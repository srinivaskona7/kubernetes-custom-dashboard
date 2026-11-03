/**
 * What the Traffic Errors filter bar means, with no JSX so it can be proved.
 *
 * `app/fleet-ui` runs vitest with `environment: 'node'` — jsdom cannot be installed on this
 * workstation (npm E401 against the internal registry) — so every rule lives here and
 * `TrafficErrorsPage.tsx` renders the answers without deciding any of them. These rules are worth
 * proving rather than eyeballing: the request's own example, "Namespace = acme-shop, Status = 5xx,
 * Time = Last 6 hours must show only matching data", is a composition question, and a composition of
 * four predicates is exactly where one of them quietly wins.
 *
 * ## Five fixed time ranges, and no Custom — a deliberate omission
 *
 * The request lists a sixth option, Custom. It is not here, and its absence is a decision rather
 * than an oversight. `sinceSeconds` is a *duration ending now*, not a window with an end, so a
 * custom range needs a second backend parameter that does not exist yet plus a date-time picker to
 * fill it. The alternative — accept a custom range in the UI and round it to the nearest fixed
 * window — answers a different question than the operator asked with nothing on screen admitting it,
 * which is the failure this console exists to prevent. Five ranges that are true beat six where one
 * lies. Restoring Custom starts at the route, not here.
 *
 * ## STATUS is the backend's `class`, never a number this module bands
 *
 * `class` is already `client` / `server` / `no-response` on every group. Re-deriving it from `code`
 * here would be a second answer to a question the payload has answered, and the two would disagree
 * the first time a 3xx — or a code this module never considered — appears. The request's labels
 * ("4xx", "5xx", "No HTTP response") are labels; the values are classes.
 *
 * `no-response` is its own category, in neither 4xx nor 5xx: `response_code: 0` is a connection
 * Envoy never answered, and folding it into 5xx would invent a server error nobody served.
 *
 * ## The namespace predicate runs on BOTH sides, and that is not a duplicate
 *
 * The read is already scoped server-side: `?namespace=X` reaches `selectProxies` in
 * `srv/fleet/collectors/traffic.js`, which drops every candidate pod outside `X`, and records come
 * only from the pods it selected. For a one-namespace selection {@link filterGroups} is therefore a
 * no-op, so the two sides cannot disagree.
 *
 * It still has to run, for two reasons. The query parameter takes **one** namespace (`api.ts`,
 * `clusterTrafficErrors`) while this control is a multi-select, so a two-namespace selection cannot
 * be expressed in a request at all and client-side is the only place it can apply. And `groupKey` in
 * the collector is code+method+authority+path+upstream with no proxy in it, so one group aggregates
 * records from every proxy that saw that failure shape, in any namespace — membership is group-level
 * OR over `proxies[].namespace`, not one value to compare.
 *
 * What it deliberately does not do: `count` still totals records from every proxy in the group,
 * including proxies outside the selection. Rewriting it would return a group whose count disagreed
 * with its own `proxies[]`, `p50Ms` and `firstSeen`. The scoped server read is the honest way to a
 * scoped count; the expanded row has `proxies[].count` for the breakdown.
 *
 * ## What SEARCH can and cannot reach
 *
 * The request names "route name". **There is no `route` field on the wire** — absent on all 430
 * groups, not null — so no needle can reach it, and nothing here pretends otherwise. "namespace"
 * resolves to two different namespaces and both are searched; see {@link filterGroups}.
 */
import type { TrafficErrorGroup, TrafficWindow } from '../../../api';
import { matchesNamespace } from '../../../components/namespace-filter';

/** The classes the backend assigns, plus the absence of a filter. `all` is not a class. */
export type StatusFilter = 'all' | 'client' | 'server' | 'no-response';

/** The five windows the route can actually read. No `custom` — see the module header. */
export type TimeRangeId = '15m' | '1h' | '6h' | '24h' | '7d';

export interface TrafficFilterState {
  /**
   * The namespaces of the proxies that **logged** the records, not of the traffic. The control is
   * labelled "Proxy namespace" for that reason. An empty set means "all", which is the invariant
   * `components/namespace-filter.ts` establishes and the one thing that makes the default state and
   * the cleared state a single state.
   */
  namespaces: ReadonlySet<string>;
  range: TimeRangeId;
  status: StatusFilter;
  /** `all`, or a verb observed in this window. Never a verb from a fixed list — see {@link methodOptions}. */
  method: string;
  search: string;
}

/**
 * The ranges, with the `sinceSeconds` each one sends.
 *
 * One list, so the label an operator reads and the number the route receives can never drift apart.
 * The route clamps anything below 1 to "no restriction" and imposes no ceiling, so all five arrive
 * intact.
 */
export const TIME_RANGES: readonly { id: TimeRangeId; label: string; seconds: number }[] = [
  { id: '15m', label: 'Last 15 minutes', seconds: 900 },
  { id: '1h', label: 'Last 1 hour', seconds: 3600 },
  { id: '6h', label: 'Last 6 hours', seconds: 21600 },
  { id: '24h', label: 'Last 24 hours', seconds: 86400 },
  { id: '7d', label: 'Last 7 days', seconds: 604800 }
];

/** Requirement 3's default. Named, so {@link activeTrafficFilters} and Clear filters share one source. */
const DEFAULT_RANGE: TimeRangeId = '24h';

/**
 * The open state: nothing filtered, the default 24h window.
 *
 * This is also what Clear filters restores, so {@link activeTrafficFilters} must return 0 for it —
 * a Clear that left a filter behind, or a badge counting a filter Clear does not touch, are the same
 * bug seen from two sides.
 */
export const DEFAULT_TRAFFIC_FILTERS: TrafficFilterState = {
  namespaces: new Set<string>(),
  range: DEFAULT_RANGE,
  status: 'all',
  method: 'all',
  search: ''
};

/**
 * The `sinceSeconds` to send. Genuinely server-side: this is the one filter that changes what is
 * read rather than what is shown.
 *
 * An unrecognised id falls back to the default rather than returning `NaN` or 0: the state can
 * arrive from a URL, and `?range=lastweek` must read the default window instead of sending a value
 * the API server rejects — which failed *every* proxy read and reported a cluster-wide read failure
 * for a bad query string.
 */
export function sinceSecondsFor(state: TrafficFilterState): number {
  const found = TIME_RANGES.find(r => r.id === state.range);
  if (found) return found.seconds;
  const fallback = TIME_RANGES.find(r => r.id === DEFAULT_RANGE);
  return fallback ? fallback.seconds : 86400;
}

/** The label beside the range, for the chip and for {@link coverageNote}. */
function rangeLabel(range: TimeRangeId): string {
  const found = TIME_RANGES.find(r => r.id === range);
  return found ? found.label : rangeLabelOfDefault();
}

function rangeLabelOfDefault(): string {
  const found = TIME_RANGES.find(r => r.id === DEFAULT_RANGE);
  return found ? found.label : 'the selected range';
}

/**
 * The METHOD options: the verbs actually observed, with `all` first. Never a fixed list.
 *
 * The request names seven verbs. Only `GET`, `HEAD`, `POST` and null appear on this cluster, and a
 * dropdown offering PATCH invites the operator to select it, see an empty table, and conclude there
 * are no PATCH failures — when the truth is that no PATCH request was observed at all. Those are
 * different findings and the control must not blur them. Deriving from the data also means the
 * dropdown cannot go stale when a workload starts speaking a verb nobody predicted.
 *
 * Sorted alphabetically, not by volume: a dropdown that reorders itself between two reads destroys
 * the muscle memory of the operator using it during an incident.
 *
 * A group whose `method` is null (3 of 430) contributes no option — a chip reading "—" cannot be
 * understood — and stays visible under `all`. See {@link filterGroups}.
 */
export function methodOptions(groups: readonly TrafficErrorGroup[]): string[] {
  const seen = new Set<string>();
  for (const g of groups) {
    if (typeof g.method === 'string' && g.method.length > 0) seen.add(g.method);
  }
  // Deduped by exact spelling, kept verbatim. Envoy logs uppercase verbs; normalising the case here
  // would let the dropdown offer a spelling no record used, and the predicate below matches
  // case-insensitively anyway.
  return ['all', ...[...seen].sort((a, b) => a.localeCompare(b))];
}

/**
 * Whether the METHOD control is filtering at all.
 *
 * Shared with {@link activeTrafficFilters} on purpose: a definition of "open" that the badge and the
 * predicate hold separately is the drift that makes "1 filter active" show every row. An empty
 * string counts as open so a cleared URL parameter cannot come to mean "only groups with no method".
 */
function methodIsOpen(method: string): boolean {
  const v = method.trim().toLowerCase();
  return v.length === 0 || v === 'all';
}

/** The needle, normalised once per pass rather than once per group. */
function needleOf(search: string): string {
  return search.trim().toLowerCase();
}

function matchesStatus(group: TrafficErrorGroup, status: StatusFilter): boolean {
  if (status === 'all') return true;
  return group.class === status;
}

/**
 * Case-insensitive, because the value can arrive from a hand-edited URL where `get` is the natural
 * thing to type, and a filter that silently matches nothing for a spelling difference reads as "no
 * GET failures".
 */
function matchesMethod(group: TrafficErrorGroup, method: string): boolean {
  if (methodIsOpen(method)) return true;
  if (typeof group.method !== 'string') return false;
  return group.method.toLowerCase() === method.trim().toLowerCase();
}

/**
 * Group-level OR over the namespaces of the proxies that logged the records.
 *
 * The early return is not redundant with `matchesNamespace`: `[].some()` is `false`, so a group that
 * somehow carried no proxies would vanish under an *empty* selection, which is the state that must
 * show everything. Membership itself is `matchesNamespace`'s to decide — one module owns the three
 * rules (empty is all, several are OR, no namespace is cluster-scoped), and
 * `test/fleet/namespace-filter-standard.test.js` fails the build on a second opinion.
 */
function matchesProxyNamespace(group: TrafficErrorGroup, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  return group.proxies.some(p => matchesNamespace(p.namespace, selected));
}

/**
 * Every field a needle reaches, and why each one is here.
 *
 * - `path`, `authority` — the request's PATH and HOST. `authority` is the field; there is no `host`.
 * - `code` — not in the request's list, and load-bearing anyway: the breakdown panels hand back a
 *   numeric code and STATUS cannot express one, so the needle is the only filter a code can land in.
 * - `upstream.raw` and the Service it resolved to — the request's UPSTREAM. `raw` is
 *   `direction|port|subset|FQDN`, so searching it covers the FQDN and subset without four separate
 *   probes; `service.name` is the name an operator actually knows.
 * - `gateway.name` / `.host` / `.namespace` — populated on 381 of 430 groups where `upstream` is
 *   populated on 1, so this is the field that answers "which upstream served this".
 * - `destination.name` / `.ip` / `.namespace` — the request's DESTINATION.
 * - `responseCodeDetails`, `responseFlags`, `transportFailures` — the request's "response details",
 *   plus the short flags (`NR`, `DC`, `DPE`) an operator types verbatim from Envoy's documentation.
 * - `proxies[].pod` / `.namespace` — the request's PROXY, and one of the two namespaces below.
 * - `sources[].name` / `.ip` / `.namespace` — the client side, and the *other* namespace.
 * - `samples` — Envoy request ids. An operator often arrives holding an `x-request-id` from a user
 *   report and nothing else, and this is the only way to get from it to the group.
 *
 * "namespace" is two different fields and both are searched, because neither is the one the word
 * implies: `proxies[].namespace` is the proxy that logged the record (always `istio-system` here) and
 * `sources[].namespace` is the client's (non-null on 1 of 430 groups). Neither is "the namespace the
 * traffic belongs to" — no such field exists on a failure group, which is why the column was dropped.
 *
 * Deliberately not searched: `method` and `class`, each of which has its own control, and where a
 * substring would hijack a needle meant for a path; `route`, which is not on the wire; and `key`,
 * which is a join of fields already searched above.
 */
function matchesSearch(group: TrafficErrorGroup, needle: string): boolean {
  if (!needle) return true;
  const hit = (v: string | number | null | undefined): boolean =>
    v !== null && v !== undefined && String(v).toLowerCase().includes(needle);
  return (
    hit(group.path) ||
    hit(group.authority) ||
    hit(group.code) ||
    hit(group.upstream?.raw) ||
    hit(group.upstream?.service?.name) ||
    hit(group.gateway?.name) ||
    hit(group.gateway?.host) ||
    hit(group.gateway?.namespace) ||
    hit(group.destination?.name) ||
    hit(group.destination?.ip) ||
    hit(group.destination?.namespace) ||
    group.responseCodeDetails.some(hit) ||
    group.responseFlags.some(hit) ||
    group.transportFailures.some(hit) ||
    group.proxies.some(p => hit(p.pod) || hit(p.namespace)) ||
    group.sources.some(s => hit(s.name) || hit(s.ip) || hit(s.namespace)) ||
    group.samples.some(hit)
  );
}

/**
 * The rows a filter state keeps. AND across the four controls, so requirement 3's example holds.
 *
 * Cheapest predicate first — two string compares, then a Set lookup, then the needle, which is the
 * only one that touches nested arrays. The order changes the cost and never the answer, since AND
 * commutes; a test pins that, because "the filters work together" is precisely the claim a reordering
 * refactor breaks silently.
 *
 * Returns a filtered array and never a copy of the input, so the shell can memoise on
 * `[groups, state]` and a re-render with an unchanged state is free. The time range is absent from
 * this function on purpose: it is served by `sinceSeconds` and re-reads the proxies, so filtering by
 * timestamp here as well would hide records the operator explicitly asked to read.
 */
export function filterGroups(
  groups: readonly TrafficErrorGroup[],
  state: TrafficFilterState
): TrafficErrorGroup[] {
  const needle = needleOf(state.search);
  return groups.filter(
    g =>
      matchesStatus(g, state.status) &&
      matchesMethod(g, state.method) &&
      matchesProxyNamespace(g, state.namespaces) &&
      matchesSearch(g, needle)
  );
}

/**
 * How many filters Clear filters would clear. 0 for the default state, by construction.
 *
 * One control counts once. A namespace multi-select with three namespaces ticked is one active
 * filter, not three: the badge sits next to Clear filters and answers "how many things will this
 * button change", and a badge that grew to 3 for one control would read as three separate filters
 * the operator has to hunt for.
 *
 * The range counts too, even though clearing it costs a re-read. A Clear that silently left a 15
 * minute window in place while the badge said nothing was filtered would leave the operator reading
 * a window fifteen times narrower than the one they believe they are looking at.
 */
export function activeTrafficFilters(state: TrafficFilterState): number {
  let n = 0;
  if (state.namespaces.size > 0) n += 1;
  if (state.range !== DEFAULT_RANGE) n += 1;
  if (state.status !== 'all') n += 1;
  if (!methodIsOpen(state.method)) n += 1;
  if (needleOf(state.search).length > 0) n += 1;
  return n;
}

/**
 * The fraction of the requested range that counts as covered. Justified in {@link coverageNote};
 * named here so the number is changed in one place and reads as a decision rather than a magic 0.8.
 */
const COVERED_ENOUGH = 0.8;

/**
 * How much of the requested range the read actually covered, when it is materially less. `null` when
 * the window genuinely covers the selection.
 *
 * This is load-bearing, not a nicety. `tailLines` caps each proxy at ≤1000 lines, so "Last 7 days"
 * does not read seven days — it reads the last ≤1000 lines that fall inside seven days. On the live
 * cluster a 24h selection currently covers about 13h. An operator who reads "Last 24 hours" on the
 * chip, sees no 5xx and concludes the last day was clean has been misled by the control, which is
 * the exact failure this console exists to prevent.
 *
 * Fires below 80% coverage. The threshold is not zero-tolerance because `oldest` is the first
 * *record*, not the start of the range: a quiet window legitimately reports a shorter span with
 * nothing truncated, and a note that fires on every read is a note nobody reads — which brings the
 * over-promising chip straight back. A fifth of the range missing is larger than any plausible quiet
 * edge on a cluster that logged anything at all, and the live 13h-of-24h case (54%) clears it wide.
 *
 * Two causes, two sentences, because they call for opposite actions. `truncatedProxies > 0` is a
 * measurement that older records exist and were not read — narrow the range or raise the tail. Zero
 * truncated proxies means the logs that were read hold nothing older, so widening the range will not
 * help. Neither sentence guesses: `truncatedProxies` is set by the collector when a tail came back
 * full, and §5's "never infer a cause" is honoured by reporting only what the window recorded.
 */
export function coverageNote(w: TrafficWindow | undefined, state: TrafficFilterState): string | null {
  // No window, or a window with no record in it, is a different statement — "nothing was read" —
  // and the page's own unavailable state owns it. A coverage note here would be a second, quieter
  // version of it, in a place the operator reads as a footnote.
  if (!w || !w.oldest || !w.newest) return null;
  const oldest = Date.parse(w.oldest);
  const newest = Date.parse(w.newest);
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return null;

  const covered = Math.max(0, Math.round((newest - oldest) / 1000));
  const requested = sinceSecondsFor(state);
  if (covered >= requested * COVERED_ENOUGH) return null;

  const head = `${rangeLabel(state.range)} requested; the records read span ${spanText(covered)}.`;
  if (w.truncatedProxies > 0) {
    const proxies = `${w.truncatedProxies} of the ${w.proxiesRead} ${w.proxiesRead === 1 ? 'proxy' : 'proxies'} read`;
    return `${head} ${proxies} returned a full ${w.tailLines}-line tail, so older records inside the range were not read.`;
  }
  return `${head} No proxy reached its ${w.tailLines}-line cap, so the logs that were read hold nothing older — a wider range will not reach further back.`;
}

/**
 * A duration an operator can hold in their head.
 *
 * Two units at most, and the smaller unit dropped when it is zero. "47,520 seconds" and "13.2 hours"
 * both need arithmetic before they mean anything next to a chip reading "Last 24 hours".
 */
function spanText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
