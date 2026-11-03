/**
 * The model behind **Namespaces & Workloads → Pods**: filters, summary counts, the resource figures
 * each meter draws, and the events shown under an opened row.
 *
 * Nothing here is a second rule. The rows are `podInventoryRows` (the flattened, deduplicated
 * workloads payload), the resource figures go through the same `Figures` + `usageVerdict` ladder the
 * Namespaces table uses, the phase and readiness come from `podState`, and the owner verdict from
 * `ownerVerdict`. This module only joins them for the one screen.
 *
 * Pure `.ts`: the fleet-ui vitest suite runs in the node environment with no DOM.
 */

import type { ContainerRow, EventRow } from '../../api';
import { matchesNamespace } from '../../components/namespace-filter';
import { declared, type Figures } from './namespace-usage';
import { ownerVerdict, type InventoryPod } from './pod-inventory';
import { podState } from './pod-state';
import { filterByNamespace } from './workload-filter';

// ------------------------------------------------------------------ status

/**
 * The summary cards and the Status filter bucket by **phase**, the one pod status Kubernetes
 * reports. `Succeeded` is shown as Completed, the word `kubectl get pods` prints for it.
 *
 * A crashlooping container leaves its pod `Running`, so a phase bucket alone would hide it; the
 * `attention` filter is the complement — every pod `podState` does not tone green.
 */
export type PodPhaseBucket = 'running' | 'completed' | 'pending' | 'failed' | 'unknown';
export type PodStatusFilter = 'all' | PodPhaseBucket | 'attention';

export function phaseBucket(phase: string | null | undefined): PodPhaseBucket {
  switch (phase) {
    case 'Running':
      return 'running';
    case 'Succeeded':
      return 'completed';
    case 'Pending':
      return 'pending';
    case 'Failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

export const POD_STATUS_LABEL: Record<PodStatusFilter, string> = {
  all: 'All',
  running: 'Running',
  completed: 'Completed',
  pending: 'Pending',
  failed: 'Failed',
  unknown: 'Unknown',
  attention: 'Needs attention'
};

/**
 * Restarts above this read as a problem: the Restarts cell turns amber past it, and the pod counts
 * under "need attention". A pod that restarted 186 times and is momentarily Running 1/1 is flapping,
 * not healthy — `podState` judges the current instant, so the history has to be added here.
 */
export const RESTARTS_WARN = 10;

export function needsAttention(p: InventoryPod): boolean {
  return podState(p).tone !== 'ok' || p.restarts > RESTARTS_WARN;
}

export function matchesStatus(p: InventoryPod, status: PodStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'attention') return needsAttention(p);
  return phaseBucket(p.phase) === status;
}

export interface PodSummaryCounts {
  total: number;
  running: number;
  completed: number;
  pending: number;
  failed: number;
  unknown: number;
  attention: number;
}

/** Counted over the rows passed in — the caller decides the scope (namespace + system toggle). */
export function podSummaryCounts(pods: readonly InventoryPod[]): PodSummaryCounts {
  const c: PodSummaryCounts = { total: 0, running: 0, completed: 0, pending: 0, failed: 0, unknown: 0, attention: 0 };
  for (const p of pods) {
    c.total += 1;
    c[phaseBucket(p.phase)] += 1;
    if (needsAttention(p)) c.attention += 1;
  }
  return c;
}

// ------------------------------------------------------------------ filters

export interface PodTableFilter {
  search: string;
  status: PodStatusFilter;
  showSystem: boolean;
  /** The CPU and Memory quick-filter chips: a band of used ÷ summed request. */
  cpu: UsageBand;
  memory: UsageBand;
  /** The "More filters" checkboxes. Each one narrows; ticking two keeps the pods that match both. */
  advanced: ReadonlySet<AdvancedPodFilter>;
}

export const NO_POD_FILTER: PodTableFilter = {
  search: '',
  status: 'all',
  showSystem: false,
  cpu: 'all',
  memory: 'all',
  advanced: new Set()
};

// ------------------------------------------------------------------ utilization filters

/**
 * The CPU and Memory chips. The percentage is the one the meter prints beside the bar —
 * `ofRequestText`'s used ÷ summed request — so a chip never selects a row whose figure reads
 * outside it. Not % of limit: most pods on a Kyma cluster declare no CPU limit, and a band over
 * limits would drop them from every chip.
 *
 * Half-open bands, `[lo, hi)`: 25% is in 25–50, and `gt75` holds 75% and up, including a pod
 * bursting past its request (130%), which is the pod the top chip exists to find.
 */
export type UsageBand = 'all' | 'lt25' | '25to50' | '50to75' | 'gt75';

export const USAGE_BANDS: readonly UsageBand[] = ['all', 'lt25', '25to50', '50to75', 'gt75'];

export const USAGE_BAND_LABEL: Record<UsageBand, string> = {
  all: 'All',
  lt25: '<25%',
  '25to50': '25–50%',
  '50to75': '50–75%',
  gt75: '>75%'
};

/** A chip press: the selected chip unselects, back to All; any other chip selects itself. */
export function nextUsageBand(current: UsageBand, pressed: UsageBand): UsageBand {
  return pressed === current ? 'all' : pressed;
}

/**
 * Used ÷ summed request, unrounded, or `null` when it cannot be stated: no request configured, or no
 * usage sample. Read from `podFigures`, the meter's own figures.
 */
export function usagePercent(p: InventoryPod, metric: Metric): number | null {
  const f = podFigures(p, metric);
  if (f.used === null || f.request === null || !(f.request > 0)) return null;
  return (f.used / f.request) * 100;
}

/**
 * The band a percentage sits in; `null` (no request, no sample) sits in none. Rounded first, as
 * `ofRequestText` rounds it, so a pod whose meter reads "25% of request" is in 25–50%, not <25%.
 */
export function usageBandOf(pct: number | null): Exclude<UsageBand, 'all'> | null {
  if (pct === null) return null;
  const shown = Math.round(pct);
  if (shown < 25) return 'lt25';
  if (shown < 50) return '25to50';
  if (shown < 75) return '50to75';
  return 'gt75';
}

/**
 * A pod with no request or no sample matches only `all`: placing it in `<25%` would claim an idle
 * pod the console never measured. "No request configured" is its own filter under More filters.
 */
export function matchesUsageBand(p: InventoryPod, metric: Metric, band: UsageBand): boolean {
  return band === 'all' || usageBandOf(usagePercent(p, metric)) === band;
}

/** The "More filters" checkboxes — spec facts, read from the same summed figures as the meters. */
export type AdvancedPodFilter = 'noCpuRequest' | 'noMemoryRequest' | 'noLimits' | 'highRestarts';

export const ADVANCED_POD_FILTERS: readonly AdvancedPodFilter[] = ['noCpuRequest', 'noMemoryRequest', 'noLimits', 'highRestarts'];

export const ADVANCED_POD_FILTER_LABEL: Record<AdvancedPodFilter, string> = {
  noCpuRequest: 'No request configured (CPU)',
  noMemoryRequest: 'No request configured (Memory)',
  noLimits: 'No limits configured',
  highRestarts: 'High restarts'
};

export const ADVANCED_POD_FILTER_TITLE: Record<AdvancedPodFilter, string> = {
  noCpuRequest: 'Pods whose running containers declare no CPU request between them.',
  noMemoryRequest: 'Pods whose running containers declare no memory request between them.',
  noLimits: 'Pods with at least one running container missing a CPU or a memory limit, so the pod has no full ceiling.',
  highRestarts: `Pods whose containers restarted more than ${RESTARTS_WARN} times, the threshold the Restarts column turns amber at.`
};

export function matchesAdvanced(p: InventoryPod, which: AdvancedPodFilter): boolean {
  switch (which) {
    case 'noCpuRequest':
      return podFigures(p, 'cpu').request === null;
    case 'noMemoryRequest':
      return podFigures(p, 'memory').request === null;
    case 'noLimits': {
      // `limitPartial`: some container declared one and another did not — still no full ceiling.
      const cpu = podFigures(p, 'cpu');
      const mem = podFigures(p, 'memory');
      return cpu.limit === null || cpu.limitPartial === true || mem.limit === null || mem.limitPartial === true;
    }
    case 'highRestarts':
      return p.restarts > RESTARTS_WARN;
  }
}

/** Pods per band for one metric's chips, over rows the caller has already narrowed by every other filter. */
export function usageBandCounts(pods: readonly InventoryPod[], metric: Metric): Record<UsageBand, number> {
  const c: Record<UsageBand, number> = { all: 0, lt25: 0, '25to50': 0, '50to75': 0, gt75: 0 };
  for (const p of pods) {
    c.all += 1;
    const b = usageBandOf(usagePercent(p, metric));
    if (b) c[b] += 1;
  }
  return c;
}

/**
 * Whether a pod is hidden by the system toggle.
 *
 * `system` is the server's own namespace classification (`/clusters/:id/namespaces`, the flag the
 * Namespaces table reads). `null` means that read has not answered, and then nothing is hidden:
 * hiding on a guess would drop pods the operator has no way to know are missing.
 *
 * A namespace the operator selected explicitly is never hidden — arriving from the Namespaces table
 * on `kyma-system` must show kyma-system's pods, not an empty table under a toggle.
 */
export function hiddenAsSystem(
  p: { namespace: string },
  system: ReadonlySet<string> | null,
  showSystem: boolean,
  selected: ReadonlySet<string>
): boolean {
  if (showSystem || system === null) return false;
  if (selected.size > 0 && matchesNamespace(p.namespace, selected)) return false;
  return system.has(p.namespace);
}

/**
 * The Pods sub-tab's scope — the namespace selection, then the system toggle. The summary cards,
 * the table and the sub-tab counter all start from this one call, so the counter cannot promise
 * system pods the default view hides.
 */
export function podsInScope(
  pods: readonly InventoryPod[],
  namespaces: ReadonlySet<string>,
  system: ReadonlySet<string> | null,
  showSystem: boolean
): InventoryPod[] {
  return scopePods(filterByNamespace(pods, namespaces), system, showSystem, namespaces);
}

/** The rows the summary cards count: namespace-filtered upstream, then the system toggle. */
export function scopePods<T extends { namespace: string }>(
  pods: readonly T[],
  system: ReadonlySet<string> | null,
  showSystem: boolean,
  selected: ReadonlySet<string>
): T[] {
  return pods.filter(p => !hiddenAsSystem(p, system, showSystem, selected));
}

/** Case-insensitive substring over the pod name, its owning workloads and its node. */
export function matchesSearch(p: InventoryPod, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  if (p.name.toLowerCase().includes(q)) return true;
  if (p.node && p.node.toLowerCase().includes(q)) return true;
  return p.owners.some(o => o.toLowerCase().includes(q));
}

/** The table rows: the scoped set narrowed by search, status, both usage bands and every advanced filter. */
export function filterPodTable(scoped: readonly InventoryPod[], f: PodTableFilter): InventoryPod[] {
  const advanced = [...f.advanced];
  return scoped.filter(
    p =>
      matchesStatus(p, f.status) &&
      matchesSearch(p, f.search) &&
      matchesUsageBand(p, 'cpu', f.cpu) &&
      matchesUsageBand(p, 'memory', f.memory) &&
      advanced.every(a => matchesAdvanced(p, a))
  );
}

/**
 * Filters in force, for the bar's "Clear filters" badge. The namespace selection counts as one, and
 * so does each chip group and each ticked advanced filter.
 */
export function activePodFilters(f: PodTableFilter, namespacesSelected: number): number {
  return (
    (f.search.trim() ? 1 : 0) +
    (f.status !== 'all' ? 1 : 0) +
    (f.showSystem ? 1 : 0) +
    (namespacesSelected > 0 ? 1 : 0) +
    (f.cpu !== 'all' ? 1 : 0) +
    (f.memory !== 'all' ? 1 : 0) +
    f.advanced.size
  );
}

// ------------------------------------------------------------------ workload

/**
 * The Workload cell. The pods payload has no `ownerReferences`, so the owner is the workload whose
 * selector matched — one is a fact, several is an ambiguity the cell reports rather than resolves.
 */
export type WorkloadCell =
  | { kind: 'one'; workloadKind: string; name: string; title: string }
  | { kind: 'ambiguous'; count: number; title: string }
  | { kind: 'none'; title: string };

export function workloadCell(owners: readonly string[]): WorkloadCell {
  const v = ownerVerdict(owners);
  if (v.kind === 'one') {
    const [workloadKind = '', name = v.name] = v.full.split('/');
    return { kind: 'one', workloadKind, name, title: `Selected by ${v.full}` };
  }
  if (v.kind === 'ambiguous') {
    return { kind: 'ambiguous', count: v.count, title: `${v.count} workloads select this pod:\n${v.candidates.join('\n')}` };
  }
  return { kind: 'none', title: 'No workload in this cluster selects this pod' };
}

// ------------------------------------------------------------------ resources

type Metric = 'cpu' | 'memory';

/**
 * A pod's used / request / limit, as the meter reads them, summed over the containers that run for
 * the pod's whole life: the regular ones and the native sidecars (`restartPolicy: Always` init
 * containers — Istio's `istio-proxy` on Kyma). A run-to-completion init container is excluded.
 *
 * Summed here, not read from the pod: the pod's `cpuUsage`/`memoryUsage` is metrics-server's total
 * over every running container, sidecar included, while its `cpuRequest`/`cpuLimit` (`podResources`
 * in `srv/fleet/collectors/workloads.js`) cover `spec.containers` only. Grading the one against the
 * other put an app at 73% of its own limit into "Near limit" once the proxy's memory was added.
 *
 * A container with no usage sample makes the pod's usage unknown, not a smaller sum. A container
 * with no limit leaves the pod without a ceiling, so the summed limit is partial — printed `≥`,
 * never graded — exactly the namespace rule.
 */
export function podFigures(p: InventoryPod, metric: Metric): Figures {
  let used: number | null = 0;
  let request = 0;
  let limit = 0;
  let unlimited = false;
  let running = 0;
  for (const c of p.containers) {
    if (c.init && !c.sidecar) continue;
    running += 1;
    const f = containerFigures(c, metric);
    used = used === null || f.used === null ? null : used + f.used;
    request += f.request ?? 0;
    if (f.limit === null) unlimited = true;
    else limit += f.limit;
  }
  const summed = declared(limit);
  return {
    used: running ? used : null,
    request: declared(request),
    limit: summed,
    limitPartial: summed !== null && unlimited
  };
}

export function containerFigures(c: ContainerRow, metric: Metric): Figures {
  return {
    used: metric === 'cpu' ? c.cpuUsage : c.memoryUsage,
    request: declared(metric === 'cpu' ? c.cpuRequest : c.memoryRequest),
    limit: declared(metric === 'cpu' ? c.cpuLimit : c.memoryLimit)
  };
}

// ------------------------------------------------------------------ events

export const RECENT_EVENTS = 5;

/**
 * Warning events whose involved object is this pod, newest first, capped. The collector publishes
 * `object` as `Kind/name`, and a pod name is only unique within its namespace, so both must match.
 */
export function podEvents(events: readonly EventRow[], p: Pick<InventoryPod, 'namespace' | 'name'>, limit = RECENT_EVENTS): EventRow[] {
  const object = `Pod/${p.name}`;
  return events
    .filter(e => e.namespace === p.namespace && e.object === object)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    .slice(0, limit);
}
