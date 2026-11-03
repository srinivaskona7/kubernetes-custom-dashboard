/**
 * The sample basis behind every rate, share and percentile taken from the access-log window.
 *
 * ## Why this exists
 *
 * The window is bounded twice — `maxPods` proxies, `tailLines` lines each — and bounded *unevenly*:
 * the collector sorts candidates ingress-gateway-first, then by restart count, and takes the first
 * `maxPods` (`srv/fleet/collectors/traffic.js` `selectProxies`). That ordering is the right one for
 * an incident and the wrong one for a mesh-wide share: when the cap bites, the sample is drawn from
 * the edge and the busiest-restarting pods, so a "mesh-wide p95" computed over it is edge-weighted.
 *
 * `windowLine` (in `../access-log.ts`) already states how many proxies and how many lines. What it
 * does not state is the *bias*, and the bias is only present when the cap actually bit: with 8
 * candidates and a cap of 10 the ordering decides nothing, and claiming a skew there would be its
 * own false statement. So `edgeWeighted` is `proxiesSkipped > 0`, never the ordering alone.
 *
 * ## The second way the sample is incomplete
 *
 * A proxy can also be selected, asked, and fail — a 403 on `pods/log` in a namespace the token
 * cannot read, a timeout, a pod that went away. Those never reach `proxiesRead` and are not in
 * `proxiesSkipped`, so a verdict built on the cap alone rendered them as a complete read: "every
 * proxy in scope was read … so the read order skews nothing", over a sample missing whole
 * namespaces. `proxiesFailed` is therefore part of the verdict and of the prose, and it is named
 * rather than counted, because an RBAC-shaped omission is the least random one there is.
 *
 * ## Why the timed count is not `httpRequests`
 *
 * `httpRequests` is incremented for every record carrying a `:method`, whether or not the line
 * carried a duration. The percentiles are computed only over durations, so the n behind them is
 * `samples` — summed across the service buckets, which partition the HTTP records exactly once
 * each. A tile labelled "HTTP requests timed" that printed `httpRequests` overstates the evidence
 * by however many lines had no duration field.
 *
 * JSX-free on purpose: `app/fleet-ui` runs vitest under `environment: 'node'`, so every rule that
 * can be stated as a string function is stated here and unit-tested, not asserted against a DOM.
 */

/** The subset of `TrafficWindow` this module reads. Structural, so both tabs' payloads fit. */
export interface SampleBasisWindow {
  proxiesRead: number;
  proxyCandidates: number;
  proxiesSkipped: number;
  tailLines: number;
  readsSkipped: boolean;
  /**
   * Proxies that were selected, asked, and did not answer — a 403 on `pods/log`, a timeout, a pod
   * that went away mid-read. Required, not optional: a window that cannot express a failed read is
   * a window that reports one as a complete one, which is the whole defect this field exists for.
   */
  proxiesFailed: readonly { pod: string; namespace: string; reason: string | null }[];
}

/** The n behind the percentiles: HTTP records that actually carried a duration. */
export function timedRequests(buckets: readonly { samples: number }[] | undefined): number {
  return (buckets ?? []).reduce((n, b) => n + b.samples, 0);
}

/** How many selected proxies were asked and did not answer. */
export function proxiesFailedCount(w: SampleBasisWindow | undefined): number {
  return w?.proxiesFailed?.length ?? 0;
}

/**
 * True when the read covered every candidate: the cap bit nothing and nothing refused.
 *
 * This — not `proxiesSkipped === 0` — is the only condition under which the affirmative "every proxy
 * was read" may be printed.
 */
export function isCompleteRead(w: SampleBasisWindow | undefined): boolean {
  if (!w || w.readsSkipped) return false;
  return w.proxiesSkipped === 0 && proxiesFailedCount(w) === 0;
}

/**
 * True when the per-request proxy cap bit, so the read is drawn from the front of a biased order.
 * False when every candidate was read — then the order chose nothing and there is no skew to claim.
 *
 * Failed reads are a different defect in the sample and are reported separately: the cap omits the
 * *back* of a known order, a refusal omits whichever proxies the token cannot read, and conflating
 * them would let either one be described by the other's sentence.
 */
export function isEdgeWeighted(w: SampleBasisWindow | undefined): boolean {
  if (!w || w.readsSkipped) return false;
  return w.proxiesSkipped > 0;
}

/** Up to three failed proxies named, the rest counted. Names, because "3 failed" is not actionable. */
function namedFailures(w: SampleBasisWindow): string {
  const failed = w.proxiesFailed ?? [];
  const shown = failed
    .slice(0, 3)
    .map(p => `${p.namespace}/${p.pod}${p.reason ? ` (${p.reason})` : ''}`)
    .join(', ');
  const rest = failed.length - Math.min(3, failed.length);
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

/**
 * The inline basis, short enough to sit in a section hint or a tile caption.
 *
 * `from 10 of 42 proxies, 300 lines each — edge-weighted`
 */
export function sampleBasis(w: SampleBasisWindow | undefined): string {
  if (!w) return '';
  if (w.readsSkipped) return `no sample — none of ${w.proxyCandidates} proxies were read`;
  const failed = proxiesFailedCount(w);
  if (w.proxiesRead === 0) {
    return failed > 0
      ? `no sample — all ${failed} proxies asked of ${w.proxyCandidates} failed to answer`
      : `no sample — 0 of ${w.proxyCandidates} proxies were read`;
  }
  const notes: string[] = [];
  if (isEdgeWeighted(w)) notes.push('edge-weighted');
  if (failed > 0) notes.push(`${failed} could not be read`);
  return (
    `from ${w.proxiesRead} of ${w.proxyCandidates} proxies, ${w.tailLines} lines each — ` +
    (notes.length > 0 ? notes.join(', ') : 'every proxy in scope was read')
  );
}

/**
 * The same fact spelled out: which end of the mesh the sample came from, and what that does to a
 * share. Printed beside mesh-wide figures rather than hidden in a tooltip.
 *
 * Never empty for a window that exists: on a complete read it says so affirmatively, on a capped or
 * partly-refused one it says what is missing. Silence would be read as "nothing to declare".
 */
export function selectionBiasLine(w: SampleBasisWindow | undefined): string {
  if (!w) return '';
  if (w.readsSkipped) return 'Nothing was tailed, so there is no sample and no selection to describe.';
  const failed = proxiesFailedCount(w);
  if (w.proxiesRead === 0) {
    return failed > 0
      ? `Every proxy that was asked failed to answer (${namedFailures(w)}), so there is no sample ` +
          'and no share below describes the mesh.'
      : 'No proxy was read, so there is no sample and no share below describes the mesh.';
  }
  const parts: string[] = [];
  if (isEdgeWeighted(w)) {
    parts.push(
      `Ingress gateways are read first, then the most-restarted pods; ${w.proxiesSkipped} of ` +
        `${w.proxyCandidates} proxies were over the per-request cap and never asked. So a mesh-wide ` +
        'percentile or share here is edge-weighted — it describes the proxies that were read, not the mesh.'
    );
  }
  if (failed > 0) {
    parts.push(
      `${failed} of ${w.proxyCandidates} proxies were asked and could not be read ` +
        `(${namedFailures(w)}), so their traffic is missing from every figure below. A refused read ` +
        'follows permissions and reachability, not chance, so what it omits is not a random sample.'
    );
  }
  if (parts.length === 0) {
    return `All ${w.proxyCandidates} proxies with an istio-proxy container were read, so the read order skews nothing.`;
  }
  return parts.join(' ');
}

/** The caption under a tile whose value is the timed count, naming the wider count beside it. */
export function timedCaption(timed: number, httpRequests: number): string {
  if (httpRequests === 0) return 'No HTTP record was read — TCP records excluded';
  if (timed === httpRequests) return `Every one of ${httpRequests.toLocaleString()} HTTP records carried a duration`;
  return `${timed.toLocaleString()} of ${httpRequests.toLocaleString()} HTTP records carried a duration`;
}
