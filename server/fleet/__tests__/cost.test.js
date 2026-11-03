
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _cost from '../collectors/cost.js';

const __dirname = import.meta.dirname;
const {
  collect,
  billableShape,
  isBillable,
  priceNodes,
  requestsByNamespace,
  attribute,
  catalogForSimulator,
  DEFAULT_CATALOG
} = _cost;

function node({
  name = 'n1', instanceType = 'm5.2xlarge', zone = 'us-east-1a', providerID = 'aws:///us-east-1a/i-0abc',
  cpu = '8', memory = '32Gi', allocCpu = '7800m', allocMemory = '30Gi', ready = true, deletionTimestamp
} = {}) {
  const labels = { 'topology.kubernetes.io/zone': zone };
  if (instanceType) labels['node.kubernetes.io/instance-type'] = instanceType;
  return {
    metadata: { name, labels, deletionTimestamp },
    spec: { providerID },
    status: {
      capacity: { cpu, memory, pods: '110' },
      allocatable: { cpu: allocCpu, memory: allocMemory, pods: '110' },
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }]
    }
  };
}

function pod({ name = 'p', namespace = 'app', phase = 'Running', cpu = '500m', memory = '1Gi', nodeName = 'n1' } = {}) {
  return {
    metadata: { name, namespace },
    spec: { nodeName, containers: [{ name: 'c', resources: { requests: { cpu, memory } } }] },
    status: { phase }
  };
}

function fakeListFn(byPath) {
  return async ({ path }) => {
    for (const [match, result] of byPath) {
      if (path.startsWith(match)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`unexpected path in test: ${path}`);
  };
}

/** No metrics-server, so usage percentages stay null and only requests are reported. */
const NO_METRICS = [['/apis/metrics.k8s.io', Object.assign(new Error('not found'), { status: 404 })]];

// --- the spec's worked example, end to end --------------------------------------------------

test('3 x m5.2xlarge: hourly, monthly, CU and the node table all agree with the rate card', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node({ name: 'n1' }), node({ name: 'n2' }), node({ name: 'n3' })]],
    ['/api/v1/pods', []],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.verdict, 'ok');
  assert.equal(out.summary.nodeCount, 3);
  assert.equal(out.summary.hourlyUsd, 1.512);
  assert.equal(out.summary.monthlyUsd, 1103.76);
  assert.equal(out.summary.monthlyCu, 1226.4);
  assert.equal(out.summary.monthlyEur, 1022.01, 'EUR derives from USD, not from the CU meter');
  assert.equal(out.summary.costIsFloor, false);
  assert.equal(out.summary.unpricedNodes, 0);
  assert.equal(out.summary.estimate, true, 'the payload must declare itself an estimate');
  assert.equal(out.summary.rateCard, 'built-in');

  // Priced on capacity (8 vCPU / 32 GiB), not on allocatable — the invoice is for the machine.
  assert.equal(out.summary.cpuCapacity, 24);
  assert.equal(out.summary.memGiBCapacity, 96);
  // Utilization denominators are allocatable: 7.8 vCPU and 30 GiB per node.
  assert.equal(out.summary.cpuAllocatable, 23.4);
  assert.equal(out.summary.memGiBAllocatable, 90);

  assert.equal(out.nodes.length, 3);
  assert.equal(out.nodes[0].monthlyUsd, 367.92);
  assert.equal(out.nodes[0].monthlyCu, 408.8);
  assert.equal(out.nodes[0].rateSource, 'catalog');
  assert.equal(out.nodes[0].zone, 'us-east-1a');
  assert.equal(out.nodes[0].ready, true);
});

test('the CU meter is published beside the USD one, with the divergence stated', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node({ name: 'n1' }), node({ name: 'n2' }), node({ name: 'n3' })]],
    ['/api/v1/pods', []],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  // 1226.4 CU x $1.08 = $1324.51, which is 20% above the authoritative $1103.76. The UI shows
  // both meters, so the gap has to be on the wire rather than left for an operator to find by
  // multiplying two numbers on the screen.
  assert.equal(out.summary.cuRateEur, 1.0);
  assert.equal(out.summary.cuRateUsd, 1.08);
  assert.equal(out.summary.monthlyUsdOnCuMeter, 1324.51);
  assert.equal(out.summary.modelDivergencePct, 20);
  assert.equal(out.nodes[0].modelDivergencePct, 20);
});

test('a cluster with no priced node reports no divergence rather than 0%', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node({ name: 'n1', instanceType: null, cpu: '', memory: '' })]],
    ['/api/v1/pods', []],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.monthlyUsd, 0, 'nothing could be priced');
  assert.equal(out.summary.monthlyUsdOnCuMeter, 0);
  assert.equal(out.summary.modelDivergencePct, null, '0% would claim the two meters agree');
});

// --- the two failure modes that must never produce a number ---------------------------------

test('an unpriced node makes the total a FLOOR, and says which node and why', () => {
  const priced = priceNodes([
    node({ name: 'n1' }),
    // A type the catalog does not carry, whose shape IS readable: priced as derived.
    node({ name: 'n2', instanceType: 'm6i.2xlarge' }),
    // No instance-type label and no usable capacity: unpriceable, and not guessed.
    node({ name: 'n3', instanceType: null, cpu: '0', memory: '0' })
  ], DEFAULT_CATALOG);

  assert.equal(priced.unpricedNodes, 1);
  const byName = Object.fromEntries(priced.rows.map(r => [r.name, r]));
  assert.equal(byName.n1.rateSource, 'catalog');
  assert.equal(byName.n2.rateSource, 'derived');
  assert.equal(byName.n3.monthlyUsd, null, 'no dollar figure for a machine nobody could size');
  assert.equal(byName.n3.unpricedReason, 'NO_INSTANCE_TYPE_LABEL');
  assert.equal(byName.n3.vCpu, null, 'the unreadable shape is reported as unread, not as 0');

  // The total is the two priced nodes and nothing else — real, but a lower bound.
  assert.equal(priced.monthlyUsd, 735.84);
});

test('collect(): a failed node read makes every money field null, never 0', async () => {
  const forbidden = Object.assign(new Error('nodes is forbidden'), { status: 403 });
  const listFn = fakeListFn([
    ['/api/v1/nodes', forbidden],
    ['/api/v1/pods', [pod()]],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.verdict, 'unknown');
  assert.equal(out.summary.monthlyUsd, null);
  assert.equal(out.summary.hourlyUsd, null);
  assert.equal(out.summary.monthlyCu, null);
  assert.equal(out.summary.monthlyEur, null);
  assert.equal(out.summary.requestedCpuPct, null, 'a percentage of an unread denominator is not 0%');
  assert.deepEqual(out.nodes, []);
  assert.deepEqual(out.attribution, [], 'attribution needs the cluster total it divides');
  assert.ok(out.summary.unavailable.includes('nodes'));

  // Canary: a `|| 0` anywhere on that path prints a free cluster.
  assert.notEqual(out.summary.monthlyUsd, 0, 'canary: 0 would read as "this cluster costs nothing"');
});

test('collect(): a failed pod read leaves cost intact but reports no attribution', async () => {
  const forbidden = Object.assign(new Error('pods is forbidden'), { status: 403 });
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node()]],
    ['/api/v1/pods', forbidden],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.monthlyUsd, 367.92, 'the node cost does not depend on the pod list');
  assert.equal(out.summary.requestedCpu, null);
  assert.equal(out.summary.requestedCpuPct, null);
  assert.deepEqual(out.attribution, []);
  assert.equal(out.unallocated.sharePct, null, 'not 100% idle — we did not read what was requested');
  assert.ok(out.summary.unavailable.includes('pods'));
});

// --- utilization uses the right denominator -------------------------------------------------

test('requested percentages divide by allocatable, not by capacity', async () => {
  // One node: 8 vCPU capacity, 7.8 allocatable. Two pods requesting 3.9 vCPU total = 50% of
  // allocatable, but only 48.8% of capacity.
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node()]],
    ['/api/v1/pods', [
      pod({ name: 'a', cpu: '2900m', memory: '15Gi' }),
      pod({ name: 'b', cpu: '1000m', memory: '0' })
    ]],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.requestedCpu, 3.9);
  assert.equal(out.summary.requestedCpuPct, 50);
  assert.equal(out.summary.requestedMemPct, 50);
  // Canary: dividing by capacity understates a full cluster's load.
  assert.equal(Math.round((3.9 / 8) * 1000) / 10, 48.8, 'canary: the capacity denominator reads 48.8%');
});

test('a Succeeded pod holds no reservation and is not attributed any spend', () => {
  const { byNamespace, cpuTotal } = requestsByNamespace([
    pod({ name: 'live', namespace: 'app', phase: 'Running', cpu: '1' }),
    pod({ name: 'done', namespace: 'batch', phase: 'Succeeded', cpu: '4' })
  ]);
  assert.equal(cpuTotal, 1);
  assert.equal(byNamespace.has('batch'), false, 'a finished pod must not be billed');
});

test('metrics-server answering for only some nodes yields null usage, not a partial average', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node({ name: 'n1' }), node({ name: 'n2' })]],
    ['/api/v1/pods', []],
    ['/apis/metrics.k8s.io/v1beta1/nodes', [
      { metadata: { name: 'n1' }, usage: { cpu: '1', memory: '4Gi' } }
      // n2 is missing — a partial answer.
    ]]
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });
  assert.equal(out.summary.cpuUtilizationPct, null);
  assert.equal(out.summary.usageSource, 'metrics-server:partial');
});

// --- attribution ----------------------------------------------------------------------------

test('attribution: namespace shares plus the unallocated remainder sum to the cluster total', () => {
  const { byNamespace, cpuTotal, memGiBTotal } = requestsByNamespace([
    pod({ namespace: 'app', cpu: '4', memory: '10Gi' }),
    pod({ namespace: 'kyma-system', cpu: '2', memory: '5Gi' })
  ]);
  const out = attribute(byNamespace, { cpuTotal, memGiBTotal }, { cpuAllocatable: 20, memGiBAllocatable: 60 }, 1000);

  const app = out.namespaces.find(n => n.namespace === 'app');
  // cpu 4/20 = 20%, mem 10/60 = 16.667% -> mean 18.333% -> 18.3 at one decimal.
  assert.equal(app.cpuSharePct, 20);
  assert.equal(app.memSharePct, 16.7);
  assert.equal(app.sharePct, 18.3);
  assert.equal(app.monthlyUsd, 183.33);

  const sum = out.namespaces.reduce((n, r) => n + r.sharePct, 0) + out.unallocated.sharePct;
  assert.equal(Math.round(sum), 100, 'the rows plus the idle remainder are the whole cluster');
  assert.ok(out.unallocated.monthlyUsd > 0, 'idle capacity has a cost and it belongs to nobody');

  // Canary: normalising shares to the requested subtotal instead charges tenants for idle
  // nodes — `app` would carry 66.7% of the bill on a cluster that is 30% requested.
  const requestedOnly = (4 / 6 + 10 / 15) / 2 * 100;
  assert.equal(Math.round(requestedOnly * 10) / 10, 66.7, 'canary: the inflated share a requests-only basis gives');
});

test('attribution: an overcommitted cluster reports 0% idle, never a negative remainder', () => {
  const { byNamespace, cpuTotal, memGiBTotal } = requestsByNamespace([
    pod({ namespace: 'greedy', cpu: '40', memory: '200Gi' })
  ]);
  const out = attribute(byNamespace, { cpuTotal, memGiBTotal }, { cpuAllocatable: 20, memGiBAllocatable: 60 }, 1000);
  assert.equal(out.unallocated.sharePct, 0);
  assert.equal(out.unallocated.monthlyUsd, 0);
});

// --- billing edges --------------------------------------------------------------------------

test('a NotReady node still bills; a terminating node does not', () => {
  const priced = priceNodes([
    node({ name: 'broken', ready: false }),
    node({ name: 'going-away', deletionTimestamp: '2026-09-21T00:00:00Z' })
  ], DEFAULT_CATALOG);

  assert.equal(priced.rows.length, 1, 'a node being deleted must not be double-counted with its replacement');
  assert.equal(priced.rows[0].name, 'broken');
  assert.equal(priced.rows[0].ready, false);
  assert.equal(priced.monthlyUsd, 367.92, 'a broken node is still on the invoice');
  assert.equal(isBillable(node({ deletionTimestamp: 'x' })), false);
});

test('billableShape reads capacity and refuses to invent one that is missing', () => {
  assert.deepEqual(billableShape(node({ cpu: '8', memory: '32Gi' })), { cpu: 8, memGiB: 32 });
  assert.deepEqual(billableShape({ status: {} }), { cpu: null, memGiB: null });
});

// --- the simulator's menu comes from the server ---------------------------------------------

test('hyperscalerCatalog offers every provider with prices already computed server-side', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node()]],
    ['/api/v1/pods', []],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.deepEqual(Object.keys(out.hyperscalerCatalog).sort(), ['aws', 'azure', 'gcp']);
  const m5 = out.hyperscalerCatalog.aws.find(e => e.instanceType === 'm5.2xlarge');
  assert.equal(m5.monthlyUsd, 367.92);
  assert.equal(m5.monthlyCu, 408.8);
  assert.equal(m5.cpu, 8);
  // The browser must never need a rate card of its own — every figure it draws is here.
  for (const family of Object.values(out.hyperscalerCatalog)) {
    for (const entry of family) {
      assert.ok(entry.hourlyUsd > 0, `${entry.instanceType} has no price`);
      assert.ok(entry.monthlyCu > 0, `${entry.instanceType} has no CU figure`);
    }
  }
  assert.equal(catalogForSimulator(DEFAULT_CATALOG).gcp.length, 2);
});

// --- one currency on screen, and a CU meter that explains itself -------------------------------

/**
 * The tab shows two meters and exactly one currency.
 *
 * Both meters stay, because they answer different questions: the dollar figure is the hyperscaler
 * bill an operator recognises, and the Capacity Unit figure is what SAP actually bills under CPEA.
 * Neither is reconciled into the other — they value the same hardware ~20% apart, and an operator
 * shown both plus a second currency has four numbers for one machine and no way to know which one
 * their next decision depends on. USD is authoritative for this feature, so USD is the only money
 * rendered; the CU meter is stated in CU and never converted for display.
 */
test('the summary publishes the CU meter definition, so the tab does not restate it', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node({ name: 'n1' })]],
    ['/api/v1/pods', []],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.cuUnitCpu, 2, 'the normalized unit is 2 vCPU');
  assert.equal(out.summary.cuUnitMemGiB, 8, 'the normalized unit is 8 GiB');
  assert.equal(out.summary.cuHourlyPerUnit, 0.14, 'a normalized unit bills 0.14 CU per hour');
  assert.equal(typeof out.summary.cuRateUsd, 'number', 'the per-CU dollar rate is what makes the meter comparable');
  // The tab renders "a 2 vCPU / 8 GiB node-hour at 0.14 CU, billed at $1.08 per CU" from these four
  // fields. Hardcoding them in the UI is how the explanation and the arithmetic drift apart.
});

