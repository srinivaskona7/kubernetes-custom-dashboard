/**
 * Four server-side lies, pinned.
 *
 *   1. health.js reported neither `unavailable` nor `truncated`, so the Nodes tab's every count
 *      — including pod counts from a `?limit=2000` read — rendered as a confident number
 *      whatever had happened upstream.
 *   2. topology.js fabricated a pod ceiling (`|| 110`), printing Kubernetes' default kubelet
 *      setting as if a node had measured it.
 *   3. capacity.js read `allocatable.pods` only, so the same node had a ceiling on one sub-tab
 *      and null on another.
 *   4. two different node-problem predicates produced two different "nodes with problems"
 *      counts in one tab.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import health from '../collectors/health.js';
import capacity from '../collectors/capacity.js';
import topology from '../collectors/topology.js';

const __dirname = import.meta.dirname;

const cluster = { id: 'c1', displayName: 'C1', env: 'dev' };
const SRV = path.join(__dirname, '..', 'collectors');

function node(name, { capacityQ, allocatableQ, conditions } = {}) {
  return {
    metadata: { name, labels: {}, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {},
    status: {
      conditions: conditions || [{ type: 'Ready', status: 'True' }],
      capacity: capacityQ || { cpu: '4', memory: '8Gi', pods: '110' },
      allocatable: allocatableQ || { cpu: '3900m', memory: '7Gi', pods: '110' },
      nodeInfo: { kubeletVersion: 'v1.32.4' }
    }
  };
}

function forbidden() {
  const err = new Error('pods is forbidden: User cannot list resource "pods"');
  err.status = 403;
  return err;
}

/** An array marked the way k8s.js marks one that stopped at the paging ceiling. */
function truncatedArray(items) {
  const arr = [...items];
  Object.defineProperty(arr, 'truncated', { value: true, enumerable: false });
  return arr;
}

// ------------------------------------------------------- 1. health completeness contract

test('health: a refused pod read is reported as unavailable, not as zero pods', async () => {
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [node('node-a')];
    if (p.startsWith('/api/v1/pods')) throw forbidden();
    return [];
  };
  const result = await health.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.unavailable, ['pods']);
  assert.deepStrictEqual(result.truncated, []);
  // The node half of the answer still stands — that is the point of degrading rather than throwing.
  assert.strictEqual(result.nodes.total, 1);
});

test('health: a pod read that hit the ?limit=2000 ceiling says truncated, and is not unavailable', async () => {
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [node('node-a')];
    if (p.startsWith('/api/v1/pods')) {
      return truncatedArray([{ metadata: { name: 'p1', namespace: 'x' }, spec: { nodeName: 'node-a' }, status: { phase: 'Running' } }]);
    }
    return [];
  };
  const result = await health.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.truncated, ['pods']);
  assert.deepStrictEqual(result.unavailable, []);
  assert.strictEqual(result.pods.total, 1); // a floor, which is what `truncated` says
});

test('health: a truncated NODE list is reported too, since every total derives from it', async () => {
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return truncatedArray([node('node-a')]);
    if (p.startsWith('/api/v1/pods')) return [];
    return [];
  };
  const result = await health.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.truncated, ['nodes']);
});

test('health: a refused NODE read still fails loudly — there is no partial answer to report', async () => {
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) throw forbidden();
    return [];
  };
  await assert.rejects(() => health.collect({ cluster, token: 't', listFn }));
});

test('health: a clean read reports both keys empty, so a count can be trusted', async () => {
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [node('node-a')];
    return [];
  };
  const result = await health.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.unavailable, []);
  assert.deepStrictEqual(result.truncated, []);
});

// ------------------------------------------------------- 2. no fabricated pod ceiling

test('topology: a node reporting no pod ceiling yields null, never 110', async () => {
  const bare = node('node-a', { capacityQ: { cpu: '4', memory: '8Gi' }, allocatableQ: { cpu: '4', memory: '8Gi' } });
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [bare];
    return [];
  };
  const result = await topology.collect({ cluster, token: 't', listFn });
  assert.strictEqual(result.nodes[0].podCapacity, null);
  assert.strictEqual(result.nodes[0].podUsagePercent, null);
  assert.strictEqual(result.summary.totalPodCapacity, null);
  assert.strictEqual(result.summary.totalPodCapacityNodesReporting, 0);
  assert.strictEqual(result.nodeGroups[0].podCapacity, null);
  assert.strictEqual(result.nodeGroups[0].podUsagePercent, null);
});

test('topology: a partial pool sums only the nodes that reported and withholds the percentage', async () => {
  const withCeiling = node('node-a');
  const without = node('node-b', { capacityQ: { cpu: '4', memory: '8Gi' }, allocatableQ: { cpu: '4', memory: '8Gi' } });
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [withCeiling, without];
    return [];
  };
  const result = await topology.collect({ cluster, token: 't', listFn });
  const pool = result.nodeGroups[0];
  assert.strictEqual(pool.nodeCount, 2);
  assert.strictEqual(pool.podCapacity, 110);
  assert.strictEqual(pool.podCapacityNodesReporting, 1);
  assert.strictEqual(pool.podUsagePercent, null);
  assert.strictEqual(result.summary.totalPodCapacity, 110);
  assert.strictEqual(result.summary.totalPodCapacityNodesReporting, 1);
});

test('topology.js source carries no hardcoded 110 default', () => {
  const src = fs.readFileSync(path.join(SRV, 'topology.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.strictEqual(/\b110\b/.test(code), false, 'topology.js must not fabricate a pod ceiling');
});

// ------------------------------------------------------- 3. one pod ceiling, both sub-tabs

test('capacity and health agree on a node whose ceiling is only in status.capacity', async () => {
  const capacityOnly = node('node-a', {
    capacityQ: { cpu: '4', memory: '8Gi', pods: '58' },
    allocatableQ: { cpu: '3900m', memory: '7Gi' }
  });
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [capacityOnly];
    return [];
  };
  const [h, c] = await Promise.all([
    health.collect({ cluster, token: 't', listFn }),
    capacity.collect({ cluster, token: 't', listFn })
  ]);
  assert.strictEqual(h.nodes.items[0].podCapacity, 58);
  assert.strictEqual(c.overcommit.nodes[0].podSlotsCapacity, 58);
});

// ------------------------------------------------------- 4. one node-problem predicate

test('the node-problem predicate is one function: capacity.js imports health.js, it does not re-derive', () => {
  const src = fs.readFileSync(path.join(SRV, 'capacity.js'), 'utf8');
  assert.strictEqual(
    /function\s+isProblemCondition/.test(src),
    false,
    'capacity.js must use health.isProblemCondition, not its own copy'
  );
  assert.ok(/isProblemCondition/.test(src) && /from '\.\/health\.js'/.test(src));
  assert.strictEqual(typeof health.isProblemCondition, 'function');
});

test('a NotReady node counts as a problem node in BOTH health and capacity', async () => {
  const notReady = node('node-a', {
    conditions: [
      { type: 'Ready', status: 'False', reason: 'KubeletNotReady' },
      { type: 'MemoryPressure', status: 'False' }
    ]
  });
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [notReady];
    return [];
  };
  const [h, c] = await Promise.all([
    health.collect({ cluster, token: 't', listFn }),
    capacity.collect({ cluster, token: 't', listFn })
  ]);
  // The conditions sub-tab's empty state names NotReady first; it must not print its all-clear
  // beside a red NotReady pill.
  assert.deepStrictEqual(h.nodes.items[0].problems.map(p => p.type), ['Ready']);
  assert.strictEqual(h.nodes.withProblems, 1);
  assert.strictEqual(c.nodesWithProblems, 1);
});

test('SystemdUnitsReady polarity is preserved by the shared predicate', () => {
  assert.strictEqual(health.isProblemCondition({ type: 'SystemdUnitsReady', status: 'True' }), false);
  assert.strictEqual(health.isProblemCondition({ type: 'SystemdUnitsReady', status: 'False' }), true);
  assert.strictEqual(health.isProblemCondition({ type: 'MemoryPressure', status: 'False' }), false);
  assert.strictEqual(health.isProblemCondition({ type: 'MemoryPressure', status: 'Unknown' }), true);
});

// ------------------------------------------------------- 5. health's node-group pod ceiling

test('health nodeGroups: a pool where nothing reported a ceiling publishes null, not 0', async () => {
  const bare = node('node-a', { capacityQ: { cpu: '4', memory: '8Gi' }, allocatableQ: { cpu: '4', memory: '8Gi' } });
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [bare];
    return [];
  };
  const h = await health.collect({ cluster, token: 't', listFn });
  const pool = h.nodes.nodeGroups[0];
  assert.strictEqual(pool.podCapacity, null);
  assert.strictEqual(pool.podCapacityNodesReporting, 0);
  assert.strictEqual(pool.podUsagePercent, null);
});

test('health nodeGroups: a partial pool never divides by a partial denominator', async () => {
  const withCeiling = node('node-a');
  const without = node('node-b', { capacityQ: { cpu: '4', memory: '8Gi' }, allocatableQ: { cpu: '4', memory: '8Gi' } });
  const pods = [];
  // 150 pods on the pool: over the ONE reported ceiling of 110, which is exactly the shape
  // that used to render 136.4%.
  for (let i = 0; i < 150; i += 1) {
    pods.push({ metadata: { name: `p${i}`, namespace: 'x' }, spec: { nodeName: i % 2 ? 'node-a' : 'node-b' }, status: { phase: 'Running' } });
  }
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [withCeiling, without];
    if (p.startsWith('/api/v1/pods')) return pods;
    return [];
  };
  const h = await health.collect({ cluster, token: 't', listFn });
  const pool = h.nodes.nodeGroups[0];
  assert.strictEqual(pool.totalNodes, 2);
  assert.strictEqual(pool.pods, 150);
  assert.strictEqual(pool.podCapacity, 110, 'sums only the nodes that reported');
  assert.strictEqual(pool.podCapacityNodesReporting, 1);
  assert.strictEqual(pool.podUsagePercent, null, 'no percentage over a partial denominator');
});

test('health nodeGroups: a fully-reporting pool does publish the percentage', async () => {
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [node('node-a'), node('node-b')];
    if (p.startsWith('/api/v1/pods')) {
      return [{ metadata: { name: 'p1', namespace: 'x' }, spec: { nodeName: 'node-a' }, status: { phase: 'Running' } }];
    }
    return [];
  };
  const h = await health.collect({ cluster, token: 't', listFn });
  const pool = h.nodes.nodeGroups[0];
  assert.strictEqual(pool.podCapacity, 220);
  assert.strictEqual(pool.podCapacityNodesReporting, 2);
  assert.strictEqual(pool.podUsagePercent, 0.5);
});

test('health.js source zero-fills no pod ceiling', () => {
  const src = fs.readFileSync(path.join(SRV, 'health.js'), 'utf8');
  assert.strictEqual(
    /podCapacity\s*\+=\s*[^;]*\|\|\s*0/.test(src),
    false,
    'a node that reported no ceiling must not contribute a zero'
  );
});

// ------------------------------------------------------- 6. no fabricated raw capacity strings

test('topology: the raw capacity block reports null, never a fabricated "0"', async () => {
  const bare = {
    metadata: { name: 'node-a', labels: {}, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {},
    status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.32.4' } }
  };
  const listFn = async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [bare];
    return [];
  };
  const result = await topology.collect({ cluster, token: 't', listFn });
  assert.deepStrictEqual(result.nodes[0].capacity, { cpu: null, memory: null, pods: null });
  assert.strictEqual(result.nodes[0].podCapacity, null);
});
