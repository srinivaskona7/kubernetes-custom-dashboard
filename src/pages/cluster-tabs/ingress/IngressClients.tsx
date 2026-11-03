/**
 * Ingress & Traffic → Access control (section id `clients`, kept for deep links).
 *
 * Who may reach the edge and who did: the AuthorizationPolicies guarding the gateway with how much
 * each denied, the hosts those denials were aimed at, and the peers counted — distinct, internal,
 * external, allowed or only ever refused.
 *
 * ## External peers are counted, never listed (D1)
 *
 * An external peer address is a person's or a scanner's network location, and nothing on this screen
 * needs it: the finding is how many there were and what the policy did with them. The server collapses
 * them into one counted row; `listablePeers` and `peerAddress` enforce the same on the client, so an
 * older srv that still sends the addresses does not get them printed. Internal peers are cluster
 * objects and keep their address.
 *
 * ## The column is labelled "Peer address" and that is not pedantry
 *
 * `downstream_remote_address` is the **immediate peer**, which behind a corporate load balancer is
 * that load balancer and not the person. The originating client would be `x-forwarded-for`, and this
 * collector deliberately never reads it: it identifies a person and their network path, and a log line
 * is application data. So every count on this screen is per *peer*, and a screen that called it "the
 * client" would let an operator conclude "one client made 574 requests" from a row that means "one
 * load balancer forwarded 574 requests from any number of people".
 *
 * ## `external` is not a finding on an ingress gateway
 *
 * It is the whole job. What is worth reading is the pair of numbers beside it: how much of that peer's
 * traffic was rejected, and how many `CONNECT` requests it sent. `CONNECT` against an ingress gateway
 * is somebody testing whether it will act as an open forward proxy — 53 attempts on the cluster this
 * was built against — and it is the one signal here that is unambiguously somebody probing rather than
 * somebody using.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { LiveYaml } from '../../../components/LiveYaml';
import { Link } from 'react-router-dom';
import type { IngressAccessPolicy, IngressClient, TrafficIngress } from '../../../api';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { COLUMN_INFO } from '../../../components/table/column-info';
import { DetailPanel, Field } from '../../../components/layout';
import { SearchBox } from '../../../components/filters';
import { CellList, Dot, Empty, Pill, type Tone } from '../../../components/ui';
import { ago } from '../../../format';
import { Bytes, IngressCard, IngressGap, Num, ReadGap, Share } from './parts';
import { exactTimestamp, externalPeerSplit, ingressWasRead, share } from './shared';
import { Unavailable } from '../../../components/unavailable';
import { listablePeers, notFromServer, peerAddress } from './edge-view';
import { clientsFocus } from './problem-landing';
import type { IngressTarget } from '../problems';

type DeniedHost = NonNullable<TrafficIngress['access']>['deniedByHost'][number];

export function IngressClients({
  ingress,
  clusterId,
  before,
  focus,
  otherPanelOpen = false,
  onPanelOpen
}: {
  ingress: TrafficIngress | undefined;
  clusterId: string;
  /** First in the scroll column: the sub-tab's Problems strip. */
  before?: ReactNode;
  /** The tab opened its own panel (Proxies read); this one closes, so one panel shows at a time. */
  otherPanelOpen?: boolean;
  /** Called when a row opens this screen's panel, so the tab can close its own. */
  onPanelOpen?: () => void;
  /** A Problems press naming a policy or a refused host; its row is selected until the sub-tab changes. */
  focus?: Pick<IngressTarget, 'host' | 'text' | 'namespace'> | null;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [policy, setPolicy] = useState<IngressAccessPolicy | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const access = ingress?.access;
  const landed = useMemo(() => clientsFocus(access, focus), [access, focus]);
  useEffect(() => {
    if (otherPanelOpen) setSelectedKey(null);
  }, [otherPanelOpen]);
  const listed = useMemo(() => listablePeers(ingress?.clients ?? []), [ingress?.clients]);
  const all = listed.rows;
  const needle = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      all.filter(c => {
        if (!needle) return true;
        return [peerAddress(c), c.kind, c.name, c.namespace, ...c.topHosts.map(h => h.host), ...c.methods]
          .filter(Boolean)
          .some(v => String(v).toLowerCase().includes(needle));
      }),
    [all, needle]
  );
  const selected = useMemo(() => all.find(c => c.key === selectedKey) ?? null, [all, selectedKey]);

  if (!ingressWasRead(ingress)) {
    return (
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-4">
        {before}
        <IngressGap ingress={ingress} />
      </div>
    );
  }

  const policyColumns: Column<IngressAccessPolicy>[] = [
    {
      key: 'policy',
      header: 'Policy',
      pin: true,
      max: '300px',
      sortValue: p => `${p.namespace}/${p.name}`,
      render: p => (
        <span className="mono block truncate text-[12px]" title={`AuthorizationPolicy ${p.namespace}/${p.name}`}>
          {p.namespace}/{p.name}
        </span>
      )
    },
    {
      key: 'action',
      header: 'Action',
      width: '96px',
      sortValue: p => p.action,
      render: p => <Pill tone={p.action === 'DENY' ? 'warn' : 'unknown'}>{p.action ?? 'ALLOW'}</Pill>
    },
    {
      key: 'ranges',
      header: 'IP ranges',
      ...NUMERIC,
      width: '92px',
      sortValue: p => p.remoteIpBlocks,
      render: p => <Num value={p.remoteIpBlocks} title="CIDR ranges this policy lists in remoteIpBlocks. Counted; the ranges themselves are not printed." />
    },
    {
      key: 'rules',
      header: 'Rules',
      ...NUMERIC,
      width: '72px',
      sortValue: p => p.rules,
      render: p => <Num value={p.rules} />
    },
    {
      key: 'denied',
      header: 'Denied',
      ...NUMERIC,
      width: '128px',
      max: '128px',
      sortValue: p => p.denied,
      // null: several ALLOW policies select the gateway and Envoy logs a no-match denial as `[none]`.
      render: p =>
        p.denied === null ? (
          <span className="block truncate text-[12px] text-muted" title="More than one ALLOW policy selects the gateway. Envoy logs a request none of them matched as [none], so its denial cannot be pinned on one policy; the total above still counts it.">
            not attributable
          </span>
        ) : (
          <Num value={p.denied} title="Requests in the window read that this policy refused (rbac_access_denied)." />
        )
    }
  ];

  const deniedColumns: Column<DeniedHost>[] = [
    {
      key: 'host',
      header: 'Host',
      pin: true,
      max: '420px',
      sortValue: d => d.host,
      render: d => (
        <span className="mono block truncate text-[12px]" title={d.host}>
          {d.host}
        </span>
      )
    },
    {
      key: 'denied',
      header: 'Denied',
      ...NUMERIC,
      width: '84px',
      sortValue: d => d.count,
      render: d => <Num value={d.count} />
    }
  ];

  const columns: Column<IngressClient>[] = [
    {
      key: 'peer',
      header: 'Peer',
      pin: true,
      max: '190px',
      sortValue: c => peerAddress(c) ?? c.name,
      render: c => <PeerCell peer={c} />
    },
    {
      key: 'resolved',
      header: 'Resolved as',
      info: COLUMN_INFO.ingressPeerKind,
      max: '170px',
      sortValue: c => c.kind,
      render: c => (
        <span className="inline-flex min-w-0 items-baseline gap-1.5" title={c.evidence}>
          <span className="text-[12px]">{c.kind}</span>
          {c.name && c.name !== peerAddress(c) && peerAddress(c) !== null && (
            <span className="mono truncate text-[12px] text-muted">
              {c.namespace ? `${c.namespace}/` : ''}
              {c.name}
            </span>
          )}
        </span>
      )
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      width: '84px',
      sortValue: c => c.requests,
      render: c => (
        <Num
          value={c.requests}
          title={`${c.requests} record${c.requests === 1 ? '' : 's'} from this peer in the window that was read. Behind a load balancer this is the load balancer's total, not one person's.`}
        />
      )
    },
    {
      key: 'share',
      header: 'Error share',
      ...NUMERIC,
      width: '96px',
      sortValue: c => c.errorShare,
      render: c => (
        <Share
          value={c.errorShare}
          tone={c.server > 0 ? 'bad' : c.client > 0 ? 'warn' : undefined}
          title={`${c.client} rejected 4xx, ${c.server} server 5xx, ${c.noResponse} unanswered. A peer turned away on every request is usually a scanner, which is the edge working.`}
        />
      )
    },
    {
      key: 'connects',
      header: 'CONNECT attempts',
      info: COLUMN_INFO.ingressConnects,
      ...NUMERIC,
      width: '132px',
      sortValue: c => c.connects,
      render: c => <Num value={c.connects} tone="warn" title={c.connects > 0 ? 'This peer tried to use the gateway as a forward proxy.' : undefined} />
    },
    {
      key: 'hosts',
      header: 'Distinct hosts',
      priority: 3,
      // Right, and not headed `Hosts`: that label is a left-aligned column of host names elsewhere in
      // the console, and one header label means one alignment.
      ...NUMERIC,
      width: '110px',
      sortValue: c => c.hosts,
      render: c => (
        <span
          className="mono text-[13px]"
          title={c.topHosts.map(h => `${h.host} ×${h.count}`).join(', ') || 'No line from this peer carried a Host header.'}
        >
          {c.hosts}
        </span>
      )
    },
    {
      key: 'last',
      header: 'Last seen',
      priority: 3,
      ...NUMERIC,
      width: '104px',
      sortValue: c => c.lastSeen,
      render: c => (
        <span className="text-[12px] text-muted" title={c.firstSeen ? `First seen ${exactTimestamp(c.firstSeen)}` : undefined}>
          {c.lastSeen ? ago(c.lastSeen) : '—'}
        </span>
      )
    }
  ];

  return (
    <div className="flex min-h-0 flex-1 gap-4">
    <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden overscroll-contain pb-4">
      {before}
      {access ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Count label="Distinct peers" value={access.peers.distinct} why="Distinct downstream_remote_address values in the window read. Behind a load balancer one address stands for any number of people." />
          <Count label="Internal" value={access.peers.internal} why="Peers that are objects in this cluster: Pods, Services, Nodes." />
          <Count label="External" value={access.peers.external} why="Peers outside the cluster. Expected on an ingress gateway; counted, never listed by address. The tiles after it split this count and add up to it." />
          {/* One split (`externalPeerSplit`), so the tiles under External add up to it. */}
          {externalPeerSplit(access.peers).map(r => (
            <Count key={r.key} label={r.label} value={r.value} why={r.why} />
          ))}
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Count
          label="Distinct peers"
          value={ingress?.summary.clients ?? 0}
          why="Distinct downstream_remote_address values in the window that was read. Behind a load balancer one address stands for any number of people."
        />
        <Count
          label="From outside the cluster"
          value={ingress?.summary.externalClients ?? 0}
          why="Addresses that match no Pod, Service, endpoint or Node in this cluster. Expected on an ingress gateway — this is the number that says the edge is reachable, not a fault."
        />
        {/*
          Both counts below come from the summary rather than from `all`, which is the capped row
          list. The cap sorts by request volume, so what it drops is the *quietest* peers — exactly
          where a scanner lives. Counting these over the listed rows printed a confident 0 for the one
          signal this screen exists to surface.
        */}
        <Count
          label="Peers sending CONNECT"
          value={ingress?.summary.clientsConnecting ?? 0}
          tone={(ingress?.summary.clientsConnecting ?? 0) > 0 ? 'warn' : undefined}
          why="Addresses that sent at least one HTTP CONNECT. An ingress gateway is not a forward proxy, so these are probes testing whether it will act as one."
        />
        <Count
          label="Peers rejected outright"
          value={ingress?.summary.clientsFullyRejected ?? 0}
          why="Peers where every record read was a 4xx, a 5xx or an unanswered connection. Usually a scanner being turned away, which is the edge doing its job."
        />
      </div>
      )}

      <IngressCard
        title="AuthorizationPolicies"
        label={access && !access.unavailable.authorizationPolicies ? `${access.policies.length} · ${access.deniedTotal.toLocaleString()} denied` : undefined}
        hint="Policies selecting the ingress gateway, with how many requests each refused in the window read. Select a policy to inspect its configured CIDRs. Configuration does not prove which rule admitted a successful request."
      >
        {!access ? (
          <ReadGap status={notFromServer('AuthorizationPolicies')} />
        ) : access.unavailable.authorizationPolicies ? (
          <ReadGap status={{ ...notFromServer('AuthorizationPolicies'), why: 'could not read AuthorizationPolicies' }} />
        ) : (
          <>
            <DataTable
              columns={policyColumns}
              rows={[...access.policies].sort((a, b) => (b.denied ?? -1) - (a.denied ?? -1))}
              rowKey={p => `${p.namespace}/${p.name}`}
              selectedKey={policy ? `${policy.namespace}/${policy.name}` : landed?.table === 'policies' ? landed.key : undefined}
              onSelect={setPolicy}
              empty={<Empty title="No AuthorizationPolicy selects the gateway" hint="Every request that reaches a route is admitted at the edge." />}
            />
            {policy && (
              <div className="mt-3 space-y-2 border-t border-line pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-text">Configured ranges · {policy.namespace}/{policy.name}</h3>
                  <button type="button" className="text-[12px] text-muted hover:text-text" onClick={() => setPolicy(null)}>Close policy</button>
                </div>
                <p className="text-[12px] text-muted">ipBlocks and remoteIpBlocks are configured source ranges, not observed client addresses. Load balancer source ranges and upstream firewall rules are separate controls.</p>
                <LiveYaml clusterId={clusterId} kind="AuthorizationPolicy" namespace={policy.namespace} name={policy.name} fetchKey={`${clusterId}/${policy.namespace}/${policy.name}`} />
              </div>
            )}
            <p className="mt-2 text-[12px] text-muted">
              {access.proxyProtocol === null
                ? 'Whether PROXY protocol is on was not read, so an IP-range policy may be matching the load balancer rather than the client.'
                : access.proxyProtocol
                  ? 'PROXY protocol is on at the gateway: IP-range rules match the real client address.'
                  : 'PROXY protocol is off at the gateway: IP-range rules see the load balancer, not the client.'}
            </p>
          </>
        )}
      </IngressCard>

      {access && !access.unavailable.authorizationPolicies && (
        <IngressCard title="Denied by host" label={String(access.deniedByHost.length)} hint="Which hosts the refused requests were aimed at, most refused first.">
          <DataTable
            columns={deniedColumns}
            rows={access.deniedByHost}
            rowKey={d => d.host}
            selectedKey={landed?.table === 'denied' ? landed.key : undefined}
            empty={<Empty title="No request was denied in this window" />}
          />
        </IngressCard>
      )}

      <p className="text-[13px] text-muted">
        Refused requests, with the policy that decided each, are on{' '}
        <Link className="text-text underline" to={`?tab=network&networkView=flows&section=refused`}>Service flows → Refused Requests</Link>.
      </p>

      <IngressCard
        title="Peers that reached the edge"
        label={String(rows.length)}
        hint="Internal peers by address, external peers as one counted row — never by address. Click a row for the hosts it asked for, the codes it got and the methods it used."
      >
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface py-2">
          <span className="flex min-w-[240px] flex-1 items-center">
            <SearchBox value={search} onChange={setSearch} placeholder="Pod, namespace, host, method…" />
          </span>
          <span className="text-[13px] text-muted">
            {rows.length} of {all.length} shown
          </span>
        </div>
        {/*
          Seven narrow columns on the base tier: its 900px threshold sits below this console's 1090px
          container at 1440, so all seven render there. Under 900px (1100 wide) Distinct hosts and Last
          seen shed, which is what keeps the table inside its 820px pane.
        */}
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={c => c.key}
          selectedKey={selectedKey ?? undefined}
          onSelect={c => {
            const open = c.key !== selectedKey;
            setSelectedKey(open ? c.key : null);
            if (open) onPanelOpen?.();
          }}
          empty={
            <Empty
              title={all.length ? 'No peer matches this search' : 'No record carried a client address'}
              hint={
                all.length
                  ? 'Clear the search to see every peer.'
                  : 'Every line in the window lacked downstream_remote_address. Proxies read, beside the sub-tabs, shows what the log looked like.'
              }
            />
          }
        />
        {ingress?.clientsTruncated && (
          <p className="mt-2 text-[12px] text-warn">
            {ingress.clientsTotal} peers were seen and the {ingress.clients.length} busiest are listed. The rest are
            absent from this table, not merged into it — the tiles above count every peer, the table counts the rows
            shown.
          </p>
        )}
        {listed.externalHidden > 0 && (
          <p className="mt-2 text-[12px] text-muted">
            {listed.externalHidden} external peer{listed.externalHidden === 1 ? '' : 's'} sent by this server with an address {listed.externalHidden === 1 ? 'is' : 'are'} not
            listed; external peers are counted above, never shown by address.
          </p>
        )}
        <p className="mt-3 max-w-[100ch] text-[12px] text-muted">
          This console never reads <span className="mono">x-forwarded-for</span> or the user agent. Both identify a
          person and their network path, and neither is needed to answer the question this screen asks — so the column
          is honest about being the peer rather than approximating the originator from a header the gateway also
          cannot verify.
        </p>
      </IngressCard>
    </div>

      {selected && (
        <DetailPanel
          title={peerAddress(selected) ?? (selected.external ? 'External clients' : selected.name)}
          subtitle={selected.kind}
          onClose={() => setSelectedKey(null)}
        >
          <Field
            label="Resolved by"
            value={<span className="text-[13px] text-muted">{selected.evidence}</span>}
          />
          <Field
            label="What this address is"
            value={
              <span className="text-[13px] text-muted">
                {selected.external
                  ? 'Outside this cluster. Expected on an ingress gateway, and the only address this reader can attribute is the immediate peer — behind a load balancer that is the load balancer.'
                  : selected.kind === 'unresolved'
                    ? 'An in-cluster address that matches no Pod, Service, endpoint or Node this reader can see. A gap in what is visible here, not a fault in the cluster.'
                    : 'An object in this cluster, matched on the address the API server reports for it rather than on a name looking similar.'}
              </span>
            }
          />
          <Field
            label="Sampled records"
            value={
              <span className="mono">
                {selected.requests.toLocaleString()} — {selected.ok} ok, {selected.redirect} redirect, {selected.client}{' '}
                rejected, {selected.server} server error, {selected.noResponse} unanswered ({share(selected.errorShare)}{' '}
                non-2xx)
              </span>
            }
          />
          {selected.connects > 0 && (
            <Field
              label="CONNECT attempts"
              value={
                <span className="inline-flex items-baseline gap-2">
                  <span className="mono text-warn">{selected.connects}</span>
                  <span className="text-[13px] text-muted">
                    tried to use the gateway as a forward proxy. Envoy has no forward-proxy filter chain here, so these
                    were declined — the count is the intent, not a breach.
                  </span>
                </span>
              }
            />
          )}
          <Field
            label="Hosts asked for"
            value={
              selected.topHosts.length ? (
                <div className="mono space-y-0.5 text-[12px]">
                  {selected.topHosts.map(h => (
                    <div key={h.host} className="flex items-baseline justify-between gap-3">
                      <span className="truncate" title={h.host}>
                        {h.host}
                      </span>
                      <span className="text-muted/70">×{h.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-muted">no line from this peer carried a Host header</span>
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
          <Field label="Methods" value={<CellList items={selected.methods} empty="none recorded" className="mono text-[13px]" />} />
          <Field label="Bytes sent to it" value={<Bytes total={selected.bytesSent} />} />
          <Field label="Bytes received from it" value={<Bytes total={selected.bytesReceived} />} />
          <Field
            label="Seen"
            value={
              selected.firstSeen && selected.lastSeen ? (
                <span title={`Within the window this tab read. Not this peer's whole history. Exact UTC: ${exactTimestamp(selected.firstSeen)} → ${exactTimestamp(selected.lastSeen)}`}>
                  {ago(selected.firstSeen)} → {ago(selected.lastSeen)}
                </span>
              ) : (
                <span className="text-muted">no line from this peer carried a timestamp</span>
              )
            }
          />
        </DetailPanel>
      )}
    </div>
  );
}

/** A peer's identity: an internal peer by address, the external row by its count — never an external address. */
function PeerCell({ peer }: { peer: IngressClient }) {
  const address = peerAddress(peer);
  if (address === null) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px]" title="Peers outside the cluster are counted, never listed by address.">
        <Dot tone={kindTone(peer)} />
        External clients
        {peer.distinct !== undefined && <span className="mono text-[11px] text-muted">{peer.distinct} distinct</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={`${address} — ${peer.evidence}`}>
      <Dot tone={kindTone(peer)} />
      <span className="mono truncate text-[12px]">{address}</span>
    </span>
  );
}

/** One count with the sentence that says what it is. Same shape as Top Utilization's pressure counts. */
function Count({ label, value, why, tone }: { label: string; value: number | null; why: string; tone?: Tone }): JSX.Element {
  const quiet = value === 0;
  return (
    <div className="rounded-[8px] border border-line bg-surface px-3 py-2.5" title={why}>
      <div className="flex items-baseline gap-2">
        <span className={`text-[20px] font-semibold leading-6 ${quiet ? 'text-muted' : tone === 'warn' ? 'text-warn' : 'text-text'}`}>
          {value === null ? <Unavailable what={label} why={notFromServer(label).why} variant="dash" /> : value.toLocaleString()}
        </span>
        {!quiet && tone && (
          <span className="mt-[3px]">
            <Dot tone={tone} />
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[12px] leading-tight">{label}</div>
    </div>
  );
}

/**
 * How a peer address should read.
 *
 * `external` is neutral, not a warning (violet is the brand, never a status): on an ingress gateway it is the expected case and colouring it
 * as a fault would spend the console's alarm colour on normal traffic. `unresolved` is `unknown`,
 * because what is missing is this reader's ability to name the address rather than anything about the
 * address itself.
 */
function kindTone(c: IngressClient): Tone {
  if (c.kind === 'unresolved') return 'unknown';
  if (c.external) return 'unknown';
  return 'ok';
}
