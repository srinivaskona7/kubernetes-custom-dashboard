
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import _cost_catalog from '../collectors/cost-catalog.js';
const {
  HOURS_PER_MONTH,
  CU_RATE_USD,
  DEFAULT_CATALOG,
  loadCatalog,
  providerOf,
  normalizedUnitsFor,
  calculateCapacityUnits,
  getMachineRate
} = _cost_catalog;

// --- the rate card loads at all -------------------------------------------------------------

test('the module is CommonJS and every catalog entry prices a real shape', () => {
  // `export const` in this tree would throw on require; that this file ran at all proves it.
  for (const [provider, family] of Object.entries(DEFAULT_CATALOG)) {
    for (const [type, entry] of Object.entries(family)) {
      assert.ok(entry.cpu > 0, `${provider}/${type} has no cpu`);
      assert.ok(entry.memGiB > 0, `${provider}/${type} has no memory`);
      assert.ok(entry.totalHourlyUsd > 0, `${provider}/${type} has no authoritative hourly rate`);
    }
  }
});

// --- the spec's worked example --------------------------------------------------------------

test('3 x m5.2xlarge: USD is authoritative, EUR derives from it, CU is the second meter', () => {
  const rate = getMachineRate('m5.2xlarge', 'aws:///us-east-1a/i-0abc');
  assert.equal(rate.source, 'catalog');
  assert.equal(rate.provider, 'aws');

  // One node, as the catalog states it: 0.504/hr * 730.
  assert.equal(rate.hourlyUsd, 0.504);
  assert.equal(rate.monthlyUsd, 367.92);
  assert.equal(rate.nodeHourlyUsd, 0.384, 'the hyperscaler list price is kept visible');
  assert.equal(rate.sapFeeHourlyUsd, 0.12, 'so is the surcharge, which is not a flat percentage');

  // Three of them.
  assert.equal(round(rate.hourlyUsd * 3, 4), 1.512);
  assert.equal(round(rate.monthlyUsd * 3, 2), 1103.76);

  // The CU meter, computed independently: 4 units * 0.14 * 730.
  assert.equal(rate.normalizedUnits, 4);
  assert.equal(rate.hourlyCu, 0.56);
  assert.equal(rate.monthlyCu, 408.8);
  assert.equal(round(rate.monthlyCu * 3, 1), 1226.4, "the spec's ~1,226 CU/mo banner figure");

  // EUR comes from USD, not from CU. Had it come from CU it would read 408.80 EUR.
  assert.equal(rate.monthlyEur, 340.67);
  assert.notEqual(rate.monthlyEur, rate.monthlyCu);
});

// --- the two meters diverge, and that is pinned so nobody "fixes" it silently ----------------

test('the CU meter and the USD figure differ by ~20% for every catalog entry, and say so', () => {
  for (const [provider, family] of Object.entries(DEFAULT_CATALOG)) {
    for (const type of Object.keys(family)) {
      const rate = getMachineRate(type);
      const cuAsUsd = rate.monthlyCu * CU_RATE_USD;
      assert.notEqual(
        round(cuAsUsd, 2), rate.monthlyUsd,
        `${provider}/${type}: if these ever agree the catalog changed and the UI copy must too`
      );
      assert.ok(rate.modelDivergencePct !== null, `${provider}/${type} must disclose the gap`);
      // Sanity: the disclosed percentage really is the gap, not a decorative number.
      assert.equal(rate.modelDivergencePct, round(((cuAsUsd - rate.monthlyUsd) / rate.monthlyUsd) * 100, 1));
    }
  }

  // Canary: the naive reading — treating CU x 1.08 as "the monthly bill in dollars" — is what
  // produces two contradictory totals on one card. For m5.2xlarge it overstates by $73.58.
  const m5 = getMachineRate('m5.2xlarge');
  assert.equal(round(m5.monthlyCu * CU_RATE_USD - m5.monthlyUsd, 2), 73.58);
  assert.ok(m5.modelDivergencePct > 19 && m5.modelDivergencePct < 21);
});

// --- normalizedUnits: the mean rule the catalog's own values imply ---------------------------

test('normalizedUnits follows the mean rule, which is the only rule fitting c5 and r5', () => {
  // 8 vCPU / 16 GiB -> cpu says 4 units, memory says 2. The catalog says 3.
  assert.equal(DEFAULT_CATALOG.aws['c5.2xlarge'].normalizedUnits, 3);
  assert.equal(normalizedUnitsFor(8, 16), 3);
  // 8 vCPU / 64 GiB -> cpu says 4, memory says 8. The catalog says 6.
  assert.equal(DEFAULT_CATALOG.aws['r5.2xlarge'].normalizedUnits, 6);
  assert.equal(normalizedUnitsFor(8, 64), 6);
  // Canary: a CPU-only or memory-only rule contradicts the catalog it is supposed to explain.
  assert.notEqual(8 / 2, DEFAULT_CATALOG.aws['c5.2xlarge'].normalizedUnits, 'canary: cpu-only rule gives 4');
  assert.notEqual(16 / 8, DEFAULT_CATALOG.aws['c5.2xlarge'].normalizedUnits, 'canary: memory-only rule gives 2');

  // Not rounded to an integer: a 4/8 node is 1.5 units and rounding up overstates it by a third.
  assert.equal(normalizedUnitsFor(4, 8), 1.5);
  assert.equal(normalizedUnitsFor(0, 8), null);
});

test('calculateCapacityUnits is the CU meter only and never names a USD or a plain EUR figure', () => {
  const cu = calculateCapacityUnits(8, 32);
  assert.equal(cu.normalizedUnits, 4);
  assert.equal(cu.monthlyCu, 408.8);
  assert.equal(cu.monthlyEurOnCuMeter, 408.8);
  assert.equal(cu.monthlyUsd, undefined, 'the CU meter must not publish a dollar total');
  assert.equal(cu.monthlyEur, undefined, 'the authoritative EUR comes from USD, not from here');
  assert.equal(calculateCapacityUnits(0, 0), null);
});

// --- provider routing -----------------------------------------------------------------------

test('providerOf reads spec.providerID, including gce:// for GCP', () => {
  assert.equal(providerOf('aws:///eu-central-1a/i-0abc'), 'aws');
  assert.equal(providerOf('azure:///subscriptions/x/vm/y'), 'azure');
  assert.equal(providerOf('gce://project/zone/instance'), 'gcp');
  assert.equal(providerOf(undefined), null, 'an absent providerID is unknown, not aws');
  assert.equal(providerOf('openstack:///x'), null);
});

test('an Azure or GCP type prices from its own family and leaves the fee split absent, not zero', () => {
  const azure = getMachineRate('Standard_D8_v3', 'azure:///subscriptions/x');
  assert.equal(azure.provider, 'azure');
  assert.equal(azure.monthlyUsd, 365);
  assert.equal(azure.sapFeeHourlyUsd, null, 'the source does not break it out — null, never 0');
  assert.equal(azure.nodeHourlyUsd, null);

  const gcp = getMachineRate('n2-standard-8', 'gce://p/z/i');
  assert.equal(gcp.provider, 'gcp');
  assert.equal(gcp.monthlyUsd, 372.3);

  // No providerID: every family is searched, since these names do not collide.
  assert.equal(getMachineRate('n2-standard-8').provider, 'gcp');
});

// --- the fallback, and the refusal ----------------------------------------------------------

test('an uncatalogued type with a known shape is priced as derived, and labelled so', () => {
  // m6i.2xlarge is a real shape this catalog does not carry: 8 vCPU / 32 GiB.
  const rate = getMachineRate('m6i.2xlarge', 'aws:///us-east-1a/i-0abc', { cpu: 8, memGiB: 32 });
  assert.equal(rate.source, 'derived');
  assert.equal(rate.normalizedUnits, 4);
  assert.equal(rate.hourlyUsd, 0.504, '4 units x $0.126 per unit-hour, the m5 family reference');
  assert.equal(rate.monthlyCu, 408.8, 'the CU meter needs no catalog entry at all');
  assert.equal(rate.instanceType, 'm6i.2xlarge');
});

test('an uncatalogued type with an unknown shape returns null — no dollar figure is invented', () => {
  assert.equal(getMachineRate('mystery.9xlarge', 'aws:///x'), null);
  assert.equal(getMachineRate('mystery.9xlarge', 'aws:///x', { cpu: 0, memGiB: 0 }), null);
  assert.equal(getMachineRate(undefined, undefined, undefined), null);
  // 'standard' is what topology.js substitutes when the instance-type label is missing entirely;
  // it must not accidentally match a catalog entry or be priced without a shape.
  assert.equal(getMachineRate('standard', 'aws:///x'), null);

  // Canary: the tempting fallback — price it off the m5 reference anyway — invents $367.92/mo
  // for a machine whose size nobody read.
  const invented = 4 * 0.126 * HOURS_PER_MONTH;
  assert.equal(round(invented, 2), 367.92, 'canary: this is the number a shape-less guess would print');
});

// --- the override ---------------------------------------------------------------------------

test('FLEET_COST_CATALOG replaces the built-in rates, and a broken file throws rather than silently defaulting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cost-'));
  const good = path.join(dir, 'rates.json');
  fs.writeFileSync(good, JSON.stringify({
    aws: { 'm5.2xlarge': { cpu: 8, memGiB: 32, normalizedUnits: 4, totalHourlyUsd: 0.25 } }
  }));

  assert.equal(loadCatalog({}).source, 'built-in');
  const loaded = loadCatalog({ FLEET_COST_CATALOG: good });
  assert.equal(loaded.source, `file:${good}`);

  const rate = getMachineRate('m5.2xlarge', 'aws:///x', null, { catalog: loaded.catalog });
  assert.equal(rate.monthlyUsd, 182.5, 'the operator\'s own contracted rate, not the built-in one');

  const bad = path.join(dir, 'broken.json');
  fs.writeFileSync(bad, '{ not json');
  assert.throws(() => loadCatalog({ FLEET_COST_CATALOG: bad }), /JSON|Unexpected/,
    'a malformed override must fail loudly — defaulting behind the operator\'s back is worse');
  assert.throws(() => loadCatalog({ FLEET_COST_CATALOG: path.join(dir, 'absent.json') }), /ENOENT/);

  fs.rmSync(dir, { recursive: true, force: true });
});

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
