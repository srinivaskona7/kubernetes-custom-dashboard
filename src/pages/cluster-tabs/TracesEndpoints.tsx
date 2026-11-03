/**
 * Distributed Traces → **Endpoints**: every journey the Traces filters kept, grouped by method, host
 * and path with identifiers folded, each row naming the workload that served it (`/orders/1041` and `/orders/1042` are one row).
 *
 * The rows are built on the server over every kept journey, not only the 200 the Journeys table
 * holds, so a count here can exceed that table's. A p95 is printed only from 20 samples or more —
 * below that it is one or two requests, and the cell says how many there were instead.
 */
import type { Trace, TracesData, TraceEndpointStat } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { Section } from '../../components/layout';
import { Empty, Pill } from '../../components/ui';
import { StatTile, type MetricStatus } from '../../components/unavailable';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { ago } from '../../format';
import { endpointDrill, endpointHeadline, fitName, isFailing, p95Text, pct, rateTone, TONE_TEXT, type EndpointDrill } from './service-map-layout';
import { ms } from './traces-view';
import { endpointBlock, filteredTitle } from './egress-view';
import { endpointHostName } from './traffic/endpoint-label';

const shortPath = (e: TraceEndpointStat) => `${e.method ? `${e.method} ` : ''}${fitName(e.path ?? '—', 26)}`;

/**
 * The Endpoints headline: how many, how many failing (the tile that filters to them), and which
 * one is worst and slowest (the table is busiest first). Every number rides `status`, so an unread log is "not read".
 */
export function EndpointTiles({
  payload,
  status,
  failingOnly,
  onFailing,
  includeFiltered
}: {
  payload: TracesData | undefined;
  status: MetricStatus;
  failingOnly: boolean;
  onFailing: () => void;
  includeFiltered: boolean;
}): JSX.Element {
  const block = endpointBlock(payload, includeFiltered);
  const h = endpointHeadline(block?.endpoints ?? [], block?.endpointsFound ?? 0);
  const listed = block?.endpoints.length ?? 0;
  return (
    <>
      <StatTile label="Endpoints" status={status} value={<span className="mono">{h.endpoints.toLocaleString('en-US')}</span>} caption={h.endpoints > listed ? `${listed} busiest listed` : 'method, host and path'} />
      <StatTile
        label="Failing (≥ 5%)"
        status={status}
        value={<span className="mono">{h.failing}</span>}
        valueClass={h.failing > 0 ? 'text-bad' : 'text-text'}
        caption={failingOnly ? 'only these shown · press for all' : `of ${listed} listed endpoints`}
        onClick={onFailing}
        actionLabel={failingOnly ? 'Show every endpoint' : 'Show only failing endpoints'}
      />
      <StatTile
        label="Worst error rate"
        status={status}
        value={<span className="mono">{h.worst ? pct(h.worst.errorRate) : '—'}</span>}
        valueClass={h.worst ? 'text-bad' : 'text-text'}
        caption={h.worst ? <span className="mono" title={`${h.worst.method ?? ''} ${h.worst.path ?? ''}`.trim()}>{shortPath(h.worst)}</span> : 'no endpoint at 5% or more'}
      />
      <StatTile
        label={h.slowest?.which === 'p50' ? 'Slowest p50' : 'Slowest p95'}
        status={status}
        value={<span className="mono">{h.slowest ? ms(h.slowest.ms) : '—'}</span>}
        caption={h.slowest ? <span className="mono" title={`${h.slowest.ep.method ?? ''} ${h.slowest.ep.path ?? ''}`.trim()}>{shortPath(h.slowest.ep)}</span> : 'no duration recorded'}
      />
    </>
  );
}

function codeTone(code: number): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (code === 0) return 'unknown';
  if (code >= 500) return 'bad';
  if (code >= 400) return 'warn';
  return 'ok';
}

export function TracesEndpoints({
  payload,
  noEvidence,
  windowLine,
  onDrill,
  failingOnly,
  includeFiltered,
  onIncludeFiltered
}: {
  payload: TracesData | undefined;
  noEvidence: boolean;
  windowLine: string;
  onDrill: (target: EndpointDrill) => void;
  failingOnly: boolean;
  includeFiltered: boolean;
  onIncludeFiltered: (v: boolean) => void;
}): JSX.Element {
  const block = endpointBlock(payload, includeFiltered);
  const filtered = payload?.endpointsFiltered;
  const filteredN = filtered?.journeys ?? 0;
  const all = block?.endpoints ?? [];
  const rows = failingOnly ? all.filter(isFailing) : all;
  const traces: readonly Trace[] = payload?.traces ?? [];
  const more = block && block.endpointsFound > all.length ? block.endpointsFound - all.length : 0;

  const columns: Column<TraceEndpointStat>[] = [
    {
      key: 'endpoint',
      header: 'Endpoint',
      pin: true,
      priority: 1,
      max: '216px',
      render: e => (
        <span className="mono block truncate text-[12px]" title={`${e.method ?? ''} ${e.path ?? ''} — identifiers in the path are folded to {id}`.trim()}>
          {e.method && <span className="text-muted">{e.method} </span>}
          {e.path ?? <span className="text-muted/70">— no path recorded</span>}
        </span>
      )
    },
    {
      key: 'service',
      header: 'Service',
      priority: 1,
      max: '200px',
      sortValue: e => e.service?.name ?? endpointHostName(e).primary ?? '',
      render: e => {
        // A bare-IP host a cluster object names reads as that name, the IP on the line beneath.
        const h = endpointHostName(e);
        return (
          <span
            className={`mono block truncate text-[12px] ${e.service ? '' : 'text-muted'}`}
            title={`${e.service ? `${e.service.kind} ${e.service.namespace}/${e.service.name} served the entry of these journeys.` : 'No workload in this read served the entry — the upstream is outside the cluster, or its pod was not listed.'} Host: ${e.host ?? 'none recorded'}.${h.provenance ? `\n${h.primary}, named ${h.provenance}.` : ''}`}
          >
            {fitName(e.service?.name ?? h.primary ?? '—', 23)}
            {!e.service && h.secondary && <span className="block truncate text-[11px] text-muted">{h.secondary}</span>}
          </span>
        );
      }
    },
    {
      key: 'journeys',
      header: 'Journeys',
      ...NUMERIC,
      priority: 1,
      width: '92px',
      sortValue: e => e.journeys,
      render: e => <span className="mono text-[13px]">{e.journeys.toLocaleString('en-US')}</span>
    },
    {
      key: 'errors',
      header: 'Errors',
      ...NUMERIC,
      priority: 1,
      width: '80px',
      sortValue: e => e.errors,
      render: e => <span className={`mono text-[13px] ${e.errors > 0 ? 'text-bad' : 'text-muted'}`}>{e.errors.toLocaleString('en-US')}</span>
    },
    {
      key: 'rate',
      header: 'Error rate',
      ...NUMERIC,
      priority: 1,
      width: '96px',
      sortValue: e => e.errorRate ?? -1,
      render: e => (
        <span className={`mono text-[13px] ${TONE_TEXT[rateTone(e.errorRate)]}`} title="Journeys with a 4xx, 5xx or unanswered connection on any hop, over this endpoint's journeys. Red from 5%.">
          {pct(e.errorRate)}
        </span>
      )
    },
    {
      key: 'p50',
      header: 'p50',
      ...NUMERIC,
      priority: 2,
      width: '70px',
      sortValue: e => e.p50Ms ?? -1,
      render: e => <span className="mono text-[13px]">{ms(e.p50Ms)}</span>
    },
    {
      key: 'p95',
      header: 'p95',
      ...NUMERIC,
      priority: 1,
      width: '70px',
      sortValue: e => e.p95Ms ?? -1,
      render: e => (
        <span
          className={`mono text-[13px] ${e.p95Ms === null ? 'text-muted' : ''}`}
          title={e.p95Ms === null ? `Only ${e.samples} journey${e.samples === 1 ? '' : 's'} with a duration — a 95th percentile needs 20.` : 'Edge duration, 95th percentile over this endpoint’s journeys.'}
        >
          {p95Text(e.p95Ms, e.samples, ms)}
        </span>
      )
    },
    {
      key: 'codes',
      header: 'Status codes',
      priority: 2,
      max: '150px',
      render: e => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {e.codes.length === 0 ? (
            <span className="text-muted">—</span>
          ) : (
            <>
              {/* One pill keeps the row one line high; the rest are counted, and all are in the title. */}
              <span title={e.codes.map(c => `${c.code === 0 ? 'no response' : c.code} ×${c.count}`).join(', ')}>
                <Pill tone={codeTone(e.codes[0]!.code)}>
                  {e.codes[0]!.code === 0 ? 'none' : e.codes[0]!.code} <span className="mono tabular-nums">×{e.codes[0]!.count}</span>
                </Pill>
              </span>
              {e.codes.length > 1 && <span className="text-[11px] text-muted">+{e.codes.length - 1}</span>}
            </>
          )}
        </span>
      )
    },
    {
      key: 'lastSeen',
      header: 'Last seen',
      ...NUMERIC,
      priority: 3,
      width: '100px',
      sortValue: e => (e.lastSeen ? Date.parse(e.lastSeen) : 0),
      render: e => (
        <span className="text-[12px] text-muted" title={e.lastSeen ?? 'No start stamp was recorded.'}>
          {e.lastSeen ? ago(e.lastSeen) : '—'}
        </span>
      )
    }
  ];

  return (
    <Section
      compactHint
      title="Endpoints"
      label={failingOnly ? `${rows.length} failing` : String(block?.endpointsFound ?? 0)}
      hint={`One row per method, host and path, identifiers folded to {id}; Service is the workload that served the entry, with its host on hover. Built from every kept journey, not only the ${traces.length} the Journeys table holds. ${windowLine}. Press a row to open its newest journey.${filtered ? (includeFiltered ? ' Probes, policy refusals and direct-IP dials are included.' : ' Probes, policy refusals and direct-IP dials are left out, so p50 and p95 are app latency.') : ''}${more ? ` The ${more} quietest endpoints are not listed.` : ''}`}
      action={
        filtered && filteredN > 0 ? (
          <button
            type="button"
            onClick={() => onIncludeFiltered(!includeFiltered)}
            aria-pressed={includeFiltered}
            title={filteredTitle(filtered.byClass)}
            className="whitespace-nowrap text-[12px] text-muted underline-offset-2 hover:text-text hover:underline"
          >
            {includeFiltered ? `Hide ${filteredN.toLocaleString('en-US')} filtered` : `Include ${filteredN.toLocaleString('en-US')} filtered`}
          </button>
        ) : undefined
      }
    >
      <div className={CARD_TABLE_CLASS}>
        <DataTable
          id="traces.endpoints"
          shed="mid"
          columns={columns}
          rows={rows}
          rowKey={e => `${e.method ?? '-'} ${e.host ?? '-'} ${e.path ?? '-'}`}
          onSelect={e => onDrill(endpointDrill(e, traces))}
          empty={
            <Empty
              title={noEvidence ? 'Nothing came back to group' : failingOnly && all.length ? 'No endpoint failing at 5% or more' : 'No endpoint in the window that was read'}
              hint={
                failingOnly && all.length
                  ? `${all.length} endpoint${all.length === 1 ? '' : 's'} read, none failing. Press the Failing tile or Reset to show them.`
                  : noEvidence
                  ? 'No proxy returned a request line, so there is nothing to count — this is not the same as no traffic.'
                  : filteredN > 0 && !includeFiltered
                    ? `${filteredN.toLocaleString('en-US')} journeys were filtered as noise: refusals, probes or direct-IP. Press Include ${filteredN.toLocaleString('en-US')} filtered to list them.`
                  : (payload?.summary.journeysSeen ?? 0) > 0
                    ? 'Every journey read was a successful poll or outside the scope. Show polls, or widen the namespace scope.'
                    : 'Widen the tail, or re-read: a log window moves.'
              }
            />
          }
        />
      </div>
    </Section>
  );
}
