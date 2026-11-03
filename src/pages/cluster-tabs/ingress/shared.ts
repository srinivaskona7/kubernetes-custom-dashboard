/**
 * The pure half of the ingress screens: what a group means, how a share reads, and which rows a
 * filter keeps.
 *
 * Extracted rather than inlined so it can be tested without a DOM. `app/fleet-ui`'s vitest runs in
 * `environment: 'node'` on purpose, so anything that has to be *proved* — the filter predicate, the
 * share formatter, the health verdict — lives here, and the `.tsx` files hold only markup. The
 * predicate especially: "which rows does the corporate chip show" is the kind of question that is obvious
 * until a host matches two groups, and a test is cheaper than a screenshot.
 */
import type { IngressAccess, IngressHost, IngressHostGroup, IngressRate, TrafficIngress } from '../../../api';
import type { Tone } from '../../../components/ui';

/** The filter chips, in the order they read. `all` is not a group; it is the absence of a filter. */
export type HostFilter = 'all' | IngressHostGroup;

/** Exact UTC value for evidence timestamps; pair with relative text for quick scanning. */
export function exactTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/**
 * What each bucket means, in the operator's words.
 *
 * `corporate` deliberately does not name a company: the suffixes come from
 * `FLEET_CORPORATE_DOMAIN_SUFFIXES` and differ per deployment, so a literal here would be wrong on
 * the next cluster onboarded and would read as authoritative while being wrong.
 */
export const GROUP_LABEL: Record<IngressHostGroup, string> = {
  corporate: 'Configured domains',
  declared: 'Cluster domains',
  infra: 'Cluster plumbing',
  address: 'Dialled by address',
  other: 'Unrecognised',
  none: 'No Host header'
};

export const GROUP_WHY: Record<IngressHostGroup, string> = {
  corporate:
    'The host ends in a suffix configured as yours, via FLEET_CORPORATE_DOMAIN_SUFFIXES. Nothing about the domain is baked into this console — set no suffixes and this bucket is empty rather than wrong.',
  declared:
    'An Istio Gateway in this cluster admits this host, and it matched no configured suffix. Usually the cluster’s own wildcard ingress domain.',
  infra:
    'Cluster plumbing rather than an application: health probes, the connectivity proxy, Kiali. Real traffic and almost never the traffic you came to look at — 620 of 1485 records in a live window.',
  address:
    'The Host header was an IP address, so somebody dialled the load balancer directly instead of using a name. Common for scanners and for a misconfigured probe.',
  other:
    'A Host header no Gateway in this cluster admits and no configured suffix matches. Either a domain that was pointed here and never declared, or a scanner trying a name at random.',
  none:
    'Envoy recorded no Host header at all. Every TCP connection lands here, and so does every TLS connection rejected before a request line was parsed — which is why this bucket is worth reading rather than hiding.'
};

export const GROUP_TONE: Record<IngressHostGroup, Tone> = {
  corporate: 'unknown',
  declared: 'ok',
  infra: 'unknown',
  address: 'warn',
  other: 'warn',
  none: 'unknown'
};

/**
 * Which hosts a chip keeps.
 *
 * Pure and total: every `HostFilter` has an answer, and `all` keeps everything including the
 * no-Host-header row. The search half matches the host, the matched suffix, the Gateway that admits
 * it and every object that declares it, because an operator searching "shop-rule" is looking for the
 * route by name and the host is what they do not know yet.
 */
export function matchesHostFilter(host: IngressHost, filter: HostFilter, needle: string): boolean {
  if (filter !== 'all' && host.group !== filter) return false;
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    host.host,
    host.key,
    host.matchedSuffix,
    host.gateway?.name,
    host.gateway?.namespace,
    ...host.servedBy.map(s => s.name),
    ...host.servedBy.map(s => s.namespace),
    ...host.methods,
    ...host.paths.map(p => p.path),
    ...host.codes.map(c => String(c.code)),
    ...host.flags
  ];
  return haystack.some(v => v && String(v).toLowerCase().includes(q));
}

/**
 * The chips to draw, with their counts — derived from the rows in hand, never from a fixed list.
 *
 * A chip for a group with no rows is a control that lands the operator on an empty table and blames
 * them for it, so an empty group is simply absent. `all` is always present and always first.
 */
export function hostFilterChips(hosts: IngressHost[]): { id: HostFilter; label: string; count: number }[] {
  const counts = new Map<IngressHostGroup, number>();
  for (const h of hosts) counts.set(h.group, (counts.get(h.group) ?? 0) + 1);
  const order: IngressHostGroup[] = ['corporate', 'declared', 'other', 'address', 'infra', 'none'];
  const chips: { id: HostFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All hosts', count: hosts.length }
  ];
  for (const g of order) {
    const n = counts.get(g);
    if (n) chips.push({ id: g, label: GROUP_LABEL[g], count: n });
  }
  return chips;
}

/**
 * A share, as a percentage string, or an em-dash when there is no share to state.
 *
 * `null` in, `—` out. `0` in, `0%` out. Those are different answers and the whole vocabulary of this
 * console rests on the difference: a host that served nothing has no error share, and a host that
 * served 500 requests with no failures has a share of exactly zero.
 */
export function share(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const pct = value * 100;
  // Below 1% but not zero, so it rounds to "0%" and reads as clean. One decimal keeps it honest.
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/**
 * How a host's error share should read.
 *
 * Deliberately not `band()` from `format.ts`: that one bands *utilisation*, where 70% is a warning
 * and 90% is trouble. An error share is not utilisation. A single 5xx on a host matters, and 100%
 * 403 on a host whose entire job is to reject unauthenticated callers is the system working.
 *
 * So the verdict leans on *which* family failed rather than on how much of it did. Server errors are
 * bad at any share; client errors are a warning only once they are the majority, because a scanner
 * being turned away is a healthy edge. `null` is `unknown`, never `ok`.
 */
export function hostTone(host: IngressHost): Tone {
  if (!host.requests) return 'unknown';
  if (host.server > 0) return 'bad';
  const clientShare = (host.client + host.noResponse) / host.requests;
  if (clientShare >= 0.5) return 'warn';
  if (clientShare > 0) return 'unknown';
  return 'ok';
}

/** The one-line verdict behind {@link hostTone}, for the cell's tooltip. */
export function hostWhy(host: IngressHost): string {
  if (!host.requests) return 'No record for this host in the window that was read.';
  if (host.server > 0) {
    return `${host.server} server error${host.server === 1 ? '' : 's'} (5xx) in this window. The workload behind the host is the place to look, not the Gateway.`;
  }
  const rejected = host.client + host.noResponse;
  if (!rejected) return `Every one of the ${host.requests} records read for this host was answered 2xx or 3xx.`;
  const pct = share(rejected / host.requests);
  if (host.noResponse > 0 && host.client === 0) {
    return `${host.noResponse} of ${host.requests} records (${pct}) produced no HTTP response at all — a connection dropped or a TLS handshake that never completed. Not an HTTP error.`;
  }
  return `${rejected} of ${host.requests} records (${pct}) were rejected with a 4xx or produced no response. A high share is not automatically a fault: a host whose job is to turn away unauthenticated callers looks exactly like this.`;
}

/**
 * The sentence to print for the request rate.
 *
 * Always returns something. A suppressed rate has a reason, and printing the reason where the number
 * would go is the whole point — an operator who sees "—" with no explanation assumes the feature is
 * broken, and one who sees a fabricated 0.0/s assumes the cluster is idle.
 */
export function rateLine(rate: IngressRate | undefined): { value: string; why: string } {
  if (!rate) return { value: '—', why: 'No ingress window was read, so there is nothing to divide.' };
  if (rate.suppressed || rate.perSecond === null) return { value: '—', why: rate.why };
  return { value: `${rate.perSecond}/s`, why: rate.why };
}

/**
 * Whether the ingress block has anything to say.
 *
 * `scope: 'none'` means no gateway pod contributed a record, and there is deliberately no fall back
 * to the whole mesh — so every count in `summary` is 0 because nothing was measured, not because
 * nothing happened. The screens must print the reason instead of the zeros, and this is the one
 * check they all share.
 */
export function ingressWasRead(ingress: TrafficIngress | undefined): boolean {
  return Boolean(ingress && ingress.scope === 'ingress' && ingress.summary.ingressProxies > 0);
}

/**
 * Why there is no ingress window, in the operator's terms.
 *
 * Three different causes land on the same empty screen and need three different sentences: no
 * gateway pod exists, the gateway pods exist but every log read was refused, or the gateways were
 * read and logged nothing.
 */
export function ingressGapWhy(ingress: TrafficIngress | undefined): string {
  if (!ingress) return 'No traffic payload was read for this cluster.';
  if (ingress.ingressProxiesUnread.length > 0) {
    return `Every ingress gateway pod this read selected refused its log: ${ingress.ingressProxiesUnread.join(', ')}. That is a statement about this reader's access, not about the edge — see Proxies read for the reason each one gave.`;
  }
  if (ingress.ingressProxiesSelected === 0) {
    return 'No pod in this cluster is an Istio ingress gateway, so there is no edge to read. Everything the Traffic tab can show comes from sidecars, which see east-west traffic only.';
  }
  return 'The ingress gateway was read and returned no request line in the window. Widen the window or re-read; a quiet edge and an unreadable log look the same from here, which is why this says "not read" rather than zero.';
}

/**
 * A byte total, or the honest gap.
 *
 * `null` means not one line recorded the field; `0` means lines did and the answer was zero.
 * `bytes_received` is genuinely 0 on every line of a live ingress window, because probes and plain
 * GETs carry no request body — so collapsing the two would turn a real measurement into a mystery
 * and a mystery into a confident zero.
 */
export function byteLine(total: number | null): { text: string; title: string } {
  if (total === null) {
    return {
      text: 'not recorded',
      title: 'No line in this window carried the byte count field. Not zero bytes — no measurement.'
    };
  }
  return { text: total.toLocaleString(), title: `${total.toLocaleString()} bytes across the records read.` };
}

/**
 * The tiles under Access control's External count, as parts that add up to it: allowed, refused by
 * a policy only, turned away at TLS only, and a remainder when the server's three leave some out.
 * An older srv sends no TLS-only count: that tile is `null` (unknown) and no remainder is guessed.
 */
export function externalPeerSplit(peers: IngressAccess['peers']): { key: 'allowed' | 'refused' | 'tls' | 'other'; label: string; value: number | null; why: string }[] {
  const tls = peers.externalTlsOnly ?? null;
  const refused = peers.externalBlockedOnly;
  const rows: ReturnType<typeof externalPeerSplit> = [
    { key: 'allowed', label: 'External, allowed', value: peers.externalAllowed, why: 'External peers with at least one request the policies let through.' },
    { key: 'refused', label: 'External, refused only', value: refused, why: 'External peers whose every request an AuthorizationPolicy refused. Usually scanners, and the allowlist doing its job.' },
    { key: 'tls', label: 'External, TLS only', value: tls, why: 'External peers that only ever opened a TLS connection the gateway turned away before any request. Scanners and SNI-less probes.' }
  ];
  const other = tls === null ? 0 : peers.external - peers.externalAllowed - refused - tls;
  if (other > 0) rows.push({ key: 'other', label: 'External, other', value: other, why: 'External peers in none of the three above: no request allowed, refused or rejected at TLS was attributed to them.' });
  return rows;
}
