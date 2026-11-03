/**
 * The Overview's health signals.
 *
 * The first two tests here are the ones that matter, and they exist because the bug they catch
 * shipped: `/clusters/:id/summary` reported `state: 'ok'` for all seventeen groups on a cluster
 * with two crashlooping containers, because `groupState` only ever asks "did the read succeed".
 * A test that only checked the response shape passed happily through that, so these check the
 * answer instead.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';

import _signals from '../signals.js';
const { signalsOf, healthOf, SIGNAL_GROUP_KEYS } = _signals;
import _router_harness2 from './helpers/router-harness.js';
const { withRouter } = _router_harness2;

/** One fan-out result, in the shape `runFanOut` actually returns. */
const ok = (id, data) => ({ cluster: { id }, ok: true, data });

/**
 * A payload that trips at least one rule in nearly every group, with every count at 1 so the
 * singular branch is the one exercised. `summary` is shared because the rules read disjoint keys
 * off it, which is also how the real collectors are shaped.
 */
const FAT_PAYLOAD = {
  nodes: { total: 3, ready: 2, withProblems: 1, unschedulable: 1 },
  pods: { failed: 1, pending: 1 },
  // A real ceiling: the controller's reason, not `current >= max` (see `hpaState`).
  hpas: [{
    minReplicas: 1, maxReplicas: 2, currentReplicas: 2,
    conditions: [{ type: 'ScalingActive', status: 'True' }, { type: 'ScalingLimited', status: 'True', reason: 'TooManyReplicas' }]
  }],
  instances: [{ ready: false }],
  bindings: [{ ready: false }],
  mtls: [{ mode: 'PERMISSIVE' }],
  kymas: [{ state: 'Processing', modules: [{ state: 'Error' }, { state: 'Processing' }, { state: 'Ready', currency: 'behind' }] }],
  ingressBindingIntegrity: {
    virtualServicesWithMissingGateway: [{}],
    duplicateHostExposures: [{}],
    unboundGateways: [{}]
  },
  authorizationPosture: { unenforceablePolicies: [{}] },
  sidecarCoverage: { coveragePercent: 50 },
  unboundedContainers: { noEitherLimit: 1 },
  metricsServer: { installed: true, reporting: false },
  telemetry: { logPipelines: { notReady: 1, flowUnhealthy: 1, indeterminate: 1 } },
  summary: {
    verdict: 'ok',
    crashLoops: 1, underCapacity: 1, zeroEndpointServices: 1,
    daemonSetsStuck: 1, driftedDeployments: 1, staleStatefulSets: 1,
    notReady: 1,
    apirulesNeedingMigration: 1,
    pendingPvcs: 1, defaultStorageClassState: { state: 'missing' }, quotaCoverage: 0.5,
    privilegedContainers: 1, appNamespacesAudited: 2, networkPolicyProtectedNamespaces: 1,
    withFindings: 1, withWarnings: 1,
    expired: 1, expiringSoon: 1, unready: 1,
    isMultiZone: false,
    instancesWithNoBindingInThisClusterCount: 1,
    activeOutageRiskCount: 1, pdbDrainBlockerCount: 1,
    unavailableAggregated: 1, servedVersionDrift: 1
  }
};

// The group list comes from the live route rather than from a copy of it here: a second hand-kept
// list of the seventeen keys is exactly the kind of duplicate that goes stale silently, and the
// route's own answer is the thing this gate is about.
test('every summary group has a health rule — a group without one renders a green pill backed by no check', async () => {
  await withRouter({}, async ({ get, registry }) => {
    const { body } = await get(`/clusters/${registry.active()[0].id}/summary`);
    const keys = Object.keys(body.groups || {});
    assert.ok(keys.length >= 17, `only ${keys.length} groups came back; this gate would pass vacuously`);

    const missing = keys.filter(k => !SIGNAL_GROUP_KEYS.includes(k));
    assert.deepStrictEqual(
      missing,
      [],
      'these groups reach the Overview with no health rule, so they can only ever render "Clear" — '
        + 'add them to RULES in srv/fleet/signals.js:\n  ' + missing.join('\n  ')
    );
    const orphans = SIGNAL_GROUP_KEYS.filter(k => !keys.includes(k));
    assert.deepStrictEqual(orphans, [], 'these rules name a group the server does not summarise');
  });
});

test('a crashlooping cluster does not report itself clear — the bug this module exists to remove', () => {
  const results = [ok('c1', { summary: { verdict: 'ok', crashLoops: 2, underCapacity: 0 } })];
  const signals = signalsOf('reliability', results);
  assert.deepStrictEqual(signals, [{ label: 'containers crashlooping', count: 2, tone: 'bad', clusters: ['c1'] }]);
  // `reads` is 'ok' here on purpose: every read succeeded. That is exactly the state in which the
  // old code said "Clear" and meant "I did not look at the answer".
  assert.equal(healthOf('ok', signals), 'attention');
});

test('a count of one gets the singular — an operator console that says "1 nodes not ready" reads as unfinished', () => {
  assert.deepStrictEqual(
    signalsOf('health', [ok('c1', { nodes: { total: 3, ready: 2 }, pods: {} })]),
    [{ label: 'node not ready', count: 1, tone: 'bad', clusters: ['c1'] }]
  );
  assert.deepStrictEqual(
    signalsOf('health', [ok('c1', { nodes: { total: 4, ready: 2 }, pods: {} })]),
    [{ label: 'nodes not ready', count: 2, tone: 'bad', clusters: ['c1'] }]
  );
  // The irregulars are why the singular is written out rather than derived from the plural.
  assert.deepStrictEqual(
    signalsOf('reliability', [ok('c1', { summary: { verdict: 'ok', staleStatefulSets: 1 } })]),
    [{ label: 'StatefulSet behind its spec', count: 1, tone: 'warn', clusters: ['c1'] }]
  );
});

test('agreement is decided after the merge, so 1 + 2 sums to one finding of 3 rather than splitting in two', () => {
  // The merge keys on the label. If the singular reached the map, "1 container crashlooping" and
  // "2 containers crashlooping" would be two different keys and the fleet total would never add up.
  const results = [
    ok('c1', { summary: { verdict: 'ok', crashLoops: 1 } }),
    ok('c2', { summary: { verdict: 'ok', crashLoops: 2 } })
  ];
  assert.deepStrictEqual(signalsOf('reliability', results), [
    { label: 'containers crashlooping', count: 3, tone: 'bad', clusters: ['c1', 'c2'] }
  ]);
});

test('two clusters at one each merge to a plural, because the fleet total is what is rendered', () => {
  const results = [
    ok('c1', { summary: { verdict: 'ok', crashLoops: 1 } }),
    ok('c2', { summary: { verdict: 'ok', crashLoops: 1 } })
  ];
  assert.deepStrictEqual(signalsOf('reliability', results), [
    { label: 'containers crashlooping', count: 2, tone: 'bad', clusters: ['c1', 'c2'] }
  ]);
});

test('the internal bookkeeping fields never reach the wire', async () => {
  let groupsWithFindings = 0;
  for (const key of SIGNAL_GROUP_KEYS) {
    const found = signalsOf(key, [ok('c1', FAT_PAYLOAD)]);
    if (found.length) groupsWithFindings++;
    for (const s of found) {
      for (const field of ['forms', 'merge']) {
        assert.ok(!(field in s), `${key} leaked its internal \`${field}\` to the client: ${JSON.stringify(s)}`);
      }
    }
  }
  // Without this the loop above could pass by finding nothing at all.
  assert.ok(groupsWithFindings >= 15, `only ${groupsWithFindings} groups produced a finding; this gate would pass vacuously`);

  await withRouter({}, async ({ get, registry }) => {
    for (const path of [`/clusters/${registry.active()[0].id}/summary`, '/summary']) {
      const { body } = await get(path);
      const raw = JSON.stringify(body);
      for (const field of ['forms', 'merge']) {
        assert.ok(!raw.includes(`"${field}"`), `GET ${path} leaked the \`${field}\` field`);
      }
    }
  });
});

test('a percentage does not sum across clusters — two clusters at 100% is not 200%', () => {
  // Summing rates produced "200% of namespaces have no ResourceQuota" on the fleet-wide route,
  // which is the confident-wrong-number bug in a different costume. The worst value is reported,
  // and the label says so, because the UI renders `${count}${unit} ${label}` and the bare number
  // beside two cluster names would read as true of both.
  const results = [
    ok('c1', { summary: { quotaCoverage: 0 } }),
    ok('c2', { summary: { quotaCoverage: 0.4 } })
  ];
  assert.deepStrictEqual(signalsOf('storage', results), [
    {
      label: 'of namespaces have no ResourceQuota (worst of 2 clusters)',
      count: 100, tone: 'warn', unit: '%', clusters: ['c1', 'c2']
    }
  ]);
});

test('one cluster at a rate keeps the plain label — the qualifier only earns its place when clusters disagree', () => {
  assert.deepStrictEqual(signalsOf('storage', [ok('c1', { summary: { quotaCoverage: 0.25 } })]), [
    { label: 'of namespaces have no ResourceQuota', count: 75, tone: 'warn', unit: '%', clusters: ['c1'] }
  ]);
});

test('a countless flag merges without inventing a number', () => {
  const results = [
    ok('c1', { summary: { defaultStorageClassState: { state: 'missing' } } }),
    ok('c2', { summary: { defaultStorageClassState: { state: 'missing' } } })
  ];
  assert.deepStrictEqual(signalsOf('storage', results), [
    { label: 'no default StorageClass', count: null, tone: 'warn', clusters: ['c1', 'c2'] }
  ]);
});

test('no label leaves a plural leading noun at a count of one, across every rule', () => {
  // A missing plural form, or a tuple written the wrong way round, is invisible until an operator
  // reads it — so sweep the whole catalogue rather than the handful of rules spelled out above.
  // The check is deliberately narrow: an all-lowercase leading word ending in a single `s`
  // ("nodes", "pods", "certificates"). It cannot judge "app namespace**s** with no NetworkPolicy",
  // where the noun is not the first word, but it does catch the whole class that shipped.
  for (const key of SIGNAL_GROUP_KEYS) {
    for (const s of signalsOf(key, [ok('c1', FAT_PAYLOAD)])) {
      if (s.count !== 1 || s.unit) continue;
      const first = s.label.split(' ')[0];
      assert.ok(
        !(/^[a-z]+s$/.test(first) && !/ss$/.test(first)),
        `${key} renders "1 ${s.label}" — the leading noun is still plural at a count of one`
      );
    }
  }
});

test('an unread topic is unknown, never clear — a refused read has no clean bill of health to give', () => {
  assert.equal(healthOf('error', []), 'unknown');
  // A cluster that failed contributes no findings rather than zeroes.
  assert.deepStrictEqual(signalsOf('reliability', [{ cluster: { id: 'c1' }, ok: false, error: {} }]), []);
});

test('an incomplete read with nothing wrong in what arrived is partial, not clear and not attention', () => {
  assert.equal(healthOf('degraded', []), 'partial');
});

test('a real zero produces no finding, so a clean topic stays silent', () => {
  const results = [ok('c1', { summary: { verdict: 'ok', crashLoops: 0, underCapacity: 0, zeroEndpointServices: 0 } })];
  assert.deepStrictEqual(signalsOf('reliability', results), []);
  assert.equal(healthOf('ok', []), 'clear');
});

test('a null count is unread, not zero — the collectors that use null for "the read failed" stay silent', () => {
  // `platform.js` returns null for every count when the APIService read failed; a finding of 0
  // there would be the confident-zero bug moved one layer up.
  const results = [ok('c1', { summary: { totalApiServices: null, unavailableAggregated: null, servedVersionDrift: null } })];
  assert.deepStrictEqual(signalsOf('integrity', results), []);
});

test('a no-binding count built over a refused list stays silent — every instance joins to nothing and reads as unbound', () => {
  // The shape the live rail warned on: three instances, the bindings list refused and so empty,
  // and all three counted as having no binding here.
  const joined = { instanceCount: 3, bindingCount: 0, instancesWithNoBindingInThisClusterCount: 3 };
  for (const list of ['servicebindings', 'serviceinstances']) {
    assert.deepStrictEqual(
      signalsOf('btpServices', [ok('c1', { instances: [], bindings: [], summary: { ...joined, unavailable: [list] } })]),
      [],
      `a refused ${list} read still produced a finding`
    );
  }
  // Read in full, the same count is a real finding: the gate is the refusal, not the number.
  assert.deepStrictEqual(
    signalsOf('btpServices', [ok('c1', { instances: [], bindings: [], summary: { ...joined, unavailable: [] } })]),
    [{ label: 'instances with no binding here', count: 3, tone: 'warn', clusters: ['c1'] }]
  );
});

test("reliability stays silent when its own verdict says the pod sweep failed, rather than reading its empty arrays as a clean cluster", () => {
  const results = [ok('c1', { summary: { verdict: 'unknown', crashLoops: 0, underCapacity: 0 } })];
  assert.deepStrictEqual(signalsOf('reliability', results), []);
});

test('the same finding from two clusters sums and names both, so a fleet dot can say which', () => {
  const results = [
    ok('c1', { summary: { verdict: 'ok', crashLoops: 2 } }),
    ok('c2', { summary: { verdict: 'ok', crashLoops: 3 } })
  ];
  assert.deepStrictEqual(signalsOf('reliability', results), [
    { label: 'containers crashlooping', count: 5, tone: 'bad', clusters: ['c1', 'c2'] }
  ]);
});

test('findings sort worst first, so the first one is the one to act on', () => {
  const results = [ok('c1', {
    summary: { verdict: 'ok', crashLoops: 1, driftedDeployments: 9, zeroEndpointServices: 2 }
  })];
  const tones = signalsOf('reliability', results).map(s => s.tone);
  assert.deepStrictEqual(tones, ['bad', 'bad', 'warn'], 'a warn outranked a bad, so the tile leads with the wrong number');
});

test('a collector whose shape moved degrades to no signal rather than taking the summary down', () => {
  // `d.summary` absent entirely — the rule reads through it and must not throw out of the route.
  assert.deepStrictEqual(signalsOf('reliability', [ok('c1', null)]), []);
  assert.deepStrictEqual(signalsOf('reliability', [ok('c1', {})]), []);
  assert.deepStrictEqual(signalsOf('mesh', [ok('c1', { sidecarCoverage: [], mtls: 'not-an-array' })]), []);
});

test('a percentage finding carries its unit so the UI never prints "100 %"', () => {
  const results = [ok('c1', { summary: { quotaCoverage: 0.25, pendingPvcs: 0 } })];
  const found = signalsOf('storage', results);
  assert.deepStrictEqual(found, [
    { label: 'of namespaces have no ResourceQuota', count: 75, tone: 'warn', unit: '%', clusters: ['c1'] }
  ]);
});

test('GET /clusters/:id/summary carries health and signals on every group, not just a read verdict', async () => {
  await withRouter({}, async ({ get, registry }) => {
    const id = registry.active()[0].id;
    const { status, body } = await get(`/clusters/${id}/summary`);
    assert.equal(status, 200);
    const groups = Object.entries(body.groups);
    assert.ok(groups.length >= 17, `only ${groups.length} groups came back`);
    for (const [key, g] of groups) {
      assert.ok(['unknown', 'attention', 'warn', 'partial', 'clear'].includes(g.health), `${key}.health was ${g.health}`);
      assert.ok(Array.isArray(g.signals), `${key}.signals was not an array`);
      // The two verdicts must not be collapsed back into one by a later refactor.
      assert.ok('state' in g, `${key} lost its completeness verdict`);
    }
  });
});

test('GET /summary breaks down per cluster, so the rail dots need no request per cluster', async () => {
  await withRouter({}, async ({ get, registry }) => {
    const { status, body } = await get('/summary');
    assert.equal(status, 200);
    const ids = registry.active().map(c => c.id);
    assert.deepStrictEqual(Object.keys(body.perCluster).sort(), [...ids].sort());
    for (const id of ids) {
      const g = body.perCluster[id];
      assert.ok(Object.keys(g).length >= 17, `${id} got ${Object.keys(g).length} groups`);
      for (const [key, one] of Object.entries(g)) {
        assert.ok(one.health, `${id}.${key} had no health`);
        assert.ok(Array.isArray(one.signals), `${id}.${key}.signals was not an array`);
      }
    }
  });
});
