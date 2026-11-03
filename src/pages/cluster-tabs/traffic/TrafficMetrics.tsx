/**
 * Traffic Errors → the four headline counts, and the access-logging state beneath them.
 *
 * ## Why four cards and not five
 *
 * Access logging used to be a fifth tile in the same row, which said the wrong thing twice: it gave a
 * system-configuration fact the same weight as a measurement, and it put a pill where the other four
 * had digits, so the row read as "four numbers and one that failed to load". It is now a strip under
 * the cards — same palette, no digits, recessed surface — because the question it answers ("can this
 * tab see the requests at all") is a precondition for the four above it rather than a peer of them.
 *
 * ## The thing this screen is designed against
 *
 * On the reference cluster `server` is **0** and `noResponse` is **1808** — the largest number on the
 * page. A layout that assumes 5xx is the headline looks broken here, and a layout that paints the
 * biggest number red asserts a failure the data does not support: `response_code 0` is a connection
 * Envoy never answered, which is a dropped client or an incomplete TLS handshake as often as it is a
 * fault. So the no-response card is neutral by construction and its popover says why before the
 * operator can act on it.
 *
 * Every count here describes **the access-log window that was read**, which is why each card states
 * that under its subtitle and why `logReadVerdict` is consulted before a single digit is drawn: a 0
 * from a mesh that streams its logs to OTLP is "nobody looked", and it must not look like good news.
 */
import type { AccessLogVerdict, TrafficData } from '../../../api';
import { Dot, TONE_TEXT } from '../../../components/ui';
import { MetricValue, type MetricStatus } from '../../../components/unavailable';
import { InfoPopover, type InfoPopoverContent } from '../../../components/InfoPopover';
import { PROVIDER_KIND_WHY } from '../access-log';
import { accessLogView, logReadVerdict } from './metrics-logic';
import type { StatusFilter } from './traffic-filters';

/**
 * The one sentence repeated under all four cards.
 *
 * Repeated rather than stated once for the row, because each card is read on its own — an operator
 * who has scrolled to the third card has not necessarily read a footnote under the first, and "0
 * server errors" with no window qualifier is the sentence this whole tab exists to avoid printing.
 */
const WINDOW_NOTE = 'In the window read — not a cluster total, and not a rate.';

export function TrafficMetrics({
  summary,
  accessLog,
  loading,
  onPickStatus
}: {
  summary: TrafficData['summary'] | undefined;
  accessLog: AccessLogVerdict | undefined;
  loading: boolean;
  onPickStatus: (s: StatusFilter) => void;
}): JSX.Element {
  // One verdict for all four counts: they come from the same parsed lines, so they cannot be
  // individually readable. See `logReadVerdict` for why `summary.unavailable` is not the source.
  const status = logReadVerdict(summary, accessLog);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Server errors"
          value={summary?.server}
          subtitle="HTTP 5xx responses"
          /* Red only when there is something to be red about. A zero in the console's alarm colour
             blunts the colour for the cluster where it is not zero. */
          valueClass={(summary?.server ?? 0) > 0 ? 'text-bad' : 'text-text'}
          status={status}
          loading={loading}
          ariaLabel="Explain server errors"
          info={{
            title: 'Server errors (5xx)',
            means: 'Requests where the recorded HTTP response code is between 500 and 599.',
            source:
              'The collector’s own classification of response_code on each Envoy access-log line. This card does not re-test the number against 500–599 — if it did, it could disagree with the failures table, which reads the same class field.',
            limitations: [
              'Describes the window that was read. A 0 means no 5xx appeared in this window; it does not mean the cluster has never returned one.',
              'Only the proxies this read reached contribute. Proxies read states how many of the candidates answered.'
            ],
            sources: ['accessLog']
          }}
          onPick={() => onPickStatus('server')}
          actionLabel="show only the server errors"
        />

        <MetricCard
          label="Client errors"
          value={summary?.client}
          subtitle="HTTP 4xx responses"
          valueClass={(summary?.client ?? 0) > 0 ? 'text-warn' : 'text-text'}
          status={status}
          loading={loading}
          ariaLabel="Explain client errors"
          info={{
            title: 'Client errors (4xx)',
            means: 'Requests where the recorded HTTP response code is between 400 and 499.',
            source: 'The collector’s classification of response_code, the same field the failures table reads.',
            limitations: [
              'A high count is not automatically a fault. A host whose job is to turn away unauthenticated callers reports exactly this shape.',
              'Nothing here states why a request was rejected. Where Envoy recorded a reason, it is in the failures table as its own words.',
              'Describes the window that was read.'
            ],
            sources: ['accessLog']
          }}
          onPick={() => onPickStatus('client')}
          actionLabel="show only the client errors"
        />

        <MetricCard
          label="No HTTP response"
          value={summary?.noResponse}
          subtitle="Response code not recorded"
          /* Deliberately neutral, even at 1808. This is the largest number on the reference cluster
             and it is not an error count; a warn tone here would turn a working mesh into a page of
             alarms and leave nothing louder for the 5xx that matters. */
          valueClass="text-text"
          status={status}
          loading={loading}
          ariaLabel="Explain no HTTP response"
          info={{
            title: 'No HTTP response',
            means:
              'Entries where an HTTP response code was not recorded. These should not automatically be interpreted as application HTTP errors.',
            source:
              'response_code 0 on the access-log line — Envoy recorded the connection and no HTTP response over it.',
            limitations: [
              'A dropped connection, a TLS handshake that never completed, a client that hung up and a plain TCP session all land here.',
              'This page never infers which of those it was. Envoy’s response flags, where it set any, are the only evidence of a cause and they appear on the failure row itself.',
              'Describes the window that was read.'
            ],
            sources: ['accessLog', 'networkIssues']
          }}
          onPick={() => onPickStatus('no-response')}
          actionLabel="show only the entries with no HTTP response"
        />

        <MetricCard
          label="Failure patterns"
          value={summary?.groups}
          subtitle="Distinct grouped traffic patterns"
          valueClass="text-text"
          status={status}
          loading={loading}
          ariaLabel="Explain failure patterns"
          info={{
            title: 'Failure patterns',
            means: 'Grouped combinations of response code, method, path, host and upstream information.',
            source: 'One group per distinct combination, counted by the collector as it parsed the window.',
            limitations: [
              'This counts patterns, not requests. One pattern can stand for a single request or for hundreds — the count beside each row in the table is the one that says which.',
              'Two requests that differ only in a path parameter are two patterns, so a busy API can report a large number here without anything being wrong.',
              'Describes the window that was read.'
            ],
            sources: ['accessLog']
          }}
          /* Clears the class filter rather than setting one: "patterns" is every class at once, and
             there is no StatusFilter that means "grouped". */
          onPick={() => onPickStatus('all')}
          actionLabel="clear the response-class filter and show every pattern"
        />
      </div>

      <AccessLogStrip accessLog={accessLog} loading={loading} />
    </div>
  );
}

// ------------------------------------------------------------------------------------ one card

function MetricCard({
  label,
  value,
  subtitle,
  valueClass,
  status,
  loading,
  info,
  ariaLabel,
  onPick,
  actionLabel
}: {
  label: string;
  value: number | undefined;
  subtitle: string;
  valueClass: string;
  status: MetricStatus;
  loading: boolean;
  info: InfoPopoverContent;
  ariaLabel: string;
  onPick: () => void;
  actionLabel: string;
}): JSX.Element {
  /*
    Dead clicks are suppressed, matching `StatTile`: filtering by a count that could not be read, or
    by one that is zero, lands the operator on an empty table and blames them for the click. The card
    keeps its chrome either way, so the row does not change shape between clusters.
  */
  const live = !loading && status.state !== 'unavailable' && (value ?? 0) > 0;

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</span>
        {/* Inside the card's own button on purpose. `InfoPopover` renders a `<span role="button">`
            and stops pointerdown as well as click, which is what keeps a nested native button out of
            the markup and the filter from firing when the explanation is opened. */}
        <InfoPopover content={info} ariaLabel={ariaLabel} />
      </div>

      <div className="mt-1.5 flex items-baseline gap-2">
        {loading ? (
          // The label, the subtitle and the card's box stay on screen; only the digits are pending.
          // A skeleton over the whole card would take the page's structure away while it loaded.
          <span className="skeleton block h-[28px] w-[72px]" aria-hidden="true" />
        ) : (
          <MetricValue
            status={status}
            size="lg"
            className={`mono text-[22px] font-semibold leading-7 ${valueClass}`}
          >
            {(value ?? 0).toLocaleString()}
          </MetricValue>
        )}
      </div>

      <div className="mt-1 text-[12px] leading-tight text-muted">{subtitle}</div>
      <div className="mt-0.5 text-[11px] leading-tight text-muted/70">{WINDOW_NOTE}</div>
    </>
  );

  const box = 'h-full rounded-[8px] border border-line bg-surface p-4 text-left';

  if (!live) {
    return (
      <div className={box} aria-busy={loading || undefined}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onPick}
      title={actionLabel}
      aria-label={`${label}: ${actionLabel}`}
      className={`${box} transition-colors hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      {body}
    </button>
  );
}

// ------------------------------------------------------------------- the subordinate status strip

/**
 * Access logging, as system status rather than as a metric.
 *
 * Three things are said and kept apart, because on the reference cluster the first one alone is
 * misleading: the state ("Enabled"), whether the log reaches *this* tab, and which provider decided
 * it. A mesh pointed at an OTLP collector is `state: 'on'` and invisible here, and an operator who
 * reads a green "Enabled" above an empty table concludes there were no failures.
 *
 * `accessLog.why` is printed verbatim rather than paraphrased: it names the Telemetry CR and the
 * mesh-config key that decided the verdict, which is what makes the claim checkable.
 */
function AccessLogStrip({
  accessLog,
  loading
}: {
  accessLog: AccessLogVerdict | undefined;
  loading: boolean;
}): JSX.Element {
  const view = accessLogView(accessLog);

  return (
    <div className="rounded-[8px] border border-line bg-raised/50 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Access logging</span>

        {loading ? (
          <span className="skeleton block h-[14px] w-[90px]" aria-hidden="true" />
        ) : (
          // A dot and a word, never the colour alone — and a dot rather than a `Pill`, which would
          // give this the same visual weight as the four cards above it.
          <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${TONE_TEXT[view.tone]}`}>
            <Dot tone={view.tone} />
            {view.word}
          </span>
        )}

        <span className="text-[12px] text-muted">Istio proxy access logs</span>

        {!loading &&
          (accessLog?.providerDetail ?? []).map(p => (
            <span
              key={p.name}
              className="inline-flex items-center gap-1.5 rounded-[5px] border border-line bg-surface px-1.5 py-px"
              // The provider's kind decides whether this tab can read it, and the sentence for each
              // kind is already written once in `access-log.ts`.
              title={`${p.name} — ${PROVIDER_KIND_WHY[p.kind] ?? `kind ${p.kind}`}${p.destination ? ` Destination: ${p.destination}.` : ''}`}
            >
              <Dot tone={p.readable === true ? 'ok' : p.readable === false ? 'warn' : 'unknown'} />
              <span className="mono text-[11px] text-muted">{p.name}</span>
            </span>
          ))}

        {!loading &&
          (accessLog?.unresolvedProviders ?? []).map(name => (
            <span
              key={`unresolved:${name}`}
              className="inline-flex items-center gap-1.5 rounded-[5px] border border-warn/40 bg-warn/5 px-1.5 py-px"
              title={`${name} — ${PROVIDER_KIND_WHY.unresolved}`}
            >
              <Dot tone="warn" />
              <span className="mono text-[11px] text-warn">{name}</span>
            </span>
          ))}

        <span className="ml-auto">
          <InfoPopover
            content={{
              title: 'Access logging',
              means:
                'Whether Envoy writes an access log for this mesh, and whether the log lands somewhere this tab can read. Both halves matter: a mesh can log everything and still show nothing here.',
              source:
                'The Telemetry custom resources, resolved against the Istio mesh ConfigMap to find what each named provider actually writes to.',
              limitations: [
                'A provider that streams to an OTLP or gRPC collector records the requests somewhere this tab cannot follow, so every count above it reads as unavailable rather than as zero.',
                'This is the mesh’s configuration, not a measurement. It says what should be written, not that any particular request was.'
              ],
              sources: ['accessLog', 'telemetryApi']
            }}
            ariaLabel="Explain access logging"
          />
        </span>
      </div>

      {/* The collector's own sentence, in full. It is the part that names the object which decided
          the verdict, so it is not folded into a tooltip. */}
      {!loading && <p className="mt-1 max-w-[110ch] text-[12px] leading-snug text-muted">{view.why}</p>}

      {!loading && accessLog?.meshUnavailable && (
        <p className="mt-1 text-[12px] text-warn">
          The Istio mesh ConfigMap could not be read, so no provider name above could be resolved to what it
          writes to.
        </p>
      )}
    </div>
  );
}
