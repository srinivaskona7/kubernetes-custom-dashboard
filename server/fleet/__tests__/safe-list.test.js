import { test } from 'vitest';
import assert from 'node:assert/strict';

import _safe_list from '../collectors/safe-list.js';
const { safeList, unavailableLabels, truncatedLabels, isTruncated } = _safe_list;
import _errors2 from '../errors.js';
const { ClusterError, UNAUTHENTICATED, FORBIDDEN, UNREACHABLE, UPSTREAM } = _errors2;

/**
 * The behaviour under test is a distinction, not a value: a 404 and a 403 both produce zero
 * items, and only one of them means the fleet is clean. Every case below therefore asserts
 * `unavailable` as well as `items`, because asserting the count alone would pass under the
 * exact bug this module exists to remove.
 */

const CTX = { cluster: { id: 'c1', apiUrl: 'https://api.example.invalid' }, token: 'tok' };
const PATH = '/apis/cert-manager.io/v1/certificates';
const LABEL = 'certificates';

/** A listFn that always throws the given value. */
const throwing = err => async () => { throw err; };

/** A listFn that resolves with the given items, recording the args it was called with. */
function resolving(items) {
  const calls = [];
  const fn = async args => { calls.push(args); return items; };
  fn.calls = calls;
  return fn;
}

/** Shorthand: run safeList against a thrower and return the result. */
const failWith = err => safeList(throwing(err), CTX, PATH, LABEL);

/** An array marked the way `k8s.list` marks one that stopped at its paging ceiling. */
function truncatedArray(items) {
  return Object.defineProperty([...items], 'truncated', { value: true });
}

// --- true zero: the CRD is simply not installed ------------------------------------------

test('404 is a true zero, not an outage', async () => {
  const result = await failWith(Object.assign(new Error('the server could not find the requested resource'), { status: 404 }));
  assert.deepEqual(result, { label: LABEL, items: [], unavailable: false, reason: null, detail: null, truncated: false });
});

test('a ClusterError carrying status 404 is a true zero even though its code is UPSTREAM', async () => {
  // The production shape. srv/fleet/k8s.js maps every non-401/403 status onto UPSTREAM via
  // codeForStatus, keeping the real number in `status`. Reading the code instead of the
  // status would report every uninstalled CRD in the fleet as an upstream fault.
  const err = new ClusterError(UPSTREAM, 'the server could not find the requested resource', { cluster: 'c1', status: 404 });
  const result = await failWith(err);
  assert.equal(result.unavailable, false);
  assert.equal(result.reason, null);
  assert.equal(result.detail, null);
  assert.deepEqual(result.items, []);
});

test('a Kubernetes Status body with reason NotFound is a true zero without any numeric status', async () => {
  const err = Object.assign(new Error('HTTP request failed'), {
    body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', message: 'certificates.cert-manager.io not found' }
  });
  const result = await failWith(err);
  assert.equal(result.unavailable, false);
  assert.equal(result.reason, null);
  assert.equal(result.detail, null);
});

test('a Status body arriving as JSON text is parsed, and NotFound is still a true zero', async () => {
  const err = Object.assign(new Error('HTTP request failed'), {
    body: JSON.stringify({ kind: 'Status', code: 404, reason: 'NotFound', message: 'no such resource type' })
  });
  const result = await failWith(err);
  assert.equal(result.unavailable, false);
  assert.equal(result.reason, null);
});

test('a bare no-matching-CRD message with no status at all is a true zero', async () => {
  const result = await failWith(new Error('the server doesn\'t have a resource type "apirules"'));
  assert.equal(result.unavailable, false);
  assert.equal(result.reason, null);
});

// --- unavailable: every non-404 failure ---------------------------------------------------

test('403 is FORBIDDEN', async () => {
  const result = await failWith(Object.assign(new Error('forbidden'), { status: 403 }));
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'FORBIDDEN');
  assert.equal(result.label, LABEL);
  assert.deepEqual(result.items, []);
});

test('a ClusterError with code FORBIDDEN is FORBIDDEN, and the RBAC message survives intact', async () => {
  const message = 'certificates.cert-manager.io is forbidden: User "system:serviceaccount:fleet:fleet-reader" cannot list resource "certificates" in API group "cert-manager.io" at the cluster scope';
  const result = await failWith(new ClusterError(FORBIDDEN, message, { cluster: 'c1', status: 403 }));
  assert.equal(result.reason, 'FORBIDDEN');
  assert.equal(result.detail, message, 'the denial names the exact missing rule and must not be truncated away');
});

test('401 is UNAUTHORIZED', async () => {
  const result = await failWith(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'UNAUTHORIZED');
});

test('a ClusterError with the codebase code UNAUTHENTICATED reports as UNAUTHORIZED', async () => {
  // srv/fleet/errors.js calls a 401 UNAUTHENTICATED; this module's contract with the UI
  // says UNAUTHORIZED. Both are accepted in; only UNAUTHORIZED goes out.
  const result = await failWith(new ClusterError(UNAUTHENTICATED, 'token rejected', { cluster: 'c1' }));
  assert.equal(result.reason, 'UNAUTHORIZED');
});

test('429 is RATE_LIMITED', async () => {
  const result = await failWith(Object.assign(new Error('too many requests'), { status: 429 }));
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'RATE_LIMITED');
});

test('a typed RATE_LIMITED code is honoured even with no HTTP status on the error', async () => {
  // k8s.js is growing a RATE_LIMITED ClusterError code; handle it before it lands.
  const result = await failWith(Object.assign(new Error('slow down'), { name: 'ClusterError', code: 'RATE_LIMITED' }));
  assert.equal(result.reason, 'RATE_LIMITED');
});

test('500 is UPSTREAM', async () => {
  const result = await failWith(Object.assign(new Error('internal server error'), { status: 500 }));
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'UPSTREAM');
});

test('a socket timeout is TIMEOUT', async () => {
  const result = await failWith(Object.assign(new Error('timed out after 8000ms'), { name: 'TimeoutError' }));
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'TIMEOUT');
});

test('ECONNABORTED is TIMEOUT', async () => {
  const result = await failWith(Object.assign(new Error('request aborted'), { code: 'ECONNABORTED' }));
  assert.equal(result.reason, 'TIMEOUT');
});

test('a timeout wrapped by k8s.js as an UNREACHABLE ClusterError is still TIMEOUT', async () => {
  // The real path: k8s.js catches the socket TimeoutError and rethrows it as UNREACHABLE
  // with the original hung on `cause`. The reason must survive that wrapping.
  const socket = Object.assign(new Error('timed out after 8000ms'), { name: 'TimeoutError' });
  const err = new ClusterError(UNREACHABLE, 'c1: timed out after 8000ms', { cluster: 'c1', cause: socket });
  const result = await failWith(err);
  assert.equal(result.reason, 'TIMEOUT');
});

test('a connection refusal is UPSTREAM, not TIMEOUT', async () => {
  const socket = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
  const err = new ClusterError(UNREACHABLE, 'c1: connect ECONNREFUSED 10.0.0.1:443', { cluster: 'c1', cause: socket });
  const result = await failWith(err);
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'UPSTREAM');
});

test('a bare thrown Error with nothing structured on it is UPSTREAM, never a zero', async () => {
  const result = await failWith(new Error('boom'));
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'UPSTREAM');
  assert.equal(result.detail, 'boom');
  assert.deepEqual(result.items, []);
});

test('a thrown non-Error still degrades rather than escaping', async () => {
  const result = await failWith('something went sideways');
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'UPSTREAM');
});

// --- success ------------------------------------------------------------------------------

test('a successful list passes items through untouched', async () => {
  const items = [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }];
  const listFn = resolving(items);
  const result = await safeList(listFn, CTX, PATH, LABEL);

  assert.equal(result.items, items, 'the array is handed through by reference, not copied or reshaped');
  assert.deepEqual(result, { label: LABEL, items, unavailable: false, reason: null, detail: null, truncated: false });
  assert.deepEqual(listFn.calls, [{ ...CTX, path: PATH }], 'ctx is spread and path is added');
});

test('an empty successful list is a zero, and is not marked unavailable', async () => {
  const result = await safeList(resolving([]), CTX, PATH, LABEL);
  assert.deepEqual(result, { label: LABEL, items: [], unavailable: false, reason: null, detail: null, truncated: false });
});

test('the label defaults to the path when none is given', async () => {
  const result = await safeList(resolving([]), CTX, PATH);
  assert.equal(result.label, PATH);
});

// --- unavailableLabels ----------------------------------------------------------------------

test('unavailableLabels returns only the labels that failed', async () => {
  const results = await Promise.all([
    safeList(resolving([{}]), CTX, '/api/v1/pods', 'pods'),
    failWith(Object.assign(new Error('forbidden'), { status: 403 })),
    safeList(throwing(Object.assign(new Error('nope'), { status: 500 })), CTX, '/apis/istio', 'virtualservices'),
    safeList(throwing(Object.assign(new Error('gone'), { status: 404 })), CTX, '/apis/kyma', 'apirules')
  ]);
  assert.deepEqual(unavailableLabels(results), [LABEL, 'virtualservices']);
});

test('unavailableLabels returns [] when everything succeeded or returned an honest zero', async () => {
  const results = await Promise.all([
    safeList(resolving([{}]), CTX, '/api/v1/pods', 'pods'),
    safeList(resolving([]), CTX, '/api/v1/services', 'services'),
    safeList(throwing(Object.assign(new Error('gone'), { status: 404 })), CTX, '/apis/kyma', 'apirules')
  ]);
  assert.deepEqual(unavailableLabels(results), []);
});

test('unavailableLabels tolerates junk instead of throwing at render time', () => {
  assert.deepEqual(unavailableLabels(undefined), []);
  assert.deepEqual(unavailableLabels([]), []);
  assert.deepEqual(unavailableLabels([null, { unavailable: true, label: 'x' }, { unavailable: true }]), ['x']);
});

// --- truncation: read, but short -------------------------------------------------------------

/**
 * The other way a count can lie. `k8s.list` stops at its 20000-item / 200-page ceiling and
 * marks the array non-enumerably; before this, nothing read the mark, so the array was just
 * short. The distinction being asserted throughout is that truncated is NOT unavailable:
 * the items are real and the count is a floor, so it must never displace a number with an
 * em-dash, and it must never appear in `unavailable`.
 */

test('a truncated list is reported as truncated, and still returns its items', async () => {
  const items = truncatedArray([{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }]);
  const result = await safeList(resolving(items), CTX, PATH, LABEL);

  assert.equal(result.truncated, true);
  assert.equal(result.items, items, 'the items are real and are handed through, not dropped');
  assert.equal(result.items.length, 2);
  assert.equal(result.unavailable, false, 'a short read is not a failed read');
  assert.equal(result.reason, null);
  assert.equal(result.detail, null);
});

test('a truncated read never appears in unavailableLabels', async () => {
  const results = await Promise.all([
    safeList(resolving(truncatedArray([{}, {}])), CTX, '/api/v1/pods', 'pods'),
    safeList(throwing(Object.assign(new Error('forbidden'), { status: 403 })), CTX, PATH, LABEL)
  ]);
  assert.deepEqual(unavailableLabels(results), [LABEL], 'only the refused read is unavailable');
  assert.deepEqual(truncatedLabels(results), ['pods']);
});

test('an untruncated read is truncated: false everywhere it can arise', async () => {
  const ok = await safeList(resolving([{}]), CTX, PATH, LABEL);
  const empty = await safeList(resolving([]), CTX, PATH, LABEL);
  const zero = await failWith(Object.assign(new Error('gone'), { status: 404 }));
  const failed = await failWith(Object.assign(new Error('forbidden'), { status: 403 }));
  const junk = await safeList(async () => null, CTX, PATH, LABEL);

  for (const result of [ok, empty, zero, failed, junk]) {
    assert.equal(result.truncated, false);
  }
  assert.deepEqual(truncatedLabels([ok, empty, zero, failed, junk]), []);
});

test('the truncated mark survives safeList because the array is never copied', async () => {
  // k8s.js defines the flag non-enumerably so JSON.stringify and spread stay unaffected;
  // the price is that any reshaping of the array silently loses it.
  const items = truncatedArray([{}]);
  const result = await safeList(resolving(items), CTX, PATH, LABEL);

  assert.equal(Object.keys(result.items).includes('truncated'), false, 'still non-enumerable');
  assert.equal(JSON.parse(JSON.stringify(result.items)).truncated, undefined);
  assert.equal(result.items.truncated, true, 'a caller that asks by name still gets it');
});

test('truncatedLabels returns only the labels that hit the ceiling', () => {
  assert.deepEqual(truncatedLabels(undefined), []);
  assert.deepEqual(truncatedLabels([]), []);
  assert.deepEqual(
    truncatedLabels([null, { truncated: true, label: 'pods' }, { truncated: true }, { truncated: false, label: 'nodes' }]),
    ['pods']
  );
});

test('isTruncated reads the flag off a raw array, for reads left outside safeList', () => {
  assert.equal(isTruncated(truncatedArray([{}])), true);
  assert.equal(isTruncated([{}]), false);
  assert.equal(isTruncated([]), false);
  assert.equal(isTruncated(null), false);
  assert.equal(isTruncated(undefined), false);
  assert.equal(isTruncated({ truncated: true }), false, 'a non-array is not a list');
  assert.equal(isTruncated(Object.assign([{}], { truncated: 'yes' })), false, 'only the boolean counts');
});

// --- detail is operator-facing, and safe -----------------------------------------------------

test('detail never contains a token when the thrown error message embeds one', async () => {
  const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJmbGVldC1yZWFkZXIifQ.c2lnbmF0dXJlLXZhbHVl';
  const result = await failWith(new Error(`list failed with Authorization: Bearer ${jwt}`));

  assert.equal(result.unavailable, true);
  assert.ok(!result.detail.includes(jwt), `token leaked into detail: ${result.detail}`);
  assert.ok(!result.detail.includes('eyJ'), `a JWT fragment leaked into detail: ${result.detail}`);
  assert.ok(result.detail.includes('[redacted]'));
});

test('detail redacts a token query parameter and URL credentials', async () => {
  const result = await failWith(new Error('GET https://admin:hunter2@api.example.invalid/api/v1/pods?token=s3cr3t-value failed'));
  assert.ok(!result.detail.includes('hunter2'), result.detail);
  assert.ok(!result.detail.includes('s3cr3t-value'), result.detail);
  assert.ok(result.detail.includes('api.example.invalid'), 'the host is useful and stays');
});

test('detail is a single short line, never a stack trace', async () => {
  const err = new Error('upstream exploded');
  err.stack = 'Error: upstream exploded\n    at listFn (/srv/fleet/k8s.js:120:11)\n    at async collect (/srv/fleet/collectors/x.js:9:3)';
  err.status = 502;
  const result = await failWith(err);

  assert.equal(result.reason, 'UPSTREAM');
  assert.ok(!result.detail.includes('\n'));
  assert.ok(!result.detail.includes('at listFn'));
  assert.ok(result.detail.length <= 240);
});

test('an overlong API server message is truncated rather than dumped into the UI', async () => {
  const result = await failWith(Object.assign(new Error('x'.repeat(4000)), { status: 500 }));
  assert.ok(result.detail.length <= 240, `detail was ${result.detail.length} chars`);
});

test('the Status body message is preferred over a generic wrapper message', async () => {
  const err = Object.assign(new Error('HTTP request failed'), {
    statusCode: 403,
    body: { kind: 'Status', code: 403, reason: 'Forbidden', message: 'pods is forbidden: cannot list resource "pods"' }
  });
  const result = await failWith(err);
  assert.equal(result.reason, 'FORBIDDEN');
  assert.equal(result.detail, 'pods is forbidden: cannot list resource "pods"');
});

// --- the guarantee the collectors rely on ------------------------------------------------------

test('safeList never rejects, whatever the listFn does', async () => {
  const listFns = [
    throwing(new Error('boom')),
    throwing(Object.assign(new Error('forbidden'), { status: 403 })),
    () => Promise.reject(new Error('rejected')),
    () => { throw new TypeError('listFn is not a function'); },
    undefined
  ];
  for (const listFn of listFns) {
    const result = await safeList(listFn, CTX, PATH, LABEL);
    assert.equal(result.unavailable, true, `expected unavailable for ${String(listFn)}`);
    assert.deepEqual(result.items, []);
    assert.equal(typeof result.detail, 'string');
  }
});

test('a listFn that resolves with a non-array yields an empty list rather than poisoning callers', async () => {
  const result = await safeList(async () => null, CTX, PATH, LABEL);
  assert.deepEqual(result.items, []);
  assert.equal(result.unavailable, false);
});
