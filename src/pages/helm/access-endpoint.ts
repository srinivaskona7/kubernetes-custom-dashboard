/**
 * The address an operator can actually type to reach this release.
 *
 * ## Where it comes from
 *
 * One field on one Kind: a Kyma `APIRule`'s facts, as `/helm/related` returns them. `forwardedHost`
 * is the `x-forwarded-host` the APIRule's rules set, which is the external name; `spec.hosts` is
 * what the APIRule declares, which on a rewriting rule is the cluster-internal one. So
 * `forwardedHost` wins and `hosts[0]` is the fallback, and the resolved endpoint carries which of
 * the two it used — an operator debugging a 404 needs to know whether they are looking at the name
 * the gateway matches or the name it forwards.
 *
 * ## The scheme is an assumption, and says so
 *
 * A manifest nowhere states `http` or `https`. An APIRule with no TLS block still reaches an
 * HTTPS-terminating Kyma gateway in every deployment this console has seen, so `https` is the only
 * useful guess — but it is a guess, `schemeAssumed` is therefore always true, and the UI prints that
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
  source: 'x-forwarded-host' | 'spec.hosts';
  /** The APIRule that declared it, for the tooltip — a release may have several. */
  apiRule: string;
  /** How many APIRules in this release declared a host at all. */
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

/**
 * The release's access endpoint, or null.
 *
 * Deterministic when a release has several APIRules: an `x-forwarded-host` beats a `spec.hosts`
 * whichever APIRule it is on, and within a tie the APIRule names sort. An arbitrary pick would give
 * two operators two different answers off the same cluster.
 */
export function resolveAccessEndpoint(resources: HelmRelatedResource[] | undefined | null): AccessEndpoint | null {
  const rules = (resources ?? [])
    .filter(r => r.kind === 'APIRule')
    .map(r => {
      const facts = (r.facts ?? {}) as Record<string, unknown>;
      const forwarded = firstString(facts.forwardedHost);
      const declared = firstString(facts.hosts);
      const host = forwarded ?? declared;
      return host === null
        ? null
        : {
            host,
            source: (forwarded ? 'x-forwarded-host' : 'spec.hosts') as AccessEndpoint['source'],
            apiRule: r.name
          };
    })
    .filter((r): r is { host: string; source: AccessEndpoint['source']; apiRule: string } => r !== null)
    .sort(
      (a, b) =>
        (a.source === 'x-forwarded-host' ? 0 : 1) - (b.source === 'x-forwarded-host' ? 0 : 1) ||
        a.apiRule.localeCompare(b.apiRule)
    );

  const best = rules[0];
  if (!best) return null;
  return {
    host: best.host,
    url: addressable(best.host) ? `https://${best.host}` : null,
    source: best.source,
    apiRule: best.apiRule,
    candidates: rules.length,
    schemeAssumed: true
  };
}

/** The endpoint pill's tooltip — every caveat in one string, because the pill itself is four words. */
export function endpointTitle(endpoint: AccessEndpoint): string {
  const parts = [
    `${endpoint.host} — read from ${endpoint.source} on APIRule/${endpoint.apiRule}.`,
    endpoint.url
      ? 'The scheme is this console’s assumption: no manifest field states http or https.'
      : 'Not linked: this host is a matching pattern rather than an address, so there is nothing to open.'
  ];
  if (endpoint.candidates > 1) {
    parts.push(`${endpoint.candidates} APIRules in this release declare a host; the Resources tab lists them all.`);
  }
  return parts.join(' ');
}
