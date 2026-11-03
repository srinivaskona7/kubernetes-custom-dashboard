/**
 * The arithmetic behind the Namespaces & Workloads → Namespaces table's CPU and memory.
 *
 * The table joins two reads that answer different halves of the question:
 *
 *  - **`/clusters/:id/namespaces`** is the namespace inventory and the pod count. It is the
 *    authoritative list — every namespace on the cluster appears, including ones holding nothing
 *    a workload selector claims.
 *  - **`/clusters/:id/workloads`** is where CPU and memory come from, via
 *    `buildUtilizationModel`. It only sees pods selected by a Deployment, StatefulSet or
 *    DaemonSet, so a namespace can legitimately have pods and no figures.
 *
 * Keeping the inventory on the left of the join is the whole point. Driving the rows off the
 * utilization rows instead would silently drop every namespace whose pods are Jobs or bare pods,
 * and a namespace missing from a list reads as "not on this cluster" rather than "not measured".
 *
 * Lives in a `.ts` with no JSX because `app/fleet-ui` runs vitest under `environment: 'node'` —
 * anything left in the `.tsx` has no test behind it.
 */

import type { NamespaceRow } from '../../api';
import type { UtilizationNamespace } from './usage/utilization-model';

/** One resource's three numbers. `null` means *not known*, and `0` request/limit means none declared. */
export interface Figures {
  /** Cores or bytes actually sampled. `null` when no pod in the namespace reported. */
  used: number | null;
  /** Summed requests, or `null` when nothing in the namespace declared one. */
  request: number | null;
  /** Summed limits, or `null` when nothing declared one. */
  limit: number | null;
  /**
   * Some measured pods declared no limit, so the namespace has no ceiling at all and the summed
   * limit covers fewer pods than `used` does. Grading against it would compare every pod's usage
   * with a few pods' ceiling — one unlimited pod using 2 GiB beside a 256 MiB-limited one reads as
   * 880% "at limit". A partial limit is printed with `≥`, never graded. (Requests need no such
   * flag: a pod without one reserves 0, so the sum *is* the namespace's reservation.)
   */
  limitPartial?: boolean;
}

/** One card. */
export interface NamespaceUsage {
  namespace: string;
  system: boolean;
  /** Pods the cluster reports in this namespace. `null` when the pod list was refused or short. */
  pods: number | null;
  /** Pods the CPU and memory figures are summed over. `0` when the namespace was not measured. */
  podsMeasured: number;
  /** Measured pods that returned no usage sample — above zero, `used` is a floor, not a total. */
  usageMissing: number;
  cpu: Figures;
  memory: Figures;
  restarts: number | null;
  oomKilled: number | null;
  /** False when no workload-selected pod was found here, so the two meters have nothing to draw. */
  measured: boolean;
}

/**
 * A Kubernetes request or limit of `0` is not a budget of zero — it is the absence of a
 * declaration, and `aggregateNamespaceResources` sums it as `0`. Rendering that as a denominator
 * produces `Infinity%`; rendering it as a number tells an operator a ceiling exists.
 */
export function declared(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** A declared limit sum that some counted pods contributed nothing to. */
function partial(u: UtilizationNamespace | undefined, sum: number | null | undefined, without: number | undefined): boolean {
  return Boolean(u && declared(sum) !== null && (without ?? 0) > 0);
}

/**
 * Join the namespace inventory to its utilization rows.
 *
 * `util` is `null` while the workloads read is in flight or after it failed; the rows still
 * render, with pod counts and without meters. That is deliberate — the namespace list is the
 * cheaper read and must not be held hostage to the expensive one.
 */
export function mergeNamespaceUsage(
  rows: readonly NamespaceRow[],
  util: readonly UtilizationNamespace[] | null
): NamespaceUsage[] {
  const byNs = new Map<string, UtilizationNamespace>();
  for (const n of util ?? []) byNs.set(n.namespace, n);
  return rows.map(r => {
    const u = byNs.get(r.namespace);
    return {
      namespace: r.namespace,
      system: Boolean(r.system),
      pods: r.pods ?? null,
      podsMeasured: u ? u.pods : 0,
      usageMissing: u ? u.usageMissing : 0,
      cpu: {
        used: u ? u.cpuUsage : null,
        request: u ? declared(u.cpuRequest) : null,
        limit: u ? declared(u.cpuLimit) : null,
        limitPartial: partial(u, u?.cpuLimit, u?.noCpuLimit)
      },
      memory: {
        used: u ? u.memoryUsage : null,
        request: u ? declared(u.memoryRequest) : null,
        limit: u ? declared(u.memoryLimit) : null,
        limitPartial: partial(u, u?.memoryLimit, u?.noMemoryLimit)
      },
      restarts: u ? u.restarts : null,
      oomKilled: u ? u.oomKilled : null,
      measured: Boolean(u)
    };
  });
}

/** The two meters draw on one shared scale per card row. */
export interface MeterGeometry {
  /** The value the track's full width represents, or `null` when there is nothing to draw. */
  scale: number | null;
  /** Fill width as a percentage of the track. `0` when usage was not read. */
  usedPct: number;
  /** Where the request tick sits, or `null` when none was declared. */
  requestPct: number | null;
  /** Where the limit tick sits, or `null` when none was declared. */
  limitPct: number | null;
}

/**
 * Lay a used / request / limit triple out on one track.
 *
 * The track is scaled to the **largest of the three**, not to the limit. Scaling to the limit
 * would make a namespace that declared none unplottable, and scaling to the request would push a
 * bursting namespace off the end — which is exactly the namespace worth looking at.
 */
export function meterGeometry(f: Figures): MeterGeometry {
  const scale = Math.max(f.used ?? 0, f.request ?? 0, f.limit ?? 0);
  if (!(scale > 0)) return { scale: null, usedPct: 0, requestPct: null, limitPct: null };
  const at = (n: number | null) => (n === null ? null : Math.min(100, (n / scale) * 100));
  return {
    scale,
    usedPct: at(f.used) ?? 0,
    requestPct: at(f.request),
    limitPct: at(f.limit)
  };
}

/** A percentage of a denominator, or `null` when either side is unknown. Never `Infinity`. */
export function pctOf(used: number | null, basis: number | null): number | null {
  if (used === null || basis === null || !(basis > 0)) return null;
  return Math.round((used / basis) * 100);
}

export type UsageTone = 'ok' | 'warn' | 'bad' | 'unknown';

/**
 * Where usage sits on the one ladder every resource meter shares, loudest last:
 * `normal` → `above-request` (amber) → `near-limit` (stronger) → `at-limit` (critical).
 *
 * `tone` alone cannot say this: memory near its limit and memory at its limit are both `bad`,
 * and the meter has to draw them differently or "OOMKill likely" and "OOMKilling now" look alike.
 */
export type UsageLevel = 'normal' | 'above-request' | 'near-limit' | 'at-limit' | 'unknown';

/** What a card says about one resource, and how loudly. */
export interface UsageVerdict {
  tone: UsageTone;
  level: UsageLevel;
  /** Short label for the badge, or `null` when there is nothing worth saying. */
  label: string | null;
  /** The long form, for the badge's `title`. */
  detail: string | null;
}

/**
 * Grade one resource.
 *
 * The thresholds are deliberately not `band()`. Running above your request is how Burstable pods
 * are *designed* to work — it is worth a word, not a red badge — whereas approaching a limit is
 * the kernel's business: memory ends in an OOMKill, CPU in throttling. So the limit drives the
 * severity and the request only ever earns an amber.
 *
 * The wording is fixed by a prior decision: **"Above request"**, never "CPU error". One is a
 * scheduling observation, the other accuses the operator of a misconfiguration.
 */
export type UsageScope = 'namespace' | 'pod' | 'container';

/**
 * A missing sample reads "No data" on the Pods page (the wording its request named) and keeps the
 * Namespaces table's established "No sample". Same state, same `unknown` tone; only the word moves.
 */
const NO_SAMPLE_LABEL: Record<UsageScope, string> = { namespace: 'No sample', pod: 'No data', container: 'No data' };

const NO_SAMPLE_DETAIL: Record<UsageScope, string> = {
  namespace: 'No pod in this namespace reported a usage sample, so nothing here is measured.',
  pod: 'metrics-server returned no usage sample for this pod, so nothing here is measured.',
  container: 'metrics-server returned no usage sample for this container, so nothing here is measured.'
};

/**
 * `scope` only changes the wording: a namespace's and a pod's figures are sums over their pods or
 * containers, a container's are its own. The ladder and every threshold are the same for all three,
 * so a pod row and the namespace it sits in cannot disagree about when to raise a flag.
 */
export function usageVerdict(metric: 'cpu' | 'memory', f: Figures, scope: UsageScope = 'namespace'): UsageVerdict {
  if (f.used === null) {
    return {
      tone: 'unknown',
      level: 'unknown',
      label: NO_SAMPLE_LABEL[scope],
      detail: NO_SAMPLE_DETAIL[scope]
    };
  }
  const basis = scope === 'container' ? 'limit' : 'summed limit';
  const reqBasis = scope === 'container' ? 'request' : 'summed request';
  const ofLimit = f.limitPartial ? null : pctOf(f.used, f.limit);
  const ofRequest = pctOf(f.used, f.request);
  const what = metric === 'cpu' ? 'CPU' : 'Memory';
  if (ofLimit !== null && ofLimit >= 100) {
    return {
      tone: 'bad',
      level: 'at-limit',
      label: 'At limit',
      detail:
        metric === 'memory'
          ? `Memory usage has reached the ${basis} (${ofLimit}%). Pods at their own limit are OOMKilled.`
          : `CPU usage has reached the ${basis} (${ofLimit}%), so pods at their own limit are being throttled.`
    };
  }
  // 80% of a memory limit and 95% of a CPU limit are the same warning the pod tables use, so a
  // namespace card and the pod row it leads to cannot disagree about whether to raise a flag.
  // `warn`, not `bad`: approaching a limit is the stronger *warning*; only reaching it is critical.
  if (metric === 'memory' && ofLimit !== null && ofLimit >= 80) {
    return {
      tone: 'warn',
      level: 'near-limit',
      label: 'Near memory limit',
      detail: `Memory usage is ${ofLimit}% of the ${basis}. Above 80% an OOMKill is the likely next event.`
    };
  }
  if (metric === 'cpu' && ofLimit !== null && ofLimit >= 95) {
    return {
      tone: 'warn',
      level: 'near-limit',
      label: 'Throttling likely',
      detail: `CPU usage is ${ofLimit}% of the ${basis}. At the limit the kernel throttles rather than kills.`
    };
  }
  if (ofRequest !== null && ofRequest > 100) {
    return {
      tone: 'warn',
      level: 'above-request',
      label: 'Above request',
      detail: `${what} usage is ${ofRequest}% of the ${reqBasis} — normal for Burstable pods, and a sign the request is set low.`
    };
  }
  return { tone: 'ok', level: 'normal', label: null, detail: null };
}

/**
 * The caption under a meter: the three figures, each named, with "none" where nothing was
 * declared. `fmt` is the unit's formatter (`cpu` or `mem`), injected so this module holds no
 * formatting of its own.
 */
export function figuresText(f: Figures, fmt: (n: number | null | undefined) => string): string {
  const req = f.request === null ? 'none' : fmt(f.request);
  // `≥` on a partial limit: some pods declared none, so the namespace's true ceiling is unbounded.
  const lim = f.limit === null ? 'none' : `${f.limitPartial ? '≥' : ''}${fmt(f.limit)}`;
  return `used ${fmt(f.used)} · req ${req} · lim ${lim}`;
}

/**
 * The right-hand figure on a meter.
 *
 * Three different nothings, and printing one em dash for all of them was the first version's
 * mistake: **no request configured** is a fact about the pod spec, **no sample** is a fact about
 * metrics-server, and they lead an operator to different places. The percentage always names its
 * denominator — a bare `115%` invites the reader to supply their own basis.
 */
export function ofRequestText(f: Figures, scope: UsageScope = 'namespace'): string {
  if (f.request === null) return f.used === null ? 'not measured' : 'no request configured';
  if (f.used === null) return NO_SAMPLE_LABEL[scope].toLowerCase();
  const raw = (f.used / f.request) * 100;
  // A namespace using a fraction of a percent of its request must not print `0% of request`, which
  // reads as idle and is how a live sample becomes a rendered zero. The Namespaces table one click
  // away prints `0.9%` for the same row, so this stays below 1% rather than rounding up to meet it.
  if (raw > 0 && raw < 1) return '<1% of request';
  return `${Math.round(raw)}% of request`;
}

/**
 * Summed container restarts for a namespace, or `null` when there is nothing to say.
 *
 * Grouped with separators because these are sums over every container of every pod and they get
 * genuinely large — a five-digit run-on like `37431restarts` reads as a typo, and the number is the
 * whole point of the line.
 */
export function restartsText(n: NamespaceUsage): string | null {
  if (!n.restarts || n.restarts <= 0) return null;
  return `${n.restarts.toLocaleString('en-US')} container restarts, summed since each pod started`;
}

/** `1 pod`, `4 pods`, and `—` for a count that was never read. */
export function podsLabel(pods: number | null): string {
  return pods === 1 ? 'pod' : 'pods';
}

/**
 * What the card has to admit about its own coverage, or `null` when it has nothing to admit.
 *
 * Two different shortfalls, and they must not be collapsed into one sentence: pods no workload
 * selects are *absent* from the figures, while pods that returned no sample are *counted but
 * silent*. The first makes the sums too small, the second makes them a floor.
 */
export function coverageNote(n: NamespaceUsage): string | null {
  const parts: string[] = [];
  if (n.pods !== null && n.podsMeasured < n.pods) {
    const outside = n.pods - n.podsMeasured;
    parts.push(
      `${outside} of ${n.pods} pods are not selected by a Deployment, StatefulSet or DaemonSet, so they are outside these figures`
    );
  }
  if (n.usageMissing > 0) {
    parts.push(`${n.usageMissing} measured pod${n.usageMissing === 1 ? '' : 's'} reported no sample, so usage is a floor`);
  }
  if (!parts.length) return null;
  return `${parts.join('; ')}.`;
}
