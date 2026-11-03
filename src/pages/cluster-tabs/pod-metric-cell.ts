/**
 * How a pod row prints Used / Request / Limit, and the two zeros that are not zero.
 *
 * Pulled out of `ClusterDetail.tsx` as JSX-free logic because both rules here are the kind that
 * looks right in a cell and is wrong in the data:
 *
 *  1. **A missing sample is not 0.** `bytes()` in `format.ts` returns the string `'0'` for `null`
 *     and `undefined` — fine where the caller has already proved the read succeeded, wrong here.
 *     When metrics-server did not answer, `memoryUsage` is `null`, and printing `0 B` claims the
 *     container is using no memory. `cpu()` already returns an em dash for null; `bytes()` does not,
 *     and that asymmetry is exactly the trap. Usage goes through `usedText`, never through `bytes`.
 *
 *  2. **A limit of 0 is "no limit", not "a limit of zero".** The pod's `cpuLimit`/`memoryLimit` are
 *     sums over its containers, so a pod where nothing declares a limit sums to 0. Rendering `0`
 *     says the pod may use nothing, when it means the opposite — the pod is unbounded and is the
 *     first thing the node kills under pressure. `capacity.js` tracks the same fact as
 *     `unboundedContainers`, and this is the per-row face of it.
 *
 * Kubernetes semantics worth keeping straight while reading this: CPU is compressible, so exceeding
 * a CPU limit throttles; memory is incompressible, so exceeding a memory limit is an OOMKill. That
 * is why an absent memory limit is the more serious of the two, and why neither is rendered as a
 * reassuring `0`.
 */

/** What a cell prints for a usage sample, which is absent whenever metrics-server did not answer. */
export function usedText(
  value: number | null | undefined,
  format: (n: number | null | undefined) => string
): string {
  if (value === null || value === undefined) return '—';
  return format(value);
}

/**
 * What a cell prints for a declared limit.
 *
 * `'none'` rather than an em dash: a dash reads as "not reported", and this IS reported — the pod
 * declares no ceiling. The two states are different and an operator acts on them differently.
 */
export function limitText(value: number | null | undefined, format: (n: number | null | undefined) => string): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return 'none';
  return format(value);
}

/**
 * What a cell prints for a declared request.
 *
 * Same arithmetic as `limitText` and the same reason: `cpuRequest`/`memoryRequest` are sums over the
 * pod's containers, so a pod where nothing declares a request sums to 0. Rendering a bare `0` says
 * the pod asked for nothing measurable when it means the pod asked for nothing *at all* — which is
 * the definition of BestEffort, the first class the kubelet evicts. Found on a live cluster: the one
 * BestEffort pod rendered `1m / 0 / none`, where the `0` was the most load-bearing figure in the row
 * and the only one printed as a number.
 */
export function requestText(value: number | null | undefined, format: (n: number | null | undefined) => string): string {
  return limitText(value, format);
}

/** True when the pod declares no ceiling at all for this resource, so the cell should read as a risk. */
export function isUnbounded(limit: number | null | undefined): boolean {
  return limit === 0;
}

/**
 * The hover text behind a Used / Request / Limit cell, spelled out in words.
 *
 * The cell itself is three short values and two separators; this is the sentence that says which is
 * which, because `9m / 100m / none` does not say so on its own.
 */
export function metricTitle(
  resource: 'CPU' | 'Memory',
  used: string,
  request: string,
  limit: string
): string {
  const ceiling =
    limit === 'none'
      ? resource === 'Memory'
        ? 'no memory limit is declared, so the kubelet will not OOMKill this pod for exceeding one — it is evicted on node pressure instead'
        : 'no CPU limit is declared, so this pod is never throttled by a quota of its own'
      : `limit ${limit}`;
  return `${resource}: using ${used}, requests ${request}, ${ceiling}`;
}
