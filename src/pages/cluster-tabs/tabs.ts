/**
 * The cluster page's tab vocabulary, extracted from `ClusterDetail.tsx` so that a tab can
 * *link to another tab* without importing the page that renders it.
 *
 * The ids are the `?tab=` values and are load-bearing: every deep link, every cross-tab
 * drill-down (`viewNode`, `viewLogs`, `viewWorkload`) and every Overview tile addresses a tab
 * by id. Group them however you like — never rename an id.
 */

import type { IconName } from '../../components/icons';

export type Tab =
  | 'overview'
  | 'nodes'
  | 'workloads'
  | 'network'
  | 'networking'
  | 'istio'
  | 'observability'
  | 'certificates'
  | 'storage'
  | 'logs'
  | 'traffic'
  | 'security'
  | 'helm'
  | 'traces'
  | 'cost'
  | 'tokens';

// Former tabs folded in rather than dropped, each into the tab that already answered the same
// question: `topology` -> `nodes`, `compliance` -> `security`, and `events` and `autoscaling` ->
// `workloads` (Autoscalers and CronJobs are sub-tabs there; `TAB_ALIASES` redirects old links).
// The old latency screen (then `observability`) and the `reliability` sub-tab were removed
// outright; `observability` now names the platform observability tab. `overview` summarises the
// rest and owns nothing, which is the property that keeps it from being redundant with them.
// `traffic` and `traces` remain in the type only while the alias layer accepts their old URLs.
export const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'nodes', label: 'Nodes & Topology' },
  // "Namespaces & Workloads": the tab opens on its namespace inventory, and a namespace is how an
  // operator scopes every workload question after it. The id stays `workloads` — it is a URL.
  { id: 'workloads', label: 'Namespaces & Workloads' },
  { id: 'network', label: 'Network Operations' },
  { id: 'networking', label: 'Networking' },
  { id: 'istio', label: 'Istio & Mesh' },
  { id: 'observability', label: 'Observability' },
  { id: 'certificates', label: 'Certificates' },
  { id: 'storage', label: 'Storage & Quotas' },
  { id: 'logs', label: 'Live Pod Logs' },
  { id: 'security', label: 'Security & Compliance' },
  // Helm releases are their own destination, not a table appended to another tab. A release is an object an operator investigates — resources, values, manifest, revision
  // history — and every one of those views is a page reached from this list, so burying the
  // list under another tab's heading cost a click and hid the entry point. Read-only: this tab
  // and everything under it view, compare and copy, and never install, upgrade or roll back.
  { id: 'helm', label: 'Helm Releases' },
  // "Credentials", not "Access & Tokens": the fleet rail already owns a destination spelled
  // "Access & Tokens" (layout.tsx `NAV_ITEMS`) and it goes somewhere else — every cluster's
  // token, side by side. Two controls one label apart, landing on different pages, is the
  // duplication this grouping exists to remove.
  // "Cost & Budget", and the tab says "estimate" on its own heading. Every figure here is modelled
  // from node shapes against a rate card held on the server — this console has no access to a cloud
  // provider invoice, so it can price what the cluster declares and nothing more.
  { id: 'cost', label: 'Cost & Budget' },
  { id: 'tokens', label: 'Credentials' }
];

export const TAB_IDS = new Set<string>(TABS.map(t => t.id));

/**
 * Retired `?tab=` ids that still have a home, and where that home is.
 *
 * An unknown `?tab=` falls silently to Overview, which looks deliberate, so a bookmark to a moved
 * screen is redirected instead. `section` is the default; a `?section=` the target tab owns wins,
 * so `?tab=autoscaling&section=cronjobs` keeps landing on CronJobs. `observability` has no entry:
 * its old latency screen was removed, not moved, and the id now opens the Observability tab (the
 * platform observability panels).
 *
 * `keep` marks a tab whose screens did not move one-for-one. Its links land on `section` whatever
 * they named (Top Utilization's `pods` and `namespaces` are ids on the target tab too, and meant a
 * different screen), and only the listed params survive: its own `u*` params, `res` and the rest
 * described a screen that no longer exists.
 */
export const TAB_ALIASES: Partial<Record<string, { tab: Tab; section: string; keep?: readonly string[]; set?: Record<string, string>; preserveSection?: boolean }>> = {
  autoscaling: { tab: 'workloads', section: 'hpas' },
  // Top Utilization's six sections were retired on 2026-09-25; its ranking lives on as a sub-tab.
  utilization: { tab: 'workloads', section: 'top', keep: ['ns'] },
  traffic: { tab: 'network', section: 'ingress', set: { networkView: 'edge' }, preserveSection: true },
  traces: { tab: 'network', section: 'journeys', set: { networkView: 'flows' }, preserveSection: true },
  // Modules & Telemetry was retired; its telemetry panels live on as the Observability tab.
  platform: { tab: 'observability', section: 'telemetry', keep: [] }
};

/** The params a retired `?tab=` should be replaced with, or `null` when it is not an alias. */
export function resolveTabAlias(params: URLSearchParams): URLSearchParams | null {
  const sourceTab = params.get('tab') ?? '';
  const alias = TAB_ALIASES[sourceTab];
  // Retired parent tabs take precedence so an old `traffic&section=listeners` bookmark reaches
  // Network Operations in one URL replacement, rather than first rewriting its old sub-tab.
  if (!alias) {
    const live = sectionAlias(sourceTab, params.get('section'));
    if (!live) return null;
    const out = new URLSearchParams(params);
    out.set('section', live.section);
    for (const [k, v] of Object.entries(live.set ?? {})) out.set(k, v);
    return out;
  }
  if (alias.keep) {
    const out = new URLSearchParams({ tab: alias.tab, section: alias.section });
    for (const k of alias.keep) {
      const v = params.get(k);
      if (v) out.set(k, v);
    }
    return out;
  }
  const out = new URLSearchParams(params);
  const sourceSection = params.get('section');
  const sourceSectionAlias = alias.preserveSection ? sectionAlias(sourceTab, sourceSection) : null;
  const movedSection = sourceSectionAlias?.section ?? sourceSection;
  const owned = (TAB_SECTIONS as Record<string, readonly { id: string }[]>)[alias.tab];
  out.set('tab', alias.tab);
  out.set('section', alias.preserveSection && movedSection ? movedSection : movedSection && owned?.some(s => s.id === movedSection) ? movedSection : alias.section);
  for (const [k, v] of Object.entries(sourceSectionAlias?.set ?? {})) out.set(k, v);
  for (const [k, v] of Object.entries(alias.set ?? {})) out.set(k, v);
  return out;
}

/**
 * Every tab's sub-section list, in one place.
 *
 * These arrays used to live in the ten components that render them, and that was fine until the
 * Overview tile grid needed to *name a section it does not own*. A tile that says "Admission &
 * policy" has to land on `?tab=security&section=admission`, and the only honest way to write that
 * link is against the same list the Security tab falls back through — `useSection` silently
 * replaces an id it does not recognise with its own default, so a mistyped destination does not
 * error, it lands somewhere else and looks deliberate. Three tiles pointing at the Security tab
 * all landed on `isolation` for exactly that reason: they named a tab and the tab picked the
 * section.
 *
 * So the vocabulary moved here and the components import it. `tabs.ts` already owns the tab ids for
 * the same reason (a tab can link to another tab without importing the page that renders it), and
 * this file imports nothing, so there is no cycle to create.
 *
 * Two invariants ride on this, both asserted in `test/fleet/overview-tile-destinations.test.js`:
 * every Overview destination names a section that exists here, and **the first entry of each list
 * is that tab's default** — components pass `SECTIONS[0].id` as the `useSection` fallback rather
 * than repeating the literal, so the two can never drift apart.
 */
export const TAB_SECTIONS = {
  nodes: [
    { id: 'overview', label: 'Overview', description: 'Summarizes node readiness, zones, pod capacity, and active conditions.' },
    { id: 'nodes', label: 'Nodes', description: 'Lists core/v1 Nodes with capacity, requests, taints, and kubelet details.' },
    { id: 'zones', label: 'Zones & Topology', description: 'Groups Nodes by topology zone and worker pool labels.' },
    { id: 'slots', label: 'Pod Slots', description: 'Compares scheduled pod counts with each Node pod-capacity ceiling.' },
    { id: 'conditions', label: 'Node Conditions', description: 'Shows Nodes reporting readiness or resource-pressure conditions.' },
    { id: 'taints', label: 'Taints', description: 'Lists the taints each Node declares, with how many Pods tolerate each one and how many are placed there.' },
    { id: 'tolerations', label: 'Tolerations', description: 'Lists Pods declaring a toleration beyond the two Kubernetes injects, with the Node each one runs on.' },
    { id: 'headroom', label: 'Headroom & Scheduling', description: 'Compares pod requests and current samples with allocatable capacity.' }
  ],
  workloads: [
    { id: 'namespaces', label: 'Namespaces', description: 'Lists every Namespace with its type, status, workload count, and CPU and memory against requests and limits.' },
    { id: 'workloads', label: 'Workloads', description: 'Lists Deployments, StatefulSets, and DaemonSets with readiness and usage.' },
    { id: 'pods', label: 'Pods', description: 'Lists the Pods owned by the collected workload controllers, with CPU and memory against requests and limits, containers and warning Events.' },
    { id: 'top', label: 'Top Consumers', description: 'Ranks pods by their current CPU and memory sample, with each one set against its request and limit.' },
    // Autoscaling & Jobs was its own tab; its two sections live here now, ids unchanged.
    { id: 'hpas', label: 'Autoscalers', description: 'Reads autoscaling/v2 HPAs, targets, replica bounds, and conditions.' },
    { id: 'cronjobs', label: 'CronJobs', description: 'Reads batch/v1 CronJobs, their schedule, and their last scheduled and last successful times.' },
    { id: 'events', label: 'Events', description: 'Shows warning Events returned by the Kubernetes core API.' }
  ],
  network: [
    { id: 'overview', label: 'Overview', description: 'Recent request outcomes, where failures first appeared, and direct links to the evidence.' },
    { id: 'edge', label: 'Edge traffic', description: 'Ingress hosts, TLS, access control, gateway paths, and recent request failures.' },
    { id: 'flows', label: 'Service flows', description: 'Request journeys, endpoints, outbound connections, service map, and proxy refusals.' }
  ],
  networking: [
    { id: 'networking', label: 'Routes & Services', description: 'Published routes, Services, Ingresses, Gateway API Gateways and HTTPRoutes, and Istio VirtualServices and Gateways. NetworkPolicy isolation is on Security & Compliance → Security & Isolation.' }
  ],
  istio: [
    { id: 'mesh', label: 'Mesh security', description: 'Sidecars, Istio gateways and effective mTLS policy.' }
  ],
  certificates: [
    { id: 'certificates', label: 'Certificates', description: 'Certificate validity, expiry, issuers, and ingress bindings.' }
  ],
  observability: [
    { id: 'telemetry', label: 'Telemetry pipelines', description: 'Reads telemetry pipeline readiness and OTel agent DaemonSet coverage — never a pipeline destination.' },
    { id: 'traces', label: 'Service flows & traces', description: 'Request journeys, endpoints, outbound connections, service map, and proxy refusals.' }
  ],
  storage: [
    { id: 'pvcs', label: 'PersistentVolumeClaims', description: 'Reads claim phase, StorageClass, requested capacity, and bindings.' },
    { id: 'quotas', label: 'ResourceQuotas', description: 'Reads Namespace hard limits and currently reported usage.' },
    { id: 'limitranges', label: 'LimitRanges', description: 'Reads default, minimum, and maximum resource constraints.' }
  ],
  traffic: [
    // `ingress` first: the tab's default. Nine sub-tabs became five on 2026-09-27 (spec
    // docs/superpowers/specs/2026-09-27-ingress-traces-cleanup-design.md); SECTION_ALIASES keeps old links.
    { id: 'ingress', label: 'Edge overview', description: 'What needs attention at the edge, and where its traffic went.' },
    { id: 'failures', label: 'Failures', description: 'Failing requests by owner, then the response codes and Envoy flags behind them.' },
    { id: 'hosts', label: 'Hosts & TLS', description: 'Each published host with its route and certificate, then listeners and TLS.' },
    // `clients` keeps its id (a deep link) under its new title: peers are counted here, never listed by address.
    { id: 'clients', label: 'Access control', description: 'AuthorizationPolicies on the gateway and the peers they allowed or refused.' },
    { id: 'gateway', label: 'Gateway & path', description: 'Gateway pods, HPA and EnvoyFilters, then each network hop in and out.' }
  ],
  security: [
    // Namespace Compliance first so the first security question is scoped by namespace. PDBs & Drain
    // was removed from the strip (2026-09-25), and an old `?section=pdb` link falls back to Namespace
    // Compliance. Security & Isolation was removed the same day and restored 2026-09-26. "mesh
    // policy" is not claimed: security.js reads no PeerAuthentication or AuthorizationPolicy, so the
    // description names the screen that does.
    { id: 'compliance', label: 'Namespace Compliance', description: 'Summarizes the configured Namespace compliance checks.' },
    { id: 'isolation', label: 'Security & Isolation', description: 'Reads NetworkPolicy isolation, Secret and ServiceAccount inventory, and container security contexts. Effective mTLS is on Istio & Mesh \u2192 Mesh security.' }
  ],
  // The first four are one read: traces.js tails the istio-proxy access logs once, and the server
  // builds the journeys, the endpoint rows, the outbound rows and the call map from the same lines.
  // Refused Requests reads `/traffic-errors` for `ingress.refused` instead — the same route the
  // Traffic tab's Access control section reads, so the two never disagree about one cluster.
  traces: [
    { id: 'journeys', label: 'Requests', description: 'Individual requests stitched from access-log lines.' },
    { id: 'successful', label: 'Successful requests', description: 'Completed requests with a successful edge result and no observed failing hop.' },
    { id: 'map', label: 'Service calls', description: 'Who called whom, from every access-log line read.' },
    { id: 'endpoints', label: 'Endpoints', description: 'Requests grouped by method, host and path, with failures and latency.' },
    { id: 'outbound', label: 'External calls', description: 'Each workload’s calls outside its service path, linked by time to the request in flight.' },
    { id: 'refused', label: 'Blocked requests', description: 'Requests a proxy refused, with the AuthorizationPolicy that decided each.' }
  ]
} as const;

/** Tabs that have sub-sections. The rest are a single screen and take no `?section=`. */
export type SectionedTab = keyof typeof TAB_SECTIONS;

/**
 * Retired `?section=` ids on a live tab, and where each now lives. `resolveTabAlias` applies them,
 * so a bookmark lands on the merged screen instead of silently falling to the tab's first section.
 * srv still names `listeners` on its attention rows; edge-view's `attentionTarget` maps it through here.
 */
export const SECTION_ALIASES: Partial<Record<SectionedTab, Record<string, { section: string; set?: Record<string, string> }>>> = {
  network: {
    networking: { section: 'networking', set: { tab: 'networking' } },
    mesh: { section: 'mesh', set: { tab: 'istio' } },
    certificates: { section: 'certificates', set: { tab: 'certificates' } }
  },
  traffic: {
    listeners: { section: 'hosts' },
    codes: { section: 'failures' },
    path: { section: 'gateway' },
    window: { section: 'ingress', set: { proxies: '1' } }
  }
};

/** Where a retired `(tab, section)` pair lands now, or `null` when the section is live or not an alias. */
export function sectionAlias(tab: string, section: string | null): { section: string; set?: Record<string, string> } | null {
  if (!section) return null;
  // Own keys only: `?section=constructor` must not resolve to Object.prototype's.
  const map = Object.hasOwn(SECTION_ALIASES, tab) ? (SECTION_ALIASES as Record<string, Record<string, { section: string; set?: Record<string, string> }>>)[tab] : undefined;
  return map && Object.hasOwn(map, section) ? (map[section] ?? null) : null;
}

/** Any `?section=` value this console can produce, across every tab. */
export type AnySectionId = (typeof TAB_SECTIONS)[SectionedTab][number]['id'];

/**
 * The human label for one `(tab, section)` pair, for a control that has to *say* where it goes.
 *
 * Returns `null` rather than the raw id when the pair does not exist: a caller printing "opens
 * Security & Compliance → admission" has a bug, and a caller printing nothing at all is merely
 * less helpful. Nothing in the console is allowed to invent a destination name.
 */
export function sectionLabel(tab: Tab, section: string | undefined): string | null {
  if (!section) return null;
  const list = (TAB_SECTIONS as Record<string, readonly { id: string; label: string }[]>)[tab];
  return list?.find(s => s.id === section)?.label ?? null;
}

/**
 * Which tabs are a *workspace* rather than a document.
 *
 * A document tab is a column of sections that grows as tall as it needs and is read by scrolling
 * the page — every table already scrolls internally, but the page below them is the one scroller.
 * A workspace tab is two or more panes that must each fill the viewport and scroll *themselves*,
 * because the operator is comparing across them: Live Pod Logs is a pod list beside a log stream,
 * and a page scroller there is actively wrong — reaching the bottom of the log carried on into the
 * page, the pod list slid off the top with it, and picking a different pod meant scrolling back up
 * to find the list. Distributed Traces is the same shape: the journey list beside the selected
 * journey's panel, with the sub-tabs, tiles and FilterBar held above both. Ingress & Traffic too:
 * a host or failure table beside its detail panel, each scrolling on its own under a fixed band.
 *
 * The distinction is structural, not cosmetic, and it changes four things at once in
 * `ClusterDetail`: the page column stops scrolling (`overflow-hidden`), the content row stretches
 * instead of `items-start`, and the row's child and the gutter both become bounded flex columns so
 * `flex-1 min-h-0` inside the tab resolves against the viewport instead of against its own content.
 * Miss any one of the four and the panes silently fall back to auto height — they render, they just
 * do not scroll — which is why `test/fleet/workspace-tab-layout.test.js` asserts the whole chain.
 *
 * Exhaustive `Record<Tab, boolean>` on purpose: a new tab has to state which kind it is rather
 * than defaulting into the document layout by omission.
 */
const IS_WORKSPACE: Record<Tab, boolean> = {
  overview: false,
  nodes: false,
  workloads: false,
  network: true,
  networking: false,
  istio: false,
  observability: false,
  certificates: false,
  storage: false,
  logs: true,
  traffic: true,
  security: false,
  helm: false,
  traces: true,
  cost: false,
  tokens: false
};

/** True when the tab owns the viewport and scrolls inside its own panes. See {@link IS_WORKSPACE}. */
export function isWorkspaceTab(tab: Tab): boolean {
  return IS_WORKSPACE[tab] === true;
}

export const WORKSPACE_TABS: Tab[] = (Object.keys(IS_WORKSPACE) as Tab[]).filter(t => IS_WORKSPACE[t]);

/** The tab a cluster opens on. Overview, because it is the only one that answers "and?". */
export const DEFAULT_TAB: Tab = 'overview';

/**
 * Nine tabs in one flat strip wrapped to two rows at 1440px and read as a wall — nothing said
 * which of them answered the question in hand. These groups are the operator's actual
 * questions, and each tab has exactly one home:
 *
 *   Overview    what should I look at
 *   Health      is the cluster up and how full is it
 *   Workloads   what is running, is it scaling, what is it saying
 *   Traffic     how does anything reach it
 *   Platform    what is installed underneath it
 *   Governance  who may touch it and with what credential
 *
 * Deliberately no count or status badge on a group label. Only `nodes` and `workloads` have
 * their data in hand when the strip renders — every other tab fetches on mount — so a badge
 * would be summarising reads that have not happened. That is the same false-confidence bug as
 * a refused read rendering as `0`; see `components/unavailable.tsx`. The Overview tab is where
 * those verdicts belong, because it waits for its own fetch before claiming any of them.
 *
 * `[Tab, ...Tab[]]` rather than `Tab[]`: a group with no tabs would render a header that
 * selects nothing, and the compiler is the cheapest place to catch that.
 */
export const TAB_GROUPS: { id: string; label: string; tabs: [Tab, ...Tab[]] }[] = [
  { id: 'core', label: 'Core', tabs: ['overview', 'nodes', 'workloads'] },
  { id: 'network', label: 'Network delivery', tabs: ['network', 'networking', 'istio'] },
  { id: 'trust', label: 'Observability & trust', tabs: ['observability', 'certificates', 'security'] },
  { id: 'platform', label: 'Platform', tabs: ['storage'] },
  { id: 'operations', label: 'Independent operations', tabs: ['logs', 'helm', 'cost', 'tokens'] }
];

/**
 * The rail's reading order: Overview, then the two destinations an operator opens most (what is
 * running, and what it is saying), then the rest from the node upward to governance.
 *
 * This replaced six group headings. Eleven items is a short list, the headings cost six rows of
 * vertical space to label groups of one or two, and "Namespaces & Workloads" and "Live Pod Logs" — the
 * two most-used screens — sat below a `WORKLOADS` heading in the middle of the column rather than
 * where the eye starts. A flat list in frequency order puts them second and third.
 *
 * Derived from `TABS` through an exhaustive `Record<Tab, number>` rather than written out as a
 * list, so a new tab is a compile error here instead of a screen with no way to reach it.
 */
const RANK_OF: Record<Tab, number> = {
  overview: 0,
  workloads: 1,
  logs: 3,
  nodes: 4,
  traffic: 6,
  traces: 8,
  network: 6,
  networking: 7,
  istio: 9,
  observability: 10,
  certificates: 11,
  helm: 11,
  storage: 12,
  security: 13,
  cost: 14,
  tokens: 15
};

export const TAB_ORDER: Tab[] = TABS.map(t => t.id).sort((a, b) => RANK_OF[a] - RANK_OF[b]);

export const GROUP_OF: Record<Tab, string> = Object.fromEntries(
  TAB_GROUPS.flatMap(g => g.tabs.map(t => [t, g.id]))
) as Record<Tab, string>;

export const TAB_LABEL: Record<Tab, string> = Object.fromEntries(
  TABS.map(t => [t.id, t.label])
) as Record<Tab, string>;

/**
 * Two letters per section, for the icon-only sidebar rail.
 *
 * Written out rather than sliced from the label, because slicing collides: "Nodes & Topology"
 * and "Networking, Mesh & Certs" both start "NE", and two tiles spelled the same in a column of
 * eleven is worse than no rail at all. `tokens` is `CR` for the same reason its label is
 * "Credentials" — see the note on that entry above.
 *
 * Exhaustive `Record<Tab, string>`, so a new tab is a compile error here rather than a blank tile.
 * The abbreviation is never the accessible name: every tile carries the full `TAB_LABEL` in both
 * `title` and `aria-label`, and the two letters are `aria-hidden`.
 */
/**
 * One glyph per tab, beside its heading and nowhere else.
 *
 * Exhaustive `Record<Tab, IconName>`, for the same reason `TAB_ABBR` is: a new tab has to choose a
 * glyph at compile time rather than render a heading with a gap where one should be. The icon is
 * never the accessible name — `Icon` is `aria-hidden` and the heading text beside it is the name.
 *
 * Several tabs share a glyph on purpose. `traffic` gets the warning triangle because its entire subject is failure
 * and nothing else on the strip may use it. Where two tabs would want the same picture, the more
 * specific one keeps it.
 */
export const TAB_ICON: Record<Tab, IconName> = {
  overview: 'overview',
  nodes: 'nodes',
  workloads: 'workloads',
  network: 'network',
  networking: 'network',
  istio: 'security',
  observability: 'observability',
  certificates: 'security',
  storage: 'storage',
  logs: 'logs',
  traffic: 'traffic',
  security: 'security',
  helm: 'helm',
  traces: 'traces',
  cost: 'cost',
  tokens: 'credentials'
};

/**
 * A one-line subtitle under a tab's heading, for the sections whose tab's `TAB_ABOUT` provenance is
 * too long to read as one. Keyed by section, not tab: the Namespaces & Workloads line describes its
 * Namespaces section and would be wrong over Events or CronJobs. The provenance stays in the
 * heading's InfoTip; anything without an entry shows its `TAB_ABOUT` line, truncated, as before.
 * Worded for a read-only console: nothing here manages.
 */
const SECTION_SUBTITLE: Partial<Record<Tab, Partial<Record<string, string>>>> = {
  workloads: { namespaces: 'Browse namespaces and their aggregated workload resource usage.' }
};

/** The subtitle for `(tab, ?section=)`; an absent or unknown section is the tab's first, as `useSection` resolves it. */
export function tabSubtitle(tab: Tab, section: string | null | undefined): string | undefined {
  const list = (TAB_SECTIONS as Record<string, readonly { id: string }[]>)[tab];
  const active = list?.some(s => s.id === section) ? section : list?.[0]?.id;
  return active ? SECTION_SUBTITLE[tab]?.[active] : undefined;
}

/**
 * What each tab actually reads, in one or two sentences, shown in the InfoTip beside its heading.
 *
 * These are *provenance*, not marketing. An operator looking at a number on this console has one
 * recurring question — "where did that come from, and can I trust it" — and the answer is almost
 * always a specific API group and a specific limitation. So each line names the objects read and,
 * where it matters, what the reading cannot tell you: metrics-server samples are instantaneous with
 * no history behind them, Istio access logs exist only while a proxy is emitting them, Helm state
 * comes out of release Secrets rather than from a Tiller that no longer exists.
 *
 * Two rules these lines follow, both of which are the completeness contract restated in prose:
 *
 *  - **Never promise a fact the collector does not read.** Nothing here mentions historical trends,
 *    request tracing or cost, because this console has no time-series store and says so.
 *  - **Name the read, not the verdict.** "Reads X" is checkable against `srv/fleet/collectors/`;
 *    "shows you what is wrong" is not, and would drift the moment a collector changed.
 *
 * Exhaustive, so a new tab cannot ship an unexplained heading.
 */
export const TAB_ABOUT: Record<Tab, string> = {
  overview:
    'One verdict per topic, relayed from the same collector the tab behind it reads \u2014 this screen computes nothing of its own. Two reads: GET /clusters/:id/summary for the verdicts, GET /clusters/:id/namespaces for the namespace and pod counts on the Namespaces tile.',
  nodes:
    'Reads Nodes from the core API: conditions, taints, allocatable capacity, and the zone and worker-pool labels the provider sets. Capacity here is what the node declares, not what is in use.',
  workloads:
    'Reads Namespaces with a cluster-wide Pod count (GET /clusters/:id/namespaces), and Deployments, StatefulSets, DaemonSets and their Pods from apps/v1 and core/v1, joined to live CPU and memory samples from metrics-server where it answers. The Autoscalers and CronJobs sub-tabs read HorizontalPodAutoscalers from autoscaling/v2 and CronJobs from batch/v1 (GET /clusters/:id/autoscaling), including each CronJob\u2019s last schedule time and, for an autoscaler pinned at its ceiling, the reason the controller gave.',
  network:
    'Three views of one request path: a summary of recent request outcomes; edge traffic, parsed from Istio proxy access logs (ingress gateway first) and joined to the Gateways, Certificates, DNSEntries, AuthorizationPolicies and EnvoyFilters that shape the edge; and service flows, which stitch the journey of one request from the access logs of each hop that handled it. It sees only requests a proxy logged inside the bounded tail read, so a namespace without sidecar injection has nothing to show. Routes and Services are on Networking and mesh posture on Istio & Mesh. NetworkPolicy isolation is on Security & Compliance \u2192 Security & Isolation.',
  networking: 'Reads Kubernetes Services and Ingresses, Gateway API Gateways and HTTPRoutes, and Istio VirtualServices and Gateways for published routes and backend targets.',
  istio: 'Reads sidecar coverage, mTLS posture and Istio AuthorizationPolicy configuration.',
  observability: 'Reads Prometheus-Operator objects, telemetry pipeline readiness and OpenTelemetry agent coverage.',
  certificates:
    'Reads cert-manager Certificates for readiness, expiry and issuer, plus the TLS Secret name each Ingress references. Expiry is the date the Certificate reports, not the one a client is served; Istio Gateway credentials and the Secrets themselves are not read here.',
  storage:
    'Reads PersistentVolumeClaims, StorageClasses, ResourceQuotas and LimitRanges. A claim\u2019s capacity is what was requested; whether the volume behind it is full is not visible to the API server.',
  logs: 'Streams container logs straight from the kubelet through the API server\u2019s pods/log subresource. Nothing is stored or indexed here \u2014 what you see is the buffer the node still holds.',
  traffic:
    'Parses Istio proxy access logs — ingress gateway first — into traffic classes, published hosts, listener ports, peer counts and failing requests, joined to the Gateways, Certificates, DNSEntries, AuthorizationPolicies and EnvoyFilters that shape the edge. It can only see requests a proxy logged, so a namespace without sidecar injection, or a mesh writing logs elsewhere, has nothing to read.',
  traces:
    'Stitches one request\u2019s journey back together from the Istio proxy access logs of every hop that handled it, correlated by W3C traceparent when the mesh logs one and by Envoy\u2019s x-request-id otherwise. It sees only the proxies and the bounded log window read for this sample, so a hop count is what this read observed \u2014 never the request\u2019s full topology.',
  security:
    'Reads the per-namespace bootstrap compliance checks, and NetworkPolicies, Secret and ServiceAccount inventory and container security contexts for isolation. Secret names and types only \u2014 never a value. Istio PeerAuthentication and AuthorizationPolicy are not read here \u2014 effective mTLS is on Istio & Mesh \u2192 Mesh security.',
  cost:
    'Prices the cluster\u2019s own Nodes \u2014 instance-type label and declared capacity \u2014 against a rate card held on the server. It is an estimate, not an invoice: this console cannot read cloud provider billing, and a Node whose shape it does not recognise is left unpriced rather than guessed.',
  helm: 'Decodes Helm release Secrets (owner=helm) for revisions, chart versions, manifests and values. Values are masked: a key is shown, a credential never is.',
  tokens:
    'The service-account credential this dashboard reads the cluster with \u2014 its namespace, expiry and whether it can renew itself. The token itself is never returned to the browser.'
};

export const TAB_ABBR: Record<Tab, string> = {
  overview: 'OV',
  nodes: 'ND',
  workloads: 'WL',
  network: 'NW',
  networking: 'NT',
  istio: 'IS',
  observability: 'OB',
  certificates: 'CT',
  storage: 'ST',
  logs: 'LG',
  traffic: 'TR',
  // Not `TR` — Ingress & Traffic already owns it, and two tiles spelled the same in one rail is the
  // collision this map exists to prevent.
  traces: 'DT',
  security: 'SC',
  helm: 'HL',
  cost: 'CB',
  tokens: 'CR'
};
