/**
 * Namespaces → Top namespaces by CPU and by memory.
 *
 * Ranked by what the namespace's pods are using now (the metrics-server sample summed over them),
 * never by what they requested or were limited to: a namespace that reserves eight cores and uses
 * two millicores is not a top consumer. The bar is the namespace's usage against the top row's.
 */
import { cpu } from '../../format';
import { mem } from './usage/shared';
import { rankTopN, type UtilizationNamespace } from './usage/utilization-model';
import type { Metric } from './top-consumers';

/** Rows a ranking view offers (`?ntop=`); 10 is the default and stays out of the URL. */
export type NamespaceTop = 10 | 20 | 30 | 'all';
export const NAMESPACE_TOPS: readonly NamespaceTop[] = [10, 20, 30, 'all'];

/** `?ntop=`: one of the offered sizes, else 10. Exact match, so `20abc` is not 20. */
export function namespaceTop(raw: string | null): NamespaceTop {
  return NAMESPACE_TOPS.find(t => String(t) === raw) ?? 10;
}

/** The heading names what the table shows: a cap the cluster does not fill reads as the real count. */
export function namespaceTopLabel(top: NamespaceTop, m: Metric, shown: number): string {
  const what = m === 'cpu' ? 'CPU' : 'memory';
  if (shown === 0) return `Top namespaces by ${what} used`;
  return top === 'all' ? `All ${shown} namespaces by ${what} used` : `Top ${Math.min(top, shown)} namespaces by ${what} used`;
}

/** The Namespaces sub-tab's view: the full list (default), or one ranking. `?nsview=`. */
export type NamespaceView = 'list' | Metric;

export function namespaceView(raw: string | null): NamespaceView {
  return raw === 'cpu' || raw === 'memory' ? raw : 'list';
}

export function namespaceUsage(n: UtilizationNamespace, m: Metric): number | null {
  return m === 'cpu' ? n.cpuUsage : n.memoryUsage;
}

/**
 * Sampled namespaces only, largest first, among those the page lists (`visible`; `null` is all).
 * A namespace none of whose pods reported a sample is counted, not ranked as a zero.
 */
export function rankNamespaces(
  rows: readonly UtilizationNamespace[],
  visible: ReadonlySet<string> | null,
  m: Metric,
  top: NamespaceTop | number
): { rows: UtilizationNamespace[]; unsampled: number } {
  const listed = visible ? rows.filter(r => visible.has(r.namespace)) : rows;
  const sampled = listed.filter(r => namespaceUsage(r, m) !== null);
  return { rows: rankTopN(sampled, r => namespaceUsage(r, m), top), unsampled: listed.length - sampled.length };
}

/** Fraction of the bar: this namespace's usage against the top row's. */
export function usageBar(value: number, max: number): number {
  return max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
}

/** The figure, with "≥" when some of its pods reported no sample, so the sum is a floor. */
export function usageText(n: UtilizationNamespace, m: Metric): string {
  const text = m === 'cpu' ? cpu(n.cpuUsage) : mem(n.memoryUsage);
  return n.usageMissing > 0 ? `≥ ${text}` : text;
}

/**
 * Why a ranking table is empty, most upstream cause first: a failed workloads read is not "no
 * sample", and filters that list nothing are not the cluster's doing.
 */
export function rankedEmpty({
  metricsAvailable,
  workloadsRead,
  listed,
  metric
}: {
  metricsAvailable: boolean;
  workloadsRead: boolean;
  listed: number;
  metric: Metric;
}): { title: string; hint: string } {
  const what = metric === 'cpu' ? 'CPU' : 'Memory';
  if (!metricsAvailable)
    return {
      title: `${what} ranking unavailable`,
      hint: 'metrics-server is not answering on this cluster, so no namespace has a usage sample to rank. Requests and limits are not used in its place.'
    };
  if (!workloadsRead)
    return {
      title: `${what} ranking unavailable`,
      hint: 'The workloads read failed, so no namespace usage could be summed. This is an unread value, not an idle cluster.'
    };
  if (listed === 0) return { title: 'No namespace matches the filters', hint: 'Clear or widen the filters above to rank namespaces.' };
  return { title: `No ${what} sample`, hint: `None of the listed namespaces reported a ${what} sample in this snapshot.` };
}
