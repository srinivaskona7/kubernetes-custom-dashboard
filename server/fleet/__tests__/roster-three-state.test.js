
/**
 * `ok` is three-state on the roster routes, and `null` is not a failure.
 *
 * The defect these tests close, found by adding a second cluster to a running console:
 * `GET /clusters` merged any registered cluster the fan-out had not covered back into the
 * response as a hardcoded `ok: false`. The rail renders that as a red
 * "Unreachable — the fleet could not read this cluster", `summary.unreachable` counted it, and
 * the fleet Overview showed it as "Down". Every one of those is the console asserting a failure
 * about a cluster nothing had contacted — the same class of mistake as reporting a forbidden read
 * as a zero, pointed the other way.
 *
 * Two populations reach that merge and they are different answers:
 *
 *   enabled: false   a deliberate configuration. `ok: false` is correct; the fleet really is not
 *                    reading it. `notRead: 'disabled'` says why.
 *   anything else    onboarded a moment ago, before this fan-out took its snapshot of the
 *                    registry. `ok: null`, `notRead: 'pending'`, and not counted as unreachable.
 *
 * The tests assert on the wire shape, because the wire shape is what three separate screens
 * branch on.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import _router_harness from './helpers/router-harness.js';
const { withRouter } = _router_harness;
import fixtures from './dev-fixtures.js';

/**
 * Drop a cluster record straight into the Registry's watched directory, bypassing onboarding.
 *
 * This is exactly the state the defect lives in — present in the registry, absent from the
 * fan-out — and writing the file directly is the only way to hold it still. Going through
 * `POST /clusters` would race the very cache invalidation that usually closes the window.
 */
function seedUncovered(registry, record) {
  fs.writeFileSync(path.join(registry.dir, record.id), JSON.stringify(record));
  registry.invalidate();
}

const rosterOf = body => Object.fromEntries(body.clusters.map(c => [c.cluster.id, c]));

/**
 * A cache that never expires, so a fan-out result can be pinned to a moment in time.
 *
 * This is the production path, not a contrivance: `GET /clusters` serves the fan-out from
 * `cache.wrap(scoped(req, 'clusters'), …)` while it reads the placeholder list from
 * `registry.all()` live. A cluster onboarded between the two is in the registry and not in the
 * cached fan-out, which is the exact window the defect lived in. Freezing the cache holds that
 * window open instead of racing it.
 */
function frozenCache() {
  const entries = new Map();
  return {
    entries,
    async wrap(key, fn) {
      if (!entries.has(key)) entries.set(key, await fn());
      return entries.get(key);
    },
    invalidate(prefix) {
      for (const key of [...entries.keys()]) if (!prefix || key.startsWith(prefix)) entries.delete(key);
    }
  };
}

test('a registered cluster the cached fan-out has not covered is `ok: null`, not a failure', async () => {
  const cache = frozenCache();
  await withRouter({ callFn: fixtures.callFn, cache }, async ({ get, registry }) => {
    // Warm the fan-out over the two fixture clusters, then add a third behind it.
    await get('/clusters');

    seedUncovered(registry, {
      id: 'just-added',
      displayName: 'Just Added',
      env: 'sbx',
      // Deliberately unreachable: it must not matter. Nothing contacts it, because the cached
      // fan-out predates it — which is the whole point.
      apiUrl: 'https://api.not-contacted.invalid',
      enabled: true
    });

    const res = await get('/clusters');
    assert.equal(res.status, 200);
    const roster = rosterOf(res.body);

    const slot = roster['just-added'];
    assert.ok(slot, 'the cluster must still appear in the roster — dropping it is the other bug');
    assert.equal(slot.ok, null, 'not read yet is null, never false');
    assert.equal(slot.notRead, 'pending');
    assert.equal(slot.registered, false);
    assert.equal(res.body.summary.unreachable, 0, 'and nothing may call it unreachable');
    assert.equal(res.body.summary.clusters, 3, 'but the fleet is three clusters, not two');
  });
});

test('an unread cluster is not counted under summary.unreachable', async () => {
  await withRouter({ callFn: fixtures.callFn }, async ({ get, registry }) => {
    const before = (await get('/clusters')).body.summary.unreachable;

    seedUncovered(registry, {
      id: 'just-added',
      displayName: 'Just Added',
      env: 'sbx',
      apiUrl: 'https://api.not-contacted.invalid',
      enabled: true
    });

    const body = (await get('/clusters')).body;
    assert.equal(
      body.summary.unreachable,
      before,
      'adding a cluster nobody has read must not move the unreachable count'
    );
    // It is still in the fleet, and the fleet size must say so — the count used to be
    // `results.length`, which silently omitted every merged-back cluster.
    assert.equal(body.summary.clusters, body.clusters.length);
  });
});

test('a disabled cluster is `ok: false` with `notRead: disabled` — a real answer, not a pending one',
  async () => {
    await withRouter({ callFn: fixtures.callFn }, async ({ get, registry }) => {
      seedUncovered(registry, {
        id: 'switched-off',
        displayName: 'Switched Off',
        env: 'sbx',
        apiUrl: 'https://api.switched-off.invalid',
        enabled: false
      });

      const body = (await get('/clusters')).body;
      const slot = rosterOf(body)['switched-off'];
      assert.ok(slot);
      assert.equal(slot.ok, false, 'a cluster the fleet is configured not to read is a definite no');
      assert.equal(slot.notRead, 'disabled');
      assert.ok(body.summary.unreachable >= 1, 'and it does count, because it is a real state');
    });
  });

test('GET /clusters/:id answers the same three-state shape for an uncovered cluster', async () => {
  await withRouter({ callFn: fixtures.callFn }, async ({ get, registry }) => {
    seedUncovered(registry, {
      id: 'just-added',
      displayName: 'Just Added',
      env: 'sbx',
      apiUrl: 'https://api.not-contacted.invalid',
      // Disabled, so the fan-out genuinely skips it on a direct request too. An enabled cluster
      // would simply be read here, which is the happy path and not what this pins.
      enabled: false
    });

    const res = await get('/clusters/just-added');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.notRead, 'disabled');
    assert.equal(res.body.cluster.id, 'just-added');
  });
});

test('a cluster that was actually read is still plain `true`', async () => {
  await withRouter({ callFn: fixtures.callFn }, async ({ get }) => {
    const roster = rosterOf((await get('/clusters')).body);
    // The harness's own fixture clusters go through the fan-out, so they are the control: the
    // three-state change must not have turned a successful read into anything else.
    assert.equal(roster.platformsbx.ok, true);
    assert.equal(roster.platformsbx.notRead, undefined);
  });
});
