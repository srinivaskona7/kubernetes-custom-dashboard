/**
 * The pods scheduled on one node, joined with what the cluster already knows about them.
 *
 * `NodeRow.podsList` is deliberately thin — name, namespace, phase, and the requests the
 * scheduler counted (see `api.ts`). It carries no owner and no live usage, so a table built from
 * it alone can only show four of the eight columns the Nodes view needs. The missing four are
 * already in the browser: `/clusters/:id/overview` returns `workloads.items`, each with its
 * selector-matched `pods`, and a `PodRow` there has `cpuUsage`/`memoryUsage` from
 * `metrics.k8s.io` plus the container detail. So this joins the two rather than fetching again —
 * no new Kubernetes API read exists for this feature.
 *
 * Three rules the join obeys, each of them a bug that would otherwise ship:
 *
 * 1. **`podsList` is the spine, not the workload list.** A node also runs static pods, bare pods
 *    and Job pods that no Deployment/StatefulSet/DaemonSet selects. Driving the table off the
 *    workload side would silently drop them, and "Scheduled pods (14)" over 11 rows is exactly
 *    the quiet mismatch this console treats as a defect. Every entry in `podsList` gets a row.
 *
 * 2. **Ownership stays ambiguous when it is ambiguous.** Pods are matched to workloads by label
 *    selector and selectors overlap, so `owners` is a list and the caller renders
 *    `ownerVerdict` (see `pod-inventory.ts`). Nothing here derives a controller from a pod's
 *    name — `api-7d9f8b4c6-x2k9p` → `api` is string similarity, not a relationship.
 *
 * 3. **A missing usage reading is `null`, never 0.** `cpuUsage: null` means metrics-server did
 *    not answer for that pod; a 0 there would read as an idle pod. Requests are separate fields
 *    for the same reason: they are a different fact, not a fallback for the same one.
 */
import type { PodRow, WorkloadRow } from '../../api';
import { bytes, cpu } from '../../format';
import { assessResourceRisk, type RiskAssessment } from './usage/resource-risk';

/** Which levels are worth a pill. `info` is "above its request", which is Burstable working. */
const REPORTABLE: ReadonlySet<RiskAssessment['level']> = new Set<RiskAssessment['level']>([
  'critical',
  'warning'
]);

/**
 * The worst limit-proximity finding across a pod's containers, or `null` when there is none.
 *
 * Both units are assessed for every container and the worse one wins, with memory taking a tie:
 * reaching a memory limit is a kill and reaching a CPU limit is a delay, so when a container is close
 * to both, the kill is the sentence the operator needs first.
 */
/**
 * Flatten one assessment into a table cell's worth of fact, carrying the two figures the
 * explanation drawer would otherwise have to re-derive from the pod.
 *
 * Both are nullable and for one reason each: `percentOfLimit` needs a limit to be a share of, and a
 * container with no limit declared can still be reportable (`Bursting` is measured against its
 * request). Rendering 0% there would read as an idle container rather than an undeclared ceiling.
 */
function flatten(
  a: RiskAssessment,
  container: string,
  unit: 'cpu' | 'memory',
  usage: number,
  limit: number | null | undefined
): NodePodLimitRisk {
  const hasLimit = typeof limit === 'number' && limit > 0;
  return {
    ...a,
    container,
    unit,
    percentOfLimit: hasLimit ? usage / limit : null,
    limitText: hasLimit ? (unit === 'memory' ? bytes(limit) : cpu(limit)) : null
  };
}

function worstLimitRisk(p: PodRow | undefined): NodePodLimitRisk | null {
  let worst: NodePodLimitRisk | null = null;
  for (const c of p?.containers ?? []) {
    const candidates: NodePodLimitRisk[] = [];
    if (c.memoryUsage !== null && c.memoryUsage !== undefined) {
      const a = assessResourceRisk('memory', c.memoryUsage, c.memoryRequest, c.memoryLimit);
      if (REPORTABLE.has(a.level)) candidates.push(flatten(a, c.name, 'memory', c.memoryUsage, c.memoryLimit));
    }
    if (c.cpuUsage !== null && c.cpuUsage !== undefined) {
      const a = assessResourceRisk('cpu', c.cpuUsage, c.cpuRequest, c.cpuLimit);
      if (REPORTABLE.has(a.level)) candidates.push(flatten(a, c.name, 'cpu', c.cpuUsage, c.cpuLimit));
    }
    for (const candidate of candidates) {
      if (worst === null) {
        worst = candidate;
        continue;
      }
      const better =
        candidate.level === 'critical' && worst.level !== 'critical'
          ? true
          : candidate.level === worst.level && candidate.unit === 'memory' && worst.unit === 'cpu';
      if (better) worst = candidate;
    }
  }
  return worst;
}

/** One row of the Scheduled pods table. Every optional source has been resolved to a value or null. */
export interface NodePodRow {
  name: string;
  namespace: string;
  phase: string;
  /** The kubelet's own reason (`CrashLoopBackOff`, `Evicted`), when it gave one. */
  reason: string | null;
  /** Null when neither source reported one — distinct from a pod that has genuinely never restarted. */
  restarts: number | null;
  isOOMKilled: boolean;
  /** Live usage from `metrics.k8s.io`. Null when the reading did not happen. */
  cpuUsage: number | null;
  memoryUsage: number | null;
  /** What the scheduler counted. Null when neither source reported it; 0 is a real "no request set". */
  cpuRequest: number | null;
  memoryRequest: number | null;
  /** `Kind/name` for every workload whose selector matched this pod. Empty for an unowned pod. */
  owners: string[];
  /** Container names, for the log drawer's selector. Empty when the workload join found nothing. */
  containers: string[];
  /**
   * The container closest to one of its own limits, when one is close enough to say so.
   *
   * `null` means **nothing was found to report**, and it covers four different situations on
   * purpose, because none of them supports a badge: the workload join never matched this pod, no
   * usage sample exists for it, no container declares a limit to approach, or every container is
   * comfortably inside the ones it does declare. A pill drawn from `null` would claim the last of
   * those for all four.
   *
   * The verdict itself comes from `assessResourceRisk`, which the Top Utilization tab already uses —
   * so a pod flagged here and the same pod on that tab cannot disagree. CPU and memory are assessed
   * apart for the reason that module exists: memory is incompressible and kills, CPU is compressible
   * and only slows down.
   */
  limitRisk: NodePodLimitRisk | null;
}

/** One container's proximity to one of its limits, flattened for a table cell. */
export interface NodePodLimitRisk extends RiskAssessment {
  container: string;
  unit: 'cpu' | 'memory';
  /** Usage as a share of the declared limit, or null when no limit is declared. Never 0 for "unknown". */
  percentOfLimit: number | null;
  /** The limit as the rest of the console prints it (`512 MiB`, `1 core`), or null when undeclared. */
  limitText: string | null;
}

/** What `NodeRow.podsList` gives us. Declared structurally so the caller needs no cast. */
export interface ScheduledPod {
  name: string;
  namespace: string;
  phase: string;
  restarts?: number;
  cpuRequested?: number;
  memoryRequested?: number;
}

function key(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

/**
 * Index the overview's workload pods by `namespace/name`, keeping every claimant.
 *
 * Kept separate from the join so the cost is paid once per render of the tab rather than once per
 * node: the index is over every pod on the cluster, the join is over one node's.
 */
export function indexWorkloadPods(
  workloads: readonly WorkloadRow[]
): Map<string, { pod: PodRow; owners: string[] }> {
  const byKey = new Map<string, { pod: PodRow; owners: string[] }>();
  for (const w of workloads) {
    const owner = `${w.kind}/${w.name}`;
    for (const p of w.pods) {
      const k = key(p.namespace, p.name);
      const seen = byKey.get(k);
      if (seen) {
        if (!seen.owners.includes(owner)) seen.owners.push(owner);
      } else {
        byKey.set(k, { pod: p, owners: [owner] });
      }
    }
  }
  return byKey;
}

/**
 * @param scheduled the node's own pod list — the spine of the result
 * @param index the output of `indexWorkloadPods`, or an empty map when workloads did not load
 * @returns one row per scheduled pod, worst first
 */
export function nodePodRows(
  scheduled: readonly ScheduledPod[],
  index: Map<string, { pod: PodRow; owners: string[] }>
): NodePodRow[] {
  const rows = scheduled.map<NodePodRow>(s => {
    const hit = index.get(key(s.namespace, s.name));
    const p = hit?.pod;
    return {
      name: s.name,
      namespace: s.namespace,
      // The node's phase is the one the node reported. They agree in practice; when they do not,
      // the node list is the fresher of the two for a pod *on that node*.
      phase: s.phase,
      reason: p?.reason ?? null,
      restarts: s.restarts ?? p?.restarts ?? null,
      isOOMKilled: p?.isOOMKilled ?? false,
      cpuUsage: p?.cpuUsage ?? null,
      memoryUsage: p?.memoryUsage ?? null,
      cpuRequest: s.cpuRequested ?? p?.cpuRequest ?? null,
      memoryRequest: s.memoryRequested ?? p?.memoryRequest ?? null,
      owners: hit ? [...hit.owners] : [],
      containers: p?.containers.map(c => c.name) ?? [],
      limitRisk: worstLimitRisk(p)
    };
  });
  return rows.sort((a, b) => severity(a) - severity(b) || key(a.namespace, a.name).localeCompare(key(b.namespace, b.name)));
}

/**
 * Sort key: a pod with a reason is worse than one that is merely not Running, which is worse than
 * one that is running. The same order the Workloads and Logs pod lists use, so all three read alike.
 */
function severity(p: NodePodRow): number {
  if (p.reason || p.isOOMKilled) return 0;
  if (p.phase !== 'Running' && p.phase !== 'Succeeded') return 1;
  return (p.restarts ?? 0) > 0 ? 2 : 3;
}

/** The namespaces actually present on this node, for the filter's options. Never a guess. */
export function nodePodNamespaces(rows: readonly NodePodRow[]): string[] {
  return [...new Set(rows.map(r => r.namespace))].sort();
}

/**
 * The workloads actually present on this node, as `Kind/name`.
 *
 * A pod claimed by three overlapping selectors contributes all three, because filtering by any one
 * of them must find it — the ambiguity is in the data and the filter inherits it rather than
 * picking a winner.
 */
export function nodePodWorkloads(rows: readonly NodePodRow[]): string[] {
  return [...new Set(rows.flatMap(r => r.owners))].sort();
}

export interface NodePodFilter {
  /** Empty means every namespace. */
  namespace: string;
  /** Empty means every workload; `UNOWNED` selects the pods no workload claims. */
  workload: string;
  /** Matched against the pod name, case-insensitively. Trimmed here, not by the caller. */
  search: string;
}

/**
 * The sentinel for "pods no workload selected".
 *
 * A real option rather than an omission: static and Job pods are the ones an operator is least
 * able to find anywhere else in the console. Every other option in the filter is a `Kind/name`, so
 * a value with no slash in it cannot collide with one.
 *
 * It was briefly a leading NUL byte (` unowned` written with `\0` rather than a space), which is
 * legal JavaScript, compiles, passes its tests — and makes `grep` and `diff` treat the whole file as
 * binary. `test/fleet/no-ignored-sources.test.js` catches that class of byte; a printable sentinel
 * avoids needing it to.
 */
export const UNOWNED = '(no workload)';

export function filterNodePods(rows: readonly NodePodRow[], f: NodePodFilter): NodePodRow[] {
  const needle = f.search.trim().toLowerCase();
  return rows.filter(r => {
    if (f.namespace && r.namespace !== f.namespace) return false;
    if (f.workload === UNOWNED) {
      if (r.owners.length > 0) return false;
    } else if (f.workload && !r.owners.includes(f.workload)) return false;
    if (needle && !r.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** How many filters are narrowing the list — what `FilterBar`'s reset badge counts. */
export function activeNodePodFilters(f: NodePodFilter): number {
  return (f.namespace ? 1 : 0) + (f.workload ? 1 : 0) + (f.search.trim() ? 1 : 0);
}
