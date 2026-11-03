import { test } from 'vitest';
import assert from 'node:assert';

import _renew from '../renew.js';
const { renewCycle, renewOne, RENEW_BELOW_MS, humanise } = _renew;
import _errors2 from '../errors.js';
const { ClusterError, UNAUTHENTICATED } = _errors2;

const T0 = Date.parse('2026-08-31T12:00:00Z');
const inHours = h => new Date(T0 + h * 3600_000).toISOString();
const cluster = {
  id: 'platformsbx', namespace: 'fleet-dashboard',
  serviceAccount: 'fleet-reader', apiUrl: 'https://api.example'
};

test('a token with 18h left is left alone', async () => {
  const out = await renewOne({
    cluster, now: T0,
    record: { token: 'eyJ-a', expiresAt: inHours(18), renewedAt: inHours(-6) }
  });
  assert.strictEqual(out.healthy, true);
  assert.strictEqual(out.patch, null, 'no write when nothing changed');
  assert.match(out.summary, /still valid/);
});

test('a token inside the half-life window is renewed', async () => {
  const out = await renewOne({
    cluster, now: T0,
    mintFn: async () => ({ token: 'eyJ-new', expiresAt: inHours(24) }),
    record: { token: 'eyJ-old', expiresAt: inHours(6), renewedAt: inHours(-18) }
  });
  assert.strictEqual(out.healthy, true);
  assert.strictEqual(out.patch.token, 'eyJ-new');
  assert.strictEqual(out.patch.expiresAt, inHours(24));
  assert.strictEqual(out.patch.lastError, null, 'a successful renewal clears the previous error');
});

test('the current token is what authenticates the renewal', async () => {
  let seen = null;
  await renewOne({
    cluster, now: T0,
    mintFn: async ({ currentToken }) => { seen = currentToken; return { token: 'eyJ-new', expiresAt: inHours(24) }; },
    record: { token: 'eyJ-old', expiresAt: inHours(6), renewedAt: inHours(-18) }
  });
  assert.strictEqual(seen, 'eyJ-old', 'the chain works by the old token minting the new one');
});

test('a failed renewal keeps the old token when it still has time left', async () => {
  const out = await renewOne({
    cluster, now: T0,
    mintFn: async () => { throw new ClusterError(UNAUTHENTICATED, '401 Unauthorized', { cluster: 'platformsbx' }); },
    record: { token: 'eyJ-old', expiresAt: inHours(8), renewedAt: inHours(-16) }
  });
  // This is the property the whole half-life design rests on: one cycle may fail.
  assert.strictEqual(out.healthy, true, 'still healthy — 8h of runway remain');
  assert.strictEqual(out.patch.token, 'eyJ-old', 'the working token must not be discarded');
  assert.match(out.patch.lastError, /UNAUTHENTICATED/);
  assert.match(out.summary, /will retry next cycle/);
});

test('a failed renewal on an already-lapsed token is reported as unhealthy', async () => {
  const out = await renewOne({
    cluster, now: T0,
    mintFn: async () => { throw new ClusterError(UNAUTHENTICATED, '401 Unauthorized'); },
    // expiresAt is in the past, so the short-circuit fires before mintFn is reached
    record: { token: 'eyJ-old', expiresAt: inHours(-1), renewedAt: inHours(-25) }
  });
  assert.strictEqual(out.healthy, false);
});

test('an expired token is not even attempted — minting needs a valid one', async () => {
  let called = false;
  const out = await renewOne({
    cluster, now: T0,
    mintFn: async () => { called = true; return { token: 'x', expiresAt: inHours(24) }; },
    record: { token: 'eyJ-dead', expiresAt: inHours(-2), renewedAt: inHours(-26) }
  });
  assert.strictEqual(called, false, 'no doomed network call');
  assert.strictEqual(out.healthy, false);
  assert.match(out.summary, /chain broken, re-seed by hand/);
});

test('an unseeded cluster reports the exact command that fixes it', async () => {
  const out = await renewOne({ cluster, now: T0, record: null });
  assert.strictEqual(out.healthy, false);
  assert.strictEqual(out.patch, null);
  assert.match(out.summary, /kubectl create token fleet-reader -n fleet-dashboard --duration=24h/);
});

test('a cluster granting less than the renewal interval is flagged loudly', async () => {
  // Cannot happen on Gardener, whose maxTokenExpiration floor is 30d — but if the app is
  // ever pointed at a cluster that caps low, a silent 12h gap would be the worst outcome.
  const out = await renewOne({
    cluster, now: T0,
    mintFn: async () => ({ token: 'eyJ-short', expiresAt: inHours(1) }),
    record: { token: 'eyJ-old', expiresAt: inHours(6), renewedAt: inHours(-18) }
  });
  assert.match(out.summary, /WARNING: granted only/);
});

test('the renewal threshold is half of a 24h lifetime', () => {
  assert.strictEqual(RENEW_BELOW_MS, 12 * 3600_000);
});

test('humanise renders durations the way an operator reads them', () => {
  assert.strictEqual(humanise(18 * 3600_000 + 42 * 60_000), '18h 42m');
  assert.strictEqual(humanise(45 * 60_000), '45m');
});

// ------------------------------------------------------------------ renewCycle
//
// The sweep across the whole fleet. What matters is that one cluster's failure is
// contained: it must not stop the others, and it must not blank their tokens. The single
// merge patch at the end is what guarantees the second half of that.

const QUIET = { log() {} };

function fleet(ids) {
  return { active: () => ids.map(id => ({ ...cluster, id })) };
}

function recordingWriter(stored = {}) {
  const writes = [];
  return {
    writes,
    readAll: async () => stored,
    patchAll: async patches => { writes.push(patches); return {}; }
  };
}

test('every active cluster is swept, and the whole fleet is written in one patch', async () => {
  const writer = recordingWriter({
    a: { token: 't-a', expiresAt: inHours(1) },
    b: { token: 't-b', expiresAt: inHours(1) }
  });
  const result = await renewCycle({
    registry: fleet(['a', 'b']), writer, now: T0, logger: QUIET,
    renewFn: async ({ cluster: c }) => ({
      cluster: c.id, healthy: true, renewed: true,
      patch: { token: `new-${c.id}`, expiresAt: inHours(24), renewedAt: inHours(0), lastError: null },
      summary: 'renewed'
    })
  });

  assert.equal(result.total, 2);
  assert.equal(result.healthy, 2);
  assert.equal(result.renewed, 2);
  assert.equal(writer.writes.length, 1, 'one write for the fleet, not one per cluster');
  assert.deepEqual(Object.keys(writer.writes[0]).sort(), ['a', 'b']);
});

test('a cluster that needs nothing contributes no write', async () => {
  const writer = recordingWriter({ a: { token: 't-a', expiresAt: inHours(18) } });
  const result = await renewCycle({
    registry: fleet(['a']), writer, now: T0, logger: QUIET,
    renewFn: async () => ({ cluster: 'a', healthy: true, patch: null, summary: 'still valid' })
  });
  assert.equal(writer.writes.length, 0, 'nothing to write means no API call at all');
  assert.equal(result.renewed, 0);
});

test('one failing cluster neither stops the others nor appears as renewed', async () => {
  const writer = recordingWriter({});
  const result = await renewCycle({
    registry: fleet(['good', 'bad']), writer, now: T0, logger: QUIET,
    renewFn: async ({ cluster: c }) => c.id === 'bad'
      ? { cluster: 'bad', healthy: false, renewed: false, patch: { token: 'old', expiresAt: inHours(-1), lastError: 'EXPIRED' }, summary: 'EXPIRED — re-seed by hand' }
      : { cluster: 'good', healthy: true, renewed: true, patch: { token: 'new', expiresAt: inHours(24), renewedAt: inHours(0) }, summary: 'renewed' }
  });

  assert.equal(result.total, 2);
  assert.equal(result.healthy, 1);
  assert.equal(result.renewed, 1, 'the failed cluster records an error but was not renewed');
  assert.deepEqual(result.broken.map(b => b.cluster), ['bad']);
  // Both keys are in the one patch, and the failure's key carries its previous token.
  assert.equal(writer.writes[0].bad.token, 'old');
});

test('an empty fleet is a valid sweep, not an error', async () => {
  const writer = recordingWriter({});
  const result = await renewCycle({ registry: fleet([]), writer, now: T0, logger: QUIET });
  assert.equal(result.total, 0);
  assert.equal(result.healthy, 0);
  assert.equal(writer.writes.length, 0);
});

test('each cluster is handed its own stored record and nobody else\'s', async () => {
  const seen = {};
  const writer = recordingWriter({ a: { token: 't-a' }, b: { token: 't-b' } });
  await renewCycle({
    registry: fleet(['a', 'b']), writer, now: T0, logger: QUIET,
    renewFn: async ({ cluster: c, record }) => {
      seen[c.id] = record;
      return { cluster: c.id, healthy: true, renewed: false, patch: null, summary: 'ok' };
    }
  });
  assert.equal(seen.a.token, 't-a');
  assert.equal(seen.b.token, 't-b');
});

test('a renewal that failed is not counted as a renewal, even though it writes a record', async () => {
  // The count used to be inferred from the patch carrying a renewedAt. A failed renewal
  // patches the *previous* record back with an error attached, and that record has a
  // renewedAt from last time — so a sweep in which every cluster failed reported every
  // cluster as renewed. The dev server showed "2 renewed" beside two FAILED lines.
  const writer = recordingWriter({
    flaky: { token: 'old', expiresAt: inHours(3), renewedAt: inHours(-21), lastError: null }
  });
  const result = await renewCycle({
    registry: fleet(['flaky']), writer, now: T0, logger: QUIET,
    renewFn: async ({ cluster: c, record }) => (await renewOne({
      cluster: c, record, now: T0,
      mintFn: async () => { throw new Error('connect ETIMEDOUT'); }
    }))
  });

  assert.equal(result.renewed, 0, 'nothing was minted, so nothing was renewed');
  assert.equal(result.healthy, 1, 'the previous token still has three hours, so the cluster is not broken');
  assert.equal(writer.writes[0].flaky.token, 'old', 'the previous token is kept, never blanked');
  assert.match(writer.writes[0].flaky.lastError, /ETIMEDOUT/);
});
