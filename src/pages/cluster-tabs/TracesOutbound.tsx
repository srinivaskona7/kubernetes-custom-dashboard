/**
 * Distributed Traces → **Outbound**: every call a workload's own sidecar logged on its way out,
 * one row per workload and destination, and which request each connection belongs to.
 *
 * A line with a correlator is an **exact** link — it is already a hop of its journey. A TLS
 * passthrough (a database, an IdP, an external API) carries no header, so its link is **inferred**
 * from time: the request its pod was serving when the connection opened. "Crowded" counts the
 * inferred links made while more than one request was in flight, where the named one is only the
 * innermost. Built on the server (srv/fleet/collectors/outbound.js).
 */
import { useEffect, useRef } from 'react';
import type { TraceOutboundRow, TracesData } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { Section } from '../../components/layout';
import { Empty } from '../../components/ui';
import { StatTile, Unavailable, type MetricStatus } from '../../components/unavailable';
import { declaredBy, policyRead } from './egress-view';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { ago } from '../../format';
import { byteText, fromTitle, linkSummary, outboundHeadline } from './outbound-view';
import { destinationLabel, destinationProvenance } from './destination-label';
import { CONNECTION_DURATION_TIP, confidenceOf } from './journey-status';
import { fitName, isFailing, nodeKindLabel, p95Text, pct, rateTone, TONE_TEXT, type EndpointDrill } from './service-map-layout';
import { ms } from './traces-view';

export function OutboundTiles({
  payload,
  status,
  failingOnly,
  onFailing
}: {
  payload: TracesData | undefined;
  status: MetricStatus;
  failingOnly: boolean;
  onFailing: () => void;
}): JSX.Element {
  const h = outboundHeadline(payload?.outbound?.rows ?? []);
  return (
    <>
      <StatTile label="Calling workloads" status={status} value={<span className="mono">{h.workloads}</span>} caption="whose sidecar logged a call out" />
      <StatTile label="Destinations" status={status} value={<span className="mono">{h.destinations}</span>} caption={`${h.external} outside the cluster`} />
      <StatTile label="Connections" status={status} value={<span className="mono">{h.connections.toLocaleString('en-US')}</span>} caption={`${h.headerless} with no trace header`} />
      <StatTile
        label="Failing (≥ 5%)"
        status={status}
        value={<span className="mono">{h.failing}</span>}
        valueClass={h.failing > 0 ? 'text-bad' : 'text-text'}
        caption={failingOnly ? 'only these shown · press for all' : 'workload → destination pairs'}
        onClick={onFailing}
        actionLabel={failingOnly ? 'Show every outbound call' : 'Show only failing outbound calls'}
      />
    </>
  );
}

/** Opens the newest journey a row's connections were linked to. */
function outboundDrill(r: TraceOutboundRow, loaded: ReadonlySet<string>): EndpointDrill | null {
  if (!r.sample) return null;
  return loaded.has(r.sample.traceId) ? { selectId: r.sample.traceId, fetchId: null, search: r.sample.traceId } : { selectId: null, fetchId: r.sample.traceId, search: r.sample.traceId };
}

export function TracesOutbound({
  payload,
  noEvidence,
  windowLine,
  onDrill,
  failingOnly,
  selectedKey = null
}: {
  payload: TracesData | undefined;
  noEvidence: boolean;
  windowLine: string;
  onDrill: (target: EndpointDrill) => void;
  failingOnly: boolean;
  /** The row a Problems press named (`${from}→${to}`); it is selected and scrolled to. */
  selectedKey?: string | null;
}): JSX.Element {
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedKey) tableRef.current?.querySelector('tr[data-selected="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedKey]);
  const block = payload?.outbound;
  const all = block?.rows ?? [];
  const rows = failingOnly ? all.filter(isFailing) : all;
  const loaded = new Set((payload?.traces ?? []).map(t => t.traceId));
  const more = block && block.rowsFound > all.length ? block.rowsFound - all.length : 0;
  // The label NAME_READS gives the list in srv/fleet/destination-names.js.
  const policies = policyRead(payload?.summary);

  const columns: Column<TraceOutboundRow>[] = [
    {
      key: 'from',
      header: 'From',
      pin: true,
      priority: 1,
      max: '180px',
      sortValue: r => r.from.name,
      // The td's own title too: derived, it would be the fitted name over the cell padding.
      title: r => fromTitle(r),
      render: r => (
        <span className="mono block truncate text-[12px]" title={fromTitle(r)}>
          {fitName(r.from.name, 19)}
        </span>
      )
    },
    {
      key: 'to',
      header: 'To',
      priority: 1,
      max: '200px',
      sortValue: r => destinationLabel(r.to).primary,
      render: r => {
        const l = destinationLabel(r.to);
        // Which object declares the address. A named one says so in the tooltip; an unnamed
        // external one gets its own line, because "undeclared" and "could not tell" differ.
        const v = r.to.kind === 'external' ? declaredBy(r.to, policies) : null;
        return (
          <span
            className="mono block truncate text-[12px]"
            title={`${nodeKindLabel(r.to as Parameters<typeof nodeKindLabel>[0])}: ${r.to.namespace ? `${r.to.namespace}/` : ''}${r.to.name}${v && r.to.destination ? `\nDeclared by ${v.text}` : ''}${r.to.destination ? `\n${destinationProvenance(r.to.destination)}` : ''}`}
          >
            {fitName(l.primary, 23)}
            {l.secondary && <span className="block truncate text-[11px] text-muted">{l.secondary}</span>}
            {v && !r.to.destination && (v.tone === 'unknown'
              ? <span className="block"><Unavailable what="the NetworkPolicy list" why={v.title} size="sm" /></span>
              : <span className={`block truncate font-sans text-[11px] ${v.tone === 'partial' ? 'text-warn' : 'text-muted'}`} title={v.title}>{v.text}</span>)}
          </span>
        );
      }
    },
    {
      key: 'declared',
      header: 'Declaration',
      priority: 3,
      width: '135px',
      max: '135px',
      sortValue: r => confidenceOf(r.to.destination),
      render: r => {
        const c = confidenceOf(r.to.destination);
        const title = r.to.destination
          ? r.to.destination.policyName ?? r.to.destination.objects[0] ?? undefined
          : 'The dashboard found no NetworkPolicy declaring this address. That does not mean it was blocked.';
        return (
          <span className={`text-[12px] ${c === 'explicit' ? 'text-text' : 'text-muted'}`} title={title}>
            {c === 'explicit' ? 'Explicit' : c === 'inferred' ? 'Inferred' : 'Undeclared'}
          </span>
        );
      }
    },
    {
      key: 'policy',
      header: 'Policy',
      priority: 3,
      width: '140px',
      max: '140px',
      sortValue: r => r.to.destination?.policyName ?? '',
      render: r => <span className="mono block truncate text-[12px] text-muted">{r.to.destination?.policyName ?? '—'}</span>
    },
    {
      key: 'connections',
      header: 'Connections',
      ...NUMERIC,
      priority: 1,
      width: '104px',
      sortValue: r => r.connections,
      render: r => (
        <span className="mono text-[13px]" title={r.protocol === 'tcp' ? 'TCP or TLS passthrough: Envoy logged the connection, not the requests inside it.' : 'HTTP calls through the sidecar.'}>
          {r.connections.toLocaleString('en-US')}
          {r.protocol !== 'http' && <span className="text-[11px] text-muted"> {r.protocol}</span>}
        </span>
      )
    },
    {
      key: 'rate',
      header: 'Error rate',
      ...NUMERIC,
      priority: 1,
      width: '96px',
      sortValue: r => r.errorRate ?? -1,
      render: r => (
        <span className={`mono text-[13px] ${TONE_TEXT[rateTone(r.errorRate)]}`} title={`${r.errors} failed. A TCP line fails only when Envoy set a response flag (UF, UH, UT…). Red from 5%.`}>
          {pct(r.errorRate)}
        </span>
      )
    },
    {
      key: 'p50',
      header: 'p50',
      info: CONNECTION_DURATION_TIP,
      ...NUMERIC,
      priority: 2,
      width: '76px',
      sortValue: r => r.p50Ms ?? -1,
      render: r => (
        <span
          className="mono text-[13px]"
          title={`${r.protocol === 'tcp' ? CONNECTION_DURATION_TIP : 'Duration Envoy logged for the call.'} p95 ${p95Text(r.p95Ms, r.samples, ms)}.`}
        >
          {ms(r.p50Ms)}
        </span>
      )
    },
    {
      key: 'bytes',
      header: 'Bytes out / in',
      ...NUMERIC,
      priority: 3,
      width: '140px',
      sortValue: r => r.bytesSent ?? -1,
      render: r => (
        <span className="mono text-[12px]" title={r.bytesUnknown ? `${r.bytesUnknown} line(s) logged no byte count, so these totals are a floor.` : 'Bytes the workload sent / received over these connections.'}>
          {byteText(r.bytesSent)} / {byteText(r.bytesReceived)}
          {r.bytesUnknown > 0 && r.bytesSent !== null ? '+' : ''}
        </span>
      )
    },
    {
      key: 'link',
      header: 'Linked request',
      priority: 1,
      max: '210px',
      render: r => (
        <span className="block truncate text-[12px]" title={`${linkSummary(r)}. Exact: the line carried a trace header. Inferred: the request its pod was serving when the connection opened${r.crowded ? '; crowded means more than one was in flight and the innermost is named' : ''}.`}>
          {r.sample ? (
            <>
              <span className="mono">{r.sample.method ? `${r.sample.method} ` : ''}{fitName((r.sample.path ?? '—').split('?')[0]!, 14)}</span>
              <span className="text-muted"> · {r.sample.link === 'exact' ? 'exact' : r.sample.candidates > 1 ? `inferred, 1 of ${r.sample.candidates}` : 'inferred'}</span>
            </>
          ) : (
            <span className="text-muted">{linkSummary(r)}</span>
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
      sortValue: r => (r.lastSeen ? Date.parse(r.lastSeen) : 0),
      render: r => <span className="text-[12px] text-muted">{r.lastSeen ? ago(r.lastSeen) : '—'}</span>
    }
  ];

  return (
    <Section
      compactHint
      title="Outbound calls"
      label={failingOnly ? `${rows.length} failing` : block ? String(block.rowsFound) : 'not reported'}
      hint={`One row per workload and destination, from the calling workload’s own sidecar; gateways are left out, their onward calls are the journeys. A connection with no trace header is linked by time to the request its pod was serving when it opened — inferred, and a pooled connection is linked only to the request that opened it. ${windowLine}. Press a row to open its linked journey.${more ? ` The ${more} quietest pairs are not listed.` : ''}${block?.unrouted ? ` ${block.unrouted} outbound attempt(s) were answered by the proxy itself and reached no destination.` : ''}`}
    >
      <div ref={tableRef} className={CARD_TABLE_CLASS}>
        <DataTable
          id="traces.outbound"
          shed="wide"
          columns={columns}
          rows={rows}
          rowKey={r => `${r.from.id}→${r.to.id}`}
          selectedKey={selectedKey ?? undefined}
          onSelect={r => {
            const d = outboundDrill(r, loaded);
            if (d) onDrill(d);
          }}
          empty={
            <Empty
              title={
                !block && !noEvidence
                  ? 'This server does not report outbound calls yet'
                  : noEvidence
                    ? 'Nothing came back to list'
                    : failingOnly && all.length
                      ? 'No outbound call failing at 5% or more'
                      : 'No workload called out in the window that was read'
              }
              hint={
                !block && !noEvidence
                  ? 'The srv build behind this console predates the Outbound read. Rebuild srv to see it.'
                  : noEvidence
                    ? 'No proxy returned a request line, so there is nothing to list — this is not the same as no traffic.'
                    : failingOnly && all.length
                      ? `${all.length} pair${all.length === 1 ? '' : 's'} read, none failing. Press the Failing tile or Reset to show them.`
                      : 'A sidecar only logs what passes through it: widen the namespace scope or the tail, or re-read.'
              }
            />
          }
        />
      </div>
    </Section>
  );
}
