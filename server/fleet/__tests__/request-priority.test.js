
/**
 * The `x-fleet-priority` request hint.
 *
 * The browser warms tabs the operator has not clicked yet (app/fleet-ui/src/prefetch.ts), and
 * speculative work that competes with the tab in front of them is worse than no warming at
 * all — it fills the same eight-slot per-cluster gate the visible page is waiting on. The hint
 * is how the browser says "I am guessing, put me last".
 *
 * Two properties, and the second is the one that matters:
 *
 *  1. `low` reaches `withLowPriority`, or the whole warming design is inert. Nothing on screen
 *     would report this — the prefetch still works, it just stops being polite.
 *  2. Nothing **promotes**. This header arrives from the browser, is never authenticated and
 *     is never validated against the caller's identity, so if any value could ask for *more*
 *     than the default it would be a one-curl way past the gate that protects every other
 *     tenant of the cluster from one greedy page.
 *
 * Priority is ambient (`AsyncLocalStorage`), so it cannot be asserted from a response body.
 * The router is mounted for real and `withLowPriority` is observed at the seam instead.
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

/**
 * Mount the router with `k8s.withLowPriority` replaced by a recorder.
 *
 * router.js destructures it at import time, so the substitution has to be in place before the
 * module is first loaded - hence `resetModules` plus a mock of '../k8s.js', and a fresh import
 * of the harness (which imports the router) afterwards. Without the reset the harness stays
 * cached holding a reference to the *first* test's patched router, and every later test then
 * reads a recorder nothing writes to. That failure is silently one-directional (`demoted` is
 * always 0), so the two assertions that expect 0 would pass against a mutant that demoted every
 * request in the process. Caught by canarying, not by the suite being green.
 */
async function withRecordedPriority(fn) {
  const demoted = [];
  vi.resetModules();
  vi.doMock('../k8s.js', async () => {
    const real = (await vi.importActual('../k8s.js')).default;
    return { default: { ...real, withLowPriority: cb => { demoted.push(true); return real.withLowPriority(cb); } } };
  });
  try {
    const { default: harness } = await import('./helpers/router-harness.js');
    return await fn(demoted, harness);
  } finally {
    vi.doUnmock('../k8s.js');
    vi.resetModules();
  }
}

const HEADER = 'x-fleet-priority';

async function requestWith(headers) {
  return withRecordedPriority(async (demoted, { withRouter }) => {
    let status = 0;
    await withRouter(async ({ get }) => {
      ({ status } = await get('/clusters/platformsbx/overview', { headers }));
    });
    return { status, demoted: demoted.length };
  });
}

test('`x-fleet-priority: low` demotes the read behind the interactive tier', async () => {
  const { status, demoted } = await requestWith({ [HEADER]: 'low' });
  assert.equal(status, 200, 'the hint must not change the answer, only its place in the queue');
  assert.equal(demoted, 1, 'the handler must run inside withLowPriority');
});

test('a request with no hint runs at the normal priority', async () => {
  const { status, demoted } = await requestWith({});
  assert.equal(status, 200);
  assert.equal(demoted, 0);
});

test('no header value can promote a request above the default', async () => {
  // The security half. `low` is the one value that does anything and the only thing it can do
  // is make the sender wait longer, so an unauthenticated header cannot be used to jump the
  // per-cluster gate. Anything that is not `low` must land on the default tier — never on a
  // faster one, and never rejected either, since a proxy is free to add headers.
  for (const value of ['high', 'HIGH', 'urgent', 'Low', '0', '']) {
    const { status, demoted } = await requestWith({ [HEADER]: value });
    assert.equal(status, 200, `${JSON.stringify(value)} must still be served`);
    assert.equal(demoted, 0, `${JSON.stringify(value)} must not be treated as a priority instruction`);
  }
});

test('surrounding whitespace is the same value, because HTTP already stripped it', async () => {
  // `'low '` is not a near-miss to be rejected: RFC 9110 optional whitespace is removed by the
  // HTTP parser, so Express is handed `low` and the request is genuinely the same one. Written
  // down because the first version of the test above listed `'low '` among the values that
  // must NOT demote, and it failed for this reason rather than for a bug in the router —
  // exactly the kind of wrong expectation a canary run surfaces and a green suite hides.
  const { status, demoted } = await requestWith({ [HEADER]: 'low ' });
  assert.equal(status, 200);
  assert.equal(demoted, 1);
});
