/**
 * The address an operator can actually type to reach this release.
 *
 * ## Where it comes from
 *
 * The `hosts` fact of the release's routes, as `/helm/related` returns them: an Ingress's
 * `spec.rules[].host` or a Gateway API HTTPRoute's `spec.hostnames`. Those are the names a client
 * types. A VirtualService is deliberately not read — its `hosts` is as often the in-mesh Service
 * name as an external one, and a pill that links `app.ns.svc.cluster.local` goes nowhere. The
 * resolved endpoint carries which field and which object it came from, because an operator
 * debugging a 404 needs to know which route they are looking at.
 *
 * ## The scheme is an assumption, and says so
 *
 * A route nowhere states `http` or `https` for certain — TLS can terminate at a load balancer the
 * manifest never mentions — so `https` is the only useful guess — but it is a guess, `schemeAssumed` is therefore always true, and the UI prints that
 * beside the link rather than letting a rendered `https://` imply the manifest said so.
 *
 * ## No host, no link
 *
 * `null` rather than an empty pill when nothing named a host, and `url: null` when the host is
 * present but not addressable as typed — a wildcard (`*.example.com`) is a matching pattern, not an
 * address, and turning one into an href invents a hostname that resolves to nothing.
 */
import type { HelmRelatedResource } from '../../api';

export interface AccessEndpoint {
  /** The host exactly as the manifest states it. Never normalised, never completed. */
  host: string;
  /** `https://host`, or null when the host is not addressable as written. */
  url: string | null;
  /** Which field the host came from, in the manifest's own vocabulary. */
  source: 'spec.rules[].host' | 'spec.hostnames';
  /** `Kind/name` of the route that declared it, for the tooltip — a release may have several. */
  route: string;
  /** How many routes in this release declared a host at all. */
  candidates: number;
  /** Always true: the scheme is this console's assumption, not a field it read. */
  schemeAssumed: true;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstString(item);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Whether this host can be put in an `href` as written.
 *
 * A wildcard is a pattern; a value carrying a scheme, a path or whitespace is not a bare host and
 * this console would be guessing at what the operator meant by it. Either way the host is still
 * shown and still copyable — it is the *link* that is withheld, not the fact.
 */
function addressable(host: string): boolean {
  if (/[*\s/\\?#@]/.test(host)) return false;
  // A trailing `:8080` is part of an address; anything else with a colon is not a bare host.
  const bare = host.replace(/:\d+$/, '');
  return !bare.includes(':') && bare.includes('.');
}

/** The route kinds read, in precedence order, and the manifest field each one's `hosts` fact is. */
const ROUTE_SOURCE: Record<string, AccessEndpoint['source']> = {
  Ingress: 'spec.rules[].host',
  HTTPRoute: 'spec.hostnames'
};
const ROUTE_RANK: Record<string, number> = { Ingress: 0, HTTPRoute: 1 };

/**
 * The release's access endpoint, or null.
 *
 * Deterministic when a release has several routes: an Ingress beats an HTTPRoute, and within a
 * kind the names sort. An arbitrary pick would give two operators two different answers off the
 * same cluster.
 */
export function resolveAccessEndpoint(resources: HelmRelatedResource[] | undefined | null): AccessEndpoint | null {
  const routes = (resources ?? [])
    .filter(r => r.kind in ROUTE_SOURCE)
    .map(r => {
      const facts = (r.facts ?? {}) as Record<string, unknown>;
      const host = firstString(facts.hosts);
      return host === null ? null : { host, kind: r.kind, name: r.name };
    })
    .filter((r): r is { host: string; kind: string; name: string } => r !== null)
    .sort((a, b) => (ROUTE_RANK[a.kind] ?? 9) - (ROUTE_RANK[b.kind] ?? 9) || a.name.localeCompare(b.name));

  const best = routes[0];
  if (!best) return null;
  return {
    host: best.host,
    url: addressable(best.host) ? `https://${best.host}` : null,
    source: ROUTE_SOURCE[best.kind] ?? 'spec.rules[].host',
    route: `${best.kind}/${best.name}`,
    candidates: routes.length,
    schemeAssumed: true
  };
}

/** The endpoint pill's tooltip — every caveat in one string, because the pill itself is four words. */
export function endpointTitle(endpoint: AccessEndpoint): string {
  const parts = [
    `${endpoint.host} — read from ${endpoint.source} on ${endpoint.route}.`,
    endpoint.url
      ? 'The scheme is this console’s assumption: no manifest field states http or https.'
      : 'Not linked: this host is a matching pattern rather than an address, so there is nothing to open.'
  ];
  if (endpoint.candidates > 1) {
    parts.push(`${endpoint.candidates} routes in this release declare a host; the Resources tab lists them all.`);
  }
  return parts.join(' ');
}
