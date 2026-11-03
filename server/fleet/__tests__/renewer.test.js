/**
 * The in-process renewal clock.
 *
 * The renewal logic itself is tested in renew.test.js. This suite is about the schedule,
 * and specifically about the three ways a timer-based renewer goes wrong:
 *
 *   - it sleeps for the renewal window, so a pod restart at the wrong moment loses a
 *     token that was about to be renewed;
 *   - a slow cluster lets the next tick overlap the current sweep, minting twice;
 *   - a sweep throws inside a timer callback, which in Node is an unhandled rejection and
 *     therefore a dead pod.
 *
 * All three are asserted here with an injected clock, because the alternative is a test
 * that waits thirty minutes.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import _renewer from '../renewer.js';
const { Renewer, DEFAULT_INTERVAL_MS } = _renewer;

/** A hand-cranked timer. `fire()` runs whatever is currently scheduled. */
function fakeTimers() {
  let pending = null;
  let seq = 0;
  return {
    delays: [],
    setTimer(fn, delay) {
      this.delays.push(delay);
      pending = fn;
      return { id: ++seq, unref() { this.unrefd = true; return this; } };
    },
    clearTimer() { pending = null; },
    get armed() { return pending !== null; },
    async fire() {
      const fn = pending;
      pending = null;
      if (!fn) throw new Error('nothing was scheduled');
      await fn();
    }
  };
}

const QUIET = { log() {}, warn() {}, error() {} };

function harness({ cycleFn, intervalMs = 1000, startupDelayMs = 10 } = {}) {
  const timers = fakeTimers();
  const calls = [];
  const renewer = new Renewer({
    registry: { active: () => [] },
    writer: { readAll: async () => ({}), patchAll: async () => ({}) },
    intervalMs,
    startupDelayMs,
    now: () => Date.parse('2026-09-01T10:00:00Z'),
    cycleFn: cycleFn || (async args => {
      calls.push(args);
      return { total: 1, healthy: 1, renewed: 1, broken: [], report: [] };
    }),
    setTimer: (fn, d) => timers.setTimer(fn, d),
    clearTimer: () => timers.clearTimer(),
    logger: QUIET
  });
  return { renewer, timers, calls };
}

// ------------------------------------------------------------------ scheduling

test('the check interval is far shorter than the renewal window, so a restart cannot lose a token', () => {
  // The window is 12h. If the clock also ticked every 12h, a pod restarted at hour 11
  // would not look again until hour 23 — an hour after the token died.
  assert.ok(DEFAULT_INTERVAL_MS < 12 * 60 * 60 * 1000 / 4,
    `expected the sweep interval to be well under a quarter of the renewal window, got ${DEFAULT_INTERVAL_MS}ms`);
});

test('a sweep runs shortly after start, not one full interval later', async () => {
  const { renewer, timers, calls } = harness({ startupDelayMs: 10, intervalMs: 1000 });
  renewer.start();
  assert.deepEqual(timers.delays, [10]);
  await timers.fire();
  assert.equal(calls.length, 1);
});

test('the timer re-arms itself at the interval after each sweep', async () => {
  const { renewer, timers } = harness({ startupDelayMs: 10, intervalMs: 1000 });
  renewer.start();
  await timers.fire();
  assert.deepEqual(timers.delays, [10, 1000]);
  await timers.fire();
  assert.deepEqual(timers.delays, [10, 1000, 1000]);
});

test('the timer is unref\'d, so a pending sweep never holds the process open', () => {
  const unrefd = [];
  const renewer = new Renewer({
    registry: { active: () => [] },
    writer: {},
    startupDelayMs: 10,
    setTimer: () => ({ unref() { unrefd.push(true); return this; } }),
    logger: QUIET
  });
  renewer.start();
  assert.deepEqual(unrefd, [true]);
});

test('stop cancels the pending sweep and nothing re-arms', async () => {
  const { renewer, timers } = harness();
  renewer.start();
  renewer.stop();
  assert.equal(timers.armed, false);
  await renewer.runOnce();
  assert.equal(timers.armed, false, 'a manual sweep after stop must not restart the clock');
});

// -------------------------------------------------------------------- overlap

test('a second tick during a slow sweep is skipped rather than run concurrently', async () => {
  let release;
  let started = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { renewer } = harness({
    cycleFn: async () => {
      started += 1;
      await gate;
      return { total: 1, healthy: 1, renewed: 1, broken: [], report: [] };
    }
  });

  const first = renewer.runOnce();
  const second = await renewer.runOnce(); // must return immediately, without a second sweep
  assert.equal(started, 1, 'two concurrent sweeps could mint twice and write twice');
  assert.ok(second, 'the skipped call still answers with the last known state');
  release();
  await first;
});

test('after a slow sweep finishes, the next one is allowed to run', async () => {
  let started = 0;
  const { renewer } = harness({
    cycleFn: async () => {
      started += 1;
      return { total: 1, healthy: 1, renewed: 1, broken: [], report: [] };
    }
  });
  await renewer.runOnce();
  await renewer.runOnce();
  assert.equal(started, 2);
});

// --------------------------------------------------------------------- outcome

test('the last outcome is recorded, because the UI shows whether the clock is ticking', async () => {
  const { renewer } = harness({
    cycleFn: async () => ({ total: 3, healthy: 2, renewed: 1, broken: [{ cluster: 'x', summary: 'expired' }], report: [] })
  });
  await renewer.runOnce();
  assert.equal(renewer.last.total, 3);
  assert.equal(renewer.last.healthy, 2);
  assert.equal(renewer.last.renewed, 1);
  assert.equal(renewer.last.at, '2026-09-01T10:00:00.000Z');
  assert.equal(renewer.last.error, null);
});

test('a sweep that throws is recorded, not propagated — a rejection in a timer kills the pod', async () => {
  const { renewer, timers } = harness({
    cycleFn: async () => { throw new Error('secret is not patchable'); }
  });
  renewer.start();
  await assert.doesNotReject(() => timers.fire());
  assert.match(renewer.last.error, /not patchable/);
  assert.equal(renewer.last.healthy, null, 'a failed sweep must not report a health figure it never measured');
});

test('a failed sweep still re-arms the clock, so a transient failure recovers on its own', async () => {
  const { renewer, timers } = harness({
    cycleFn: async () => { throw new Error('boom'); }
  });
  renewer.start();
  await timers.fire();
  assert.equal(timers.armed, true);
});

test('broken clusters are logged as ACTION REQUIRED, which is what an operator greps for', async () => {
  const lines = [];
  const timers = fakeTimers();
  const renewer = new Renewer({
    registry: { active: () => [] },
    writer: {},
    startupDelayMs: 1,
    cycleFn: async () => ({
      total: 2, healthy: 1, renewed: 0,
      broken: [{ cluster: 'demo-dev', summary: 'EXPIRED at 2026-08-31T00:00:00Z — re-seed by hand' }],
      report: []
    }),
    setTimer: (fn, d) => timers.setTimer(fn, d),
    clearTimer: () => timers.clearTimer(),
    logger: { log() {}, warn() {}, error: msg => lines.push(msg) }
  });
  await renewer.runOnce();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ACTION REQUIRED demo-dev/);
  assert.match(lines[0], /re-seed by hand/);
});

test('the sweep is handed the registry and writer it was built with', async () => {
  const registry = { active: () => [] };
  const writer = { readAll: async () => ({}), patchAll: async () => ({}) };
  let seen = null;
  const renewer = new Renewer({
    registry, writer, startupDelayMs: 1,
    cycleFn: async args => {
      seen = args;
      return { total: 0, healthy: 0, renewed: 0, broken: [], report: [] };
    },
    setTimer: () => ({ unref() { return this; } }),
    logger: QUIET
  });
  await renewer.runOnce();
  assert.equal(seen.registry, registry);
  assert.equal(seen.writer, writer);
});

// ------------------------------------------------ the clock survives a hostile rejection

/**
 * The existing "a throwing sweep does not kill the clock" case rejects with an Error, which
 * `runOnce`'s own catch handles. These two cover the rejection shapes that catch could not
 * handle before: reading `.message` off them threw from inside the handler, so the rejection
 * escaped `runOnce`, escaped `_tick`, and left the timer un-armed for the life of the pod.
 *
 * That failure is invisible in exactly the wrong way. Nothing logs a failed sweep, because
 * the sweep never completed enough to log one; the fleet simply stops renewing, and ~24h
 * later every stored token expires at once. It reads as the clusters going down.
 */
for (const [shape, thrown] of [['null', null], ['a bare string', 'boom']]) {
  test(`a sweep rejecting with ${shape} still re-arms the clock and records the failure`, async () => {
    const { renewer, timers } = harness({
      startupDelayMs: 10,
      intervalMs: 1000,
      cycleFn: async () => { throw thrown; }
    });
    renewer.start();

    await assert.doesNotReject(() => timers.fire(),
      'the rejection must be contained by runOnce, not escape through the timer callback');

    assert.ok(timers.armed, 'the next sweep must be scheduled even after a hostile rejection');
    assert.equal(timers.delays.at(-1), 1000, 'it re-arms at the normal interval');
    assert.ok(renewer.last.error, 'the failure is recorded rather than swallowed');
    assert.equal(renewer.last.renewed, 0);

    // And the renewer is not wedged: the guard that prevents overlapping sweeps must have
    // been released, or every subsequent tick would skip with "previous sweep still running".
    await assert.doesNotReject(() => timers.fire());
    assert.ok(timers.armed);
  });
}
