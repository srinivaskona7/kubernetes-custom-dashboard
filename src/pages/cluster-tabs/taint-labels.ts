/**
 * How a taint and a toleration are described in words.
 *
 * Separate from the components because every sentence here is a claim about Kubernetes semantics
 * that a screenshot cannot check, and `app/fleet-ui` runs vitest under `environment: 'node'` with
 * no jsdom — logic left inside a `.tsx` is logic with no test.
 *
 * The rule that drives most of this file: **an empty field in a toleration is a wildcard, not a
 * blank.** `operator: Exists` with no key tolerates every taint on the cluster; an absent effect
 * matches every effect. Rendered literally, the most permissive row on the page is the one with
 * the fewest characters in it, which is exactly backwards. Measured on a live cluster: 42 of the
 * 50 authored tolerations were this universal form.
 */

import type { NodeTaint, PodToleration } from '../../api';

/** What a taint's effect does, in the operator's terms rather than the API's. */
export function effectMeaning(effect: string | null): string {
  switch (effect) {
    case 'NoSchedule':
      return 'No new pod is scheduled here unless it tolerates this taint. Pods already running stay.';
    case 'PreferNoSchedule':
      return 'The scheduler avoids this node when it can, but will still place a pod here rather than leave it pending. A preference, not a rule.';
    case 'NoExecute':
      return 'No new pod is scheduled here, and any running pod that does not tolerate this taint is evicted.';
    default:
      return 'This taint came back with no effect. The API server does not accept a taint without one, so this read is malformed rather than permissive.';
  }
}

/**
 * A toleration as one readable clause.
 *
 * The wildcard cases are spelled out rather than rendered as gaps, because "tolerates everything"
 * and "nothing configured" look identical when the key and effect columns are both empty.
 */
export function tolerationText(t: PodToleration): string {
  const scope = t.universal
    ? 'any taint'
    : t.key
      ? t.operator === 'Exists'
        ? `any taint keyed ${t.key}`
        : `${t.key}=${t.value ?? ''}`
      : 'any taint';
  const where = t.effect ? ` with effect ${t.effect}` : ' with any effect';
  const secs =
    t.tolerationSeconds === null || t.tolerationSeconds === undefined
      ? ''
      : `, for up to ${t.tolerationSeconds}s after the taint appears`;
  return `Tolerates ${scope}${where}${secs}`;
}

/** The three states a toleration can be in, worst-understood first. */
export type TolerationState = 'universal' | 'inert' | 'unchecked' | 'active';

export function tolerationState(t: PodToleration): TolerationState {
  if (t.inert === null || t.inert === undefined) return 'unchecked';
  if (t.universal) return 'universal';
  return t.inert ? 'inert' : 'active';
}

export function tolerationStateText(state: TolerationState): string {
  switch (state) {
    case 'universal':
      return 'Tolerates every taint on the cluster, including taints added later. This is what a DaemonSet that must run everywhere declares, and it is the broadest permission a pod can hold.';
    case 'inert':
      return 'Matches no taint currently on this cluster, so it grants nothing today. It is not an error — it is a permission held against a taint that does not exist yet.';
    case 'active':
      return 'Matches a taint a node is declaring right now. The pod is permitted onto those nodes; whether it is running on one is a separate column.';
    case 'unchecked':
      return 'The node list could not be read, so whether this toleration matches any real taint is unknown. Not the same as matching nothing.';
  }
}

/**
 * The headline for the Taints sub-tab.
 *
 * Three different empty screens live here and only one of them is a problem:
 *  - nodes unread: unknown, and the count must not render as 0
 *  - nodes read, none tainted: a true zero, and the common case on a managed cluster
 *  - tainted: the real inventory
 */
export function taintsHeadline(summary: {
  nodesReporting: number | null;
  taints: number | null;
  taintedNodes: number | null;
}): string {
  if (summary.nodesReporting === null || summary.taints === null) {
    return 'The node list could not be read, so the taints on this cluster are unknown — not zero.';
  }
  if (summary.taints === 0) {
    const n = summary.nodesReporting;
    return `No taint is declared on ${n === 1 ? 'the one node' : `any of the ${n} nodes`} this cluster reported. Nothing is being kept off a node by a taint, so every toleration on the Tolerations sub-tab grants nothing today.`;
  }
  return `${summary.taints} ${summary.taints === 1 ? 'taint' : 'taints'} across ${summary.taintedNodes} of ${summary.nodesReporting} nodes.`;
}

/** The headline for the Tolerations sub-tab, which has to explain why the count is not every pod. */
export function tolerationsHeadline(summary: {
  podsRead: number | null;
  podsWithAuthoredTolerations: number | null;
  podsWithUniversalToleration: number | null;
}): string {
  if (summary.podsRead === null || summary.podsWithAuthoredTolerations === null) {
    return 'The pod list could not be read, so which pods declare a toleration is unknown.';
  }
  const { podsRead, podsWithAuthoredTolerations: authored, podsWithUniversalToleration: universal } = summary;
  const head = `${authored} of ${podsRead} pods declare a toleration of their own.`;
  // Without this sentence the other number looks like a bug: every pod really does have a
  // toleration, and a reader who knows that will read "50 of 120" as a broken filter.
  const why = ` Kubernetes injects a not-ready and an unreachable toleration into every pod, so all ${podsRead} would otherwise qualify; those two are filtered out here.`;
  const uni = universal ? ` ${universal} hold a toleration that matches every taint on the cluster.` : '';
  return head + why + uni;
}

/** Sort order for the toleration rows: the broadest permissions first, because they matter most. */
export function tolerationSortRank(t: PodToleration): number {
  const state = tolerationState(t);
  if (state === 'universal') return 0;
  if (state === 'active') return 1;
  if (state === 'unchecked') return 2;
  return 3;
}

/** A taint as `key=value:Effect`, matching how kubectl prints it so the two can be compared. */
export function taintText(t: Pick<NodeTaint, 'key' | 'value' | 'effect'>): string {
  const kv = t.value ? `${t.key}=${t.value}` : `${t.key ?? ''}`;
  return `${kv}:${t.effect ?? '(no effect)'}`;
}
