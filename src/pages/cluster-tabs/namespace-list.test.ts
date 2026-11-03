import { describe, expect, it } from 'vitest';
import type { NamespaceRow } from '../../api';
import { namespaceHeadline, orderNamespaces, podCountText } from './namespace-list';

const ns = (namespace: string, pods: number | null | undefined, system = false): NamespaceRow => ({
  cluster: 'c1',
  namespace,
  system,
  pods,
  verdict: system ? 'system' : 'compliant',
  findings: 0,
  warnings: 0,
  checks: []
} as NamespaceRow);

describe('podCountText', () => {
  it('prints a real count, including a true zero', () => {
    expect(podCountText(7)).toBe('7');
    expect(podCountText(0)).toBe('0');
  });

  it('never renders an unread count as a number', () => {
    expect(podCountText(null)).toBe('—');
    expect(podCountText(undefined)).toBe('—');
  });
});

describe('orderNamespaces', () => {
  it('puts application namespaces before system ones whatever their size', () => {
    const rows = orderNamespaces([ns('kube-system', 40, true), ns('app', 1)]);
    expect(rows.map(r => r.namespace)).toEqual(['app', 'kube-system']);
  });

  it('sorts the busiest first within each group', () => {
    const rows = orderNamespaces([ns('small', 1), ns('big', 9), ns('mid', 4)]);
    expect(rows.map(r => r.namespace)).toEqual(['big', 'mid', 'small']);
  });

  it('ranks an unknown count below the busy namespaces but above the empty ones', () => {
    const rows = orderNamespaces([ns('empty', 0), ns('unread', null), ns('busy', 2)]);
    expect(rows.map(r => r.namespace)).toEqual(['busy', 'unread', 'empty']);
  });

  it('does not let an unknown count outrank a namespace with one pod', () => {
    // The unknown weight sits between 0 and 1, so it must not float to the top of the table and
    // imply that the unreadable namespace is the biggest thing on the cluster.
    const rows = orderNamespaces([ns('unread', null), ns('one', 1)]);
    expect(rows.map(r => r.namespace)).toEqual(['one', 'unread']);
  });

  it('breaks ties by name and does not mutate the input', () => {
    const input = [ns('b', 3), ns('a', 3)];
    const rows = orderNamespaces(input);
    expect(rows.map(r => r.namespace)).toEqual(['a', 'b']);
    expect(input.map(r => r.namespace)).toEqual(['b', 'a']);
  });

  it('still falls through to the name tiebreak when two counts are both unknown', () => {
    const rows = orderNamespaces([ns('zeta', null), ns('alpha', null)]);
    expect(rows.map(r => r.namespace)).toEqual(['alpha', 'zeta']);
  });
});

describe('namespaceHeadline', () => {
  it('totals the pods when every count was read', () => {
    const text = namespaceHeadline([ns('a', 2), ns('kube-system', 5, true)], null);
    expect(text).toContain('2 namespaces holding 7 pods');
    expect(text).toContain('1 of them');
  });

  it('singularises one namespace and one pod', () => {
    expect(namespaceHeadline([ns('a', 1)], null)).toContain('1 namespace holding 1 pod.');
  });

  it('omits the system sentence when there are none', () => {
    expect(namespaceHeadline([ns('a', 1)], null)).not.toContain('system');
  });

  it('states no total at all when the pod list was refused', () => {
    const text = namespaceHeadline([ns('a', null)], 'unavailable');
    expect(text).toContain('refused');
    expect(text).not.toMatch(/holding \d+ pod/);
  });

  it('states no total when the pod list was truncated, because a sum of holes undercounts', () => {
    const text = namespaceHeadline([ns('a', null), ns('b', null)], 'truncated');
    expect(text).toContain('undercounts');
    expect(text).not.toMatch(/holding \d+ pod/);
  });
});
