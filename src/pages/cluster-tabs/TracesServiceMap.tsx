/**
 * Distributed Traces → **Service map**: who called whom in the window read, with call volume,
 * failure share and latency on every arrow.
 *
 * Built on the server from every parsed access-log line rather than from stitched journeys, because
 * the edge an operator opens this for — a service's call to its database — is a TCP line with no
 * correlation header, which stitching drops. Each call is counted once, from whichever proxy saw
 * more of it (`observedBy`). Callers outside the cluster are one "Outside the cluster" node: a client
 * address names a person's network, and no question on this screen needs it.
 *
 * Read-only: nodes and edges only select; nothing here changes the cluster.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ServiceMapEdge, ServiceMapNode, TracesData } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { FilterSelect } from '../../components/filters';
import { Section } from '../../components/layout';
import { Empty } from '../../components/ui';
import { StatTile, type MetricStatus } from '../../components/unavailable';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { ago } from '../../format';
import {
  mapHeadline,
  rateTone,
  TONE_TEXT,
  codeBreakdown,
  edgeId,
  edgeTone,
  edgeWidth,
  edgesOf,
  fitName,
  layoutServiceMap,
  NODE_H,
  NODE_W,
  nodeKindLabel,
  p95Text,
  pct,
  type EdgeTone
} from './service-map-layout';
import { edgeJourneys, edgesForTrace, failingNodes, matchesServiceMapOutcome, type ServiceMapOutcome } from './service-map-drill';
import { ms } from './traces-view';
import { destinationLabel, destinationProvenance } from './destination-label';

const PAD = 16;
/**
 * The map scales down to its pane, to no less than this: 3/4 of its size, so a three-column map
 * (3 x 208 + 2 x 184 + 2 x 16 = 1024 units) fits the 810px pane at 1100 and its 11px text renders
 * at no less than 8.25px. A wider map (four columns is 1416 units) scrolls sideways in its box
 * instead: fitting it would put the text near 6px.
 */
const MIN_SCALE = 3 / 4;

const EDGE_STROKE: Record<EdgeTone, string> = {
  neutral: 'var(--graph-unknown-stroke)',
  warn: 'var(--graph-warn-stroke)',
  bad: 'var(--graph-bad-stroke)'
};

function nodeStyle(n: ServiceMapNode): { fill: string; stroke: string } {
  switch (n.kind) {
    case 'gateway':
    case 'workload':
      return { fill: 'var(--graph-accent-fill)', stroke: 'var(--graph-accent-stroke)' };
    default:
      return { fill: 'var(--graph-unknown-fill)', stroke: 'var(--graph-unknown-stroke)' };
  }
}

/** A node's tooltip: its kind and address, then the object that named it, when one did. */
function nodeTitle(n: ServiceMapNode): string {
  return `${nodeKindLabel(n)}\n${n.namespace ? `${n.namespace}/` : ''}${n.name}${n.destination ? `\n${destinationProvenance(n.destination)}` : ''}`;
}

const OBSERVED_BY: Record<ServiceMapEdge['observedBy'], string> = {
  both: 'Both proxies logged this call; the counts are from the side that saw more.',
  caller: 'Only the caller’s proxy logged it — the callee has no sidecar, or was not read.',
  callee: 'Only the callee’s proxy logged it — the caller is outside the mesh, or was not read.'
};

/**
 * The map's headline: who is in it, how much moved, what failed (the tile that filters the Calls
 * table and dims the healthy arrows), the slowest call and how many destinations leave the cluster.
 */
export function MapTiles({
  payload,
  status,
  outcome,
  onOutcome
}: {
  payload: TracesData | undefined;
  status: MetricStatus;
  outcome: ServiceMapOutcome;
  onOutcome: (outcome: ServiceMapOutcome) => void;
}): JSX.Element {
  const nodes = payload?.serviceMap?.nodes ?? [];
  const h = mapHeadline(nodes, payload?.serviceMap?.edges ?? []);
  const labelOf = (id: string) => {
    const n = nodes.find(x => x.id === id);
    return n ? destinationLabel(n).primary : id;
  };
  const name = (id: string) => fitName(labelOf(id), 22);
  return (
    <>
      <StatTile label="Workloads" status={status} value={<span className="mono">{h.workloads}</span>} caption="gateways and workloads in a call" />
      <StatTile label="Calls" status={status} value={<span className="mono">{h.calls.toLocaleString('en-US')}</span>} caption={`over ${payload?.serviceMap?.edges.length ?? 0} arrows`} />
      <StatTile
        label="Failing calls"
        status={status}
        value={<span className="mono">{h.failedCalls.toLocaleString('en-US')}</span>}
        valueClass={h.failingEdges > 0 ? 'text-bad' : h.failedCalls > 0 ? 'text-warn' : 'text-text'}
        caption={outcome === 'failing' ? 'only these shown · press for all' : `${h.failingEdges} arrow${h.failingEdges === 1 ? '' : 's'} at 5% or more`}
        onClick={() => onOutcome(outcome === 'failing' ? 'all' : 'failing')}
        actionLabel={outcome === 'failing' ? 'Show every call' : 'Show only failing calls'}
      />
      <StatTile
        label={h.slowest?.which === 'p50' ? 'Slowest call p50' : 'Slowest call p95'}
        status={status}
        value={<span className="mono">{h.slowest ? ms(h.slowest.ms) : '—'}</span>}
        caption={
          h.slowest ? (
            <span className="mono" title={`${labelOf(h.slowest.edge.from)} → ${labelOf(h.slowest.edge.to)}`}>
              into {name(h.slowest.edge.to)}
            </span>
          ) : (
            'no duration recorded'
          )
        }
      />
    </>
  );
}

export function TracesServiceMap({
  payload,
  noEvidence,
  windowLine,
  outcome,
  onOutcome,
  pickRequest,
  requestTraceId,
  onOpenJourney
}: {
  payload: TracesData | undefined;
  noEvidence: boolean;
  windowLine: string;
  outcome: ServiceMapOutcome;
  onOutcome: (outcome: ServiceMapOutcome) => void;
  /** A Problems row asks for its arrow. `n` counts presses, so asking twice for one arrow re-picks it. */
  pickRequest?: { id: string; n: number } | null;
  /** A request panel opened the map: select its matching service call when evidence carries one. */
  requestTraceId?: string | null;
  /** A journey listed on an arrow's panel; opens it in the Journeys table. */
  onOpenJourney?: (traceId: string) => void;
}): JSX.Element {
  const map = payload?.serviceMap;
  const nodes = map?.nodes ?? [];
  const edges = map?.edges ?? [];
  const [focus, setFocus] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (pickRequest) setPicked(pickRequest.id);
  }, [pickRequest]);

  useEffect(() => {
    const [matching] = edgesForTrace(requestTraceId, edges);
    if (matching) setPicked(matching);
  }, [requestTraceId, edges]);

  const failing = useMemo(() => (map ? failingNodes(map) : new Set<string>()), [map]);
  const visibleEdges = useMemo(() => edges.filter(e => matchesServiceMapOutcome(e, outcome)), [edges, outcome]);
  const visibleNodeIds = useMemo(() => new Set(visibleEdges.flatMap(e => [e.from, e.to])), [visibleEdges]);
  // readonly: this memoised array feeds the layout and the picker, so an in-place sort would mutate a value they share; tsc refuses one.
  const visibleNodes = useMemo<readonly ServiceMapNode[]>(() => nodes.filter(n => visibleNodeIds.has(n.id)), [nodes, visibleNodeIds]);
  const focused = focus && visibleNodeIds.has(focus) ? focus : null;
  const displayedEdges = useMemo(() => focused ? visibleEdges.filter(e => e.from === focused || e.to === focused) : visibleEdges, [visibleEdges, focused]);
  const displayedNodeIds = useMemo(() => new Set(displayedEdges.flatMap(e => [e.from, e.to])), [displayedEdges]);
  const displayedNodes = useMemo(() => visibleNodes.filter(n => displayedNodeIds.has(n.id)), [visibleNodes, displayedNodeIds]);

  const { placed, drawn, extent } = useMemo(() => layoutServiceMap(displayedNodes, displayedEdges, ms), [displayedNodes, displayedEdges]);
  const viewW = extent.width + PAD * 2;
  const viewH = extent.height + PAD * 2;
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const maxCalls = displayedEdges.reduce((m, e) => Math.max(m, e.calls), 0);
  const rows = useMemo(() => edgesOf(displayedEdges, null), [displayedEdges]);
  const active = displayedEdges.find(e => edgeId(e) === picked) ?? null;
  const mapOptions = useMemo(
    () => [{ value: '', label: 'All services' }, ...[...visibleNodes].sort((a, b) => destinationLabel(a).primary.localeCompare(destinationLabel(b).primary)).map(n => ({ value: n.id, label: `${destinationLabel(n).primary} (${nodeKindLabel(n)})` }))],
    [visibleNodes]
  );
  const nameOf = (id: string) => {
    const n = byId.get(id);
    return n ? destinationLabel(n).primary : id;
  };
  const more = map && map.edgesFound > edges.length ? map.edgesFound - edges.length : 0;

  const end = (id: string) => {
    const n = byId.get(id);
    const l = n ? destinationLabel(n) : null;
    return (
      <span className="block min-w-0 truncate" title={n ? nodeTitle(n).replace('\n', ' ') : id}>
        <span className="mono text-[12px]">{fitName(l?.primary ?? id, 25)}</span>
        {l?.secondary && <span className="mono block truncate text-[11px] text-muted">{l.secondary}</span>}
      </span>
    );
  };

  const columns: Column<ServiceMapEdge>[] = [
    { key: 'from', header: 'From', pin: true, priority: 1, max: '210px', render: e => end(e.from) },
    { key: 'to', header: 'To', priority: 1, max: '220px', render: e => end(e.to) },
    {
      key: 'calls',
      header: 'Calls',
      ...NUMERIC,
      priority: 1,
      width: '80px',
      sortValue: e => e.calls,
      render: e => <span className="mono text-[13px]">{e.calls.toLocaleString('en-US')}</span>
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
        <span className={`mono text-[13px] ${TONE_TEXT[rateTone(e.errorRate)]}`} title={`${e.protocol === 'tcp' ? 'A TCP line fails only when Envoy set a response flag (UF, UH, UT…).' : 'Lines answered 4xx, 5xx or with no response.'} Red from 5%.`}>
          {pct(e.errorRate)}
        </span>
      )
    },
    { key: 'p50', header: 'p50', ...NUMERIC, priority: 2, width: '70px', sortValue: e => e.p50Ms ?? -1, render: e => <span className="mono text-[13px]">{ms(e.p50Ms)}</span> },
    {
      key: 'p95',
      header: 'p95',
      ...NUMERIC,
      priority: 1,
      width: '70px',
      sortValue: e => e.p95Ms ?? -1,
      render: e => (
        <span className={`mono text-[13px] ${e.p95Ms === null ? 'text-muted' : ''}`} title={e.p95Ms === null ? `Only ${e.samples} timed call${e.samples === 1 ? '' : 's'} — a 95th percentile needs 20.` : 'Duration Envoy logged for the call, 95th percentile.'}>
          {p95Text(e.p95Ms, e.samples, ms)}
        </span>
      )
    },
    {
      key: 'protocol',
      header: 'Protocol',
      priority: 2,
      width: '92px',
      render: e => (
        <span className="mono text-[13px]" title={e.protocol === 'tcp' ? 'Envoy logged no HTTP method: TCP or TLS passthrough, for example a database or an HTTPS egress.' : undefined}>
          {e.protocol.toUpperCase()}
        </span>
      )
    },
    {
      key: 'observed',
      header: 'Observed by',
      priority: 3,
      width: '112px',
      render: e => (
        <span className="text-[12px] text-muted" title={OBSERVED_BY[e.observedBy]}>
          {e.observedBy === 'both' ? 'both sides' : `${e.observedBy} only`}
        </span>
      )
    }
  ];

  const empty = (
    <Empty
      title={noEvidence ? 'Nothing came back to map' : outcome === 'healthy' && edges.length ? 'No wholly healthy call in this window' : outcome === 'failing' && edges.length ? 'No call failing at 5% or more' : 'No call between two parties in the window that was read'}
      hint={
        outcome === 'healthy' && edges.length
          ? `${edges.length} call${edges.length === 1 ? '' : 's'} read, but each arrow includes an observed failure. Choose All calls to inspect them.`
          : outcome === 'failing' && edges.length
          ? `${edges.length} call${edges.length === 1 ? '' : 's'} read, none failing. Press the Failing calls tile or Reset to show them.`
          : noEvidence
          ? 'No proxy returned a request line, so no call can be placed — this is not the same as no traffic.'
          : 'Widen the namespace scope or the tail, or show polls: a successful poll is left out of the map as it is out of the journeys.'
      }
    />
  );

  return (
    <div className="space-y-4">
      <Section
        compactHint
        title="Service map"
        label={outcome === 'all' && !focused ? String(edges.length) : `${displayedEdges.length} shown`}
        hint={`Who called whom, from every access-log line read — TCP connections with no trace header included. ${windowLine}. Each call is counted once, from the proxy that saw more of it. A proxy that was not read adds no arrow. Press a node to keep only its calls; press an arrow for its numbers.${more ? ` The ${more} quietest calls are not drawn.` : ''}`}
        action={<div className="flex flex-wrap items-center justify-end gap-2"><FilterSelect label="Service map" value={focused ?? ''} onChange={setFocus} options={mapOptions} /><div role="group" aria-label="Filter service calls" className="flex overflow-hidden rounded-[6px] border border-line">{(['all', 'healthy', 'failing'] as const).map(mode => <button key={mode} type="button" aria-pressed={outcome === mode} onClick={() => onOutcome(mode)} className={`px-2 py-1 text-[12px] ${outcome === mode ? 'bg-raised text-text' : 'text-muted hover:text-text'}`}>{mode === 'all' ? 'All calls' : mode === 'healthy' ? 'Healthy only' : 'Failing only'}</button>)}</div></div>}
      >
        {displayedEdges.length === 0 ? (
          empty
        ) : (
          <div className="overflow-x-auto overflow-y-hidden rounded-[8px] border border-line bg-surface">
            <svg
              viewBox={`${extent.x - PAD} ${extent.y - PAD} ${viewW} ${viewH}`}
              preserveAspectRatio="xMidYMid meet"
              style={{ width: '100%', height: 'auto', aspectRatio: `${viewW} / ${viewH}`, maxWidth: viewW, minWidth: Math.round(viewW * MIN_SCALE) }}
              role="img"
              aria-label={`Service map: ${displayedNodes.length} parties, ${displayedEdges.length} calls, ${outcome}`}
              className="block"
            >
              <defs>
                {(['neutral', 'warn', 'bad'] as const).map(t => (
                  <marker key={t} id={`sm-arrow-${t}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: EDGE_STROKE[t] }} />
                  </marker>
                ))}
              </defs>
              {drawn.map(d => {
                const tone = edgeTone(d.edge);
                const isActive = picked === d.id;
                const box = d.labelBox;
                return (
                  <g key={d.id} style={{ cursor: 'pointer' }} onClick={() => setPicked(isActive ? null : d.id)}>
                    <title>{`${nameOf(d.edge.from)} → ${nameOf(d.edge.to)}\n${d.edge.calls} calls, ${d.edge.errors} failed (${pct(d.edge.errorRate)})\np50 ${ms(d.edge.p50Ms)}, p95 ${p95Text(d.edge.p95Ms, d.edge.samples, ms)}\n${d.edge.protocol.toUpperCase()}, ${OBSERVED_BY[d.edge.observedBy]}`}</title>
                    <path d={d.d} stroke="transparent" strokeWidth={14} fill="none" />
                    <path
                      d={d.d}
                      fill="none"
                      style={{ stroke: isActive ? 'var(--graph-selected-stroke)' : EDGE_STROKE[tone] }}
                      strokeWidth={edgeWidth(d.edge.calls, maxCalls) + (isActive ? 1 : 0)}
                      strokeDasharray={d.edge.protocol === 'tcp' ? '5 3' : undefined}
                      markerEnd={`url(#sm-arrow-${tone})`}
                    />
                    <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={4} style={{ fill: 'var(--color-surface)', stroke: EDGE_STROKE[tone] }} strokeWidth={0.75} />
                    <text x={box.x + box.w / 2} y={box.y + box.h / 2 + 4} textAnchor="middle" fontSize={11} fontFamily="ui-monospace, monospace" style={{ fill: tone === 'neutral' ? 'var(--graph-text)' : EDGE_STROKE[tone] }}>
                      {d.label}
                    </text>
                  </g>
                );
              })}
              {placed.map(p => {
                const st = nodeStyle(p.node);
                const isFocus = focused === p.node.id;
                return (
                  <g
                    key={p.node.id}
                    transform={`translate(${p.x},${p.y})`}
                    opacity={1}
                    tabIndex={0}
                    role="button"
                    aria-pressed={isFocus}
                    aria-label={`${nodeKindLabel(p.node)} ${destinationLabel(p.node).primary}${p.node.destination ? ` at ${p.node.name}` : ''}${p.node.namespace ? ` in ${p.node.namespace}` : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setFocus(isFocus ? null : p.node.id)}
                    onKeyDown={ev => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        setFocus(isFocus ? null : p.node.id);
                      }
                    }}
                  >
                    <title>{nodeTitle(p.node)}</title>
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={7}
                      style={{ fill: st.fill, stroke: isFocus ? 'var(--graph-selected-stroke)' : failing.has(p.node.id) ? EDGE_STROKE.bad : st.stroke }}
                      strokeWidth={isFocus ? 2 : failing.has(p.node.id) ? 2 : 1.25}
                      strokeDasharray={p.node.kind === 'external' || p.node.kind === 'clients' || p.node.kind === 'mesh' ? '4 3' : undefined}
                    />
                    <text x={10} y={16} fontSize={11} fontFamily="ui-monospace, monospace" style={{ fill: 'var(--graph-label)' }}>
                      {nodeKindLabel(p.node)}
                    </text>
                    <text x={10} y={32} fontSize={12} fontFamily="ui-monospace, monospace" style={{ fill: 'var(--graph-text)' }}>
                      {fitName(destinationLabel(p.node).primary)}
                    </text>
                    {p.node.destination && (
                      <text x={10} y={45} fontSize={11} fontFamily="ui-monospace, monospace" style={{ fill: 'var(--graph-label)' }}>
                        {fitName(p.node.name, 28)}
                      </text>
                    )}
                    {!p.node.destination && p.node.namespace && (
                      <text x={10} y={45} fontSize={11} fontFamily="ui-monospace, monospace" style={{ fill: 'var(--graph-label)' }}>
                        {fitName(p.node.namespace, 28)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        )}

        {displayedEdges.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-5" style={{ background: EDGE_STROKE.neutral }} /> no failures
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-5" style={{ background: EDGE_STROKE.warn }} /> under 5% failing
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-5" style={{ background: EDGE_STROKE.bad }} /> 5% or more failing
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: EDGE_STROKE.neutral }} /> TCP, no HTTP status
            </span>
            <span>Arrow width follows call volume. Numbers: calls · p95 (p50 below 20 samples) · failure share.</span>
            {focused && (
              <button type="button" onClick={() => setFocus(null)} className="text-accent-bright hover:underline">
                Show every call
              </button>
            )}
          </div>
        )}

        {active && (
          <div className="mt-3 rounded-[8px] border border-line bg-panel/40 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-[13px] font-medium text-text">
                <span className="mono">{nameOf(active.from)}</span> <span className="text-muted">→</span> <span className="mono">{nameOf(active.to)}</span>
              </p>
              <button type="button" onClick={() => setPicked(null)} className="text-[12px] text-muted hover:text-text" aria-label="Close call details">
                Close
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ['Calls', active.calls.toLocaleString('en-US')],
                ['Failures', `${active.errors.toLocaleString('en-US')} · ${pct(active.errorRate)}`],
                ['Latency', `p50 ${ms(active.p50Ms)} · p95 ${p95Text(active.p95Ms, active.samples, ms)}`],
                ['Signal', `${active.protocol.toUpperCase()}${active.lastSeen ? ` · ${ago(active.lastSeen)}` : ''}`]
              ].map(([label, value]) => (
                <div key={label} className="rounded-[6px] border border-line bg-surface px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</p>
                  <p className="mono mt-0.5 truncate text-[12px]" title={value}>{value}</p>
                </div>
              ))}
            </div>
            {codeBreakdown(active) && <p className="mono mt-1 text-[12px] text-muted">{codeBreakdown(active)}</p>}
            <p className="mt-1 text-[12px] text-muted/80">{OBSERVED_BY[active.observedBy]}</p>
            {requestTraceId && active.traceIds?.includes(requestTraceId) && (
              <p className="mt-2 rounded-[6px] border border-accent/30 bg-accent/5 px-2.5 py-2 text-[12px] text-muted">
                This service call matches the request you opened. The match comes from its propagated correlation id.
              </p>
            )}
            {(() => {
              const j = edgeJourneys(active, payload?.traces ?? []);
              if (j.elsewhere === null) return null;
              return (
                <div className="mt-2">
                  <p className="text-[12px] text-muted">Journeys on this arrow{j.elsewhere > 0 ? ` · ${j.elsewhere} more not among the table's journeys` : ''}</p>
                  <ul className="mt-1 divide-y divide-line">
                    {j.openable.map(t => (
                      <li key={t.traceId}>
                        <button type="button" className="mono w-full truncate py-1 text-left text-[12px] hover:underline" onClick={() => onOpenJourney?.(t.traceId)}>
                          {t.finalStatus ?? '—'} {t.method} {t.path}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </div>
        )}
      </Section>

      <Section
        compactHint
        title="Calls"
        label={outcome === 'all' ? String(rows.length) : `${rows.length} ${outcome}`}
        hint={`${focused ? `The calls to and from ${nameOf(focused)}.` : 'Every arrow on the map, busiest first.'}${outcome === 'healthy' ? ' Healthy only means every observed call on an arrow completed without an Envoy failure.' : outcome === 'failing' ? ' Only calls failing at 5% or more; choose All calls to show every arrow.' : ''}`}
      >
        <div className={CARD_TABLE_CLASS}>
          <DataTable
            id="traces.calls"
            shed="mid"
            columns={columns}
            rows={rows}
            rowKey={edgeId}
            selectedKey={picked ?? undefined}
            onSelect={e => setPicked(edgeId(e) === picked ? null : edgeId(e))}
            empty={empty}
          />
        </div>
      </Section>
    </div>
  );
}
