/**
 * The Top Utilization model.
 *
 * These pin the claims the tab makes on screen, in the order they can go wrong:
 *
 *  1. a ratio never renders as Infinity, NaN or a confident 0 when its basis is unset,
 *  2. an unreadable sample never aggregates as zero,
 *  3. a heuristic is marked as one, and OOM is never inferred from a usage figure,
 *  4. no total double-counts a pod that two Deployments both selected.
 *
 * Every fixture below is shaped like the real `/clusters/:id/workloads` payload, including the
 * two encodings that trip people up: `0` for "no limit declared" and `null` for "no reading".
 */
import { describe, expect, it } from 'vitest';
import {
  MEMORY_CRITICAL_FRACTION,
  MEMORY_NEAR_FRACTION,
  aggregatePodResources,
  buildUtilizationModel,
  clusterShare,
  namespaceRows,
  normalizeCpu,
  normalizeMemory,
  podCoverage,
  rankTopN,
  ratio,
  requestHeadroom,
  resourcePressure,
  schedulingCause,
  utilizationPods
} from './utilization-model';
import { flattenPods } from '../pod-inventory';
import type { WorkloadRow } from '../../../api';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/* ---------------------------------------------------------------- normalisation */

describe('normalisation', () => {
  it('passes a real reading through untouched', () => {
    expect(normalizeCpu(0.32)).toBe(0.32);
    expect(normalizeMemory(52_396_032)).toBe(52_396_032);
  });

  it('treats an absent reading as absent, not as zero', () => {
    expect(normalizeCpu(null)).toBeNull();
    expect(normalizeCpu(undefined)).toBeNull();
    expect(normalizeMemory(null)).toBeNull();
  });

  it('refuses the values that would poison a percentage', () => {
    // NaN and Infinity arrive from upstream arithmetic; a negative core count is a bug that would
    // otherwise render as a negative percentage of a request.
    expect(normalizeCpu(Number.NaN)).toBeNull();
    expect(normalizeCpu(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeCpu(-1)).toBeNull();
    expect(normalizeMemory(-1)).toBeNull();
  });

  it('keeps a genuine zero reading, which is different from no reading', () => {
    // An idle container really does report 0 cores. That is a fact, and it must not become "—".
    expect(normalizeCpu(0)).toBe(0);
    expect(normalizeMemory(0)).toBe(0);
  });
});

/* ----------------------------------------------------------------------- ratio */

describe('ratio', () => {
  it('is a fraction when both sides are real, and carries its denominator', () => {
    const r = ratio(0.5, 2);
    expect(r).toEqual({ state: 'ratio', value: 0.25, usage: 0.5, basis: 2 });
  });

  it('answers no-basis rather than Infinity when nothing was declared', () => {
    // This is the whole reason the return type is a union: `0.5 / 0` is Infinity, and
    // `Infinity * 100` renders as "Infinity%" on a dashboard an operator is meant to trust.
    expect(ratio(0.5, 0)).toEqual({ state: 'no-basis' });
    expect(ratio(0, 0)).toEqual({ state: 'no-basis' });
  });

  it('answers unknown when the sample could not be read, never 0%', () => {
    expect(ratio(null, 2)).toEqual({ state: 'unknown' });
  });

  it('allows a fraction above 1, because exceeding a request is legal', () => {
    const r = ratio(3, 2);
    expect(r).toMatchObject({ state: 'ratio', value: 1.5 });
  });
});

describe('clusterShare', () => {
  it('is a fraction of the cluster total', () => {
    expect(clusterShare(1, 4)).toBe(0.25);
  });

  it('is null when the total is unreadable, zero or absent', () => {
    // A share of an unknown total is the most misleading number this tab could print.
    expect(clusterShare(1, null)).toBeNull();
    expect(clusterShare(1, 0)).toBeNull();
    expect(clusterShare(null, 4)).toBeNull();
  });
});

describe('requestHeadroom', () => {
  it('is request minus the current sample', () => {
    expect(requestHeadroom(0.3, 1)).toBeCloseTo(0.7);
  });

  it('goes negative when the sample is above the request, rather than clamping', () => {
    // Clamping at zero would erase the only case an operator is looking for on this column.
    expect(requestHeadroom(1.5, 1)).toBeCloseTo(-0.5);
  });

  it('is null when there is no request, because headroom against nothing is not zero', () => {
    expect(requestHeadroom(0.3, 0)).toBeNull();
  });

  it('is null when the sample is unreadable', () => {
    expect(requestHeadroom(null, 1)).toBeNull();
  });
});

/* ------------------------------------------------------------------ aggregates */

const container = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'app',
  image: 'img',
  imageDigest: null,
  runtimeImage: null,
  envKeys: [],
  envFrom: [],
  init: false,
  ready: true,
  restarts: 0,
  state: 'running',
  reason: null,
  lastStateReason: null,
  lastExitCode: null,
  isOOMKilled: false,
  cpuRequest: 0.1,
  cpuLimit: 0.5,
  memoryRequest: 128 * MiB,
  memoryLimit: 256 * MiB,
  cpuUsage: 0.05,
  memoryUsage: 64 * MiB,
  ...over
});

describe('aggregatePodResources', () => {
  it('never lets two unreadable pods look like two idle pods', () => {
    // The measured shape of the honesty rule: a namespace of three pods where two cannot be read
    // must not present one pod's usage as the namespace's total.
    const agg = aggregatePodResources([
      { cpuUsage: 1, memoryUsage: GiB, cpuRequest: 1, memoryRequest: GiB },
      { cpuUsage: null, memoryUsage: null, cpuRequest: 1, memoryRequest: GiB },
      { cpuUsage: null, memoryUsage: null, cpuRequest: 1, memoryRequest: GiB }
    ]);
    expect(agg.cpuUsage).toBe(1);
    expect(agg.usageMissing).toBe(2);
    expect(agg.counted).toBe(3);
    // Requests are declared, not sampled, so they are complete even when usage is not.
    expect(agg.cpuRequest).toBe(3);
  });

  it('counts a pod with one readable resource as present for that one only', () => {
    const agg = aggregatePodResources([{ cpuUsage: 1, memoryUsage: null }]);
    expect(agg.cpuUsage).toBe(1);
    expect(agg.memoryUsage).toBeNull();
    expect(agg.usageMissing).toBe(0);
  });
});

/* -------------------------------------------------------------------- rankTopN */

describe('rankTopN', () => {
  const rows = [{ v: 3 }, { v: 10 }, { v: null }, { v: 7 }];

  it('is largest first', () => {
    expect(rankTopN(rows, r => r.v, 'all').map(r => r.v)).toEqual([10, 7, 3, null]);
  });

  it('sorts an unreadable value last rather than as zero', () => {
    // Bottom of a "top consumers" list is the only placement that asserts nothing false about it.
    const out = rankTopN([{ v: null }, { v: 0 }], r => r.v, 'all');
    expect(out.map(r => r.v)).toEqual([0, null]);
  });

  it('still returns an unreadable row when it falls inside N', () => {
    expect(rankTopN(rows, r => r.v, 10)).toHaveLength(4);
  });

  it('takes exactly N', () => {
    expect(rankTopN(rows, r => r.v, 10)).toHaveLength(4);
    expect(rankTopN(rows, r => r.v, 20)).toHaveLength(4);
    expect(rankTopN([...rows, ...rows, ...rows], r => r.v, 10)).toHaveLength(10);
  });

  it('is stable for ties, so the list does not reshuffle on refresh', () => {
    const tied = [{ id: 'a', v: 5 }, { id: 'b', v: 5 }, { id: 'c', v: 5 }];
    expect(rankTopN(tied, r => r.v, 'all').map(r => r.id)).toEqual(['a', 'b', 'c']);
  });
});

/* ------------------------------------------------------------ scheduling cause */

describe('schedulingCause', () => {
  const cond = (reason: string, message: string) => [
    { type: 'PodScheduled', status: 'False', reason, message }
  ];

  it('says nothing about a scheduled pod', () => {
    expect(schedulingCause([{ type: 'PodScheduled', status: 'True', reason: null, message: null }])).toEqual({
      unschedulable: false,
      cause: null,
      message: null
    });
  });

  it('quotes the scheduler when the scheduler named a resource', () => {
    const out = schedulingCause(
      cond('Unschedulable', '0/3 nodes are available: 3 Insufficient cpu. preemption: not eligible')
    );
    expect(out.unschedulable).toBe(true);
    expect(out.cause).toBe('Insufficient CPU');
  });

  it('names both resources when the scheduler named both', () => {
    const out = schedulingCause(cond('Unschedulable', '3 Insufficient cpu, 2 Insufficient memory.'));
    expect(out.cause).toBe('Insufficient CPU, Insufficient memory');
  });

  it('invents no cause when the scheduler gave none', () => {
    // The rule verbatim: display "Unschedulable" without an invented cause. A pod pending on an
    // image pull is not a capacity problem, and guessing sends the operator to the wrong tab.
    const out = schedulingCause(cond('Unschedulable', ''));
    expect(out.unschedulable).toBe(true);
    expect(out.cause).toBeNull();
  });

  it('does not read a capacity cause into a taint or affinity failure', () => {
    expect(schedulingCause(cond('Unschedulable', '3 node(s) had untolerated taint {x: y}')).cause).toBe(
      'Untolerated taint'
    );
  });

  it('handles a pod with no conditions at all', () => {
    expect(schedulingCause(undefined).unschedulable).toBe(false);
    expect(schedulingCause([]).unschedulable).toBe(false);
  });
});

/* ---------------------------------------------------------------- pressure */

describe('resourcePressure', () => {
  it('reports OOMKilled only from the kubelet reason, and names the container', () => {
    const out = resourcePressure({
      containers: [container({ name: 'app', lastStateReason: 'OOMKilled', isOOMKilled: true })]
    });
    const oom = out.find(f => f.kind === 'oom-killed');
    expect(oom?.basis).toBe('proven');
    expect(oom?.detail).toBe('app');
  });

  it('never infers OOM from a high memory sample', () => {
    // The explicit prohibition. 99.9% of a limit is 99.9% of a limit; plenty of containers live
    // there for months without ever being killed.
    const out = resourcePressure({ memoryUsage: 999 * MiB, memoryLimit: 1000 * MiB, containers: [container()] });
    expect(out.some(f => f.kind === 'oom-killed')).toBe(false);
    expect(out.some(f => f.kind === 'memory-critical')).toBe(true);
  });

  it('marks the memory proximity bands as heuristic, because Kubernetes defines no such state', () => {
    const critical = resourcePressure({ memoryUsage: 0.95 * GiB, memoryLimit: GiB });
    const near = resourcePressure({ memoryUsage: 0.85 * GiB, memoryLimit: GiB });
    expect(critical.find(f => f.kind === 'memory-critical')?.basis).toBe('heuristic');
    expect(near.find(f => f.kind === 'memory-near-limit')?.basis).toBe('heuristic');
  });

  it('puts the band boundaries exactly where the constants say', () => {
    const at = (f: number) => resourcePressure({ memoryUsage: f * GiB, memoryLimit: GiB }).map(x => x.kind);
    expect(at(MEMORY_CRITICAL_FRACTION)).toContain('memory-critical');
    expect(at(MEMORY_NEAR_FRACTION)).toContain('memory-near-limit');
    expect(at(MEMORY_NEAR_FRACTION - 0.01)).not.toContain('memory-near-limit');
  });

  it('reports no memory band at all when no limit is declared', () => {
    const out = resourcePressure({ memoryUsage: 8 * GiB, memoryLimit: 0 });
    expect(out.some(f => f.kind.startsWith('memory-'))).toBe(false);
  });

  it('calls CPU above the request "Above request", never an error and never throttling', () => {
    const out = resourcePressure({ cpuUsage: 1.5, cpuRequest: 1 });
    const burst = out.find(f => f.kind === 'above-cpu-request');
    expect(burst?.label).toBe('Above request');
    for (const f of out) {
      expect(f.label.toLowerCase()).not.toContain('error');
      expect(f.label.toLowerCase()).not.toContain('throttl');
      expect(f.detail.toLowerCase()).not.toContain('throttl');
    }
  });

  it('never reports throttling, which needs a cgroup counter this fleet does not expose', () => {
    // Usage at the CPU *limit* is the shape most likely to tempt an inference. There is none.
    const out = resourcePressure({ cpuUsage: 1, cpuLimit: 1, cpuRequest: 1 });
    expect(out.map(f => f.kind)).not.toContain('throttled');
    expect(JSON.stringify(out).toLowerCase()).not.toContain('throttl');
  });

  it('reports restarts as a count with no claim about the cause', () => {
    const out = resourcePressure({ restarts: 7 });
    const r = out.find(f => f.kind === 'restarts');
    expect(r?.label).toBe('7 restarts');
    expect(r?.basis).toBe('proven');
  });

  it('is silent about a healthy pod', () => {
    expect(resourcePressure({ cpuUsage: 0.05, cpuRequest: 1, memoryUsage: 64 * MiB, memoryLimit: GiB })).toEqual([]);
  });

  it('orders findings worst first', () => {
    const out = resourcePressure({
      restarts: 3,
      cpuUsage: 2,
      cpuRequest: 1,
      memoryUsage: 0.95 * GiB,
      memoryLimit: GiB,
      containers: [container({ lastStateReason: 'OOMKilled' })],
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '' }]
    });
    expect(out.map(f => f.kind)).toEqual([
      'oom-killed',
      'unschedulable',
      'memory-critical',
      'restarts',
      'above-cpu-request'
    ]);
  });
});

/* ------------------------------------------------------------- rows and totals */

describe('utilizationPods', () => {
  const pod = {
    name: 'api-1',
    namespace: 'shop',
    node: 'node-a',
    phase: 'Running',
    qosClass: 'Burstable',
    restarts: 0,
    owners: ['Deployment/api'],
    cpuUsage: 0.5,
    cpuRequest: 1,
    cpuLimit: 0,
    memoryUsage: 512 * MiB,
    memoryRequest: GiB,
    memoryLimit: 2 * GiB,
    containers: [container()]
  };

  it('precomputes every ratio the tables print, each with its own basis', () => {
    const row = utilizationPods([pod], { cpuUsage: 1, memoryUsage: GiB })[0]!;
    expect(row.cpuOfRequest).toMatchObject({ state: 'ratio', value: 0.5 });
    // No CPU limit declared: the cell must say "No limit", not 0% and not Infinity.
    expect(row.cpuOfLimit).toEqual({ state: 'no-basis' });
    expect(row.memoryOfLimit).toMatchObject({ state: 'ratio', value: 0.25 });
    expect(row.cpuShare).toBe(0.5);
  });

  it('carries the owner ambiguity forward instead of resolving it', () => {
    const row = utilizationPods([{ ...pod, owners: ['Deployment/a', 'Deployment/b'] }], {
      cpuUsage: 1,
      memoryUsage: GiB
    })[0]!;
    expect(row.owners).toEqual(['Deployment/a', 'Deployment/b']);
  });
});

describe('namespaceRows', () => {
  it('aggregates its pods and counts the reasons to look', () => {
    const pods = utilizationPods(
      [
        {
          name: 'a',
          namespace: 'shop',
          cpuUsage: 1,
          memoryUsage: 0.95 * GiB,
          memoryLimit: GiB,
          cpuRequest: 1,
          restarts: 2,
          containers: [container({ lastStateReason: 'OOMKilled' })]
        },
        { name: 'b', namespace: 'shop', cpuUsage: 1, memoryUsage: GiB, cpuRequest: 1 },
        { name: 'c', namespace: 'infra', cpuUsage: 2, memoryUsage: GiB, cpuRequest: 4 }
      ],
      { cpuUsage: 4, memoryUsage: 4 * GiB }
    );
    const rows = namespaceRows(pods, { cpuUsage: 4, memoryUsage: 4 * GiB });
    const shop = rows.find(r => r.namespace === 'shop');
    expect(shop?.pods).toBe(2);
    expect(shop?.cpuUsage).toBe(2);
    expect(shop?.cpuShare).toBe(0.5);
    expect(shop?.oomKilled).toBe(1);
    expect(shop?.nearMemoryLimit).toBe(1);
    expect(shop?.restarts).toBe(2);
    expect(rows.find(r => r.namespace === 'infra')?.cpuOfRequest).toMatchObject({ state: 'ratio', value: 0.5 });
  });

  it('keeps a namespace whose usage is entirely unreadable as unreadable', () => {
    const pods = utilizationPods(
      [{ name: 'a', namespace: 'dark', cpuUsage: null, memoryUsage: null, cpuRequest: 1 }],
      { cpuUsage: null, memoryUsage: null }
    );
    const row = namespaceRows(pods, { cpuUsage: null, memoryUsage: null })[0]!;
    expect(row.cpuUsage).toBeNull();
    expect(row.usageMissing).toBe(1);
    expect(row.cpuOfRequest).toEqual({ state: 'unknown' });
    expect(row.cpuShare).toBeNull();
  });
});

/* ------------------------------------------------------------------- coverage */

describe('podCoverage', () => {
  it('reports the pods this payload cannot see', () => {
    // 121 pods on the cluster, 98 of them selected by a Deployment/StatefulSet/DaemonSet. The
    // other 23 are Job, CronJob and bare pods, and no table on this tab has a row for them.
    expect(podCoverage(98, 121)).toEqual({ covered: 98, total: 121, outside: 23 });
  });

  it('never reports a negative remainder', () => {
    expect(podCoverage(10, 5).outside).toBe(0);
  });

  it('falls back to the covered count when the total is unknown, claiming no gap it cannot prove', () => {
    expect(podCoverage(10, null)).toEqual({ covered: 10, total: 10, outside: 0 });
  });
});

/* --------------------------------------------------------------- whole model */

const workload = (name: string, pods: unknown[]): WorkloadRow =>
  ({
    name,
    namespace: 'platform-system',
    cluster: 'c',
    kind: 'Deployment',
    ready: 1,
    desired: 1,
    state: 'Ready',
    healthy: true,
    image: null,
    restarts: 0,
    createdAt: '',
    nodes: [],
    restartedAt: null,
    updatedReplicas: 1,
    availableReplicas: 1,
    generation: 1,
    observedGeneration: 1,
    restartable: true,
    cpuRequest: 1,
    cpuLimit: 0,
    memoryRequest: GiB,
    memoryLimit: 0,
    cpuUsage: 0.5,
    memoryUsage: 512 * MiB,
    pods
  }) as unknown as WorkloadRow;

const sharedPod = {
  name: 'controller-manager-abc',
  namespace: 'platform-system',
  phase: 'Running',
  restarts: 0,
  isOOMKilled: false,
  reason: null,
  message: null,
  startedAt: null,
  node: 'node-a',
  nodeSelector: null,
  podIP: null,
  qosClass: 'Burstable',
  conditions: [],
  containers: [container()],
  cpuRequest: 1,
  cpuLimit: 0,
  memoryRequest: GiB,
  memoryLimit: 0,
  cpuUsage: 0.5,
  memoryUsage: 512 * MiB
};

describe('buildUtilizationModel', () => {
  it('counts a pod claimed by three overlapping selectors exactly once', () => {
    // Three Deployments in platform-system share `control-plane: controller-manager`, so the same pod
    // is legitimately present under all three. Summing the flattened list would report three
    // times this pod's memory in the cluster total and in its namespace row.
    const model = buildUtilizationModel(
      [workload('a', [sharedPod]), workload('b', [sharedPod]), workload('c', [sharedPod])],
      1,
      flattenPods
    );
    expect(model.pods).toHaveLength(1);
    expect(model.cluster.memoryUsage).toBe(512 * MiB);
    expect(model.pods[0]?.owners).toEqual(['Deployment/a', 'Deployment/b', 'Deployment/c']);
    expect(model.namespaces[0]?.pods).toBe(1);
  });

  it('makes every pod share sum to one, which only holds because of the de-duplication', () => {
    const model = buildUtilizationModel(
      [
        workload('a', [sharedPod, { ...sharedPod, name: 'other', memoryUsage: 512 * MiB }]),
        workload('b', [sharedPod])
      ],
      2,
      flattenPods
    );
    const total = model.pods.reduce((n, p) => n + (p.memoryShare ?? 0), 0);
    expect(total).toBeCloseTo(1);
  });

  it('reports the pods outside the workloads payload rather than implying it is the cluster', () => {
    const model = buildUtilizationModel([workload('a', [sharedPod])], 121, flattenPods);
    expect(model.coverage).toEqual({ covered: 1, total: 121, outside: 120 });
  });

  it('lists namespaces for the filter, sorted and unique', () => {
    const model = buildUtilizationModel(
      [
        workload('a', [sharedPod]),
        workload('b', [{ ...sharedPod, name: 'z', namespace: 'app' }]),
        workload('c', [{ ...sharedPod, name: 'y', namespace: 'app' }])
      ],
      3,
      flattenPods
    );
    expect(model.namespaceNames).toEqual(['app', 'platform-system']);
  });

  it('survives an empty cluster without inventing a zero usage', () => {
    const model = buildUtilizationModel([], 0, flattenPods);
    expect(model.pods).toEqual([]);
    expect(model.cluster.cpuUsage).toBeNull();
    expect(model.coverage.outside).toBe(0);
  });
});
