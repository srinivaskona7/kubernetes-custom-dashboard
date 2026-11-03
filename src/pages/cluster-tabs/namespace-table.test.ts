import { describe, expect, it } from 'vitest';
import type { NamespaceRow, WorkloadRow } from '../../api';
import type { UtilizationNamespace } from './usage/utilization-model';
import {
  NO_NAMESPACE_FILTER,
  activeNamespaceFilters,
  hiddenSystemCount,
  buildNamespaceTable,
  filterNamespaceTable,
  namespaceTypeCounts,
  resourceCell,
  type NamespaceTableFilter,
  showsSystem,
  withShowSystem,
  withType
} from './namespace-table';

const ns = (namespace: string, pods: number | null, system = false): NamespaceRow => ({
  cluster: 'c',
  namespace,
  system,
  pods,
  verdict: system ? 'system' : 'compliant',
  findings: 0,
  warnings: 0,
  checks: []
});

const wl = (namespace: string, name: string, over: Partial<WorkloadRow> = {}): WorkloadRow =>
  ({
    name,
    namespace,
    cluster: 'c',
    kind: 'Deployment',
    ready: 1,
    desired: 1,
    state: 'Ready',
    podIssues: [],
    healthy: true,
    image: null,
    restarts: 0,
    createdAt: '2026-09-01T00:00:00Z',
    nodes: [],
    restartedAt: null,
    updatedReplicas: 1,
    availableReplicas: 1,
    generation: 1,
    observedGeneration: 1,
    restartable: false,
    cpuRequest: 0,
    cpuLimit: 0,
    memoryRequest: 0,
    memoryLimit: 0,
    cpuUsage: null,
    memoryUsage: null,
    pods: [],
    ...over
  }) as WorkloadRow;

const util = (namespace: string, over: Partial<UtilizationNamespace> = {}): UtilizationNamespace =>
  ({
    namespace,
    pods: 1,
    usageMissing: 0,
    cpuUsage: 0.011,
    cpuRequest: 0.19,
    cpuLimit: 1.5,
    memoryUsage: 100,
    memoryRequest: 200,
    memoryLimit: 400,
    restarts: 0,
    oomKilled: 0,
    ...over
  }) as UtilizationNamespace;

describe('namespaceTypeCounts', () => {
  it('counts from the backend system flag, so Overview and the table cannot disagree', () => {
    const c = namespaceTypeCounts([ns('a', 2), ns('b', 0), ns('kube-system', 9, true)], null);
    expect(c).toEqual({ list: 'ok', total: 3, application: 2, system: 1, other: 0, pods: 11 });
  });

  it('refuses a pod total when any count is missing or the list was short', () => {
    expect(namespaceTypeCounts([ns('a', 2), ns('b', null)], null).pods).toBeNull();
    expect(namespaceTypeCounts([ns('a', 2)], { podCountReason: 'truncated' }).pods).toBeNull();
  });

  it('a refused namespace list is unavailable, never "0 namespaces · 0 pods"', () => {
    // safeList answers a 403 with items: [] inside an ok envelope; only the summary says so.
    const c = namespaceTypeCounts([], { podCountReason: null, unavailable: ['namespaces'] });
    expect(c.list).toBe('unavailable');
    expect(c.pods).toBeNull();
  });

  it('a truncated namespace list is a floor, and its pod total is withheld', () => {
    const c = namespaceTypeCounts([ns('a', 2)], { truncated: ['namespaces'] });
    expect(c.list).toBe('truncated');
    expect(c.total).toBe(1);
    expect(c.pods).toBeNull();
    // Another list's gap (the audit's secrets) is not the namespace list's.
    expect(namespaceTypeCounts([ns('a', 2)], { unavailable: ['secrets'] }).list).toBe('ok');
  });
});

describe('buildNamespaceTable', () => {
  it('keeps the namespace inventory on the left of the join and counts workloads, not pods', () => {
    const rows = buildNamespaceTable(
      [ns('polls', 3), ns('kyma-demo', 0), ns('kube-system', 9, true)],
      [util('polls', { pods: 3 })],
      [wl('polls', 'a'), wl('polls', 'b', { kind: 'StatefulSet' })]
    );
    expect(rows.map(r => r.namespace)).toEqual(['polls', 'kyma-demo', 'kube-system']);
    const polls = rows[0]!;
    expect(polls.workloads).toBe(2);
    expect(polls.usage.pods).toBe(3);
    expect(polls.type).toBe('application');
    expect(rows[2]!.type).toBe('system');
  });

  it('a namespace with zero pods is Empty, not Healthy', () => {
    const r = buildNamespaceTable([ns('kyma-demo', 0)], [], [])[0]!;
    expect(r.status).toBe('empty');
  });

  it('a Deployment wanting replicas it does not have is Critical even with zero pods', () => {
    const r = buildNamespaceTable(
      [ns('broken', 0)],
      [],
      [wl('broken', 'api', { ready: 0, desired: 2, healthy: false, state: 'Unavailable' })]
    )[0]!;
    expect(r.status).toBe('critical');
  });

  it('Above request is a Warning; at-limit and OOMKills are Critical', () => {
    const above = buildNamespaceTable([ns('a', 1)], [util('a', { memoryUsage: 380, memoryRequest: 320, memoryLimit: 1300 })], [wl('a', 'x')]);
    expect(above[0]!.status).toBe('warning');
    expect(above[0]!.statusReason).toMatch(/Above request/);

    const atLimit = buildNamespaceTable([ns('a', 1)], [util('a', { memoryUsage: 400, memoryLimit: 400 })], [wl('a', 'x')]);
    expect(atLimit[0]!.status).toBe('critical');

    const oom = buildNamespaceTable([ns('a', 1)], [util('a', { oomKilled: 1 })], [wl('a', 'x')]);
    expect(oom[0]!.status).toBe('critical');
  });

  it('a progressing workload is a Warning, a healthy one is Healthy', () => {
    const prog = buildNamespaceTable([ns('a', 1)], [util('a')], [wl('a', 'x', { healthy: false, state: 'Progressing' })]);
    expect(prog[0]!.status).toBe('warning');
    const ok = buildNamespaceTable([ns('a', 1)], [util('a')], [wl('a', 'x')]);
    expect(ok[0]!.status).toBe('healthy');
  });

  it('an unread pod count with nothing else known is Unknown, never Empty', () => {
    const r = buildNamespaceTable([ns('a', null)], [], [])[0]!;
    expect(r.status).toBe('unknown');
  });

  it('an incomplete workloads read never yields Healthy or Empty, but evidence still reads Critical', () => {
    const [quiet, empty] = buildNamespaceTable([ns('a', 5), ns('b', 0)], [], [], false);
    expect(quiet!.status).toBe('unknown');
    expect(empty!.status).toBe('unknown');
    const failing = buildNamespaceTable([ns('a', 1)], [util('a')], [wl('a', 'x', { healthy: false, state: 'CrashLoopBackOff' })], false)[0]!;
    expect(failing.status).toBe('critical');
  });

  it('pods that no Deployment, StatefulSet or DaemonSet owns are Unknown, not Healthy', () => {
    const r = buildNamespaceTable([ns('jobs', 3)], [], [])[0]!;
    expect(r.status).toBe('unknown');
    expect(r.statusReason).toMatch(/3 pods/);
  });

  it('Last Updated is the newest workload creation or rollout restart, and null with no workloads', () => {
    const rows = buildNamespaceTable(
      [ns('a', 2), ns('b', 0)],
      [],
      [
        wl('a', 'x', { createdAt: '2026-09-01T00:00:00Z', restartedAt: '2026-09-20T00:00:00Z' }),
        wl('a', 'y', { createdAt: '2026-09-10T00:00:00Z' })
      ]
    );
    expect(rows[0]!.lastUpdated).toBe('2026-09-20T00:00:00Z');
    expect(rows[1]!.lastUpdated).toBeNull();
  });
});

describe('resourceCell', () => {
  it('zero pods is "No pods", never a meter of zeros', () => {
    const r = buildNamespaceTable([ns('kyma-demo', 0)], [], [])[0]!;
    expect(resourceCell(r.usage)).toEqual({ kind: 'text', text: 'No pods', title: expect.any(String) });
  });

  it('an unread count with nothing measured is "No data"', () => {
    const r = buildNamespaceTable([ns('a', null)], [], [])[0]!;
    expect(resourceCell(r.usage).kind === 'text' && resourceCell(r.usage)).toMatchObject({ text: 'No data' });
  });

  it('pods that no workload selects are "Not measured", not zero', () => {
    const r = buildNamespaceTable([ns('jobs', 3)], [], [])[0]!;
    expect(resourceCell(r.usage)).toMatchObject({ kind: 'text', text: 'Not measured' });
  });

  it('measured pods draw the meter', () => {
    const r = buildNamespaceTable([ns('a', 1)], [util('a')], [wl('a', 'x')])[0]!;
    expect(resourceCell(r.usage)).toEqual({ kind: 'meter' });
  });
});

describe('filterNamespaceTable', () => {
  const rows = buildNamespaceTable(
    [ns('applecare', 2), ns('polls', 1), ns('kyma-demo', 0), ns('kube-system', 9, true)],
    [util('applecare'), util('polls', { memoryUsage: 380, memoryRequest: 320, memoryLimit: 1300 }), util('kube-system')],
    [wl('applecare', 'a'), wl('polls', 'p'), wl('kube-system', 'k')]
  );
  const all: NamespaceTableFilter = { search: '', showSystem: true, type: 'all', status: 'all' };
  const names = (f: Partial<NamespaceTableFilter>) => filterNamespaceTable(rows, { ...all, ...f }).map(r => r.namespace);

  it('search matches the name, case-insensitively and trimmed', () => {
    expect(names({ search: '  APPLE ' })).toEqual(['applecare']);
    expect(names({ search: 'zzz' })).toEqual([]);
  });

  it('shows application namespaces by default; system ones only on request', () => {
    const byDefault = filterNamespaceTable(rows, NO_NAMESPACE_FILTER).map(r => r.namespace);
    expect(byDefault).not.toContain('kube-system');
    expect(byDefault).toHaveLength(3);
    expect(names({ showSystem: true })).toContain('kube-system');
  });

  it('choosing Type = System shows them even with the toggle off, never an empty table', () => {
    expect(names({ type: 'system', showSystem: false })).toEqual(['kube-system']);
  });

  it('counts the toggle as a filter only when it is on', () => {
    expect(activeNamespaceFilters(NO_NAMESPACE_FILTER)).toBe(0);
    expect(activeNamespaceFilters({ ...NO_NAMESPACE_FILTER, showSystem: true })).toBe(1);
  });

  it('type and status filters combine with search', () => {
    expect(names({ type: 'system' })).toEqual(['kube-system']);
    expect(names({ status: 'empty' })).toEqual(['kyma-demo']);
    expect(names({ status: 'warning', type: 'application', search: 'po', showSystem: false })).toEqual(['polls']);
    expect(names({ type: 'other' })).toEqual([]);
  });
});

describe('hiddenSystemCount', () => {
  it('counts system namespaces only where the toggle would bring them back', () => {
    expect(hiddenSystemCount(NO_NAMESPACE_FILTER, 10)).toBe(10);
    expect(hiddenSystemCount({ ...NO_NAMESPACE_FILTER, showSystem: true }, 10)).toBe(0);
    // Type = Other/Application still excludes system rows with the toggle on, so it is no fix to offer.
    expect(hiddenSystemCount({ ...NO_NAMESPACE_FILTER, type: 'other' }, 10)).toBe(0);
    expect(hiddenSystemCount({ ...NO_NAMESPACE_FILTER, type: 'application' }, 10)).toBe(0);
    expect(hiddenSystemCount({ ...NO_NAMESPACE_FILTER, type: 'system' }, 10)).toBe(0);
  });
});

describe('withShowSystem', () => {
  const f = (over: Partial<NamespaceTableFilter>): NamespaceTableFilter => ({ ...NO_NAMESPACE_FILTER, ...over });

  it('widens Type to All when ticked under Application or Other, or it would change no row', () => {
    expect(withShowSystem(f({ type: 'application' }), true)).toEqual(f({ type: 'all', showSystem: true }));
    expect(withShowSystem(f({ type: 'other' }), true)).toEqual(f({ type: 'all', showSystem: true }));
  });

  it('keeps every other filter', () => {
    expect(withShowSystem(f({ search: 'kyma', status: 'warning' }), true)).toEqual(f({ search: 'kyma', status: 'warning', showSystem: true }));
  });

  it('reads as ticked under Type = System, and unticking it leaves System for All', () => {
    expect(showsSystem(f({ type: 'system' }))).toBe(true);
    expect(withShowSystem(f({ type: 'system' }), false)).toEqual(f({ type: 'all', showSystem: false }));
  });
});

describe('withType', () => {
  const f = (over: Partial<NamespaceTableFilter>): NamespaceTableFilter => ({ ...NO_NAMESPACE_FILTER, ...over });

  it('drops a ticked Show system when Type narrows to Application or Other, so the box never sits ticked over no system row', () => {
    const out = withType(f({ showSystem: true, search: 'x' }), 'application');
    expect(out).toEqual(f({ type: 'application', showSystem: false, search: 'x' }));
    expect(showsSystem(out)).toBe(false);
    expect(activeNamespaceFilters(out)).toBe(2);
    expect(withType(f({ showSystem: true }), 'other').showSystem).toBe(false);
  });

  it('keeps it when Type goes to All or System', () => {
    expect(withType(f({ showSystem: true, type: 'application' }), 'all').showSystem).toBe(true);
    expect(withType(f({ showSystem: true }), 'system').showSystem).toBe(true);
  });
});
