/**
 * Ingress & Traffic → Hosts & Routes.
 *
 * Ordered broken joins first, then failing, then busy, then idle (`sortHosts`): a host whose DNSEntry,
 * Gateway server, certificate or route is missing is the finding, whatever its volume. The Chain
 * column is that join, link by link (`chainLinks`), and a bare-IP host shows the destination name the
 * server resolved for it.
 *
 * One row per Host header the edge actually saw, grouped against the objects in the cluster that
 * claim to publish it. The pairing is the point: an access log knows what was *asked for* and a
 * Gateway knows what is *offered*, and the interesting rows are where the two disagree — a host being
 * hit that nothing declares, a configured domain with no Gateway admitting it.
 *
 * ## The filter is derived, not declared
 *
 * The chips come from `hostFilterChips`, which counts the rows in hand. A bucket with no rows gets no
 * chip, because a control that lands an operator on an empty table and blames them for it is worse
 * than no control. Nothing here names a company or a cluster domain: `corporate` means "matched a
 * suffix configured in FLEET_CORPORATE_DOMAIN_SUFFIXES", so with none set that chip simply does not
 * appear — which is a different fact from it appearing empty.
 *
 * ## Why "no Host header" is a row rather than a filtered-out line
 *
 * 318 of 1485 records in a live window carried no authority at all: every TCP connection, and every
 * TLS connection Envoy rejected before it parsed a request line. Dropping them would make the counts
 * on this screen disagree with the counts on Ingress Overview for no reason an operator could see, and
 * it is where the largest single failure bucket on the cluster lives.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { IngressHost, TrafficIngress } from '../../../api';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { COLUMN_INFO } from '../../../components/table/column-info';
import { DetailPanel, Field } from '../../../components/layout';
import { SearchBox } from '../../../components/filters';
import { CellList, Dot, Empty, Pill } from '../../../components/ui';
import { ago } from '../../../format';
import { Bytes, GroupPill, HostCell, IngressCard, IngressGap, Latency, Num, RouteRefs, Share } from './parts';
import {
  GROUP_LABEL,
  GROUP_WHY,
  hostFilterChips,
  hostTone,
  hostWhy,
  exactTimestamp,
  ingressWasRead,
  matchesHostFilter,
  share,
  type HostFilter
} from './shared';
import {
  EDGE_CLASS_LABEL,
  EDGE_CLASS_TONE,
  EDGE_CLASS_WHY,
  chainLinks,
  classFilterChips,
  hostsAreClassified,
  joinGaps,
  matchesClassFilter,
  sortHosts,
  type ClassFilter
} from './edge-view';
import { hostFocus } from './problem-landing';
import type { IngressTarget } from '../problems';

export function IngressHosts({
  ingress,
  before,
  after,
  focus,
  otherPanelOpen = false,
  onPanelOpen
}: {
  ingress: TrafficIngress | undefined;
  /** First in the scroll column: the sub-tab's Problems strip. */
  before?: ReactNode;
  /** Last in the scroll column: TLS & Listeners, merged into Hosts & TLS. */
  after?: ReactNode;
  /** The tab opened its own panel (Proxies read); this one closes, so one panel shows at a time. */
  otherPanelOpen?: boolean;
  /** Called when a row opens this screen's panel, so the tab can close its own. */
  onPanelOpen?: () => void;
  /** A Problems press naming a host. A new object each press, so pressing it again lands again. */
  focus?: Pick<IngressTarget, 'host'> | null;
}): JSX.Element {
  const [filter, setFilter] = useState<HostFilter>('all');
  const [klass, setKlass] = useState<ClassFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const all = ingress?.hosts ?? [];
  // A server that classifies the edge gets class chips; an older one keeps the host-group chips.
  const classified = hostsAreClassified(all);
  const chips = useMemo(
    () =>
      classified
        ? classFilterChips(all).map(c => ({ ...c, active: c.id === klass, why: c.id === 'all' ? 'Every host the gateway recorded.' : EDGE_CLASS_WHY[c.id], pick: () => setKlass(c.id) }))
        : hostFilterChips(all).map(c => ({
            ...c,
            active: c.id === filter,
            why: c.id === 'all' ? 'Every host the gateway recorded, including the no-Host-header bucket.' : GROUP_WHY[c.id],
            pick: () => setFilter(c.id)
          })),
    [all, classified, filter, klass]
  );
  const rows = useMemo(
    () => sortHosts(all.filter(h => matchesHostFilter(h, classified ? 'all' : filter, search) && (!classified || matchesClassFilter(h, klass)))),
    [all, classified, filter, klass, search]
  );
  const selected = useMemo(() => all.find(h => h.key === selectedKey) ?? null, [all, selectedKey]);

  // Land on the host a Problems row names: its row selected with every filter cleared so it is in
  // view, or a search for it when the capped list does not hold it. Keyed on the press alone, so a
  // re-read does not re-open a panel the operator closed.
  useEffect(() => {
    const f = hostFocus(ingress?.hosts ?? [], focus?.host);
    // A press naming a Certificate or PeerAuthentication lands below: an earlier host row lets go,
    // or its selection would take the scroll and keep its panel over the row just selected.
    if (!f) {
      if (focus) setSelectedKey(null);
      return;
    }
    setFilter('all');
    setKlass('all');
    setSearch(f.search ?? '');
    setSelectedKey(f.selectKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  useEffect(() => {
    if (otherPanelOpen) setSelectedKey(null);
  }, [otherPanelOpen]);

  if (!ingressWasRead(ingress)) {
    return (
      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden overscroll-contain pb-4">
        {before}
        {/* TLS & Listeners states the gap itself, above the Gateway servers it can still list. */}
        {after ?? <IngressGap ingress={ingress} />}
      </div>
    );
  }

  /*
    Nine columns, and they fit a 1090px container at 1440 only because every one of them is narrow —
    see the note on `shed`. Health is not a column: it is the dot inside Host, because a verdict about
    the row's subject is not a tenth fact to scan down and the tenth column is what would clip.

    The budget is exact, not generous: a capped column costs its `max` (padding included) and states
    the same `width`, and a numeric column costs its header (Requests renders 113px whatever its
    `width` says). 1125px at 1440 and 788px at 1100 against a card of 1135px and 795px once a classic
    scrollbar takes its 15px — `test/fleet/ingress-hosts-fit.test.js` holds the arithmetic.
  */
  const columns: Column<IngressHost>[] = [
    {
      key: 'host',
      header: 'Host',
      pin: true,
      priority: 1,
      width: '200px',
      max: '200px',
      sortValue: h => h.host ?? '',
      render: h =>
        h.destination ? (
          <span className="flex min-w-0 flex-col">
            <HostCell host={h} />
            <span className="truncate text-[11px] text-muted" title={`Resolved from ${h.destination.source}: ${h.destination.label}`}>
              {h.destination.display}
            </span>
          </span>
        ) : (
          <HostCell host={h} />
        )
    },
    {
      key: 'class',
      header: 'Class',
      priority: 1,
      width: '180px',
      max: '180px',
      sortValue: h => (h.edgeClass ? EDGE_CLASS_LABEL[h.edgeClass] : GROUP_LABEL[h.group]),
      // The pill may shrink to the cell and ellipsise its word; a pill that cannot shrink is clipped
      // by the cell, which leaves the cell's own ellipsis as a stray dot after it.
      render: h => (
        <span className="flex min-w-0 [&>span]:max-w-full">
          {h.edgeClass ? (
            <Pill tone={EDGE_CLASS_TONE[h.edgeClass]} title={EDGE_CLASS_WHY[h.edgeClass]}>
              <span className="truncate">{EDGE_CLASS_LABEL[h.edgeClass]}</span>
            </Pill>
          ) : (
            <GroupPill host={h} />
          )}
        </span>
      )
    },
    {
      key: 'chain',
      header: 'Chain',
      priority: 2,
      width: '140px',
      max: '140px',
      sortValue: h => joinGaps(h).length,
      render: h => (h.chain ? <ChainCell host={h} /> : <RouteRefs refs={h.servedBy} empty="nothing declares it" />)
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      priority: 1,
      width: '78px',
      sortValue: h => h.requests,
      render: h => (
        <Num
          value={h.requests}
          title={`${h.requests} record${h.requests === 1 ? '' : 's'} for this host in the window that was read — not a rate, and not a total for the cluster.`}
        />
      )
    },
    {
      key: 'client',
      header: '4xx',
      ...NUMERIC,
      priority: 1,
      width: '62px',
      sortValue: h => h.client,
      render: h => (
        <Num
          value={h.client}
          tone="warn"
          title="Rejected by the edge. A 403 from an AuthorizationPolicy and a 404 from a missing route are both cluster configuration; a host whose whole job is turning away unauthenticated callers looks exactly like this and is working."
        />
      )
    },
    {
      key: 'server',
      header: '5xx',
      ...NUMERIC,
      priority: 1,
      width: '62px',
      sortValue: h => h.server,
      render: h => (
        <Num
          value={h.server}
          tone="bad"
          title="The upstream answered with a server error, or Envoy could not reach it. The workload behind the host is the place to look, not the Gateway."
        />
      )
    },
    {
      key: 'share',
      header: 'Error share',
      info: COLUMN_INFO.ingressErrorShare,
      ...NUMERIC,
      priority: 1,
      width: '92px',
      sortValue: h => h.errorShare,
      render: h => <Share value={h.errorShare} tone={hostTone(h) === 'bad' ? 'bad' : hostTone(h) === 'warn' ? 'warn' : undefined} title={hostWhy(h)} />
    },
    {
      key: 'latency',
      header: 'Latency p50 / p95',
      info: COLUMN_INFO.ingressUpstreamLatency,
      ...NUMERIC,
      priority: 2,
      width: '112px',
      sortValue: h => h.upstream.p95Ms,
      render: h => <Latency l={h.upstream} what="upstream_service_time" />
    }
  ];

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-4">
        {before}
        <IngressCard
          title="Hosts seen at the edge"
          label={String(rows.length)}
          hint="One row per Host header the ingress gateway recorded, broken joins first, then failing, busy and idle. Click a row for the chain, the paths, the codes and the proxies behind it."
        >
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface py-2">
            {chips.map(c => {
              const active = c.active;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={c.pick}
                  aria-pressed={active}
                  title={c.why}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] border px-2.5 text-[13px] transition-colors ${
                    active ? 'border-accent bg-accent/10 text-text' : 'border-line text-muted hover:border-line-strong hover:text-text'
                  }`}
                >
                  {c.label}
                  <span className="mono text-[12px] text-muted">{c.count}</span>
                </button>
              );
            })}
            <span className="ml-auto flex min-w-[240px] flex-1 items-center">
              <SearchBox value={search} onChange={setSearch} placeholder="host, Gateway, APIRule, path, code…" />
            </span>
          </div>

          {/*
            `wide` (1300/1000), and the tier is doing one thing: shedding Served by and Latency below a
            1000px container, which is where the drawer puts this table. Nothing is priority 3, because
            wide sheds priority 3 below 1300 and this console's container at a 1440px viewport is about
            1090 — so a priority 3 here would be a column hidden at the default width.
          */}
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={h => h.key}
            shed="wide"
            selectedKey={selectedKey ?? undefined}
            onSelect={h => {
              const open = h.key !== selectedKey;
              setSelectedKey(open ? h.key : null);
              if (open) onPanelOpen?.();
            }}
            empty={
              <Empty
                title={all.length ? 'No host matches this filter' : 'The gateway logged no request line in this window'}
                hint={
                  all.length
                    ? 'Clear the search or pick All hosts.'
                    : 'The ingress gateway was read and returned nothing to group. Widen the window or re-read — a quiet edge and an unreadable log look the same from here.'
                }
              />
            }
          />
          {ingress?.hostsTruncated && (
            <p className="mt-2 text-[12px] text-warn">
              {ingress.hostsTotal} hosts were seen and the {ingress.hosts.length} busiest are listed. The rest are
              absent from this table, not merged into it — the counts above are for the rows shown.
            </p>
          )}
          <p className="mt-3 max-w-[100ch] text-[12px] text-muted">
            The <span className="mono">Chain</span> column is the cluster's own declaration, not a guess: a
            DNSEntry, Gateway server or route is joined only when the object itself lists this host or a wildcard
            covering it. Nothing here is matched on a name looking similar.
          </p>
        </IngressCard>
        {after && <div className="mt-5">{after}</div>}
      </div>

      {selected && (
        <DetailPanel
          title={selected.host ?? 'No Host header'}
          subtitle={selected.edgeClass ? EDGE_CLASS_LABEL[selected.edgeClass] : GROUP_LABEL[selected.group]}
          onClose={() => setSelectedKey(null)}
        >
          <Field
            label="What this class means"
            value={<span className="text-[13px] text-muted">{selected.edgeClass ? EDGE_CLASS_WHY[selected.edgeClass] : GROUP_WHY[selected.group]}</span>}
          />
          {selected.destination && (
            <Field
              label="Destination"
              value={
                <span title={`Resolved from ${selected.destination.source}`}>
                  {selected.destination.display}
                  {selected.destination.qualifier && <span className="text-muted"> ({selected.destination.qualifier})</span>}
                </span>
              }
            />
          )}
          {selected.chain && (
            <Field
              label="Chain"
              value={
                <div className="space-y-1 text-[13px]">
                  {chainLinks(selected).map(l => (
                    <div key={l.step} className="flex items-baseline gap-2">
                      <Dot tone={l.tone} />
                      <span className="w-[84px] shrink-0 text-muted">{l.step}</span>
                      <span className="mono min-w-0 break-words text-[12px]" title={l.why}>
                        {l.text}
                      </span>
                    </div>
                  ))}
                  {joinGaps(selected).length > 0 && (
                    <p className="text-[12px] text-warn">Broken join: {joinGaps(selected).join('; ')}.</p>
                  )}
                </div>
              }
            />
          )}
          {selected.matchedSuffix && <Field label="Matched suffix" value={selected.matchedSuffix} mono />}
          <Field label="Verdict" value={<span className="text-[13px] text-muted">{hostWhy(selected)}</span>} />
          <Field
            label="Admitted by"
            value={
              selected.gateway ? (
                <span title={selected.gateway.evidence}>
                  Gateway {selected.gateway.namespace}/{selected.gateway.name}
                  {selected.gateway.port ? ` :${selected.gateway.port}` : ''}
                  <span className="text-muted"> for {selected.gateway.host}</span>
                </span>
              ) : (
                /*
                  Not an em-dash. A host being served with no Gateway admitting it is one of the two
                  findings this screen exists to surface, and it has to read as a finding.
                */
                <span className="text-warn">
                  no Istio Gateway in this cluster admits this host
                </span>
              )
            }
            mono
          />
          <Field label="Declared by" value={<RouteRefs refs={selected.servedBy} empty="no VirtualService or APIRule declares it" link />} />
          <Field
            label="Sampled records"
            value={
              <span className="mono">
                {selected.requests.toLocaleString()} — {selected.ok} ok, {selected.redirect} redirect, {selected.client} rejected,{' '}
                {selected.server} server error, {selected.noResponse} unanswered ({share(selected.errorShare)} non-2xx)
              </span>
            }
          />
          <Field
            label="Latency"
            value={
              <div className="space-y-0.5 text-[13px]">
                <div className="mono">
                  end to end <Latency l={selected.total} what="duration" /> ms
                </div>
                <div className="mono">
                  upstream <Latency l={selected.upstream} what="upstream_service_time" /> ms
                </div>
                {selected.overheadMs !== null && (
                  <div className="mono text-muted" title="Median of duration − upstream_service_time: this proxy's own work plus the client leg. Computed only over lines that carried both fields.">
                    {selected.overheadMs} ms proxy and client overhead
                  </div>
                )}
              </div>
            }
          />
          <Field label="Methods" value={<CellList items={selected.methods} empty="none recorded" className="mono text-[13px]" />} />
          <Field
            label="Top paths"
            value={
              selected.paths.length ? (
                <div className="mono space-y-0.5 text-[12px]">
                  {selected.paths.map(p => (
                    <div key={p.path} className="flex items-baseline justify-between gap-3">
                      <span className="truncate" title={p.path}>
                        {p.path}
                      </span>
                      <span className="text-muted/70">×{p.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                /*
                  Deliberately not "none": a path is absent from every TCP connection and from every
                  request Envoy rejected before parsing the request line, so an empty list here is
                  usually a statement about what kind of traffic this is.
                */
                <span className="text-muted">no path was recorded on any line for this host</span>
              )
            }
          />
          <Field
            label="Response codes"
            value={
              selected.codes.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {selected.codes.map(c => (
                    <Pill
                      key={c.code}
                      tone={c.class === 'server' ? 'bad' : c.class === 'client' ? 'warn' : c.class === 'no-response' ? 'unknown' : 'ok'}
                      title={`${c.count} record${c.count === 1 ? '' : 's'} — ${c.class}`}
                    >
                      {c.code === 0 ? 'none' : c.code} ×{c.count}
                    </Pill>
                  ))}
                </div>
              ) : (
                <span className="text-muted">no response code recorded</span>
              )
            }
          />
          {selected.flags.length > 0 && (
            <Field
              label="Envoy’s flags"
              value={<CellList items={selected.flags} className="mono text-[13px]" />}
            />
          )}
          {selected.details.length > 0 && (
            <Field
              label="Envoy’s detail"
              // `response_code_details`, verbatim. Rewording it would change what the proxy said, and
              // it is the field that makes NR readable — `filter_chain_not_found` versus `route_not_found`
              // are the same flag and two entirely different problems.
              value={<div className="mono space-y-0.5 text-[12px]">{selected.details.map(d => <div key={d}>{d}</div>)}</div>}
            />
          )}
          <Field
            label="Peers"
            value={
              <span title="The immediate peer address, which behind a corporate load balancer is that load balancer. The originating client would be x-forwarded-for, which this collector deliberately never reads.">
                {selected.clients} distinct, {selected.externalClients} from outside the cluster
              </span>
            }
          />
          <Field
            label="Listeners"
            value={
              <span className="mono text-[13px]">
                {selected.ports.map(p => `${p.port ?? 'not recorded'} ×${p.count}`).join(', ') || 'none recorded'}
                {selected.sni > 0 && <span className="text-muted"> · {selected.sni} SNI value{selected.sni === 1 ? '' : 's'}</span>}
              </span>
            }
          />
          <Field label="Bytes sent" value={<Bytes total={selected.bytesSent} />} />
          <Field label="Bytes received" value={<Bytes total={selected.bytesReceived} />} />
          <Field label="Reported by" value={<CellList items={selected.proxies} className="mono text-[13px]" />} />
          <Field
            label="Seen"
            value={
              selected.firstSeen && selected.lastSeen ? (
                <span title={`Within the window this tab read. Not the host's whole history. Exact UTC: ${exactTimestamp(selected.firstSeen)} → ${exactTimestamp(selected.lastSeen)}`}>
                  {ago(selected.firstSeen)} → {ago(selected.lastSeen)}
                </span>
              ) : (
                <span className="text-muted">no line for this host carried a timestamp</span>
              )
            }
          />
        </DetailPanel>
      )}
    </div>
  );
}

/**
 * The chain in one cell: each link's verdict as a dot, the first link's text beside it (ellipsised),
 * the full sentence on hover. The later links are dots only: their text never fit the column, and
 * clipped mid-word it read as a different value.
 */
function ChainCell({ host }: { host: IngressHost }) {
  const links = chainLinks(host);
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[12px]" title={links.map(l => `${l.step}: ${l.text} — ${l.why}`).join('\n')}>
      {links.map((l, i) => (
        <span key={l.step} className={`inline-flex items-center gap-1 ${i === 0 ? 'min-w-0' : 'shrink-0'}`}>
          {i > 0 && <span className="text-muted/60">›</span>}
          <Dot tone={l.tone} />
          {i === 0 && <span className={`mono truncate ${l.tone === 'bad' ? 'text-bad' : l.tone === 'warn' ? 'text-warn' : 'text-muted'}`}>{l.text}</span>}
        </span>
      ))}
    </span>
  );
}
