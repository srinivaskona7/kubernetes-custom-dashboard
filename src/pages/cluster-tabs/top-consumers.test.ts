/** Top Consumers: which pods rank, in what order, and what the meter beside each is drawn from. */
import { describe, expect, it } from 'vitest';
import type { UtilizationPod } from './usage/utilization-model';
import {
  emptyReason,
  parseTop,
  podNameParts,
  rankConsumers,
  scopeConsumers,
  serializeTop,
  topFigures,
  unsampledNote,
  usageOf
} from './top-consumers';

function pod(over: Partial<UtilizationPod> & { name: string }): UtilizationPod {
  return {
    key: `${over.namespace ?? 'app'}/${over.name}`,
    namespace: 'app',
    node: null,
    phase: 'Running',
    qosClass: null,
    restarts: 0,
    owners: [],
    containers: [],
    conditions: [],
    cpuUsage: null,
    cpuRequest: 0,
    cpuLimit: 0,
    memoryUsage: null,
    memoryRequest: 0,
    memoryLimit: 0,
    cpuOfRequest: { state: 'no-basis' },
    cpuOfLimit: { state: 'no-basis' },
    memoryOfRequest: { state: 'no-basis' },
    memoryOfLimit: { state: 'no-basis' },
    cpuHeadroom: null,
    memoryHeadroom: null,
    cpuShare: null,
    memoryShare: null,
    pressure: [],
    ...over
  };
}

describe('parseTop', () => {
  it('reads the three offered sizes', () => {
    expect(parseTop('10')).toBe(10);
    expect(parseTop('20')).toBe(20);
    expect(parseTop('50')).toBe(50);
  });
  it('falls back to 10 on anything else', () => {
    for (const raw of [null, '', '7', 'all', '20abc', '-10', '1e2']) expect(parseTop(raw)).toBe(10);
  });
  it('omits the default from the URL', () => {
    expect(serializeTop(10)).toBeNull();
    expect(serializeTop(50)).toBe('50');
  });
});

describe('rankConsumers', () => {
  it('ranks by usage, largest first', () => {
    const pods = [pod({ name: 'a', cpuUsage: 0.1 }), pod({ name: 'b', cpuUsage: 0.9 }), pod({ name: 'c', cpuUsage: 0.5 })];
    expect(rankConsumers(pods, 'cpu', 10).rows.map(p => p.name)).toEqual(['b', 'c', 'a']);
  });
  it('keeps input order on a tie, so a refresh does not reshuffle equal rows', () => {
    const pods = [pod({ name: 'a', cpuUsage: 0.5 }), pod({ name: 'b', cpuUsage: 0.5 })];
    expect(rankConsumers(pods, 'cpu', 10).rows.map(p => p.name)).toEqual(['a', 'b']);
  });
  it('excludes an unsampled pod from the ranking and counts it', () => {
    const pods = [pod({ name: 'a', cpuUsage: 0.2 }), pod({ name: 'b', cpuUsage: null })];
    const r = rankConsumers(pods, 'cpu', 10);
    expect(r.rows.map(p => p.name)).toEqual(['a']);
    expect(r.unsampled).toBe(1);
  });
  it('treats the two metrics independently', () => {
    const pods = [pod({ name: 'a', cpuUsage: null, memoryUsage: 5e8 })];
    expect(rankConsumers(pods, 'cpu', 10)).toEqual({ rows: [], unsampled: 1 });
    expect(rankConsumers(pods, 'memory', 10).rows.map(p => p.name)).toEqual(['a']);
  });
  it('ranks a measured zero, which is a reading, not a missing one', () => {
    const r = rankConsumers([pod({ name: 'idle', cpuUsage: 0 })], 'cpu', 10);
    expect(r.rows.map(p => p.name)).toEqual(['idle']);
    expect(r.unsampled).toBe(0);
  });
  it('cuts at N and never pads', () => {
    const pods = Array.from({ length: 25 }, (_, i) => pod({ name: `p${i}`, memoryUsage: i + 1 }));
    expect(rankConsumers(pods, 'memory', 20).rows).toHaveLength(20);
    expect(rankConsumers(pods.slice(0, 3), 'memory', 50).rows).toHaveLength(3);
  });
});

describe('topFigures', () => {
  it('uses the same usage the row is ranked by', () => {
    const p = pod({ name: 'a', cpuUsage: 0.42, cpuRequest: 0.25, cpuLimit: 1 });
    expect(topFigures(p, 'cpu').used).toBe(usageOf(p, 'cpu'));
    expect(topFigures(p, 'cpu')).toMatchObject({ used: 0.42, request: 0.25, limit: 1 });
  });
  it('reads an undeclared request or limit as none, not zero', () => {
    expect(topFigures(pod({ name: 'a', memoryUsage: 1 }), 'memory')).toMatchObject({ request: null, limit: null });
  });
  it('marks the limit partial when a running container declares none', () => {
    const containers = [
      { name: 'app', init: false, sidecar: false, cpuLimit: 1 },
      { name: 'proxy', init: false, sidecar: false, cpuLimit: 0 }
    ] as unknown as UtilizationPod['containers'];
    expect(topFigures(pod({ name: 'a', cpuUsage: 0.5, cpuLimit: 1, containers }), 'cpu').limitPartial).toBe(true);
  });
  it('ignores an init container without a limit', () => {
    const containers = [
      { name: 'app', init: false, sidecar: false, cpuLimit: 1 },
      { name: 'setup', init: true, sidecar: false, cpuLimit: 0 }
    ] as unknown as UtilizationPod['containers'];
    expect(topFigures(pod({ name: 'a', cpuUsage: 0.5, cpuLimit: 1, containers }), 'cpu').limitPartial).toBe(false);
  });
});

describe('scopeConsumers', () => {
  const pods = [pod({ name: 'a', namespace: 'app' }), pod({ name: 'k', namespace: 'platform-system' })];
  const system = new Set(['platform-system']);
  it('hides system namespaces when the toggle is off', () => {
    expect(scopeConsumers(pods, system, false, new Set()).map(p => p.name)).toEqual(['a']);
  });
  it('hides nothing until the server classification has answered', () => {
    expect(scopeConsumers(pods, null, false, new Set())).toHaveLength(2);
  });
  it('keeps an explicitly selected system namespace', () => {
    // Only the system rule lives here; the namespace selection itself is applied upstream by
    // `filterByNamespace`, as on the Pods sub-tab.
    expect(scopeConsumers(pods, system, false, new Set(['platform-system'])).map(p => p.name)).toEqual(['a', 'k']);
  });
});

describe('emptyReason', () => {
  const ok = { state: 'ok' as const };
  it('says the read failed before it says there are no pods', () => {
    expect(emptyReason({ inNamespaces: 0, scoped: 0, selected: 0, status: { state: 'unavailable' } })).toEqual({
      kind: 'unavailable'
    });
  });
  it('names pods hidden only by the system toggle, with their count', () => {
    expect(emptyReason({ inNamespaces: 7, scoped: 0, selected: 0, status: ok })).toEqual({ kind: 'system', hidden: 7 });
  });
  it('blames the namespace selection when it matched nothing', () => {
    expect(emptyReason({ inNamespaces: 0, scoped: 0, selected: 2, status: ok })).toEqual({ kind: 'namespaces' });
  });
  it('says the cluster reported none only when nothing was hidden and the read answered', () => {
    expect(emptyReason({ inNamespaces: 0, scoped: 0, selected: 0, status: { state: 'partial' } })).toEqual({
      kind: 'none'
    });
  });
  it('is null while there is something to rank', () => {
    expect(emptyReason({ inNamespaces: 3, scoped: 3, selected: 0, status: ok })).toBeNull();
  });
});

describe('unsampledNote', () => {
  it('says unsampled pods are left out of the ranking, not that the figures are floors', () => {
    const note = unsampledNote(3, 40)!;
    expect(note).toContain('3 of 40 pods');
    expect(note).toContain('not ranked');
    expect(note).not.toContain('floor');
  });
  it('is null when every pod reported a sample', () => {
    expect(unsampledNote(0, 40)).toBeNull();
  });
});

describe('podNameParts', () => {
  it('keeps the generated suffix apart, so two replicas never truncate to the same text', () => {
    expect(podNameParts('polls-backend-77f4454cff-jbd85')).toEqual({ head: 'polls-backend-77f4454cff', tail: '-jbd85' });
    expect(podNameParts('polls-backend-77f4454cff-x2k9q').tail).not.toBe(podNameParts('polls-backend-77f4454cff-jbd85').tail);
  });
  it('keeps a StatefulSet ordinal', () => {
    expect(podNameParts('redis-master-0')).toEqual({ head: 'redis-master', tail: '-0' });
  });
  it('leaves a name with no dash, or a long last segment, whole', () => {
    expect(podNameParts('standalone')).toEqual({ head: 'standalone', tail: '' });
    expect(podNameParts('a-verylongsegmentname')).toEqual({ head: 'a-verylongsegmentname', tail: '' });
  });
});
