/**
 * The Kubernetes quantity parser.
 *
 * The regression these pin is measured, not hypothetical. `calico-typha` on platform-sbx
 * declares `limits.memory: 4194304k` — 4.19 GB. The parser `workloads.js` used built its unit
 * table with a capital `K` and no lowercase `k`, then fell back to the bare number, so it read
 * 4194304 **bytes**: a 1000x understatement that turned a container at ~1.2% of its memory limit
 * into one reported at 1249% of it.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _quantity from '../collectors/quantity.js';
const { parseQuantity, parseCpu, parseMemory } = _quantity;
import metrics from '../collectors/metrics.js';
import health from '../collectors/health.js';

test('the lowercase k Kubernetes actually uses is decimal kilo, not the bare number', () => {
  // The exact live values that exposed the bug.
  assert.equal(parseMemory('4194304k'), 4_194_304_000);
  assert.equal(parseMemory('262144k'), 262_144_000);
  assert.equal(parseMemory('11500k'), 11_500_000);
});

test('the two spellings of calico-typha’s real limit agree', () => {
  // 4194304k and 4000Mi are the same quantity written two ways; the pod spec contains both.
  // Within a rounding hair of each other is the most that can be asserted: 4000Mi is
  // 4194304000 exactly only because 4194304 = 4000 * 1024^2 / 1000.
  assert.equal(parseMemory('4194304k'), parseMemory('4000Mi') * (1000 / 1024) ** 0);
  assert.equal(parseMemory('4000Mi'), 4000 * 1024 ** 2);
});

test('binary and decimal suffixes are different numbers and both are known', () => {
  assert.equal(parseMemory('1Ki'), 1024);
  assert.equal(parseMemory('1Mi'), 1024 ** 2);
  assert.equal(parseMemory('1Gi'), 1024 ** 3);
  assert.equal(parseMemory('1Ti'), 1024 ** 4);
  assert.equal(parseMemory('1Pi'), 1024 ** 5);
  assert.equal(parseMemory('1Ei'), 1024 ** 6);
  assert.equal(parseMemory('1k'), 1e3);
  assert.equal(parseMemory('1M'), 1e6);
  assert.equal(parseMemory('1G'), 1e9);
  assert.equal(parseMemory('1T'), 1e12);
  assert.equal(parseMemory('1P'), 1e15);
  assert.equal(parseMemory('1E'), 1e18);
});

test('a suffix that is a prefix of another one is not confused with it', () => {
  // Ei/E, Pi/P and Mi/M would collide under endsWith, and which one won would depend on the
  // order of a literal. Exact lookup makes the order irrelevant.
  assert.notEqual(parseMemory('1Ei'), parseMemory('1E'));
  assert.notEqual(parseMemory('1Pi'), parseMemory('1P'));
  assert.notEqual(parseMemory('1Mi'), parseMemory('1M'));
  assert.notEqual(parseMemory('1Ki'), parseMemory('1k'));
});

test('milli and mega differ only by case and are a billion apart', () => {
  assert.equal(parseQuantity('1m'), 1e-3);
  assert.equal(parseQuantity('1M'), 1e6);
});

test('a capital K is not a Kubernetes suffix and is refused rather than guessed', () => {
  // The old table had K: 1e3. Kubernetes has no capital-K suffix, so a value spelled that way
  // came from somewhere unexpected and should not be silently converted.
  assert.equal(parseQuantity('1K'), null);
});

test('an unrecognised unit refuses instead of becoming the bare number', () => {
  // This is the half of the old bug that made it invisible: `return parseFloat(s) || 0`
  // understated a Ti value by twelve orders of magnitude and reported it confidently.
  assert.equal(parseQuantity('5Zi'), null);
  assert.equal(parseQuantity('5bytes'), null);
  assert.equal(parseQuantity('1Gib'), null);
});

test('a bare number is bytes, and scientific notation is accepted', () => {
  assert.equal(parseMemory('1024'), 1024);
  assert.equal(parseMemory('128e6'), 128e6);
  assert.equal(parseMemory('1.5Gi'), 1.5 * 1024 ** 3);
});

test('absent and malformed both read as unknown, never as a number', () => {
  for (const bad of [undefined, null, '', '   ', 'abc', 'Gi', '1 Gi', '--5', '5.5.5']) {
    assert.equal(parseMemory(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('CPU arrives in four spellings and comes back in cores', () => {
  assert.equal(parseCpu('2'), 2);
  assert.equal(parseCpu('320m'), 0.32);
  assert.equal(parseCpu('1500000000n'), 1.5);
  assert.equal(parseCpu('2000u'), 0.002);
});

test('CPU defaults to zero cores when absent, because an absent request reserves nothing', () => {
  assert.equal(parseCpu(undefined), 0);
  assert.equal(parseCpu(null), 0);
  assert.equal(parseCpu('nonsense'), 0);
});

test('metrics.parseMemory keeps its zero-means-absent contract for the wire', () => {
  // workloads.js sums these and its payload already spells "no limit set" as 0. Kubernetes
  // rejects a literal zero limit, so downstream the encoding stays unambiguous.
  assert.equal(metrics.parseMemory(undefined), 0);
  assert.equal(metrics.parseMemory(null), 0);
  assert.equal(metrics.parseMemory('5Zi'), 0);
  assert.equal(metrics.parseMemory('4194304k'), 4_194_304_000);
});

test('health and metrics no longer disagree about the same string', () => {
  // The whole point of the shared module: /workloads and /capacity read the same pod spec, and
  // used to parse it with two different functions. Every value they can be handed must agree.
  for (const q of ['4194304k', '262144k', '11500k', '4000Mi', '1Gi', '32612204Ki', '128e6', '1024']) {
    assert.equal(health.parseMemory(q), metrics.parseMemory(q), `disagreement on ${q}`);
    assert.equal(health.parseCpu(q), metrics.parseCpu(q), `cpu disagreement on ${q}`);
  }
});

test('health.parseMemory still reports unknown as null so its callers can choose', () => {
  assert.equal(health.parseMemory(undefined), null);
  assert.equal(health.parseMemory('5Zi'), null);
});

test('the pressure ratio that was wrong is now right', () => {
  // 52396032 bytes of usage against calico-typha's real 4194304k limit.
  const usage = 52_396_032;
  const limit = parseMemory('4194304k');
  const pct = (usage / limit) * 100;
  assert.ok(pct < 2, `expected roughly 1.2%, got ${pct.toFixed(1)}%`);
});
