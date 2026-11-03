/**
 * Ordering and wording for the namespace list behind Namespaces & Workloads → Namespaces.
 *
 * Separate from the component because `app/fleet-ui` runs vitest under `environment: 'node'` with
 * no jsdom, so anything left inside the `.tsx` has no test behind it. The two rules worth pinning
 * are both cases where the obvious implementation is quietly wrong:
 *
 *  - **A null pod count is not a zero.** The count is null when the cluster-wide pod list was
 *    refused or truncated. Sorting those rows as 0 buries them at the bottom as if they were
 *    empty namespaces, which is the one place an operator would never look for "we could not
 *    read this".
 *  - **System namespaces sort last, they do not disappear.** On a managed cluster they are often the
 *    majority of the list and most of the pods, so hiding them makes the totals look wrong; they
 *    are marked instead.
 */

import type { NamespaceRow } from '../../api';

/** A pod count as text. Null is `—`, never `0` — see the module note. */
export function podCountText(pods: number | null | undefined): string {
  return pods === null || pods === undefined ? '—' : String(pods);
}

/**
 * Reading order: application namespaces first, then system ones; within each, the busiest first,
 * and unknown counts above the zeros rather than among them.
 */
export function orderNamespaces(rows: NamespaceRow[]): NamespaceRow[] {
  // Real counts are integers, so 0.5 places an unknown between the last namespace that has pods
  // and the ones that have none. That is the honest position: we cannot claim it is busy, and we
  // must not file it with the empty namespaces at the bottom, which is what reading null as 0
  // does. (`-1` and `Infinity` were both tried and both overshoot, in opposite directions.)
  const UNKNOWN = 0.5;
  const weight = (r: NamespaceRow) => (r.pods === null || r.pods === undefined ? UNKNOWN : r.pods);
  return [...rows].sort((a, b) => {
    if (a.system !== b.system) return a.system ? 1 : -1;
    // Compared, not subtracted. The weights are close together by construction (0.5 sits between
    // 0 and 1), and an explicit inequality keeps the tiebreak below reachable rather than relying
    // on a difference that never rounds to exactly zero.
    const wa = weight(a);
    const wb = weight(b);
    if (wa !== wb) return wb - wa;
    return a.namespace.localeCompare(b.namespace);
  });
}

/**
 * The line above the table.
 *
 * It has to state the pod total, and it has to refuse to state one when any count is missing —
 * summing a list with holes in it produces a confident number that is smaller than the truth.
 */
export function namespaceHeadline(
  rows: NamespaceRow[],
  reason: 'unavailable' | 'truncated' | null | undefined
): string {
  const n = rows.length;
  const nsWord = `${n} namespace${n === 1 ? '' : 's'}`;
  const system = rows.filter(r => r.system).length;
  const marked = system ? ` ${system} of them belong to Kubernetes or the platform and are marked as system.` : '';
  if (reason === 'unavailable') {
    return `${nsWord}. The pod list was refused, so no namespace here has a pod count — that is not the same as their being empty.${marked}`;
  }
  if (reason === 'truncated') {
    return `${nsWord}. The pod list came back short of the whole cluster, so the counts would be undercounts and none is shown.${marked}`;
  }
  const total = rows.reduce((sum, r) => sum + (r.pods ?? 0), 0);
  return `${nsWord} holding ${total} pod${total === 1 ? '' : 's'}.${marked}`;
}
