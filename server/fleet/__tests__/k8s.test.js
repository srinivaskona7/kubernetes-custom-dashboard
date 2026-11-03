import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

import _k8s from '../k8s.js';
const { call, list, RATE_LIMITED, USER_AGENT, MAX_LIST_ITEMS, MAX_IN_FLIGHT_PER_CLUSTER } = _k8s;
import _errors2 from '../errors.js';
const { UNAUTHENTICATED, FORBIDDEN, UNREACHABLE, UPSTREAM } = _errors2;

/**
 * These tests run against a real TLS server presenting a self-signed certificate, because
 * the bug they exist to prevent is invisible to a mocked transport: Node's global fetch is
 * undici, which ignores an `agent` option, so a per-cluster CA bundle was being dropped and
 * every call would have failed certificate verification in the cluster. Only an actual
 * handshake against an actual untrusted-by-default cert proves the CA is being applied.
 */
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tls-'));
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
  TLS = null; // openssl unavailable; the TLS-specific tests below skip
}

/** Start a one-off https server that replies with whatever the handler returns. */
async function serve(handler) {
  const server = https.createServer(
    { key: fs.readFileSync(TLS.key), cert: fs.readFileSync(TLS.cert) },
    (req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const out = handler(req, Buffer.concat(chunks).toString('utf8'));
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(out.body === undefined ? '' : out.body);
      });
    }
  );
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    // The cert's SAN is localhost, so the URL must say localhost, not 127.0.0.1.
    url: `https://localhost:${port}`,
    close: () => new Promise(r => server.close(r))
  };
}

const skip = TLS ? false : 'openssl not available to mint a test certificate';

test('the cluster CA bundle is actually applied to the TLS handshake', { skip }, async () => {
  const srv = await serve(() => ({ status: 200, body: JSON.stringify({ kind: 'NodeList', items: [{}, {}] }) }));
  try {
    const cluster = { id: 'platformsbx', apiUrl: srv.url, caFile: TLS.cert };
    const body = await call({ cluster, token: 't', path: '/api/v1/nodes' });
    assert.strictEqual(body.items.length, 2);
  } finally {
    await srv.close();
  }
});

test('without the CA the same call fails as UNREACHABLE, not silently succeeding', { skip }, async () => {
  const srv = await serve(() => ({ status: 200, body: '{}' }));
  try {
    // caFile omitted => the system trust store, which does not know this cert.
    const cluster = { id: 'platformsbx', apiUrl: srv.url };
    await assert.rejects(
      call({ cluster, token: 't', path: '/api/v1/nodes' }),
      err => {
        assert.strictEqual(err.code, UNREACHABLE);
        assert.match(err.message, /self[- ]signed|unable to verify/i);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('the bearer token and method reach the server intact', { skip }, async () => {
  let seen = null;
  const srv = await serve((req, body) => {
    seen = { auth: req.headers.authorization, method: req.method, url: req.url, body, ct: req.headers['content-type'] };
    return { status: 201, body: JSON.stringify({ status: { token: 'new' } }) };
  });
  try {
    const cluster = { id: 'platformsbx', apiUrl: srv.url, caFile: TLS.cert };
    await call({
      cluster, token: 'eyJ-abc', path: '/api/v1/namespaces/fleet-dashboard/serviceaccounts/fleet-reader/token',
      method: 'POST', body: { kind: 'TokenRequest' }
    });
    assert.strictEqual(seen.auth, 'Bearer eyJ-abc');
    assert.strictEqual(seen.method, 'POST');
    assert.strictEqual(seen.ct, 'application/json');
    assert.deepStrictEqual(JSON.parse(seen.body), { kind: 'TokenRequest' });
  } finally {
    await srv.close();
  }
});

test('a custom content type survives, which is what makes the merge patch a merge', { skip }, async () => {
  let ct = null;
  const srv = await serve(req => { ct = req.headers['content-type']; return { status: 200, body: '{}' }; });
  try {
    await call({
      cluster: { id: 'hub', apiUrl: srv.url, caFile: TLS.cert }, token: 't', path: '/x',
      method: 'PATCH', contentType: 'application/strategic-merge-patch+json', body: { data: {} }
    });
    assert.strictEqual(ct, 'application/strategic-merge-patch+json',
      'a plain application/json PATCH would replace the Secret data wholesale');
  } finally {
    await srv.close();
  }
});

test('401 and 403 stay distinguishable, and the API server message wins', { skip }, async () => {
  const srv = await serve(req => req.url.includes('deny')
    ? { status: 403, body: JSON.stringify({ message: 'serviceaccounts "fleet-reader" is forbidden' }) }
    : { status: 401, body: JSON.stringify({ message: 'Unauthorized' }) });
  try {
    const cluster = { id: 'platformsbx', apiUrl: srv.url, caFile: TLS.cert };

    await assert.rejects(call({ cluster, token: 't', path: '/deny' }), err => {
      // 403 means the chain is fine but a rule is missing — re-seeding would not help.
      assert.strictEqual(err.code, FORBIDDEN);
      assert.strictEqual(err.needsReseed, false);
      assert.match(err.message, /is forbidden/);
      return true;
    });

    await assert.rejects(call({ cluster, token: 't', path: '/expired' }), err => {
      assert.strictEqual(err.code, UNAUTHENTICATED);
      assert.strictEqual(err.needsReseed, true, '401 is the broken-chain signal the UI acts on');
      return true;
    });
  } finally {
    await srv.close();
  }
});

test('a non-JSON 200 is reported as UPSTREAM rather than crashing the sweep', { skip }, async () => {
  const srv = await serve(() => ({ status: 200, body: '<html>gateway</html>' }));
  try {
    await assert.rejects(
      call({ cluster: { id: 'platformsbx', apiUrl: srv.url, caFile: TLS.cert }, token: 't', path: '/x' }),
      err => { assert.strictEqual(err.code, UPSTREAM); return true; }
    );
  } finally {
    await srv.close();
  }
});

test('list returns [] rather than throwing when items is absent', { skip }, async () => {
  const srv = await serve(() => ({ status: 200, body: JSON.stringify({ kind: 'Status' }) }));
  try {
    const out = await list({ cluster: { id: 'x', apiUrl: srv.url, caFile: TLS.cert }, token: 't', path: '/x' });
    assert.deepStrictEqual(out, []);
  } finally {
    await srv.close();
  }
});

test('a slow server trips the timeout instead of hanging the request', { skip }, async () => {
  const server = https.createServer(
    { key: fs.readFileSync(TLS.key), cert: fs.readFileSync(TLS.cert) },
    () => { /* deliberately never respond */ }
  );
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `https://localhost:${server.address().port}`;
  try {
    await assert.rejects(
      call({ cluster: { id: 'platformsbx', apiUrl: url, caFile: TLS.cert }, token: 't', path: '/x', timeoutMs: 250 }),
      err => {
        assert.strictEqual(err.code, UNREACHABLE);
        assert.match(err.message, /timed out after 250ms/);
        return true;
      }
    );
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('a plaintext api url is refused before the token is sent', async () => {
  await assert.rejects(
    call({ cluster: { id: 'x', apiUrl: 'http://api.internal' }, token: 'secret', path: '/x' }),
    err => {
      assert.strictEqual(err.code, UNREACHABLE);
      assert.match(err.message, /refusing to send a bearer token over http:/);
      return true;
    }
  );
});

/* ==============================================================================
 * Paging, retrying, and the LIST hints.
 *
 * These drive the injected `transport` seam instead of a socket. What is under test
 * here is which URLs we build and how we react to a status line — a real server would
 * add a handshake and a scheduler to that and prove nothing extra. `sleep` is injected
 * too, so a backoff test costs microseconds and the delays it asked for become
 * assertable rather than merely endured.
 * ============================================================================== */

const CLUSTER = { id: 'platformsbx', apiUrl: 'https://api.example.invalid' };

/**
 * A transport that answers from a queue (or a function of the request) and records every
 * request it was handed. `{ throw: err }` makes it fail the way a dead socket does.
 */
function fakeTransport(responses) {
  const seen = [];
  const queue = Array.isArray(responses) ? responses.slice() : null;
  const fn = async req => {
    seen.push(req);
    const next = queue ? queue.shift() : responses(req, seen.length);
    if (!next) throw new Error(`no canned response for request #${seen.length} ${req.url}`);
    if (next.throw) throw next.throw;
    return {
      status: next.status === undefined ? 200 : next.status,
      statusText: next.statusText || '',
      headers: next.headers || {},
      body: typeof next.body === 'string'
        ? next.body
        : JSON.stringify(next.body === undefined ? {} : next.body)
    };
  };
  fn.seen = seen;
  return fn;
}

/** Records what the code asked to wait for, without anyone actually waiting. */
function fakeSleep() {
  const waited = [];
  const fn = async ms => { waited.push(ms); };
  fn.waited = waited;
  return fn;
}

const query = url => new URL(url).searchParams;
const page = (items, cont) => ({ body: { kind: 'PodList', metadata: cont ? { continue: cont } : {}, items } });

test('a chunked LIST follows the continue cursor and returns every item, in order', async () => {
  // A continue token is base64 and routinely contains +, / and =.
  const token2 = 'eyJ2IjoibWV0YS5rOHMv+Zm9vL2Jhcg==';
  const transport = fakeTransport([
    page([{ n: 1 }, { n: 2 }], token2),
    page([{ n: 3 }, { n: 4 }], 'tok-3'),
    page([{ n: 5 }])
  ]);

  const out = await list({ cluster: CLUSTER, token: 't', path: '/api/v1/pods?limit=2', transport, sleep: fakeSleep() });

  assert.deepStrictEqual(out.map(i => i.n), [1, 2, 3, 4, 5],
    'the old implementation stopped at [1, 2] and every caller believed it');
  assert.strictEqual(transport.seen.length, 3);
  assert.strictEqual(out.truncated, undefined, 'a list that finished is not truncated');

  assert.strictEqual(query(transport.seen[1].url).get('continue'), token2,
    'the cursor must survive the round trip byte for byte');
  assert.strictEqual(query(transport.seen[2].url).get('continue'), 'tok-3');
  assert.strictEqual(query(transport.seen[1].url).get('limit'), '2',
    "the caller's own page size is not clobbered");
});

test('an empty page carrying a continue token keeps paging, because a selector can filter a whole chunk', async () => {
  const transport = fakeTransport([
    page([], 'tok-2'),
    page([], 'tok-3'),
    page([{ n: 'the only match' }])
  ]);
  const out = await list({ cluster: CLUSTER, token: 't', path: '/api/v1/pods?limit=500&labelSelector=rare%3Dtrue', transport });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(transport.seen.length, 3, 'an empty page is not the end of the list');
});

test('a runaway LIST stops at the ceiling and says so', async () => {
  const chunk = Array.from({ length: 5000 }, (_, i) => ({ i }));
  const transport = fakeTransport(() => page(chunk, 'never-ending'));

  const out = await list({ cluster: CLUSTER, token: 't', path: '/api/v1/pods?limit=5000', transport });

  assert.strictEqual(out.length, MAX_LIST_ITEMS);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(transport.seen.length, MAX_LIST_ITEMS / 5000,
    'hitting the ceiling exactly costs no extra round trip');
});

test('the truncated flag is non-enumerable, so nothing downstream can see it by accident', async () => {
  const chunk = Array.from({ length: 10000 }, (_, i) => ({ i }));
  const out = await list({
    cluster: CLUSTER, token: 't', path: '/api/v1/pods?limit=10000',
    transport: fakeTransport(() => page(chunk, 'never-ending'))
  });

  assert.strictEqual(out.truncated, true, 'a caller that asks by name gets the flag');
  assert.ok(Array.isArray(out));
  assert.strictEqual(JSON.stringify(out), JSON.stringify([...out]),
    'the wire shape is identical to a plain array');
  assert.deepStrictEqual(Object.keys(out).filter(k => !/^\d+$/.test(k)), [],
    'no string key leaks into Object.keys / for..in / spread-into-object');
  assert.strictEqual(out.length, MAX_LIST_ITEMS);
  assert.strictEqual([...out].truncated, undefined);
});

test('a LIST asks for the watch cache; { consistent: true } pays for the quorum read', async () => {
  const cached = fakeTransport([page([])]);
  await list({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport: cached });
  assert.strictEqual(query(cached.seen[0].url).get('resourceVersion'), '0');

  const consistent = fakeTransport([page([])]);
  await list({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', consistent: true, transport: consistent });
  assert.strictEqual(query(consistent.seen[0].url).get('resourceVersion'), null);
  assert.strictEqual(consistent.seen[0].url, 'https://api.example.invalid/api/v1/nodes',
    'a consistent read adds nothing at all to the path');
});

test('the resourceVersion hint is dropped on continuation pages, where it means nothing', async () => {
  const transport = fakeTransport([page([{ n: 1 }], 'tok-2'), page([{ n: 2 }])]);
  await list({ cluster: CLUSTER, token: 't', path: '/api/v1/pods?limit=1', transport });
  assert.strictEqual(query(transport.seen[0].url).get('resourceVersion'), '0');
  assert.strictEqual(query(transport.seen[1].url).get('resourceVersion'), null,
    'the continue token already pins the read; the server would be entitled to reject both');
});

test("a caller's existing query string is appended to, never re-encoded", async () => {
  const transport = fakeTransport([page([])]);
  await list({ cluster: CLUSTER, token: 't', path: '/api/v1/secrets?fieldSelector=metadata.name%3Dfleet-pull', transport });
  assert.strictEqual(
    transport.seen[0].url,
    'https://api.example.invalid/api/v1/secrets?fieldSelector=metadata.name%3Dfleet-pull&resourceVersion=0',
    'round-tripping the query through URLSearchParams would silently rewrite the %3D'
  );
});

test('every request identifies the dashboard to the apiserver audit log', async () => {
  const transport = fakeTransport([{ status: 200, body: {} }]);
  await call({ cluster: CLUSTER, token: 't', path: '/x', transport });
  assert.strictEqual(transport.seen[0].headers['User-Agent'], USER_AGENT);
  assert.match(transport.seen[0].headers['User-Agent'], /^k8s-fleet-dashboard\/\d+\.\d+\.\d+/);
});

test('a 429 with Retry-After in seconds is obeyed, and the retry succeeds', async () => {
  const sleep = fakeSleep();
  const transport = fakeTransport([
    { status: 429, headers: { 'retry-after': '1' }, body: { message: 'too many requests' } },
    { status: 200, body: { kind: 'NodeList', items: [{ name: 'node-1' }] } }
  ]);

  const body = await call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep });

  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(transport.seen.length, 2);
  assert.deepStrictEqual(sleep.waited, [1000], 'delta-seconds means seconds, not milliseconds');
});

test('a 429 with an HTTP-date Retry-After is read as a deadline, not a number', async () => {
  const sleep = fakeSleep();
  const transport = fakeTransport([
    { status: 429, headers: { 'retry-after': new Date(Date.now() + 2000).toUTCString() }, body: {} },
    { status: 200, body: { items: [] } }
  ]);

  await call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep });

  assert.strictEqual(sleep.waited.length, 1);
  // toUTCString truncates to whole seconds, so the remaining delta lands in (1000, 2000].
  assert.ok(sleep.waited[0] > 1000 && sleep.waited[0] <= 2000,
    `expected roughly 2000ms, waited ${sleep.waited[0]}ms — Number('Wed, 21 Oct...') is NaN, not a delay`);
});

test('an absurd Retry-After is clamped rather than stalling the whole fan-out', async () => {
  const sleep = fakeSleep();
  const transport = fakeTransport([
    { status: 429, headers: { 'retry-after': '600' }, body: {} },
    { status: 200, body: { items: [] } }
  ]);
  await call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep });
  assert.strictEqual(sleep.waited[0], 5000);
});

test('a 429 with no Retry-After falls back to jittered exponential backoff', async () => {
  const sleep = fakeSleep();
  const transport = fakeTransport([
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 200, body: { items: [] } }
  ]);
  await call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep });
  assert.strictEqual(sleep.waited.length, 2);
  // Equal jitter: half the window is fixed, half is random, so the two ranges are
  // [125, 250] and [250, 500] — bounded and non-overlapping except at the single point.
  assert.ok(sleep.waited[0] >= 125 && sleep.waited[0] <= 250, `first backoff ${sleep.waited[0]}ms`);
  assert.ok(sleep.waited[1] >= 250 && sleep.waited[1] <= 500, `second backoff ${sleep.waited[1]}ms`);
});

test('three consecutive 429s give up with a typed RATE_LIMITED', async () => {
  const sleep = fakeSleep();
  const transport = fakeTransport(() => ({
    status: 429, headers: { 'retry-after': '1' },
    body: { message: 'the server is currently unable to handle the request' }
  }));

  await assert.rejects(call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep }), err => {
    assert.strictEqual(err.name, 'ClusterError');
    assert.strictEqual(err.code, RATE_LIMITED);
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.cluster, 'platformsbx');
    assert.strictEqual(err.needsReseed, false, 'being throttled is not a broken credential');
    assert.match(err.message, /unable to handle the request/);
    return true;
  });

  assert.strictEqual(transport.seen.length, 3, 'three attempts, not four');
  assert.strictEqual(sleep.waited.length, 2, 'no pointless sleep after the final failure');
});

test('a 403 is a decision, not a delay, and is never retried', async () => {
  const sleep = fakeSleep();
  const transport = fakeTransport(() => ({
    status: 403, body: { message: 'nodes is forbidden: User "system:serviceaccount:fleet-dashboard:fleet-reader" cannot list' }
  }));

  await assert.rejects(call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep }), err => {
    assert.strictEqual(err.code, FORBIDDEN);
    return true;
  });

  assert.strictEqual(transport.seen.length, 1, 'retrying a missing RBAC rule just wastes the budget');
  assert.deepStrictEqual(sleep.waited, []);
});

test('the other non-429 failures are not retried either', async () => {
  for (const [status, code] of [[401, UNAUTHENTICATED], [404, UPSTREAM], [500, UPSTREAM]]) {
    const transport = fakeTransport(() => ({ status, body: {} }));
    await assert.rejects(
      call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep: fakeSleep() }),
      err => { assert.strictEqual(err.code, code); return true; }
    );
    assert.strictEqual(transport.seen.length, 1, `${status} must not be retried`);
  }
});

test('a 503 and a dropped socket are both retried', async () => {
  const unavailable = fakeTransport([
    { status: 503, headers: { 'retry-after': '2' }, body: { message: 'apiserver is restarting' } },
    { status: 200, body: { items: [{}] } }
  ]);
  const sleep = fakeSleep();
  await call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport: unavailable, sleep });
  assert.strictEqual(unavailable.seen.length, 2);
  assert.deepStrictEqual(sleep.waited, [2000]);

  const reset = fakeTransport([
    { throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
    { status: 200, body: { items: [{}] } }
  ]);
  const body = await call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport: reset, sleep: fakeSleep() });
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(reset.seen.length, 2);
});

test('our own deadline is a deadline, not a blip: it is reported, not retried three times over', async () => {
  const transport = fakeTransport(() => ({
    throw: Object.assign(new Error('timed out after 8000ms'), { name: 'TimeoutError' })
  }));
  const sleep = fakeSleep();

  await assert.rejects(call({ cluster: CLUSTER, token: 't', path: '/api/v1/nodes', transport, sleep }), err => {
    assert.strictEqual(err.code, UNREACHABLE);
    assert.match(err.message, /timed out after 8000ms/);
    return true;
  });

  assert.strictEqual(transport.seen.length, 1, 'retrying would triple the time budget the caller asked for');
});

test('a throttled mutation is never replayed', async () => {
  const transport = fakeTransport(() => ({ status: 429, headers: { 'retry-after': '1' }, body: { message: 'slow down' } }));
  const sleep = fakeSleep();

  await assert.rejects(call({
    cluster: CLUSTER, token: 't',
    path: '/api/v1/namespaces/fleet-dashboard/serviceaccounts/fleet-reader/token',
    method: 'POST', body: { kind: 'TokenRequest' }, transport, sleep
  }), err => {
    assert.strictEqual(err.code, RATE_LIMITED, 'still typed, so the UI can say "busy" rather than "broken"');
    return true;
  });

  assert.strictEqual(transport.seen.length, 1, 'replaying a TokenRequest would mint a second token nobody holds');
  assert.deepStrictEqual(sleep.waited, []);
});

test('no more than eight reads are in flight against one apiserver', async () => {
  const cluster = { id: 'gate-under-test', apiUrl: 'https://api.example.invalid' };
  const BURST = 20;
  let active = 0;
  let peak = 0;
  const pending = [];

  const transport = () => {
    active += 1;
    peak = Math.max(peak, active);
    return new Promise(resolve => pending.push(() => {
      active -= 1;
      resolve({ status: 200, statusText: '', headers: {}, body: JSON.stringify({ items: [] }) });
    }));
  };

  const burst = Promise.all(Array.from({ length: BURST }, () =>
    list({ cluster, token: 't', path: '/api/v1/pods', transport })));

  for (let done = 0; done < BURST; done++) {
    await new Promise(r => setImmediate(r));
    assert.ok(pending.length > 0, `the queue stalled after ${done} completions — a slot was leaked`);
    if (done === 0) {
      assert.strictEqual(pending.length, MAX_IN_FLIGHT_PER_CLUSTER,
        'the first wave is exactly the gate width, not all twenty');
    }
    pending.shift()();
  }

  await burst;
  assert.strictEqual(peak, MAX_IN_FLIGHT_PER_CLUSTER);
  assert.strictEqual(active, 0, 'every slot came back');
});
