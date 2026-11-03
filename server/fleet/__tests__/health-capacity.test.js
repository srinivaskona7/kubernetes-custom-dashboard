/**
 * The cluster capacity totals, which had no test and were consequently wrong.
 *
 * `collect` summed each node's raw `status.capacity` and the UI rendered the result under the
 * label "requested / allocatable". On a real cluster that reads 93 GiB in the header above a
 * Nodes table whose own rows add up to 90 GiB — two numbers for one fact, neither labelled
 * honestly. These tests pin both totals and pin the denominator every percentage divides by.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import health from '../collectors/health.js';

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

/**
 * Two nodes reserving a visible slice for the kubelet: 8 cores / 32Gi of hardware each,
 * 7.9 cores / 30Gi of it schedulable. The gap is the whole point — a fixture where
 * allocatable equals capacity cannot fail the bug this file exists to catch.
 */
function nodes() {
  return [
    {
      metadata: { name: 'node-a', creationTimestamp: '2026-01-01T00:00:00Z', labels: {} },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        capacity: { cpu: '8', memory: '32Gi', pods: '110' },
        allocatable: { cpu: '7900m', memory: '30Gi', pods: '110' },
        nodeInfo: { kubeletVersion: 'v1.32.4' }
      },
      spec: {}
    },
    {
      metadata: { name: 'node-b', creationTimestamp: '2026-01-01T00:00:00Z', labels: {} },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        capacity: { cpu: '8', memory: '32Gi', pods: '110' },
        allocatable: { cpu: '7900m', memory: '30Gi', pods: '110' },
        nodeInfo: { kubeletVersion: 'v1.32.4' }
      },
      spec: {}
    }
  ];
}

/** One running pod on node-a asking for 1 core / 2Gi. */
function pods() {
  return [
    {
      metadata: { name: 'app-1', namespace: 'prod' },
      spec: {
        nodeName: 'node-a',
        containers: [{ name: 'app', resources: { requests: { cpu: '1', memory: '2Gi' } } }]
      },
      status: { phase: 'Running', containerStatuses: [{ restartCount: 0 }] }
    }
  ];
}

function listFor({ nodeUsage = null } = {}) {
  return async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return nodes();
    if (path.startsWith('/api/v1/pods')) return pods();
    if (path.includes('metrics.k8s.io')) {
      if (!nodeUsage) throw Object.assign(new Error('metrics-server not found'), { status: 404 });
      return nodeUsage;
    }
    return [];
  };
}

const GIB = 1024 ** 3;

test('capacity and allocatable are reported as two separate totals, not one', async () => {
  const result = await health.collect({ cluster, token: 'fake', listFn: listFor() });

  assert.strictEqual(result.capacity.cpu.capacity, 16, 'raw hardware cores');
  assert.strictEqual(result.capacity.cpu.allocatable, 15.8, 'cores the scheduler can hand out');
  assert.strictEqual(result.capacity.memory.capacity, 64 * GIB);
  assert.strictEqual(result.capacity.memory.allocatable, 60 * GIB);
});

test('the cluster totals equal the sum of the node rows the Nodes tab renders', async () => {
  const result = await health.collect({ cluster, token: 'fake', listFn: listFor() });
  const rows = result.nodes.items;

  const sum = key => rows.reduce((n, r) => n + r[key], 0);
  assert.strictEqual(result.capacity.cpu.allocatable, sum('cpuAllocatable'));
  assert.strictEqual(result.capacity.memory.allocatable, sum('memoryAllocatable'));
  assert.strictEqual(result.capacity.cpu.capacity, sum('cpuCapacity'));
  assert.strictEqual(result.capacity.memory.capacity, sum('memoryCapacity'));
});

test('requested percent divides by allocatable, never by capacity', async () => {
  const result = await health.collect({ cluster, token: 'fake', listFn: listFor() });

  assert.strictEqual(result.capacity.cpu.requested, 1);
  assert.strictEqual(result.capacity.memory.requested, 2 * GIB);
  // 1 / 15.8 = 6.3%. Against capacity it would be 6.3% too at this precision, so memory
  // carries the discriminating assertion: 2/60 = 3.3%, but 2/64 = 3.1%.
  assert.strictEqual(result.capacity.memory.percent, 3.3);
  assert.strictEqual(result.capacity.cpu.percent, 6.3);
});

test('live usage percent divides by allocatable too', async () => {
  const nodeUsage = [
    { metadata: { name: 'node-a' }, usage: { cpu: '2', memory: `${3 * 1024 * 1024}Ki` } },
    { metadata: { name: 'node-b' }, usage: { cpu: '1', memory: `${3 * 1024 * 1024}Ki` } }
  ];
  const result = await health.collect({ cluster, token: 'fake', listFn: listFor({ nodeUsage }) });

  assert.strictEqual(result.metrics.available, true);
  assert.strictEqual(result.capacity.cpu.used, 3);
  assert.strictEqual(result.capacity.memory.used, 6 * GIB);
  // 6/60 = 10%, where 6/64 would be 9.4%.
  assert.strictEqual(result.capacity.memory.usedPercent, 10);
});

test('without metrics-server, used stays null rather than becoming a zero', async () => {
  const result = await health.collect({ cluster, token: 'fake', listFn: listFor() });

  assert.strictEqual(result.metrics.available, false);
  assert.strictEqual(result.capacity.cpu.used, null);
  assert.strictEqual(result.capacity.memory.used, null);
  assert.strictEqual(result.capacity.cpu.usedPercent, null);
  assert.strictEqual(result.capacity.memory.usedPercent, null);
});

test('a node that reports no allocatable falls back to its capacity, not to zero', async () => {
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) {
      const [a, b] = nodes();
      delete a.status.allocatable;
      return [a, b];
    }
    if (path.startsWith('/api/v1/pods')) return pods();
    throw Object.assign(new Error('metrics-server not found'), { status: 404 });
  };

  const result = await health.collect({ cluster, token: 'fake', listFn });
  // node-a contributes its full 8 cores / 32Gi; node-b still contributes 7.9 / 30Gi.
  assert.strictEqual(result.capacity.cpu.allocatable, 15.9);
  assert.strictEqual(result.capacity.memory.allocatable, 62 * GIB);
});

/**
 * Per-node pod slots. A Succeeded or Failed pod keeps `spec.nodeName` for as long as its
 * record is retained but holds no scheduler slot, so counting it made the Pod slots card on a
 * cluster with CronJob history read 27/20, 135%, and "-7 free" — and put completed Jobs in the
 * node's own pod list. `kubectl describe node` counts the same population under
 * "Non-terminated Pods".
 */
test('per-node pod counts exclude terminal pods, while the cluster phase totals keep them', async () => {
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/nodes')) return nodes();
    if (path.startsWith('/api/v1/pods')) {
      return [
        ...pods(),
        {
          metadata: { name: 'cron-1', namespace: 'prod' },
          spec: { nodeName: 'node-a', containers: [{ name: 'job', resources: {} }] },
          status: { phase: 'Succeeded', containerStatuses: [{ restartCount: 0 }] }
        },
        {
          metadata: { name: 'cron-2', namespace: 'prod' },
          spec: { nodeName: 'node-a', containers: [{ name: 'job', resources: {} }] },
          status: { phase: 'Failed', containerStatuses: [{ restartCount: 0 }] }
        },
        {
          metadata: { name: 'pending-1', namespace: 'prod' },
          spec: { nodeName: 'node-a', containers: [{ name: 'app', resources: {} }] },
          status: { phase: 'Pending', containerStatuses: [] }
        }
      ];
    }
    throw Object.assign(new Error('metrics-server not found'), { status: 404 });
  };

  const result = await health.collect({ cluster, token: 'fake', listFn });
  const nodeA = result.nodes.items.find(n => n.name === 'node-a');

  // Running + Pending occupy a slot; Succeeded and Failed do not.
  assert.strictEqual(nodeA.pods, 2);
  assert.strictEqual(nodeA.podsList.length, 2);
  assert.deepStrictEqual(
    nodeA.podsList.map(p => p.name).sort(),
    ['app-1', 'pending-1']
  );
  assert.strictEqual(nodeA.podUsagePercent, 1.8); // 2 / 110

  // The cluster-wide phase breakdown still reports every pod — it is a phase census, not a
  // slot count, and a Failed pod disappearing from it would hide a real failure.
  assert.strictEqual(result.pods.total, 4);
  assert.strictEqual(result.pods.succeeded, 1);
  assert.strictEqual(result.pods.failed, 1);
});
