/**
 * The model behind **Distributed Traces**: the outcome filter, its counts, and the sentences that
 * say what the numbers cover.
 *
 * The collector (`srv/fleet/collectors/traces.js`) keeps `MAX_TRACES` journeys, app first, and counts
 * `multiHop`, `errorTraces` and `slowTraces` over those kept, not over `tracesFound`. A tile reading
 * "66 with an error" beside "200 of 1509" invites the reader to take 66 as a share of 1509, so every
 * caption here names its denominator when the cap bit.
 *
 * Pure `.ts`: the fleet-ui vitest suite runs in the node environment with no DOM.
 */

import type { Trace } from '../../api';
import { ago } from '../../format';

/** Milliseconds, as a latency reads. `format.duration` is a token countdown and starts at minutes. */
export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}s`;
}

export type TraceOutcome = 'all' | 'app' | 'egress' | 'refused' | 'app-errors' | 'slow' | 'multi';

export const TRACE_OUTCOMES: readonly TraceOutcome[] = ['all', 'app', 'egress', 'refused', 'app-errors', 'slow', 'multi'];

const CLASS_OUTCOMES: ReadonlySet<TraceOutcome> = new Set(['app', 'egress', 'refused', 'app-errors']);

/** A class chip on a server that sends no `classCounts`: it has no answer, which is not zero. */
export function outcomeUnclassified(outcome: TraceOutcome, summary: { classCounts?: object } | undefined): boolean {
  return CLASS_OUTCOMES.has(outcome) && summary?.classCounts === undefined;
}

/**
 * Class chips read the server's request class (`classifyJourney` in request-class.js). A server
 * older than that field sends no `class`; `outcomeUnclassified` disables those chips.
 */
export function matchesOutcome(t: Trace, outcome: TraceOutcome, slowMs: number): boolean {
  switch (outcome) {
    case 'all':
      return true;
    case 'app':
      return t.class === 'app';
    case 'egress':
      return t.class === 'egress-declared';
    case 'refused':
      return t.class === 'security-refused';
    case 'app-errors':
      return t.appError === true;
    case 'slow':
      return t.totalDurationMs !== null && t.totalDurationMs >= slowMs;
    case 'multi':
      return t.hopCount > 1;
  }
}

/** Case-insensitive substring over the ids, the request line, the host and the Envoy flags. */
export function matchesTraceSearch(t: Trace, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [t.traceId, t.requestId, t.path, t.authority, t.method, ...t.flags]
    .filter(Boolean)
    .some(v => String(v).toLowerCase().includes(q));
}

export function filterTraces(traces: readonly Trace[], outcome: TraceOutcome, search: string, slowMs: number): Trace[] {
  return traces.filter(t => matchesOutcome(t, outcome, slowMs) && matchesTraceSearch(t, search));
}

/** A completed request: green at the edge and no failed hop among the evidence that was read. */
export function isSuccessfulTrace(t: Trace): boolean {
  return t.finalStatusClass === 'ok' && t.worstStatus === null && t.hops.length > 0 && t.hops.every(h => h.codeClass === 'ok');
}

/** The server's floor for a 95th percentile (`MIN_P95_SAMPLES` in edge.js and service-map.js): fewer durations are not a distribution. */
const MIN_P95_SAMPLES = 20;

/** The nearest-rank p95 of the durations the rows carry, null below the floor, and how many durations that rests on. */
export function p95Of(traces: readonly Trace[]): { p95: number | null; samples: number } {
  const values = traces.map(t => t.totalDurationMs).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  return { p95: values.length >= MIN_P95_SAMPLES ? values[Math.ceil(values.length * 0.95) - 1] ?? null : null, samples: values.length };
}

/** Rows per outcome chip, over the rows the search leaves — so a chip's number is what pressing it shows. */
export function outcomeCounts(traces: readonly Trace[], search: string, slowMs: number): Record<TraceOutcome, number> {
  const c: Record<TraceOutcome, number> = { all: 0, app: 0, egress: 0, refused: 0, 'app-errors': 0, slow: 0, multi: 0 };
  for (const t of traces) {
    if (!matchesTraceSearch(t, search)) continue;
    for (const o of TRACE_OUTCOMES) if (matchesOutcome(t, o, slowMs)) c[o] += 1;
  }
  return c;
}

/**
 * Whether the collector's cap dropped journeys. When it did, the tiles count the kept ones (app and
 * egress first, then the newest noise)
 * and the table holds only those.
 */
export function capped(summary: { traces: number; tracesFound: number } | undefined): boolean {
  return !!summary && summary.tracesFound > summary.traces;
}

/** A tile caption's denominator: "of the 200 kept" when capped, the plain sentence otherwise. */
export function ofShown(summary: { traces: number; tracesFound: number } | undefined, plain: string): string {
  return capped(summary) ? `${plain}, of the ${summary!.traces} kept` : plain;
}

/**
 * Journeys opens on App journeys when there are any to show; an older server has no classes, and
 * the App chip is disabled there, so it stays on All rather than selecting a chip no one can use.
 */
export function initialOutcome(summary: { classCounts?: Partial<Record<string, number>> } | undefined): TraceOutcome {
  return (summary?.classCounts?.app ?? 0) > 0 ? 'app' : 'all';
}

/** The cap keeps work ahead of noise (traces.js capJourneys), so the caption says so. */
export function keptCaption(summary: { traces: number; tracesFound: number } | undefined): string | null {
  return summary && capped(summary) ? `${summary.traces} kept of ${summary.tracesFound.toLocaleString('en-US')}: app first` : null;
}

/**
 * When the cap bit, the journeys shown cover a different time than the lines read — 200 of 1,509
 * can span four minutes of a five-hour window, or reach back to an old app journey. Stated beside the window line so the
 * table's time range is never read off the window's.
 */
export function shownSpanLine(summary: { traces: number; tracesFound: number } | undefined, traces: readonly Trace[]): string | null {
  if (!capped(summary)) return null;
  const stamps = traces
    .map(t => t.startTime)
    .filter((s): s is string => !!s)
    .sort();
  const span = stamps.length ? `, started ${ago(stamps[0])} to ${ago(stamps[stamps.length - 1])}` : '';
  return `Showing ${summary!.traces.toLocaleString('en-US')} of ${summary!.tracesFound.toLocaleString('en-US')} journeys, app first${span}`;
}

/**
 * The detail panel's "Worst hop". The collector publishes `worstStatus: null` when no hop failed, and
 * an em dash there reads as "not read". Only a journey whose every hop answered 2xx/3xx is called
 * clean; anything else with no worst status is genuinely unknown.
 */
export function worstHopText(t: Pick<Trace, 'worstStatus' | 'errorHop' | 'hops'>): string {
  if (t.worstStatus !== null) {
    // Envoy's response_code 0 is "no HTTP response", the word the status pills already use.
    const code = t.worstStatus === 0 ? 'no response' : String(t.worstStatus);
    return t.errorHop ? `${code} at hop ${t.errorHop}` : code;
  }
  if (t.hops.length > 0 && t.hops.every(h => h.codeClass === 'ok')) return 'none — every hop answered 2xx/3xx';
  return '—';
}

type FilteredSummary = {
  pollsHidden?: number;
  pollsHiddenBy?: readonly { kind: string; count: number }[];
  outsideNamespace?: number;
};

/**
 * What the server left out before the cap, as one sentence, or null when it left nothing out.
 * Without it, "200 of 414" beside a window of 1,160 journeys has no explanation on screen.
 */
export function hiddenLine(summary: FilteredSummary | undefined, namespaces: readonly string[]): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  const polls = summary.pollsHidden ?? 0;
  if (polls > 0) {
    const by = (summary.pollsHiddenBy ?? []).map(p => `${p.kind} ${p.count.toLocaleString('en-US')}`).join(', ');
    parts.push(`${polls.toLocaleString('en-US')} successful liveness poll${polls === 1 ? '' : 's'} hidden${by ? ` (${by})` : ''}`);
  }
  const outside = summary.outsideNamespace ?? 0;
  if (outside > 0 && namespaces.length > 0) {
    parts.push(`${outside.toLocaleString('en-US')} journey${outside === 1 ? '' : 's'} never touched ${namespaces.join(', ')}`);
  }
  return parts.length ? parts.join('; ') : null;
}
