/**
 * The Overview tiles' high-level stats: a headline of counts and one split bar per topic, so a
 * deviation reads at a glance before the tile is opened.
 *
 * The contract these tests hold is the console's own: a read that failed yields `null` stats and
 * never a row of zeros, and a truncated read marks its counts as floors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _signals from '../signals.js';
const { statsOf, signalsOf, hpaState, STAT_GROUP_KEYS } = _signals;
import _router_harness2 from './helpers/router-harness.js';
const { withRouter, DEFAULT_CLUSTERS } = _router_harness2;
import _registry3 from '../registry.js';
const { Registry } = _registry3;

const __dirname = import.meta.dirname;

const ok = (id, data) => ({ cluster: { id }, ok: true, data });
const failed = id => ({ cluster: { id }, ok: false, error: { code: 'FORBIDDEN' } });

const part = (stats, key) => stats.split.parts.find(p => p.key === key);
const head = (stats, label) => stats.headline.find(h => h.label === label);

const cond = (type, status, reason) => ({ type, status, reason, message: null });
const scaling = (reason, extra = {}) => ({
  minReplicas: 1, maxReplicas: 5, currentReplicas: 2,
  conditions: [cond('AbleToScale', 'True', 'ReadyForNewScale'), cond('ScalingActive', 'True', 'ValidMetricFound'),
    ...(reason ? [cond('ScalingLimited', 'True', reason)] : [cond('ScalingLimited', 'False', 'DesiredWithinRange')])],
  ...extra
});

test('a failed read has no stats, never zeros', () => {
  for (const key of STAT_GROUP_KEYS) {
    assert.equal(statsOf(key, [failed('c1')]), null, `${key} answered stats for a read that failed`);
    assert.equal(statsOf(key, []), null, `${key} answered stats with no read at all`);
  }
});

test('stats describe one cluster only; a fleet-wide call gets none', () => {
  const d = { nodes: { total: 3, ready: 3 }, pods: { total: 4, running: 4, pending: 0, failed: 0, succeeded: 0 } };
  assert.equal(statsOf('health', [ok('a', d), ok('b', d)]), null);
});

test('a collector shape that moved degrades to no stats instead of throwing', () => {
  assert.equal(statsOf('autoscaling', [ok('c1', { hpas: 'not-a-list' })]), null);
});

test('health: ready of total nodes, pods split by phase', () => {
  const s = statsOf('health', [ok('c1', {
    nodes: { total: 3, ready: 2 },
    pods: { total: 120, running: 116, pending: 2, failed: 1, succeeded: 1 }
  })]);
  assert.deepStrictEqual(head(s, 'nodes ready'), { count: 2, of: 3, label: 'nodes ready', tone: 'bad' });
  assert.equal(head(s, 'pods').count, 120);
  assert.equal(s.split.total, 120);
  assert.deepStrictEqual(s.split.parts.map(p => [p.key, p.count, p.tone]), [
    ['running', 116, 'ok'], ['pending', 2, 'warn'], ['failed', 1, 'bad'], ['succeeded', 1, 'neutral'], ['otherPhase', 0, 'unknown']
  ]);
  assert.equal(s.atLeast, false);
});

test('health: an unread pod list is unavailable, not zero pods', () => {
  const s = statsOf('health', [ok('c1', { nodes: { total: 3, ready: 3 }, pods: null })]);
  assert.equal(head(s, 'pods').count, null);
  assert.equal(s.split, null);
});

test('workloads: ready vs not ready, restarts in the headline', () => {
  const s = statsOf('workloads', [ok('c1', { summary: { total: 75, notReady: 2, restarts: 248, unavailable: [], truncated: [] } })]);
  assert.deepStrictEqual(s.headline.map(h => [h.label, h.count]), [['workloads', 75], ['not ready', 2], ['container restarts', 248]]);
  assert.equal(head(s, 'not ready').tone, 'bad');
  assert.deepStrictEqual(s.split.parts.map(p => [p.key, p.count]), [['ready', 73], ['notReady', 2]]);
});

test('a truncated read marks every count as a floor', () => {
  const s = statsOf('workloads', [ok('c1', { summary: { total: 500, notReady: 0, restarts: 0, unavailable: [], truncated: ['pods'] } })]);
  assert.equal(s.atLeast, true);
});

test('hpaState reads the controller reason, the same way the tab does', () => {
  assert.equal(hpaState(scaling('TooManyReplicas', { currentReplicas: 5 })), 'ceiling');
  // min == max sits at max forever; the tab calls it "Fixed at N", not at ceiling.
  assert.equal(hpaState(scaling('TooFewReplicas', { minReplicas: 2, maxReplicas: 2, currentReplicas: 2 })), 'fixed');
  // Held at the floor is idle, not pressure.
  assert.equal(hpaState(scaling('TooFewReplicas', { minReplicas: 3, maxReplicas: 15, currentReplicas: 3 })), 'scaling');
  assert.equal(hpaState(scaling(null)), 'scaling');
  assert.equal(hpaState({ conditions: [] }), 'other');
  assert.equal(hpaState({ ...scaling(null), conditions: [cond('AbleToScale', 'False', 'FailedGetScale')] }), 'failing');
  assert.equal(hpaState({ ...scaling(null), conditions: [cond('ScalingActive', 'False', 'FailedGetResourceMetric')] }), 'failing');
  assert.equal(hpaState({ ...scaling(null), conditions: [cond('ScalingActive', 'False', 'ScalingDisabled')] }), 'other');
});

test('autoscaling: an HPA fixed or at its floor is not "at its maximum" (platform-sbx false alarm)', () => {
  // The three HPAs platform-sbx actually runs: two min == max at 2, one held at its floor.
  const hpas = [
    scaling('TooFewReplicas', { minReplicas: 2, maxReplicas: 2, currentReplicas: 2 }),
    scaling('TooFewReplicas', { minReplicas: 2, maxReplicas: 2, currentReplicas: 2 }),
    scaling('TooFewReplicas', { minReplicas: 3, maxReplicas: 15, currentReplicas: 3 })
  ];
  assert.deepStrictEqual(signalsOf('autoscaling', [ok('c1', { hpas })]), []);
});

test('autoscaling: the signal still fires on a real ceiling and on an HPA that cannot scale', () => {
  const hpas = [
    scaling('TooManyReplicas', { currentReplicas: 5 }),
    { ...scaling(null), conditions: [cond('AbleToScale', 'False', 'FailedGetScale')] }
  ];
  const found = signalsOf('autoscaling', [ok('c1', { hpas })]).map(s => [s.label, s.count, s.tone]);
  assert.deepStrictEqual(found, [['HPA not scaling', 1, 'bad'], ['HPA at its maximum', 1, 'warn']]);
});

test('autoscaling stats: HPAs split by state, CronJobs in the headline', () => {
  const hpas = [
    scaling('TooManyReplicas', { currentReplicas: 5 }),
    scaling(null),
    scaling('TooFewReplicas', { minReplicas: 2, maxReplicas: 2, currentReplicas: 2 })
  ];
  const s = statsOf('autoscaling', [ok('c1', { hpas, summary: { totalHpas: 3, totalCronJobs: 4 } })]);
  assert.deepStrictEqual(s.headline.map(h => [h.label, h.count]), [['HPAs', 3], ['at ceiling', 1], ['CronJobs', 4]]);
  assert.deepStrictEqual(s.split.parts.map(p => [p.key, p.count]), [
    ['scaling', 1], ['ceiling', 1], ['failing', 0], ['fixed', 1], ['other', 0]
  ]);
});

test('networking: Ingresses, Gateway API and Istio objects side by side, no APIRules', () => {
  const s = statsOf('networking', [ok('c1', { summary: {
    ingressesCount: 4, httproutesCount: 3, gatewaysCount: 1, virtualServicesCount: 9, servicesCount: 91
  } })]);
  assert.deepStrictEqual(s.headline.map(h => [h.label, h.count]), [
    ['Ingresses', 4], ['HTTPRoutes', 3], ['Gateway', 1], ['VirtualServices', 9], ['Services', 91]
  ]);
  assert.equal(s.split, null);
});

test('certificates: each certificate counted once, worst state first', () => {
  const certificates = [
    { isExpired: true, isExpiringSoon: true, isReady: false },
    { isExpired: false, isExpiringSoon: true, isReady: true },
    { isExpired: false, isExpiringSoon: false, isReady: false },
    { isExpired: false, isExpiringSoon: false, isReady: true }
  ];
  const s = statsOf('certificates', [ok('c1', { certificates, summary: { totalCertificates: 4, expiringSoon: 2, expired: 1 } })]);
  assert.deepStrictEqual(s.split.parts.map(p => [p.key, p.count]), [['valid', 1], ['expiring', 1], ['unready', 1], ['expired', 1]]);
  assert.equal(s.split.parts.reduce((n, p) => n + p.count, 0), s.split.total);
  assert.deepStrictEqual(s.headline.map(h => [h.label, h.count]), [['certificates', 4], ['expiring soon', 2], ['expired', 1]]);
});

test('singular labels agree with a count of one', () => {
  const s = statsOf('workloads', [ok('c1', { summary: { total: 1, notReady: 0, restarts: 1, unavailable: [], truncated: [] } })]);
  assert.deepStrictEqual(s.headline.map(h => h.label), ['workload', 'not ready', 'container restart']);
});

test('/clusters/:id/summary carries stats on the six Overview topics', async () => {
  await withRouter(async ({ get }) => {
    const { status, body } = await get('/clusters/platformsbx/summary');
    assert.equal(status, 200);
    for (const key of STAT_GROUP_KEYS) {
      assert.ok('stats' in body.groups[key], `group '${key}' has no stats field`);
    }
    assert.ok(body.groups.health.stats && body.groups.health.stats.headline.length, 'the fake cluster answered, so health has stats');
  });
});

test('the fleet-wide /summary sends no stats: the rail reads verdicts only', async () => {
  await withRouter(async ({ get }) => {
    const { body } = await get('/summary');
    for (const key of STAT_GROUP_KEYS) assert.ok(!('stats' in body.groups[key]), `fleet /summary carried stats for '${key}'`);
  });
});

test('a one-cluster fleet still gets no stats on /summary: the route decides, not the cluster count', async () => {
  const registry = new Registry({ clusters: [DEFAULT_CLUSTERS[0]] });
  await withRouter({ registry }, async ({ get }) => {
    const { status, body } = await get('/summary');
    assert.equal(status, 200);
    assert.ok(Object.keys(body.groups).length, 'the sweep answered no groups; the check below would pass vacuously');
    for (const key of STAT_GROUP_KEYS) assert.ok(!('stats' in body.groups[key]), `one-cluster /summary carried stats for '${key}'`);
  });
});

test('a lifetime restart count is a number, not a deviation', () => {
  const s = statsOf('workloads', [ok('c1', { summary: { total: 75, notReady: 0, restarts: 248, unavailable: [], truncated: [] } })]);
  assert.equal(head(s, 'container restarts').tone, undefined);
});

// A collector that answered can still have had one of its lists refused: the count built from that
// list is then 0 by construction, and the stat has to say unavailable instead.
test('health: a refused pod list is unavailable, even though the collector reports pods.total 0', () => {
  const s = statsOf('health', [ok('c1', {
    nodes: { total: 3, ready: 3 },
    pods: { total: 0, running: 0, pending: 0, failed: 0, succeeded: 0 },
    unavailable: ['pods']
  })]);
  assert.equal(head(s, 'pods').count, null);
  assert.equal(s.split, null);
  assert.equal(head(s, 'nodes ready').count, 3, 'the node read stood, so its count stands');
});

test('health: pods in a phase outside the four still fill the bar, so the parts sum to the total', () => {
  const s = statsOf('health', [ok('c1', {
    nodes: { total: 1, ready: 1 },
    pods: { total: 10, running: 7, pending: 1, failed: 0, succeeded: 0, byPhase: { Running: 7, Pending: 1, Unknown: 2 } }
  })]);
  assert.equal(s.split.parts.reduce((n, p) => n + p.count, 0), 10);
  assert.equal(part(s, 'otherPhase').count, 2);
});

test('workloads: a refused controller list leaves the totals unavailable; a refused pod list, the restarts', () => {
  const s = statsOf('workloads', [ok('c1', { summary: { total: 40, notReady: 0, restarts: 0, unavailable: ['statefulsets', 'pods'], truncated: [] } })]);
  assert.equal(head(s, 'workloads').count, null);
  assert.equal(head(s, 'not ready').count, null);
  assert.equal(head(s, 'container restarts').count, null);
  assert.equal(s.split, null);
});

test('workloads: a per-namespace refusal label counts as refused too', () => {
  const s = statsOf('workloads', [ok('c1', { summary: { total: 40, notReady: 0, restarts: 0, unavailable: ['deployments[ns=a]'], truncated: [] } })]);
  assert.equal(head(s, 'workloads').count, null);
});

test('autoscaling: a refused HPA list is unavailable, not 0 HPAs', () => {
  const s = statsOf('autoscaling', [ok('c1', { hpas: [], summary: { totalHpas: 0, totalCronJobs: 2, unavailable: ['hpa'] } })]);
  assert.equal(head(s, 'HPAs').count, null);
  assert.equal(head(s, 'at ceiling').count, null);
  assert.equal(head(s, 'CronJobs').count, 2);
  assert.equal(s.split, null);
});

test('networking: each refused list blanks its own count only', () => {
  const s = statsOf('networking', [ok('c1', { summary: {
    ingressesCount: 1, httproutesCount: 2, gatewaysCount: 0, virtualServicesCount: 0, servicesCount: 0,
    unavailable: ['httproutes', 'virtualservices', 'services']
  } })]);
  assert.deepStrictEqual(s.headline.map(h => h.count), [1, null, 0, null, null]);
});

test('certificates: a refused certificate list is unavailable, not 0 certificates', () => {
  const s = statsOf('certificates', [ok('c1', { certificates: [], summary: { totalCertificates: 0, expiringSoon: 0, expired: 0, unavailable: ['certificates'] } })]);
  assert.deepStrictEqual(s.headline.map(h => h.count), [null, null, null]);
  assert.equal(s.split, null);
});
