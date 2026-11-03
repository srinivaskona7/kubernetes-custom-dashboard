import { test } from 'vitest';
import assert from 'node:assert';

import _fanout from '../fanout.js';
const { fanOut, Cache, publicCluster, OIDC_FALLBACK_TO_SA } = _fanout;
import _registry2 from '../registry.js';
const { Registry } = _registry2;
import _errors3 from '../errors.js';
const { ClusterError, UNREACHABLE, FORBIDDEN } = _errors3;

const CLUSTERS = [
  { id: 'platformsbx', displayName: 'Platform Sandbox', env: 'sbx', apiUrl: 'https://kubernetes.default.svc' },
  { id: 'appkymadv', displayName: 'Kyma DEV', env: 'dev', apiUrl: 'https://api.b1eb3b8.kyma.ondemand.com' },
  { id: 'appkymaut', displayName: 'Kyma UAT', env: 'uat', apiUrl: 'https://api.c-563c468.kyma.ondemand.com', enabled: false }
];

/** A TokenStore stand-in driven by a plain map of statuses. */
function fakeTokens(byCluster) {
  return {
    health: id => byCluster[id] || { status: 'unseeded', expiresAt: null, expiresInMs: null, renewedAt: null, lastError: null, dueForRenewal: true },
    tokenFor: id => (byCluster[id] && byCluster[id].status !== 'unseeded') ? `token-${id}` : null
  };
}

const valid = { status: 'valid', expiresAt: '2026-09-01T12:00:00Z', expiresInMs: 18 * 3600_000, renewedAt: null, lastError: null, dueForRenewal: false };
const expired = { status: 'expired', expiresAt: '2026-08-30T12:00:00Z', expiresInMs: -3600_000, renewedAt: null, lastError: null, dueForRenewal: true };

test('disabled clusters are never called', async () => {
  const registry = new Registry({ clusters: CLUSTERS });
  const called = [];
  const results = await fanOut({
    registry,
    tokens: fakeTokens({ platformsbx: valid, appkymadv: valid, appkymaut: valid }),
    collect: async ({ cluster }) => { called.push(cluster.id); return { ok: 1 }; }
  });
  assert.deepStrictEqual(called.sort(), ['appkymadv', 'platformsbx']);
  assert.strictEqual(results.length, 2);
});

test('one cluster failing never fails the others', async () => {
  const registry = new Registry({ clusters: CLUSTERS });
  const results = await fanOut({
    registry,
    tokens: fakeTokens({ platformsbx: valid, appkymadv: valid }),
    collect: async ({ cluster }) => {
      if (cluster.id === 'appkymadv') throw new ClusterError(UNREACHABLE, 'dial tcp: i/o timeout', { cluster: cluster.id });
      return { nodes: 3 };
    }
  });

  const sbx = results.find(r => r.cluster.id === 'platformsbx');
  const dev = results.find(r => r.cluster.id === 'appkymadv');

  assert.strictEqual(sbx.ok, true, 'the healthy cluster still returns its data');
  assert.deepStrictEqual(sbx.data, { nodes: 3 });
  assert.strictEqual(dev.ok, false);
  assert.strictEqual(dev.error.code, UNREACHABLE);
  assert.strictEqual(dev.error.needsReseed, false, 'a network timeout is not a credential problem');
});

test('an expired token short-circuits without a network call', async () => {
  const registry = new Registry({ clusters: [CLUSTERS[0]] });
  let called = false;
  const [result] = await fanOut({
    registry,
    tokens: fakeTokens({ platformsbx: expired }),
    collect: async () => { called = true; return {}; }
  });
  assert.strictEqual(called, false, 'no point calling a cluster with a token we know is dead');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.needsReseed, true);
  assert.match(result.error.message, /renewal chain is broken/);
});

test('an unseeded cluster reports the seeding command instead of a timeout', async () => {
  const registry = new Registry({ clusters: [CLUSTERS[0]] });
  const [result] = await fanOut({
    registry, tokens: fakeTokens({}), collect: async () => ({})
  });
  assert.strictEqual(result.error.code, 'UNSEEDED');
  assert.match(result.error.message, /kubectl create token fleet-reader -n kyma-fleet --duration=24h/);
});

test('the cluster object sent to the browser carries no credential fields', () => {
  const pub = publicCluster({
    id: 'platformsbx', displayName: 'x', env: 'sbx', apiUrl: 'https://a',
    namespace: 'kyma-fleet', serviceAccount: 'fleet-reader', enabled: true,
    caFile: '/etc/ca.crt', secretRef: 'should-not-appear'
  });
  assert.ok(!('secretRef' in pub));
  assert.ok(!('caFile' in pub), 'a filesystem path is infrastructure detail, not UI data');
});

test('a cluster with no renewable flag is presented as renewable, not as broken', () => {
  // Baked clusters and anything onboarded before the field existed have no flag. Defaulting
  // to false would put a "will go dark" warning on every cluster in the fleet.
  const pub = publicCluster({ id: 'platformsbx', enabled: true });
  assert.strictEqual(pub.renewable, true);
  assert.strictEqual(pub.onboardedVia, 'baked');
});

test('a pasted token that cannot mint its successor is carried through as not renewable', () => {
  const pub = publicCluster({ id: 'x', enabled: true, onboardedVia: 'token', renewable: false });
  assert.strictEqual(pub.renewable, false);
  assert.strictEqual(pub.onboardedVia, 'token');
});

// ------------------------------------------------------------------------ cache

test('the cache serves a hit within its TTL and re-runs after it', async () => {
  let now = 1000;
  let runs = 0;
  // staleMs: 0 is strict expiry — the behaviour before stale-while-revalidate, kept as its
  // own case so the TTL boundary itself is still pinned independently of the stale window.
  const cache = new Cache({ ttlMs: 30_000, staleMs: 0, now: () => now });
  const fn = async () => { runs++; return runs; };

  assert.strictEqual(await cache.wrap('k', fn), 1);
  assert.strictEqual(await cache.wrap('k', fn), 1, 'served from cache');
  now += 30_001;
  assert.strictEqual(await cache.wrap('k', fn), 2, 'TTL elapsed, recomputed');
});

// ------------------------------------------------- stale-while-revalidate
//
// The measured defect these cover: the sidebar polls `/summary` and `/clusters` every 30s
// against a 30s TTL, so every poll was a guaranteed miss and paid 4-5s of real cluster
// reading on the request path. Serving the stale entry while refreshing behind it is what
// removes that. The tests below pin the three properties that make it safe to do so.

test('a stale entry is served immediately and refreshed behind the answer', async () => {
  let now = 1000;
  let runs = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });
  const fn = async () => { runs++; return runs; };

  assert.strictEqual(await cache.wrap('k', fn), 1);
  now += 30_001; // past the TTL, inside the stale window

  assert.strictEqual(await cache.wrap('k', fn), 1, 'the stale value is returned without waiting');
  await new Promise(r => setImmediate(r)); // let the detached refresh land
  assert.strictEqual(runs, 2, 'the refresh ran exactly once, off the request path');
  assert.strictEqual(await cache.wrap('k', fn), 2, 'the next read sees the refreshed value');
});

test('a stale entry past the stale window blocks on a real collection', async () => {
  let now = 1000;
  let runs = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });
  const fn = async () => { runs++; return runs; };

  assert.strictEqual(await cache.wrap('k', fn), 1);
  now += 90_001; // ttl + stale elapsed
  assert.strictEqual(await cache.wrap('k', fn), 2, 'beyond the stale window nothing old may be served');
});

test('a stale entry whose refresh fails is evicted, not served again', async () => {
  let now = 1000;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });

  assert.strictEqual(await cache.wrap('k', async () => 'good'), 'good');
  now += 30_001;

  // The cluster has stopped answering. The stale value is served this once — the failure is
  // not known yet — and then the entry must go, so the next read surfaces the real error
  // rather than the last good numbers. A dashboard that keeps rendering a dead cluster's
  // last healthy state is the exact failure the completeness contract forbids.
  assert.strictEqual(await cache.wrap('k', async () => { throw new Error('cluster down'); }), 'good');
  await new Promise(r => setImmediate(r));

  await assert.rejects(
    cache.wrap('k', async () => { throw new Error('cluster down'); }),
    /cluster down/,
    'after a failed refresh the stale entry must be gone and the error must reach the caller'
  );
});

test('a stale window never outlives the entry\'s own declared shelf life', async () => {
  let now = 1000;
  let runs = 0;
  // /traffic-errors asks for 15s because its answer is a moving window over access logs.
  // The cache's 60s stale window must not stretch that to 75s.
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });
  const fn = async () => { runs++; return runs; };

  assert.strictEqual(await cache.wrap('k', fn, { ttlMs: 15_000 }), 1);
  now += 30_001; // past 15s ttl + 15s capped stale window
  assert.strictEqual(await cache.wrap('k', fn, { ttlMs: 15_000 }), 2, 'a short-lived entry gets a short stale window');
});

test('invalidate retires an in-flight collection so a forced refresh really re-reads', async () => {
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => 0 });
  let release;
  const gate = new Promise(r => { release = r; });

  // A collection is in flight when the operator asks /traffic-errors for a forced refresh.
  const first = cache.wrap('k', async () => { await gate; return 'before'; });
  cache.invalidate('k');
  const second = cache.wrap('k', async () => 'after');

  release();
  assert.strictEqual(await first, 'before');
  assert.strictEqual(await second, 'after', 'the forced refresh must not join the read it just invalidated');
  assert.strictEqual(await cache.wrap('k', async () => 'unused'), 'after', 'the retired collection must not write over it');
});

test('concurrent callers share one in-flight sweep', async () => {
  let runs = 0;
  const cache = new Cache({ ttlMs: 30_000, now: () => 0 });
  const slow = async () => { runs++; await new Promise(r => setTimeout(r, 10)); return runs; };

  const [a, b, c] = await Promise.all([cache.wrap('k', slow), cache.wrap('k', slow), cache.wrap('k', slow)]);
  assert.strictEqual(runs, 1, 'three browsers refreshing must not cause three fleet sweeps');
  assert.deepStrictEqual([a, b, c], [1, 1, 1]);
});

test('a failed sweep is not cached', async () => {
  const cache = new Cache({ ttlMs: 30_000, now: () => 0 });
  await assert.rejects(cache.wrap('k', async () => { throw new Error('boom'); }));
  assert.strictEqual(await cache.wrap('k', async () => 'recovered'), 'recovered');
});

// --------------------------------------------------------------------- registry

test('the registry rejects an id that could escape the token mount', () => {
  assert.throws(() => new Registry({ clusters: [{ id: '../etc', apiUrl: 'https://a' }] }), /must match/);
  assert.throws(() => new Registry({ clusters: [{ id: 'ok', apiUrl: 'http://insecure' }] }), /https/);
});

test('the registry defaults the fleet namespace and service account', () => {
  const r = new Registry({ clusters: [{ id: 'platformsbx', apiUrl: 'https://a/' }] });
  const c = r.get('platformsbx');
  assert.strictEqual(c.namespace, 'kyma-fleet');
  assert.strictEqual(c.serviceAccount, 'fleet-reader');
  assert.strictEqual(c.apiUrl, 'https://a', 'trailing slash trimmed so path joins stay clean');
  assert.strictEqual(c.enabled, true);
});

// ------------------------------------------------------------------- userToken selection

test('a userToken is used for an oidc-mode cluster, whether flagged via authMode or via onboardedVia', async () => {
  const byAuthMode = { id: 'appkymaoidc', apiUrl: 'https://api.oidc.kyma.ondemand.com', authMode: 'oidc' };
  const byOnboardedVia = { id: 'appkymasso', apiUrl: 'https://api.sso.kyma.ondemand.com', onboardedVia: 'oidc' };

  for (const clusterDef of [byAuthMode, byOnboardedVia]) {
    const registry = new Registry({ clusters: [clusterDef] });
    let seenToken;
    const [result] = await fanOut({
      registry,
      tokens: fakeTokens({}), // no service-account token stored for this cluster at all
      userToken: 'user-bearer-abc',
      collect: async ({ token }) => { seenToken = token; return { ok: 1 }; }
    });
    assert.strictEqual(seenToken, 'user-bearer-abc', `${clusterDef.id} must be called with the forwarded user token`);
    assert.strictEqual(result.ok, true);
    assert.ok(!result.authFallback, 'a userToken was supplied, so nothing fell back');
  }
});

test('a userToken is never used for a token-mode (non-OIDC) cluster', async () => {
  const registry = new Registry({ clusters: [CLUSTERS[0]] }); // platformsbx: authMode defaults to 'token'
  let seenToken;
  const [result] = await fanOut({
    registry,
    tokens: fakeTokens({ platformsbx: valid }),
    userToken: 'user-bearer-must-be-ignored',
    collect: async ({ token }) => { seenToken = token; return {}; }
  });
  assert.strictEqual(seenToken, 'token-platformsbx', 'a token-mode cluster always uses its own service-account token');
  assert.ok(!result.authFallback, 'authFallback only ever applies to OIDC clusters');
});

test('an oidc cluster with no userToken falls back to the service-account token and flags it', async () => {
  const registry = new Registry({ clusters: [{ id: 'appkymaoidc', apiUrl: 'https://api.oidc.kyma.ondemand.com', authMode: 'oidc' }] });
  let seenToken;
  const [result] = await fanOut({
    registry,
    tokens: fakeTokens({ appkymaoidc: valid }), // a service-account token happens to exist
    // no userToken passed — the request arrived with no user session
    collect: async ({ token }) => { seenToken = token; return { ok: 1 }; }
  });
  assert.strictEqual(seenToken, 'token-appkymaoidc', 'falls back to the service-account token');
  assert.strictEqual(result.ok, true);
  assert.ok(result.authFallback, 'the fallback must be observable on the result');
  assert.strictEqual(result.authFallback.code, OIDC_FALLBACK_TO_SA);
  assert.strictEqual(result.authFallback.cluster, 'appkymaoidc');
  assert.match(result.authFallback.message, /service account/);
});

test('the fallback flag survives even when the fallback token is then refused upstream', async () => {
  const registry = new Registry({ clusters: [{ id: 'appkymaoidc', apiUrl: 'https://api.oidc.kyma.ondemand.com', authMode: 'oidc' }] });
  const [result] = await fanOut({
    registry,
    tokens: fakeTokens({ appkymaoidc: valid }),
    collect: async () => { throw new ClusterError(FORBIDDEN, 'RBAC denies', { cluster: 'appkymaoidc', status: 403 }); }
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, FORBIDDEN);
  assert.ok(result.authFallback, 'a bare 403 on the fallback token still needs the explanation attached');
});

test('an oidc cluster with neither a userToken nor a service-account token reports UNSEEDED, not a fallback', async () => {
  const registry = new Registry({ clusters: [{ id: 'appkymaoidc', apiUrl: 'https://api.oidc.kyma.ondemand.com', authMode: 'oidc' }] });
  const [result] = await fanOut({ registry, tokens: fakeTokens({}), collect: async () => ({}) });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'UNSEEDED');
  assert.ok(!result.authFallback, 'there was nothing to fall back to, so no fallback flag either');
});

// ------------------------------------------------------------------------- cache bound

test('cache: two concurrent calls for the same key share one upstream request', async () => {
  let calls = 0;
  const cache = new Cache({ ttlMs: 30_000, now: () => 0 });
  const fn = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return 'v'; };

  const [a, b] = await Promise.all([cache.wrap('k', fn), cache.wrap('k', fn)]);
  assert.strictEqual(calls, 1, 'two callers for the same key must cause one upstream call');
  assert.deepStrictEqual([a, b], ['v', 'v']);
});

test('cache: a rejected in-flight promise is not left cached for a later retry', async () => {
  let attempt = 0;
  const cache = new Cache({ ttlMs: 30_000, now: () => 0 });
  const flaky = async () => {
    attempt++;
    if (attempt === 1) throw new Error('upstream boom');
    return 'recovered';
  };

  // Two concurrent callers share the one in-flight request, which fails for both.
  const [aResult, bResult] = await Promise.allSettled([cache.wrap('k', flaky), cache.wrap('k', flaky)]);
  assert.strictEqual(aResult.status, 'rejected');
  assert.strictEqual(bResult.status, 'rejected');
  assert.strictEqual(attempt, 1, 'the failure was shared, not duplicated');

  // A later, separate call must re-issue the request rather than replay a cached rejection.
  const retried = await cache.wrap('k', flaky);
  assert.strictEqual(retried, 'recovered');
  assert.strictEqual(attempt, 2);
});

test('cache: inserting more than maxEntries distinct keys evicts the oldest', async () => {
  const cache = new Cache({ ttlMs: 30_000, now: () => 0, maxEntries: 3 });
  await cache.wrap('a', async () => 1);
  await cache.wrap('b', async () => 2);
  await cache.wrap('c', async () => 3);
  await cache.wrap('d', async () => 4);

  assert.strictEqual(cache._entries.size, 3, 'the map never grows past maxEntries');
  assert.strictEqual(cache._entries.has('a'), false, 'the oldest entry is the one evicted');
  assert.ok(cache._entries.has('b') && cache._entries.has('c') && cache._entries.has('d'));
});

test('cache: reading an entry protects it from eviction ahead of one that was never re-read', async () => {
  const cache = new Cache({ ttlMs: 30_000, now: () => 0, maxEntries: 2 });
  await cache.wrap('a', async () => 1);
  await cache.wrap('b', async () => 2);
  await cache.wrap('a', async () => 99); // cache hit on 'a' — touches it, moving it to the back
  await cache.wrap('c', async () => 3); // over bound: 'b' is now the least recently used

  assert.strictEqual(cache._entries.has('a'), true, 'recently touched entries survive eviction');
  assert.strictEqual(cache._entries.has('b'), false, 'the untouched entry is evicted instead');
  assert.strictEqual(cache._entries.has('c'), true);
});

test('the default cache bound is 500 entries', () => {
  assert.strictEqual(new Cache().maxEntries, 500);
});

test('cache: an expired entry is purged even if its key is never read again', async () => {
  let now = 0;
  const cache = new Cache({ ttlMs: 1000, now: () => now });
  await cache.wrap('stale', async () => 'v1');
  assert.strictEqual(cache._entries.has('stale'), true);

  now = 2000; // well past the TTL
  // A wholly unrelated key is touched; 'stale' itself is never wrapped again.
  await cache.wrap('other', async () => 'v2');

  assert.strictEqual(cache._entries.has('stale'), false, 'expired entries are deleted, not left to rot in the map');
  assert.strictEqual(cache._entries.size, 1, 'only the fresh key remains');
});

/*
  Per-entry TTL.

  `/traffic-errors` is a moving window over Envoy access logs, so it asks to be kept for
  seconds while every resource listing beside it is kept for thirty. Without this the shorter
  life is silently ignored and a log tail is served for half a minute — a page that reports
  "the last N lines" while showing lines from a window that closed long before.

  Both directions matter, and the second is the one that is easy to lose: `_purgeExpired` is
  driven by *other* keys' traffic, so an entry with its own TTL must still be evicted on time
  by a sweep it did not trigger, and an entry without one must not be evicted early by a sweep
  that a short-lived neighbour did.
*/
test('an entry may be given a shorter life than the cache default', async () => {
  let now = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 0, now: () => now });

  await cache.wrap('short', async () => 'v1', { ttlMs: 5_000 });
  await cache.wrap('normal', async () => 'n1');

  now = 4_999;
  assert.strictEqual(await cache.wrap('short', async () => 'v2'), 'v1', 'still inside its own window');

  now = 5_000;
  assert.strictEqual(await cache.wrap('short', async () => 'v2'), 'v2', 'expired on its own TTL, not the default');
  assert.strictEqual(await cache.wrap('normal', async () => 'n2'), 'n1', 'a neighbour keeps the default TTL');
});

test('a short-lived entry is swept on time by traffic it did not cause', async () => {
  let now = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 0, now: () => now });
  await cache.wrap('short', async () => 'v1', { ttlMs: 5_000 });

  now = 6_000;
  // Nothing asks for `short` — some unrelated key drives the sweep, which is how it happens
  // in the router.
  await cache.wrap('unrelated', async () => 'x');
  assert.strictEqual(cache._entries.has('short'), false, 'expired on its own TTL during somebody else’s read');
});

test('a short-lived entry is swept at its own ttl + stale, not the cache default', async () => {
  let now = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });
  await cache.wrap('short', async () => 'v1', { ttlMs: 5_000 });

  now = 9_999; // inside 5s ttl + 5s capped stale window
  await cache.wrap('unrelated', async () => 'x');
  assert.strictEqual(cache._entries.has('short'), true, 'still serveable-while-refreshing');

  now = 10_000;
  await cache.wrap('unrelated2', async () => 'x');
  assert.strictEqual(
    cache._entries.has('short'),
    false,
    'a 5s entry must not linger for the cache-wide 60s stale window — memory is bounded by the ' +
      'shortest declared shelf life, not the longest'
  );
});
