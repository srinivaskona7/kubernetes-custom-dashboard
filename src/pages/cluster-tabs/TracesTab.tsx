/**
 * Distributed Traces — one request's journey across the mesh, rebuilt from access-log lines.
 *
 * ## What a trace on this screen is, and what it is not
 *
 * It is a **correlation**, not a span tree. There is no tracing backend behind this tab: the hops
 * are Envoy access-log lines, tailed from a bounded set of `istio-proxy` containers and grouped by
 * whichever correlation header the window actually carried. That produces three honesty
 * obligations the rest of the console has taught this codebase to take literally:
 *
 *   1. **A hop count is what this read observed.** Never the request's real topology. A proxy that
 *      was not tailed contributes no hop, so a one-hop trace can be a five-hop request seen once.
 *      The window — proxies read, proxies skipped, lines read — is printed in place.
 *   2. **`traceparent` absent is a configuration finding, not an empty result.** Kyma's stock
 *      `stdout-json` access-log format does not name the header at all, and Envoy only fills it
 *      when tracing is enabled on the Istio module. When it is missing the collector falls back to
 *      `x-request-id`, which Envoy always propagates — and then hop nesting is *inferred from
 *      duration* rather than read from span ids. A "Hop order inferred" badge beside the sub-tabs
 *      says so, with the reason behind its tip, because an inferred parent is a weaker claim than a
 *      measured one.
 *   3. **A derived time is labelled as derived.** Transit time is one hop's duration minus its
 *      callee's; when that subtraction goes negative (two clocks, or two requests sharing an id)
 *      the collector publishes `null` and sets `nestingAnomaly`, and this screen prints neither a
 *      zero nor a negative bar.
 *
 * The status an operator cares about is the **edge** one — what the client actually received — so
 * `finalStatus` comes from the ingress hop wherever one was read, not from the first line in time
 * order. `worstStatus` is the other fact, and they are shown as two facts: a 200 at the edge over a
 * 503 three hops in is a retry that worked, and collapsing them would hide the incident.
 *
 * Read-only throughout: this tab reads pod logs and lists objects, and offers no control that
 * changes anything in the cluster.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, DEFAULT_TRACES_TAIL, type Trace, type TraceEndpoint, type TraceHop, type TracesData, type TrafficData } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { DiagnosisDrawer } from '../../components/DiagnosisDrawer';
import { diagnose } from '../../diagnosis';
import { DetailPanel, Field, Section } from '../../components/layout';
import { ResourceLink } from '../../components/ResourceLink';
import { Dot, Empty, ErrorBanner, ErrorState, InfoTip, Pill, Skeleton, TONE_TEXT, type Tone } from '../../components/ui';
import { UnavailableNotice, envelopeScope } from '../../components/unavailable';
import { useAsync } from '../../useAsync';
import { StaleReadNotice } from '../../components/StaleReadNotice';
import { ago } from '../../format';
import { accessLogEvidence } from './access-log';
import { barOf, hopFill, journeyBreakdown, linkNote, ticksOf, transitBar, upstreamShare } from './waterfall';
import { byteText } from './outbound-view';
import { FilterBar, FilterSelect, SearchBox } from '../../components/filters';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { NamespaceFilter } from '../../components/NamespaceFilter';
import { serializeNamespaceParam, useNamespaceSelection } from '../../components/use-namespace-selection';
import { SubTabs, useSection } from '../../components/SubTabs';
import { TAB_SECTIONS } from './tabs';
import { EndpointTiles, TracesEndpoints } from './TracesEndpoints';
import type { EndpointDrill } from './service-map-layout';
import { MapTiles, TracesServiceMap } from './TracesServiceMap';
import type { ServiceMapOutcome } from './service-map-drill';
import { OutboundTiles, TracesOutbound } from './TracesOutbound';
import { destinationLabel, destinationProvenance } from './destination-label';
import { endpointBlock, filteredEmptyLine, policyRead } from './egress-view';
import { edgeProblems, endpointProblems, outboundProblems, type Problem, type TracesTarget } from './problems';
import { ProblemStrip } from './ProblemStrip';
import { ProxiesChip, TracesProxiesRead, useProxiesPanel } from './traffic/ProxiesRead';
import { JourneyPath } from './JourneyPath';
import { failureRoot } from './journey-status';
import { TracesRefused } from './TracesRefused';
import { SuccessfulRequests } from './SuccessfulRequests';
import { TIME_RANGES, rangeNote, readStamp, sinceOf } from './time-range';
import { useSearchParams } from 'react-router-dom';
import {
  filterTraces,
  hiddenLine,
  initialOutcome,
  isSuccessfulTrace,
  keptCaption,
  ms,
  outcomeCounts,
  outcomeUnclassified,
  shownSpanLine,
  TRACE_OUTCOMES,
  worstHopText,
  type TraceOutcome
} from './traces-view';

/**
 * How wide a tail to ask each proxy for. `DEFAULT_TAIL_LINES` in `srv/fleet/collectors/traces.js`
 * is 500 and the server clamps to 1000 whatever arrives; a wider tail is a larger read from every
 * proxy, which is why it is a control rather than a default.
 */
const TAIL_CHOICES = [200, 500, 1000];
/** From api.ts, so the prefetch warms the URL this tab reads. */
const DEFAULT_TAIL = DEFAULT_TRACES_TAIL;

const SECTIONS = TAB_SECTIONS.traces;
/**
 * Endpoints, Service map and Outbound scroll their whole body below the tiles; their FilterBar
 * sticks to the top of that scroller so the read controls stay in reach while the table scrolls.
 */
const PINNED_FILTERS = 'sticky top-0 z-10 bg-bg';
type SectionId = (typeof SECTIONS)[number]['id'];


const STATUS_TONE: Record<NonNullable<Trace['finalStatusClass']>, Tone> = {
  ok: 'ok',
  client: 'warn',
  server: 'bad',
  'no-response': 'unknown'
};

const STATUS_WHY: Record<NonNullable<Trace['finalStatusClass']>, string> = {
  ok: 'The edge answered 2xx or 3xx. Hops further in may still have failed — see the worst status in the panel.',
  client: '4xx at the edge. Often the caller, but a 403 from an AuthorizationPolicy is cluster configuration.',
  server: '5xx at the edge — the client saw the failure. The failing hop is highlighted in the waterfall.',
  'no-response':
    'Envoy recorded response_code 0: the connection produced no HTTP response at all. Not an HTTP error.'
};

/**
 * The hop-order badge's tip: why these journeys carry no read parent/child order, and the line
 * counts behind that verdict. It was a banner on every sub-tab; the badge says it once.
 */
function correlationTip(corr: TracesData['correlation']): string {
  const parts: string[] = [];
  if (corr.traceparentAbsent) {
    parts.push(
      "No access-log line in this window carried a traceparent. Kyma's stock stdout-json format does not emit it, and Envoy only fills it when tracing is enabled on the Istio module, so its absence describes the mesh's configuration, not the traffic. Correlation fell back to x-request-id, which Envoy propagates regardless."
    );
  }
  if (corr.nestingInferred) {
    parts.push(
      'Without span ids, a caller and its callee are ordered by start time and duration. That is right for ordinary nested calls and wrong for two unrelated requests that happen to share an id. Journeys where it did not hold are marked, and they publish no transit time at all.'
    );
  }
  parts.push(
    `Lines: ${corr.traceparentLines} traceparent, ${corr.b3Lines} b3, ${corr.requestIdLines} request-id, ${corr.uncorrelatedLines} uncorrelated.`
  );
  return parts.join(' ');
}

function endpointTone(kind: string): Tone {
  if (kind === 'unresolved') return 'unknown';
  // Neutral, like unresolved: violet is the brand, never a category. The label says which it is.
  if (kind === 'external') return 'unknown';
  return 'ok';
}

/**
 * One end of a hop, with the field that proves it on hover.
 *
 * `null` is its own sentence rather than an em-dash on the `to` side: a hop with no upstream never
 * reached one, which is the single most useful thing a `NR` or a local 403 can tell an operator.
 */
function Endpoint({ ep, unreached = false }: { ep: TraceEndpoint | null; unreached?: boolean }) {
  if (!ep) {
    return (
      <span
        className="text-muted/70"
        title={
          unreached
            ? 'Envoy recorded no upstream for this hop — the request never reached one. A local rejection, or no route matched.'
            : 'Envoy recorded no address for this side of the request.'
        }
      >
        {unreached ? 'never reached an upstream' : '—'}
      </span>
    );
  }
  const label = ep.kind === 'external' || ep.kind === 'unresolved' ? (ep.ip ?? ep.fqdn ?? ep.name ?? 'unknown') : ep.name;
  const title = `${ep.ip ?? ep.fqdn ?? 'no address'}${ep.port ? `:${ep.port}` : ''} — ${ep.evidence}`;
  if (ep.kind === 'Pod' && ep.namespace) {
    return (
      <span title={title} className="inline-flex min-w-0 items-center gap-1.5">
        <Dot tone="ok" />
        <ResourceLink refTo={{ kind: 'Pod', namespace: ep.namespace, name: ep.name }} />
      </span>
    );
  }
  return (
    <span title={title} className="mono inline-flex min-w-0 items-center gap-1.5 text-[12px]">
      <Dot tone={endpointTone(ep.kind)} />
      <span className="truncate">{label}</span>
      {ep.kind === 'unresolved' && <span className="text-[11px] text-muted/70">unresolved</span>}
    </span>
  );
}

/** The few facts needed to decide where to investigate before opening the hop-level evidence. */
function RequestSummary({ trace }: { trace: Trace }) {
  const clientResult = trace.finalStatus === null ? 'No edge result read' : trace.finalStatus === 0 ? 'No HTTP response' : String(trace.finalStatus);
  const worst = trace.worstStatus === null ? 'No failed hop read' : worstHopText(trace);
  const certainty = trace.correlatedBy === 'traceparent' || trace.correlatedBy === 'b3'
    ? 'span correlation'
    : 'request-id order inferred';
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-[6px] border border-line bg-panel/40 px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">Client result</p>
        <p className={`mono mt-0.5 text-[13px] ${trace.finalStatusClass ? TONE_TEXT[STATUS_TONE[trace.finalStatusClass]] : 'text-muted'}`}>{clientResult}</p>
      </div>
      <div className="rounded-[6px] border border-line bg-panel/40 px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">Worst observed</p>
        <p className={`mono mt-0.5 truncate text-[13px] ${trace.worstStatus === null ? 'text-muted' : 'text-text'}`} title={worst}>{worst}</p>
      </div>
      <div className="rounded-[6px] border border-line bg-panel/40 px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">Edge duration</p>
        <p className="mono mt-0.5 text-[13px]">{ms(trace.totalDurationMs)}</p>
      </div>
      <div className="rounded-[6px] border border-line bg-panel/40 px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">Evidence</p>
        <p className="mt-0.5 truncate text-[13px]" title={`${trace.hopCount} observed hop(s) · ${certainty}`}>{trace.hopCount} hops · {certainty}</p>
      </div>
    </div>
  );
}

/**
 * The waterfall.
 *
 * Bars are positioned from `offsetMs` and sized from `durationMs`, both of which the server
 * computed from the log lines — the browser scales, it never re-derives a timing (`waterfall.ts`).
 * Each hop's bar is split: the solid part is the upstream's own time
 * (`x-envoy-upstream-service-time`), the pale part the proxy and its connection. The split shows a
 * share, not a timeline — Envoy does not log where inside the hop the upstream's time fell.
 *
 * Below the hops, outbound connections the journey's pods opened while it ran (a database, an
 * IdP) are drawn dashed and labelled inferred: no header ties them to the request, only time. One
 * that outlived the journey — a pooled connection — is clipped at the edge with its real length.
 *
 * Two cases the geometry survives: a total of 0 or null (no bars, and a line saying so, rather than
 * a full-width bar that reads as "this took the whole window"), and a hop with no duration inside a
 * trace that has one (an outline, not a zero-width sliver).
 */
function Waterfall({ trace }: { trace: Trace }) {
  const total = trace.totalDurationMs;
  if (!total || total <= 0) {
    return (
      <p className="text-[13px] text-muted">
        No duration was recorded for this trace, so there is no waterfall to draw. Envoy writes
        <span className="mono"> duration</span> on a completed request; a connection it never answered has none.
      </p>
    );
  }
  const outbound = trace.outbound ?? [];
  const split = journeyBreakdown(trace);
  const label = 'mono w-[132px] shrink-0 truncate text-[11px] text-muted';
  return (
    <div className="space-y-1.5">
      <div className="flex items-end gap-2" aria-hidden="true">
        <span className="w-[132px] shrink-0" />
        <div className="relative h-4 flex-1 border-b border-line">
          {ticksOf(total).map(([p, v]) => (
            <span
              key={p}
              className="mono absolute bottom-0.5 text-[10px] text-muted/80"
              style={p === 100 ? { right: 0 } : p === 0 ? { left: 0 } : { left: `${p}%`, transform: 'translateX(-50%)' }}
            >
              {ms(v)}
            </span>
          ))}
        </div>
        <span className="w-[62px] shrink-0" />
      </div>
      {trace.hops.map(h => {
        const bar = barOf(h.offsetMs, h.durationMs, total);
        const share = upstreamShare(h);
        const tone = hopFill(h);
        const transit = transitBar(h, total);
        return (
          <div key={h.seq} className="flex items-center gap-2">
            <span className={label} title={`${h.observedBy.namespace}/${h.observedBy.pod}`}>
              {h.seq}. {h.observedBy.pod}
            </span>
            <div className="relative h-[10px] flex-1 rounded-[3px] bg-line/40">
              {bar === null ? (
                h.offsetMs === null ? (
                  <span className="absolute inset-0 flex items-center pl-1 text-[10px] text-muted" title="This hop recorded no start stamp, so it has no place on the axis.">
                    no start stamp
                  </span>
                ) : (
                  <div
                    className="absolute inset-y-0 rounded-[3px] border border-dashed border-muted/50"
                    style={{ left: `${Math.min((h.offsetMs / total) * 100, 94)}%`, width: '6%' }}
                    title="This hop recorded no duration; its position is from its start stamp only."
                  />
                )
              ) : share === null ? (
                // No upstream service time: the split is unknown, so the bar is outlined, never solid.
                <div
                  className={`absolute inset-y-0 rounded-[3px] border ${tone.outline}`}
                  style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  title={`${ms(h.durationMs)} starting ${ms(h.offsetMs)} into the trace · no upstream service time logged, so the split is not known`}
                />
              ) : (
                <div
                  className={`absolute inset-y-0 flex overflow-hidden rounded-[3px] ${tone.solid}`}
                  style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  title={`${ms(h.durationMs)} starting ${ms(h.offsetMs)} into the trace · upstream ${ms(h.upstreamMs)}, proxy and connection ${ms(h.proxyOverheadMs)}`}
                >
                  <span className="h-full bg-surface/55" style={{ width: `${100 - share}%` }} />
                </div>
              )}
              {transit && (
                <span
                  className="absolute -bottom-[3px] h-[2px] rounded-full bg-warn/70"
                  style={{ left: `${transit.left}%`, width: `${transit.width}%` }}
                  title={`${transit.label}: this hop's time its callee did not account for, the network and the proxies between them`}
                />
              )}
            </div>
            <span className="mono w-[62px] shrink-0 text-right text-[11px] text-muted">{ms(h.durationMs)}</span>
          </div>
        );
      })}
      {outbound.map((o, i) => {
        const bar = barOf(o.offsetMs, o.durationMs, total);
        return (
          <div key={`o${i}`} className="flex items-center gap-2">
            <span className={label} title={`${o.pod} opened a connection to ${o.to.destination ? `${o.to.destination.display} (${o.to.name})` : o.to.name} ${ms(o.offsetMs)} into the journey. ${linkNote(o)}: no header ties it to this request, only time.${o.to.destination ? ` Named ${destinationProvenance(o.to.destination)}.` : ''}`}>
              ↳ {destinationLabel(o.to).primary}
            </span>
            <div className="relative h-[10px] flex-1 rounded-[3px] bg-line/20">
              {bar && (
                <div
                  className={`absolute inset-y-0 rounded-[3px] border border-dashed ${bar.clipped ? 'rounded-r-none border-r-0' : ''} ${bar.early ? 'rounded-l-none border-l-0' : ''} ${o.failed ? 'border-bad bg-bad/15' : 'border-muted/70 bg-muted/10'}`}
                  style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  title={`${o.protocol.toUpperCase()} ${ms(o.durationMs)}${bar.clipped ? ' — outlived the journey (a pooled connection stays open); the bar runs off the right edge' : ''}${bar.early ? ' · starts before the journey’s first hop (clock skew between nodes); cut at 0' : ''} · sent ${byteText(o.bytesSent)}, received ${byteText(o.bytesReceived)} · ${linkNote(o)}`}
                />
              )}
            </div>
            <span className="mono w-[62px] shrink-0 text-right text-[11px] text-muted" title={linkNote(o)}>
              {ms(o.durationMs)}
            </span>
          </div>
        );
      })}
      {(trace.outboundDropped ?? 0) > 0 && (
        <p className="pl-[140px] text-[11px] text-muted">+{trace.outboundDropped} more outbound connections in the same window.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-[2px] bg-ok" /> upstream’s own time
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-[2px] bg-ok/45" /> proxy and connection
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 rounded-full bg-warn/70" /> transit
        </span>
        {trace.hops.some(h => h.durationMs !== null && upstreamShare(h) === null) && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-4 rounded-[2px] border border-ok bg-ok/20" /> split not logged
          </span>
        )}
        {outbound.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-4 rounded-[2px] border border-dashed border-muted/70" /> outbound, linked by time (inferred)
          </span>
        )}
      </div>
      <p className="text-[12px] text-muted" title={split.value ? 'The edge duration = transit between hops + the innermost proxy + the innermost workload. The three add up exactly.' : undefined}>
        {split.value ? (
          <>
            <span className="text-text">Where {ms(split.value.totalMs)} went:</span> app {ms(split.value.appMs)} · proxy {ms(split.value.proxyMs)}
            {trace.hops.length > 1 && <> · network and proxies between hops {ms(split.value.betweenMs)}</>}
            {split.value.derived ? ' (derived: hops ordered by duration)' : ''}
          </>
        ) : (
          <>No time split: {split.reason}</>
        )}
      </p>
    </div>
  );
}

/** One hop, as a step in the flow: who observed it, what it answered, and where it sent the request. */
function HopStep({
  hop,
  inferred,
  onExplain
}: {
  hop: TraceHop;
  inferred: boolean;
  /** Opens the "what went wrong" panel for this hop's status code. Absent for a 2xx/3xx hop. */
  onExplain?: (code: number) => void;
}) {
  const tone = STATUS_TONE[hop.codeClass];
  const explainable = hop.codeClass !== 'ok' && onExplain;
  return (
    <div className="border-l-2 py-2 pl-3" style={{ borderColor: 'var(--line)' }}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="mono text-[11px] text-muted">{hop.seq}</span>
        {/* A failing code is a control: the pill says what happened and the panel behind it says why,
            what the mechanism is, and which command shows it. A 2xx needs no explanation and stays
            a plain pill rather than a button that opens a shrug. */}
        {explainable ? (
          <button
            type="button"
            onClick={() => onExplain(hop.code)}
            className="rounded-[4px] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            title={`Explain HTTP ${hop.code} — what it means here and what to check.`}
          >
            <Pill tone={tone}>{hop.code === 0 ? 'no response' : hop.code} ?</Pill>
          </button>
        ) : (
          <Pill tone={tone}>{hop.code === 0 ? 'no response' : hop.code}</Pill>
        )}
        <span className="text-[12px] font-semibold text-text">
          {hop.role === 'ingress' ? 'ingress gateway' : 'sidecar'}
        </span>
        <span
          className="mono truncate text-[11px] text-muted"
          title={`Reported by the istio-proxy in ${hop.observedBy.namespace}/${hop.observedBy.pod}. The observer, not necessarily either endpoint.`}
        >
          {hop.observedBy.pod}
        </span>
        <span className="mono ml-auto text-[12px] text-text">{ms(hop.durationMs)}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <Endpoint ep={hop.from} />
        <span aria-hidden="true" className="text-muted/60">
          →
        </span>
        <Endpoint ep={hop.to} unreached />
      </div>

      <div className="mono mt-1 truncate text-[12px] text-muted" title={`${hop.method ?? ''} ${hop.path ?? ''}`.trim()}>
        {hop.method && <span className="text-muted/70">{hop.method} </span>}
        {hop.path ?? 'no path recorded'}
      </div>

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
        {hop.upstreamMs !== null && (
          <span title="x-envoy-upstream-service-time: the part of this hop's duration the upstream itself spent.">
            upstream {ms(hop.upstreamMs)}
          </span>
        )}
        {hop.proxyOverheadMs !== null && (
          <span title="This hop's duration minus the upstream's own time — the proxy and the connection.">
            proxy {ms(hop.proxyOverheadMs)}
          </span>
        )}
        {hop.transitMs !== null && (
          <span
            title={
              inferred
                ? 'Derived: this hop’s duration minus the next hop’s. The hops were nested by duration rather than by span id, so read it as an estimate.'
                : 'This hop’s duration minus its callee’s — the time that went into the network and the proxies.'
            }
          >
            transit {ms(hop.transitMs)}
            {inferred ? ' (derived)' : ''}
          </span>
        )}
        {hop.responseCodeDetails && (
          <span className="mono" title="Envoy’s own response_code_details, verbatim.">
            {hop.responseCodeDetails}
          </span>
        )}
      </div>

      {hop.flagDetails.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {hop.flagDetails.map(f => (
            <span
              key={f.flag}
              className={`mono rounded-[4px] border px-1.5 py-0.5 text-[11px] ${f.known ? 'border-warn/40 text-warn' : 'border-line text-muted'}`}
              title={f.meaning}
            >
              {f.flag}
              {f.name ? ` — ${f.name}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TracesTab({ id }: { id: string }) {
  const [section, setSection] = useSection<SectionId>(SECTIONS, SECTIONS[0].id);
  const [tail, setTail] = useState(DEFAULT_TAIL);
  /*
    The time range narrows the tail (`sinceSeconds`), never widens it — there is no store behind
    this read. Held in the URL, like the namespace scope: `?since=` defaults to `tail`, which
    keeps today's request byte-identical (no `sinceSeconds` at all), so the prefetch cache this
    tab warms on mount still hits.
  */
  const [searchParams, setSearchParams] = useSearchParams();
  const since = TIME_RANGES.find(r => r.id === searchParams.get('since'))?.id ?? 'tail';
  const onSince = useCallback(
    (next: string) => {
      setSearchParams(
        prev => {
          const p = new URLSearchParams(prev);
          if (next === 'tail') p.delete('since');
          else p.set('since', next);
          return p;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  const sinceSeconds = sinceOf(since);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TraceOutcome>('all');
  /*
    Journeys opens on App journeys when the server classifies and found any (initialOutcome). That
    default holds only until a person chooses: a chip, a tile, a drill or Reset sets this, and from
    then on a re-read keeps their filter rather than snapping back.
  */
  const touched = useRef(false);
  /*
    Liveness polls are left out on the SERVER, before its 200-journey cap — filtering here would
    get back 200 slots already spent on them (measured: every slot, on platformsbx). So showing
    them is a different read, and it sits in the fetch key.
  */
  const [showPolls, setShowPolls] = useState(false);
  /**
   * Endpoints and Service map: show only rows failing at 5% or more. Set by their Failing tile, or
   * by the Network Operations Outbound-failures card (`?outboundErrors=1`). Read from the router's
   * params, not `window.location.search`: this is a HashRouter app, so the query lives after the `#`
   * and `location.search` is always empty.
   */
  const [failingOnly, setFailingOnly] = useState(() => searchParams.get('outboundErrors') === '1');
  const [mapOutcome, setMapOutcome] = useState<ServiceMapOutcome>('all');
  // Endpoints: include the probes, refusals and direct-IP dials the server left out of p50 and p95.
  const [includeFiltered, setIncludeFiltered] = useState(false);
  /*
    The namespace scope is also a read, not a row filter: it decides which sidecars the server's
    twelve-proxy budget is spent on (the ingress gateways are always read), then keeps the journeys
    that touched it. Options are the namespaces the last read found a sidecar in.
  */
  const [meshOptions, setMeshOptions] = useState<readonly string[]>([]);
  const [namespaces, onNamespaces] = useNamespaceSelection('ns', meshOptions);
  const nsParam = serializeNamespaceParam(namespaces) ?? undefined;
  /**
   * The status code whose explanation is open.
   *
   * One panel at a time: while this is set the journey panel is replaced rather than stacked beside
   * it. `DetailPanel` is a modal dialog below 1280px and an inline sidebar above it, so two of them
   * open at once is either two nested dialogs or two 40%-width columns — closing this one returns
   * the operator to the journey they were reading, which is the behaviour the stack would only
   * approximate.
   */
  const [explainCode, setExplainCode] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The Proxies read panel (`?proxies=1`). One panel at a time: it and the journey panels exclude each other. */
  const [proxiesOpen, setProxiesOpen] = useProxiesPanel();
  /** A Service map problem asks the map to pick its arrow; `n` makes a second press on one row count. */
  const [mapPick, setMapPick] = useState<{ id: string; n: number } | null>(null);
  /** An Outbound problem with no journey to open selects its own row. */
  const [outboundPick, setOutboundPick] = useState<string | null>(null);
  // A pick is one press: leaving the sub-tab ends it, so coming back never reopens a closed arrow.
  useEffect(() => {
    if (section !== 'map') setMapPick(null);
    if (section !== 'outbound') setOutboundPick(null);
  }, [section]);
  /**
   * A journey opened from Endpoints that is older than the table's 200. Fetched from the detail
   * route, which serves it out of the same cached window, and shown in the same panel.
   */
  const [older, setOlder] = useState<Trace | null>(null);
  const drillRun = useRef(0);
  /** Anything the operator does after pressing an Endpoints row outranks that row's pending fetch. */
  const supersedeDrill = () => {
    drillRun.current += 1;
  };
  const selectRow = (traceId: string | null) => {
    supersedeDrill();
    if (traceId && proxiesOpen) setProxiesOpen(false);
    setSelectedId(traceId);
  };
  const searchFor = (text: string) => {
    supersedeDrill();
    setSearch(text);
  };
  /** An Endpoints row opens its newest journey; a search for its journeys is the last resort. */
  const drill = (target: EndpointDrill) => {
    touched.current = true;
    const run = ++drillRun.current;
    if (proxiesOpen) setProxiesOpen(false);
    setExplainCode(null);
    setFilter('all');
    setSection('journeys');
    setSearch('');
    setSelectedId(target.selectId);
    if (target.selectId || !target.fetchId) {
      if (!target.selectId) setSearch(target.search);
      return;
    }
    void api
      .clusterTrace(id, target.fetchId, { tailLines: tail, namespace: nsParam, polls: showPolls ? 'show' : undefined, sinceSeconds })
      .then(r => {
        if (run !== drillRun.current) return;
        const t = r.ok ? (r.data?.trace ?? null) : null;
        if (t) {
          setOlder(t);
          setSelectedId(t.traceId);
        } else setSearch(target.search);
      })
      .catch(() => run === drillRun.current && setSearch(target.search));
  };
  /*
    Whether the NEXT read must go to the proxies again. The server holds its answer for a few
    seconds so that opening this tab does not cost a dozen pod-log reads every time — but the
    Re-read control promises a fresh tail, and a control that can be served a cached copy lies. A
    ref rather than state: flipping it must not re-render, and it must be readable by the fetcher
    `useAsync` already holds rather than changing that fetcher's identity, which would refetch on
    its own and defeat the whole thing. Same mechanism as the Traffic tab.
  */
  const wantsLiveTail = useRef(false);

  // A primitive key, not the fetcher: `useAsync` refetches on the key, and passing the closure
  // loops. The tail belongs in the key, because a different tail is a different read; so does
  // the time range, because a narrower `sinceSeconds` is a different read too.
  const readKey = `${id}:${tail}:${nsParam ?? ''}:${showPolls ? 'polls' : ''}:${since}`;
  const { data, loading, error, reload, stale } = useAsync(
    useCallback(() => {
      const fresh = wantsLiveTail.current;
      wantsLiveTail.current = false;
      return api.clusterTraces(id, { tailLines: tail, namespace: nsParam, polls: showPolls ? 'show' : undefined, sinceSeconds }, { fresh });
    }, [id, tail, nsParam, showPolls, sinceSeconds]),
    0,
    readKey,
    // The cluster is the subject: a wider tail or another option keeps the rows, marked stale,
    // instead of blanking the page for a cold read (async-retain.ts).
    { subject: id }
  );
  // A journey fetched for an older read is not part of the new one: drop it, and any fetch in flight.
  useEffect(() => {
    drillRun.current += 1;
    setOlder(null);
  }, [readKey]);

  /*
    Refused Requests reads `/traffic-errors` — a different route from the traces read above — and
    this is the one place that reads it for this tab: `TracesRefused` used to fetch its own copy,
    which meant two reads and no way for this tab's `SubTabs` chip to know the row count. Same
    fetcher and same key `TracesRefused` used, so the cache entry `prefetch.ts` already warmed for
    this tab is the one this hook joins, not a second one. `since` joins the key for the same
    reason it joins the traces key above: `/traffic-errors` honours `sinceSeconds` too, so this is
    a genuinely different read, not only a different label on the same one.
  */
  const refused = useAsync(
    useCallback(() => api.clusterTrafficErrors(id, { namespace: nsParam, sinceSeconds }), [id, nsParam, sinceSeconds]),
    0,
    `${id}|${nsParam ?? ''}|${since}`
  );

  const reloadLive = useCallback(() => {
    wantsLiveTail.current = true;
    reload();
  }, [reload]);

  const payload: TracesData | undefined = data?.ok ? data.data : undefined;
  const refusedPayload: TrafficData | undefined = refused.data?.ok ? refused.data.data : undefined;
  // A transport failure and an envelope that came back {ok: false} both mean the same thing to
  // TracesRefused: this read failed, and its table must never stand in for that as an empty result.
  const refusedFailure = refused.error ?? (refused.data && !refused.data.ok ? refused.data.error : null) ?? null;
  // Held in state so the options survive the reload a new selection triggers; the list comes from
  // every sidecar on the cluster, so a scoped read returns the same options as an unscoped one.
  const meshList = payload?.window.meshNamespaces;
  const meshKey = (meshList ?? []).map(m => m.namespace).join(',');
  useEffect(() => {
    if (meshKey) setMeshOptions(meshKey.split(','));
  }, [meshKey]);
  const scope = useMemo(() => envelopeScope(id, payload?.summary), [payload?.summary, id]);

  // Re-applied on every read until a person touches the filter; never a chip the toolbar disables.
  useEffect(() => {
    if (!touched.current && payload) setFilter(initialOutcome(payload.summary));
  }, [payload]);

  const slowMs = payload?.summary.slowThresholdMs ?? 500;
  const rows = useMemo(() => filterTraces(payload?.traces ?? [], filter, search, slowMs), [payload?.traces, filter, search, slowMs]);
  const counts = useMemo(() => outcomeCounts(payload?.traces ?? [], search, slowMs), [payload?.traces, search, slowMs]);
  const successful = useMemo(() => (payload?.traces ?? []).filter(isSuccessfulTrace), [payload?.traces]);

  const selected = useMemo(
    () => payload?.traces.find(t => t.traceId === selectedId) ?? (older && older.traceId === selectedId ? older : null),
    [payload?.traces, selectedId, older]
  );
  const selectedIsOlder = !!selected && !payload?.traces.some(t => t.traceId === selected.traceId);
  const selectedRoot = selected?.journeyPath ? failureRoot(selected.journeyPath) : null;

  // Declared above the early returns: a read that threw has no toolbar to hold it, and this is the
  // page's only way to ask again.
  const rereadButton = (
    <button
      type="button"
      onClick={reloadLive}
      disabled={loading}
      className="inline-flex h-8 items-center rounded-[6px] border border-line bg-raised px-2.5 text-[13px] text-text transition-colors hover:border-line-strong disabled:opacity-60"
      title="Read the current tail again. A log window moves, so a refresh shows a different set of requests. The server caps the tail at 1000 lines per proxy."
    >
      {loading ? 'Reading…' : 'Re-read'}
    </button>
  );

  if (loading && !data) return <Skeleton rows={6} />;

  if (data && !data.ok) {
    return (
      <ErrorState
        cluster={id}
        code={data.error?.code ?? 'UNKNOWN'}
        message={data.error?.message ?? 'this cluster did not answer'}
        needsReseed={data.error?.needsReseed}
      />
    );
  }

  // The read threw before anything answered: no payload to count, so every figure below would be a 0
  // from nothing. The banner and Re-read are the whole page.
  if (error && !data) {
    return (
      <div className="flex items-center gap-3 py-4">
        <div className="min-w-0 flex-1">
          <ErrorBanner code={error.code} message={error.message} />
        </div>
        {rereadButton}
      </div>
    );
  }

  const w = payload?.window;
  const s = payload?.summary;
  const corr = payload?.correlation;
  const log = payload?.accessLog;

  /*
    The same three states the Traffic tab is drawn through, from the same helper, because both tabs
    read the same access log and must reach the same verdict about it. `noEvidence` is what turns
    every count below from a zero into "not read".
  */
  const { readsSkipped, unprovenZero, noEvidence, notRead, windowLine } = accessLogEvidence(log, w);
  const countStatus = (label: string) => (noEvidence ? notRead : scope.of(label));

  /** Where the lines are going, when they are not coming here. Named, never invented. */
  const offPodSinks = (log?.providerDetail ?? []).filter(p => p.readable === false && p.destination);

  const spanLine = shownSpanLine(s, payload?.traces ?? []);
  const leftOut = hiddenLine(s, [...namespaces]);
  const scopeLine = namespaces.size
    ? `Scoped to ${[...namespaces].join(', ')}: its sidecars and the ingress gateways were read`
    : null;
  const outcomeLabel: Record<TraceOutcome, [string, string]> = {
    all: ['All', 'Every correlated journey in the table.'],
    app: ['App journeys', 'Journeys an application served — not a probe, a refusal, platform traffic or egress.'],
    egress: ['Declared egress', 'Journeys out of the cluster to an address a NetworkPolicy or another cluster object names.'],
    refused: ['Security refusals', 'Journeys the mesh or an ingress policy refused (403, RBAC). Working as intended, so never an app error.'],
    'app-errors': ['App errors', 'App journeys with a 5xx or an upstream failure (UF, URX, UH, NR, UT) on any hop. A 4xx or a refusal is not one.'],
    slow: [`Slow ≥ ${slowMs}ms`, `Journeys whose edge duration was at least ${slowMs}ms. A threshold, not a percentile: a tail of lines has no denominator.`],
    multi: ['Multi-hop', 'Journeys more than one proxy observed — the ones with a waterfall worth opening.']
  };

  const columns: Column<Trace>[] = [
    {
      key: 'status',
      header: 'Result',
      pin: true,
      priority: 1,
      width: '92px',
      sortValue: t => t.finalStatus ?? -1,
      render: t => (
        <span title={t.finalStatusClass ? STATUS_WHY[t.finalStatusClass] : 'No edge hop was read for this trace.'}>
          <Pill tone={t.finalStatusClass ? STATUS_TONE[t.finalStatusClass] : 'unknown'}>
            {t.finalStatus === null ? 'unknown' : t.finalStatus === 0 ? 'none' : t.finalStatus}
          </Pill>
        </span>
      )
    },
    {
      key: 'request',
      header: 'Request',
      priority: 1,
      max: '260px',
      render: t => (
        <span className="mono block truncate text-[12px]" title={`${t.method ?? ''} ${t.path ?? ''}`.trim() || 'No method or path was recorded.'}>
          {t.method && <span className="text-muted">{t.method} </span>}
          {t.path ?? <span className="text-muted/70">— no path recorded</span>}
        </span>
      )
    },
    {
      key: 'host',
      header: 'Host',
      // Kept at 1100 (an ~812px container sheds only priority 3); Started gives way instead, and
      // drops with the rest of priority 2 once an inline journey panel narrows the table under 660px.
      priority: 2,
      max: '150px',
      render: t => (
        <span className="mono block truncate text-[12px] text-muted" title={t.authority ?? 'No Host header was recorded.'}>
          {t.authority ?? '—'}
        </span>
      )
    },
    {
      key: 'duration',
      header: 'Duration',
      ...NUMERIC,
      priority: 1,
      width: '84px',
      sortValue: t => t.totalDurationMs ?? -1,
      render: t => (
        <span
          className={`mono text-[13px] ${t.totalDurationMs !== null && t.totalDurationMs >= slowMs ? 'text-warn' : ''}`}
          title={`From the edge hop. Slow is ≥ ${slowMs}ms on this tab.`}
        >
          {ms(t.totalDurationMs)}
        </span>
      )
    },
    {
      key: 'hops',
      header: 'Seen',
      ...NUMERIC,
      priority: 1,
      width: '64px',
      sortValue: t => t.hopCount,
      render: t => (
        <span
          className="mono text-[13px]"
          title={`${t.hopCount} access-log line${t.hopCount === 1 ? '' : 's'} matched this trace in the window that was read. Not the request's full topology — a proxy that was not tailed contributes no hop.${t.hopsDropped ? ` ${t.hopsDropped} further hop(s) were dropped by the per-trace cap.` : ''}`}
        >
          {t.hopCount}
          {t.hopsDropped > 0 && <span className="text-muted">+</span>}
        </span>
      )
    },
    {
      key: 'started',
      header: 'Started',
      ...NUMERIC,
      // Sheds with the trace id below 900px; the journey panel prints both.
      priority: 3,
      width: '100px',
      sortValue: t => (t.startTime ? Date.parse(t.startTime) : 0),
      render: t => (
        <span className="text-[12px] text-muted" title={t.startTime ?? 'No start stamp was recorded.'}>
          {t.startTime ? ago(t.startTime) : '—'}
        </span>
      )
    },
    {
      key: 'trace',
      header: 'Trace ID',
      priority: 3,
      max: '150px',
      render: t => (
        <span
          className="mono block truncate text-[12px] text-muted"
          title={`${t.traceId} — correlated by ${t.correlatedBy}${t.requestId ? `, request id ${t.requestId}` : ''}`}
        >
          {t.traceId}
        </span>
      )
    }
  ];

  /*
    The controls that change the READ, shared by all three sections: each is a different tail from
    the proxies, so the journeys, the endpoints and the map always describe the same lines.
  */
  const scopeControl = <NamespaceFilter options={meshOptions} selected={namespaces} onChange={onNamespaces} />;
  const pollsButton = (
      <button
        type="button"
        onClick={() => setShowPolls(v => !v)}
        aria-pressed={showPolls}
        title={
          showPolls
            ? 'Liveness polls are in the journeys, endpoints and map. Press to leave the successful ones out again.'
            : `Health, readiness and metrics polls that succeeded are left out before the 200-journey cap, so the slots go to real requests. A failing poll always stays.${
                s?.pollsHiddenBy.length ? ` Hidden: ${s.pollsHiddenBy.map(p => `${p.kind} ${p.count}`).join(', ')}.` : ''
              } Press to show them.`
        }
        className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] border px-2.5 text-[13px] transition-colors ${
          showPolls ? 'border-accent bg-accent/10 text-text' : 'border-line text-muted hover:border-line-strong hover:text-text'
        }`}
      >
        {showPolls ? 'Polls shown' : 'Polls hidden'}
        {!showPolls && !noEvidence && s && (
          <span className="mono tabular-nums text-[12px] text-muted">{s.pollsHidden.toLocaleString('en-US')}</span>
        )}
      </button>
  );
  const tailSelect = (
      <FilterSelect
        label="Tail"
        value={String(tail)}
        onChange={v => setTail(Number(v))}
        options={TAIL_CHOICES.map(n => ({ value: String(n), label: `${n} lines per proxy` }))}
      />
  );
  /*
    Beside `scopeControl`: narrows the tail (`sinceSeconds`), never widens it — there is no store
    behind this read, so the choices stop at 24h. `tail` (the default) sends no `sinceSeconds` at
    all, which keeps the URL byte-identical to today's so the prefetch cache still hits.
  */
  const rangeSelect = (
      <span title={rangeNote(since, tail)}>
        <FilterSelect
          label="Range"
          value={since}
          onChange={onSince}
          options={TIME_RANGES.map(r => ({ value: r.id, label: r.label }))}
        />
      </span>
  );
  const readStampText = readStamp(s?.readAt, Date.now());
  /* Endpoints, Map and Outbound have room for all three in their bar; readStampText joins Re-read. */
  const readTail = (
    <>
      {pollsButton}
      {tailSelect}
      {rangeSelect}
      {rereadButton}
      {readStampText && <span className="text-[12px] text-muted">{readStampText}</span>}
    </>
  );
  /*
    Journeys' bar also carries search and seven outcome chips, so Polls and Tail fold into a
    disclosure to keep it one row at 1440; Re-read stays visible. The count on the summary is how
    many of the two differ from the default, so a changed read is never hidden behind it.
  */
  const readOptionsChanged = (showPolls ? 1 : 0) + (tail !== DEFAULT_TAIL ? 1 : 0) + (since !== 'tail' ? 1 : 0);
  const readOptions = (
    <details className="relative">
      <summary
        className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-[6px] border border-line px-2.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-text [&::-webkit-details-marker]:hidden"
        title="Polls, the tail per proxy and the time range: all three change what is read, not only what is shown."
      >
        Read options
        {readOptionsChanged > 0 && <span className="mono tabular-nums text-[12px] text-text">{readOptionsChanged}</span>}
      </summary>
      <div className="absolute right-0 z-20 mt-1 flex items-center gap-2 rounded-[8px] border border-line bg-surface p-2 shadow-sm">
        {pollsButton}
        {tailSelect}
        {rangeSelect}
      </div>
    </details>
  );
  const pickOutcome = (o: TraceOutcome) => {
    touched.current = true;
    supersedeDrill();
    setFilter(o);
  };
  const resetJourneys = () => {
    touched.current = true;
    supersedeDrill();
    setSearch('');
    setFilter('all');
    setShowPolls(false);
    onNamespaces(new Set());
  };
  const loadedIds = new Set((payload?.traces ?? []).map(t => t.traceId));
  /** The Problems strip's rows for the open sub-tab; `null` is a source not read, never "none". */
  const tracesProblems: Problem<TracesTarget>[] | null = noEvidence
    ? null
    : section === 'journeys'
      ? endpointProblems(payload?.endpoints.endpoints, payload?.traces ?? [], slowMs)
      : section === 'endpoints'
        ? endpointProblems(endpointBlock(payload, includeFiltered)?.endpoints, payload?.traces ?? [], slowMs)
        : section === 'map'
          ? edgeProblems(payload?.serviceMap)
          : outboundProblems(payload?.outbound?.rows, policyRead(payload?.summary), loadedIds);
  const openTraceProblem = (p: Problem<TracesTarget>) => {
    if ('drill' in p.target) drill(p.target.drill);
    else if ('outbound' in p.target) setOutboundPick(p.target.outbound);
    else {
      const edge = p.target.edge;
      setMapPick(v => ({ id: edge, n: (v?.n ?? 0) + 1 }));
    }
  };
  /** The sub-tabs with a Problems strip and a tile row. Journeys carries its own strip; Successful and Blocked are one table each. */
  const tiled = section === 'endpoints' || section === 'map' || section === 'outbound';
  const problemStrip = (
    <ProblemStrip problems={tracesProblems} unavailableWhy={noEvidence ? notRead.why : 'this server did not send it'} onOpen={openTraceProblem} collapsed={section === 'journeys' ? 1 : undefined} emptyText={section === 'journeys' || (section === 'endpoints' && !includeFiltered) ? filteredEmptyLine(payload?.endpointsFiltered) : undefined} />
  );
  const readFilterCount = (namespaces.size ? 1 : 0) + (showPolls ? 1 : 0) + (failingOnly ? 1 : 0) + (mapOutcome === 'all' ? 0 : 1);
  const resetRead = () => {
    supersedeDrill();
    setShowPolls(false);
    setFailingOnly(false);
    setMapOutcome('all');
    onNamespaces(new Set());
  };

  return (
    // A workspace tab (IS_WORKSPACE): the page does not scroll. Everything down to the tiles stays
    // put; below them the journey table and the journey panel each scroll themselves, and the
    // other sub-tabs scroll as one body.
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${stale ? '[&_tbody]:opacity-60' : ''}`} aria-busy={stale && loading ? true : undefined}>
      <div className="shrink-0">
      <div className="flex items-start gap-2">
      <SubTabs
        className="min-w-0 flex-1"
        sections={SECTIONS}
        active={section}
        onSelect={s => {
          supersedeDrill();
          setSection(s);
        }}
        counts={{
          ...(payload && !noEvidence ? { journeys: s?.traces ?? 0, successful: successful.length, endpoints: endpointBlock(payload, includeFiltered)?.endpointsFound ?? 0, map: payload.serviceMap?.edges.length ?? 0, ...(payload.outbound ? { outbound: payload.outbound.rowsFound } : {}) } : {}),
          // Undefined until the refused read lands, and never 0 while it is still loading or failed —
          // `refusedPayload` is only set from a `{ok: true}` envelope.
          ...(refusedPayload?.ingress.refused ? { refused: refusedPayload.ingress.refused.rowsFound } : {})
        }}
      />
      {/*
        How the window was correlated, once for all four sub-tabs. `traceparentAbsent` is a
        configuration statement (the stock stdout-json format does not name the header) and
        `nestingInferred` its consequence: parent/child order comes from durations. The badge says
        the verdict; the tip says why, with the line counts.
      */}
      {corr && (corr.traceparentAbsent || corr.nestingInferred) && !noEvidence && (
        <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-line px-2.5 text-[12px] text-muted">
          <Dot tone="unknown" />
          Hop order inferred
          <InfoTip text={correlationTip(corr)} title="Hop order inferred" />
          {/* Below xl the source would wrap the sub-tab strip; the tip names it too. */}
          {corr.source && <span className="mono hidden text-[12px] xl:inline">{corr.source}</span>}
        </span>
      )}
      <ProxiesChip
        w={w}
        collectedAt={payload?.collectedAt}
        open={proxiesOpen}
        onToggle={() => {
          if (!proxiesOpen) {
            selectRow(null);
            setExplainCode(null);
          }
          setProxiesOpen(!proxiesOpen);
        }}
      />
      </div>
      <UnavailableNotice scope={scope} className="mb-4" />

      {error && (
        <div className="pb-4">
          <ErrorBanner code={error.code} message={error.message} />
        </div>
      )}
      <StaleReadNotice stale={stale} loading={loading} failed={!!error} what="journeys, endpoints and calls" />

      {/* ---------------------------------------- can these requests be seen here at all */}
      {log && (log.state !== 'on' || noEvidence) && (
        <div className="mb-4 rounded-[8px] border border-warn/40 bg-warn/5 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <Dot tone={log.state === 'unknown' ? 'unknown' : 'warn'} />
            <span className="text-[13px] font-semibold text-text">
              {readsSkipped
                ? 'The access log does not reach this tab, so no journey can be rebuilt'
                : unprovenZero
                  ? 'No request line came back, and this tab cannot prove one should have'
                  : log.state === 'off'
                    ? 'Envoy access logging is off — there are no lines to correlate'
                    : 'Access logging state is unknown'}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-muted">{log.why}</p>
          {readsSkipped && (
            <p className="mt-1 text-[13px] text-muted">
              No proxy was read, so the counts below are "not read", not zero.{' '}
              {log.recordedElsewhere
                ? 'The requests are being recorded — query them at the destination named below.'
                : 'Nothing is recording these requests, here or anywhere else.'}
            </p>
          )}
          {log.decidedBy.length > 0 && (
            <p className="mono mt-1 text-[12px] text-muted/80">
              Decided by {log.decidedBy.map(d => `${d.namespace}/${d.name}`).join(', ')}
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ headline numbers */}
      {/* Not on Journeys: its tiles repeated the outcome chips one for one, and the rows need the height.
          The cap rides the result line and the correlation source the badge. */}
      {/* Problems first: on every sub-tab with tiles, the strip sits above them. */}
      {tiled && <div className="pt-4">{problemStrip}</div>}
      {tiled && (
      <div className="grid grid-cols-2 gap-3 border-b border-line pb-4 lg:grid-cols-4">
        {section === 'endpoints' && <EndpointTiles payload={payload} status={countStatus('traces')} failingOnly={failingOnly} onFailing={() => setFailingOnly(v => !v)} includeFiltered={includeFiltered} />}
        {section === 'map' && <MapTiles payload={payload} status={countStatus('traces')} outcome={mapOutcome} onOutcome={setMapOutcome} />}
        {section === 'outbound' && <OutboundTiles payload={payload} status={payload && !payload.outbound ? { state: 'unavailable', what: 'outbound calls', why: 'This server does not report outbound calls yet — rebuild srv.', blind: 1, total: 1, truncated: false, truncatedWhy: '' } : countStatus('traces')} failingOnly={failingOnly} onFailing={() => setFailingOnly(v => !v)} />}
      </div>
      )}
      </div>

      <div className={`min-h-0 flex-1 pt-4 ${section === 'journeys' ? 'flex flex-col' : 'overflow-y-auto overflow-x-hidden overscroll-contain pb-4'}`}>
        <div className={`flex gap-4 ${section === 'journeys' ? 'min-h-0 flex-1' : ''}`}>
          <div className={`min-w-0 flex-1 ${section === 'journeys' ? 'flex min-h-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain pb-4' : ''}`}>
            {section === 'endpoints' && (
              <>
                <div className={PINNED_FILTERS}>
                  <FilterBar activeCount={readFilterCount} onReset={resetRead} resultLine={noEvidence ? 'Endpoints not read' : `${endpointBlock(payload, includeFiltered)?.endpointsFound ?? 0} endpoints${failingOnly ? ', failing only' : ''}`}>
                    {scopeControl}
                    {readTail}
                  </FilterBar>
                </div>
                <TracesEndpoints payload={payload} noEvidence={noEvidence} windowLine={[windowLine, scopeLine, leftOut].filter(Boolean).join('. ')} onDrill={drill} failingOnly={failingOnly} includeFiltered={includeFiltered} onIncludeFiltered={setIncludeFiltered} />
              </>
            )}
            {section === 'map' && (
              <>
                <div className={PINNED_FILTERS}>
                  <FilterBar activeCount={readFilterCount} onReset={resetRead} resultLine={noEvidence ? 'Calls not read' : `${payload?.serviceMap?.edges.length ?? 0} calls between ${payload?.serviceMap?.nodes.length ?? 0} parties${mapOutcome === 'all' ? '' : `, ${mapOutcome} only`} `}>
                    {scopeControl}
                    {readTail}
                  </FilterBar>
                </div>
                <TracesServiceMap
                  payload={payload}
                  noEvidence={noEvidence}
                  windowLine={[windowLine, scopeLine].filter(Boolean).join('. ')}
                  outcome={mapOutcome}
                  onOutcome={setMapOutcome}
                  pickRequest={mapPick}
                  requestTraceId={selected?.traceId}
                  onOpenJourney={tid => drill({ selectId: payload?.traces.some(t => t.traceId === tid) ? tid : null, fetchId: tid, search: '' })}
                />
              </>
            )}
            {section === 'outbound' && (
              <>
                <div className={PINNED_FILTERS}>
                  <FilterBar activeCount={readFilterCount} onReset={resetRead} resultLine={noEvidence ? 'Outbound not read' : !payload?.outbound ? 'Outbound not reported' : `${payload.outbound.connections} connections${failingOnly ? ', failing only' : ''}`}>
                    {scopeControl}
                    {readTail}
                  </FilterBar>
                </div>
                <TracesOutbound payload={payload} noEvidence={noEvidence} windowLine={[windowLine, scopeLine].filter(Boolean).join('. ')} onDrill={drill} failingOnly={failingOnly} selectedKey={outboundPick} />
              </>
            )}
            {section === 'refused' && (
              <TracesRefused
                clusterId={id}
                payload={refusedPayload}
                failure={refusedFailure}
                initial={refused.initial}
                reload={refused.reload}
              />
            )}
            {section === 'successful' && (
              <SuccessfulRequests
                rows={successful}
                status={countStatus('traces')}
                kept={keptCaption(s)}
                noEvidence={noEvidence}
                showPolls={showPolls}
                onShowPolls={setShowPolls}
                onOpen={traceId => drill({ selectId: traceId, fetchId: traceId, search: '' })}
              />
            )}
            {section === 'journeys' && problemStrip}
            {section === 'journeys' && (
            <Section
              compactHint
              // No min-h-0: the section keeps its heading, hint, FilterBar and the table's floor, so a
              // short window overflows the column (which scrolls) instead of drawing the blocks below over it.
              className="flex flex-1 flex-col"
              title="Request journeys"
              label={String(rows.length)}
              // Scope and search share the heading row, so the table below keeps that height.
              action={
                <div className="flex items-center gap-2">
                  {scopeControl}
                  <label className="relative flex w-[280px] [&>input]:min-w-[180px]">
                    <span className="sr-only">Search journeys</span>
                    <SearchBox value={search} onChange={searchFor} placeholder="Trace id, request id, path, host…" />
                  </label>
                </div>
              }
              hint={`One row per correlated request. ${windowLine}.${scopeLine ? ` ${scopeLine}.` : ''}${spanLine ? ` ${spanLine}.` : ''}${leftOut ? ` ${leftOut}.` : ''} A hop count is what these proxies observed — never the request's full topology.`}
            >
              <FilterBar
                activeCount={(search.trim() ? 1 : 0) + (filter !== 'all' ? 1 : 0) + (namespaces.size ? 1 : 0) + (showPolls ? 1 : 0)}
                onReset={resetJourneys}
                resultLine={noEvidence ? 'Journeys not read' : `${rows.length} of ${payload?.traces.length ?? 0} journeys${keptCaption(s) ? ` · ${keptCaption(s)}` : ''}`}
              >
                <div role="group" aria-label="Filter journeys by outcome" className="inline-flex flex-wrap items-center gap-1">
                  {TRACE_OUTCOMES.map(o => {
                    const active = filter === o;
                    const unclassified = outcomeUnclassified(o, s);
                    return (
                      <button
                        key={o}
                        type="button"
                        disabled={unclassified}
                        onClick={() => pickOutcome(o)}
                        title={unclassified ? 'This server does not classify requests yet, so this filter has no answer.' : outcomeLabel[o][1]}
                        aria-pressed={active}
                        className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] border px-2.5 text-[13px] transition-colors ${
                          active ? 'border-accent bg-accent/10 text-text' : 'border-line text-muted enabled:hover:border-line-strong enabled:hover:text-text disabled:opacity-60'
                        }`}
                      >
                        <span className={o === 'app-errors' && counts['app-errors'] > 0 ? 'text-bad' : o === 'slow' && counts.slow > 0 ? 'text-warn' : ''}>
                          {outcomeLabel[o][0]}
                        </span>
                        {!noEvidence && <span className="mono tabular-nums text-[12px] text-muted">{unclassified ? '—' : counts[o]}</span>}
                      </button>
                    );
                  })}
                </div>
                {readOptions}
                {rereadButton}
                {readStampText && <span className="text-[12px] text-muted">{readStampText}</span>}
              </FilterBar>

              {/* The journey list's own scroller: the heading and the FilterBar above it stay put. Its 240px
                  basis and floor keep several rows on screen and set the section's own minimum (a
                  0% basis made that minimum the whole table); on a window too short for that, the column
                  around it scrolls instead, so nothing below is clipped out of reach. */}
              <div className={`${CARD_TABLE_CLASS} min-h-[240px] flex-[1_1_240px] overflow-y-auto overflow-x-hidden overscroll-contain [&_.table-tools]:mt-0! [&_.table-tools]:flex-wrap [&_.table-tools]:gap-1`}>
              <DataTable
                id="traces.journeys"
                columns={columns}
                rows={rows}
                rowKey={t => t.traceId}
                selectedKey={selectedId ?? undefined}
                onSelect={t => selectRow(t.traceId === selectedId ? null : t.traceId)}
                empty={
                  /*
                    `readsSkipped` first, then the unproven zero, and only then "the cluster was
                    quiet". An empty table is allowed to say a cluster had no requests only when
                    something actually looked — otherwise this is the screen that turns a log
                    streamed off the pod into "no traffic".
                  */
                  <Empty
                    title={
                      readsSkipped
                        ? 'No proxy was read'
                        : noEvidence
                          ? 'Nothing came back to correlate'
                          : payload?.traces.length
                            ? 'No journey matches these filters'
                            : (s?.journeysSeen ?? 0) > 0
                              ? 'Every journey read was a successful poll or outside the scope'
                              : 'No request journey in the window that was read'
                    }
                    hint={
                      readsSkipped
                        ? 'The access log is streamed off the pod, so there are no lines here to stitch. The destination is named above.'
                        : noEvidence
                          ? 'The proxies were tailed and returned no request line at all — consistent with a quiet cluster, and equally consistent with a log this tab cannot see.'
                          : payload?.traces.length
                            ? 'Clear the search, or widen the outcome filter.'
                            : (s?.journeysSeen ?? 0) > 0
                              ? `${leftOut ?? 'Journeys were left out'}. Show polls, or widen the namespace scope.`
                              : 'Widen the tail, or re-read: a log window moves, and the proxies that were tailed may not be the ones serving this traffic.'
                    }
                  />
                }
              />
              </div>
            </Section>
            )}

            {/* ------------------------------------------- where the full spans live, when they do */}
            {/*
              No URL is constructed. A SAP Cloud Logging tenant's dashboard host is not readable
              from the cluster — it is a binding in a different subaccount — and inventing one
              would send an operator to a 404 with this console's name on it. What CAN be proved is
              the sink Envoy is streaming to, and that is what is named.
            */}
            {offPodSinks.length > 0 && (
              <div className="mt-4 shrink-0 rounded-[8px] border border-line bg-panel/40 px-4 py-3">
                <p className="text-[13px] font-semibold text-text">The full records are in your log backend</p>
                <p className="mt-1 text-[13px] text-muted">
                  {offPodSinks.map(p => p.name).join(' and ')} stream{offPodSinks.length === 1 ? 's' : ''} these lines to{' '}
                  <span className="mono">{offPodSinks.map(p => p.destination).join(', ')}</span>, which on a Kyma
                  cluster is normally SAP Cloud Logging. Search there by the trace id or the request id in the table
                  above — both are propagated end to end, so a journey this window clipped is whole over there. This
                  console holds no credential for that tenant and cannot link into it.
                </p>
              </div>
            )}
          </div>

          {/* ------------------------------------------------------------------ the journey itself */}
          {/* The proxies behind every hop, from the chip beside the sub-tabs; on every sub-tab. */}
          {proxiesOpen && w && (
            <DetailPanel title="Proxies read" onClose={() => setProxiesOpen(false)} inlineClassName="sticky top-0 max-h-[calc(100vh-180px)]">
              <TracesProxiesRead w={w} />
            </DetailPanel>
          )}
          {section === 'journeys' && !proxiesOpen && explainCode !== null && (
            <DiagnosisDrawer
              diagnosis={diagnose({ kind: 'http', code: explainCode })}
              onClose={() => setExplainCode(null)}
            />
          )}
          {section === 'journeys' && !proxiesOpen && selected && explainCode === null && (
            <DetailPanel
              title={
                <span className="flex items-baseline gap-2">
                  <Pill tone={selected.finalStatusClass ? STATUS_TONE[selected.finalStatusClass] : 'unknown'}>
                    {selected.finalStatus === null ? 'unknown' : selected.finalStatus === 0 ? 'none' : selected.finalStatus}
                  </Pill>
                  <span className="mono truncate text-[13px]">
                    {selected.method} {selected.path ?? 'no path'}
                  </span>
                </span>
              }
              subtitle={`${selected.hopCount} hop${selected.hopCount === 1 ? '' : 's'} observed · ${ms(selected.totalDurationMs)} at the edge · correlated by ${selected.correlatedBy}`}
              onClose={() => selectRow(null)}
              inlineClassName="sticky top-0 max-h-[calc(100vh-180px)]"
            >
              <div className="space-y-4">
                {selectedIsOlder && (
                  <p className="rounded-[6px] border border-line bg-panel/40 px-3 py-2 text-[13px] text-muted">
                    Opened from Endpoints. This journey is not among the {payload?.traces.length ?? 0} the table
                    keeps, so it has no row there.
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  {selectedRoot && (
                    <p className="text-[13px] text-bad">
                      Failure root: {selectedRoot.node} · {selectedRoot.reason}
                    </p>
                  )}
                  <button
                    type="button"
                    className="shrink-0 rounded-[6px] border border-line px-2.5 py-1 text-[12px] text-muted hover:border-line-strong hover:text-text"
                    onClick={() => setSection('map')}
                  >
                    Explore service calls
                  </button>
                </div>
                <RequestSummary trace={selected} />
                <div className="grid grid-cols-2 gap-3 [&>div]:min-w-0">
                  <div className="col-span-2">
                    <Field label="Host" value={<span className="break-all">{selected.authority ?? '—'}</span>} mono />
                  </div>
                  <Field label="Started" value={selected.startTime ? ago(selected.startTime) : '—'} />
                  <Field label="Correlation" value={selected.correlatedBy === 'request-id' ? 'request id · hop order inferred' : selected.correlatedBy} mono />
                  <div className="col-span-2">
                    <Field label="Trace ID" value={<span className="break-all">{selected.traceId}</span>} mono />
                  </div>
                  <div className="col-span-2">
                  <Field
                    label="Request ID"
                    value={
                      selected.requestIds && selected.requestIds.length > 1 ? (
                        <span
                          className="text-warn"
                          title="The hops disagree about the request id. Worth knowing: it means these lines may not all belong to one request."
                        >
                          {selected.requestIds.join(', ')}
                        </span>
                      ) : (
                        <span className="break-all">{selected.requestId ?? '—'}</span>
                      )
                    }
                    mono
                  />
                  </div>
                </div>

                {selected.nestingAnomaly && (
                  <p className="rounded-[6px] border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-muted">
                    These hops do not nest: an inner hop reports a longer duration than the hop that called it. That is
                    clock skew between nodes, or two requests that share a correlation id — so no transit time is
                    published for this journey.
                  </p>
                )}

                <div>
                  <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Request path</p>
                  <JourneyPath trace={selected} summary={payload?.summary} onExplain={setExplainCode} />
                </div>

                <div>
                  <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Waterfall</p>
                  <Waterfall trace={selected} />
                </div>

                <div>
                  <p className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                    Hop by hop
                  </p>
                  <div className="divide-y divide-line">
                    {selected.hops.map(h => (
                      <HopStep
                        key={h.seq}
                        hop={h}
                        inferred={selected.correlatedBy === 'request-id'}
                        onExplain={setExplainCode}
                      />
                    ))}
                  </div>
                  {selected.hopsDropped > 0 && (
                    <p className="mt-2 text-[13px] text-muted">
                      {selected.hopsDropped} further hop{selected.hopsDropped === 1 ? '' : 's'} matched this journey and
                      were dropped by the per-journey cap.
                    </p>
                  )}
                </div>
              </div>
            </DetailPanel>
          )}
        </div>
      </div>
    </div>
  );
}
