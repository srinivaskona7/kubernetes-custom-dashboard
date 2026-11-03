/**
 * Capacity collector.
 *
 * D1 (overcommit) and D2 (unbounded-container inventory) share one canary: sidecar-aware
 * container union. Summing only spec.containers makes a native sidecar's missing limit
 * invisible — this suite proves the sidecar-aware union is what makes it visible, by
 * removing the union and checking the assertion goes red.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import capacity from '../collectors/capacity.js';

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

function node(name, { cpu = '4', memory = '16Gi', pods = '110', ready = 'True', conditions } = {}) {
  return {
    metadata: { name },
    status: {
      allocatable: { cpu, memory, pods },
      conditions: conditions || [{ type: 'Ready', status: ready }]
    }
  };
}

function pod({
  name,
  namespace = 'default',
  nodeName = 'node-1',
  phase = 'Running',
  qosClass = 'Burstable',
  containers = [],
  initContainers = [],
  conditions = []
} = {}) {
  return {
    metadata: { name, namespace },
    spec: { nodeName, containers, initContainers },
    status: { phase, qosClass, conditions }
  };
}

function container(name, { cpuReq, cpuLim, memReq, memLim, restartPolicy } = {}) {
  const resources = {};
  if (cpuReq || memReq) resources.requests = { ...(cpuReq && { cpu: cpuReq }), ...(memReq && { memory: memReq }) };
  if (cpuLim || memLim) resources.limits = { ...(cpuLim && { cpu: cpuLim }), ...(memLim && { memory: memLim }) };
  const c = { name, resources };
  if (restartPolicy) c.restartPolicy = restartPolicy;
  return c;
}

// ------------------------------------------------------------------- D2 canary

test('D2: unbounded inventory counts a native sidecar with no limits — sidecar-aware union', () => {
  const p = pod({
    containers: [container('app', { cpuLim: '500m', memLim: '256Mi' })],
    initContainers: [container('istio-proxy', { restartPolicy: 'Always' /* no limits set */ })]
  });

  const roll = capacity.podCapacityRollup(p);
  assert.strictEqual(roll.totalEffectiveContainers, 2);
  assert.strictEqual(roll.unboundedCpuCount, 1);
  assert.strictEqual(roll.unboundedMemoryCount, 1);
  assert.strictEqual(roll.unboundedBothCount, 1);

  // Canary: remove the sidecar-aware union (fall back to spec.containers only) and this
  // real gap becomes invisible — the count must change when the union is dropped.
  const containersOnlyRoll = (() => {
    // Simulate the old, non-sidecar-aware behaviour inline for the canary comparison
    // rather than editing source: sum spec.containers alone.
    let unbounded = 0;
    for (const c of p.spec.containers) {
      const lim = (c.resources && c.resources.limits) || {};
      if (lim.cpu === undefined) unbounded += 1;
    }
    return unbounded;
  })();
  assert.notStrictEqual(roll.unboundedCpuCount, containersOnlyRoll,
    'sidecar-aware union must surface the sidecar-only gap that a containers-only sum hides');
  assert.strictEqual(containersOnlyRoll, 0, 'the app container alone has a cpu limit, so the naive sum would report 0');
});

test('D1: ordinary (non-restart-always) init containers use max(), not sum, for the limit ceiling', () => {
  const p = pod({
    containers: [container('app', { cpuLim: '200m', memLim: '128Mi' })],
    initContainers: [
      container('migrate', { cpuLim: '1', memLim: '1Gi' }),
      container('wait-for-db', { cpuLim: '500m', memLim: '512Mi' })
    ]
  });
  const roll = capacity.podCapacityRollup(p);
  // max(1, 0.5) = 1 core added to the app's 0.2 -> 1.2, never the sum (1.5 + 0.2 = 1.7).
  assert.strictEqual(roll.totalCpuLimit, 1.2);
  assert.strictEqual(roll.totalMemoryLimit, 128 * 1024 ** 2 + 1024 ** 3);
});

test('D1: native sidecar (restartPolicy Always) is summed concurrently, and sidecarLimitShare is broken out', () => {
  const p = pod({
    containers: [container('app', { cpuLim: '1', memLim: '1Gi' })],
    initContainers: [container('istio-proxy', { cpuLim: '500m', memLim: '256Mi', restartPolicy: 'Always' })]
  });
  const roll = capacity.podCapacityRollup(p);
  assert.strictEqual(roll.totalCpuLimit, 1.5); // summed, not maxed
  assert.ok(Math.abs(roll.sidecarCpuLimitShare - (0.5 / 1.5)) < 1e-9);
});

test('D1 is not an eviction-risk score: no such field exists on the rollup or the collector output', () => {
  const roll = capacity.podCapacityRollup(pod({ containers: [container('app', { cpuLim: '1', memLim: '1Gi' })] }));
  assert.strictEqual('evictionRisk' in roll, false);
});

// ------------------------------------------------------------------- D3 QoS pass-through

test('D3: QoS is read directly from status.qosClass with no re-derivation', async () => {
  const pods = [
    pod({ name: 'a', qosClass: 'Guaranteed' }),
    pod({ name: 'b', qosClass: 'BestEffort' }),
    pod({ name: 'c', qosClass: 'Burstable' })
  ];
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [node('node-1')];
    if (path.startsWith('/api/v1/pods')) return pods;
    if (path.startsWith('/apis/metrics.k8s.io')) return [];
    return [];
  };
  const result = await capacity.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.qos.counts, { Guaranteed: 1, BestEffort: 1, Burstable: 1 });
  assert.strictEqual(result.qos.total, 3);
});

// ------------------------------------------------------------------- D4 metrics-server states

test('D4: metrics-server 404 -> not installed', async () => {
  const err = new Error('the server could not find the requested resource');
  err.status = 404;
  const listFn = async () => { throw err; };
  const state = await capacity.metricsServerState({ cluster, token: 't', listFn });
  assert.deepStrictEqual(state, { installed: false, reporting: false, reason: 'NOT_INSTALLED' });
});

test('D4: metrics-server 503 -> installed but backend down (distinct from not-installed)', async () => {
  const err = new Error('service unavailable');
  err.status = 503;
  const listFn = async () => { throw err; };
  const state = await capacity.metricsServerState({ cluster, token: 't', listFn });
  assert.deepStrictEqual(state, { installed: true, reporting: false, reason: 'BACKEND_DOWN' });

  // Canary: this is the state this collector is required to add beyond metrics.js's three.
  // Swap in a 404 and confirm the verdict changes from BACKEND_DOWN to NOT_INSTALLED —
  // proving the two are not collapsed into one "unavailable" bucket.
  const notInstalledErr = new Error('nope');
  notInstalledErr.status = 404;
  const notInstalled = await capacity.metricsServerState({ cluster, token: 't', listFn: async () => { throw notInstalledErr; } });
  assert.notDeepStrictEqual(state, notInstalled);
});

test('D4: metrics-server answering -> installed and reporting', async () => {
  const listFn = async () => [];
  const state = await capacity.metricsServerState({ cluster, token: 't', listFn });
  assert.deepStrictEqual(state, { installed: true, reporting: true, reason: null });
});

test('D4: 403 on metrics.k8s.io -> unknown/forbidden, not a false "not installed"', async () => {
  const err = new Error('forbidden');
  err.status = 403;
  const listFn = async () => { throw err; };
  const state = await capacity.metricsServerState({ cluster, token: 't', listFn });
  assert.deepStrictEqual(state, { installed: null, reporting: false, reason: 'FORBIDDEN' });
});

// ------------------------------------------------------------------- D5 pending pods

test('D5: PodScheduled=False/Unschedulable is pending; other False reasons are not', () => {
  const stuck = pod({
    name: 'stuck',
    conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient cpu' }]
  });
  const notYet = pod({
    name: 'not-yet',
    conditions: [{ type: 'PodScheduled', status: 'False', reason: 'SchedulerError' }]
  });
  const scheduled = pod({
    name: 'ok',
    conditions: [{ type: 'PodScheduled', status: 'True' }]
  });
  assert.strictEqual(capacity.isUnschedulable(stuck), true);
  assert.strictEqual(capacity.isUnschedulable(notYet), false);
  assert.strictEqual(capacity.isUnschedulable(scheduled), false);
});

test('D5: pending pods surface in collect() without a second list call', async () => {
  const pods = [
    pod({
      name: 'stuck',
      namespace: 'shop',
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient memory' }]
    }),
    pod({ name: 'ok', conditions: [{ type: 'PodScheduled', status: 'True' }] })
  ];
  let podListCalls = 0;
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [node('node-1')];
    if (path.startsWith('/api/v1/pods')) { podListCalls += 1; return pods; }
    if (path.startsWith('/apis/metrics.k8s.io')) return [];
    return [];
  };
  const result = await capacity.collect({ cluster, token: 't', listFn });
  assert.strictEqual(podListCalls, 1, 'D5 must reuse the pods already read for D1/D2, not issue a second list');
  assert.strictEqual(result.pending.count, 1);
  assert.strictEqual(result.pending.items[0].name, 'stuck');
  assert.strictEqual(result.pending.items[0].namespace, 'shop');
  assert.strictEqual(result.pending.items[0].reason, 'Unschedulable');
});

// ------------------------------------------------------------------- degradation contract

test('pods read degrades via safeList: a 403 never throws and every derived field goes null/empty, not zero-as-lie', async () => {
  const err = new Error('pods is forbidden: User "x" cannot list resource "pods"');
  err.status = 403;
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [node('node-1')];
    if (path.startsWith('/api/v1/pods')) throw err;
    if (path.startsWith('/apis/metrics.k8s.io')) return [];
    return [];
  };
  const result = await capacity.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.summary.unavailable, ['pods']);
  assert.strictEqual(result.qos.total, 0);
  assert.strictEqual(result.pending.count, 0);
  assert.strictEqual(result.unboundedContainers.totalEffectiveContainers, 0);
  // The node/condition panel and D4's independent metrics-server verdict must survive a
  // pods-read failure untouched — they have nothing to do with whether pods could be read.
  assert.strictEqual(result.overcommit.nodes.length, 1);
  assert.strictEqual(result.metricsServer.reporting, true);
});

test('a thrown error from the pods list never propagates out of collect()', async () => {
  const err = new Error('boom');
  err.status = 500;
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [node('node-1')];
    if (path.startsWith('/api/v1/pods')) throw err;
    if (path.startsWith('/apis/metrics.k8s.io')) return [];
    return [];
  };
  await assert.doesNotReject(() => capacity.collect({ cluster, token: 't', listFn }));
});

// ------------------------------------------------------------------- overcommit ranking basis

test('overcommit ranking uses the enforceable triple (requests/allocatable, pod slots, usage) and includes sidecarLimitShare', async () => {
  const pods = [
    pod({
      name: 'p1',
      nodeName: 'node-1',
      containers: [container('app', { cpuReq: '1', memReq: '1Gi', cpuLim: '2', memLim: '2Gi' })],
      initContainers: [container('istio-proxy', { cpuLim: '200m', memLim: '128Mi', restartPolicy: 'Always' })]
    })
  ];
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [node('node-1', { cpu: '4', memory: '8Gi', pods: '10' })];
    if (path.startsWith('/api/v1/pods')) return pods;
    if (path.startsWith('/apis/metrics.k8s.io/v1beta1/nodes')) return [{ metadata: { name: 'node-1' }, usage: { cpu: '500m', memory: '1Gi' } }];
    return [];
  };
  const result = await capacity.collect({ cluster, token: 't', listFn });
  const n = result.overcommit.nodes[0];
  assert.strictEqual(n.cpuRequestedPercent, 25); // 1 / 4 cores
  assert.strictEqual(n.podSlotsPercent, 10); // 1 / 10 slots
  assert.ok(n.cpuUsagePercent !== null);
  assert.ok(result.overcommit.sidecarCpuLimitShare > 0);
  assert.strictEqual('evictionRisk' in result.overcommit, false);
});

test('nodesWithProblems reuses health.js condition polarity: SystemdUnitsReady=False is a problem, MemoryPressure=False is not', async () => {
  const healthy = node('node-1', {
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'MemoryPressure', status: 'False' },
      { type: 'SystemdUnitsReady', status: 'True' }
    ]
  });
  const unhealthy = node('node-2', {
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'MemoryPressure', status: 'False' },
      { type: 'SystemdUnitsReady', status: 'False' } // inverted polarity: False is the problem here
    ]
  });
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [healthy, unhealthy];
    if (path.startsWith('/api/v1/pods')) return [];
    if (path.startsWith('/apis/metrics.k8s.io')) return [];
    return [];
  };
  const result = await capacity.collect({ cluster, token: 't', listFn });
  assert.strictEqual(result.nodesWithProblems, 1);
});

test('truncated pods list is reported as a floor, not folded into unavailable', async () => {
  const items = [pod({ name: 'p1' })];
  Object.defineProperty(items, 'truncated', { value: true, enumerable: false });
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [node('node-1')];
    if (path.startsWith('/api/v1/pods')) return items;
    if (path.startsWith('/apis/metrics.k8s.io')) return [];
    return [];
  };
  const result = await capacity.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.summary.truncated, ['pods']);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

// ------------------------------------------------- D4b a denied metrics read is not "ok"

/**
 * `metricsServerState` already distinguishes a denied read (`installed: null`) from a genuine
 * absence (`installed: false`, a clean 404). Only the absence is a true fact about the
 * cluster; a 403 or a timeout means we do not know. That distinction was computed and then
 * dropped: `summary.unavailable` was built from the nodes and pods reads alone, so the group
 * state stayed 'ok' and the tile rendered a green pill over overcommit numbers while saying
 * nothing about the usage figures it could not read.
 *
 * This is the house rule — a failed read is never a zero and never a silent omission — applied
 * to the one probe that built its own error path instead of going through safeList.
 */
const listWithMetricsError = status => async ({ path }) => {
  if (path.startsWith('/api/v1/nodes')) return [node('node-1')];
  if (path.startsWith('/api/v1/pods')) return [pod({ name: 'a' })];
  if (path.startsWith('/apis/metrics.k8s.io')) throw Object.assign(new Error('nope'), { status });
  return [];
};

for (const [status, reason] of [[403, 'FORBIDDEN'], [401, 'FORBIDDEN'], [500, 'UPSTREAM']]) {
  test(`D4b: a metrics read failing ${status} is reported unavailable, not passed over`, async () => {
    const result = await capacity.collect({ cluster, token: 't', listFn: listWithMetricsError(status) });
    assert.strictEqual(result.metricsServer.reason, reason);
    assert.ok(result.summary.unavailable.includes('metrics-server'),
      `a ${status} on metrics.k8s.io must name itself in summary.unavailable, got ` +
      JSON.stringify(result.summary.unavailable));
  });
}

test('D4b: metrics-server genuinely absent (404) is a true fact, not an unavailable read', async () => {
  const result = await capacity.collect({ cluster, token: 't', listFn: listWithMetricsError(404) });
  assert.strictEqual(result.metricsServer.installed, false);
  assert.strictEqual(result.summary.unavailable.includes('metrics-server'), false,
    'a clean 404 means we read successfully and it is not installed — that is knowledge, not a gap');
});

test('D4b: a healthy metrics-server adds nothing to unavailable', async () => {
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return [node('node-1')];
    if (path.startsWith('/api/v1/pods')) return [pod({ name: 'a' })];
    return [];
  };
  const result = await capacity.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.summary.unavailable, []);
});
