/**
 * Every number the Top Utilization tab prints, computed here and nowhere else.
 *
 * ## Why a module and not arithmetic in JSX
 *
 * The four detail sections and the Overview all answer the same questions at different scopes —
 * container, pod, namespace, cluster. When that arithmetic lives in each view, the views drift:
 * one divides by the request, one by the limit, one treats a missing sample as zero, and the
 * screen shows three different truths about one pod. Everything below is pure, and the sections
 * are rendering only.
 *
 * ## The three rules the types enforce
 *
 * 1. **A ratio has no value unless its basis does.** `ratio()` returns a discriminated union, so a
 *    pod with no memory limit cannot render as `Infinity%` or as `0%` — the view is forced to
 *    handle `no-basis` and print "No limit". Kubernetes has no zero limit, so `0` on the wire
 *    means "unset" unambiguously (see `srv/fleet/collectors/metrics.js`).
 * 2. **A missing sample is not a zero.** Every aggregate carries `usageMissing`, the number of
 *    members that contributed no reading while metrics were available. Two unreadable pods make a
 *    namespace *partial*, never a namespace whose usage happens to be lower.
 * 3. **A heuristic says so.** `resourcePressure()` marks each finding `proven` or `heuristic`.
 *    OOMKilled is proven — the kubelet wrote the word. "Near memory limit" is a threshold this
 *    console chose, and the view is obliged to label it as one.
 *
 * ## What the usage number actually is
 *
 * `cpuUsage` / `memoryUsage` come from `metrics.k8s.io/v1beta1`, parsed by
 * `srv/fleet/collectors/quantity.js` into cores and bytes. The payload this console receives keeps
 * the value and drops the metrics-server `window` and `timestamp` fields, so the only defensible
 * description is **a current sample**. There is no history behind it: no trend, no average over
 * time, no p95 of anything. `USAGE_SAMPLE_NOTE` is the sentence every view prints rather than
 * inventing its own.
 */
import type { PodRow, WorkloadRow } from '../../../api';

/**
 * What a usage figure on this tab is, in one sentence, printed verbatim wherever one appears.
 *
 * A single string rather than per-view prose: the claim is load-bearing (it is the reason no view
 * offers a time-range control) and it must not weaken by paraphrase.
 */
export const USAGE_SAMPLE_NOTE =
  'Usage is a current sample from the metrics API, not an average over time. This console keeps no history, so there is no trend or historical utilization behind these numbers.';

/* ------------------------------------------------------------------ normalisation */

/**
 * A CPU reading in cores, or `null` when there is no reading.
 *
 * The wire value is already numeric — `quantity.js` did the suffix work server-side — so this is
 * the gate against the shapes that arrive anyway: `null` from a pod the metrics API did not
 * report, and `NaN`/`Infinity` from arithmetic upstream. A negative core count is not a reading
 * either; it is a bug somewhere, and passing it through would produce a negative percentage.
 */
export function normalizeCpu(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

/** Bytes, or `null` when there is no reading. Same contract as {@link normalizeCpu}. */
export function normalizeMemory(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * A declared request or limit, in base units.
 *
 * Always a number, never null: the wire spells "not set" as `0`, and that encoding is safe because
 * Kubernetes rejects a literal zero limit and treats a zero request as no request. Downstream,
 * `0` is what makes {@link ratio} answer `no-basis`.
 */
function declared(v: number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/* ------------------------------------------------------------------------- ratio */

/**
 * A comparison of a sample against a declared basis.
 *
 * Three states, because there are three genuinely different answers and an operator needs to tell
 * them apart: the ratio, "nothing was declared to compare against", and "we could not read the
 * usage". Only the first carries a number.
 */
export type Ratio =
  | { state: 'ratio'; value: number; usage: number; basis: number }
  | { state: 'no-basis' }
  | { state: 'unknown' };

/**
 * `usage / basis` as a fraction, guarded on both ends.
 *
 * @param usage the current sample, or null when unreadable
 * @param basis the declared request or limit; `0` means none was declared
 */
export function ratio(usage: number | null, basis: number): Ratio {
  if (usage === null) return { state: 'unknown' };
  if (!(basis > 0)) return { state: 'no-basis' };
  return { state: 'ratio', value: usage / basis, usage, basis };
}

/**
 * This member's share of a cluster total.
 *
 * `null` when the total is not a positive number — including the case where the total is itself
 * unreadable, which is exactly when a share would be most misleading.
 */
export function clusterShare(value: number | null, total: number | null): number | null {
  if (value === null || total === null) return null;
  if (!Number.isFinite(value) || !Number.isFinite(total) || !(total > 0)) return null;
  return value / total;
}

/**
 * Request minus current sample, in base units.
 *
 * Positive means the pod is currently below what it reserved; negative means it is above it. This
 * is the number the UI labels **"Current request headroom"**, and {@link HEADROOM_NOTE} is why:
 * one sample cannot support a word like waste, over-provisioned or unused. It is the gap right
 * now, nothing more.
 *
 * `null` when the sample is unreadable or no request was declared — a headroom against a request
 * of zero is not zero headroom, it is a different question.
 */
export function requestHeadroom(usage: number | null, request: number): number | null {
  if (usage === null) return null;
  if (!(request > 0)) return null;
  return request - usage;
}

/* --------------------------------------------------------------------- aggregates */

/**
 * Usage, requests and limits for a set of containers, pods or namespaces.
 *
 * `usageMissing` and `counted` are the completeness half and are never optional. A caller that
 * prints `cpuUsage` without checking `usageMissing` is printing a floor as a total, which is the
 * defect the whole console's `unavailable` vocabulary exists to prevent.
 */
export interface ResourceAggregate {
  /** Cores summed over members that reported. `null` when none did. */
  cpuUsage: number | null;
  cpuRequest: number;
  /** `0` means at least one member declared no CPU limit. */
  cpuLimit: number;
  /** Bytes summed over members that reported. `null` when none did. */
  memoryUsage: number | null;
  memoryRequest: number;
  memoryLimit: number;
  /** Members that reported no usage sample. Above zero, every usage figure here is a floor. */
  usageMissing: number;
  /** Members folded in. */
  counted: number;
  /** Members that declared no CPU request / no memory limit, etc. */
  noCpuRequest: number;
  noMemoryRequest: number;
  noCpuLimit: number;
  noMemoryLimit: number;
}

const EMPTY: ResourceAggregate = {
  cpuUsage: null,
  cpuRequest: 0,
  cpuLimit: 0,
  memoryUsage: null,
  memoryRequest: 0,
  memoryLimit: 0,
  usageMissing: 0,
  counted: 0,
  noCpuRequest: 0,
  noMemoryRequest: 0,
  noCpuLimit: 0,
  noMemoryLimit: 0
};

/** The shape every aggregation input shares: a container row, a pod row, a workload row. */
export interface ResourceBearing {
  cpuUsage?: number | null;
  memoryUsage?: number | null;
  cpuRequest?: number | null;
  cpuLimit?: number | null;
  memoryRequest?: number | null;
  memoryLimit?: number | null;
}

/**
 * Fold a list of resource-bearing rows into one aggregate.
 *
 * A member with no CPU *and* no memory sample counts once toward `usageMissing`; a member with one
 * of the two counts as present for that resource and missing for the other, which is why the sums
 * start `null` and only become numbers once something real lands in them. Summing `null` as `0`
 * here is the exact bug in rule 2 of this module's header.
 */
function fold(rows: readonly ResourceBearing[]): ResourceAggregate {
  if (!rows.length) return { ...EMPTY };
  const out: ResourceAggregate = { ...EMPTY };
  for (const r of rows) {
    out.counted++;
    const cpu = normalizeCpu(r.cpuUsage);
    const mem = normalizeMemory(r.memoryUsage);
    if (cpu === null && mem === null) out.usageMissing++;
    if (cpu !== null) out.cpuUsage = (out.cpuUsage ?? 0) + cpu;
    if (mem !== null) out.memoryUsage = (out.memoryUsage ?? 0) + mem;

    const cpuReq = declared(r.cpuRequest);
    const cpuLim = declared(r.cpuLimit);
    const memReq = declared(r.memoryRequest);
    const memLim = declared(r.memoryLimit);
    out.cpuRequest += cpuReq;
    out.cpuLimit += cpuLim;
    out.memoryRequest += memReq;
    out.memoryLimit += memLim;
    if (!(cpuReq > 0)) out.noCpuRequest++;
    if (!(cpuLim > 0)) out.noCpuLimit++;
    if (!(memReq > 0)) out.noMemoryRequest++;
    if (!(memLim > 0)) out.noMemoryLimit++;
  }
  return out;
}

/**
 * A set of pods folded together, using each pod's own totals.
 *
 * The pod-level fields are used rather than re-deriving from containers: the backend fills them
 * from the metrics API's pod entry, which is the authoritative sum for the pod, and it already
 * handles the init-container rule for requests.
 */
export function aggregatePodResources(pods: readonly ResourceBearing[]): ResourceAggregate {
  return fold(pods);
}

/** One namespace's pods folded together. Identical arithmetic, named for the scope it serves. */
export function aggregateNamespaceResources(pods: readonly ResourceBearing[]): ResourceAggregate {
  return fold(pods);
}

/* ------------------------------------------------------------------------ ranking */

/** `'all'` is a real choice in the top-N control, so it is a value in the type. */
export type TopN = 10 | 20 | 50 | 'all';

/**
 * Sort by a numeric key, largest first, and take the top N.
 *
 * Rows whose key is `null` sort **last and keep their position relative to each other**, never as
 * zero: a pod whose usage could not be read is not a pod using nothing, and floating it to the
 * bottom of a "top consumers" list is the only placement that does not assert something false.
 * They are still returned when they fall inside N, so a truncated list never hides them silently.
 *
 * `n` accepts a plain number as well as a {@link TopN} the control offers, because the Overview's
 * panes show a fixed five and must use this function rather than their own sort — that is the whole
 * reason the null-last rule holds identically on the summary and on the table it links to.
 */
export function rankTopN<T>(rows: readonly T[], keyOf: (row: T) => number | null, n: TopN | number): T[] {
  const scored = rows.map((row, i) => ({ row, i, k: keyOf(row) }));
  scored.sort((a, b) => {
    if (a.k === null && b.k === null) return a.i - b.i;
    if (a.k === null) return 1;
    if (b.k === null) return -1;
    return b.k - a.k || a.i - b.i;
  });
  const ordered = scored.map(s => s.row);
  return n === 'all' ? ordered : ordered.slice(0, n);
}

/* ----------------------------------------------------------------------- pressure */

/**
 * The thresholds this console uses to call a pod close to its memory limit.
 *
 * **Not Kubernetes-defined.** Kubernetes has no "near limit" state: a container is either within
 * its limit or it has been killed. These two numbers are a choice made here so an operator sees a
 * pod before the kubelet kills it, and every view that renders them says so — that is what the
 * `heuristic` flag on each finding is for.
 */
export const MEMORY_CRITICAL_FRACTION = 0.9;
export const MEMORY_NEAR_FRACTION = 0.8;

export type PressureKind =
  /** The kubelet terminated a container with reason OOMKilled. Proven, from pod status. */
  | 'oom-killed'
  /** Current sample is at or above {@link MEMORY_CRITICAL_FRACTION} of the limit. Heuristic. */
  | 'memory-critical'
  /** Between the two fractions. Heuristic. */
  | 'memory-near-limit'
  /** Current CPU sample exceeds the declared request. Bursting, which is legal and often fine. */
  | 'above-cpu-request'
  /** The scheduler has not placed this pod. Cause included only when the scheduler stated one. */
  | 'unschedulable'
  /** Containers have restarted. A count, with no claim about why. */
  | 'restarts';

export interface PressureFinding {
  kind: PressureKind;
  /** The label a table cell shows. Never the word "error" for a CPU burst; never "throttled". */
  label: string;
  /** Supporting figures, already formatted by the view — this carries the raw numbers. */
  detail: string;
  /**
   * `proven` — Kubernetes said it, in a status field or an event reason.
   * `heuristic` — this console inferred it from a threshold it chose.
   */
  basis: 'proven' | 'heuristic';
  /** Worst first: 0 is the most severe. */
  rank: number;
}

/** The words the scheduler itself uses. Nothing here is inferred from usage. */
const SCHEDULER_CAUSES: { probe: RegExp; text: string }[] = [
  { probe: /Insufficient cpu/i, text: 'Insufficient CPU' },
  { probe: /Insufficient memory/i, text: 'Insufficient memory' },
  { probe: /Insufficient ephemeral-storage/i, text: 'Insufficient ephemeral storage' },
  { probe: /didn't match Pod's node affinity|node affinity/i, text: 'Node affinity' },
  { probe: /untolerated taint/i, text: 'Untolerated taint' },
  { probe: /had volume node affinity conflict/i, text: 'Volume node affinity conflict' }
];

/**
 * Why the scheduler says this pod is not placed — **only** from what it wrote.
 *
 * The spec on this is exact: "Insufficient CPU" may appear only when that reason exists in the
 * scheduling status. So the message is matched for the scheduler's own phrases, and when none of
 * them are present the finding is the bare word `Unschedulable` with no invented cause. A pod
 * pending because its image will not pull is not a capacity problem, and guessing that it is sends
 * an operator to the wrong tab.
 */
export function schedulingCause(
  conditions?: readonly { type: string; status: string; reason: string | null; message: string | null }[]
): { unschedulable: boolean; cause: string | null; message: string | null } {
  const scheduled = (conditions || []).find(c => c.type === 'PodScheduled');
  if (!scheduled || scheduled.status === 'True') return { unschedulable: false, cause: null, message: null };
  const text = `${scheduled.reason || ''} ${scheduled.message || ''}`;
  const hits = SCHEDULER_CAUSES.filter(c => c.probe.test(text)).map(c => c.text);
  return {
    unschedulable: true,
    cause: hits.length ? hits.join(', ') : null,
    message: scheduled.message || null
  };
}

/** What `resourcePressure` needs from a pod. A subset of `PodRow`, so pods and rows both fit. */
export interface PressureInput extends ResourceBearing {
  phase?: string;
  restarts?: number;
  isOOMKilled?: boolean;
  containers?: readonly {
    name: string;
    init?: boolean;
    isOOMKilled?: boolean;
    lastStateReason?: string | null;
    lastExitCode?: number | null;
    restarts?: number;
  }[];
  conditions?: readonly { type: string; status: string; reason: string | null; message: string | null }[];
}

const pct = (f: number) => `${(f * 100).toFixed(f * 100 >= 10 ? 0 : 1)}%`;

/**
 * Everything this pod's status and current sample support saying about resource pressure.
 *
 * What it deliberately does **not** do:
 *
 *  - **Never infers OOM from memory usage.** `oom-killed` is emitted only when a container status
 *    carries the kubelet's own `OOMKilled` reason. A pod at 99% of its limit is at 99% of its
 *    limit; a great many run there for months.
 *  - **Never infers throttling.** CPU throttling is a cgroup counter
 *    (`container_cpu_cfs_throttled_periods_total`) that needs a metrics backend this fleet does not
 *    expose; metrics.k8s.io carries usage only. Usage near a CPU limit is not evidence of
 *    throttling and is not reported as any.
 *  - **Never calls a CPU burst an error.** Exceeding a *request* is what a request permits;
 *    Kubernetes schedules on requests and lets a container use spare capacity. The finding is
 *    named "Above request" and ranks below a real failure.
 */
export function resourcePressure(pod: PressureInput): PressureFinding[] {
  const out: PressureFinding[] = [];

  const oomContainers = (pod.containers || []).filter(
    c => c.isOOMKilled || c.lastStateReason === 'OOMKilled'
  );
  if (pod.isOOMKilled || oomContainers.length) {
    const names = oomContainers.map(c => c.name);
    out.push({
      kind: 'oom-killed',
      label: 'OOMKilled',
      // The container name is the actionable part: a sidecar being killed and the app being
      // killed are different incidents with the same pod-level flag.
      detail: names.length ? names.join(', ') : 'reported by the kubelet',
      basis: 'proven',
      rank: 0
    });
  }

  const sched = schedulingCause(pod.conditions);
  if (sched.unschedulable) {
    out.push({
      kind: 'unschedulable',
      label: 'Unschedulable',
      detail: sched.cause || 'no cause stated by the scheduler',
      basis: 'proven',
      rank: 1
    });
  }

  const memRatio = ratio(normalizeMemory(pod.memoryUsage), declared(pod.memoryLimit));
  if (memRatio.state === 'ratio') {
    if (memRatio.value >= MEMORY_CRITICAL_FRACTION) {
      out.push({
        kind: 'memory-critical',
        label: 'Critical proximity to memory limit',
        detail: `${pct(memRatio.value)} of limit`,
        basis: 'heuristic',
        rank: 2
      });
    } else if (memRatio.value >= MEMORY_NEAR_FRACTION) {
      out.push({
        kind: 'memory-near-limit',
        label: 'Near memory limit',
        detail: `${pct(memRatio.value)} of limit`,
        basis: 'heuristic',
        rank: 3
      });
    }
  }

  const restarts = pod.restarts || 0;
  if (restarts > 0) {
    out.push({
      kind: 'restarts',
      label: restarts === 1 ? '1 restart' : `${restarts} restarts`,
      detail: 'container restart count from pod status',
      basis: 'proven',
      rank: 4
    });
  }

  const cpuRatio = ratio(normalizeCpu(pod.cpuUsage), declared(pod.cpuRequest));
  if (cpuRatio.state === 'ratio' && cpuRatio.value > 1) {
    out.push({
      kind: 'above-cpu-request',
      label: 'Above request',
      detail: `${pct(cpuRatio.value)} of CPU request`,
      basis: 'proven',
      rank: 5
    });
  }

  return out.sort((a, b) => a.rank - b.rank);
}

/* ---------------------------------------------------------------------- pod rows */

/** One pod as this tab ranks it, with every derived figure precomputed once. */
export interface UtilizationPod {
  key: string;
  name: string;
  namespace: string;
  node: string | null;
  phase: string;
  qosClass: string | null;
  restarts: number;
  owners: string[];
  /**
   * The pod's containers, carried through unchanged.
   *
   * The Requests & Limits section works one row per container, because a missing limit is a
   * statement about one container and rolling it up to the pod hides which one — and the edit that
   * fixes it happens at container level.
   */
  containers: PodRow['containers'];
  /**
   * PodScheduled and the rest, carried through so the Errors & Pressure table can quote the
   * scheduler verbatim. This is the only admissible source for a cause such as "Insufficient CPU".
   */
  conditions: PodRow['conditions'];
  cpuUsage: number | null;
  cpuRequest: number;
  cpuLimit: number;
  memoryUsage: number | null;
  memoryRequest: number;
  memoryLimit: number;
  cpuOfRequest: Ratio;
  cpuOfLimit: Ratio;
  memoryOfRequest: Ratio;
  memoryOfLimit: Ratio;
  cpuHeadroom: number | null;
  memoryHeadroom: number | null;
  cpuShare: number | null;
  memoryShare: number | null;
  pressure: PressureFinding[];
}

/**
 * The pod rows this tab works from, derived once per payload.
 *
 * Takes the already-deduplicated inventory (`pod-inventory.ts`) rather than re-flattening
 * `workloads.items`: label selectors overlap, three Deployments in `platform-system` legitimately claim
 * the same pod, and counting that pod's memory three times would inflate every namespace and
 * cluster total on this tab. `owners` carries the ambiguity forward instead of resolving it.
 */
export function utilizationPods(
  pods: readonly (PressureInput & {
    name: string;
    namespace: string;
    node?: string | null;
    phase?: string;
    qosClass?: string | null;
    owners?: string[];
  })[],
  totals: { cpuUsage: number | null; memoryUsage: number | null }
): UtilizationPod[] {
  return pods.map(p => {
    const cpuUsage = normalizeCpu(p.cpuUsage);
    const memoryUsage = normalizeMemory(p.memoryUsage);
    const cpuRequest = declared(p.cpuRequest);
    const cpuLimit = declared(p.cpuLimit);
    const memoryRequest = declared(p.memoryRequest);
    const memoryLimit = declared(p.memoryLimit);
    return {
      key: `${p.namespace}/${p.name}`,
      name: p.name,
      namespace: p.namespace,
      node: p.node ?? null,
      phase: p.phase || 'Unknown',
      qosClass: p.qosClass ?? null,
      restarts: p.restarts || 0,
      owners: p.owners ? [...p.owners] : [],
      containers: (p.containers ?? []) as PodRow['containers'],
      conditions: (p.conditions ?? []) as PodRow['conditions'],
      cpuUsage,
      cpuRequest,
      cpuLimit,
      memoryUsage,
      memoryRequest,
      memoryLimit,
      cpuOfRequest: ratio(cpuUsage, cpuRequest),
      cpuOfLimit: ratio(cpuUsage, cpuLimit),
      memoryOfRequest: ratio(memoryUsage, memoryRequest),
      memoryOfLimit: ratio(memoryUsage, memoryLimit),
      cpuHeadroom: requestHeadroom(cpuUsage, cpuRequest),
      memoryHeadroom: requestHeadroom(memoryUsage, memoryRequest),
      cpuShare: clusterShare(cpuUsage, totals.cpuUsage),
      memoryShare: clusterShare(memoryUsage, totals.memoryUsage),
      pressure: resourcePressure(p)
    };
  });
}

/** One namespace's row, aggregated from its pods. */
export interface UtilizationNamespace extends ResourceAggregate {
  namespace: string;
  pods: number;
  cpuShare: number | null;
  memoryShare: number | null;
  cpuOfRequest: Ratio;
  memoryOfRequest: Ratio;
  memoryOfLimit: Ratio;
  restarts: number;
  oomKilled: number;
  nearMemoryLimit: number;
}

/**
 * Group pod rows by namespace.
 *
 * The counts alongside the sums (`oomKilled`, `nearMemoryLimit`) are what makes a namespace row
 * clickable into something: "62% of requests" is a fact, "and two of its pods were OOMKilled" is
 * the reason to look.
 */
export function namespaceRows(
  pods: readonly UtilizationPod[],
  totals: { cpuUsage: number | null; memoryUsage: number | null }
): UtilizationNamespace[] {
  const byNs = new Map<string, UtilizationPod[]>();
  for (const p of pods) {
    const list = byNs.get(p.namespace);
    if (list) list.push(p);
    else byNs.set(p.namespace, [p]);
  }
  return [...byNs.entries()].map(([namespace, members]) => {
    const agg = aggregateNamespaceResources(members);
    return {
      ...agg,
      namespace,
      pods: members.length,
      cpuShare: clusterShare(agg.cpuUsage, totals.cpuUsage),
      memoryShare: clusterShare(agg.memoryUsage, totals.memoryUsage),
      cpuOfRequest: ratio(agg.cpuUsage, agg.cpuRequest),
      memoryOfRequest: ratio(agg.memoryUsage, agg.memoryRequest),
      memoryOfLimit: ratio(agg.memoryUsage, agg.memoryLimit),
      restarts: members.reduce((n, p) => n + p.restarts, 0),
      oomKilled: members.filter(p => p.pressure.some(f => f.kind === 'oom-killed')).length,
      nearMemoryLimit: members.filter(p =>
        p.pressure.some(f => f.kind === 'memory-critical' || f.kind === 'memory-near-limit')
      ).length
    };
  });
}

/* -------------------------------------------------------------------- the payload */

/**
 * Which pods of the cluster this tab can actually see, and which it cannot.
 *
 * The workloads payload lists pods **selected by a Deployment, StatefulSet or DaemonSet**. A Job's
 * pods, a CronJob's pods and a bare pod are in none of those, so they are absent from every table
 * here. `summary.pods` is the cluster's real pod count, so the difference is knowable — and the
 * tab prints it rather than letting an operator read a partial list as the whole cluster.
 */
export interface PodCoverage {
  /** Pods this tab has rows for, after de-duplicating overlapping selectors. */
  covered: number;
  /** Pods the cluster reported in total. */
  total: number;
  /** `total - covered`, floored at zero. */
  outside: number;
}

export function podCoverage(covered: number, total: number | null | undefined): PodCoverage {
  const t = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : covered;
  return { covered, total: t, outside: Math.max(0, t - covered) };
}

/** Everything the five sections read, computed once from one workloads payload. */
export interface UtilizationModel {
  pods: UtilizationPod[];
  namespaces: UtilizationNamespace[];
  cluster: ResourceAggregate;
  coverage: PodCoverage;
  /** Distinct namespaces, for the filter control. Sorted. */
  namespaceNames: string[];
}
/**
 * Build the whole model from the workloads payload.
 *
 * `flatten` is injected rather than imported so this module stays free of the inventory module's
 * `WorkloadRow` dependency in tests; callers pass `flattenPods`.
 */
export function buildUtilizationModel(
  workloadItems: readonly WorkloadRow[],
  summaryPods: number | null | undefined,
  flatten: (items: readonly WorkloadRow[]) => (PodRow & { owners: string[] })[]
): UtilizationModel {
  const flat = flatten(workloadItems);
  const cluster = aggregatePodResources(flat);
  const totals = { cpuUsage: cluster.cpuUsage, memoryUsage: cluster.memoryUsage };
  const pods = utilizationPods(flat, totals);
  const namespaces = namespaceRows(pods, totals);
  return {
    pods,
    namespaces,
    cluster,
    coverage: podCoverage(flat.length, summaryPods),
    namespaceNames: [...new Set(pods.map(p => p.namespace))].sort()
  };
}
