/**
 * Pasted service-account tokens.
 *
 * The decoder is the part an operator meets when they get it wrong, so most of these tests
 * are about the rejections: what was pasted, and whether the message says something useful
 * about it. Pasting a kubeconfig, a URL, or the whole `kubectl` command line into the token
 * box are the three mistakes worth naming.
 *
 * The claims are never trusted for access — `adopt` proves the token against the cluster.
 * The test that matters most here is the last one: a token that cannot mint its successor
 * still onboards, because monitoring a cluster whose chain needs fixing beats not
 * monitoring it, but it must say so.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import saToken from '../sa-token.js';
import _errors from '../errors.js';
const { ClusterError } = _errors;

const CLUSTER = { id: 'platform-dev', apiUrl: 'https://api.example.com' };
const HOUR = 3600;
const NOW = Math.floor(Date.parse('2026-09-01T10:00:00Z') / 1000);

/** Build a token the way the API server does, minus the signature we never check. */
function makeToken(claims = {}, { segments = 3 } = {}) {
  const body = {
    sub: 'system:serviceaccount:fleet-dashboard:fleet-reader',
    iss: 'https://kubernetes.default.svc',
    iat: NOW,
    exp: NOW + 24 * HOUR,
    ...claims
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete body[k];
  const b64 = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const parts = ['eyJhbGciOiJSUzI1NiJ9', b64(body), 'c2lnbmF0dXJl'];
  return parts.slice(0, segments).join('.');
}

// -------------------------------------------------------------------- decode

test('the namespace and service account are read off the token, not asked for', () => {
  const claims = saToken.decode(makeToken());
  assert.equal(claims.namespace, 'fleet-dashboard');
  assert.equal(claims.serviceAccount, 'fleet-reader');
});

test('the expiry is the token\'s own, not a duration we assumed', () => {
  const claims = saToken.decode(makeToken({ exp: NOW + 6 * HOUR }));
  assert.equal(claims.expiresAt, new Date((NOW + 6 * HOUR) * 1000).toISOString());
});

test('surrounding whitespace from a copy-paste is tolerated', () => {
  const claims = saToken.decode(`  ${makeToken()}\n`);
  assert.equal(claims.namespace, 'fleet-dashboard');
});

test('whitespace inside means the command line was pasted, and the message says so', () => {
  assert.throws(
    () => saToken.decode(`kubectl create token fleet-reader ${makeToken()}`),
    err => err.status === 400 && /not the command that printed it/.test(err.message)
  );
});

test('a pasted kubeconfig is named as such, and pointed at the other tab', () => {
  // A kubeconfig is full of newlines, so this has to be checked before the whitespace
  // complaint or the operator is told to "paste only the token" about a YAML file.
  const kubeconfig = 'apiVersion: v1\nkind: Config\nclusters:\n  - name: x\n';
  assert.throws(
    () => saToken.decode(kubeconfig),
    err => err.status === 400 && /kubeconfig tab/.test(err.message)
  );
});

test('a token with two segments is refused', () => {
  assert.throws(() => saToken.decode(makeToken({}, { segments: 2 })), err => err.status === 400);
});

test('a user token is refused — only a service account can be a fleet identity', () => {
  assert.throws(
    () => saToken.decode(makeToken({ sub: 'jo@example.com' })),
    err => err.status === 400 && /service-account token/.test(err.message)
  );
});

test('a service account in a namespace that could escape a path is refused', () => {
  assert.throws(
    () => saToken.decode(makeToken({ sub: 'system:serviceaccount:../etc:fleet-reader' })),
    err => err.status === 400
  );
});

test('a token that never expires is refused, and the message names the fix', () => {
  // Legacy non-expiring SA tokens exist. Storing one would put a permanent credential in
  // the Secret while the UI claimed a 24h chain.
  assert.throws(
    () => saToken.decode(makeToken({ exp: undefined })),
    err => err.status === 400 && /--duration=24h/.test(err.message)
  );
});

test('an unreadable expiry is refused rather than becoming an Invalid Date', () => {
  assert.throws(() => saToken.decode(makeToken({ exp: 'soon' })), err => err.status === 400);
});

test('an empty paste is refused before anything is parsed', () => {
  assert.throws(() => saToken.decode('   '), err => err.status === 400);
});

test('claims that are not JSON are refused', () => {
  const bad = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from('{ not json', 'utf8').toString('base64url'), 'sig'].join('.');
  assert.throws(() => saToken.decode(bad), err => err.status === 400 && /not readable/.test(err.message));
});

test('an absurdly long paste is refused by size before being parsed', () => {
  assert.throws(
    () => saToken.decode('a.' + 'x'.repeat(saToken.MAX_TOKEN_BYTES) + '.c'),
    err => err.status === 400 && /bytes/.test(err.message)
  );
});

test('the error class is the one the router maps to a 400', () => {
  assert.throws(() => saToken.decode(''), saToken.SaTokenError);
});

// --------------------------------------------------------------------- adopt

function capture(handlers) {
  const calls = [];
  return {
    calls,
    callFn: async args => {
      calls.push(args);
      for (const [match, respond] of handlers) {
        if (args.path.includes(match)) return typeof respond === 'function' ? respond(args) : respond;
      }
      return {};
    }
  };
}

const MINTED = {
  status: { token: makeToken({ exp: NOW + 24 * HOUR }), expirationTimestamp: '2026-09-02T10:00:00Z' }
};

test('the token is proved against the cluster before anything is stored', async () => {
  const api = capture([['/version', { gitVersion: 'v1.30.7' }], ['/token', MINTED]]);
  const claims = saToken.decode(makeToken());
  await saToken.adopt({ cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn });
  assert.ok(api.calls[0].path.startsWith('/api/v1/namespaces'), 'the first call is the read that proves the token');
});

test('a token that cannot read is rejected, and nothing further is attempted', async () => {
  const api = {
    calls: [],
    callFn: async args => {
      api.calls.push(args);
      throw new ClusterError('UNAUTHENTICATED', 'unauthorized', { status: 401 });
    }
  };
  const claims = saToken.decode(makeToken());
  await assert.rejects(() => saToken.adopt({ cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn }));
  assert.equal(api.calls.length, 1);
});

test('the successor is minted and stored instead of what was pasted', async () => {
  const api = capture([['/version', { gitVersion: 'v1.30.7' }], ['/token', MINTED]]);
  const claims = saToken.decode(makeToken());
  const out = await saToken.adopt({ cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn });

  assert.notEqual(out.token, 'pasted', 'the pasted token must not be the one we keep');
  assert.equal(out.expiresAt, '2026-09-02T10:00:00Z');
  assert.equal(out.renewable, true);
});

test('the mint request carries no audiences, which would make the token unusable', async () => {
  const api = capture([['/version', { gitVersion: 'v1' }], ['/token', MINTED]]);
  const claims = saToken.decode(makeToken());
  await saToken.adopt({ cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn });
  const mintCall = api.calls.find(c => c.path.endsWith('/token'));
  assert.ok(!('audiences' in mintCall.body.spec));
});

test('the mint targets the service account the token itself named', async () => {
  const api = capture([['/version', { gitVersion: 'v1' }], ['/token', MINTED]]);
  const claims = saToken.decode(makeToken({ sub: 'system:serviceaccount:ops:watcher' }));
  await saToken.adopt({ cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn });
  const mintCall = api.calls.find(c => c.path.endsWith('/token'));
  assert.equal(mintCall.path, '/api/v1/namespaces/ops/serviceaccounts/watcher/token');
});

test('a token that cannot mint its successor still onboards, with a warning and the fix', async () => {
  const api = {
    callFn: async args => {
      if (args.path.endsWith('/token')) throw new ClusterError('FORBIDDEN', 'forbidden', { status: 403 });
      if (args.path === '/version') return { gitVersion: 'v1.30.7' };
      return {};
    }
  };
  const claims = saToken.decode(makeToken());
  const out = await saToken.adopt({ cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn });

  assert.equal(out.renewable, false);
  assert.equal(out.token, 'pasted', 'with no successor, the pasted token is all we have');
  const warn = out.steps.find(s => s.id === 'selfmint');
  assert.equal(warn.level, 'warn');
  assert.match(warn.detail, /go dark/);
  assert.match(warn.detail, /serviceaccounts\/token/);
});

test('a custom audience is warned about, because it produces a 401 that looks like a typo', async () => {
  const api = capture([['/version', { gitVersion: 'v1' }], ['/token', MINTED]]);
  const claims = saToken.decode(makeToken({ aud: ['https://something-else'] }));
  const out = await saToken.adopt({ cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn });
  const step = out.steps.find(s => s.id === 'audience');
  assert.equal(step.level, 'warn');
});

test('the steps are reported as they happen, so the dialog can show progress', async () => {
  const api = capture([['/version', { gitVersion: 'v1' }], ['/token', MINTED]]);
  const seen = [];
  const claims = saToken.decode(makeToken());
  const out = await saToken.adopt({
    cluster: CLUSTER, token: 'pasted', claims, callFn: api.callFn, onStep: s => seen.push(s.id)
  });
  assert.deepEqual(seen, out.steps.map(s => s.id));
  assert.deepEqual(seen, ['decode', 'verify', 'version', 'selfmint']);
});

test('no step ever contains the token', async () => {
  const api = capture([['/version', { gitVersion: 'v1' }], ['/token', MINTED]]);
  const pasted = makeToken();
  const claims = saToken.decode(pasted);
  const out = await saToken.adopt({ cluster: CLUSTER, token: pasted, claims, callFn: api.callFn });
  for (const step of out.steps) {
    assert.ok(!step.detail.includes(pasted), `step ${step.id} leaked the token`);
    assert.ok(!step.detail.includes(MINTED.status.token), `step ${step.id} leaked the minted token`);
  }
});
