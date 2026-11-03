/**
 * The three things that make a tab load fast, each proven against a real HTTPS server.
 *
 * All three were added after measuring the live cluster, and all three are the kind of
 * optimisation that is easy to leave half-working: a cache that never hits still returns the
 * right answer, a cache that over-shares returns another user's answer, and a compressed body
 * that is never decoded fails a long way from its cause. So each test below names the wrong
 * behaviour it exists to catch, and the two that are about *isolation* rather than speed —
 * the token fingerprint and the mutation copy — were canaried against a deliberately broken
 * implementation before being trusted.
 *
 * A real server rather than an injected transport on purpose: `list` deliberately bypasses
 * its cache when a `transport` is supplied, so a mocked round trip cannot exercise any of
 * this.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

import _k8s from '../k8s.js';
const {
  list, forgetListCache, withLowPriority,
  MAX_IN_FLIGHT_PER_CLUSTER, LOW_PRIORITY_MAX_IN_FLIGHT
} = _k8s;

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-perf-tls-'));
  const key = path.join(dir, 'tls.key');
  const cert = path.join(dir, 'tls.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost'
  ], { stdio: 'ignore' });
  return { key, cert };
}

let TLS = null;
try { TLS = selfSigned(); } catch { TLS = null; }
const skip = TLS ? false : 'openssl not available to mint a test certificate';

/**
 * An https server that records every request and answers from `handler`. The handler may be
 * async, which is what lets a test hold responses open and observe the concurrency gate.
 */
async function serve(handler) {
  const seen = [];
  const server = https.createServer(
    { key: fs.readFileSync(TLS.key), cert: fs.readFileSync(TLS.cert) },
    async (req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      const out = await handler(req, seen.length);
      res.writeHead(out.status || 200, out.headers || { 'Content-Type': 'application/json' });
      res.end(out.body);
    }
  );
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `https://localhost:${port}`, seen, close: () => new Promise(r => server.close(r)) };
}

const itemsBody = (n, tag = 'x') => JSON.stringify({
  kind: 'PodList',
  items: Array.from({ length: n }, (_, i) => ({ metadata: { name: `${tag}-${i}` } }))
});

let clusterSeq = 0;
/** A fresh cluster id per test, so no test can be served another test's cache entry. */
function freshCluster(url) {
  clusterSeq += 1;
  const id = `perf-cluster-${clusterSeq}`;
  forgetListCache(id);
  return { id, apiUrl: url, caFile: TLS.cert };
}

/* ------------------------------------------------------------------ shared list reads */

test('concurrent identical reads become one request', { skip }, async () => {
  // The measured failure: eight collectors each asked for the cluster-wide pod list at the
  // same moment, so one tab load made eight 1.7 MB reads and queued the small ones behind
  // them. The wrong answer here is 8.
  const srv = await serve(async () => {
    await new Promise(r => setTimeout(r, 40));   // long enough for all eight to pile up
    return { body: itemsBody(3) };
  });
  try {
    const cluster = freshCluster(srv.url);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => list({ cluster, token: 't', path: '/api/v1/pods' }))
    );
    assert.strictEqual(srv.seen.length, 1, 'eight concurrent identical reads must share one round trip');
    for (const r of results) assert.strictEqual(r.length, 3, 'every coalesced caller still gets the full list');
  } finally { await srv.close(); }
});

test('a sequential repeat inside the TTL is served from cache, and forgetting drops it', { skip }, async () => {
  const srv = await serve(async (_req, n) => ({ body: itemsBody(2, `call${n}`) }));
  try {
    const cluster = freshCluster(srv.url);
    const first = await list({ cluster, token: 't', path: '/api/v1/pods' });
    const second = await list({ cluster, token: 't', path: '/api/v1/pods' });
    assert.strictEqual(srv.seen.length, 1);
    assert.deepStrictEqual(second, first);

    // Re-onboarding a cluster must not keep answering with the previous credential's reads.
    forgetListCache(cluster.id);
    await list({ cluster, token: 't', path: '/api/v1/pods' });
    assert.strictEqual(srv.seen.length, 2, 'forgetListCache must force the next read back onto the network');
  } finally { await srv.close(); }
});

test('two tokens never share a cached read', { skip }, async () => {
  // The one that matters. In OIDC passthrough the token IS the identity, and two operators
  // have different RBAC: serving user B the list user A was allowed to read is a
  // confidentiality bug, not a stale-data bug. Canaried — with the fingerprint dropped from
  // the key this returns 1 and user B sees user A's items.
  const srv = await serve(async (req, n) => ({
    body: itemsBody(1, req.headers.authorization === 'Bearer alice' ? 'alice' : `other${n}`)
  }));
  try {
    const cluster = freshCluster(srv.url);
    const a = await list({ cluster, token: 'alice', path: '/api/v1/secrets' });
    const b = await list({ cluster, token: 'bob', path: '/api/v1/secrets' });
    assert.strictEqual(srv.seen.length, 2, 'a second token must cause a second read');
    assert.match(a[0].metadata.name, /^alice-/);
    assert.doesNotMatch(b[0].metadata.name, /^alice-/, "bob must not be served alice's read");
  } finally { await srv.close(); }
});

test('consistent: true neither reads the cache nor fills it', { skip }, async () => {
  // `consistent` exists for a read whose result is about to be acted on. Getting a copy is
  // the exact thing it is asking not to happen — and it must not leave an entry behind that
  // a later cached read would then be served.
  const srv = await serve(async (_req, n) => ({ body: itemsBody(1, `n${n}`) }));
  try {
    const cluster = freshCluster(srv.url);
    await list({ cluster, token: 't', path: '/api/v1/pods', consistent: true });
    await list({ cluster, token: 't', path: '/api/v1/pods', consistent: true });
    assert.strictEqual(srv.seen.length, 2, 'a quorum read must never be served from cache');
    await list({ cluster, token: 't', path: '/api/v1/pods' });
    assert.strictEqual(srv.seen.length, 3, 'a quorum read must not have populated the cache either');
  } finally { await srv.close(); }
});

test('limit is a page size, so it does not split the cache — a selector does', { skip }, async () => {
  // Three collectors picked ?limit=1500, ?limit=2000 and none for the same pod list. `list`
  // pages to completion regardless, so all three are one answer and must be one entry.
  const srv = await serve(async () => ({ body: itemsBody(2) }));
  try {
    const cluster = freshCluster(srv.url);
    await list({ cluster, token: 't', path: '/api/v1/pods?limit=1500' });
    await list({ cluster, token: 't', path: '/api/v1/pods?limit=2000' });
    await list({ cluster, token: 't', path: '/api/v1/pods' });
    assert.strictEqual(srv.seen.length, 1, 'differing page sizes must share one cache entry');

    // A selector genuinely changes the result set and must never be folded away.
    await list({ cluster, token: 't', path: '/api/v1/pods?labelSelector=app%3Dweb' });
    assert.strictEqual(srv.seen.length, 2, 'a labelSelector must be part of the key');
  } finally { await srv.close(); }
});

test('each caller gets its own array, so one sorting it cannot reorder another', { skip }, async () => {
  // `logs.js` sorts its pod list in place. Before the copy that sort reordered the very array
  // the next collector was about to read. Canaried — returning the cached array directly
  // makes the second caller see b,a.
  const srv = await serve(async () => ({
    body: JSON.stringify({ items: [{ metadata: { name: 'b' } }, { metadata: { name: 'a' } }] })
  }));
  try {
    const cluster = freshCluster(srv.url);
    const first = await list({ cluster, token: 't', path: '/api/v1/pods' });
    first.sort((x, y) => x.metadata.name.localeCompare(y.metadata.name));
    assert.deepStrictEqual(first.map(p => p.metadata.name), ['a', 'b']);

    const second = await list({ cluster, token: 't', path: '/api/v1/pods' });
    assert.deepStrictEqual(
      second.map(p => p.metadata.name), ['b', 'a'],
      "a previous caller's in-place sort must not reach the next one"
    );
  } finally { await srv.close(); }
});

/* ------------------------------------------------------------------------ compression */

test('the apiserver is asked for gzip, and a gzipped body is decoded', { skip }, async () => {
  // Measured on a live cluster: the pod list is 3.5 MB plain and 487 KB gzipped, and reads a
  // third faster. Without the decode half, the caller sees "API server returned non-JSON".
  const payload = itemsBody(50);
  const srv = await serve(async () => ({
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: zlib.gzipSync(Buffer.from(payload))
  }));
  try {
    const cluster = freshCluster(srv.url);
    const items = await list({ cluster, token: 't', path: '/api/v1/pods' });
    assert.strictEqual(srv.seen[0].headers['accept-encoding'], 'gzip', 'the request must advertise gzip');
    assert.strictEqual(items.length, 50, 'the gzipped body must be decoded before parsing');
  } finally { await srv.close(); }
});

test('an identity-encoded response still works, because small reads are not compressed', { skip }, async () => {
  // Kubernetes only compresses over ~128 KB, so most reads come back uncompressed and must
  // not be run through gunzip.
  const srv = await serve(async () => ({ body: itemsBody(2) }));
  try {
    const cluster = freshCluster(srv.url);
    assert.strictEqual((await list({ cluster, token: 't', path: '/api/v1/pods' })).length, 2);
  } finally { await srv.close(); }
});

/* -------------------------------------------------------------------- priority gating */

test('a background sweep leaves slots free for an interactive read', { skip }, async () => {
  // The measured failure: the sidebar's 30 s /summary poll is a full fleet sweep that held
  // the eight-slot gate for twenty seconds, and a tab opened during one waited behind it —
  // 250 ms reads were observed queued for 10 s. Low-priority work must stay under its own
  // lower ceiling so a click always finds a slot. The wrong answer is that the interactive
  // read never lands until the sweep drains.
  assert.ok(LOW_PRIORITY_MAX_IN_FLIGHT < MAX_IN_FLIGHT_PER_CLUSTER, 'the reserve must be non-empty');

  let releaseAll = null;
  const held = new Promise(r => { releaseAll = r; });
  let interactiveArrived = false;

  const srv = await serve(async req => {
    if (req.url.includes('interactive')) {
      interactiveArrived = true;
      return { body: itemsBody(1) };
    }
    await held;                       // the sweep's reads never finish until we say so
    return { body: itemsBody(1) };
  });

  try {
    const cluster = freshCluster(srv.url);
    // Far more background reads than the gate can hold, each a distinct path so none of them
    // is coalesced or cached away.
    const sweep = withLowPriority(() => Promise.all(
      Array.from({ length: MAX_IN_FLIGHT_PER_CLUSTER * 3 }, (_, i) =>
        list({ cluster, token: 't', path: `/api/v1/sweep-${i}` }))
    ));

    // Give the sweep time to fill everything it is allowed to fill.
    await new Promise(r => setTimeout(r, 150));

    const items = await list({ cluster, token: 't', path: '/api/v1/interactive' });
    assert.ok(interactiveArrived, 'the interactive read must reach the server while the sweep is stuck');
    assert.strictEqual(items.length, 1);

    releaseAll();
    await sweep;
  } finally {
    if (releaseAll) releaseAll();
    await srv.close();
  }
});

test('an interactive read waiting for a slot is served before a queued background one', { skip }, async () => {
  const order = [];
  let releaseFirst = null;
  const held = new Promise(r => { releaseFirst = r; });

  const srv = await serve(async req => {
    order.push(req.url);
    if (req.url.includes('block')) await held;
    return { body: itemsBody(1) };
  });

  try {
    const cluster = freshCluster(srv.url);
    // Fill every slot with interactive work so both queues are genuinely blocked.
    const blockers = Array.from({ length: MAX_IN_FLIGHT_PER_CLUSTER }, (_, i) =>
      list({ cluster, token: 't', path: `/api/v1/block-${i}` }));
    await new Promise(r => setTimeout(r, 120));

    const background = withLowPriority(() => list({ cluster, token: 't', path: '/api/v1/queued-background' }));
    await new Promise(r => setTimeout(r, 20));     // background queues first, on purpose
    const foreground = list({ cluster, token: 't', path: '/api/v1/queued-foreground' });

    releaseFirst();
    await Promise.all([...blockers, background, foreground]);

    const fg = order.findIndex(u => u.includes('queued-foreground'));
    const bg = order.findIndex(u => u.includes('queued-background'));
    assert.ok(fg !== -1 && bg !== -1, 'both queued reads must eventually run');
    assert.ok(fg < bg, 'the interactive read must jump the queue even though it arrived second');
  } finally {
    if (releaseFirst) releaseFirst();
    await srv.close();
  }
});
