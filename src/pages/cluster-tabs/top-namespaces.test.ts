/** Top namespaces: ranked by live usage only, never by what was requested or limited. */
import { describe, expect, it } from 'vitest';
import type { UtilizationNamespace } from './usage/utilization-model';
import { namespaceTop, namespaceTopLabel, namespaceView, rankNamespaces, rankedEmpty, usageBar, usageText } from './top-namespaces';

function ns(namespace: string, over: Partial<UtilizationNamespace> = {}): UtilizationNamespace {
  return {
    namespace,
    pods: 1,
    cpuUsage: 0.01,
    cpuRequest: 0,
    cpuLimit: 0,
    memoryUsage: 1000,
    memoryRequest: 0,
    memoryLimit: 0,
    usageMissing: 0,
    counted: 1,
    noCpuRequest: 0,
    noMemoryRequest: 0,
    noCpuLimit: 0,
    noMemoryLimit: 0,
    cpuShare: null,
    memoryShare: null,
    cpuOfRequest: { state: 'no-request' },
    memoryOfRequest: { state: 'no-request' },
    memoryOfLimit: { state: 'no-request' },
    restarts: 0,
    oomKilled: 0,
    nearMemoryLimit: 0,
    ...over
  } as UtilizationNamespace;
}

describe('rankNamespaces', () => {
  it('orders by used CPU, ignoring a far larger request', () => {
    const rows = [ns('big-request', { cpuUsage: 0.002, cpuRequest: 8 }), ns('busy', { cpuUsage: 0.3, cpuRequest: 0.1 })];
    expect(rankNamespaces(rows, null, 'cpu', 5).rows.map(r => r.namespace)).toEqual(['busy', 'big-request']);
  });

  it('orders memory by used bytes, not by the limit', () => {
    const rows = [ns('a', { memoryUsage: 10, memoryLimit: 1e9 }), ns('b', { memoryUsage: 500, memoryLimit: 600 })];
    expect(rankNamespaces(rows, null, 'memory', 5).rows.map(r => r.namespace)).toEqual(['b', 'a']);
  });

  it('never ranks a namespace with no sample; it counts it instead', () => {
    const out = rankNamespaces([ns('x', { cpuUsage: null }), ns('y')], null, 'cpu', 5);
    expect(out.rows.map(r => r.namespace)).toEqual(['y']);
    expect(out.unsampled).toBe(1);
  });

  it('ranks only the namespaces the page lists, and cuts to N', () => {
    const rows = [ns('a', { cpuUsage: 3 }), ns('b', { cpuUsage: 2 }), ns('c', { cpuUsage: 1 })];
    expect(rankNamespaces(rows, new Set(['b', 'c']), 'cpu', 5).rows.map(r => r.namespace)).toEqual(['b', 'c']);
    expect(rankNamespaces(rows, null, 'cpu', 2).rows).toHaveLength(2);
  });
});

describe('usageBar', () => {
  it('scales to the top namespace, so #1 is full and a zero is empty', () => {
    expect(usageBar(2, 4)).toBe(0.5);
    expect(usageBar(4, 4)).toBe(1);
    expect(usageBar(0, 0)).toBe(0);
  });
});

describe('usageText', () => {
  it('marks a sum with unsampled pods as a floor', () => {
    expect(usageText(ns('a', { cpuUsage: 0.25, usageMissing: 2 }), 'cpu')).toBe('≥ 250m');
    expect(usageText(ns('a', { cpuUsage: 0.25 }), 'cpu')).toBe('250m');
  });
});

describe('rankedEmpty', () => {
  it('says metrics-server is not answering before anything else', () => {
    const e = rankedEmpty({ metricsAvailable: false, workloadsRead: false, listed: 0, metric: 'cpu' });
    expect(e.title).toBe('CPU ranking unavailable');
    expect(e.hint).toMatch(/metrics-server/);
  });

  it('names the failed workloads read instead of blaming metrics', () => {
    const e = rankedEmpty({ metricsAvailable: true, workloadsRead: false, listed: 12, metric: 'cpu' });
    expect(e.title).toBe('CPU ranking unavailable');
    expect(e.hint).toMatch(/workloads read/);
    expect(e.hint).not.toMatch(/sample/);
  });

  it('says the filters matched nothing when no namespace is listed', () => {
    expect(rankedEmpty({ metricsAvailable: true, workloadsRead: true, listed: 0, metric: 'memory' }).title).toBe('No namespace matches the filters');
  });

  it('blames the sample only when listed namespaces were read and none reported one', () => {
    expect(rankedEmpty({ metricsAvailable: true, workloadsRead: true, listed: 3, metric: 'memory' }).title).toBe('No Memory sample');
  });
});

describe('namespaceView', () => {
  it('opens on the full namespace list', () => {
    expect(namespaceView(null)).toBe('list');
  });

  it('reads the two ranking views and nothing else', () => {
    expect(namespaceView('cpu')).toBe('cpu');
    expect(namespaceView('memory')).toBe('memory');
    expect(namespaceView('limit')).toBe('list');
  });
});

describe('namespaceTop', () => {
  it('offers 10, 20, 30 and all, defaulting to 10', () => {
    expect(namespaceTop(null)).toBe(10);
    expect(namespaceTop('20')).toBe(20);
    expect(namespaceTop('30')).toBe(30);
    expect(namespaceTop('all')).toBe('all');
    expect(namespaceTop('50')).toBe(10);
    expect(namespaceTop('20abc')).toBe(10);
  });

  it('ranks every sampled namespace under all', () => {
    const rows = Array.from({ length: 35 }, (_, i) => ns(`n${i}`, { cpuUsage: i + 1 }));
    expect(rankNamespaces(rows, null, 'cpu', namespaceTop('all')).rows).toHaveLength(35);
    expect(rankNamespaces(rows, null, 'cpu', namespaceTop('30')).rows).toHaveLength(30);
  });

  it('heads the table with what it actually shows', () => {
    expect(namespaceTopLabel(20, 'cpu', 25)).toBe('Top 20 namespaces by CPU used');
    expect(namespaceTopLabel(30, 'memory', 7)).toBe('Top 7 namespaces by memory used');
    expect(namespaceTopLabel('all', 'memory', 12)).toBe('All 12 namespaces by memory used');
    expect(namespaceTopLabel(10, 'cpu', 0)).toBe('Top namespaces by CPU used');
  });
});
