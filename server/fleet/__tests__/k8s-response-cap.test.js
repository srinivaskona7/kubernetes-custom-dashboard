
/**
 * The ceiling on one apiserver response.
 *
 * Why this is its own file: `MAX_RESPONSE_BYTES` is read from the environment once, when
 * `k8s.js` is loaded, because it is a deployment property and not a per-call one. `node --test`
 * gives every file its own process, so setting the env var here and requiring the module after
 * exercises the real production path rather than a test-only parameter threaded through `call`.
 *
 * The defect: `request` buffered whatever the server sent and handed the whole thing to
 * `JSON.parse` with no limit at all. The pod is `limits.memory: 500M` at `replicaCount: 1`, the
 * per-cluster gate allows 8 concurrent reads, and a parsed object graph costs several times its
 * own text — so one unbounded collection could take the fleet API down for every user.
 *
 * Two halves, and the second is the one that matters. The read path sends
 * `Accept-Encoding: gzip`, so counting only the bytes that arrive on the socket is not a cap: a
 * 200 KB body on the wire can be gigabytes once inflated. The decompressed limit is enforced by
 * zlib *while inflating*, so the bomb is never allocated.
 */
// ESM hoists imports above statements, so the env var has to be set by a hoisted block.
vi.hoisted(() => { process.env.FLEET_MAX_RESPONSE_BYTES = String(64 * 1024); });

import { test, vi } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

import _k8s from '../k8s.js';
const { call } = _k8s;
import _errors2 from '../errors.js';
const { UPSTREAM } = _errors2;

const CAP = 64 * 1024;

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cap-tls-'));
  const key = path.join(dir, 'tls.key');
  const cert = path.join(dir, 'tls.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost'
  ], { stdio: 'ignore' });
  return { dir, key, cert };
}

let TLS = null;
try {
  TLS = selfSigned();
} catch {
  TLS = null;
}
const skip = TLS ? false : 'openssl not available to mint a test certificate';

/** `reply(res)` writes the body however the test needs — plain, gzipped, or a slow drip. */
async function serve(reply) {
  const server = https.createServer(
    { key: fs.readFileSync(TLS.key), cert: fs.readFileSync(TLS.cert) },
    (_req, res) => reply(res)
  );
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `https://localhost:${server.address().port}`,
    close: () => new Promise(r => server.close(r))
  };
}

const cluster = url => ({ id: 'cap-test', apiUrl: url, caFile: TLS && TLS.cert });

test('a body over the cap is refused instead of buffered', { skip }, async () => {
  // A JSON array of ~1 MB, well over the 64 KB cap this process was started with.
  const huge = JSON.stringify({ kind: 'PodList', items: Array.from({ length: 12000 }, (_, i) => ({ name: `pod-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` })) });
  assert.ok(huge.length > CAP * 4, 'the fixture must be comfortably over the cap');
  const srv = await serve(res => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(huge);
  });
  try {
    await assert.rejects(
      call({ cluster: cluster(srv.url), token: 't', path: '/api/v1/pods' }),
      err => {
        // UPSTREAM, not UNREACHABLE: the cluster answered perfectly well. Telling the operator
        // the cluster is down when the problem is the size of its answer sends them to the
        // wrong place entirely.
        assert.strictEqual(err.code, UPSTREAM);
        assert.match(err.message, /exceeds the 65536 byte response cap/);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('a gzip bomb is refused while inflating, not after', { skip }, async () => {
  // 8 MB of zeroes compresses to a few KB — under the cap on the wire, 128x over it in memory.
  // A cap that only counted received bytes would let this one through, which is the whole
  // reason the decompressed half exists.
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
  assert.ok(bomb.length < CAP, `the compressed form must be under the cap to prove the point (${bomb.length})`);
  const srv = await serve(res => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(bomb);
  });
  try {
    await assert.rejects(
      call({ cluster: cluster(srv.url), token: 't', path: '/api/v1/pods' }),
      err => {
        assert.strictEqual(err.code, UPSTREAM);
        assert.match(err.message, /decompressed gzip body exceeds/);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('a body under the cap is unaffected, compressed or not', { skip }, async () => {
  const payload = JSON.stringify({ kind: 'PodList', items: [{ name: 'a' }, { name: 'b' }] });
  for (const gzipped of [false, true]) {
    const srv = await serve(res => {
      const headers = { 'Content-Type': 'application/json' };
      if (gzipped) headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(gzipped ? zlib.gzipSync(payload) : payload);
    });
    try {
      const out = await call({ cluster: cluster(srv.url), token: 't', path: '/api/v1/pods' });
      assert.strictEqual(out.items.length, 2, `gzipped=${gzipped}`);
    } finally {
      await srv.close();
    }
  }
});

test('an oversize read is not retried — the second attempt would cost the same bytes', { skip }, async () => {
  let attempts = 0;
  const huge = 'x'.repeat(CAP * 3);
  const srv = await serve(res => {
    attempts += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pad: huge }));
  });
  try {
    await assert.rejects(call({ cluster: cluster(srv.url), token: 't', path: '/api/v1/pods' }));
    assert.strictEqual(attempts, 1, `the oversize response was retried ${attempts} times`);
  } finally {
    await srv.close();
  }
});
