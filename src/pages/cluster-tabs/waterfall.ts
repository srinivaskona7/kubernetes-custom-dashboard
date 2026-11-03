/**
 * Traces → the journey waterfall: where the time went, from the timings the server already sent.
 *
 * Nothing here re-derives a timing from a log line. It only arranges `offsetMs`, `durationMs`,
 * `upstreamMs`, `proxyOverheadMs` and `transitMs`, and decides when their arithmetic is sound
 * enough to publish.
 */
import type { Trace, TraceHop, TraceOutboundItem } from '../../api';
import { ms } from './traces-view';

/**
 * Where one journey's time went, when the hops nest.
 *
 * For hops ordered caller → callee, the edge hop's duration is the transit into each next hop plus
 * the innermost hop's duration, and the innermost hop is its own proxy plus the workload it
 * forwarded to:
 *
 *   D₁ = Σ transit(i < n) + proxy(n) + upstream(n)
 *
 * so the three parts add up to the total exactly. When they cannot be computed — hops that do not
 * nest, a missing `x-envoy-upstream-service-time` — the answer is null with the reason, never a
 * partial sum that reads as a whole.
 */
export interface JourneyBreakdown {
  totalMs: number;
  /** The innermost workload's own time: its `x-envoy-upstream-service-time`. */
  appMs: number;
  /** The innermost proxy's own work and connection. */
  proxyMs: number;
  /** Network and proxies between the hops. 0 on a one-hop journey. */
  betweenMs: number;
  /** The hops were ordered by duration, not by span id: the split is an estimate. */
  derived: boolean;
}

export function journeyBreakdown(t: Pick<Trace, 'hops' | 'nestingAnomaly' | 'correlatedBy'>): { value: JourneyBreakdown | null; reason: string | null } {
  const hops = t.hops;
  if (!hops.length) return { value: null, reason: 'No hop was read.' };
  if (t.nestingAnomaly) return { value: null, reason: 'The hops do not nest, so their times cannot be split without double-counting.' };
  const first = hops[0]!;
  const last = hops[hops.length - 1]!;
  if (first.durationMs === null) return { value: null, reason: 'The edge hop recorded no duration.' };
  if (last.upstreamMs === null || last.proxyOverheadMs === null) {
    return { value: null, reason: 'The innermost hop logged no upstream service time, so the workload’s own time is not known.' };
  }
  const transits = hops.slice(0, -1).map(h => h.transitMs);
  if (transits.some(v => v === null)) return { value: null, reason: 'A hop between the edge and the innermost one has no transit time.' };
  const betweenMs = (transits as number[]).reduce((n, v) => n + v, 0);
  return {
    value: { totalMs: first.durationMs, appMs: last.upstreamMs, proxyMs: last.proxyOverheadMs, betweenMs, derived: t.correlatedBy === 'request-id' && hops.length > 1 },
    reason: null
  };
}

export interface BarGeometry {
  /** Percent of the journey's span. */
  left: number;
  width: number;
  /** The bar runs past the journey's end (a pooled connection outliving the request). */
  clipped: boolean;
  /** The interval starts before the journey's zero (clock skew between nodes); the bar is cut at 0. */
  early: boolean;
}

/** Position one interval on a 0–`total` axis. Null when it has no start or no length to draw. */
export function barOf(offsetMs: number | null, durationMs: number | null, total: number): BarGeometry | null {
  if (!(total > 0) || offsetMs === null || durationMs === null) return null;
  const start = (offsetMs / total) * 100;
  const left = Math.min(Math.max(start, 0), 99);
  // The part before 0 is cut, not shifted: the bar still ends where the interval ends.
  const raw = (durationMs / total) * 100 + Math.min(start, 0);
  const width = Math.max(Math.min(raw, 100 - left), 0.8);
  return { left, width, clipped: left + raw > 100.5, early: start < 0 };
}

/** The upstream's share of a hop's bar, as a percent of that bar. Null when not logged. */
export function upstreamShare(h: Pick<TraceHop, 'durationMs' | 'upstreamMs'>): number | null {
  if (h.durationMs === null || h.upstreamMs === null || h.durationMs <= 0) return null;
  return Math.min(Math.max((h.upstreamMs / h.durationMs) * 100, 0), 100);
}

/** Axis ticks at the start, the middle and the end of the span, as `[percent, ms]`: the panel is narrow. */
export function ticksOf(total: number): Array<[number, number]> {
  if (!(total > 0)) return [];
  return [0, 50, 100].map(p => [p, (total * p) / 100]);
}

/** "inferred · 3 in flight": how sure the link from an outbound connection to this journey is. */
export function linkNote(o: Pick<TraceOutboundItem, 'candidates'>): string {
  return o.candidates > 1 ? `inferred · ${o.candidates} in flight` : 'inferred';
}

/** A hop's bar tone. Violet is the brand and never a status, so the ingress hop uses the ok tone. */
export function hopFill(h: Pick<TraceHop, 'codeClass'>): { solid: string; outline: string } {
  const failed = h.codeClass === 'server' || h.codeClass === 'client' || h.codeClass === 'no-response';
  return failed ? { solid: 'bg-bad', outline: 'border-bad bg-bad/20' } : { solid: 'bg-ok', outline: 'border-ok bg-ok/20' };
}

/**
 * The part of a caller's time its callee did not account for, drawn at the end of the caller's
 * bar: network and proxies. Null when `transitMs` is null (the last hop, or hops that do not nest).
 */
export function transitBar(
  h: Pick<TraceHop, 'offsetMs' | 'durationMs' | 'transitMs'>,
  total: number
): { left: number; width: number; label: string } | null {
  if (h.transitMs === null || h.offsetMs === null || h.durationMs === null || !(total > 0)) return null;
  const end = Math.min(((h.offsetMs + h.durationMs) / total) * 100, 100);
  const width = Math.max((h.transitMs / total) * 100, 0.8);
  return { left: Math.max(end - width, 0), width, label: `transit ${ms(h.transitMs)}` };
}
