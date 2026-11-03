
/**
 * Traffic and Traces load from one read, early, and are served stale while they refresh.
 *
 * Three changes, each pinned where it can fail (measured on platformsbx, 2026-09-26: cold
 * `/traffic-errors` 8-20s, cold `/traces` 11-33s, warm 3ms):
 *
 *  1. The route cache serves an entry for `TRAFFIC_CACHE_STALE_MS` past its 15s fresh window and
 *     refreshes it behind the answer; the refresh tails the proxies, never the shared copy.
 *  2. Both routes read container tails through one `logShare`, so Traces after Traffic tails
 *     nothing it already has.
 *  3. The tails start from two label-selector reads instead of waiting for the cluster-wide pod
 *     list, and the final selection is still made from that list.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _fanout from '../fanout.js';
const { Cache } = _fanout;
import _proxy_log_share2 from '../collectors/proxy-log-share.js';
const { createLogShare, fitTail } = _proxy_log_share2;
import traffic from '../collectors/traffic.js';
import _router_harness3 from './helpers/router-harness.js';
const { withRouter } = _router_harness3;

/* ------------------------------------------------------------------ fixtures */

function pod(name, namespace, labels = {}) {
  return {
    metadata: { name, namespace, labels },
    spec: { containers: [{ name: 'app' }, { name: 'istio-proxy' }], nodeName: 'node-a' },
    status: { phase: 'Running', podIP: null, containerStatuses: [] }
  };
}

const GATEWAY = pod('istio-ingressgateway-1', 'istio-system', { istio: 'ingressgateway' });
const SIDECAR = pod('shop-1', 'shop', { 'security.istio.io/tlsMode': 'istio' });
// An injected pod carrying neither discovery label: only the full pod list finds it.
const UNLABELLED = pod('legacy-1', 'shop');

function line(i) {
  return JSON.stringify({
    authority: 'shop.example.com',
    method: 'GET',
    path: `/p/${i}`,
    protocol: 'HTTP/1.1',
    request_id: `req-${i}`,
    response_code: 503,
    response_flags: 'UF',
    start_time: `2026-09-26T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
    duration: 5,
    upstream_cluster: 'outbound|80||shop.shop.svc.cluster.local'
  });
}

/** A cluster whose proxies write to stdout, and a transport that counts every tail it serves. */
function seams({ pods = [GATEWAY, SIDECAR] } = {}) {
  const state = { logReads: [], lists: [] };
  const listFn = async ({ path }) => {
    state.lists.push(path);
    if (path.includes('/telemetries')) {
      return [{ metadata: { name: 'mesh-default', namespace: 'istio-system' }, spec: { accessLogging: [{ providers: [{ name: 'stdout-json' }] }] } }];
    }
    if (path.startsWith('/api/v1/pods')) {
      if (path.includes('labelSelector=security.istio.io')) return pods.filter(p => p.metadata.labels['security.istio.io/tlsMode']);
      if (path.includes('labelSelector=istio')) return pods.filter(p => p.metadata.labels.istio);
      return pods;
    }
    return [];
  };
  const textFn = async ({ path }) => {
    state.logReads.push(path);
    const tail = Number(new URL(`http://x${path}`).searchParams.get('tailLines'));
    return Array.from({ length: Math.min(tail, 40) }, (_, i) => line(i)).join('\n') + '\n';
  };
  return { state, listFn, textFn };
}

/* ------------------------------------------------------------------ 1. the route cache */

test('an entry that declares its own stale window is served for all of it, then refreshed', async () => {
  let now = 0;
  let runs = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });
  const fn = async () => ++runs;
  const opts = { ttlMs: 15_000, staleMs: 585_000 };

  assert.equal(await cache.wrap('k', fn, opts), 1);
  now = 500_000; // past the old min(staleMs, ttlMs) = 15s cap, inside the declared 585s
  assert.equal(await cache.wrap('k', fn, opts), 1, 'served stale at once');
  await new Promise(r => setImmediate(r));
  assert.equal(runs, 2, 'and refreshed behind the answer');

  now += 600_001;
  assert.equal(await cache.wrap('k', fn, opts), 3, 'past fresh + stale nothing old is served');
});

test('without a declared stale window the short-TTL cap still holds (canary for the override)', async () => {
  let now = 0;
  let runs = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });
  const fn = async () => ++runs;
  await cache.wrap('k', fn, { ttlMs: 15_000 });
  now = 31_000; // past 15s fresh + 15s capped stale
  assert.equal(await cache.wrap('k', fn, { ttlMs: 15_000 }), 2);
});

test('an entry is dated by collectedAtOf, so reused ingredients do not restart its TTL', async () => {
  let now = 50_000;
  let runs = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 0, now: () => now });
  const opts = { ttlMs: 15_000, staleMs: 0, collectedAtOf: v => v.at };
  const fn = async () => ({ at: 40_000, run: ++runs }); // built from a read 10s old

  await cache.wrap('k', fn, opts);
  now = 56_000; // 6s after the collection, 16s after its oldest read
  assert.equal((await cache.wrap('k', fn, opts)).run, 2, 'the entry expired by its oldest read');

  const future = async () => ({ at: now + 99_000 });
  let served;
  await cache.wrap('f', future, { ttlMs: 15_000, collectedAtOf: v => v.at, onServed: at => { served = at; } });
  assert.ok(served <= now, 'a stamp from the future is clamped to now');
});

test('a background refresh tells its collector it is one', async () => {
  let now = 0;
  const seen = [];
  const cache = new Cache({ ttlMs: 10, staleMs: 1000, now: () => now });
  const fn = async how => { seen.push(Boolean(how && how.revalidating)); return seen.length; };
  await cache.wrap('k', fn);
  now = 15; // past the 10ms TTL, inside its 10ms stale window
  await cache.wrap('k', fn);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, [false, true]);
});

/* ------------------------------------------------------------------ 2. the shared tail */

const CTX = { cluster: { id: 'c1' }, token: 'token-a' };

function counter(lines = 500) {
  const calls = [];
  const fetch = async n => {
    calls.push(n);
    const raw = Array.from({ length: Math.min(n, lines) }, (_, i) => `l${i}`).join('\n') + '\n';
    return { raw, tail: n, byteCapped: false };
  };
  return { calls, fetch };
}

const readArgs = (over = {}) => ({ baseCtx: CTX, namespace: 'ns', pod: 'p', container: 'istio-proxy', sinceSeconds: null, tail: 300, readTail: 500, maxAgeMs: 60_000, ...over });

test('a 300-line caller after a 500-line read gets the newest 300 lines and reads nothing', async () => {
  const share = createLogShare();
  const { calls, fetch } = counter(1000);
  const wide = await share.read(readArgs({ tail: 500, fetch }));
  const narrow = await share.read(readArgs({ tail: 300, fetch }));
  assert.deepEqual(calls, [500]);
  assert.equal(narrow.shared, true);
  assert.equal(narrow.tail, 300);
  const lines = narrow.raw.trimEnd().split('\n');
  assert.equal(lines.length, 300);
  assert.deepEqual(lines, wide.raw.trimEnd().split('\n').slice(-300), 'the newest 300, as tailLines=300 returns');
});

test('a narrow first read reads wide, so the wider default after it fits', async () => {
  const share = createLogShare();
  const { calls, fetch } = counter(1000);
  await share.read(readArgs({ tail: 300, fetch }));
  await share.read(readArgs({ tail: 500, fetch }));
  assert.deepEqual(calls, [500]);
});

test('maxAgeMs 0 always tails, and a wider ask than was read reads again', async () => {
  const share = createLogShare();
  const { calls, fetch } = counter(1000);
  await share.read(readArgs({ fetch }));
  await share.read(readArgs({ fetch, maxAgeMs: 0 }));
  await share.read(readArgs({ fetch, tail: 1000, readTail: 1000 }));
  assert.deepEqual(calls, [500, 500, 1000]);
});

test('an entry older than maxAgeMs is not reused', async () => {
  let now = 0;
  const share = createLogShare({ now: () => now });
  const { calls, fetch } = counter();
  await share.read(readArgs({ fetch }));
  now = 60_001;
  await share.read(readArgs({ fetch }));
  assert.equal(calls.length, 2);
});

test('another credential never shares a tail', async () => {
  const share = createLogShare();
  const { calls, fetch } = counter();
  await share.read(readArgs({ fetch }));
  await share.read(readArgs({ fetch, baseCtx: { ...CTX, token: 'token-b' } }));
  assert.equal(calls.length, 2);
});

test('concurrent callers join one read; a failed read is not kept', async () => {
  const share = createLogShare();
  const { calls, fetch } = counter();
  await Promise.all([share.read(readArgs({ fetch })), share.read(readArgs({ fetch }))]);
  assert.equal(calls.length, 1);

  const boom = () => { throw new Error('sync boom'); };
  await assert.rejects(share.read(readArgs({ pod: 'q', fetch: boom })));
  const after = await share.read(readArgs({ pod: 'q', fetch }));
  assert.equal(after.shared, false, 'a synchronous failure does not wedge the key');
});

test('tails past the retain bound are dropped on the next insert, and bytes stay under budget', async () => {
  let now = 0;
  const share = createLogShare({ now: () => now, retainMs: 120_000, maxBytes: 5_000 });
  const { fetch } = counter(1000);
  await share.read(readArgs({ pod: 'old', fetch }));
  now = 120_001;
  await share.read(readArgs({ pod: 'new', fetch }));
  assert.equal(share.size(), 1, 'the expired tail went with the insert');
  for (const pod of ['a', 'b', 'c']) await share.read(readArgs({ pod, fetch }));
  assert.ok(share.bytes() <= 5_000, `kept ${share.bytes()} bytes`);
  assert.ok(share.size() >= 1, 'the newest tail is always kept');
});

test('a byte-capped tail is never sliced for a narrower caller: it lacks the newest lines', async () => {
  const share = createLogShare();
  const calls = [];
  const capped = async n => {
    calls.push(n);
    return { raw: Array.from({ length: 420 }, (_, i) => `l${i}`).join('\n') + '\n', tail: 420, byteCapped: true };
  };
  await share.read(readArgs({ tail: 500, fetch: capped }));
  await share.read(readArgs({ tail: 500, fetch: capped }));
  assert.deepEqual(calls, [500], 'a caller as wide as the capped read reuses it whole');
  await share.read(readArgs({ tail: 300, fetch: capped }));
  assert.deepEqual(calls, [500, 500], 'a 300-line caller reads its own tail');
  calls.length = 0;
  const other = createLogShare();
  await Promise.all([other.read(readArgs({ pod: 'j', tail: 500, fetch: capped })), other.read(readArgs({ pod: 'j', tail: 300, fetch: capped }))]);
  assert.equal(calls.length, 2, 'nor does a caller joining an in-flight capped read');
});

test('fitTail keeps a refit tail whole and slices a longer one', () => {
  const refit = { raw: 'a\nb\nc\n', tail: 3, byteCapped: true };
  assert.deepEqual(fitTail(refit, 5), { raw: 'a\nb\nc\n', tail: 3, byteCapped: true });
  assert.deepEqual(fitTail({ raw: 'a\nb\nc\n', tail: 500, byteCapped: false }, 2), { raw: 'b\nc\n', tail: 2, byteCapped: false });
  assert.deepEqual(fitTail({ raw: '', tail: 500, byteCapped: false }, 2), { raw: '', tail: 2, byteCapped: false });
});

/* ------------------------------------------------------------------ 3. early tails */

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('the tails start before the cluster-wide pod list lands', async () => {
  const full = deferred();
  const started = [];
  const run = traffic.readProxiesEarly({
    podsRead: full.promise,
    discovery: Promise.resolve([GATEWAY, SIDECAR]),
    skipReads: Promise.resolve(false),
    select: items => traffic.selectProxies(items, { maxPods: 10 }),
    read: async proxies => proxies.map(p => { started.push(p.metadata.name); return { proxy: p.metadata.name }; })
  });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(started.sort(), ['istio-ingressgateway-1', 'shop-1'], 'read while the pod list is still pending');
  full.resolve({ items: [GATEWAY, SIDECAR] });
  const { reads } = await run;
  assert.equal(reads.length, 2);
  assert.equal(started.length, 2, 'nothing read twice');
});

test('a proxy the selectors missed is read once the full list names it', async () => {
  const read = [];
  const { selection, reads } = await traffic.readProxiesEarly({
    podsRead: Promise.resolve({ items: [GATEWAY, SIDECAR, UNLABELLED] }),
    discovery: Promise.resolve([GATEWAY, SIDECAR]),
    skipReads: Promise.resolve(false),
    select: items => traffic.selectProxies(items, { maxPods: 10 }),
    read: async proxies => proxies.map(p => { read.push(p.metadata.name); return { proxy: p.metadata.name }; })
  });
  assert.equal(selection.candidates, 3, 'the selection is made from the full list');
  assert.deepEqual(reads.map(r => r.proxy), selection.selected.map(p => p.metadata.name), 'one read per selected proxy, in its order');
  assert.ok(read.includes('legacy-1'));
});

test('a proxy the selectors missed is read without waiting for the early tails', async () => {
  // platformsbx 2026-09-27: one ingress gateway tail took 10s, and the late reads queued behind it,
  // so a cold /traces paid 10s + the slowest late read (17s) instead of the slower of the two (11s).
  const slow = deferred();
  const started = [];
  const run = traffic.readProxiesEarly({
    podsRead: Promise.resolve({ items: [GATEWAY, SIDECAR, UNLABELLED] }),
    discovery: Promise.resolve([GATEWAY, SIDECAR]),
    skipReads: Promise.resolve(false),
    select: items => traffic.selectProxies(items, { maxPods: 10 }),
    read: async proxies => {
      proxies.forEach(p => started.push(p.metadata.name));
      if (proxies.some(p => p.metadata.name === GATEWAY.metadata.name)) await slow.promise;
      return proxies.map(p => ({ proxy: p.metadata.name }));
    }
  });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.ok(started.includes('legacy-1'), 'the late read started while the gateway tail was still pending');
  slow.resolve();
  const { reads, selection } = await run;
  assert.deepEqual(reads.map(r => r.proxy), selection.selected.map(p => p.metadata.name));
  assert.equal(started.length, 3, 'nothing read twice');
});

test('a failed discovery falls back to the full list; a skipped log reads nothing', async () => {
  const read = [];
  const args = {
    podsRead: Promise.resolve({ items: [GATEWAY] }),
    select: items => traffic.selectProxies(items, { maxPods: 10 }),
    read: async proxies => proxies.map(p => { read.push(p.metadata.name); return {}; })
  };
  const { reads } = await traffic.readProxiesEarly({ ...args, discovery: Promise.resolve(null), skipReads: Promise.resolve(false) });
  assert.equal(reads.length, 1);
  const skipped = await traffic.readProxiesEarly({ ...args, discovery: Promise.resolve([GATEWAY]), skipReads: Promise.resolve(true) });
  assert.deepEqual(skipped.reads, []);
  assert.equal(read.length, 1);
});

test('discovery asks for exactly the two proxy selectors', async () => {
  const paths = [];
  const found = await traffic.discoverProxyPods(async ({ path }) => { paths.push(path); return [SIDECAR]; }, CTX);
  assert.deepEqual(paths, traffic.PROXY_DISCOVERY_PATHS);
  assert.equal(found.length, 1, 'a pod both selectors return is kept once');
  assert.equal(await traffic.discoverProxyPods(async () => { throw new Error('403'); }, CTX), null);
});

/* ------------------------------------------------------------------ through the router */

test('Traces after Traffic tails no proxy a second time', async () => {
  const { state, listFn, textFn } = seams();
  await withRouter({ listFn, textFn }, async ({ get }) => {
    const t = await get('/clusters/platformsbx/traffic-errors');
    assert.equal(t.status, 200);
    assert.ok(t.body.ok, JSON.stringify(t.body.error));
    const afterTraffic = state.logReads.length;
    assert.equal(afterTraffic, 2, 'Traffic tailed both proxies');

    const tr = await get('/clusters/platformsbx/traces');
    assert.equal(tr.status, 200);
    assert.ok(tr.body.ok, JSON.stringify(tr.body.error));
    assert.equal(state.logReads.length, afterTraffic, 'Traces reused every tail');
    assert.ok(state.logReads.every(p => p.includes('tailLines=500')), 'read wide enough for both');
  });
});

test('the Refresh control tails the proxies again even though a shared copy exists', async () => {
  const { state, listFn, textFn } = seams();
  await withRouter({ listFn, textFn }, async ({ get }) => {
    await get('/clusters/platformsbx/traffic-errors');
    const before = state.logReads.length;
    await get('/clusters/platformsbx/traces', { headers: { 'cache-control': 'no-cache' } });
    assert.equal(state.logReads.length, before + 2);
  });
});

test('a stale answer is served at once and its refresh tails the proxies', async () => {
  let now = Date.now();
  const cache = new Cache({ now: () => now });
  const { state, listFn, textFn } = seams();
  await withRouter({ listFn, textFn, cache }, async ({ get }) => {
    const first = await get('/clusters/platformsbx/traffic-errors');
    const before = state.logReads.length;
    now += 60_000; // past the 15s fresh window, inside the 120s serve bound
    const second = await get('/clusters/platformsbx/traffic-errors');
    assert.deepEqual(second.body, first.body, 'the stale body, without waiting');
    for (let i = 0; i < 50 && state.logReads.length === before; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(state.logReads.length, before + 2, 'the background refresh read live tails');
  });
});

test('the answer is dated by its oldest tail', async () => {
  const { listFn, textFn } = seams();
  await withRouter({ listFn, textFn }, async ({ get }) => {
    const t = await get('/clusters/platformsbx/traffic-errors');
    await new Promise(r => setTimeout(r, 30));
    const tr = await get('/clusters/platformsbx/traces');
    assert.ok(Date.parse(tr.body.data.collectedAt) <= Date.parse(t.body.data.collectedAt),
      'Traces reused Traffic\'s tails, so it is no fresher than them');
  });
});

test('readProxiesEarly: the final selection waits for backends; a failed backends read selects as before', async () => {
  const seen = [];
  const pods = [{ metadata: { namespace: 'a', name: 'p' } }];
  const run = backends => traffic.readProxiesEarly({
    podsRead: Promise.resolve({ items: pods }),
    discovery: Promise.resolve(null),
    skipReads: Promise.resolve(false),
    backends,
    select: (items, b) => { seen.push(b); return { selected: items, skipped: 0, candidates: items.length }; },
    read: async ps => ps.map(() => ({ requests: [] }))
  });
  await run(Promise.resolve([{ namespace: 'a', selector: { app: 'x' } }]));
  await run(Promise.reject(new Error('refused')));
  assert.deepEqual(seen, [[{ namespace: 'a', selector: { app: 'x' } }], null]);
});
