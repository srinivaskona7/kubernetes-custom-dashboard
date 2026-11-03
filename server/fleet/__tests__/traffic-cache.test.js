
/**
 * `/traffic-errors`: cached for seconds, bypassed on demand.
 *
 * This route used to refuse to cache at all, and the reason was sound — a log tail is a moving
 * window, and an operator refreshing after a deploy must see the current one. What the refusal
 * actually cost was every *automatic* read: ten pod-log reads, 5-7s, paid again on each visit
 * to the tab including one two seconds after the last.
 *
 * The cache and the bypass are therefore one feature, and each half fails silently without the
 * other:
 *
 *  - No cache, and the tab is slow forever with nothing on screen to explain it.
 *  - No bypass, and the Refresh control — whose tooltip promises "read the current tail
 *    again" — hands back the copy it already showed. The page looks identical either way; the
 *    operator just draws a conclusion about a deploy from lines that predate it.
 *  - A key missing a parameter, and a 1000-line request is served from a 300-line read while
 *    the page reports the wide window as satisfied.
 *
 * "Did the collector run again" is counted directly rather than inferred from a duration, by
 * wrapping the injected `listFn` and counting the one read only `traffic.collect` makes. The
 * obvious counter — pod-log reads — is useless here: the fixture cluster runs no `istio-proxy`,
 * so a correct collector reads zero logs and the counter cannot tell a cache hit from a miss.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _router_harness from './helpers/router-harness.js';
const { withRouter } = _router_harness;
import fixtures from './dev-fixtures.js';

const PATH = '/clusters/platformsbx/traffic-errors';

/**
 * Wrap the fixture transport so every run of the traffic collector is counted.
 *
 * `telemetries` is the marker: `traffic.collect` reads it exactly once per run and no other
 * route under test reads it at all, so the count is the number of collections.
 */
function countingSeams() {
  const state = { collections: 0 };
  return {
    state,
    listFn: async args => {
      if (String(args.path).includes('/telemetries')) state.collections += 1;
      return fixtures.listFn(args);
    }
  };
}

test('a second automatic read is served without touching the proxies again', async () => {
  const { state, listFn } = countingSeams();
  await withRouter({ listFn }, async ({ get }) => {
    const first = await get(PATH);
    assert.equal(first.status, 200);
    const afterFirst = state.collections;
    assert.ok(afterFirst > 0, 'the first read must actually run the collector');

    const second = await get(PATH);
    assert.equal(second.status, 200);
    assert.equal(state.collections, afterFirst, 'the second read must not run the collector again');
    assert.deepEqual(second.body, first.body);
  });
});

test('`cache-control: no-cache` reads the proxies again', async () => {
  // The half that keeps the Refresh control honest. Without it the control is decorative and
  // the page cannot be distinguished from one that did refresh.
  const { state, listFn } = countingSeams();
  await withRouter({ listFn }, async ({ get }) => {
    await get(PATH);
    const afterFirst = state.collections;

    const fresh = await get(PATH, { headers: { 'cache-control': 'no-cache' } });
    assert.equal(fresh.status, 200);
    assert.ok(state.collections > afterFirst, 'a forced refresh must run the collector again');
  });
});

test('`no-store` is honoured the same way as `no-cache`', async () => {
  const { state, listFn } = countingSeams();
  await withRouter({ listFn }, async ({ get }) => {
    await get(PATH);
    const afterFirst = state.collections;
    await get(PATH, { headers: { 'cache-control': 'no-store' } });
    assert.ok(state.collections > afterFirst);
  });
});

test('a forced refresh replaces the entry rather than leaving the old one behind', async () => {
  // `cache.invalidate(key)` before the live read, not just a skip around it. Skipping alone
  // would serve the *next* automatic read from the copy the operator just refreshed past —
  // a refresh that appears to work and then silently un-does itself one render later.
  const { state, listFn } = countingSeams();
  await withRouter({ listFn }, async ({ get }) => {
    await get(PATH);
    await get(PATH, { headers: { 'cache-control': 'no-cache' } });
    const afterRefresh = state.collections;
    await get(PATH);
    assert.equal(state.collections, afterRefresh, 'the refreshed answer is what the next read gets');
  });
});

test('a different tail width is a different read, not a cache hit', async () => {
  // Leaving `tailLines` out of the key serves a 1000-line request from a 300-line read and
  // reports the wide window as satisfied — the window this whole tab exists to state honestly.
  const { state, listFn } = countingSeams();
  await withRouter({ listFn }, async ({ get }) => {
    await get(`${PATH}?tailLines=300`);
    const afterNarrow = state.collections;
    await get(`${PATH}?tailLines=1000`);
    assert.ok(state.collections > afterNarrow, 'a wider tail must be read, not inferred');
  });
});

test('a different namespace is a different read', async () => {
  const { state, listFn } = countingSeams();
  await withRouter({ listFn }, async ({ get }) => {
    await get(PATH);
    const afterAll = state.collections;
    await get(`${PATH}?namespace=istio-system`);
    assert.ok(state.collections > afterAll, 'narrowing to one namespace must re-read');
  });
});

test('one cluster\'s tail is never served for another', async () => {
  const { state, listFn } = countingSeams();
  await withRouter({ listFn }, async ({ get }) => {
    await get(PATH);
    const afterFirst = state.collections;
    const other = await get('/clusters/demo-dev/traffic-errors');
    assert.equal(other.status, 200);
    assert.ok(state.collections >= afterFirst);
    assert.notEqual(other.body.cluster.id, 'platformsbx');
  });
});
