/**
 * How many times one `GET /summary` lists every pod, measured on the production transport.
 *
 * `/summary` fans out every `SUMMARY_GROUPS` collector at once, and nine of them ask for the
 * cluster-wide pod list — under four spellings (`?limit=2000`, `?limit=1500`, bare, and a
 * metadata-only read). Nothing above the transport dedupes them: the route cache in fanout.js
 * keys per group, not per read. What makes it one read is `list()` in srv/fleet/k8s.js, which
 * coalesces concurrent identical reads and drops `limit` from its key. k8s-perf.test.js proves
 * that for `list()` alone; this proves it holds for the real composition, so a collector that
 * starts spelling the path differently, or reaches past `list()`, fails here by count.
 *
 * Why not an injected `listFn`: a stubbed transport bypasses `list()` entirely (router.js
 * threads it straight to the collectors), so it counts nine and measures only the fixture.
 * Neither srv/server.js nor srv/fleet/dev-server.js injects one, so the number that matters is
 * the one a real HTTPS server sees.
 *
 * Canaried 2026-09-24: with the in-flight lookup in `list()` disabled, the first test counts
 * 8 full pod reads per cluster and the rejection test 7 round trips; with `accept` dropped from
 * the list-cache key, the first and third tests fail (the metadata read swallows the full one).
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

import _registry from '../registry.js';
const { Registry } = _registry;
import _k8s2 from '../k8s.js';
const { list, forgetListCache, METADATA_ONLY } = _k8s2;
import _router_harness3 from './helpers/router-harness.js';
const { withRouter } = _router_harness3;

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-summary-tls-'));
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

/** Records every request; answers from `handler` after a delay long enough for reads to pile up. */
async function serve(handler) {
  const seen = [];
  const server = https.createServer(
    { key: fs.readFileSync(TLS.key), cert: fs.readFileSync(TLS.cert) },
    async (req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      await new Promise(r => setTimeout(r, 30));
      const out = handler(req);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(out.body);
    }
  );
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `https://localhost:${port}`, seen, close: () => new Promise(r => server.close(r)) };
}

const isPodList = url => new URL(url, 'https://x').pathname === '/api/v1/pods';

const podListBody = () => JSON.stringify({
  kind: 'PodList',
  items: [{ metadata: { name: 'p-0', namespace: 'default' }, spec: { containers: [] }, status: { phase: 'Running' } }]
});

let seq = 0;
/** Fresh cluster ids per test, so no test is served another's list-cache entry. */
function freshIds(n) {
  return Array.from({ length: n }, () => {
    seq += 1;
    const id = `summary-dedup-${seq}`;
    forgetListCache(id);
    return id;
  });
}

test('one /summary lists every pod once per cluster, plus one metadata-only read', { skip }, async () => {
  const srv = await serve(req => ({ body: isPodList(req.url) ? podListBody() : JSON.stringify({ kind: 'List', items: [] }) }));
  try {
    const ids = freshIds(2);
    // Both clusters share one server, told apart by their bearer, which is also what keeps
    // their reads apart in the list cache.
    const registry = new Registry({ clusters: ids.map(id => ({ id, apiUrl: srv.url, caFile: TLS.cert, enabled: true })) });
    const tokens = {
      tokenFor: id => `tok-${id}`,
      health: () => ({ status: 'valid', expiresAt: null, expiresInMs: 1e9, renewedAt: null, lastError: null, dueForRenewal: false })
    };

    // listFn/textFn/callFn undefined: the router falls back to the real k8s.js transport, the
    // same construction srv/server.js uses.
    await withRouter({ registry, tokens, listFn: undefined, textFn: undefined, callFn: undefined }, async ({ get }) => {
      const res = await get('/summary');
      assert.strictEqual(res.status, 200);
    });

    for (const id of ids) {
      const pods = srv.seen.filter(r => isPodList(r.url) && r.headers.authorization === `Bearer tok-${id}`);
      const full = pods.filter(r => !String(r.headers.accept || '').includes('PartialObjectMetadataList'));
      const meta = pods.filter(r => String(r.headers.accept || '').includes('PartialObjectMetadataList'));
      assert.strictEqual(full.length, 1, `${id}: ${full.length} full pod LISTs in one /summary; the collectors must share one`);
      assert.strictEqual(meta.length, 1, `${id}: the metadata-only pod read is a different payload and stays its own read`);
    }
  } finally { await srv.close(); }
});

test('a rejected pod LIST reaches every coalesced caller as its own call would, and is not cached', { skip }, async () => {
  // safeList and requiredList classify on err.status before err.code, so a sharer handed a
  // different error shape than a lone caller would misreport forbidden as unavailable.
  const srv = await serve(() => ({ status: 403, body: JSON.stringify({ kind: 'Status', code: 403, reason: 'Forbidden' }) }));
  try {
    const [id] = freshIds(1);
    const cluster = { id, apiUrl: srv.url, caFile: TLS.cert };
    const alone = await list({ cluster, token: 't', path: '/api/v1/pods?limit=2000' }).catch(e => e);
    assert.strictEqual(srv.seen.length, 1);

    const paths = ['/api/v1/pods?limit=2000', '/api/v1/pods?limit=1500', '/api/v1/pods', '/api/v1/pods', '/api/v1/pods?limit=2000', '/api/v1/pods'];
    const shared = await Promise.all(paths.map(p => list({ cluster, token: 't', path: p }).catch(e => e)));
    assert.strictEqual(srv.seen.length, 2, 'a failed read must not be cached, and six concurrent ones must share one retry');

    assert.ok(alone instanceof Error, 'a 403 must reject');
    for (const err of shared) {
      assert.ok(err instanceof Error, 'every sharer must be rejected, none handed an empty list');
      assert.strictEqual(err.status, alone.status);
      assert.strictEqual(err.code, alone.code);
      assert.strictEqual(err.name, alone.name);
    }
  } finally { await srv.close(); }
});

test('the metadata-only read is keyed apart from the full pod list', { skip }, async () => {
  // Coalescing across `accept` would hand a collector that reads .spec a PartialObjectMetadata
  // list with no .spec, and it would silently count zero containers.
  const srv = await serve(() => ({ body: podListBody() }));
  try {
    const [id] = freshIds(1);
    const cluster = { id, apiUrl: srv.url, caFile: TLS.cert };
    await Promise.all([
      list({ cluster, token: 't', path: '/api/v1/pods' }),
      list({ cluster, token: 't', path: '/api/v1/pods', accept: METADATA_ONLY })
    ]);
    assert.strictEqual(srv.seen.length, 2);
  } finally { await srv.close(); }
});
