/**
 * The pure half of the Traffic Errors summary: what a count is worth, and how a breakdown reads.
 *
 * Extracted for the same reason `ingress/shared.ts` exists — `app/fleet-ui`'s vitest runs in
 * `environment: 'node'`, so anything that has to be *proved* lives in a `.ts` file and the `.tsx`
 * files beside it hold only markup. What has to be proved here is the honesty of three claims:
 *
 *  1. **a zero is only a measurement when something was read.** `server: 0` on the reference cluster
 *     is a true zero; the identical `0` on a mesh that streams its access log to OTLP is "nobody
 *     looked". They must not render the same way, and nothing else on the page can tell them apart.
 *  2. **the breakdown shows the codes the window recorded, and no others.** A `404  0` row for a code
 *     that never appeared is indistinguishable from one that was looked for and not found.
 *  3. **the class beside a code is the collector's own.** Re-deriving "4xx" from the number would
 *     disagree with the failures table — which reads `class` — the first time a 3xx error appears.
 */
import type { AccessLogVerdict, TrafficData, TrafficErrorGroup } from '../../../api';
import type { MetricStatus } from '../../../components/unavailable';
import type { Tone } from '../../../components/ui';

type Summary = TrafficData['summary'];

// ------------------------------------------------------------------ is the count a measurement

/**
 * The status the four headline counts must carry: `ok` when something was read, `unavailable` when
 * nothing was.
 *
 * ## Why this is not `summary.unavailable`
 *
 * It would be the obvious source and it is the wrong one. `srv/fleet/collectors/traffic.js` fills
 * `summary.unavailable` from the ten **enrichment** reads — the Telemetry CR, the mesh ConfigMap,
 * Services, EndpointSlices, Nodes, Gateways, VirtualServices, APIRules, the HPA and the PDB. None of
 * them contributes a single digit to `server`, `client`, `noResponse` or `groups`, which come purely
 * from parsed access-log lines. Folding that list into these four cards would mark a correct 5xx
 * count "unavailable" because an HPA read was refused, which trains the operator to ignore the
 * marker on the one page where it means a dead credential.
 *
 * The read that *does* decide these four is the log tail, and its own verdict lives on
 * `window` (`readsSkipped`, `proxiesFailed`) — which this component is deliberately not given, so
 * that the same three states can be reached from the two fields it does have:
 *
 * `summary.requests` is `requests.length` in the collector and `window.requestsParsed` is the same
 * expression, so "did any line parse" is answerable from the summary alone. Combined with
 * `accessLog.readable`, that reproduces `accessLogEvidence`'s `readsSkipped` / `unprovenZero` split
 * exactly:
 *
 *   - `readable === false` — the log provably does not reach pod stdout (an OTLP or gRPC sink). Every
 *     count over that window is *not read*, whatever it says.
 *   - no line parsed and `readable !== true` — consistent with a quiet cluster and equally consistent
 *     with a log this reader cannot see. Not a measurement either.
 *   - no line parsed and `readable === true` — a genuinely quiet stdout-logging cluster has earned
 *     its zero.
 *
 * What is *not* covered, and must be said by the shell rather than here: `window.truncatedProxies`
 * and `window.proxiesSkipped`. A window read from 10 of 41 proxies is genuinely partial, and the
 * partial-visibility warning is the surface for it (§16 of the request) — `summary.truncated` is no
 * substitute, because it names paged *object* reads and says nothing about proxy coverage.
 */
export function logReadVerdict(
  summary: Summary | undefined,
  accessLog: AccessLogVerdict | undefined
): MetricStatus {
  const notRead = (why: string): MetricStatus => ({
    state: 'unavailable',
    what: 'requests',
    why,
    blind: 1,
    total: 1,
    truncated: false,
    truncatedWhy: ''
  });

  if (!summary) return notRead('no traffic payload was read for this cluster');

  if (accessLog?.readable === false) {
    // The sink is named. "Not read" with no reason reads as a broken page rather than as a
    // statement about where this mesh sends its logs.
    const sinks = accessLog.providerDetail.filter(p => p.readable === false && p.destination).map(p => p.name);
    return notRead(
      sinks.length
        ? `not read — ${sinks.join(' and ')} ${sinks.length === 1 ? 'streams' : 'stream'} the access log off the pod`
        : 'not read — nothing writes the access log to pod stdout'
    );
  }

  if (summary.requests === 0 && accessLog?.readable !== true) {
    return notRead('no request line came back, and the log destination could not be confirmed');
  }

  return { state: 'ok', what: 'requests', why: '', blind: 0, total: 1, truncated: false, truncatedWhy: '' };
}

// ------------------------------------------------------------------------------- the breakdown

export interface BreakdownRow {
  code: number;
  /** The collector's own class, verbatim: `client`, `server`, `no-response`, `ok`, `redirect`. */
  cls: string;
  count: number;
  /** What to print in the code slot. `none` for `response_code 0`, matching the failures table. */
  label: string;
  /** The word that carries the meaning without colour — §26's "never rely only on colour". */
  word: string;
  /** The `.dist-bar-*` modifier from theme.css. No new colour; four hues, one meaning each. */
  barClass: string;
  /** Share of every record read in the window, or `null` when nothing was read. */
  share: number | null;
  /** Present in `byCode` and counted zero. Kept, and drawn subtle rather than dropped. */
  zero: boolean;
  /** Whether clicking the row can narrow the failures table — see {@link breakdownRows}. */
  filterable: boolean;
}

/** The classes the failures table actually contains, so a click on one of them lands on rows. */
const ERROR_CLASSES = new Set(['client', 'server', 'no-response']);

const WORD: Record<string, string> = {
  client: 'client error',
  server: 'server error',
  'no-response': 'no response',
  ok: 'success',
  redirect: 'redirect'
};

const BAR: Record<string, string> = {
  client: 'dist-bar-client',
  server: 'dist-bar-server',
  // Neutral, not red: a connection Envoy never answered is not a 5xx, and the largest number on the
  // reference cluster is this one. Painting 1808 records red would make a working mesh look on fire.
  'no-response': 'dist-bar-none',
  ok: 'dist-bar-ok',
  redirect: 'dist-bar-ok'
};

/**
 * `byCode`, split into the errors and the context, each highest-count-first.
 *
 * ## Two deliberate departures from the request's example
 *
 * **No synthesised zero rows.** The example listed `401 0` and `404 0`. Only the codes present in
 * `byCode` are rendered: a printed `404  0` cannot distinguish "we looked and there were none" from
 * "404 was never in this window", and inventing the row makes the first reading look authoritative.
 * A code that *is* present with a zero keeps its row and is drawn subtle (`zero`), because there the
 * zero is a real observation.
 *
 * **`200` is shown, below the errors and not counted as one.** The section is titled "Error
 * breakdown", and the successes are still the most useful thing on it: they are the denominator that
 * decides whether 472 × 403 is a catastrophe or the background noise of a cluster turning away
 * unauthenticated callers. They sit in their own band, they are not filterable, and their word says
 * `success` — so they cannot be mistaken for part of the error total.
 *
 * A class this build does not recognise is kept, out of the error band, with its raw word. Guessing
 * would be the one thing worse than admitting the vocabulary moved on.
 */
export function breakdownRows(byCode: Summary['byCode'] | undefined): {
  errors: BreakdownRow[];
  context: BreakdownRow[];
  total: number;
} {
  const rows = byCode ?? [];
  const total = rows.reduce((n, r) => n + r.count, 0);

  const build = (r: { code: number; class: string; count: number }): BreakdownRow => ({
    code: r.code,
    cls: r.class,
    count: r.count,
    // `none`, not `0`: a bare zero in a column of response codes reads as a code, and the failures
    // table already prints `none` for the same records.
    label: r.code === 0 ? 'none' : String(r.code),
    word: WORD[r.class] ?? r.class,
    barClass: BAR[r.class] ?? 'dist-bar-none',
    share: total > 0 ? r.count / total : null,
    zero: r.count === 0,
    filterable: ERROR_CLASSES.has(r.class)
  });

  // The collector already sorts `byCode` descending. Sorted again here so the component does not
  // depend on that, and on a copy so the payload the shell holds is never reordered under it. The
  // code is the tie-break, or two equal counts swap places between renders.
  const ordered = [...rows].sort((a, b) => b.count - a.count || a.code - b.code).map(build);

  return {
    errors: ordered.filter(r => ERROR_CLASSES.has(r.cls)),
    context: ordered.filter(r => !ERROR_CLASSES.has(r.cls)),
    total
  };
}

// ---------------------------------------------------------------------------- the top patterns

/**
 * The most frequent groups, highest first.
 *
 * On a copy: the array belongs to the shell's filter state, and sorting it in place would reorder
 * the failures table as a side effect of rendering a summary above it.
 */
export function topPatterns(groups: readonly TrafficErrorGroup[], limit: number): TrafficErrorGroup[] {
  return [...groups].sort((a, b) => b.count - a.count).slice(0, limit);
}

// ------------------------------------------------------------------------- the access-log strip

export interface AccessLogView {
  tone: Tone;
  /** The pill's word. Never "Enabled" on its own when the log does not reach this tab. */
  word: string;
  /** The collector's own sentence. Not paraphrased — it states which object decided the verdict. */
  why: string;
}

/**
 * How the access-logging state should read.
 *
 * `state: 'on'` is not the whole truth and must not be printed as though it were. On the reference
 * cluster the Telemetry CR is on and the resolved provider writes to `/dev/stdout`, so the tab can
 * read it; a mesh whose provider is `envoyOtelAls` is equally "on" and this page sees nothing from
 * it. Green for the second case is the worst pill on the tab, because the operator then reads the
 * empty table below as "no failures".
 *
 * So the verdict is state **and** readability, and `readable: null` — a provider name the mesh
 * ConfigMap does not declare — stays out of both green and red, which is what "unconfirmed" means.
 */
export function accessLogView(accessLog: AccessLogVerdict | undefined): AccessLogView {
  if (!accessLog) {
    return { tone: 'unknown', word: 'Unknown', why: 'No access-log verdict was read for this cluster.' };
  }
  const why = accessLog.why;
  if (accessLog.state === 'off') return { tone: 'warn', word: 'Disabled', why };
  if (accessLog.state !== 'on') return { tone: 'unknown', word: 'Unknown', why };
  if (accessLog.readable === true) return { tone: 'ok', word: 'Enabled', why };
  if (accessLog.readable === false) {
    return {
      tone: 'warn',
      // Two different facts, and the advice differs: a network sink really is recording the
      // requests and "open the destination" is good advice, while a provider declared for tracing
      // records nothing anywhere and there is no destination to open.
      word: accessLog.recordedElsewhere ? 'Enabled, recorded elsewhere' : 'Enabled, nothing recorded',
      why
    };
  }
  return { tone: 'unknown', word: 'Enabled, unconfirmed', why };
}
