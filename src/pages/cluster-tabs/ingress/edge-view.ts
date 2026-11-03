/**
 * The pure half of the classified edge (plan 2026-09-26): what each traffic class and failure bucket
 * means, in which order the screens show them, and how a missing field reads.
 *
 * The ordering rules live here rather than in the `.tsx` files because they are the product. "Priority
 * first" means attention before volume before detail, and a sort that puts an idle host above one with
 * a broken certificate join is a screen that answers the wrong question confidently. vitest runs in
 * `environment: 'node'`, so everything here is a plain function with a test beside it.
 *
 * Every field this reads is optional on the wire — an older srv does not send it — and each helper
 * returns a stated gap for that case, never a zero.
 */
import type {
  EdgeClass,
  EdgeClassRow,
  FailureBucket,
  IngressCertificate,
  IngressAppTraffic,
  IngressAttention,
  IngressClient,
  IngressHost,
  IngressLb,
  TrafficEndpoint,
  TrafficErrorGroup
} from '../../../api';
import type { Tone } from '../../../components/ui';
import type { MetricStatus } from '../../../components/unavailable';
import { sectionAlias } from '../tabs';

/* ------------------------------------------------------------------ traffic classes */

/** Display order: the operator's own traffic first, then platform noise, then what the edge refused. */
export const EDGE_CLASS_ORDER: readonly EdgeClass[] = ['app', 'platform', 'probe', 'direct-ip', 'policy-blocked', 'tls-rejected'];

export const EDGE_CLASS_LABEL: Record<EdgeClass, string> = {
  app: 'App traffic',
  platform: 'Platform system',
  probe: 'Platform probe',
  'direct-ip': 'Direct IP / unknown host',
  'policy-blocked': 'Refused by policy',
  'tls-rejected': 'Rejected at TLS'
};

export const EDGE_CLASS_WHY: Record<EdgeClass, string> = {
  app: 'Routed by an Ingress, an HTTPRoute or a VirtualService outside the system namespaces. The only class whose errors and latency are your applications’.',
  platform: 'Routed by a VirtualService in platform-system or istio-system — the connectivity proxy, the platform gateway hosts. Real traffic, not yours.',
  probe: 'The host the istio-healthz VirtualService routes: the load balancer’s health check. Usually most of the window, always 200.',
  'direct-ip': 'The Host header was an IP address or a name no Gateway server admits — somebody dialling the load balancer directly.',
  'policy-blocked': 'Envoy answered rbac_access_denied: an AuthorizationPolicy on the gateway refused it. The allowlist working, not a failure.',
  'tls-rejected': 'No HTTP request at all: NR with filter_chain_not_found, a TLS handshake with no or an unknown SNI. Scanners, turned away before routing.'
};

export const EDGE_CLASS_TONE: Record<EdgeClass, Tone> = {
  app: 'unknown',
  platform: 'unknown',
  probe: 'unknown',
  'direct-ip': 'warn',
  'policy-blocked': 'unknown',
  'tls-rejected': 'unknown'
};

/** The bar fill for a tone, as theme token classes only. */
export function toneBar(tone: Tone): string {
  if (tone === 'bad') return 'bg-bad';
  if (tone === 'warn') return 'bg-warn';
  if (tone === 'ok') return 'bg-ok';
  return 'bg-muted/60';
}

/**
 * The class rows in display order, each with its share of `total`.
 *
 * `share` is `null` when `total` is 0 — no denominator is not a 0% share. A class the server did not
 * send is absent, not drawn as an empty bar.
 */
export function classBreakdown(classes: { rows: EdgeClassRow[]; total: number } | undefined): (EdgeClassRow & { share: number | null })[] {
  if (!classes) return [];
  const rank = (k: EdgeClass) => {
    const i = EDGE_CLASS_ORDER.indexOf(k);
    return i < 0 ? EDGE_CLASS_ORDER.length : i;
  };
  return [...classes.rows]
    .sort((a, b) => rank(a.key) - rank(b.key))
    .map(r => ({ ...r, share: classes.total > 0 ? r.records / classes.total : null }));
}

/**
 * The TCP connections (records with no request line, `records - requests`) in each class, in display
 * order, empty classes dropped. The one definition the Overview class rows and the Hosts records note
 * both use, so "164 TCP" and "163 Rejected at TLS" show where the other one went. `null` without classes.
 */
export function connectionsByClass(classes: { rows: EdgeClassRow[]; total: number } | undefined): { key: EdgeClass; connections: number }[] | null {
  if (!classes) return null;
  return classBreakdown(classes)
    .map(r => ({ key: r.key, connections: Math.max(r.records - r.requests, 0) }))
    .filter(r => r.connections > 0);
}

/** A class row's records in the units it holds: "161 HTTP", "163 TCP", or "31 HTTP + 1 TCP". */
export function classUnits(row: Pick<EdgeClassRow, 'records' | 'requests'>): string {
  const tcp = Math.max(row.records - row.requests, 0);
  const http = `${row.requests.toLocaleString('en-US')} HTTP`;
  if (!tcp) return http;
  const conn = `${tcp.toLocaleString('en-US')} TCP`;
  return row.requests ? `${http} + ${conn}` : conn;
}

/* ------------------------------------------------------------------ app traffic */

/**
 * The p95 tile's text. Null below `minSamples` is the server saying "not a percentile yet", and the
 * tile says so with the count rather than printing a number.
 */
export function appP95Line(app: IngressAppTraffic): { value: string; why: string } {
  if (app.p95Ms === null) {
    return {
      value: 'too few samples',
      why: `too few samples (${app.samples} of ${app.minSamples}) — a p95 over fewer lines is one request, not a percentile`
    };
  }
  return {
    value: `${app.p95Ms} ms`,
    why: `p95 over ${app.samples} app requests${app.p50Ms !== null ? `; p50 ${app.p50Ms} ms` : ''}`
  };
}

/* ------------------------------------------------------------------ attention */

/** The Ingress & Traffic sub-tab ids, as tabs.ts declares them — the only sections a row may link to. */
export const TRAFFIC_SECTION_IDS = ['ingress', 'hosts', 'failures', 'clients', 'gateway'] as const;
export type TrafficSectionId = (typeof TRAFFIC_SECTION_IDS)[number];

const SEVERITY_RANK: Record<IngressAttention['severity'], number> = { critical: 0, warning: 1, info: 2 };

export const SEVERITY_TONE: Record<IngressAttention['severity'], Tone> = { critical: 'bad', warning: 'warn', info: 'unknown' };

/** Critical, then warning, then info; the server's order is kept inside a severity (stable sort). */
export function sortAttention(rows: IngressAttention[] | undefined): IngressAttention[] {
  if (!rows) return [];
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (SEVERITY_RANK[a.r.severity] ?? 3) - (SEVERITY_RANK[b.r.severity] ?? 3) || a.i - b.i)
    .map(x => x.r);
}

/**
 * Only a section this tab actually has is a link; anything else renders as plain text. A retired id
 * srv still sends (`listeners` on cert-expiry, permissive-mtls and join-gap rows) maps through
 * SECTION_ALIASES first, so it opens Hosts & TLS instead of dropping to plain text.
 */
export function attentionTarget<T extends string>(row: IngressAttention, sections: readonly T[]): T | null {
  const id = sectionAlias('traffic', row.section)?.section ?? row.section;
  return (sections as readonly string[]).includes(id) ? (id as T) : null;
}

/* ------------------------------------------------------------------ certificates */

/**
 * Certificate attention follows the issuer (docs/specs/UI_SPEC.md §13a), the same rule as srv's
 * `attentionOf`: red when not Ready or under 7 days; amber when the issuer's renewal time has passed,
 * or — with no renewal time reported — under 30 days. cert-manager renews with a third of a 90-day life left,
 * so 39-66 days left with renewal pending is steady state, not a countdown. Unknown expiry is unknown.
 */
export function certTone(c: Pick<IngressCertificate, 'daysLeft' | 'ready' | 'renewalOverdue'>): Tone {
  if (c.ready === false) return 'bad';
  if (c.daysLeft === null || c.daysLeft === undefined) return 'unknown';
  if (c.daysLeft < 7) return 'bad';
  const due = c.renewalOverdue === null || c.renewalOverdue === undefined ? c.daysLeft < 30 : c.renewalOverdue;
  return due ? 'warn' : 'ok';
}

export function daysLeftText(daysLeft: number | null | undefined): string {
  if (daysLeft === null || daysLeft === undefined) return 'expiry not reported';
  if (daysLeft < 0) return `expired ${-daysLeft} d ago`;
  return `${daysLeft} d left`;
}

/**
 * The Certificate behind one Gateway server: the server's own entry in `usedBy` first, then any
 * Certificate whose Secret has the server's `credentialName`. Istio resolves that name in the gateway
 * pod's namespace, which the server row does not carry, so the fallback is by name alone.
 */
export function certForServer(
  server: { key: string; credentialName: string | null },
  certs: IngressCertificate[] | undefined
): IngressCertificate | null {
  if (!certs) return null;
  return (
    certs.find(c => c.usedBy.includes(server.key)) ??
    (server.credentialName ? certs.find(c => c.secretName === server.credentialName) : undefined) ??
    null
  );
}

/* ------------------------------------------------------------------ hosts */

/**
 * What is missing from a host's published chain.
 *
 * Only asked of a named host the server sent a `chain` for, and not of the classes where no chain is
 * expected (`direct-ip`, `tls-rejected`): a scanner dialling the LB's IP has no DNSEntry by definition.
 */
export function joinGaps(h: IngressHost): string[] {
  if (!h.chain || !h.host) return [];
  if (h.edgeClass === 'direct-ip' || h.edgeClass === 'tls-rejected') return [];
  const gaps: string[] = [];
  // `undefined` is an unread list (DNSEntries, Gateways, Certificates): unknown, so not a gap.
  if (h.chain.dns === null) gaps.push('no DNSEntry');
  const servers = h.chain.servers;
  if (servers && servers.length === 0) gaps.push('no Gateway server admits it');
  for (const s of servers ?? []) {
    const terminates = s.tlsMode === 'SIMPLE' || s.tlsMode === 'MUTUAL';
    if (terminates && s.certificate === null) gaps.push(`:${s.port ?? '?'} names no readable certificate`);
    else if (s.certificate && s.certificate.ready === false) gaps.push(`certificate ${s.certificate.name} not Ready`);
    else if (s.certificate && s.certificate.daysLeft !== null && s.certificate.daysLeft < 0) gaps.push(`certificate ${s.certificate.name} expired`);
  }
  if (h.servedBy.length === 0) gaps.push('no route declares it');
  return gaps;
}

export interface ChainLink {
  step: 'DNS' | 'Gateway' | 'Certificate' | 'Route';
  text: string;
  tone: Tone;
  why: string;
}

/**
 * The host's published chain as four links — DNSEntry, Gateway server (port and TLS mode), the
 * certificate behind a terminating server, the route that declares it — each with its own verdict.
 * A missing link is amber on a host that should have one and neutral on the refusal classes, where
 * none is expected. No chain from the server means no links, not four failures.
 */
export function chainLinks(h: IngressHost): ChainLink[] {
  if (!h.chain) return [];
  const expected = h.edgeClass !== 'direct-ip' && h.edgeClass !== 'tls-rejected';
  const missing: Tone = expected ? 'warn' : 'unknown';
  const links: ChainLink[] = [];
  const dns = h.chain.dns;
  links.push(
    dns === undefined
      ? { step: 'DNS', text: 'not read', tone: 'unknown', why: 'The DNSEntry read failed, so whether a DNSEntry publishes this name is unknown.' }
      : dns
      ? {
          step: 'DNS',
          text: dns.name,
          tone: dns.ready === false ? 'warn' : dns.ready === null ? 'unknown' : 'ok',
          why: `DNSEntry ${dns.name} publishes ${dns.dnsName}${dns.ready === false ? ', and is not Ready' : ''}.`
        }
      : { step: 'DNS', text: 'no DNSEntry', tone: missing, why: 'No DNSEntry publishes this name onto the load balancer.' }
  );
  const servers = h.chain.servers;
  links.push(
    servers === undefined
      ? { step: 'Gateway', text: 'not read', tone: 'unknown', why: 'The Gateway read failed, so which Gateway server admits this host is unknown.' }
      : servers.length
      ? {
          step: 'Gateway',
          text: servers.map(sv => `:${sv.port ?? '?'} ${sv.tlsMode ?? 'no TLS'}`).join(', '),
          tone: 'ok',
          why: servers.map(sv => `${sv.gateway} :${sv.port ?? '?'} ${sv.tlsMode ?? 'no tls block'}${sv.credentialName ? `, secret ${sv.credentialName}` : ''}`).join('; ')
        }
      : { step: 'Gateway', text: 'no Gateway server', tone: missing, why: 'No Istio Gateway server lists this host.' }
  );
  const terminating = servers?.find(sv => sv.tlsMode === 'SIMPLE' || sv.tlsMode === 'MUTUAL');
  if (terminating) {
    const c = terminating.certificate;
    links.push(
      c === undefined
        ? { step: 'Certificate', text: 'not read', tone: 'unknown', why: 'The Certificate read failed, so whether this server has a valid certificate is unknown.' }
        : c
        ? {
            step: 'Certificate',
            text: c.ready === false ? 'not Ready' : daysLeftText(c.daysLeft),
            tone: certTone(c),
            why: `Certificate ${c.namespace}/${c.name}${c.expires ? `, notAfter ${c.expires}` : ''}.`
          }
        : {
            step: 'Certificate',
            text: 'no readable certificate',
            tone: missing,
            why: `The :${terminating.port ?? '?'} server names ${terminating.credentialName ?? 'no Secret'}, and no cert-manager Certificate was found for it.`
          }
    );
  }
  const first = h.servedBy[0];
  links.push(
    first
      ? {
          step: 'Route',
          text: `${first.kind} ${first.name}${h.servedBy.length > 1 ? ` +${h.servedBy.length - 1}` : ''}`,
          tone: 'ok',
          why: h.servedBy.map(r => `${r.kind} ${r.namespace}/${r.name}`).join(', ')
        }
      : { step: 'Route', text: 'no route', tone: missing, why: 'No VirtualService, Ingress or HTTPRoute declares this host.' }
  );
  return links;
}

/** The Hosts & Routes class filter; `all` passes every row, including an unclassified one. */
export function matchesClassFilter(h: IngressHost, filter: ClassFilter): boolean {
  return filter === 'all' || h.edgeClass === filter;
}

/** A host's failures for sorting: 5xx always; 4xx only where they are not the edge's own refusals. */
export function hostFailures(h: IngressHost): number {
  const refusals = h.edgeClass === 'policy-blocked' || h.edgeClass === 'tls-rejected' || h.edgeClass === 'direct-ip';
  return h.server + (refusals ? 0 : h.client);
}

/** 0 broken join, 1 failing, 2 busy, 3 idle — the Hosts & Routes order. */
export function hostRank(h: IngressHost): number {
  if (joinGaps(h).length > 0) return 0;
  if (hostFailures(h) > 0) return 1;
  if (h.requests > 0) return 2;
  return 3;
}

export function sortHosts(hosts: IngressHost[]): IngressHost[] {
  return [...hosts].sort(
    (a, b) =>
      hostRank(a) - hostRank(b) ||
      hostFailures(b) - hostFailures(a) ||
      b.requests - a.requests ||
      (a.host ?? '').localeCompare(b.host ?? '')
  );
}

export type ClassFilter = 'all' | EdgeClass;

/** Chips from the rows in hand, in class order; a class with no host has no chip. */
export function classFilterChips(hosts: IngressHost[]): { id: ClassFilter; label: string; count: number }[] {
  const counts = new Map<EdgeClass, number>();
  for (const h of hosts) if (h.edgeClass) counts.set(h.edgeClass, (counts.get(h.edgeClass) ?? 0) + 1);
  const chips: { id: ClassFilter; label: string; count: number }[] = [{ id: 'all', label: 'All hosts', count: hosts.length }];
  for (const k of EDGE_CLASS_ORDER) {
    const n = counts.get(k);
    if (n) chips.push({ id: k, label: EDGE_CLASS_LABEL[k], count: n });
  }
  return chips;
}

/** True when the server classified hosts at all — decides between class chips and the legacy group chips. */
export function hostsAreClassified(hosts: IngressHost[]): boolean {
  return hosts.some(h => h.edgeClass !== undefined);
}

/* ------------------------------------------------------------------ failure buckets */

export const BUCKET_ORDER: readonly FailureBucket[] = ['app-failed', 'not-routed', 'policy-blocked', 'tls-rejected', 'direct-ip'];

export const BUCKET_LABEL: Record<FailureBucket, string> = {
  'app-failed': 'App failed',
  'not-routed': 'Not routed',
  'policy-blocked': 'Refused by policy',
  'tls-rejected': 'Rejected at TLS',
  'direct-ip': 'Direct IP / unknown host'
};

export const BUCKET_WHY: Record<FailureBucket, string> = {
  'app-failed': 'App traffic that got a 5xx, or an upstream flag (UF, URX, UT, UH): the workload or the path to it failed. Look here first.',
  'not-routed': 'App traffic answered 404 or NR on a known host: the Gateway admitted it and no route matched the path.',
  'policy-blocked': 'Refused by an AuthorizationPolicy (rbac_access_denied). The allowlist doing its job; counted, not a fault.',
  'tls-rejected': 'Turned away at the listener before any HTTP was parsed. Scanners and SNI-less probes; counted, not a fault.',
  'direct-ip': 'No Host header, an IP as the Host, or a Host no Gateway admits (missing_host_header, DPE): scanners and misdialled clients, not the app.'
};

export const BUCKET_TONE: Record<FailureBucket, Tone> = {
  'app-failed': 'bad',
  'not-routed': 'warn',
  'policy-blocked': 'unknown',
  'tls-rejected': 'unknown',
  'direct-ip': 'warn'
};

/** Refusals start collapsed: they are the edge working, and they would bury the two buckets above. */
export const BUCKET_COLLAPSED: Record<FailureBucket, boolean> = {
  'app-failed': false,
  'not-routed': false,
  'policy-blocked': true,
  'tls-rejected': true,
  'direct-ip': true
};

export interface BucketGroup {
  bucket: FailureBucket | 'unclassified';
  groups: TrafficErrorGroup[];
  /** Requests, not rows: a row is a distinct failure and can stand for hundreds. */
  requests: number;
}

/**
 * Failure groups by bucket, in bucket order, empty buckets dropped. Groups the server sent without a
 * bucket (an older srv, or a sidecar line it did not classify) land in `unclassified`, last — never
 * guessed into a bucket here.
 */
export function bucketFailures(groups: TrafficErrorGroup[]): BucketGroup[] {
  const by = new Map<BucketGroup['bucket'], TrafficErrorGroup[]>();
  for (const g of groups) {
    const k = g.bucket ?? 'unclassified';
    const list = by.get(k);
    if (list) list.push(g);
    else by.set(k, [g]);
  }
  const order: BucketGroup['bucket'][] = [...BUCKET_ORDER, 'unclassified'];
  return order
    .filter(k => by.has(k))
    .map(k => {
      const list = by.get(k) ?? [];
      return { bucket: k, groups: list, requests: list.reduce((n, g) => n + g.count, 0) };
    });
}

/** Whether the server buckets failures at all. */
export function failuresAreBucketed(groups: TrafficErrorGroup[]): boolean {
  return groups.some(g => g.bucket !== undefined);
}

/**
 * What the buckets panel can say. `unread` is no failures payload at all (loading, or its read
 * failed). `empty` is a window with no failing group, which proves nothing about the server; only
 * groups present without a bucket mean an older srv.
 */
export function failureBucketState(
  groups: TrafficErrorGroup[] | undefined,
  /** `accessLogEvidence(...).noEvidence`: no log was proved readable, so an empty list proves nothing. */
  noEvidence = false
): 'unread' | 'unproven' | 'empty' | 'bucketed' | 'legacy' {
  if (!groups) return 'unread';
  if (!groups.length) return noEvidence ? 'unproven' : 'empty';
  return failuresAreBucketed(groups) ? 'bucketed' : 'legacy';
}

/**
 * The upstream targets behind the failures an operator owns, busiest first: Envoy's own cluster name
 * (`outbound|8080||svc.ns.svc.cluster.local`) with the flags and codes it carried.
 */
export function failingUpstreams(groups: TrafficErrorGroup[]): { target: string; requests: number; codes: number[]; flags: string[]; hosts: string[] }[] {
  const by = new Map<string, { target: string; requests: number; codes: Set<number>; flags: Set<string>; hosts: Set<string> }>();
  for (const g of groups) {
    if (g.bucket !== 'app-failed' && g.bucket !== 'not-routed') continue;
    const target = g.upstream?.raw ?? 'no upstream chosen';
    const e = by.get(target) ?? { target, requests: 0, codes: new Set(), flags: new Set(), hosts: new Set() };
    e.requests += g.count;
    e.codes.add(g.code);
    for (const f of g.responseFlags) for (const one of f.split(',')) if (one.trim() && one.trim() !== '-') e.flags.add(one.trim());
    if (g.authority) e.hosts.add(g.authority);
    by.set(target, e);
  }
  return [...by.values()]
    .sort((a, b) => b.requests - a.requests || a.target.localeCompare(b.target))
    .map(e => ({ target: e.target, requests: e.requests, codes: [...e.codes].sort((a, b) => a - b), flags: [...e.flags].sort(), hosts: [...e.hosts].sort() }));
}

/* ------------------------------------------------------------------ load balancer */

export interface LbAddressRow {
  address: string;
  /** `hostname` is looked up by srv; `ip` is what the provider published, with nothing to resolve. */
  kind: 'hostname' | 'ip';
  ips: string[];
  resolvedAt: string | null;
  error: string | null;
}

/**
 * Every address the gateway's load balancer publishes: the hostnames with srv's lookup, then the
 * IPs an Azure or GCP load balancer publishes directly. `ips` is absent from an older srv.
 */
export function lbAddressRows(lb: IngressLb): LbAddressRow[] {
  const hostnames: LbAddressRow[] = lb.dns.map(d => ({ address: d.hostname, kind: 'hostname', ips: d.ips, resolvedAt: d.resolvedAt, error: d.error }));
  const ips: LbAddressRow[] = (lb.ips ?? []).map(ip => ({ address: ip, kind: 'ip', ips: [ip], resolvedAt: null, error: null }));
  return [...hostnames, ...ips];
}

/* ------------------------------------------------------------------ peers (D1) */

/** An external peer, whichever way the server marks it. */
export function isExternalPeer(p: Pick<IngressClient, 'kind' | 'external'> | Pick<TrafficEndpoint, 'kind'>): boolean {
  return p.kind === 'external' || ('external' in p && p.external === true);
}

/**
 * The address to print for a peer, or `null`.
 *
 * The only way an ingress screen may read a peer's address. External peers are counted, never
 * addressed (D1) — and that holds even against an older srv that still sends their IPs, because the
 * refusal is here rather than on the wire alone.
 */
export function peerAddress(p: { ip: string | null; kind: string; external?: boolean }): string | null {
  if (p.kind === 'external' || p.external === true) return null;
  return p.ip;
}

/** The peer rows a screen may list: internal ones, plus at most the one collapsed external row. */
export function listablePeers(clients: IngressClient[]): { rows: IngressClient[]; externalHidden: number } {
  const rows: IngressClient[] = [];
  let externalHidden = 0;
  for (const c of clients) {
    if (!isExternalPeer(c)) rows.push(c);
    else if (c.ip === null && c.key === 'external') rows.push(c);
    else externalHidden += 1;
  }
  return { rows, externalHidden };
}

/* ------------------------------------------------------------------ gaps */

/** A tile/panel status for a field this server does not send. */
export function notFromServer(what: string): MetricStatus {
  return {
    state: 'unavailable',
    what,
    why: `${what} is not reported by this server — srv predates the classified edge; rebuild srv to see it`,
    blind: 1,
    total: 1,
    truncated: false,
    truncatedWhy: ''
  };
}

/** A tile/panel status for `ingress.app: null`: the Gateways and routes reads both failed, so no request can be called app traffic. */
export function routingUnread(what: string): MetricStatus {
  return {
    ...notFromServer(what),
    why: `${what}: routing unread — the Gateways and routes reads both failed, so app traffic cannot be told from probes, platform hosts or refusals`
  };
}

/** A tile/panel status for a read the server made and failed. `null` when the block is fine. */
export function readFailed(what: string, block: { unavailable: boolean; reason: string | null } | undefined): MetricStatus | null {
  if (!block) return notFromServer(what);
  if (!block.unavailable) return null;
  return {
    state: 'unavailable',
    what,
    why: block.reason ? `could not read ${what}: ${block.reason}` : `could not read ${what}`,
    blind: 1,
    total: 1,
    truncated: false,
    truncatedWhy: ''
  };
}
