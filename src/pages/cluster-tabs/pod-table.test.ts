/**
 * The Pods sub-tab's model: phase buckets, the system toggle, search, the resource figures the
 * shared meter draws, and the events under an opened row.
 */
import { describe, expect, it } from 'vitest';
import type { ContainerRow, EventRow } from '../../api';
import { ofRequestText, usageVerdict } from './namespace-usage';
import type { InventoryPod } from './pod-inventory';
import {
  activePodFilters,
  containerFigures,
  matchesAdvanced,
  matchesUsageBand,
  nextUsageBand,
  usageBandCounts,
  usageBandOf,
  usagePercent,
  type AdvancedPodFilter,
  filterPodTable,
  hiddenAsSystem,
  matchesSearch,
  needsAttention,
  podsInScope,
  RESTARTS_WARN,
  NO_POD_FILTER,
  phaseBucket,
  podEvents,
  podFigures,
  podSummaryCounts,
  scopePods,
  workloadCell
} from './pod-table';

const ctr = (over: Partial<ContainerRow> = {}): ContainerRow =>
  ({
    name: 'app',
    image: 'img',
    init: false,
    ready: true,
    restarts: 0,
    state: 'running',
    reason: null,
    cpuRequest: 0.1,
    cpuLimit: 0.5,
    memoryRequest: 100,
    memoryLimit: 200,
    cpuUsage: 0.05,
    memoryUsage: 50,
    ...over
  }) as ContainerRow;

const pod = (over: Partial<InventoryPod> = {}): InventoryPod =>
  ({
    name: 'p',
    namespace: 'ns',
    phase: 'Running',
    restarts: 0,
    reason: null,
    node: 'n1',
    conditions: [{ type: 'ContainersReady', status: 'True', reason: null, message: null }],
    containers: [ctr()],
    owners: ['Deployment/web'],
    cpuRequest: 0.1,
    cpuLimit: 0.5,
    memoryRequest: 100,
    memoryLimit: 200,
    cpuUsage: 0.05,
    memoryUsage: 50,
    ...over
  }) as InventoryPod;

const NONE = new Set<string>();

describe('phaseBucket and podSummaryCounts', () => {
  it('buckets by phase, Succeeded as completed, anything else unknown', () => {
    expect(['Running', 'Succeeded', 'Pending', 'Failed', 'Weird', ''].map(phaseBucket)).toEqual([
      'running',
      'completed',
      'pending',
      'failed',
      'unknown',
      'unknown'
    ]);
  });

  it('counts the rows it is given, and a crashlooping Running pod needs attention without leaving Running', () => {
    const c = podSummaryCounts([
      pod(),
      pod({ name: 'crash', reason: 'CrashLoopBackOff' }),
      pod({ name: 'done', phase: 'Succeeded' }),
      pod({ name: 'wait', phase: 'Pending' }),
      pod({ name: 'dead', phase: 'Failed' })
    ]);
    expect(c).toEqual({ total: 5, running: 2, completed: 1, pending: 1, failed: 1, unknown: 0, attention: 3 });
  });

  it('counts a flapping pod — Running 1/1 now, restarts above the threshold — as needing attention', () => {
    expect(needsAttention(pod({ restarts: RESTARTS_WARN }))).toBe(false);
    expect(needsAttention(pod({ restarts: RESTARTS_WARN + 1 }))).toBe(true);
    expect(podSummaryCounts([pod({ restarts: 186 })])).toMatchObject({ running: 1, attention: 1 });
  });

  it('is all zeros for no pods, not undefined', () => {
    expect(podSummaryCounts([]).total).toBe(0);
  });
});

describe('system toggle', () => {
  const sys = new Set(['kyma-system']);

  it('hides system pods by default and shows them when asked', () => {
    const p = pod({ namespace: 'kyma-system' });
    expect(hiddenAsSystem(p, sys, false, NONE)).toBe(true);
    expect(hiddenAsSystem(p, sys, true, NONE)).toBe(false);
  });

  it('never hides a namespace the operator selected — the drilldown from Namespaces', () => {
    expect(hiddenAsSystem(pod({ namespace: 'kyma-system' }), sys, false, new Set(['kyma-system']))).toBe(false);
  });

  it('hides nothing while the classification is unknown', () => {
    expect(hiddenAsSystem(pod({ namespace: 'kyma-system' }), null, false, NONE)).toBe(false);
  });

  it('podsInScope is the one scope the counter and the table share: namespace, then system', () => {
    const rows = [pod({ namespace: 'kyma-system' }), pod({ namespace: 'applecare' }), pod({ namespace: 'polls' })];
    expect(podsInScope(rows, NONE, sys, false).map(r => r.namespace)).toEqual(['applecare', 'polls']);
    expect(podsInScope(rows, NONE, sys, true)).toHaveLength(3);
    expect(podsInScope(rows, new Set(['kyma-system']), sys, false).map(r => r.namespace)).toEqual(['kyma-system']);
  });

  it('scopePods keeps application pods', () => {
    const rows = scopePods([pod({ namespace: 'kyma-system' }), pod({ namespace: 'applecare' })], sys, false, NONE);
    expect(rows.map(r => r.namespace)).toEqual(['applecare']);
  });
});

describe('search and status', () => {
  it('matches pod name, node and owner, case-insensitively', () => {
    const p = pod({ name: 'api-7d9f', node: 'shoot-worker-1', owners: ['Deployment/checkout'] });
    expect(matchesSearch(p, 'API')).toBe(true);
    expect(matchesSearch(p, 'worker-1')).toBe(true);
    expect(matchesSearch(p, 'checkout')).toBe(true);
    expect(matchesSearch(p, 'nope')).toBe(false);
    expect(matchesSearch(p, '  ')).toBe(true);
  });

  it('filters by phase and by attention', () => {
    const rows = [pod({ name: 'ok' }), pod({ name: 'pend', phase: 'Pending' }), pod({ name: 'crash', reason: 'CrashLoopBackOff' })];
    expect(filterPodTable(rows, { ...NO_POD_FILTER, status: 'pending' }).map(r => r.name)).toEqual(['pend']);
    expect(filterPodTable(rows, { ...NO_POD_FILTER, status: 'attention' }).map(r => r.name)).toEqual(['pend', 'crash']);
    expect(filterPodTable(rows, NO_POD_FILTER)).toHaveLength(3);
  });

  it('counts each active filter once, the namespace selection included', () => {
    expect(activePodFilters(NO_POD_FILTER, 0)).toBe(0);
    expect(activePodFilters({ ...NO_POD_FILTER, search: 'x', status: 'failed', showSystem: true }, 2)).toBe(4);
    expect(
      activePodFilters({ ...NO_POD_FILTER, cpu: 'gt75', memory: 'lt25', advanced: new Set(['noLimits', 'highRestarts'] as const) }, 0)
    ).toBe(4);
  });
});

describe('nextUsageBand', () => {
  it('pressing the selected chip unselects it, back to All', () => {
    expect(nextUsageBand('lt25', 'lt25')).toBe('all');
    expect(nextUsageBand('25to50', '25to50')).toBe('all');
  });

  it('pressing another chip selects it, and All stays All', () => {
    expect(nextUsageBand('lt25', 'gt75')).toBe('gt75');
    expect(nextUsageBand('all', '50to75')).toBe('50to75');
    expect(nextUsageBand('all', 'all')).toBe('all');
    expect(nextUsageBand('gt75', 'all')).toBe('all');
  });
});

describe('utilization bands', () => {
  // request 0.1 CPU / 100 Mi on one container, so usage 0.0x CPU and x Mi read as x%.
  const at = (name: string, cpuPct: number, memPct: number, over: Partial<ContainerRow> = {}) =>
    pod({ name, containers: [ctr({ cpuUsage: cpuPct / 1000, memoryUsage: memPct, ...over })] });

  it('computes used ÷ summed request, the figure the meter prints', () => {
    const p = at('a', 40, 90);
    expect(usagePercent(p, 'cpu')).toBeCloseTo(40);
    expect(usagePercent(p, 'memory')).toBeCloseTo(90);
    expect(ofRequestText(podFigures(p, 'memory'), 'pod')).toBe('90% of request');
  });

  it('bands are half-open on the rounded figure the meter prints, and the top band holds a pod past its request', () => {
    expect([0, 0.4, 24.4, 24.6, 49.4, 49.5, 74.4, 74.5, 130].map(usageBandOf)).toEqual([
      'lt25',
      'lt25',
      'lt25',
      '25to50',
      '25to50',
      '50to75',
      '50to75',
      'gt75',
      'gt75'
    ]);
    // A pod the meter prints as "25% of request" is in 25–50%, never <25%.
    const p = at('edge', 24.6, 10);
    expect(ofRequestText(podFigures(p, 'cpu'), 'pod')).toBe('25% of request');
    expect(matchesUsageBand(p, 'cpu', '25to50')).toBe(true);
  });

  it('a pod with no request or no sample matches All and no band', () => {
    const noReq = at('noreq', 10, 10, { cpuRequest: undefined });
    const noSample = at('nosample', 10, 10, { cpuUsage: null });
    for (const p of [noReq, noSample]) {
      expect(usagePercent(p, 'cpu')).toBeNull();
      expect(matchesUsageBand(p, 'cpu', 'all')).toBe(true);
      expect((['lt25', '25to50', '50to75', 'gt75'] as const).some(b => matchesUsageBand(p, 'cpu', b))).toBe(false);
    }
  });

  it('CPU and Memory bands combine with each other and with status and search', () => {
    const rows = [at('hot-cpu', 90, 10), at('hot-both', 90, 80), at('cold', 10, 10), { ...at('hot-pending', 90, 80), phase: 'Pending' }];
    const names = (f: Partial<typeof NO_POD_FILTER>) => filterPodTable(rows, { ...NO_POD_FILTER, ...f }).map(r => r.name);
    expect(names({ cpu: 'gt75' })).toEqual(['hot-cpu', 'hot-both', 'hot-pending']);
    expect(names({ memory: 'gt75' })).toEqual(['hot-both', 'hot-pending']);
    expect(names({ cpu: 'gt75', memory: 'lt25' })).toEqual(['hot-cpu']);
    expect(names({ cpu: 'gt75', memory: 'gt75', status: 'running' })).toEqual(['hot-both']);
    expect(names({ cpu: 'gt75', search: 'pending' })).toEqual(['hot-pending']);
    expect(names({ cpu: 'lt25' })).toEqual(['cold']);
  });

  it('counts each band over the rows given, All counting the unplaced pods too', () => {
    const c = usageBandCounts([at('a', 10, 10), at('b', 60, 10), at('c', 60, 10, { cpuRequest: undefined })], 'cpu');
    expect(c).toEqual({ all: 3, lt25: 1, '25to50': 0, '50to75': 1, gt75: 0 });
  });
});

describe('advanced filters', () => {
  const ok = pod({ name: 'ok' });
  const noCpuReq = pod({ name: 'nocpureq', containers: [ctr({ cpuRequest: undefined })] });
  const noMemReq = pod({ name: 'nomemreq', containers: [ctr({ memoryRequest: undefined })] });
  const partialLimit = pod({ name: 'partial', containers: [ctr(), ctr({ name: 'side', cpuLimit: undefined })] });
  const noMemLimit = pod({ name: 'nomemlim', containers: [ctr({ memoryLimit: undefined })] });
  const flapping = pod({ name: 'flap', restarts: RESTARTS_WARN + 1 });
  const atThreshold = pod({ name: 'edge', restarts: RESTARTS_WARN });
  const rows = [ok, noCpuReq, noMemReq, partialLimit, noMemLimit, flapping, atThreshold];
  const names = (...a: AdvancedPodFilter[]) => filterPodTable(rows, { ...NO_POD_FILTER, advanced: new Set(a) }).map(r => r.name);

  it('each reads the summed pod figures', () => {
    expect(names('noCpuRequest')).toEqual(['nocpureq']);
    expect(names('noMemoryRequest')).toEqual(['nomemreq']);
    // A partial limit is still no full ceiling; a missing memory limit alone counts too.
    expect(names('noLimits')).toEqual(['partial', 'nomemlim']);
    // Above the Restarts column's amber threshold, not at it.
    expect(names('highRestarts')).toEqual(['flap']);
  });

  it('ticked together they narrow (AND), and none ticked shows everything', () => {
    const both = pod({ name: 'both', restarts: 50, containers: [ctr({ cpuRequest: undefined })] });
    const r = [...rows, both];
    expect(filterPodTable(r, { ...NO_POD_FILTER, advanced: new Set(['noCpuRequest', 'highRestarts'] as const) }).map(p => p.name)).toEqual([
      'both'
    ]);
    expect(names()).toHaveLength(rows.length);
  });

  it('a lone init container is excluded, as the meter excludes it', () => {
    const p = pod({ containers: [ctr(), ctr({ name: 'init', init: true, cpuRequest: undefined, cpuLimit: undefined })] });
    expect(matchesAdvanced(p, 'noCpuRequest')).toBe(false);
    expect(matchesAdvanced(p, 'noLimits')).toBe(false);
  });
});

describe('workloadCell', () => {
  it('splits Kind/name for one owner', () => {
    expect(workloadCell(['StatefulSet/db'])).toMatchObject({ kind: 'one', workloadKind: 'StatefulSet', name: 'db' });
  });
  it('refuses to name one of several owners', () => {
    const c = workloadCell(['Deployment/a', 'Deployment/b']);
    expect(c.kind).toBe('ambiguous');
    expect(c).not.toHaveProperty('name');
  });
  it('says none for no owner', () => {
    expect(workloadCell([]).kind).toBe('none');
  });
});

describe('podFigures', () => {
  it('reads used/request/limit, with 0 as undeclared', () => {
    expect(podFigures(pod({ containers: [ctr({ cpuRequest: 0, cpuLimit: 0 })] }), 'cpu')).toEqual({ used: 0.05, request: null, limit: null, limitPartial: false });
  });

  it('marks the limit partial when a regular container declares none, so it is never graded', () => {
    const p = pod({
      memoryLimit: 200,
      memoryUsage: 900,
      containers: [ctr({ memoryUsage: 450 }), ctr({ name: 'sidecar', memoryLimit: 0, memoryUsage: 450 })]
    });
    const f = podFigures(p, 'memory');
    expect(f.limitPartial).toBe(true);
    expect(usageVerdict('memory', f, 'pod').level).not.toBe('at-limit');
  });

  it('grades a native sidecar against its own budget — numerator and denominator cover the same containers', () => {
    // platformsbx: the pod-level usage includes istio-proxy, the pod-level limit (spec.containers) does not.
    const app = ctr({ memoryRequest: 400, memoryLimit: 500, memoryUsage: 350 });
    const proxy = ctr({ name: 'istio-proxy', init: true, sidecar: true, memoryRequest: 64, memoryLimit: 1024, memoryUsage: 55 });
    const done = ctr({ name: 'istio-validation', init: true, memoryUsage: null, memoryLimit: 0 });
    const p = pod({ memoryRequest: 400, memoryLimit: 500, memoryUsage: 405, containers: [app, proxy, done] });
    expect(podFigures(p, 'memory')).toEqual({ used: 405, request: 464, limit: 1524, limitPartial: false });
    expect(usageVerdict('memory', podFigures(p, 'memory'), 'pod').level).toBe('normal');
  });

  it('is unknown, not a smaller sum, when a running container has no sample', () => {
    const p = pod({ containers: [ctr(), ctr({ name: 'b', cpuUsage: null })] });
    expect(podFigures(p, 'cpu').used).toBeNull();
  });

  it('ignores init containers when deciding partial', () => {
    const p = pod({ containers: [ctr(), ctr({ name: 'init', init: true, cpuLimit: 0 })] });
    expect(podFigures(p, 'cpu').limitPartial).toBe(false);
  });

  it('keeps a missing sample as null — the meter says No data, not 0', () => {
    const f = podFigures(pod({ cpuUsage: null, containers: [ctr({ cpuUsage: null })] }), 'cpu');
    expect(f.used).toBeNull();
    expect(usageVerdict('cpu', f, 'pod').label).toBe('No data');
    expect(usageVerdict('cpu', f, 'namespace').label).toBe('No sample');
    expect(ofRequestText({ ...f, request: 1 }, 'container')).toBe('no data');
  });

  it('runs the shared ladder: normal, above request, near limit, at limit', () => {
    const lvl = (used: number) => usageVerdict('memory', podFigures(pod({ containers: [ctr({ memoryUsage: used })] }), 'memory'), 'pod').level;
    expect([lvl(50), lvl(150), lvl(170), lvl(200)]).toEqual(['normal', 'above-request', 'near-limit', 'at-limit']);
  });

  it('containerFigures reads the container alone', () => {
    expect(containerFigures(ctr({ cpuLimit: 0 }), 'cpu')).toEqual({ used: 0.05, request: 0.1, limit: null });
  });
});

describe('podEvents', () => {
  const ev = (over: Partial<EventRow>): EventRow =>
    ({ namespace: 'ns', cluster: 'c', reason: 'BackOff', message: 'm', count: 1, object: 'Pod/p', at: '2026-09-25T10:00:00Z', ...over }) as EventRow;

  it('keeps only this pod in this namespace, newest first, capped', () => {
    const rows = podEvents(
      [
        ev({ at: '2026-09-25T09:00:00Z', reason: 'old' }),
        ev({ at: '2026-09-25T11:00:00Z', reason: 'new' }),
        ev({ namespace: 'other', reason: 'other-ns' }),
        ev({ object: 'Pod/p2', reason: 'other-pod' }),
        ev({ object: 'Deployment/p', reason: 'other-kind' })
      ],
      pod()
    );
    expect(rows.map(r => r.reason)).toEqual(['new', 'old']);
    expect(podEvents(Array.from({ length: 9 }, () => ev({})), pod())).toHaveLength(5);
  });
});
