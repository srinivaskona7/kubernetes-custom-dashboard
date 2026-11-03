
/**
 * Cost provenance and the qualifier that must reach every dollar figure.
 *
 * The defect these pin: the tab printed "$4,102 / month" whose rate card had no region and no
 * date, whose derived rates were not disclosed at all, whose `≥` prefix reached two tiles and not
 * the rows underneath them, and whose idle row absorbed the spend of any namespace it could not
 * weigh. Each of those is a separate claim to an operator, so each has its own test.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import _cost from '../collectors/cost.js';
const { collect, attribute, priceNodes } = _cost;
import _cost_catalog2 from '../collectors/cost-catalog.js';

const __dirname = import.meta.dirname;
const {
  CATALOG_AS_OF,
  CATALOG_REGION,
  CATALOG_REGION_NOTE,
  DEFAULT_CATALOG,
  loadCatalog
} = _cost_catalog2;

function node({ name = 'n1', instanceType = 'm5.2xlarge', cpu = '8', memory = '32Gi' } = {}) {
  const labels = { 'topology.kubernetes.io/zone': 'us-east-1a' };
  if (instanceType) labels['node.kubernetes.io/instance-type'] = instanceType;
  return {
    metadata: { name, labels },
    spec: { providerID: 'aws:///us-east-1a/i-0abc' },
    status: {
      capacity: { cpu, memory, pods: '110' },
      allocatable: { cpu, memory, pods: '110' },
      conditions: [{ type: 'Ready', status: 'True' }]
    }
  };
}

function fakeListFn(byPath) {
  return async ({ path: p }) => {
    for (const [match, result] of byPath) {
      if (p.startsWith(match)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`unexpected path in test: ${p}`);
  };
}

const NO_METRICS = [['/apis/metrics.k8s.io', Object.assign(new Error('not found'), { status: 404 })]];

// --- provenance ------------------------------------------------------------------------------

test('the built-in rate card publishes its absent region and its edit date, not just "built-in"', () => {
  const meta = loadCatalog({});
  assert.equal(meta.source, 'built-in');
  assert.equal(meta.region, null, 'the built-in list has no region dimension; null says so');
  assert.equal(meta.regionNote, CATALOG_REGION_NOTE);
  assert.match(meta.asOf, /^\d{4}-\d{2}-\d{2}$/, 'a plain ISO date an operator can judge the age of');
  assert.equal(meta.asOf, CATALOG_AS_OF);
  assert.match(meta.asOfBasis, /not a market quote/, 'the date must not read as a price quote');
  assert.equal(CATALOG_REGION, null);
});

test('the cost payload carries region and asOf, so a price on screen can be dated', async () => {
  const listFn = fakeListFn([['/api/v1/nodes', [node()]], ['/api/v1/pods', []], ...NO_METRICS]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.rateCard, 'built-in');
  assert.equal(out.summary.rateCardRegion, null);
  assert.equal(out.summary.rateCardRegionNote, CATALOG_REGION_NOTE);
  assert.equal(out.summary.rateCardAsOf, CATALOG_AS_OF);
  assert.match(out.summary.rateCardAsOfBasis, /repository/);
});

test('an override file may state its own region and date, and __meta is never mistaken for a provider', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rates-'));
  const file = path.join(dir, 'rates.json');
  fs.writeFileSync(file, JSON.stringify({
    __meta: { region: 'eu-central-1', asOf: '2026-08-01' },
    aws: { 'm5.2xlarge': { cpu: 8, memGiB: 32, normalizedUnits: 4, totalHourlyUsd: 0.6 } }
  }));

  const meta = loadCatalog({ FLEET_COST_CATALOG: file });
  assert.equal(meta.region, 'eu-central-1');
  assert.equal(meta.asOf, '2026-08-01');
  assert.deepEqual(Object.keys(meta.catalog), ['aws'], '__meta must not survive as a hyperscaler');
});

test('an override file that states no date reports none rather than inheriting the built-in one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rates-'));
  const file = path.join(dir, 'rates.json');
  fs.writeFileSync(file, JSON.stringify({ aws: { 'm5.2xlarge': { cpu: 8, memGiB: 32, totalHourlyUsd: 0.6 } } }));

  const meta = loadCatalog({ FLEET_COST_CATALOG: file });
  assert.equal(meta.asOf, null);
  assert.equal(meta.region, null);
  assert.notEqual(meta.asOf, CATALOG_AS_OF);
});

// --- the qualifier ---------------------------------------------------------------------------

test('a derived rate is disclosed as an approximation, separately from a floor', () => {
  const priced = priceNodes([node({ instanceType: 'not.in.catalog' })], DEFAULT_CATALOG);
  assert.equal(priced.derivedRateNodes, 1);
  assert.equal(priced.unpricedNodes, 0, 'the shape was readable, so it is priced — just not from a stated rate');
});

test('a cluster of derived-rate nodes is qualified "approximate", never left looking exact', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [node({ instanceType: 'not.in.catalog' })]],
    ['/api/v1/pods', []],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.derivedRateNodes, 1);
  assert.equal(out.summary.costIsApproximate, true);
  assert.equal(out.summary.costQualifier, 'approximate');
  assert.equal(out.summary.costIsFloor, false, 'no bound is claimed: the derived rate can run high or low');
  assert.ok(out.summary.monthlyUsd > 0, 'the figure is still produced — approximate is not unknown');
});

test('unpriced and derived together claim neither an exact figure nor a bound', async () => {
  const listFn = fakeListFn([
    ['/api/v1/nodes', [
      node({ instanceType: 'not.in.catalog' }),
      node({ name: 'n2', instanceType: 'mystery', cpu: '0', memory: '0' })
    ]],
    ['/api/v1/pods', []],
    ...NO_METRICS
  ]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });

  assert.equal(out.summary.unpricedNodes, 1);
  assert.equal(out.summary.derivedRateNodes, 1);
  assert.equal(out.summary.costQualifier, 'approximate-floor');
});

test('a fully catalogued cluster is qualified "exact"', async () => {
  const listFn = fakeListFn([['/api/v1/nodes', [node()]], ['/api/v1/pods', []], ...NO_METRICS]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, env: {} });
  assert.equal(out.summary.costQualifier, 'exact');
  assert.equal(out.summary.costIsApproximate, false);
});

// --- a null share is unknown, not idle -------------------------------------------------------

test('a namespace with no computable share is counted, not swept into the idle row', () => {
  const byNamespace = new Map([['app', { namespace: 'app', cpuRequested: 1, memGiBRequested: 4, pods: 2 }]]);
  // Allocatable 0 on both axes: the share cannot be computed for any namespace.
  const out = attribute(byNamespace, {}, { cpuAllocatable: 0, memGiBAllocatable: 0 }, 1000);

  assert.equal(out.namespaces[0].sharePct, null);
  assert.equal(out.unattributedNamespaces, 1);
  assert.equal(out.unallocated.sharePct, null, '100 minus an incomplete sum is not the idle share');
  assert.equal(out.unallocated.monthlyUsd, null, 'and it is certainly not $1,000 of nobody-is-paying');
});

test('with every share known the idle remainder is still reported exactly as before', () => {
  const byNamespace = new Map([['app', { namespace: 'app', cpuRequested: 10, memGiBRequested: 30, pods: 2 }]]);
  const out = attribute(byNamespace, {}, { cpuAllocatable: 20, memGiBAllocatable: 60 }, 1000);

  assert.equal(out.namespaces[0].sharePct, 50);
  assert.equal(out.unattributedNamespaces, 0);
  assert.equal(out.unallocated.sharePct, 50);
  assert.equal(out.unallocated.monthlyUsd, 500);
});

// --- the rendering guard ---------------------------------------------------------------------

