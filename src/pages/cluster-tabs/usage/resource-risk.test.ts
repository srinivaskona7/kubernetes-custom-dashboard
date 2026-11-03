/**
 * The resource risk classifier.
 *
 * These pin the distinction the Top pods table previously got wrong: CPU above a request is normal
 * and survivable, memory near a limit is fatal, and the two must never produce the same verdict.
 * The edge cases below are the ones the specification did not cover and which each have exactly one
 * defensible answer — an unset basis (`0` or `null` on the wire), an inverted limit, and every
 * `>=` boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  CPU_THROTTLE_FRACTION,
  CPU_THROTTLE_NOTE,
  MEMORY_THRESHOLD_NOTE,
  assessResourceRisk,
  riskFacts
} from './resource-risk';
import { MEMORY_CRITICAL_FRACTION, MEMORY_NEAR_FRACTION } from './utilization-model';

const MiB = 1024 ** 2;

describe('memory risk', () => {
  const limit = 100 * MiB;

  it('calls the top of the limit an OOMKill risk and says what the kernel does', () => {
    const a = assessResourceRisk('memory', 95 * MiB, 50 * MiB, limit);
    expect(a.level).toBe('critical');
    expect(a.badge).toBe('OOMKill Risk');
    expect(a.impactText).toMatch(/137/);
    expect(a.impactText).toMatch(/incompressible/);
    expect(a.recommendation).toMatch(/resources\.limits\.memory/);
  });

  it('warns from 80% of the limit', () => {
    const a = assessResourceRisk('memory', 85 * MiB, 50 * MiB, limit);
    expect(a.level).toBe('warning');
    expect(a.badge).toBe('High Memory');
  });

  it('includes both thresholds themselves — the boundaries are >=, not >', () => {
    expect(assessResourceRisk('memory', MEMORY_CRITICAL_FRACTION * limit, null, limit).level).toBe('critical');
    expect(assessResourceRisk('memory', MEMORY_NEAR_FRACTION * limit, null, limit).level).toBe('warning');
    // One byte below each boundary falls to the tier under it.
    expect(assessResourceRisk('memory', MEMORY_CRITICAL_FRACTION * limit - 1, null, limit).level).toBe('warning');
    expect(assessResourceRisk('memory', MEMORY_NEAR_FRACTION * limit - 1, null, limit).level).toBe('normal');
  });

  it('is normal above the request while far from the limit', () => {
    // Burstable QoS working as designed. The only hazard left is node-level eviction, and this tab
    // has no node pressure reading to support raising it.
    const a = assessResourceRisk('memory', 60 * MiB, 50 * MiB, limit);
    expect(a.level).toBe('normal');
  });

  it('flags above-request only when no limit caps it', () => {
    const a = assessResourceRisk('memory', 60 * MiB, 50 * MiB, null);
    expect(a.level).toBe('info');
    expect(a.badge).toBe('Above Request');
    // The hazard without a limit is eviction, not an OOMKill against its own limit.
    expect(a.impactText).toMatch(/evict/i);
    expect(a.recommendation).toMatch(/resources\.limits\.memory/);
  });

  it('never claims an OOMKill has happened', () => {
    const a = assessResourceRisk('memory', 99 * MiB, null, limit);
    expect(a.impactText).not.toMatch(/was killed|has been killed|OOMKilled/);
  });
});

describe('cpu risk', () => {
  it('names throttling at the limit and rules out termination', () => {
    const a = assessResourceRisk('cpu', 0.96, 0.2, 1);
    expect(a.level).toBe('warning');
    expect(a.badge).toBe('CPU Throttled');
    expect(a.impactText).toMatch(/not terminated/);
    expect(a.impactText).toMatch(/latency/i);
    expect(a.recommendation).toMatch(/resources\.limits\.cpu/);
  });

  it('includes the throttle threshold itself', () => {
    expect(assessResourceRisk('cpu', CPU_THROTTLE_FRACTION, null, 1).level).toBe('warning');
    expect(assessResourceRisk('cpu', CPU_THROTTLE_FRACTION - 0.01, null, 1).level).toBe('normal');
  });

  it('calls 222% of a CPU request bursting, not a warning', () => {
    // The defect this module exists for: the same figure used to render in warning yellow.
    const a = assessResourceRisk('cpu', 0.444, 0.2, null);
    expect(a.level).toBe('info');
    expect(a.badge).toBe('Bursting');
    expect(a.impactText).toMatch(/safe and normal/);
    expect(a.recommendation).toMatch(/resources\.requests\.cpu/);
  });

  it('prefers the throttle verdict over bursting when both apply', () => {
    expect(assessResourceRisk('cpu', 0.99, 0.2, 1).badge).toBe('CPU Throttled');
  });

  it('treats a burst well inside the limit as bursting, not throttling', () => {
    expect(assessResourceRisk('cpu', 0.5, 0.2, 1).badge).toBe('Bursting');
  });

  it('never produces the memory verdict for CPU at any level', () => {
    for (const usage of [0, 0.1, 0.2, 0.5, 0.95, 1, 4]) {
      const a = assessResourceRisk('cpu', usage, 0.2, 1);
      expect(a.level).not.toBe('critical');
      expect(a.badge).not.toBe('OOMKill Risk');
    }
  });
});

describe('edge cases the specification did not cover', () => {
  it('treats a zero limit as no limit, because that is how the wire spells unset', () => {
    // A literal zero limit is rejected by Kubernetes, so `0` can only mean "not declared".
    expect(assessResourceRisk('memory', 600 * MiB, 100 * MiB, 0).badge).toBe('Above Request');
    expect(assessResourceRisk('cpu', 4, 0.2, 0).badge).toBe('Bursting');
  });

  it('treats a zero request as no request, so nothing "exceeds" it', () => {
    expect(assessResourceRisk('cpu', 4, 0, null).level).toBe('normal');
    expect(assessResourceRisk('memory', 600 * MiB, 0, null).level).toBe('normal');
  });

  it('has no verdict when neither request nor limit is declared', () => {
    // BestEffort. There is no basis, so a percentage would be Infinity and a verdict invented.
    expect(assessResourceRisk('cpu', 4, null, null).level).toBe('normal');
    expect(assessResourceRisk('memory', 8000 * MiB, null, null).level).toBe('normal');
  });

  it('is normal at zero usage whatever is declared', () => {
    expect(assessResourceRisk('memory', 0, 50 * MiB, 100 * MiB).level).toBe('normal');
    expect(assessResourceRisk('cpu', 0, 0.2, 1).level).toBe('normal');
  });

  it('refuses a sample that is not a number', () => {
    expect(assessResourceRisk('memory', Number.NaN, 50 * MiB, 100 * MiB).level).toBe('normal');
    expect(assessResourceRisk('cpu', Number.POSITIVE_INFINITY, 0.2, 1).level).toBe('normal');
    expect(assessResourceRisk('cpu', -1, 0.2, 1).level).toBe('normal');
  });

  it('judges an inverted limit against the limit, and says the declaration is wrong', () => {
    // Legal on the wire: these are pod-level sums, and one container declaring no limit while its
    // siblings do makes the limit total smaller than the request total.
    const a = assessResourceRisk('memory', 90 * MiB, 200 * MiB, 100 * MiB);
    expect(a.level).toBe('critical');
    expect(a.impactText).toMatch(/below the declared request/);
    const c = assessResourceRisk('cpu', 0.99, 2, 1);
    expect(c.badge).toBe('CPU Throttled');
    expect(c.impactText).toMatch(/below the declared request/);
  });

  it('leaves the normal verdict free of the inverted-limit note', () => {
    expect(assessResourceRisk('memory', MiB, 200 * MiB, 100 * MiB).impactText).not.toMatch(/below the declared/);
  });
});

describe('a chosen threshold against a plain comparison', () => {
  it('marks CPU Throttled, and says both why the line is ours and why the mechanism is unseen', () => {
    const a = assessResourceRisk('cpu', 0.96, 0.2, 1);
    expect(a.basis).toBe('heuristic');
    expect(a.basisNote).toBe(CPU_THROTTLE_NOTE);
    // The reason, not just the flag: a dashed border with no sentence behind it is decoration.
    expect(a.basisNote).toMatch(/95% line is chosen by this console/);
    expect(a.basisNote).toMatch(/container_cpu_cfs_throttled_periods_total/);
    expect(a.basisNote).toMatch(/100ms/);
  });

  it('marks both memory verdicts, because 90% and 80% are this console’s lines', () => {
    // Not because the consequence is uncertain — it is not, the kernel kills the container. Because
    // `resourcePressure()` already means exactly this by the dashed border on `memory-critical` and
    // `memory-near-limit`, and one visual cannot carry two meanings on one row.
    for (const usage of [95, 85]) {
      const a = assessResourceRisk('memory', usage * MiB, 50 * MiB, 100 * MiB);
      expect(a.basis).toBe('heuristic');
      expect(a.basisNote).toBe(MEMORY_THRESHOLD_NOTE);
    }
    expect(MEMORY_THRESHOLD_NOTE).toMatch(/chosen by this console/);
    expect(MEMORY_THRESHOLD_NOTE).toMatch(/kernel guarantee/);
  });

  it('leaves the comparisons against a declared number measured', () => {
    // This is the line that carries the meaning. `usage > request` invents no threshold of ours, so
    // marking it would collapse the distinction into "everything is heuristic", which says nothing.
    const bursting = assessResourceRisk('cpu', 0.444, 0.2, null);
    expect(bursting.badge).toBe('Bursting');
    expect(bursting.basis).toBe('measured');
    const aboveRequest = assessResourceRisk('memory', 60 * MiB, 50 * MiB, null);
    expect(aboveRequest.badge).toBe('Above Request');
    expect(aboveRequest.basis).toBe('measured');
    expect(assessResourceRisk('cpu', 0.1, 0.2, 1).basis).toBe('measured');
  });

  it('carries a note exactly when the basis is a chosen threshold', () => {
    const cases: [('cpu' | 'memory'), number, number | null, number | null][] = [
      ['memory', 95 * MiB, 50 * MiB, 100 * MiB],
      ['memory', 85 * MiB, 50 * MiB, 100 * MiB],
      ['memory', 60 * MiB, 50 * MiB, null],
      ['memory', MiB, 50 * MiB, 100 * MiB],
      ['cpu', 0.96, 0.2, 1],
      ['cpu', 0.444, 0.2, null],
      ['cpu', 0.1, 0.2, 1]
    ];
    for (const [unit, usage, request, limit] of cases) {
      const a = assessResourceRisk(unit, usage, request, limit);
      expect(a.basisNote === null).toBe(a.basis === 'measured');
    }
  });

  it('keeps the marker when the inverted-limit note is appended', () => {
    const a = assessResourceRisk('cpu', 0.99, 2, 1);
    expect(a.badge).toBe('CPU Throttled');
    expect(a.basis).toBe('heuristic');
    expect(a.basisNote).toBe(CPU_THROTTLE_NOTE);
  });

  it('states the uncertainty in the impact copy too, not only in the marker', () => {
    // A marker an operator does not hover is a marker that did not communicate.
    expect(assessResourceRisk('cpu', 0.96, 0.2, 1).impactText).toMatch(/not something this console can see/);
  });
});

describe('every verdict is operator-facing copy', () => {
  const cases: [('cpu' | 'memory'), number, number | null, number | null][] = [
    ['memory', 95 * MiB, 50 * MiB, 100 * MiB],
    ['memory', 85 * MiB, 50 * MiB, 100 * MiB],
    ['memory', 60 * MiB, 50 * MiB, null],
    ['cpu', 0.99, 0.2, 1],
    ['cpu', 0.444, 0.2, null],
    ['cpu', 0.1, 0.2, 1]
  ];

  it('always fills all four parts, with no bare codes and no emoji', () => {
    for (const [unit, usage, request, limit] of cases) {
      const a = assessResourceRisk(unit, usage, request, limit);
      expect(a.badge.trim().length).toBeGreaterThan(2);
      expect(a.title.trim().length).toBeGreaterThan(10);
      expect(a.impactText.trim().length).toBeGreaterThan(40);
      expect(a.recommendation.trim().length).toBeGreaterThan(20);
      // A SCREAMING_CODE leaking into copy is what `explainError`'s own test forbids.
      expect(a.title).not.toMatch(/[A-Z]{3,}_[A-Z]/);
      for (const ch of [...a.badge, ...a.title, ...a.impactText, ...a.recommendation]) {
        const cp = ch.codePointAt(0) ?? 0;
        expect(cp === 0xfe0f || cp >= 0x1f300).toBe(false);
      }
    }
  });
});

describe('panel facts', () => {
  it('states usage, request with its percentage, and the limit', () => {
    const facts = riskFacts('memory', 95 * MiB, 50 * MiB, 100 * MiB);
    expect(facts.map(f => f.label)).toEqual(['Current usage', 'Request', 'Limit']);
    expect(facts[0]?.value).toBe('95 MiB');
    expect(facts[1]?.note).toBe('190% of request');
    expect(facts[2]?.note).toBe('95% of limit');
  });

  it('spells out a missing limit rather than showing a dash', () => {
    const facts = riskFacts('cpu', 0.444, 0.2, null);
    expect(facts[2]?.value).toBe('No limit configured');
    expect(facts[2]?.note).toBeUndefined();
    expect(facts[1]?.note).toBe('222% of request');
  });

  it('spells out a missing request, and a zero basis is missing', () => {
    expect(riskFacts('cpu', 0.444, 0, 0)[1]?.value).toBe('No request configured');
    expect(riskFacts('cpu', 0.444, null, null)[2]?.value).toBe('No limit configured');
  });

  it('reports an unreadable sample as no sample, never as zero', () => {
    expect(riskFacts('memory', Number.NaN, 50 * MiB, null)[0]?.value).toBe('No sample');
    expect(riskFacts('memory', Number.NaN, 50 * MiB, null)[1]?.note).toBeUndefined();
  });

  it('keeps a small percentage from reading as 0%', () => {
    expect(riskFacts('cpu', 0.0008, 0.2, null)[1]?.note).toBe('0.4% of request');
  });
});
