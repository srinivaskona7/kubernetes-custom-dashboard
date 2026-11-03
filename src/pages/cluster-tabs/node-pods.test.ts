/**
 * The Scheduled-pods join, tested for the three things it is allowed to claim.
 *
 * Each `describe` below corresponds to one of the three numbered rules in `node-pods.ts`, because
 * every one of them is a bug that ships silently: a dropped static pod looks like a shorter list, a
 * resolved owner looks like an answer, and a zero looks like an idle pod. None of them throws.
 */
import { describe, expect, it } from 'vitest';
import type { PodRow, WorkloadRow } from '../../api';
import {
  UNOWNED,
  activeNodePodFilters,
  filterNodePods,
  indexWorkloadPods,
  nodePodNamespaces,
  nodePodRows,
  nodePodWorkloads,
  type NodePodRow,
  type ScheduledPod
} from './node-pods';

const pod = (over: Partial<PodRow> = {}): PodRow =>
  ({
    name: 'api-1',
    namespace: 'ns-a',
    phase: 'Running',
    reason: null,
    restarts: 0,
    isOOMKilled: false,
    node: 'node-1',
    cpuUsage: null,
    memoryUsage: null,
    cpuRequest: null,
    memoryRequest: null,
    containers: [],
    ...over
  }) as PodRow;

const workload = (over: Partial<WorkloadRow> = {}): WorkloadRow =>
  ({
    kind: 'Deployment',
    name: 'api',
    namespace: 'ns-a',
    pods: [],
    ...over
  }) as WorkloadRow;

const scheduled = (over: Partial<ScheduledPod> = {}): ScheduledPod => ({
  name: 'api-1',
  namespace: 'ns-a',
  phase: 'Running',
  ...over
});

const named = (rows: readonly NodePodRow[]): string[] => rows.map(r => `${r.namespace}/${r.name}`);

describe('indexWorkloadPods', () => {
  it('keys by namespace/name so two namespaces can hold the same pod name', () => {
    const index = indexWorkloadPods([
      workload({ namespace: 'ns-a', pods: [pod({ namespace: 'ns-a', name: 'api-1' })] }),
      workload({ namespace: 'ns-b', name: 'api', pods: [pod({ namespace: 'ns-b', name: 'api-1' })] })
    ]);
    expect(index.size).toBe(2);
    expect(index.get('ns-a/api-1')?.owners).toEqual(['Deployment/api']);
    expect(index.get('ns-b/api-1')?.owners).toEqual(['Deployment/api']);
  });

  it('keeps every claimant when selectors overlap', () => {
    const shared = pod({ name: 'api-1' });
    const index = indexWorkloadPods([
      workload({ name: 'api-blue', pods: [shared] }),
      workload({ kind: 'StatefulSet', name: 'api-green', pods: [shared] })
    ]);
    expect(index.get('ns-a/api-1')?.owners).toEqual(['Deployment/api-blue', 'StatefulSet/api-green']);
  });

  it('does not repeat one workload that lists a pod twice', () => {
    const index = indexWorkloadPods([workload({ pods: [pod({ name: 'api-1' }), pod({ name: 'api-1' })] })]);
    expect(index.get('ns-a/api-1')?.owners).toEqual(['Deployment/api']);
  });
});

describe('nodePodRows — rule 1: podsList is the spine', () => {
  it('gives a row to a pod no workload selects, so the count matches the table', () => {
    const rows = nodePodRows(
      [scheduled({ name: 'etcd-node-1' }), scheduled({ name: 'api-1' })],
      indexWorkloadPods([workload({ pods: [pod({ name: 'api-1' })] })])
    );
    expect(rows).toHaveLength(2);
    expect(named(rows).sort()).toEqual(['ns-a/api-1', 'ns-a/etcd-node-1']);
  });

  it('never invents a row for a workload pod scheduled on another node', () => {
    const rows = nodePodRows([scheduled({ name: 'api-1' })], indexWorkloadPods([
      workload({ pods: [pod({ name: 'api-1' }), pod({ name: 'api-2', node: 'node-9' })] })
    ]));
    expect(named(rows)).toEqual(['ns-a/api-1']);
  });

  it('returns an empty list — not a throw — when workloads never loaded', () => {
    const rows = nodePodRows([scheduled()], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owners).toEqual([]);
    expect(rows[0]!.containers).toEqual([]);
  });
});

describe('nodePodRows — rule 2: ownership stays ambiguous', () => {
  it('reports both owners rather than choosing one', () => {
    const shared = pod({ name: 'api-1' });
    const rows = nodePodRows([scheduled({ name: 'api-1' })], indexWorkloadPods([
      workload({ name: 'api-blue', pods: [shared] }),
      workload({ name: 'api-green', pods: [shared] })
    ]));
    expect(rows[0]!.owners).toEqual(['Deployment/api-blue', 'Deployment/api-green']);
  });

  it('derives nothing from a pod name that looks like a workload name', () => {
    const rows = nodePodRows([scheduled({ name: 'api-7d9f8b4c6-x2k9p' })], indexWorkloadPods([
      workload({ name: 'api', pods: [pod({ name: 'api-someone-else' })] })
    ]));
    expect(rows[0]!.owners).toEqual([]);
  });

  it('copies the owner list so a later push cannot reach the index', () => {
    const index = indexWorkloadPods([workload({ pods: [pod({ name: 'api-1' })] })]);
    const rows = nodePodRows([scheduled({ name: 'api-1' })], index);
    rows[0]!.owners.push('Deployment/injected');
    expect(index.get('ns-a/api-1')?.owners).toEqual(['Deployment/api']);
  });
});

describe('nodePodRows — rule 3: a missing reading is null, never 0', () => {
  it('leaves usage null when metrics-server did not answer', () => {
    const rows = nodePodRows([scheduled()], indexWorkloadPods([workload({ pods: [pod()] })]));
    expect(rows[0]!.cpuUsage).toBeNull();
    expect(rows[0]!.memoryUsage).toBeNull();
  });

  it('keeps a genuine zero usage as zero', () => {
    const rows = nodePodRows([scheduled()], indexWorkloadPods([
      workload({ pods: [pod({ cpuUsage: 0, memoryUsage: 0 })] })
    ]));
    expect(rows[0]!.cpuUsage).toBe(0);
    expect(rows[0]!.memoryUsage).toBe(0);
  });

  it('keeps a declared zero request distinct from an absent one', () => {
    const withZero = nodePodRows([scheduled({ cpuRequested: 0 })], new Map())[0]!;
    const without = nodePodRows([scheduled()], new Map())[0]!;
    expect(withZero.cpuRequest).toBe(0);
    expect(without.cpuRequest).toBeNull();
  });

  it('prefers the node’s own restart count and falls through to the workload’s', () => {
    const index = indexWorkloadPods([workload({ pods: [pod({ restarts: 7 })] })]);
    expect(nodePodRows([scheduled({ restarts: 2 })], index)[0]!.restarts).toBe(2);
    expect(nodePodRows([scheduled()], index)[0]!.restarts).toBe(7);
  });

  it('reports null restarts when neither side counted, and 0 when the node did', () => {
    expect(nodePodRows([scheduled()], new Map())[0]!.restarts).toBeNull();
    expect(nodePodRows([scheduled({ restarts: 0 })], new Map())[0]!.restarts).toBe(0);
  });

  it('takes reason, OOMKilled and containers from the workload side', () => {
    const rows = nodePodRows([scheduled()], indexWorkloadPods([
      workload({
        pods: [pod({ reason: 'CrashLoopBackOff', isOOMKilled: true, containers: [{ name: 'api' }, { name: 'istio-proxy' }] as PodRow['containers'] })]
      })
    ]));
    expect(rows[0]!.reason).toBe('CrashLoopBackOff');
    expect(rows[0]!.isOOMKilled).toBe(true);
    expect(rows[0]!.containers).toEqual(['api', 'istio-proxy']);
  });

  it('keeps the node’s phase, which is the fresher fact for a pod on that node', () => {
    const rows = nodePodRows([scheduled({ phase: 'Failed' })], indexWorkloadPods([
      workload({ pods: [pod({ phase: 'Running' })] })
    ]));
    expect(rows[0]!.phase).toBe('Failed');
  });
});

describe('nodePodRows — order', () => {
  it('sorts reason, then bad phase, then restarts, then healthy; ties by namespace/name', () => {
    const index = indexWorkloadPods([
      workload({
        pods: [
          pod({ name: 'crash', reason: 'CrashLoopBackOff' }),
          pod({ name: 'oom', isOOMKilled: true })
        ]
      })
    ]);
    const rows = nodePodRows(
      [
        scheduled({ name: 'zebra' }),
        scheduled({ name: 'alpha' }),
        scheduled({ name: 'restarted', restarts: 3 }),
        scheduled({ name: 'pending', phase: 'Pending' }),
        scheduled({ name: 'crash' }),
        scheduled({ name: 'oom' })
      ],
      index
    );
    expect(named(rows)).toEqual([
      'ns-a/crash',
      'ns-a/oom',
      'ns-a/pending',
      'ns-a/restarted',
      'ns-a/alpha',
      'ns-a/zebra'
    ]);
  });

  it('treats Succeeded as healthy, so a finished Job does not rank as a problem', () => {
    const rows = nodePodRows([scheduled({ name: 'job-1', phase: 'Succeeded' }), scheduled({ name: 'pending-1', phase: 'Pending' })], new Map());
    expect(named(rows)).toEqual(['ns-a/pending-1', 'ns-a/job-1']);
  });
});

describe('filter options', () => {
  const rows = nodePodRows(
    [scheduled({ name: 'a', namespace: 'ns-b' }), scheduled({ name: 'b', namespace: 'ns-a' }), scheduled({ name: 'c', namespace: 'ns-a' })],
    indexWorkloadPods([
      workload({ name: 'blue', pods: [pod({ namespace: 'ns-a', name: 'b' })] }),
      workload({ name: 'green', pods: [pod({ namespace: 'ns-a', name: 'b' })] })
    ])
  );

  it('offers only the namespaces present on this node, sorted', () => {
    expect(nodePodNamespaces(rows)).toEqual(['ns-a', 'ns-b']);
  });

  it('offers every claimant of an ambiguously owned pod', () => {
    expect(nodePodWorkloads(rows)).toEqual(['Deployment/blue', 'Deployment/green']);
  });

  it('offers no workload option when nothing on the node is owned', () => {
    expect(nodePodWorkloads(nodePodRows([scheduled()], new Map()))).toEqual([]);
  });
});

describe('filterNodePods', () => {
  const rows = nodePodRows(
    [
      scheduled({ name: 'api-1', namespace: 'ns-a' }),
      scheduled({ name: 'api-2', namespace: 'ns-b' }),
      scheduled({ name: 'etcd-node-1', namespace: 'kube-system' })
    ],
    indexWorkloadPods([
      workload({ namespace: 'ns-a', name: 'api', pods: [pod({ namespace: 'ns-a', name: 'api-1' })] }),
      workload({ namespace: 'ns-b', name: 'web', pods: [pod({ namespace: 'ns-b', name: 'api-2' })] })
    ])
  );

  it('an empty filter narrows nothing', () => {
    expect(filterNodePods(rows, { namespace: '', workload: '', search: '' })).toHaveLength(3);
  });

  it('the namespace filter actually filters the node’s pods', () => {
    expect(named(filterNodePods(rows, { namespace: 'ns-b', workload: '', search: '' }))).toEqual(['ns-b/api-2']);
  });

  it('the workload filter matches one claimant of an ambiguous pod', () => {
    expect(named(filterNodePods(rows, { namespace: '', workload: 'Deployment/web', search: '' }))).toEqual(['ns-b/api-2']);
  });

  it('UNOWNED selects exactly the pods no workload claims', () => {
    expect(named(filterNodePods(rows, { namespace: '', workload: UNOWNED, search: '' }))).toEqual([
      'kube-system/etcd-node-1'
    ]);
  });

  it('search is case-insensitive, trimmed, and matches the pod name only', () => {
    expect(named(filterNodePods(rows, { namespace: '', workload: '', search: '  API-1 ' }))).toEqual(['ns-a/api-1']);
    expect(filterNodePods(rows, { namespace: '', workload: '', search: 'ns-a' })).toHaveLength(0);
  });

  it('combines all three as an AND', () => {
    expect(filterNodePods(rows, { namespace: 'ns-a', workload: 'Deployment/web', search: '' })).toHaveLength(0);
    expect(named(filterNodePods(rows, { namespace: 'ns-a', workload: 'Deployment/api', search: 'api' }))).toEqual([
      'ns-a/api-1'
    ]);
  });

  it('does not mutate the input', () => {
    const before = named(rows);
    filterNodePods(rows, { namespace: 'ns-a', workload: '', search: 'x' });
    expect(named(rows)).toEqual(before);
  });
});

describe('activeNodePodFilters', () => {
  it('counts each narrowing filter once', () => {
    expect(activeNodePodFilters({ namespace: '', workload: '', search: '' })).toBe(0);
    expect(activeNodePodFilters({ namespace: 'ns-a', workload: '', search: '' })).toBe(1);
    expect(activeNodePodFilters({ namespace: 'ns-a', workload: UNOWNED, search: 'api' })).toBe(3);
  });

  it('does not count whitespace as a search', () => {
    expect(activeNodePodFilters({ namespace: '', workload: '', search: '   ' })).toBe(0);
  });
});

/**
 * The limit-proximity join.
 *
 * The node's own pod list carries no limits and no per-container usage, so this comes entirely from
 * the workloads side. The two failures worth pinning: a pod the workload join missed must be `null`
 * rather than "fine", and a CPU figure must never produce a memory verdict.
 */
describe('nodePodRows — limit proximity', () => {
  const container = (over: Record<string, unknown> = {}) =>
    ({
      name: 'app',
      cpuRequest: 0.1,
      cpuLimit: 1,
      memoryRequest: 128 * 1024 * 1024,
      memoryLimit: 512 * 1024 * 1024,
      cpuUsage: 0.1,
      memoryUsage: 100 * 1024 * 1024,
      ...over
    }) as PodRow['containers'][number];

  it('reports the container closest to a memory limit, and names it', () => {
    const rows = nodePodRows(
      [scheduled()],
      indexWorkloadPods([
        workload({
          pods: [
            pod({
              containers: [
                container({ name: 'istio-proxy', memoryUsage: 20 * 1024 * 1024 }),
                container({ name: 'app', memoryUsage: 500 * 1024 * 1024 })
              ]
            })
          ]
        })
      ])
    );
    expect(rows[0]!.limitRisk?.container).toBe('app');
    expect(rows[0]!.limitRisk?.unit).toBe('memory');
    expect(rows[0]!.limitRisk?.level).toBe('critical');
  });

  it('reports a container at its CPU limit as a CPU finding, never a memory one', () => {
    const rows = nodePodRows(
      [scheduled()],
      indexWorkloadPods([workload({ pods: [pod({ containers: [container({ cpuUsage: 1 })] })] })])
    );
    expect(rows[0]!.limitRisk?.unit).toBe('cpu');
    expect(rows[0]!.limitRisk?.badge).toMatch(/throttl/i);
  });

  it('is null for a container comfortably inside both limits', () => {
    const rows = nodePodRows(
      [scheduled()],
      indexWorkloadPods([workload({ pods: [pod({ containers: [container()] })] })])
    );
    expect(rows[0]!.limitRisk).toBeNull();
  });

  it('is null — not "fine" — for a pod the workload join never matched', () => {
    const rows = nodePodRows([scheduled({ name: 'static-pod' })], new Map());
    expect(rows[0]!.limitRisk).toBeNull();
  });

  it('is null when no usage sample exists, because proximity cannot be measured without one', () => {
    const rows = nodePodRows(
      [scheduled()],
      indexWorkloadPods([
        workload({ pods: [pod({ containers: [container({ cpuUsage: null, memoryUsage: null })] })] })
      ])
    );
    expect(rows[0]!.limitRisk).toBeNull();
  });

  it('is null when a container declares no limit at all: there is no limit to approach', () => {
    const rows = nodePodRows(
      [scheduled()],
      indexWorkloadPods([
        workload({
          pods: [
            pod({
              containers: [container({ cpuLimit: 0, memoryLimit: 0, memoryUsage: 4 * 1024 * 1024 * 1024 })]
            })
          ]
        })
      ])
    );
    expect(rows[0]!.limitRisk).toBeNull();
  });
});

describe('nodePodRows — the figures behind the badge', () => {
  it('carries the share of the limit and the limit itself, so the explanation need not re-derive them', () => {
    const rows = nodePodRows(
      [scheduled()],
      indexWorkloadPods([
        workload({
          pods: [
            pod({
              containers: [
                {
                  name: 'app',
                  cpuRequest: 0.1,
                  cpuLimit: 1,
                  memoryRequest: 128 * 1024 * 1024,
                  memoryLimit: 512 * 1024 * 1024,
                  cpuUsage: 0.1,
                  memoryUsage: 486 * 1024 * 1024
                } as PodRow['containers'][number]
              ]
            })
          ]
        })
      ])
    );
    const risk = rows[0]!.limitRisk!;
    expect(risk.percentOfLimit).toBeCloseTo(0.949, 2);
    // Formatted the way the rest of the console formats a byte figure, not as a raw number.
    expect(risk.limitText).toMatch(/512 MiB|512MiB/);
  });
});
