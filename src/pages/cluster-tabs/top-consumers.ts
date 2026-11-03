/**
 * Namespaces & Workloads → Top Consumers: which pods are using the most CPU and memory right now.
 *
 * Every figure is one metrics-server sample from the workloads payload the page already holds — no
 * history and no averaging. A row is ranked by the pod-level usage the model carries, and its meter
 * is drawn from the same fields, so the row at the top is the one whose meter holds the largest
 * value. A pod with no sample is left out of the ranking and counted, never ranked as zero.
 */
import type { Figures } from './namespace-usage';
import { declared } from './namespace-usage';
import { scopePods } from './pod-table';
import { rankTopN, type UtilizationPod } from './usage/utilization-model';

export type Metric = 'cpu' | 'memory';
export type TopCount = 10 | 20 | 50;
export const TOP_COUNTS: readonly TopCount[] = [10, 20, 50];
const DEFAULT_TOP: TopCount = 10;

/** `?top=`: one of the offered sizes, else the default. Exact match, so `20abc` is not 20. */
export function parseTop(raw: string | null): TopCount {
  return TOP_COUNTS.map(String).includes(raw ?? '') ? (Number(raw) as TopCount) : DEFAULT_TOP;
}

/** The default is left out of the URL, so a plain link and a link with `top=10` are one address. */
export function serializeTop(n: TopCount): string | null {
  return n === DEFAULT_TOP ? null : String(n);
}

export function usageOf(p: UtilizationPod, m: Metric): number | null {
  return m === 'cpu' ? p.cpuUsage : p.memoryUsage;
}

/**
 * The meter's three numbers, from the pod-level fields the ranking reads.
 *
 * The limit is partial when a running container declares none: the pod then has no ceiling, and
 * the summed limit covers only some of what `used` measures. `ResourceMeter` prints that with `≥`
 * and does not grade against it.
 */
export function topFigures(p: UtilizationPod, m: Metric): Figures {
  const limit = declared(m === 'cpu' ? p.cpuLimit : p.memoryLimit);
  const running = p.containers.filter(c => !c.init || c.sidecar);
  const unlimited = running.some(c => declared(m === 'cpu' ? c.cpuLimit : c.memoryLimit) === null);
  return {
    used: usageOf(p, m),
    request: declared(m === 'cpu' ? p.cpuRequest : p.memoryRequest),
    limit,
    limitPartial: limit !== null && unlimited
  };
}

/** The namespace selection and the system toggle, by the same rule the Pods sub-tab applies. */
export function scopeConsumers(
  pods: readonly UtilizationPod[],
  system: ReadonlySet<string> | null,
  showSystem: boolean,
  selected: ReadonlySet<string>
): UtilizationPod[] {
  return scopePods(pods, system, showSystem, selected);
}

/** Largest first, sampled pods only; ties keep input order (`rankTopN` is stable). */
export function rankConsumers(
  pods: readonly UtilizationPod[],
  m: Metric,
  top: TopCount
): { rows: UtilizationPod[]; unsampled: number } {
  const sampled = pods.filter(p => usageOf(p, m) !== null);
  return { rows: rankTopN(sampled, p => usageOf(p, m), top), unsampled: pods.length - sampled.length };
}

/** Why there is nothing to rank. The order matters: a failed read is never reported as an empty cluster. */
export type EmptyReason = { kind: 'unavailable' } | { kind: 'system'; hidden: number } | { kind: 'namespaces' } | { kind: 'none' };

export function emptyReason({
  inNamespaces,
  scoped,
  selected,
  status
}: {
  /** Pods after the namespace selection, before the system toggle. */
  inNamespaces: number;
  /** Pods after both. */
  scoped: number;
  /** Namespaces selected; 0 is all. */
  selected: number;
  status: { state: 'ok' | 'partial' | 'unavailable' };
}): EmptyReason | null {
  if (scoped > 0) return null;
  if (status.state === 'unavailable') return { kind: 'unavailable' };
  if (inNamespaces > 0) return { kind: 'system', hidden: inNamespaces };
  return selected > 0 ? { kind: 'namespaces' } : { kind: 'none' };
}

/**
 * Each ranked figure is one pod's exact sample, so an unsampled pod does not make a figure a floor;
 * it makes the ranking incomplete, because that pod could belong in it.
 */
export function unsampledNote(missing: number, counted: number): string | null {
  if (missing <= 0) return null;
  return `${missing} of ${counted} pods reported no usage sample and are not ranked; one of them may belong in this list.`;
}

/**
 * A pod name split so the generated suffix can stay visible while the head truncates: replicas of
 * one workload share everything but the last segment (the ReplicaSet pod hash or the StatefulSet
 * ordinal), and a tail-truncated name made them read as identical rows.
 */
export function podNameParts(name: string): { head: string; tail: string } {
  const at = name.lastIndexOf('-');
  if (at <= 0 || name.length - at - 1 > 8) return { head: name, tail: '' };
  return { head: name.slice(0, at), tail: name.slice(at) };
}
