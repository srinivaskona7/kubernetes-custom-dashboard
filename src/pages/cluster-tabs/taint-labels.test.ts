import { describe, expect, it } from 'vitest';
import type { PodToleration } from '../../api';
import {
  effectMeaning,
  taintText,
  taintsHeadline,
  tolerationSortRank,
  tolerationState,
  tolerationStateText,
  tolerationText,
  tolerationsHeadline
} from './taint-labels';

const tol = (o: Partial<PodToleration> = {}): PodToleration => ({
  key: null,
  value: null,
  operator: 'Equal',
  effect: null,
  tolerationSeconds: null,
  universal: false,
  inert: false,
  matchesNodes: [],
  ...o
});

describe('tolerationText', () => {
  /*
    The rule this module exists for. A universal toleration has an empty key and an empty value, so
    rendered field-by-field it is the emptiest row on the page — while being the most permissive
    thing a pod can declare. 42 of the 50 authored tolerations on the live cluster were this shape.
  */
  it('names the wildcard rather than rendering it as blanks', () => {
    const t = tolerationText(tol({ operator: 'Exists', universal: true, effect: 'NoSchedule' }));
    expect(t).toContain('any taint');
    expect(t).toContain('NoSchedule');
  });

  it('reads an absent effect as every effect, not as no effect', () => {
    expect(tolerationText(tol({ key: 'CriticalAddonsOnly', operator: 'Exists' }))).toContain('any effect');
  });

  it('distinguishes Exists on a key from an equality match', () => {
    expect(tolerationText(tol({ key: 'dedicated', operator: 'Exists' }))).toContain('any taint keyed dedicated');
    expect(tolerationText(tol({ key: 'dedicated', operator: 'Equal', value: 'gpu' }))).toContain('dedicated=gpu');
  });

  it('reports tolerationSeconds as a grace window, not as a schedule input', () => {
    const t = tolerationText(tol({ key: 'k', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 }));
    expect(t).toContain('300s');
    expect(t).toContain('after the taint appears');
  });
});

describe('tolerationState', () => {
  it('separates "grants nothing" from "not checked"', () => {
    expect(tolerationState(tol({ inert: true }))).toBe('inert');
    expect(tolerationState(tol({ inert: null }))).toBe('unchecked');
    expect(tolerationState(tol({ inert: false }))).toBe('active');
  });

  it('ranks the broadest permission first, because it is the one worth seeing', () => {
    expect(tolerationSortRank(tol({ universal: true, inert: true }))).toBeLessThan(
      tolerationSortRank(tol({ inert: false }))
    );
    expect(tolerationSortRank(tol({ inert: false }))).toBeLessThan(tolerationSortRank(tol({ inert: true })));
  });

  it('never describes an inert toleration as broken', () => {
    const s = tolerationStateText('inert');
    expect(s).toContain('grants nothing today');
    expect(s).toContain('not an error');
  });

  it('describes an active toleration as permission, never as placement', () => {
    const s = tolerationStateText('active');
    expect(s).toContain('permitted');
    expect(s).toMatch(/separate column|whether it is running/);
    expect(s).not.toMatch(/scheduled because|placed by this/);
  });
});

describe('effectMeaning', () => {
  it('keeps NoExecute distinct from NoSchedule — one evicts running pods, one does not', () => {
    expect(effectMeaning('NoExecute')).toContain('evicted');
    expect(effectMeaning('NoSchedule')).toContain('already running stay');
    expect(effectMeaning('NoSchedule')).not.toContain('evicted');
  });

  it('reads PreferNoSchedule as a preference the scheduler can ignore', () => {
    expect(effectMeaning('PreferNoSchedule')).toContain('preference, not a rule');
  });

  it('calls a missing effect a malformed read rather than treating it as permissive', () => {
    expect(effectMeaning(null)).toContain('malformed');
  });
});

describe('taintsHeadline', () => {
  it('says unknown when the nodes were not read, and never zero', () => {
    const s = taintsHeadline({ nodesReporting: null, taints: null, taintedNodes: null });
    expect(s).toContain('unknown');
    expect(s).toContain('not zero');
  });

  it('reads a genuine zero as a fact about the cluster', () => {
    // The live cluster: 3 nodes, no taints at all.
    const s = taintsHeadline({ nodesReporting: 3, taints: 0, taintedNodes: 0 });
    expect(s).toContain('No taint is declared');
    expect(s).toContain('3 nodes');
    expect(s).toContain('grants nothing today');
    expect(s).not.toContain('unknown');
  });

  it('reports the inventory when taints exist', () => {
    expect(taintsHeadline({ nodesReporting: 5, taints: 2, taintedNodes: 1 })).toBe(
      '2 taints across 1 of 5 nodes.'
    );
  });
});

describe('tolerationsHeadline', () => {
  /*
    Without the explanation the count reads as a broken filter. Every pod on every cluster has a
    toleration, so "50 of 120" invites the reader to conclude the other 70 were dropped by a bug.
  */
  it('explains why the count is not every pod', () => {
    const s = tolerationsHeadline({
      podsRead: 120,
      podsWithAuthoredTolerations: 50,
      podsWithUniversalToleration: 42
    });
    expect(s).toContain('50 of 120');
    expect(s).toContain('injects');
    expect(s).toContain('every pod');
    expect(s).toContain('42');
  });

  it('says unknown when the pods were not read', () => {
    const s = tolerationsHeadline({
      podsRead: null,
      podsWithAuthoredTolerations: null,
      podsWithUniversalToleration: null
    });
    expect(s).toContain('unknown');
    expect(s).not.toMatch(/\b0 of\b/);
  });
});

describe('taintText', () => {
  it('prints a taint the way kubectl does, so the two can be compared by eye', () => {
    expect(taintText({ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' })).toBe('dedicated=gpu:NoSchedule');
    expect(taintText({ key: 'k', value: null, effect: 'NoExecute' })).toBe('k:NoExecute');
  });

  it('marks a missing effect rather than printing a bare colon', () => {
    expect(taintText({ key: 'k', value: null, effect: null })).toBe('k:(no effect)');
  });
});
