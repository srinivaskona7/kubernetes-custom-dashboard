/**
 * Ingress & Traffic → TLS & Listeners.
 *
 * Two halves that answer two different questions and have to be read together.
 *
 * **What the cluster offers** — every `server` entry of every Istio Gateway: the port, the protocol,
 * the TLS mode and the *name* of the Secret holding the certificate. The name is the finding an
 * operator needs ("that Gateway points at a Secret that does not exist"); the value is never read,
 * here or anywhere in `srv/fleet`.
 *
 * **What arrived** — the listener each record was accepted on, from `downstream_local_address`, and
 * the connections that never got a filter chain at all.
 *
 * **What backs it** — the cert-manager Certificates behind those Secrets (expiry, Ready, issuer) and
 * the PeerAuthentication modes that decide whether the hop behind the gateway is mTLS.
 *
 * ## Rejected before routing is the largest finding on this tab
 *
 * `response_code: 0` with `filter_chain_not_found` was 286 of 1485 records on the cluster this was
 * built against — the single biggest bucket, and invisible everywhere else in the console. These
 * connections carry no authority, no path and no method, because Envoy turned them away before it
 * parsed a request line. The only identity they have is the SNI the client offered, which is why they
 * are grouped by it and why `no SNI offered` is its own row rather than being dropped: a client
 * connecting to :443 without SNI is a scanner or a misconfigured probe, and it was 260 of the 286.
 *
 * This is not drawn as a fault of the cluster. A Gateway that declines a name it does not serve is a
 * Gateway working correctly; the finding is *how much* of the edge's traffic is that, and from how
 * many distinct peers.
 */
import { useEffect, useMemo, useState } from 'react';
import type { IngressCertificate, IngressGatewayServer, IngressListener, IngressRejection, TrafficIngress } from '../../../api';
import { CENTER, DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { COLUMN_INFO } from '../../../components/table/column-info';
import { SearchBox } from '../../../components/filters';
import { CellList, Dot, Empty, Pill } from '../../../components/ui';
import { ago } from '../../../format';
import { IngressCard, IngressGap, PortLabel, ReadGap } from './parts';
import { exactTimestamp, ingressWasRead, share } from './shared';
import { certTone, daysLeftText, notFromServer, readFailed } from './edge-view';
import { gatewayServerMatches, listenersFocus, peerAuthRow, rejectionMatches, serverExpiry, tlsTone, type PeerAuthRow } from './listeners-view';
import type { IngressTarget } from '../problems';

export function IngressListeners({
  ingress,
  focus
}: {
  ingress: TrafficIngress | undefined;
  /** A Problems press naming a Certificate, PeerAuthentication or Secret. A new object each press. */
  focus?: Pick<IngressTarget, 'text' | 'namespace'> | null;
}): JSX.Element {
  const read = ingressWasRead(ingress);
  const [serverSearch, setServerSearch] = useState('');
  // The row the press names, selected (and so highlighted) until the operator leaves the sub-tab.
  const landed = useMemo(() => listenersFocus(ingress, focus?.text, focus?.namespace), [ingress, focus]);
  useEffect(() => {
    if (landed?.serverSearch) setServerSearch(landed.serverSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const [rejectionSearch, setRejectionSearch] = useState('');
  const gateways = ingress?.gateways ?? [];
  const servers = useMemo(() => gateways.filter(g => gatewayServerMatches(g, serverSearch)), [gateways, serverSearch]);
  const allRejections = ingress?.rejections ?? [];
  const rejections = useMemo(() => allRejections.filter(r => rejectionMatches(r, rejectionSearch)), [allRejections, rejectionSearch]);
  const certs = ingress?.certificates;
  const certGap = readFailed('Certificates', certs);
  const access = ingress?.access;
  const peerAuthGap: ReturnType<typeof readFailed> = !access
    ? notFromServer('PeerAuthentications')
    : access.unavailable.peerAuthentications
      ? { ...notFromServer('PeerAuthentications'), why: 'could not read PeerAuthentications' }
      : null;

  const certColumns: Column<IngressCertificate>[] = [
    {
      key: 'name',
      header: 'Certificate',
      pin: true,
      max: '240px',
      sortValue: c => `${c.namespace}/${c.name}`,
      // The shed columns' values stay on the name, so a narrow card loses no fact.
      render: c => (
        <span
          className="mono block truncate text-[12px]"
          title={[`${c.namespace}/${c.name}`, `Secret ${c.secretName ?? 'not named'}`, `Issuer ${c.issuer ?? 'not named'}`, `DNS names ${c.dnsNames.join(', ') || 'none listed'}`].join('\n')}
        >
          {c.namespace}/{c.name}
        </span>
      )
    },
    {
      key: 'secret',
      header: 'Secret',
      priority: 3,
      max: '200px',
      sortValue: c => c.secretName,
      render: c => (
        <span className="mono block truncate text-[12px] text-muted" title="The Secret's name. Its value is never read.">
          {c.secretName ?? '—'}
        </span>
      )
    },
    {
      key: 'expires',
      header: 'Expires',
      ...NUMERIC,
      width: '124px',
      sortValue: c => c.daysLeft,
      render: c => (
        <span className="inline-flex items-center gap-1.5 text-[12px]" title={c.expires ? `notAfter ${c.expires}` : 'The Certificate reports no notAfter.'}>
          <Dot tone={certTone(c)} />
          {daysLeftText(c.daysLeft)}
        </span>
      )
    },
    {
      key: 'ready',
      header: 'Ready',
      ...CENTER,
      width: '72px',
      sortValue: c => (c.ready === null ? -1 : c.ready ? 1 : 0),
      render: c => (
        <Pill tone={c.ready === null ? 'unknown' : c.ready ? 'ok' : 'bad'}>{c.ready === null ? 'not reported' : c.ready ? 'yes' : 'no'}</Pill>
      )
    },
    {
      key: 'issuer',
      header: 'Issuer',
      priority: 3,
      max: '180px',
      sortValue: c => c.issuer,
      render: c => (
        <span className="mono block truncate text-[12px] text-muted" title={c.issuer ?? undefined}>
          {c.issuer ?? '—'}
        </span>
      )
    },
    {
      key: 'dns',
      header: 'DNS names',
      priority: 2,
      max: '260px',
      sortValue: c => c.dnsNames[0] ?? null,
      render: c => <CellList items={c.dnsNames} empty="none listed" className="mono text-[12px] text-muted" />
    }
  ];

  const peerAuthColumns: Column<PeerAuthRow>[] = [
    {
      key: 'name',
      header: 'PeerAuthentication',
      pin: true,
      max: '260px',
      sortValue: p => p.name,
      render: p => (
        <span className="mono block truncate text-[12px]" title={p.name}>
          {p.name}
        </span>
      )
    },
    {
      key: 'mode',
      header: 'Mode',
      width: '128px',
      sortValue: p => p.mode,
      render: p => (
        <Pill tone={p.tone} title={p.why}>
          {p.mode}
        </Pill>
      )
    },
    {
      key: 'selector',
      header: 'Selector',
      max: '160px',
      sortValue: p => p.scope,
      render: p => (
        <span className={`mono block truncate text-[12px] ${p.scope === 'namespace-wide' ? 'text-muted/70' : 'text-muted'}`} title={p.scope}>
          {p.scope}
        </span>
      )
    }
  ];

  const serverColumns: Column<IngressGatewayServer>[] = [
    {
      key: 'gateway',
      header: 'Gateway',
      pin: true,
      max: '260px',
      sortValue: g => `${g.namespace}/${g.name}`,
      render: g => (
        // Protocol, Credential and Minimum TLS shed under 900px; their values stay on the name.
        <span
          className="mono block truncate text-[12px]"
          title={[`Gateway ${g.namespace}/${g.name}`, `Protocol ${g.protocol ?? 'none'}${g.httpsRedirect ? ', redirects to HTTPS' : ''}`, `Secret ${g.credentialName ?? 'none named'}`, `Minimum TLS ${g.minProtocolVersion ?? 'default'}`].join('\n')}
        >
          {g.namespace}/{g.name}
        </span>
      )
    },
    {
      key: 'port',
      header: 'Port',
      width: '72px',
      sortValue: g => g.port,
      render: g => (g.port === null ? <span className="text-muted/70">—</span> : <span className="mono text-[13px]">{g.port}</span>)
    },
    {
      key: 'protocol',
      header: 'Protocol',
      priority: 3,
      max: '130px',
      sortValue: g => g.protocol,
      render: g => (
        <span
          className="mono block truncate text-[12px] text-muted"
          title={[g.portName ? `port name ${g.portName}` : null, g.httpsRedirect ? 'httpsRedirect is set: this server answers plain HTTP with a 301 to the https scheme rather than serving it.' : null].filter(Boolean).join('\n') || undefined}
        >
          {g.protocol ?? 'no protocol'}
          {g.httpsRedirect && <span className="text-muted/70"> → HTTPS</span>}
        </span>
      )
    },
    {
      key: 'tls',
      header: 'TLS mode',
      width: '140px',
      sortValue: g => g.tlsMode,
      render: g => (
        <Pill tone={tlsTone(g.tlsMode)} title={tlsWhy(g.tlsMode)}>
          {g.tlsMode ?? 'no TLS block'}
        </Pill>
      )
    },
    {
      key: 'credential',
      header: 'Credential',
      priority: 3,
      max: '170px',
      sortValue: g => g.credentialName,
      render: g =>
        g.credentialName ? (
          <span
            className="mono block truncate text-[12px]"
            title={`${g.credentialName}\nThe name of the Secret this server reads its certificate from. A name, never a value — srv/fleet returns Secret keys and never their contents.`}
          >
            {g.credentialName}
          </span>
        ) : (
          <span className="text-[12px] text-muted/70" title="This server names no credential. Expected on an HTTP server and on TLS PASSTHROUGH, where the certificate lives behind the Gateway.">
            none named
          </span>
        )
    },
    {
      key: 'expiry',
      header: 'Expiry',
      ...NUMERIC,
      width: '140px',
      sortValue: g => serverExpiry(g, certs).daysLeft,
      render: g => {
        const e = serverExpiry(g, certs);
        return e.tone === null ? (
          <span className="text-muted/70" title={e.title}>
            {e.text}
          </span>
        ) : (
          <span className={`inline-flex items-center gap-1.5 text-[12px] ${e.tone === 'bad' ? 'text-bad' : e.tone === 'warn' ? 'text-warn' : e.tone === 'unknown' ? 'text-muted' : 'text-text'}`} title={e.title}>
            <Dot tone={e.tone} />
            {e.text}
          </span>
        );
      }
    },
    {
      key: 'minTls',
      header: 'Minimum TLS',
      priority: 3,
      width: '116px',
      sortValue: g => g.minProtocolVersion,
      render: g =>
        g.minProtocolVersion ? (
          <span className="mono text-[12px]" title="tls.minProtocolVersion on this server.">
            {g.minProtocolVersion}
          </span>
        ) : (
          <span className="text-[12px] text-muted/70" title="The server sets no tls.minProtocolVersion, so Envoy's own default applies.">
            default
          </span>
        )
    },
    {
      key: 'hosts',
      header: 'Hosts',
      max: '148px',
      sortValue: g => g.hosts[0] ?? null,
      render: g => (
        <span className="block min-w-0" title={g.hosts.join('\n') || undefined}>
          <CellList items={g.hosts} empty="no host listed" className="mono text-[12px] text-muted" />
        </span>
      )
    }
  ];

  /*
    Eight narrow columns on the base tier: its 900px threshold sits below this console's container at
    1440, so all eight render there. Under 900px (1100 wide) the three breadth columns shed — their
    uppercase headers alone set 953px of minimum width against 810 — and the Port cell's tooltip
    carries all three, so no value leaves the page.
  */
  const listenerColumns: Column<IngressListener>[] = [
    {
      key: 'port',
      header: 'Port',
      pin: true,
      width: '86px',
      sortValue: l => l.port,
      render: l => (
        <span title={`Protocols: ${l.protocols.length ? l.protocols.join(', ') : 'none recorded'} · ${l.hosts} distinct hosts · ${l.sni} SNI values`}>
          <PortLabel port={l.port} />
        </span>
      )
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      width: '84px',
      sortValue: l => l.requests,
      render: l => <span className="mono text-[13px]">{l.requests.toLocaleString()}</span>
    },
    {
      key: 'rejected',
      header: 'Rejected',
      info: COLUMN_INFO.ingressRejected,
      ...NUMERIC,
      width: '92px',
      sortValue: l => l.rejected,
      render: l => (
        <span
          className={`mono text-[13px] ${l.rejected > 0 ? 'text-warn' : 'text-muted'}`}
          title={
            l.rejected > 0
              ? `${share(l.requests ? l.rejected / l.requests : null)} of this listener's records. A Gateway declining a name it does not serve is working correctly; the finding is the volume and how many peers it came from.`
              : 'Every connection on this listener got a filter chain.'
          }
        >
          {l.rejected.toLocaleString()}
        </span>
      )
    },
    {
      key: 'http',
      header: 'HTTP requests',
      ...NUMERIC,
      width: '116px',
      sortValue: l => l.http,
      render: l => <span className="mono text-[13px]">{l.http.toLocaleString()}</span>
    },
    {
      key: 'tcp',
      header: 'TCP connections',
      info: COLUMN_INFO.ingressTcpConnections,
      ...NUMERIC,
      width: '132px',
      sortValue: l => l.tcp,
      render: l => <span className="mono text-[13px]">{l.tcp.toLocaleString()}</span>
    },
    {
      key: 'protocols',
      header: 'Protocols',
      priority: 3,
      max: '140px',
      sortValue: l => l.protocols[0] ?? '',
      render: l => <CellList items={l.protocols} empty="none recorded" className="mono text-[12px]" />
    },
    {
      key: 'hosts',
      header: 'Distinct hosts',
      priority: 3,
      // Right, and headed `Distinct hosts` rather than `Hosts`: `Hosts` is a left-aligned column of
      // host *names* in three other tables, and one header label means one alignment console-wide.
      ...NUMERIC,
      width: '110px',
      sortValue: l => l.hosts,
      render: l => <span className="mono text-[13px]">{l.hosts}</span>
    },
    {
      key: 'sni',
      header: 'SNI values',
      priority: 3,
      ...NUMERIC,
      width: '98px',
      sortValue: l => l.sni,
      render: l => <span className="mono text-[13px]">{l.sni}</span>
    }
  ];

  const rejectionColumns: Column<IngressRejection>[] = [
    {
      key: 'sni',
      header: 'SNI',
      info: COLUMN_INFO.ingressSni,
      pin: true,
      max: '260px',
      sortValue: r => r.sni ?? '',
      render: r =>
        r.sni ? (
          <span className="mono block truncate text-[12px]" title={r.sni}>
            {r.sni}
          </span>
        ) : (
          <span
            className="text-[12px] italic text-muted"
            title="The client offered no server name at all. On a port serving several Gateways, Envoy has nothing to select a filter chain with, so the connection is declined — typical of a port scanner and of a probe configured with an IP address instead of a name."
          >
            no SNI offered
          </span>
        )
    },
    {
      key: 'port',
      header: 'Port',
      width: '86px',
      sortValue: r => r.port,
      render: r => <PortLabel port={r.port} />
    },
    {
      key: 'count',
      header: 'Rejected',
      ...NUMERIC,
      width: '92px',
      sortValue: r => r.count,
      render: r => <span className="mono text-[13px] text-warn">{r.count.toLocaleString()}</span>
    },
    {
      key: 'clients',
      header: 'Peers',
      info: COLUMN_INFO.ingressPeerCount,
      ...NUMERIC,
      width: '84px',
      sortValue: r => r.clients,
      render: r => <span className="mono text-[13px]">{r.clients}</span>
    },
    {
      key: 'first',
      header: 'First seen',
      ...NUMERIC,
      width: '104px',
      sortValue: r => r.firstSeen,
      render: r => <span className="text-[12px] text-muted" title={exactTimestamp(r.firstSeen)}>{r.firstSeen ? ago(r.firstSeen) : '—'}</span>
    },
    {
      key: 'last',
      header: 'Last seen',
      ...NUMERIC,
      width: '104px',
      sortValue: r => r.lastSeen,
      render: r => <span className="text-[12px] text-muted" title={exactTimestamp(r.lastSeen)}>{r.lastSeen ? ago(r.lastSeen) : '—'}</span>
    }
  ];

  return (
    <div className="space-y-5">
      {!read && <IngressGap ingress={ingress} />}

      <IngressCard
        title="Gateway servers"
        label={serverSearch ? `${servers.length} of ${gateways.length}` : String(gateways.length)}
        hint="One row per server entry of every Istio Gateway selecting the ingress pods, read from the objects: what the cluster declares, whether or not anything has arrived for it."
        action={
          <span className="flex w-[260px]">
            <SearchBox value={serverSearch} onChange={setServerSearch} placeholder="Gateway, port, Secret, host…" />
          </span>
        }
      >
        <DataTable
          columns={serverColumns}
          rows={servers}
          rowKey={g => g.key}
          selectedKey={landed?.table === 'servers' ? landed.key : undefined}
          empty={
            gateways.length ? (
              <Empty title="No Gateway server matches this search" />
            ) : (
              <Empty
                title="No Istio Gateway selects the ingress pods"
                hint="Either no Gateway exists in this cluster or the Gateway read did not answer — the page-level notice above names which. With no Gateway, every host on the Hosts screen will read as undeclared."
              />
            )
          }
        />
      </IngressCard>

      {read && (
        <IngressCard
          title="Listeners that accepted traffic"
          label={String(ingress?.listeners.length ?? 0)}
          hint="From downstream_local_address on each record: the socket Envoy accepted it on. Evidence from the log, so a declared Gateway port with no traffic appears above, not here."
        >
          <DataTable
            columns={listenerColumns}
            rows={ingress?.listeners ?? []}
            rowKey={l => l.key}
            empty={
              <Empty
                title="No record carried a listener address"
                hint="Every line in the window lacked downstream_local_address, which on a JSON access log means the format omits it. Proxies read, beside the sub-tabs, shows what the log looked like."
              />
            }
          />
        </IngressCard>
      )}

      {read && (
        <IngressCard
          title="Rejected before routing"
          label={rejectionSearch ? `${rejections.length} of ${allRejections.length}` : String(allRejections.length)}
          hint="Connections turned away at the listener with filter_chain_not_found, grouped by the SNI the client offered. Envoy never parsed a request line, so these records carry no host, path or method."
          action={
            <span className="flex w-[260px]">
              <SearchBox value={rejectionSearch} onChange={setRejectionSearch} placeholder="SNI or port…" />
            </span>
          }
        >
          <DataTable
            columns={rejectionColumns}
            rows={rejections}
            rowKey={r => r.key}
            empty={
              allRejections.length ? (
                <Empty title="No rejection matches this search" />
              ) : (
                <Empty
                  title="Nothing was rejected before routing in this window"
                  hint="Every connection the gateway accepted found a filter chain. This is a statement about the lines that were read, not about the cluster's whole history."
                />
              )
            }
          />
          {ingress?.rejectionsTruncated && (
            <p className="text-[12px] text-warn">
              {ingress.rejectionsTotal} distinct groups were seen and the {allRejections.length} largest are
              listed. The rest are absent from this table, not merged into it.
            </p>
          )}
          {allRejections.length > 0 && (
            <p className="flex max-w-[100ch] items-baseline gap-2 text-[12px] text-muted">
              <Dot tone="unknown" />
              <span>
                A Gateway declining a name it does not serve is the Gateway working. What is worth acting on here is
                the <em>volume</em> against the peer count beside it: one address repeating is a client pointed at
                the wrong name, and many addresses with one connection each is an internet-wide scan finding your
                load balancer.
              </span>
            </p>
          )}
        </IngressCard>
      )}

      {/*
        Two compact cards side by side from 1360px, stacked below. Measured 2026-09-26 at 1100: a
        half card is 394px, and Mesh mTLS's three headers alone need 463px, Certificates' 426px.
      */}
      <div className="grid gap-5 min-[1360px]:grid-cols-2">
        <IngressCard
          title="Certificates"
          label={certs && !certs.unavailable ? String(certs.items.length) : undefined}
          hint="cert-manager Certificates whose Secret a Gateway server names. Amber once the issuer's renewal time has passed (under 30 days when it reports none), red under 7 days or not Ready. The Secret's value is never read."
        >
          {certGap ? (
            <ReadGap status={certGap} />
          ) : (
            <DataTable
              columns={certColumns}
              rows={[...(certs?.items ?? [])].sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity))}
              rowKey={c => `${c.namespace}/${c.name}`}
              selectedKey={landed?.table === 'certificates' ? landed.key : undefined}
              empty={<Empty title="No Certificate backs a Gateway Secret" hint="The Secrets may be managed outside cert-manager, in which case their expiry is not readable here." />}
            />
          )}
        </IngressCard>

        <IngressCard
          title="Mesh mTLS (PeerAuthentication)"
          label={access && !access.unavailable.peerAuthentications ? String(access.peerAuthentications.length) : undefined}
          hint="Whether the hop from the gateway to the workload must be mutual TLS. PERMISSIVE accepts plaintext too, so it is amber."
        >
          {peerAuthGap ? (
            <ReadGap status={peerAuthGap} />
          ) : (
            <DataTable
              columns={peerAuthColumns}
              rows={(access?.peerAuthentications ?? []).map(peerAuthRow)}
              // The toolbar row a 3-column table would skip, so this header lines up with the
              // Certificates header beside it.
              tools
              rowKey={p => p.key}
              selectedKey={landed?.table === 'peerAuth' ? landed.key : undefined}
              empty={<Empty title="No PeerAuthentication exists" hint="The mesh default applies: Istio's own default is PERMISSIVE." />}
            />
          )}
        </IngressCard>
      </div>
    </div>
  );
}

function tlsWhy(mode: string | null): string {
  if (!mode) return 'This server declares no tls block. On an HTTP port that is expected; on an HTTPS port it is a misconfiguration.';
  if (mode === 'DISABLE') return 'TLS is explicitly disabled on this server. Traffic reaching it is unencrypted from the client to the gateway.';
  if (mode === 'SIMPLE') return 'Standard server-side TLS: the gateway presents the certificate in the named Secret and does not ask the client for one.';
  if (mode === 'MUTUAL') return 'Mutual TLS: the gateway also requires and verifies a client certificate.';
  if (mode === 'ISTIO_MUTUAL') return 'Istio-managed mutual TLS, using the mesh’s own certificates rather than a named Secret.';
  if (mode === 'PASSTHROUGH' || mode === 'AUTO_PASSTHROUGH') {
    return 'The gateway does not terminate TLS — it routes the connection on by SNI and the workload behind it presents the certificate. Correct by design, and it means no certificate for this host exists at the gateway to inspect.';
  }
  return `Istio TLS mode ${mode}, as the Gateway declares it.`;
}
