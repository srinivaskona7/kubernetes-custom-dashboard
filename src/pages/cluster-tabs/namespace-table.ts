/**
 * The model behind **Namespaces & Workloads → Namespaces** and the Overview's Namespaces tile.
 *
 * Both screens build from the same two pieces, so they cannot disagree:
 *
 *  - the namespace inventory, pod counts and the `system` flag from `/clusters/:id/namespaces`
 *    (classified server-side by `SYSTEM_NAMESPACES` in `srv/fleet/collectors/compliance.js`);
 *  - CPU and memory through `mergeNamespaceUsage`, the one used/request/limit join.
 *
 * ## Type
 *
 * The backend classifies a namespace as system or not, and nothing more. `other` is in the type so
 * the filter can offer it, but no rule produces it today: inventing a third class here would make
 * this screen disagree with every other place the console says "system".
 *
 * ## Status, in the order it is decided
 *
 *  1. **Critical** — a workload whose state reads as failing (`workloadTone` → `bad`), a pod
 *     OOMKilled, or CPU/memory at a limit (or memory near it — the same 80% the pod tables flag).
 *  2. **Empty** — no pods, and no workload wanting any. Checked after Critical because a Deployment
 *     asking for two replicas and running none is the opposite of empty.
 *  3. **Warning** — a workload progressing or degraded, or usage above its request / CPU near limit.
 *  4. **Unknown** — nothing was assessed: the workloads read was incomplete, the pod count was not
 *     read, or the pods here belong to no Deployment, StatefulSet or DaemonSet (Jobs, bare pods).
 *     Never filed as Empty or Healthy — "we did not look" must not read as "all clear".
 *  5. **Healthy** — otherwise.
 *
 * Critical, from positive evidence, still wins over an incomplete read; Empty and Healthy, which
 * are claims about *everything* in the namespace, need the workloads read complete.
 *
 * Pure `.ts`: the fleet-ui vitest suite runs in the node environment with no DOM.
 */

import type { NamespaceRow, WorkloadRow } from '../../api';
import { workloadTone } from '../../status';
import type { UtilizationNamespace } from './usage/utilization-model';
import { orderNamespaces } from './namespace-list';
import { mergeNamespaceUsage, usageVerdict, type NamespaceUsage } from './namespace-usage';

export type NamespaceType = 'application' | 'system' | 'other';
export type NamespaceStatus = 'healthy' | 'warning' | 'critical' | 'empty' | 'unknown';

export const NAMESPACE_TYPE_LABEL: Record<NamespaceType, string> = {
  application: 'Application',
  system: 'System',
  other: 'Other'
};

export const NAMESPACE_STATUS_LABEL: Record<NamespaceStatus, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  empty: 'Empty',
  unknown: 'Unknown'
};

/** The backend's `system` flag, as a type. See the module note for why nothing yields `other`. */
export function namespaceType(r: Pick<NamespaceRow, 'system'>): NamespaceType {
  return r.system ? 'system' : 'application';
}

/** How much of the namespace list itself arrived — distinct from the pod count's own reason. */
export type NamespaceListState = 'ok' | 'unavailable' | 'truncated';

export interface NamespaceTypeCounts {
  /** `unavailable`: the list was refused and every count below is meaningless (read as unknown). */
  list: NamespaceListState;
  /** Namespaces returned. With `list: 'truncated'` this is a floor. */
  total: number;
  application: number;
  system: number;
  other: number;
  /** Summed pods, or `null` when any count is missing — a sum with holes is a confident undercount. */
  pods: number | null;
}

/** The parts of the `/namespaces` summary these counts depend on. */
export interface NamespaceListSummary {
  podCountReason?: 'unavailable' | 'truncated' | null;
  unavailable?: string[];
  truncated?: string[];
}

/**
 * The namespace list's own completeness. `safeList` answers a refused list with `items: []` and the
 * label in `summary.unavailable`, inside an `ok` envelope — so an empty array alone is not "zero
 * namespaces", and reading it as one is how a 403 renders as "0 namespaces · 0 pods".
 */
export function namespaceListState(summary: NamespaceListSummary | null | undefined): NamespaceListState {
  if (summary?.unavailable?.includes('namespaces')) return 'unavailable';
  if (summary?.truncated?.includes('namespaces')) return 'truncated';
  return 'ok';
}

/** The Overview tile's numbers and the Namespaces table's type counts — one function for both. */
export function namespaceTypeCounts(
  rows: readonly NamespaceRow[],
  summary: NamespaceListSummary | null | undefined
): NamespaceTypeCounts {
  const list = namespaceListState(summary);
  const c: NamespaceTypeCounts = { list, total: rows.length, application: 0, system: 0, other: 0, pods: 0 };
  for (const r of rows) {
    c[namespaceType(r)] += 1;
    if (c.pods !== null) c.pods = r.pods === null || r.pods === undefined ? null : c.pods + r.pods;
  }
  // A pod total over a short namespace list is an undercount too, so it goes the same way.
  if (summary?.podCountReason || list !== 'ok') c.pods = null;
  return c;
}

export interface NamespaceTableRow {
  namespace: string;
  type: NamespaceType;
  usage: NamespaceUsage;
  /** Deployments, StatefulSets and DaemonSets in this namespace — the kinds the workloads read collects. */
  workloads: number;
  status: NamespaceStatus;
  /** Why the status is what it is, for the pill's tooltip. */
  statusReason: string;
  /** Newest workload creation or rollout restart, or `null` when the namespace holds no workload. */
  lastUpdated: string | null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function statusOf(
  u: NamespaceUsage,
  wls: readonly WorkloadRow[],
  workloadsComplete: boolean
): { status: NamespaceStatus; reason: string } {
  const tones = wls.map(w => workloadTone(w.state, w.healthy));
  const failing = tones.filter(t => t === 'bad').length;
  const degraded = tones.filter(t => t === 'warn').length;
  const verdicts = u.measured
    ? [
        { what: 'CPU', v: usageVerdict('cpu', u.cpu) },
        { what: 'Memory', v: usageVerdict('memory', u.memory) }
      ]
    : [];
  const loud = (tone: 'bad' | 'warn') =>
    verdicts.filter(x => x.v.tone === tone && x.v.label).map(x => `${x.what}: ${x.v.label}`);

  if (failing) return { status: 'critical', reason: `${plural(failing, 'workload')} failing or unavailable` };
  if (u.oomKilled && u.oomKilled > 0) return { status: 'critical', reason: `${plural(u.oomKilled, 'pod')} OOMKilled` };
  const bad = loud('bad');
  if (bad.length) return { status: 'critical', reason: bad.join(' · ') };

  if (!workloadsComplete) {
    return { status: 'unknown', reason: 'The workloads read was incomplete, so this namespace was not assessed' };
  }
  if (u.pods === 0 && !wls.some(w => w.desired > 0)) return { status: 'empty', reason: 'No pods in this namespace' };

  if (degraded) return { status: 'warning', reason: `${plural(degraded, 'workload')} not fully ready` };
  const warn = loud('warn');
  if (warn.length) return { status: 'warning', reason: warn.join(' · ') };

  if (wls.length === 0) {
    return u.pods === null
      ? { status: 'unknown', reason: 'The pod count was not read, so nothing here is known' }
      : {
          status: 'unknown',
          reason: `${plural(u.pods, 'pod')}, none owned by a Deployment, StatefulSet or DaemonSet (Jobs or bare pods), so none assessed`
        };
  }
  return { status: 'healthy', reason: 'Every workload ready, usage within its requests and limits' };
}

function newest(wls: readonly WorkloadRow[]): string | null {
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const w of wls) {
    for (const iso of [w.createdAt, w.restartedAt]) {
      const at = iso ? Date.parse(iso) : NaN;
      if (Number.isFinite(at) && at > bestAt) {
        bestAt = at;
        best = iso;
      }
    }
  }
  return best;
}

/**
 * One row per namespace in the inventory, in the Overview's reading order (`orderNamespaces`).
 *
 * `util` is `null` while the workloads figures are unavailable; rows still render, without meters.
 * `workloadsComplete` is false when the workloads read was refused or partial: a namespace can then
 * still be Critical on evidence, but never Empty or Healthy.
 */
export function buildNamespaceTable(
  rows: readonly NamespaceRow[],
  util: readonly UtilizationNamespace[] | null,
  items: readonly WorkloadRow[],
  workloadsComplete = true
): NamespaceTableRow[] {
  const usage = mergeNamespaceUsage(orderNamespaces([...rows]), util);
  const byNs = new Map<string, WorkloadRow[]>();
  for (const w of items) {
    const list = byNs.get(w.namespace);
    if (list) list.push(w);
    else byNs.set(w.namespace, [w]);
  }
  return usage.map(u => {
    const wls = byNs.get(u.namespace) ?? [];
    const { status, reason } = statusOf(u, wls, workloadsComplete);
    return {
      namespace: u.namespace,
      type: namespaceType(u),
      usage: u,
      workloads: wls.length,
      status,
      statusReason: reason,
      lastUpdated: newest(wls)
    };
  });
}

/** What a CPU or Memory cell draws: the shared meter, or one sentence instead of a fake zero. */
export type ResourceCell = { kind: 'meter' } | { kind: 'text'; text: string; title: string };

export function resourceCell(u: NamespaceUsage): ResourceCell {
  if (u.pods === 0) {
    return { kind: 'text', text: 'No pods', title: 'This namespace has no pods, so there is nothing to measure.' };
  }
  if (!u.measured) {
    if (u.pods === null) {
      return { kind: 'text', text: 'No data', title: 'Neither the pod count nor any usage figure was read for this namespace.' };
    }
    return {
      kind: 'text',
      text: 'Not measured',
      title: 'Its pods are not selected by a Deployment, StatefulSet or DaemonSet (Jobs or bare pods), so no figures are summed.'
    };
  }
  return { kind: 'meter' };
}

export interface NamespaceTableFilter {
  search: string;
  /** Off by default: the table opens on application namespaces. Choosing Type = System overrides it. */
  showSystem: boolean;
  type: 'all' | NamespaceType;
  status: 'all' | NamespaceStatus;
}

export const NO_NAMESPACE_FILTER: NamespaceTableFilter = { search: '', showSystem: false, type: 'all', status: 'all' };

/**
 * Whether system namespaces are in the rows: ticked, or Type = System. What the toggle displays, so
 * it never reads as off while the table lists nothing but system namespaces.
 */
export function showsSystem(f: NamespaceTableFilter): boolean {
  return f.showSystem || f.type === 'system';
}

/**
 * The toggle's write. Type = Application or Other excludes every system row on its own, so ticking
 * the box there changed nothing and read as broken (reported 2026-09-27): it widens Type to All.
 * Unticking it under Type = System leaves System for All, or the box would stay ticked.
 */
export function withShowSystem(f: NamespaceTableFilter, on: boolean): NamespaceTableFilter {
  const narrowed = f.type === 'application' || f.type === 'other';
  const type = (on && narrowed) || (!on && f.type === 'system') ? 'all' : f.type;
  return { ...f, showSystem: on, type };
}

/**
 * The Type select's write, the other half of the same rule: Application and Other exclude every
 * system row, so a ticked Show system is dropped there rather than sitting ticked over nothing.
 */
export function withType(f: NamespaceTableFilter, type: NamespaceTableFilter['type']): NamespaceTableFilter {
  return { ...f, type, showSystem: type === 'application' || type === 'other' ? false : f.showSystem };
}

/** Every control at once, so the row list and the count line come from one pass. */
export function filterNamespaceTable(
  rows: readonly NamespaceTableRow[],
  f: NamespaceTableFilter
): NamespaceTableRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(
    r =>
      (!q || r.namespace.toLowerCase().includes(q)) &&
      (f.showSystem || f.type === 'system' || r.type !== 'system') &&
      (f.type === 'all' || r.type === f.type) &&
      (f.status === 'all' || r.status === f.status)
  );
}

/** How many controls differ from their default, for `FilterBar`'s reset. */
export function activeNamespaceFilters(f: NamespaceTableFilter): number {
  return (f.search.trim() ? 1 : 0) + (f.showSystem ? 1 : 0) + (f.type !== 'all' ? 1 : 0) + (f.status !== 'all' ? 1 : 0);
}

/**
 * System namespaces the toggle is hiding right now. Only Type = All counts: Application and Other
 * exclude system rows whatever the toggle says, so offering it there would be advice that does nothing.
 */
export function hiddenSystemCount(f: NamespaceTableFilter, system: number): number {
  return !f.showSystem && f.type === 'all' ? system : 0;
}
