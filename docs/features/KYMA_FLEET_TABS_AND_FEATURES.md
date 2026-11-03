# Kyma Fleet Dashboard — every tab, every sub-tab, every feature

> **Ported doc.** Ported from the source repo (branch `kyma-fleet-dashboard`). Names such as `srv` mean the backend, now `server/fleet/`. APIRule, Kyma module and approuter mentions describe the *managed Kyma clusters being observed* (still valid) or the source deployment (XSUAA + approuter, **not applicable here**; auth is Shield, see `docs/architecture/FLEET_ARCHITECTURE.md` §1). "Verified" claims were made in the source repo and are not re-verified on this branch. Guard tests marked "source repo, not ported" do not exist here.

A complete inventory of the console's navigable surface, with each claim marked by how it was
checked. Living doc: a change that ships or alters a tab updates its row here in the same commit.

**Companion documents.** `docs/specs/UI_SPEC.md` is the contract the tabs honour;
`docs/research/FLEET_API_DIGEST.md` is every route's field list, measured;
`docs/architecture/DASHBOARD_API_COMMAND_DATA_INVENTORY.md` maps each route to the screen that reads
it; `docs/operations/OPERATOR_GUIDE.md` is how to onboard and run it.

---

## 0. How to read this

| Mark | Meaning |
|---|---|
| **VERIFIED LIVE** | Exercised in a browser against a registered live cluster — in the §1 run unless the row or section names a later date. The behaviour was observed, not inferred. |
| **VERIFIED ON THE WIRE** | The route was probed against the same live cluster and returned the fields the screen needs. The screen itself was not clicked through in this run. |
| **VERIFIED BY TEST** | Covered by an automated test that runs in `npm test`. |
| **IN SOURCE, UNVERIFIED** | Present and readable in the code; no runtime evidence gathered in this run. Not a claim that it is broken. |
| **KNOWN GAP** | Missing or wrong in the source today. §11 lists every one. |

Nothing in this document is marked verified on the strength of a passing test alone. A green
suite proves the code does what the test says; it says nothing about whether the screen renders.

---

## 1. The verification run (2026-09-18)

A dated snapshot, kept as the evidence behind the VERIFIED LIVE and ON THE WIRE marks. Current gate
results come from running the gates.

| | |
|---|---|
| Date | 2026-09-18 |
| Backend | `npm run fleet:dev` on `:8099`, the production Express router, no auth middleware |
| Frontend | `npm run watch-fleet-ui` (Vite) on `:5174`, proxying `/api/fleet` to `:8099` |
| Cluster | the reference sandbox cluster (host in AGENTS.md), real, 3/3 nodes ready, `authMode: token` |
| Scale seen | 121 pods · 250 containers · 75 workloads · 31 namespaces · 76 NetworkPolicies · 3 zones |
| Routes probed | 48 of 49 (all but `/clusters/:id/logs`, which is excluded from the digest — §9) |
| Routes returning 200 | 48 of 48 |
| Envelopes reporting a gap | 0 — no `unavailable` and no `truncated` scope on any route |

Gates at the end of that run:

| Gate | Command | Result |
|---|---|---|
| Backend | `npm run test:fleet` | **972 pass / 0 fail** |
| Frontend | `npm run test:ui` | **113 pass / 0 fail** (7 files) |
| Types | `npx tsc --noEmit -p app/fleet-ui` | clean |
| Lint | `npm run lint` | clean |

---

## 2. Navigation map

### 2.1 Fleet level — the sidebar rail

Four destinations, plus two onboarding pages and a catch-all. Ids are `HashRouter` paths under
`/kyma-fleet-dashboard/#/`.

| Route | Rail label | Answers | Status |
|---|---|---|---|
| `/` | Overview | which of my clusters needs attention | VERIFIED LIVE |
| `/tokens` | Token Health | when does each cluster's credential expire | VERIFIED ON THE WIRE |
| `/drift` | Fleet Drift & Parity | are my clusters the same version of anything | VERIFIED ON THE WIRE |
| `/onboard` | Add cluster | register a cluster with a kubeconfig + token | IN SOURCE, UNVERIFIED |
| `/onboard/advanced` | (from `/onboard`) | register via OIDC kubeconfig and browser sign-in | IN SOURCE, UNVERIFIED |
| `/clusters/:id` | (from the roster) | one cluster, the tabs in §2.2 | VERIFIED LIVE |
| `/clusters/:id/helm/:ns/:name` | (from the Helm tab) | one Helm release, seven tabs | VERIFIED ON THE WIRE |
| `*` | — | a real "no such page" that names the address | VERIFIED LIVE |

`/clusters` redirects to `/` — an old bookmark still lands somewhere sensible.

### 2.2 Cluster level — the tab strip

`?tab=<id>` selects the tab, `?section=<id>` the sub-tab. Both are URL state, both use
`replace: true`, and a section change drops `?res=` unless the caller opts to keep it. Tab ids
are load-bearing and are never renamed.

`TABS` and `TAB_SECTIONS` in `src/pages/cluster-tabs/tabs.ts` are the source. This
table follows the rail order, `TAB_ORDER`.

| `?tab=` | Label | Sub-tabs (`?section=`) |
|---|---|---|
| `overview` | Overview | — (a tile grid, ending in the Namespaces tile) |
| `workloads` | Namespaces & Workloads | `namespaces` (default) · `workloads` · `pods` · `top` · `hpas` · `cronjobs` · `events` |
| `logs` | Live Pod Logs | — (pod picker + viewer) |
| `nodes` | Nodes & Topology | `overview` · `nodes` · `zones` · `slots` · `conditions` · `taints` · `tolerations` · `headroom` |
| `network` | Network Operations | Main side-panel tab for `?networkView=overview` (default), `edge` traffic evidence, and `flows` service journeys/maps |
| `networking` / `istio` / `observability` / `certificates` | Dedicated side-panel tabs | Kubernetes routes and Services; Istio mesh posture; platform observability; and certificate readiness/TLS bindings |
| `platform` | Modules & Telemetry | `modules` · `integrity` · `observability` |
| `helm` | Helm Releases | — (a release list) |
| `storage` | Storage & Quotas | `pvcs` · `quotas` · `limitranges` |
| `security` | Security & Compliance | `admission` · `compliance` |
| `cost` | Cost & Budget | — (tiles, simulator, two tables) |
| `tokens` | Credentials | — |

Network Operations opens on **Overview**, which summarizes recent policy refusals and application
failures from one bounded proxy-log journey sample and links to the request evidence. **Edge traffic**
answers whether public entry is healthy and controlled; **Service flows** follows a request through
the mesh and outbound connections; the **Networking**, **Istio & Mesh** and **Certificates** tabs inspect the Kubernetes and Istio objects
that define that path. The investigation order is overview, edge evidence, request flows, then
configuration. Former `?tab=traffic` and `?tab=traces` bookmarks redirect to their matching views
and retain their inner section.

The rail is a flat list in frequency order (`RANK_OF`): Overview, then Namespaces & Workloads and Live
Pod Logs, then the rest from the node upward to governance. It replaced six
group headings, which cost six rows to label groups of one or two and pushed the most-used screens
into the middle of the column. `TAB_GROUPS` and `GROUP_OF` are still exported from tabs.ts, and
nothing imports them.

Deliberately **no count or status badge on a tab label**. Only `nodes` and `workloads` have their
data when the strip renders; every other tab fetches on mount, so a badge would summarise reads
that have not happened — the same false confidence as a refused read rendering as `0`.

### 2.3 Admission policy — a nested seven-tab section

Reached from **Security & Compliance → Admission & Policy**, addressed with its own parameter so
it does not collide with the tab's `?section=`.

| Sub-tab | Answers |
|---|---|
| OPA Overview | is Gatekeeper installed, enforcing, and being consulted; high-risk findings (info statements sit on an "In force" line, not among the risks); library and Pod Security bundle coverage |
| Policies | which constraint templates and constraints exist, and whether each is custom, a gatekeeper-library template, modified from one, or behind its version |
| Violations | what is currently failing, and on which object |
| Native policies | which built-in ValidatingAdmissionPolicies exist, what their bindings do (deny / warn / audit / unbound) and where — a binding's reach is intersected with the policy's own `matchConstraints.namespaceSelector`; a refused binding read shows `unknown`, never `unbound`; messages only, never CEL |
| Admission Webhooks | which webhooks could take the API server down if they fail |
| Coverage | which policy topics are covered at all |
| Decision Activity | what the admission controller recently decided |

Library matching joins each template against `server/fleet/collectors/gatekeeper-library.json`, a
pinned catalogue of the upstream templates (title, version, bundle, Rego fingerprint) regenerated
with `npm run fleet:gk-library -- <gatekeeper-library checkout>`. It knows only the library as of
that commit. Bundle coverage counts Gatekeeper templates only; Pod Security Admission labels and
native policies can cover the same controls and are not counted there. Native policies and
Admission Webhooks take their rows from the Security tab's `/policy` read and issue no request.

### 2.4 Helm release — seven tabs

Reached from **Helm Releases → a release**. `/clusters/:id/helm/:namespace/:name`, keyed on all
three so moving release→release remounts rather than reusing the previous release's state.

| Tab | Answers | Note |
|---|---|---|
| Insights | is this release healthy and what changed | |
| Resources | what does it own, live | counts live objects, not the stored manifest |
| Architecture | how do its objects relate | interactive graph, anchored zoom |
| Values | what was it configured with | **masked** — see §9 |
| Manifest | what did Helm render | |
| History | every revision, with a diff | the only tab whose count is known before opening |
| Events | what has the cluster said about it | |

---

## 3. Fleet-level pages, in detail

### 3.1 Overview — `/`

**Answers** which cluster needs attention first. **Reads** `/clusters` (the roster) and `/summary`.

| Feature | Status |
|---|---|
| One row per registered cluster with a three-state verdict | VERIFIED LIVE |
| `ok` is three-state: `true` read, `false` unreachable, `null` registered-but-not-read | VERIFIED BY TEST |
| Per-cluster token state, node readiness, pod phases, CPU/memory requested vs allocatable, Kubernetes version | VERIFIED ON THE WIRE |
| Remove a cluster — typed confirmation, local bookkeeping only, zero calls to the cluster | IN SOURCE, UNVERIFIED |
| Hover-intent prefetch on this page: hovering a cluster row warms the click's read | **KNOWN GAP** — `Overview.tsx` passes no `onIntent`; the prefetch exists on `ClusterDetail` and `HelmTab` only |
| Empty state when nothing is registered — never a fabricated cluster | VERIFIED BY TEST |
| A "synced … ago" stamp for the whole console, in the rail footer | IN SOURCE, UNVERIFIED |
| A per-page freshness stamp | **KNOWN GAP** (§11) |

### 3.2 Token Health — `/tokens`

**Answers** when each cluster's service-account credential expires. **Reads** `/tokens`.

| Feature | Status |
|---|---|
| Expiry per cluster, with the renewal threshold at half-life | VERIFIED ON THE WIRE |
| "How the chain works" — the credential chain explained in place | IN SOURCE, UNVERIFIED |
| Renewal clock: when the next sweep runs and what it will do | IN SOURCE, UNVERIFIED |
| Never renders a token value — only expiry, mode and record presence | VERIFIED BY TEST |
| A link from a cluster's row to that cluster's Credentials tab, and back | **KNOWN GAP** (§11) |

### 3.3 Fleet Drift & Parity — `/drift`

**Answers** whether the fleet is running the same versions of anything. **Reads** `/drift`.

| Sub-tab | Answers | Status |
|---|---|---|
| Kyma Core Modules | which module is on which channel and state, per cluster | VERIFIED ON THE WIRE |
| Kubernetes & Node Parity | Kubernetes and kubelet spread | VERIFIED ON THE WIRE |
| Workload Image Drift | the same workload on different image tags | VERIFIED ON THE WIRE |

Module state is the operator's own `status.modules[].state` string — `Ready`, `Warning`, `Error`,
`Processing`, `Deleting`, or whatever else it emits — mapped to a tone rather than forced into a
closed enum. `missing` means not requested on that cluster; `unknown` means the cluster's Kyma CR
list itself could not be read. Those are different answers and stay different.

Sub-tab selection is URL state (`?section=`) with `role="tablist"` / `aria-selected`. It was
component state once, so a drift view could not be shared in a ticket.

A link from a specific drift finding to the affected cluster's relevant section is a **KNOWN GAP**
(§11).

### 3.4 Add cluster — `/onboard` and `/onboard/advanced`

| Feature | Status |
|---|---|
| Paste **or** upload a kubeconfig, plus paste a token, in one request | IN SOURCE, UNVERIFIED |
| The kubeconfig is parsed **server-side** (`/clusters/kubeconfig/describe`), which returns no credential | VERIFIED BY TEST |
| Re-onboarding an existing id requires an explicit **replace** — no silent overwrite | VERIFIED BY TEST |
| Advanced page: OIDC kubeconfig only, plus a browser sign-in button | IN SOURCE, UNVERIFIED |
| SSO uses a server-side PKCE flow with an exact-string redirect URI | VERIFIED BY TEST |
| OIDC `apiUrl` is host-allowlisted, so onboarding cannot be used to exfiltrate an SSO token | VERIFIED BY TEST |

The advanced page refuses fleet input descriptors (`acceptDescriptor: false`) — the two onboarding
paths stay separate on purpose.

### 3.5 No such page — `*`

A real page, not a `<Navigate to="/">`.

| Feature | Status |
|---|---|
| Names the attempted address verbatim (`#/nonexistent-route`) | VERIFIED LIVE |
| States plainly that nothing was fetched and no cluster was contacted | VERIFIED LIVE |
| Four real destinations with one line each on what they answer | VERIFIED LIVE |
| Explains that a cluster's page is `#/clusters/<cluster-id>` and the sidebar has the current ids | VERIFIED LIVE |

The argument against a silent redirect is written into the component: a bookmark that lands on the
Overview looks like it worked, and the operator learns nothing about why their link is dead.

---

## 4. Cluster tabs, in detail

### 4.1 Overview — `?tab=overview`

Two reads: a tile grid over `/clusters/:id/summary`, ending in a **Namespaces** tile over
`/clusters/:id/namespaces`. Each topic tile names a topic, shows its verdict, and links to the tab
that renders it.

Seventeen topics were once listed here in reading order; the grid now shows **seven**, sorted
worst-first by health rank rather than by a declared order — observed live 2026-09-24 as Workloads &
Controllers · Workload Reliability · Nodes & Capacity · Autoscaling · Networking & Ingress · TLS
Certificates · Kyma Modules & Platform. The older list is kept in `TOPICS` history, not on screen.

| Feature | Status |
|---|---|
| Every tile's verdict comes from the server's own group summary, never derived in the UI | VERIFIED BY TEST |
| `not installed` outranks any verdict — a cluster with no Istio is not a cluster with broken Istio | VERIFIED BY TEST |
| A refused read is named on the tile ("2 reads refused: …"), never shown as `0` | VERIFIED BY TEST |
| Each tile opens the tab and sub-tab that renders its topic | VERIFIED BY TEST (`test/fleet/overview-tile-destinations.test.js (source repo, not ported)`) |
| No Helm tile and no BTP services tile (§4.9, §6) | IN SOURCE, UNVERIFIED |
| Each topic tile shows high-level stats under its verdict, laid out like the Namespaces tile: a headline of counts, one split bar, a legend (`stats` on `/clusters/:id/summary`, `STATS` in `server/fleet/signals.js`). Deviating counts take the red or amber tone | VERIFIED LIVE 2026-09-27 |
| Per tile — Nodes: ready of total nodes, pods by phase · Workloads: total, not ready, container restarts, ready vs not ready · Autoscaling: HPAs by state (scaling, at ceiling, not scaling, fixed, no verdict), CronJobs · Networking: APIRules, VirtualServices, Services, Ingresses, APIRules by version · TLS: certificates, each in its worst state once · Modules: modules by state, Kyma CRs | VERIFIED BY TEST (`server/fleet/__tests__/overview-stats.test.js`) |
| A failed read sends `stats: null` and the tile falls back to its sentence. A list refused inside an answering collector (its label in `unavailable`) blanks the counts built from it to "unavailable" rather than the collector's 0 (`refused` in `server/fleet/signals.js`); modules show stats only on a confirmed Kyma cluster; a truncated list prefixes every count with `≥` | VERIFIED BY TEST, canaried |
| Stats ride the per-cluster summary only; the fleet `/summary` behind the rail dots never carries them, one cluster registered or many | VERIFIED BY TEST |
| The Autoscaling verdict classifies HPAs by the controller's reason (`hpaState`), as the tab's Status pill does: min = max or held at the floor is not "at its maximum" (platform-sbx read 3 false alarms before 2026-09-27) | VERIFIED LIVE 2026-09-27 |
| A tile that filters its destination to the failing rows | **KNOWN GAP** (§11) |

#### Namespaces — the tile

Added 2026-09-24, replacing the per-namespace card grid (removed the same day: it duplicated the
Namespaces sub-tab below and made the Overview a second inventory). The last cell of the tile grid,
unranked because it carries no verdict.

| Feature | Status |
|---|---|
| Total namespaces and total pods, from `/clusters/:id/namespaces` — 30 · 120 on platformsbx, matching `kubectl` | VERIFIED LIVE |
| Application / system / other split with a distribution bar; "other" is listed only when non-zero | VERIFIED LIVE |
| A refused or truncated pod list prints "pod count unavailable", never 0; a refused *namespace* list prints Unavailable, a truncated one "at least N" | VERIFIED BY TEST |
| No CPU or memory figures and no namespace rows on the tile | VERIFIED LIVE |
| "Open Namespaces →" lands on `?tab=workloads&section=namespaces` | VERIFIED LIVE |
| Counts come from `namespaceTypeCounts`, the function the sub-tab's filter labels use | VERIFIED BY TEST |

The Overview makes two reads (`/summary`, `/namespaces`); the description names both, and
`test/fleet/tab-descriptions-match-reads.test.js (source repo, not ported)` fails if the cards or a `/workloads` claim return.

BTP service instances are collected (`/clusters/:id/btp-services`) and rendered nowhere. The tile
was removed rather than pointed at a tab that does not show them (the comment above `TOPICS` in
OverviewTab.tsx); the fix is to build the screen (§11). Until 2026-10-01 the route read
`services.cloud.sap.com/v1beta2`, a version the group never served, and answered 0 instances and
0 bindings on every cluster. It reads `v1` now, and a 404 the group probe cannot explain answers
`unavailable` (`servedOrUnavailable` in `server/fleet/collectors/btp.js`). VERIFIED ON THE WIRE
2026-10-01 (`platformsbx`: 8 instances and 12 bindings, as `kubectl` counts them) and VERIFIED BY
TEST (`server/fleet/__tests__/btp.test.js`).

### 4.2 Namespaces & Workloads — `?tab=workloads`

Renamed from "Workloads & Pods" on 2026-09-24; the `?tab=workloads` id is unchanged. Seven sub-tabs
over one read (`/clusters/:id/workloads`); Namespaces adds `/clusters/:id/namespaces`, and
Autoscalers and CronJobs read `/clusters/:id/autoscaling` (§4.5).

2026-09-25: the `reliability` sub-tab was removed (`ReliabilityTab.tsx` kept in source, unmounted;
`/clusters/:id/reliability` unchanged, no longer prefetched), and so was the Overview "Workload
Reliability" tile that opened it. A stale `?section=reliability` falls back to `namespaces`.

| Sub-tab | What it shows | Status |
|---|---|---|
| `namespaces` (default) | one row per namespace: status, workload count, CPU and memory used/request/limit | VERIFIED LIVE |
| `workloads` | every controller: ready vs desired, image, restarts, requests vs usage | VERIFIED LIVE |
| `pods` | its own page since 2026-09-25: summary cards, a filter bar, one row per pod with CPU and memory used/request/limit, and an expandable detail (see "Pods sub-tab") | VERIFIED LIVE 2026-09-25 |
| `top` | Top Consumers since 2026-09-27: the pods using the most CPU, then the most memory, each against its request and limit (see "Top Consumers sub-tab") | VERIFIED LIVE 2026-09-27 |
| `hpas` | Autoscalers — see §4.5 | VERIFIED LIVE |
| `cronjobs` | CronJobs — see §4.5 | VERIFIED ON THE WIRE |
| `events` | warning events, most recent first | VERIFIED ON THE WIRE |

Workloads is one table with pills that filter within the section: All Workloads · Deployments ·
StatefulSets · DaemonSets · Pods. Its Pods pill still shows the older pod list (`PodInventoryList`),
left as it was; the Pods *sub-tab* is the page below.

#### Namespaces sub-tab

Logic in `namespace-table.ts` (tested); the meter is `ResourceMeter.tsx`; usage verdicts are
`namespace-usage.ts`.

| Feature | Status |
|---|---|
| Columns Namespace · Status · Workloads (icon + count) · CPU · Used/Req/Lim · Memory · Used/Req/Lim · a chevron; no pod rows. Type is a filter only | VERIFIED LIVE 2026-09-25 |
| Layout: every header centred; Namespace cells left, Status pill and Workloads count centred, meters left. Fixed widths Namespace 212 · Status 112 · Workloads 120 · chevron 44px; CPU and Memory split the rest equally (min 220px). A long name, the widest pill or a 9999 count moves no other column. Status's centring is the one `LABEL_EXEMPT` entry in `test/fleet/table-alignment.test.js (source repo, not ported)` | VERIFIED LIVE 2026-09-25 |
| Workloads is 120px, not the requested 90–110px: the header label, sort mark and InfoTip need 114px | KNOWN GAP |
| View switch above the toolbar: All namespaces (default, the table) · Top by CPU · Top by memory (`?nsview=cpu|memory`, survives reload). A ranking view replaces the table with the largest namespaces by live usage, as many as the toolbar's Show picker says (Top 10 default · 20 · 30 · All, `?ntop=`; the heading gives the real count when the cluster has fewer) (summed pod samples; request and limit play no part), bar scaled to the top row, Share of the cluster, "≥" when some pods reported no sample. Ranked over the namespaces the filters list, so Type, Status, search and Show system namespaces apply. The name opens Top Consumers on that namespace (`?section=top&ns=`), Pods opens the Pods sub-tab on it. Empty states name the cause: metrics-server down, workloads read failed, filters match nothing, no sample | VERIFIED LIVE 2026-09-27 (platform-sbx: switch, reload, both rankings at 1440, 0 console errors) |
| One toolbar row: Search, Type, Status, Show system namespaces (off by default, so the table opens on application namespaces; it reads ticked under Type = System, and ticking it under Type = Application or Other widens Type to All, since those exclude every system row on their own), the meter legend and the result line "X of Y namespaces · N pods · N system hidden"; filters combinable | VERIFIED LIVE 2026-09-27 (platform-sbx: 20 of 30, 10 system hidden; toggle on shows 30; under Type = Application the toggle ranks 7 → 12) |
| Status: Critical (failing workload, OOMKilled, at limit) · Warning (degraded rollout, above request, near limit) · Empty (0 pods, nothing desired) · Healthy · Unknown (workloads read incomplete, pod count unread, or pods owned by no Deployment/StatefulSet/DaemonSet). An incomplete read never yields Healthy or Empty | VERIFIED BY TEST |
| Meter (7px track, 11px limit tick): percentage of request with the ladder badge inline (amber "Above request" · stronger amber "Near limit" · solid red "At limit" with a solid limit tick); caption `used / request / limit` on one line (`11m / 190m / 1.5`), the named form in the tooltip; no request → "No request configured" on a dashed empty track, never a green fill; `none` when undeclared; a partial limit prints `≥X` and is never graded | VERIFIED BY TEST; at-limit not seen live |
| 0 pods prints "No pods" with no meter; status Empty | VERIFIED LIVE |
| Workload count, not pod count | VERIFIED LIVE |
| Row click or the chevron opens `?section=pods&ns=<ns>` in one URL write, closing any open `?workload=`/`?res=` drawer; disabled for 0 workloads. Targeted Workloads until 2026-09-25 | VERIFIED LIVE 2026-09-25 |
| "Other" type is never produced: the server classifies system vs not | KNOWN GAP |
| At 1440px and 1280px (rail expanded) the table fits with no horizontal scroll and 68–69px rows; narrower, it scrolls with Namespace pinned | VERIFIED LIVE 2026-09-25 |
| The header row is `position: sticky` but binds to `.table-wrap` (`overflow-x: auto`), so it does not stay on page scroll | KNOWN GAP |
| With a filter active, "Clear filters" wraps the toolbar's right group onto a second line | KNOWN GAP |
| Filter state is local, not in the URL | KNOWN GAP |

#### Pods sub-tab

`PodsSection.tsx`; the logic is `pod-table.ts` (tested). Rows are the flattened, deduplicated pods
of the workloads payload, so a pod no Deployment/StatefulSet/DaemonSet selects is not listed.

| Feature | Status |
|---|---|
| Five summary cards Pods · Running · Completed · Pending · Failed, counted by phase over the namespace + system-toggle scope; clicking one sets the Status filter. A crashlooping pod stays Running and counts under "need attention" on the Pods card | VERIFIED LIVE 2026-09-25 |
| Toolbar: Namespace (the shared `?ns=` selection), Search pods (name, node, owning workload), Status (All · each phase · Needs attention, with counts), Show system pods, Clear filters, result line "X of Y pods" | VERIFIED LIVE 2026-09-25 |
| Utilization filters (2026-09-25): CPU and Memory chips All · <25% · 25–50% · 50–75% · >75% (used ÷ summed request, the meter's own %; no request or no sample matches All only), each with its count; pressing the selected chip again returns its group to All (`nextUsageBand`); More filters: No request configured (CPU/Memory), No limits configured (a missing or partial limit), High restarts (>10). They AND with Namespace, Search, Status and System, and Clear filters resets all of them | VERIFIED LIVE 2026-09-25 (Memory 25–50% 16 → 10; High restarts 1; polls + Memory 25–50% 5); toggle-off VERIFIED LIVE 2026-09-27 (CPU <25% pressed twice → All, Memory 25–50% 12 → All 16, Clear filters resets both) |
| System pods hidden by default using the server's own namespace flag; unknown classification hides nothing; a namespace selected explicitly is never hidden | VERIFIED BY TEST; live 16 → 119 rows on platformsbx |
| Columns Pod · Status · Workload · CPU · Used/Req/Lim · Memory · Used/Req/Lim · Restarts · chevron. Fixed widths 232 · 132 · 150 · 112 · 44px; CPU and Memory split the rest (min 240px). At 1440px with the rail open it fills 1150px with zero header/body drift | VERIFIED LIVE 2026-09-25 |
| Meters are the Namespaces `ResourceMeter` and ladder (`scope="pod"`/`"container"` only changes wording: a missing sample reads "No data" here, "No sample" on Namespaces); a pod's used, request and limit are summed over its regular containers and native sidecars (istio-proxy), so both sides of the percentage cover the same containers; the limit is partial (`≥`, never graded) when any of them declares none | VERIFIED BY TEST; live 2026-09-25 |
| Row click or the chevron expands: Pod details (name, namespace, workload, type, node, pod IP, started, status + QoS, reason, Logs), Containers (image, CPU/memory meters, restarts, state, Logs), Recent events (latest 5 warning Events for `Pod/<name>`) | VERIFIED LIVE 2026-09-25 |
| The detail shows **Started**, not Created: the pod payload carries `startedAt` and no `creationTimestamp` | KNOWN GAP |
| Recent events are warning Events only — the events read carries no Normal events | KNOWN GAP |
| The Pods sub-tab counter follows the table's scope, system toggle included (`podsInScope`; the toggle lives in `WorkloadsArea`): 16 by default, 119 with system pods, on platformsbx | VERIFIED LIVE 2026-09-25 |
| "Need attention" (the Pods card caption and the Status option) counts a pod whose `podState` is not green **or** whose restarts exceed 10 (`RESTARTS_WARN`, the same threshold that turns the Restarts cell amber): a Running 1/1 pod with 186 restarts is flapping | VERIFIED BY TEST; live 0 → 1 on platformsbx |
| Completed is usually 0: Jobs and bare pods are not in the workloads payload | KNOWN GAP |

#### Top Consumers sub-tab

Replaced the Top Utilization tab on 2026-09-27. Reads nothing of its own: the rows are the
workloads payload the page already holds (`buildUtilizationModel` in
`src/pages/cluster-tabs/usage/utilization-model.ts`), and the rules are in
`top-consumers.ts` beside it. `?tab=utilization` (any section) redirects here through
`TAB_ALIASES`, keeping only `?ns=`.

| Feature | Status |
|---|---|
| Top CPU and Top Memory side by side from 1440px, stacked below; a row is a pod owned by a Deployment, StatefulSet or DaemonSet, with #, Pod (namespace, pressure pill and Logs under the name), the used/request/limit meter and Share | VERIFIED LIVE 2026-09-27 (platform-sbx, 566px per table at 1440, no sideways scroll at 1280/1440/1920, every Logs link and pod suffix visible) |
| Rank is the meter's own used value, largest first; a pod with no sample is not ranked and the table names how many | VERIFIED BY TEST (top-consumers.test.ts) |
| Show Top 10 · 20 · 50 in `?top=` (10 omitted); Namespace in `?ns=`; the Show system pods toggle is the Pods sub-tab's own, so switching sub-tab keeps it | VERIFIED LIVE 2026-09-27 |
| Pod name opens the resource drawer (`?res=Pod/...`); Logs opens the pod's log tail | VERIFIED LIVE 2026-09-27 |
| metrics-server down: nothing is ranked and the panel says why, rather than ranking by request | IN SOURCE, UNVERIFIED (no cluster with metrics-server down) |
| Snapshot strip: "updated N s ago" and Refresh, re-reading the page's one payload | VERIFIED LIVE 2026-09-27 for the age line; Refresh IN SOURCE, UNVERIFIED (not clicked) |
| `?tab=utilization&section=pressure&ns=kyma-system` lands on `?tab=workloads&section=top&ns=kyma-system`, and Back skips the old URL | VERIFIED LIVE 2026-09-27 |

#### Workloads, Pods, Reliability, Events

| Feature | Status |
|---|---|
| Per-row **Logs** button jumping straight to the Logs tab with the pod pre-selected | VERIFIED LIVE |
| Node cell is a button into the Nodes tab | VERIFIED LIVE |
| Restarts above 10 render in the warn tone | VERIFIED LIVE |
| Owner column: names the workload when one selects the pod | VERIFIED LIVE |
| Owner column: says "*N* workloads select it" when several do, with all candidates in the tooltip | VERIFIED LIVE |
| No workload link from a pod — the payload has no `ownerReferences`, and name-stripping is string similarity | VERIFIED BY TEST |

**The owner ambiguity was a real defect found during this run.** Three Deployments in
`kyma-system` share the selector `control-plane: controller-manager`, so
`istio-controller-manager-79bd8f969f-d8bmw` was labelled
`application-connector-controller-manager +2` — a name from a different component, rendered as
confidently as a correct one. The column now reports the ambiguity instead of resolving it
arbitrarily. `pages/cluster-tabs/pod-inventory.ts` and its tests.

#### Image drift is inspectable, and its empty state is three-way

The Reliability sub-tab's **Image-drifted Deployments** table used to print drifted pod names in red
and explain nothing, so the operator's next move was `kubectl get deploy -o yaml` in another window.

| Feature | Status |
|---|---|
| Clicking a row — or one drifted pod name — opens the drift inspector in `DetailPanel`, the console's one drawer | VERIFIED BY TEST (logic) |
| Two-line plain-English explanation of what image drift is | VERIFIED BY TEST |
| Per container: **Declared in template** vs **Currently running**, version first and repository under it, full reference in the `title` | ON THE WIRE |
| The collector's own `explanation` sentence per container, **omitted and never synthesised** when an older backend does not send it | VERIFIED BY TEST |
| Copyable `kubectl rollout restart deployment <name> -n <namespace>` — **text only**, through `CodeViewer`'s clipboard copy. No endpoint, no action | VERIFIED BY TEST |
| The command is offered for a real drift **only**. Clean, not-comparable and unknown yield no command at all — a restart cannot fix a comparison that is impossible | VERIFIED BY TEST |
| Four verdicts, one function (`driftVerdict`): drifted · clean · not comparable (`uncomparableImages > 0`) · unknown (`ownerResolution === 'unavailable'`), each with its own headline and lead | VERIFIED BY TEST |
| `ownerResolution: 'unavailable'` renders "Image drift could not be evaluated", naming the reason — never "no image-drifted Deployments" | VERIFIED BY TEST |
| The same case renders the summary tile as an em-dash rather than a sum containing a 0 nobody measured | ON THE WIRE |
| Containers reporting a bare image ID are listed as **not comparable** beside the table and in the drawer — the third state, which no restart changes | VERIFIED BY TEST |
| The `Rollouts` sub-tab pill drops its count entirely when the drifted half was not evaluated — `rolloutTabLabel`, tested for containing no digit. The stale count moves to the tooltip | VERIFIED BY TEST |
| Deployments mid-rollout (`revisionDetails`) are named beside the table as deliberately excluded — the collector separates a rolling update from a stuck image, and that distinction was previously computed and discarded | ON THE WIRE |

`pages/cluster-tabs/image-drift.ts` + `DriftInspector.tsx`, with image-drift.test.ts. The drawer is mounted from the
tab body, not inside the Card: `.table-wrap` sets `overflow-x: auto`, which computes `overflow-y` to
`auto` and clips a panel positioned inside it.

**Still on the user's hands:** the whole surface needs the backend's `explanation`,
`ownerResolution` and `uncomparableDetails` fields, which ship in the same change to
`server/fleet/collectors/reliability.js` — the UI degrades to the comparison rows alone against an
older `srv` image, but the two "unknown, not clean" states only appear once that image is deployed.

### 4.3 Live Pod Logs — `?tab=logs`

| Feature | Status |
|---|---|
| Namespace picker, pod list, per-container tabs | VERIFIED LIVE |
| Tail size 200 / 300 / 500 / 1000 | VERIFIED LIVE |
| **Previous instance** — the log from before the last restart | VERIFIED LIVE |
| Deep-linkable: `?tab=logs&ns=…&pod=…&container=…&previous=1` | VERIFIED LIVE |
| Arriving from a pod's drawer or a table row pre-selects everything | VERIFIED LIVE |
| Scrollable output with in-log search | IN SOURCE, UNVERIFIED |
| "This container has not restarted" as a real state, not an empty box | IN SOURCE, UNVERIFIED |
| Auto-refresh (off by default, `autoMs` in LogsTab.tsx) re-reads the tail; the viewer stays on the newest line until the reader scrolls away, then keeps their place and counts the lines that arrived (`newLines`, PodLogsViewer.tsx) | IN SOURCE, UNVERIFIED |
| A visible follow-state indicator and an `aria-live` announcement of it | **KNOWN GAP** (§11) |
| Never cached — logs are the one read that must be current | IN SOURCE, UNVERIFIED |

Leaving the Logs tab clears `ns`, `pod`, `container` and `previous` from the URL, so a stale
`previous=1` cannot make a healthy pod look like it has no previous instance.

### 4.4 Nodes & Topology — `?tab=nodes`

Eight sub-tabs over the nodes read; `headroom` makes a read of its own.

| Sub-tab | What it shows | Status |
|---|---|---|
| `overview` | node readiness, requests vs allocatable | VERIFIED ON THE WIRE |
| `nodes` | one row per node with its pool, instance type, zone | VERIFIED ON THE WIRE |
| `zones` | zone and pool spread | VERIFIED ON THE WIRE |
| `slots` | pod slots used vs capacity, per pool | VERIFIED ON THE WIRE |
| `conditions` | nodes reporting readiness or resource-pressure conditions — never a synthesised "Ready" | VERIFIED ON THE WIRE |
| `taints` | each node's taints, with how many pods tolerate each one and how many are placed there | VERIFIED BY TEST (`server/fleet/__tests__/taints-and-tolerations.test.js`, taint-labels.test.ts) |
| `tolerations` | pods declaring a toleration beyond the two Kubernetes injects, with the node each runs on | VERIFIED BY TEST (same) |
| `headroom` | overcommit, unbounded containers, QoS mix, scheduling pressure | VERIFIED ON THE WIRE |

The old standalone Topology tab and its lazy pod refetch were removed: zone spread, pod slots and
node conditions are all derivations of the same `nodes` array.

### 4.5 Autoscalers & CronJobs — `?tab=workloads&section=hpas|cronjobs`

Its own Autoscaling & Jobs tab until 2026-09-25; now two sub-tabs of Namespaces & Workloads.
`?tab=autoscaling` is redirected by `TAB_ALIASES` in `tabs.ts` (keeping `section=cronjobs`), and the
Overview Autoscaling tile and the HPA/CronJob drawer `home` point at the new place. The strip no
longer carries HPA/CronJob counts, because the read happens inside the section.

| Sub-tab | What it shows | Status |
|---|---|---|
| `hpas` | every autoscaler, current vs target, and an eight-state `Status` pill: `Active` (tooltip names the floor on `TooFewReplicas` and the rate limit on `ScaleUpLimit`/`ScaleDownLimit`), `At ceiling` (`TooManyReplicas`, or at max under an unrecognised limit; never on the floor or a rate limit), `Scaling disabled` (neutral; `ScalingDisabled`, target scaled to 0), `Fixed at N` (neutral; min = max, so it cannot scale), `Limited, ceiling unknown` (ScalingLimited=True with the replica counts unread), `Cannot scale target` (AbleToScale=False), `No readable metric`, `Not yet reconciled`. The resource drawer shows the same verdict (`hpaStatus`) and a `Limit` field (`hpaLimitLabel`). Values checked against `kubectl get hpa -A` on platform-sbx, 6 of 6 rows, 2026-09-25 | VERIFIED LIVE |
| `cronjobs` | schedule, last scheduled and last successful times (no Jobs read) | VERIFIED ON THE WIRE |

Searchable. A link from an HPA to its scale-target workload exists in the resource drawer
(`Scale target` relation, from `targetRef` — a real relationship). The row's Target Workload cell is
text, so a link from the *table row* to the target is a **KNOWN GAP** (§11).

### 4.6 Network Operations — `?tab=network`

#### Overview — `?networkView=overview` (default)

One `/traces` read supplies the bounded proxy-log journey sample. The view separates policy
refusals from application failures, labels the first failing gateway or workload when journey
evidence identifies it, and links to Requests or Blocked requests. The policy-refusal count is
cluster-sample-wide; the explicit "blocked at ingress" subset is counted only among the displayed
journeys because the collector does not publish an aggregate by entry tier. An unread or
unverifiable access log withholds the counts. These are sampled observations, not request totals.

| Feature | Status |
|---|---|
| Overview first in the Network Operations view order; the other views follow Edge traffic → Service flows | IN SOURCE, UNVERIFIED |
| Policy refusals and application failures are separate; failures link to their request list and refusals to the policy-evidence list | IN SOURCE, UNVERIFIED |
| The Outbound failures card opens Service flows → Outbound with its failures-only filter already on (`outboundErrors=1`, read through `useSearchParams`) | IN SOURCE, UNVERIFIED |
| A bounded sample caption, access-log read status, stale-read state and manual re-read keep window limits visible | IN SOURCE, UNVERIFIED |

#### Edge traffic — `?networkView=edge`

Read from `istio-proxy` access logs, so it is a **window over recent requests**, not a total. The
view says so itself. Five sub-tabs since 2026-09-27 (spec
`docs/superpowers/specs/2026-09-27-ingress-traces-cleanup-design.md`): `ingress`, `hosts`, `failures`,
`clients` and `gateway`, each opening with a Problems strip. The outer Network Operations tab is a workspace:
the page never scrolls, each sub-tab's body scrolls on its own. Full handoff in
`docs/features/INGRESS_OBSERVABILITY.md`; the wire contract in
`docs/superpowers/specs/2026-09-26-ingress-traffic-plan.md`.

| Sub-tab | What it shows | Status |
|---|---|---|
| `ingress` | Overview: the Problems strip first (srv's attention rows — PERMISSIVE PeerAuthentications, EnvoyFilters that can never apply, idle hosts, certificate renewal overdue or under 7 days — plus hosts whose published chain has a gap; rows judged from the sample are dropped when no gateway was read), then every edge record in exactly one class (tls-rejected, direct-ip, policy-blocked, probe, platform, app; `classifyEdgeRecord` in `server/fleet/collectors/edge.js`), then the **app** headline — error rate and p95 over app traffic only, p95 withheld under 20 samples | VERIFIED LIVE 2026-09-26 |
| `hosts` | Hosts & TLS: every Host/authority asked for at the edge, who publishes it (VirtualService / APIRule), its 2xx-3xx / 4xx / 5xx split, error share and upstream latency, with a group-chip filter and a detail drawer; then, from the retired `listeners`: TLS & Listeners, in order: the declared Istio Gateway servers as a searchable table (port, protocol, TLS mode, credential **name**, expiry, minimum TLS, hosts), the listener ports Envoy accepted on, the SNI names it turned away (searchable), then Certificates and Mesh mTLS (PeerAuthentication) side by side. Certificate tone follows the issuer's renewal time, as on Ingress Overview | VERIFIED LIVE 2026-09-27 (platform-sbx, 18 hosts) |
| `clients` | Access control: the AuthorizationPolicies on the gateway, how many records each refused, and sampled peers as **counts only** (distinct, internal, external allowed / blocked-only / TLS-only). External client addresses never reach the wire; internal peers keep their rows. Links to Service flows → Refused Requests (`?tab=network&networkView=flows&section=refused`) for the per-request detail: host, path, decided-by policy, first/last seen | VERIFIED LIVE 2026-09-26 (guarded by the wire sweep in `server/fleet/__tests__/traffic-edge.test.js`) |
| `failures` | Failures: failing requests grouped by destination and class (server / client / no response), mesh-wide; the failure buckets by owner; then, from the retired `codes`: the edge's response codes with deep links into `failures`, Envoy's response flags **decoded**, and the mesh-wide code distribution below for scope comparison | VERIFIED LIVE 2026-09-27 |
| `gateway` | Gateway & path: Gateway tier: gateway pods, autoscaler and disruption budget; the LoadBalancer Service and what its hostname resolves to (srv's one DNS lookup, cached 5 minutes); Gardener DNSEntries; EnvoyFilters with whether their `proxyVersion` can match the running Istio; then, from the retired `path`: Network Path: the AWS-to-Kyma request path as hop cards, inbound (internet, AWS load balancer, node port, gateway pod, sidecar, app) and outbound (pod, node, NAT egress IPs, named destination), each hop named from cluster evidence (`kube-system/shoot-info`, the LB Service, the mesh outbound policy); then the named destinations and the egress this read observed | VERIFIED LIVE 2026-09-27 (a Problem press lands on and rings the EnvoyFilters card) |

| Feature | Status |
|---|---|
| A Problems strip leads every sub-tab of Edge traffic and the Service flows sub-tabs Requests, Endpoints, Service calls and External calls (Successful requests opens with its summary, Blocked requests with its table), sorted bad → warn → info then count (`sortProblems` in `src/pages/cluster-tabs/problems.ts`). It sits above any tile row (Failures, Endpoints, Service map, Outbound). An unread source reads Unavailable; a read with nothing reads "No problems in the sample", or names what the screen set aside ("No app failures · N refused at the edge"; "No app problems · N … left out"); an unbucketed failure group is an info row, "Not classified"; three rows, then "Show N more". A press lands on the row it names and rings it for 1.6 s; an anchored card lands by its heading (`landingParams` in `ingress/problem-landing.ts`, one `setSearchParams` write) | VERIFIED LIVE 2026-09-28 (the 9 sub-tabs then present, at 1440 and 1100; strip-above-tiles and the Gateway heading landing measured) |
| Refusals on bare-IP Host headers are one counted item, "Direct-IP requests: N refused across K addresses", never listed by address | VERIFIED BY TEST (`problems.test.ts`) |
| Old links keep working: `?section=listeners` → `hosts`, `codes` → `failures`, `path` → `gateway`, `window` → `ingress` with the proxies panel open (`SECTION_ALIASES`) | VERIFIED LIVE 2026-09-27 |
| Which proxies were read is a chip at the end of the sub-tab bar ("10 of 41 proxies read") on every sub-tab of both tabs, opening the retired `window` content in a side panel (`traffic/ProxiesRead.tsx`) | VERIFIED LIVE 2026-09-27 |
| The chip's second line says how old the answer is, "updated just now" / "updated N min ago" (`updatedAgo` in `traffic/updated-ago.ts`, from the body's `collectedAt`, ticking every 30s; nothing when the stamp is missing). Two lines, because on one it wrapped the sub-tabs at 1100px | VERIFIED LIVE 2026-09-28 (platformsbx, 1100×800: tabs on one row) |
| Each sub-tab's count is the number of rows its Problems strip lists (`problemBadges` in `problems.ts`): none when the strip is empty, none when its reads failed (`null`), never a 0 standing in for unread | VERIFIED LIVE 2026-09-28 (platformsbx: Overview 10, Hosts & TLS 8, Failures 1, Access control 4, Gateway & path 1, each equal to its strip) |
| AuthorizationPolicy refusals are info, not warn: an allowlist refusing unknown clients is the policy working. Overview's strip lists the same policy line Clients does (`overviewProblems`); the Clients Denied cells are neutral | VERIFIED LIVE 2026-09-28 (apple-acl refused 31, info) |
| **Access control → configured ranges**: selecting an AuthorizationPolicy opens its read-only Live YAML, where its `ipBlocks` and `remoteIpBlocks` can be inspected. The policy table makes clear that these are configured source CIDRs, not observed client addresses; load-balancer source ranges and upstream Apple firewall ACLs are separate controls | VERIFIED BY TEST (`ingress-ui-readonly.test.js`) |
| Counts that describe one thing share one helper: TCP vs HTTP per edge class (`connectionsByClass`, `classUnits` in `ingress/edge-view.ts`, so Hosts and Overview agree on TLS), and the External tiles add up to External, with a TLS-only tile and an unknown one on an older srv (`externalPeerSplit` in `ingress/shared.ts`) | VERIFIED LIVE 2026-09-28 (External 49 = 4 allowed + 12 refused only + 33 TLS only) |
| Hosts & TLS columns fit the card at 1440 and 1100 with a classic scrollbar (Host 200, Chain 140, Class 180, each `width` = `max`; guard `test/fleet/ingress-hosts-fit.test.js (source repo, not ported)`) | VERIFIED LIVE 2026-09-28 (no table overflow at either width) |
| Card hints are one line plus an `InfoTip` (`splitHint` in `hint.ts` cuts at 90 characters, tested in `hint.test.ts`; `test/fleet/ingress-traces-hints.test.js (source repo, not ported)` checks the Ingress and Traces cards route their hints through it) | VERIFIED BY TEST |
| Tail 200 / 300 / 500 / 1000, server-clamped to 1000 | VERIFIED LIVE 2026-09-27 |
| Changing Tail, Polls or Re-read keeps the previous rows on screen, dimmed, under a "Re-reading" notice (`StaleReadNotice`, `subject` in `useAsync`); only a cluster change blanks. Tail 1000 on platformsbx: 0 ms blank, was a 16.9 s skeleton. Coming back to the tab opens on its last good read, stale, while it re-reads (`createRetainStore` in `async-retain.ts`, 12 reads per page): 0 ms skeleton with a 6 s re-read, was 5.8 s | VERIFIED LIVE 2026-09-27 |
| 15 s fresh, then served stale and refreshed in the background to 120 s; `cache-control` bypass; log tails shared with Distributed Traces | VERIFIED BY TEST |
| Resolves the mesh ConfigMap's access-log provider, so a `kyma-logs`-only mesh is reported rather than printed as zeros | VERIFIED BY TEST |
| Domain grouping from cluster evidence plus `FLEET_CORPORATE_DOMAIN_SUFFIXES` — never hardcoded | VERIFIED BY TEST |
| Sampled requests/s, per-proxy span-weighted, suppressed when any proxy spans < 30 s | VERIFIED ON THE WIRE |
| Read-only, no-PII and truncation guards over the whole `ingress/` folder | VERIFIED BY TEST (`test/fleet/ingress-ui-readonly.test.js (source repo, not ported)`) |
| The failing-request drawer links the proxy Pods that reported it (`ResourceLink`) | IN SOURCE, UNVERIFIED |
| A link from a failing destination to its Service, workload and then logs | **KNOWN GAP** (§11) |
| A true cluster requests/second | **IMPOSSIBLE** — needs `istio_requests_total` via `pods/proxy`, a grant refused in the RBAC audit |
| Destination IPs named with provenance — NetworkPolicy annotations and `spec.egress[].to[].ipBlock` rules (a `/32` names its address; a wider block names an address inside it only on Traces, never an ingress host; `0.0.0.0/0` names nothing), the telemetry pipelines (followed to the `cloud-logging` ServiceInstance) and the ingress LB DNS lookup; on Traces Service map / Outbound as well. Name first, address second; an address with no evidence stays an address | VERIFIED LIVE 2026-09-26 (`server/fleet/destination-names.js`); ipBlock names VERIFIED BY TEST 2026-09-27 (`server/fleet/__tests__/destination-names.test.js`) |
| Proxy sampling: ingress gateways, then pods behind a route (VirtualService / APIRule backend → Service → selected pods), then gateway-named pods, then the rest; inside each tier one pod per owning workload before any gets a second (`selectProxies` in `server/fleet/collectors/traffic.js`). Traffic and Traces share one credential-scoped read of the routes, gateways, Services and name sources (`registry-share.js`, 60s) | VERIFIED LIVE 2026-09-27 (platform-sbx: 3 gateways, then applecare, bookshop, connectivity-validator, compass, polls, nginx sidecars in the 12 read) |
| The originating client IP and the user agent | **DELIBERATELY ABSENT** — `x-forwarded-for` and `user_agent` are never emitted; the peer address is the immediate peer, and the screen says so |
| A live ingress log inspection drawer | **OUT OF SCOPE** — offered to the user and not selected |

The `window` sub-tab is the design principle in miniature: the number of proxies read is part of
the answer, so it gets a tab rather than a footnote. The edge sub-tabs apply the same rule — a
gateway pod the read did not get is named on the Ingress Overview rather than silently omitted.

#### Failing requests — what the wire carries

Measured over all 430 groups of `/traffic-errors?tailLines=500` on the reference cluster,
2026-09-21. These decide what a failures column may claim.

| Field | Populated | Consequence |
|---|---|---|
| `code` + `class` | 430/430 | Use `class` (`client`, `server`, `no-response`, `ok`, `redirect`); never re-derive a class from the number |
| a namespace | 0/430 | A failure group has none. `sources[].namespace` is the *client's* (non-null in 1 group) and `proxies[].namespace` the logging proxy's (always `istio-system`), so the column is **CLIENT**, from `sources[]` |
| `upstream` | 1/430 | Too sparse to be the "served by" column |
| `gateway` | 381/430 | The field that answers "which upstream served this": **SERVED BY** reads `gateway`, then `upstream` |
| `responseFlags` | 2/430 | "Not routed" renders only when the flags contain `NR`; an empty upstream with no flag renders `—` |
| `responseCodeDetails` | 429/430 | The richest explanatory field on the page |
| route | absent | Not on the wire; omit the row rather than print "Route —" |
| trend | — | No comparison period exists; `—`, never an invented trend |

Two controls are easy to misread, so their labels say what they do. The `namespace` query parameter
scopes **which proxies are tailed**, not which rows return, so the control is "Proxy namespace".
`sinceSeconds` bounds the time range, but `tailLines` still caps each proxy's read, so a 7-day range
reads only the last lines that fall inside 7 days; the `oldest`/`newest` echo is the true coverage
and is shown beside the chosen range.

Proxy visibility has three states: **read**, **not read** (the collector caps the sweep at
`maxPods`), and **failed** (`proxiesFailed`). A proxy that was not read was never asked, so it is
never called "silent".

**KNOWN GAP: the redesign that applies these rules is built and not mounted.**
`traffic/TrafficErrorsPage.tsx` — with `TrafficFailuresTable.tsx` (CLIENT, SERVED BY, flag-only "Not
routed") and `ProxiesObserved.tsx` (the three states) — has no importer. The `failures` and `window`
sub-tabs on screen are `TrafficTab.tsx`'s own table (Code · Seen · Request · Host · Upstream ·
Destination · Envoy's reason · Last seen) and its "What was read" section.

### 4.7 Networking, Istio & Mesh, and Certificates — `?tab=networking`, `?tab=istio`, `?tab=certificates`

Three tabs with one section each (`networking`, `mesh` labelled Mesh security, `certificates`). Links
from before the split, `?tab=network&section=<id>`, resolve to them through `SECTION_ALIASES` in tabs.ts.

| Sub-tab | What it shows | Status |
|---|---|---|
| `networking` | APIRules, Ingresses, Services, Istio VirtualServices and Gateways | VERIFIED ON THE WIRE |
| `mesh` | sidecar coverage, ingress binding integrity | VERIFIED ON THE WIRE |
| `certificates` | expiry and Ingress TLS bindings | VERIFIED ON THE WIRE |

APIRule is queried as **v2** with the two conversion annotations — `v1beta1` has been
unreconciled since Aug/Sep 2026. None of these tabs reads **any** NetworkPolicy: that read lives in
`security.js`, rendered on Security & Compliance → Security & Isolation (§4.11). The collector still infers `policyTypes` correctly when
absent (absent means Ingress only) and never conflates "has a policy" with "is isolated".

### 4.8 Modules & Telemetry — `?tab=platform`

Three independent reads, one per sub-tab, each fetching inside its own component — so opening the
tab costs exactly one read and switching costs exactly one more.

| Sub-tab | What it shows | Status |
|---|---|---|
| `modules` | installed Kyma modules, their channels, versions and states against the channel catalog | VERIFIED ON THE WIRE |
| `integrity` | aggregated APIService health (`apiservices` only — no CustomResourceDefinition read exists on this path) | VERIFIED ON THE WIRE |
| `observability` | three panels: Prometheus-Operator objects (Prometheuses, ServiceMonitors, PodMonitors, PrometheusRules) with scrape-wiring and alert-rule verdicts; Kyma log, trace and metric pipelines and their readiness — **not** their destinations, which the collector does not project; and OTel agent DaemonSet coverage | VERIFIED ON THE WIRE |

BTP service instances are **not** on this tab: `modules.js` reads Kyma module CRs and the channel
catalog only.

### 4.9 Helm Releases — `?tab=helm`

| Feature | Status |
|---|---|
| Every release with chart, version, revision count, deployed status | VERIFIED ON THE WIRE |
| Search, and a real "no releases match" state distinct from "no Helm data" | IN SOURCE, UNVERIFIED |
| A release opens its own page — a destination, not a drawer | VERIFIED ON THE WIRE |
| Helm history lists every revision's labels as Kubernetes partial metadata, reads only deployed release records in full, and reads the newest record in full when none was deployed (for example, a failed install). Selecting an older revision or comparing it fetches that revision on demand and reuses it within the page | VERIFIED BY TEST (`helm.test.js`) |
| A Helm values comparison marks removed paths red on the older revision, added paths green on the newer revision, and changed paths amber on both. Every changed-path chip scrolls to that value in the applicable pane; ordinary manifest/YAML line comparisons keep their positional marking | VERIFIED BY TEST (`code-compare.test.ts`) |
| Read-only: view, compare and copy. Never install, upgrade, roll back or uninstall | VERIFIED BY TEST |

This is the most expensive read in the console, which is why it is lazy and has no Overview tile.

### 4.10 Storage & Quotas — `?tab=storage`

| Sub-tab | What it shows | Status |
|---|---|---|
| `pvcs` | claim, phase, requested (not usage) and bound capacity, StorageClass, access modes | VERIFIED ON THE WIRE |
| `quotas` | ResourceQuota coverage and headroom per namespace | VERIFIED ON THE WIRE |
| `limitranges` | LimitRange presence and defaults | VERIFIED ON THE WIRE |

A link from a PVC to the pod that mounts it is a **KNOWN GAP** (§11) — the volume-mount
relationship is real and available, so this is a wiring gap, not a data gap.

### 4.11 Security & Compliance — `?tab=security`

Three sub-tabs; `compliance` is first, so the namespace view is the default.

| Sub-tab | What it shows | Status |
|---|---|---|
| `compliance` | per-namespace findings and warnings | VERIFIED ON THE WIRE |
| `admission` | the six-tab admission-policy section (§2.3) | VERIFIED ON THE WIRE |
| `isolation` | NetworkPolicy isolation per namespace, Secret and ServiceAccount inventory (names and types, never values), container security contexts. Removed from the strip 2026-09-25, restored 2026-09-26; Namespace Compliance cross-links to it | VERIFIED LIVE 2026-09-26 |
| ~~`pdb`~~ | removed from the strip 2026-09-25; `PdbSection` kept in `SecurityTab.tsx`, not mounted | VERIFIED BY TEST |

The PDB evaluation in `/clusters/:id/policy` is unchanged; an old `?section=pdb` link falls back
to `admission`. The tab prefetches `/security` again for the isolation sub-tab.
`test/fleet/security-subtabs.test.js (source repo, not ported)` pins the three-entry strip, checks isolation is mounted and
PDBs is not, and fails on any copy that still names PDBs & Drain.

The isolation table replaced one bordered card per namespace carrying a single pill: 18 cards at
~44px each to say two facts, and the pill said "4 Policies" in green for a namespace where none of
those four selected half its pods. The table has room for the columns that turn a policy count
into a protection verdict.

`policy` (PodDisruptionBudget) and admission policy are deliberately *not* merged — they are the
two most different meanings of the word "policy".

mTLS is **not** on this tab: `security.js` reads no PeerAuthentication and no AuthorizationPolicy.
The mesh verdict lives on `?tab=network&section=mesh`, from `mesh.js`.

### 4.12 Cost & Budget — `?tab=cost`

The only tab whose numbers are **not read from the cluster**: node shapes are, the prices are not.
`/clusters/:id/cost` reads Nodes and Pods and multiplies them by a rate card held on the server
(`server/fleet/collectors/cost-catalog.js`, overridable with `FLEET_COST_CATALOG`).

| Feature | Status |
|---|---|
| Per-node monthly/hourly spend from the instance-type label and declared capacity | VERIFIED BY TEST |
| Priced on `status.capacity`, utilization measured against `status.allocatable` | VERIFIED BY TEST |
| An unpriced node makes every total a **floor** (`costIsFloor`, rendered `≥`) | VERIFIED BY TEST |
| A failed node read makes every money field `null`, never `0` | VERIFIED BY TEST |
| Namespace attribution by the mean of CPU and memory request share, plus an `unallocated` row | VERIFIED BY TEST |
| Attribution columns: Namespace · Pods (sheds first) · CPU requested (`2.33 vCPU`) · Memory requested (`6.06 GiB`) · Cost share (the mean; the CPU and memory halves in the cell tooltip, `COLUMN_INFO.costShare`) · Monthly (est.). Banner: "Unallocated capacity (available cluster buffer) 72.5% ($800 / mo)". Fits at 1440; below about 1150 px it scrolls with the fade | VERIFIED LIVE 2026-09-27 |
| What-if simulator: node count 1–20 × any catalog machine, priced server-side | IN SOURCE, UNVERIFIED |
| Two meters side by side — USD list + Kyma fee, and SAP Capacity Units — with `modelDivergencePct` | VERIFIED BY TEST |
| One currency on screen: USD only, the CU meter stated in CU and never converted for display | VERIFIED BY TEST |
| The CU meter explains itself from the wire (`cuUnitCpu`/`cuUnitMemGiB`/`cuHourlyPerUnit`/`cuRateUsd`) | VERIFIED BY TEST |
| Reserved instances, savings plans, storage, egress, load balancers, support | **DELIBERATELY NOT MODELLED** — stated on the tab |
| Any figure read from an actual SAP BTP or hyperscaler invoice | **IMPOSSIBLE** — no such API is reachable from this console |

Not in `/summary`, so no Overview tile claims a cost verdict: a modelled number has no business
in the fleet-wide roll-up beside facts read from clusters. The simulator's headroom projection is
the one derived figure on the tab — it scales the current kubelet reservation ratio onto machines
that do not exist — and the panel labels it a projection for that reason.

### 4.13 Credentials — `?tab=tokens`

| Feature | Status |
|---|---|
| This cluster's service-account token record: mode, expiry, renewability | VERIFIED ON THE WIRE |
| "No token record" as a real state | IN SOURCE, UNVERIFIED |
| Never renders the token value | VERIFIED BY TEST |
| A link to and from fleet Token Health | **KNOWN GAP** (§11) |

Labelled "Credentials" (`TAB_ABBR` `CR`) so it does not read as a second copy of the fleet rail's
Token Health page; the note on the `tokens` entry in tabs.ts gives the reasoning.

### 4.14 Network Operations → Service flows — `?tab=network&networkView=flows`

Multi-hop request journeys, rebuilt with **no tracing backend**: `/clusters/:id/traces` tails the
same `istio-proxy` access log the Edge traffic view reads, through the shared `readProxyLogs` in
`traffic.js`, and correlates the lines into hops. It reads **its own window**: traces.js sets its own
`MAX_PODS` and `DEFAULT_TAIL_LINES`, and the router caches it under its own key, so the two tabs can
show different request sets for the same moment.
`/clusters/:id/traces/:traceId` shares the list route's cache entry and re-reads nothing.

| Feature | Status |
|---|---|
| `traceparent` / `x-b3-traceid` / `x-request-id` parsed, best available correlator chosen by majority | VERIFIED BY TEST |
| Multi-hop stitching: chronological order, `seq`, `offsetMs`, per-hop `transitMs` | VERIFIED BY TEST |
| `finalStatus` taken from the **ingress** hop, not the first hop in time order | VERIFIED BY TEST |
| `worstStatus` + `errorHop` published separately — an edge 200 over an inner 503 is a retry | VERIFIED BY TEST |
| Envoy response flags decoded per hop (`UT`, `UH`, `NR`, `DC` …), comma-joined flags split correctly | VERIFIED BY TEST |
| IP → Pod / Service / Node / EndpointSlice resolution, each cell carrying the field that proves it | VERIFIED BY TEST |
| Query strings redacted before a path is published | VERIFIED BY TEST |
| Log reads skipped when the mesh provably streams the log off the pod (`readsSkipped`) | VERIFIED BY TEST |
| Waterfall, hop-by-hop flow, tail width, Re-read | VERIFIED LIVE 2026-09-25 |
| Tail, Polls and Re-read keep the journeys, endpoints and calls on screen, dimmed, until the new read lands (`StaleReadNotice`); Network Operations warms `/traces?tailLines=500` immediately after edge evidence, so the two share one proxy-log tail. First open after 20 s on Overview: 336 ms, was about 11 s. Returning to the view opens on its last good read while it re-reads, as on Edge traffic | VERIFIED LIVE 2026-09-27 |
| Workspace scroll: no page scroll; sub-tabs and FilterBar fixed (Journeys has no tile row since 2026-09-27; Endpoints, Map and Outbound keep theirs); the journey table and the journey panel's body each scroll on their own, no horizontal overflow; Endpoints/Map/Outbound scroll below the tiles with their FilterBar pinned. The list has a 240px floor; a shorter window scrolls the column, never a 0px list. At least 8 journey rows show at 1440×900 and 5 at 1100×800 | VERIFIED LIVE 2026-09-27 (Playwright: 8 and 5) |
| **Request waterfall**: every hop in order on a 0 · middle · end axis, bars to scale by `offsetMs`/`durationMs` (`barOf` in `waterfall.ts`, tested). Each bar is split: the solid part is the upstream's own time (`x-envoy-upstream-service-time`), the pale part proxy and connection; a hop that logged no upstream time is outlined ("split not logged"), never solid, and a hop with no start stamp says so instead of sitting at 0. Under it, "Where X went: app · proxy · network and proxies between hops" (`journeyBreakdown`), exact when the hops nest (D1 = sum of transit + last hop's proxy + its upstream), marked *derived* when the hops were ordered by duration (a request-id journey, no span ids), and "No time split: reason" when the hops do not nest (`nestingAnomaly`), the edge has no duration, or the innermost hop logged no upstream time. Inferred outbound connections are dashed rows `↳ destination` under the hops, placed on the hops' own zero (the earliest hop start); a connection that outlived the journey runs off the right edge with its exact lifetime printed, one that starts before the first hop (clock skew) is cut at 0; `+N more outbound` past 8 | VERIFIED LIVE 2026-09-25 (applecare `/login/callback`: 151ms = app 149 · proxy 1 · between 1; ↳ 18.213.242.208:443 5.14s+) |
| Toolbar: Namespace and Search sit on the Request journeys heading; the shared `FilterBar` holds the outcome chips All · App journeys · Declared egress · Security refusals · App errors · Slow ≥ 500ms · Multi-hop with row counts, Tail and Polls under Read options, Re-read, Clear filters. Journeys opens on App journeys when the server classifies requests and any exist, else All (`initialOutcome`); a Tail or scope change re-applies that default until a person picks an outcome. The class chips read each journey's request class (`classifyJourney` in `server/fleet/collectors/request-class.js`: app, egress-declared, egress-undeclared, egress-unverified, platform, probe, security-refused, direct-or-tls); App errors is a 5xx or an upstream-failure flag on an app journey, so a refused 403 is never one. A server older than the class field (no `classCounts`) disables those chips with a reason and shows "—" for their counts and the App errors tile (`outcomeUnclassified`). Journeys carries no tile row since 2026-09-27: its four tiles repeated these chips one for one. "Hop order inferred" is one badge beside the sub-tabs, naming the correlation source from 1280px up | VERIFIED LIVE 2026-09-25 (one read: Errors 66, Multi-hop 101, Slow 0 of 200; each read differs slightly); class chips VERIFIED LIVE 2026-09-27 (platform-sbx, all namespaces: before the app-first cap, 188 direct-or-tls, 12 security refusals, 0 app of the 200 newest; after it, 6 app, 23 security refusals, 171 direct-or-tls) |
| Counts are over the **kept** journeys (the collector's `MAX_TRACES` 200). The cap keeps app and egress journeys first, then fills with the newest noise (`capJourneys` in `server/fleet/collectors/traces.js`, `server/fleet/__tests__/traces-cap.test.js`), and the result line reads "N of 200 journeys · 200 kept of M: app first"; the hint adds "Showing the newest 200 of 1,502 journeys, started 4m ago to 1m ago" — the window line alone spans hours | VERIFIED LIVE 2026-09-25 |
| Journey panel: Host, Trace ID and Request ID full width with `break-all` (Trace ID overlapped Request ID before); Worst hop reads "none — every hop answered 2xx/3xx" instead of an em dash when `worstStatus` is null and every hop is ok; HTTP 401 has tailored guidance (`via_upstream` vs `jwt_authn_access_denied`) | VERIFIED LIVE 2026-09-25 |
| Liveness polls left out server-side **before** the 200 cap (`POLL_RULES` in `traces.js`: Streamlit health/host-config, `/healthz`-style, Istio readiness, Actuator, Quarkus, metrics). A failing poll always stays; `/_stcore/stream` is a user session and never a poll. "Polls hidden N" toggles `?polls=show`; the hint names the hidden kinds | VERIFIED LIVE 2026-09-25 (one read: 746 of 1,160 journeys hidden; before, all 200 slots were polls) |
| Namespace scope (`?ns=`, the shared `NamespaceFilter`): the server reads that namespace's sidecars plus the ingress gateways, **before** the 12-proxy budget, and keeps journeys touching it. Options are every namespace with a running sidecar (`window.meshNamespaces`) | VERIFIED LIVE 2026-09-25 (one read, applecare: 5 of 5 proxies — 3 gateways + 2 applecare sidecars — 0 skipped; unscoped skipped 29 of 41) |
| Columns: Status · Request · Host · Duration · Hops · Started · Trace ID; default shed tier (was `wide`, which hid Trace ID at 1440). Host and Trace ID shed first when the panel opens — 0px overflow at 667px | VERIFIED LIVE 2026-09-25 |
| `traceparent` absent reported as a **configuration finding**, with `nestingInferred` | VERIFIED BY TEST |
| Hop nesting read from span ids when the mesh emits them | VERIFIED LIVE 2026-09-25 — platformsbx now logs `traceparent` (1,872 of 3,392 lines; `nestingInferred: false`). On a mesh whose format omits it, nesting is inferred from duration and the tab says so |
| A negative transit time (clock skew, or two requests sharing an id) | Published as `null` + `nestingAnomaly`, never as `0` or a negative bar |
| A deep link into SAP Cloud Logging | **IMPOSSIBLE** — the tenant's dashboard host is a binding in another subaccount and is not readable here. The tab names the sink Envoy streams to and tells the operator to search it by trace id |
| Spans from the mesh's own tracing pipeline | **IMPOSSIBLE** — on the reference cluster the mesh config's `enableTracing` is false, which governs whatever the sampling rate says, so no span leaves this cluster; and this console cannot scrape one |
| Sub-tabs: `?section=journeys` (default, **Requests**) · `successful` (**Successful requests**) · `map` (**Service calls**) · `endpoints` · `outbound` (**External calls**) · `refused` (**Blocked requests**). Successful requests means a 2xx/3xx edge result, at least one observed hop and no observed failed hop; it does not claim success across proxies outside the read. Three figures sit above its table (Successful, p95 duration printed from 20 durations, Observed hops); a window that was not read shows a dash with its reason, never 0; on a capped window a line under them says the figures cover the kept journeys only (`keptCaption`), and an empty table names the kept journeys rather than the window. Its explicit **Include successful liveness polls** checkbox re-reads the same window with otherwise-hidden successful probes. Selecting one opens that request in Requests. Service calls then shows its wider call path. Journeys/Successful/Endpoints/Outbound/Map share one read (the tailed proxy lines); Blocked requests reads `/traffic-errors` instead — `ingress.refused`, the same data the Access control sub-tab of Edge traffic links to, not a duplicate collector, and it carries no Problems strip or tile row. The scope, Polls, Tail and Re-read controls sit on each | VERIFIED BY TEST |
| **Journeys → Path view**: above the waterfall, one row per hop the journey's path touched, edge to BTP (`trace.journeyPath`, `server/fleet/collectors/journey-path.js`). Edge is a static node (Load balancer type/hostname, `externalTrafficPolicy`, its LB source-range count, and every Gateway fronting it with its TLS mode and credential name — never a value; no timing, because the load balancer writes no access log). An exact link (a shared request id or `traceparent`) draws solid; an inferred one (time-based, the approuter → srv join) draws dashed with its count, "inferred · 1 of N in flight", or "declared, not observed" when a declared BTP node opened no connection in this window (never "1 of 0"). Each hop's status is a word beside its dot — Success, Warning, Error, Refused, Inferred, Unknown — never colour alone (`hopStatus` in `journey-status.ts`). A BTP/external node's timing is "opened +Nms in, open X.Xs · TCP", captioned "Connection duration" with the tooltip "HTTP/application-level latency is not available for this connection. The value represents observed connection duration from proxy access data." (`CONNECTION_DURATION_TIP`) — never printed in `ms`. An undeclared address keeps its IP plus "Undeclared". A "Failure root" line names the earliest failing gateway/workload hop and, when a refusal decided it, the deciding policy by `decidedByText`'s wording, never re-worded; an "Open in Service Map" button sets `?section=map`. The view fits the 810px pane at 1100 | VERIFIED BY TEST (`journey-path.test.ts`, `journey-status.test.ts`); live look deferred to Task 9 Step 3 |
| **Journeys → time range and read stamp**: `?since=` (`sinceOf`/`rangeNote` in `time-range.ts`) scopes both the Journeys read and Refused Requests to the same window, bounded by the tail — there is no TSDB, so 7 days and Custom are not offered, only ranges within what the tail already holds. Because `/traces` is read live on every request rather than served from the 15s cache, its stamp reads "Read at HH:MM" beside Re-read, never "Updated N ago" (that wording stays on `/traffic-errors`'s own 10-minute cache chip) | VERIFIED BY TEST (`time-range.test.ts`) |
| **Endpoints**: every kept journey (not only the 200 in the table) grouped by method + host + path, each row naming its **Service** (the workload that served the entry — the gateway's upstream pod, else the first sidecar — host on hover), identifiers folded to `{id}` (digits, UUIDs, 12+ hex, 20+ mixed-alnum, and a bundler hash between name and extension like `index.C8X8rNzw.css` — cache-busted bundles fold too). Journeys, Errors, Error rate, p50, p95 (printed only from 20 samples; below it the cell says `n=3`), the commonest edge status code with a `+N` for the rest (all on hover, so a row stays one line), Last seen. Top 100 rows. Headline tiles: Endpoints, Failing (≥5%, press to keep only failing rows), Worst error rate, Slowest p95 (p50 when nothing has 20 samples); the table is busiest first, so no tile repeats it (dropped 2026-09-28 to keep the 4-tile limit); Error rate is amber under 5%, red from 5%. Probes, security refusals and direct-IP or TLS rejections are left out so p50 and p95 are app latency; "Include N filtered" beside the heading switches table and tiles to `endpointsAll`, its tooltip counting each class left out (`endpointsFiltered`). A row opens its newest journey; one older than the table's 200 is fetched through the detail route (`endpointSamples`, stripped from the list response by `listView`) and marked "Opened from Endpoints" | VERIFIED LIVE 2026-09-25 (applecare: 21 endpoints; `/_stcore/stream` 358 journeys, all 401); noise filter VERIFIED LIVE 2026-09-27 (platform-sbx: 4 endpoints, Include 519 filtered → 153) |
| **Service map**: built from every parsed line, not from journeys, so TCP egress with no correlation header (a database, an HTTPS passthrough) is an arrow. Pods fold to their workload (ReplicaSet → Deployment by the `pod-template-hash` label). Each call is counted once, from the proxy that saw more of it (`observedBy` both / caller / callee). Every caller outside the cluster, and every caller address no Pod, Service or Node claims, is one "Outside the cluster" node — no client IP is published, and journey hops drop the calling client's address too. An inbound line whose peer is a public address (X-Forwarded-For) is attributed to the gateway that logged the same `x-request-id`. An inbound line that arrived over sidecar mTLS (SNI `outbound_.<port>_._.<host>`) whose caller cannot be joined is an "In-mesh caller (unnamed)" node, not an outside client. SVG column layout (`service-map-layout.ts`, tested), each arrow labelled calls · p95 (p50 below 20 samples) · failure share, arrow width by volume, colour by failure share (≥5% red), TCP dashed; a call within one column is an arc beside it; a node click filters the Calls table beneath, an arrow opens its numbers. **All calls / Healthy only / Failing only** redraw both map and table. Healthy only keeps an arrow only when every observed call aggregated into it completed without an Envoy failure, so a mixed arrow is never presented as wholly successful. Headline tiles: Workloads, Calls, Failing calls, Slowest call p95. The svg scales to its pane (viewBox from the placed extent, labels included) down to 3/4 of its size, then the box scrolls (three columns fit the 810px pane at 1100; four or more scroll, since fitting them would draw text near 6px); edge labels are placed in the gap nearest their midpoint and step aside on a collision, never over a node or another label; a picked arrow reads "Calls by status" over every call, with the calls no code covers counted as "other or no status" | VERIFIED LIVE 2026-09-29 (platform-sbx: Healthy only → compass-runtime-agent → 34.141.121.68:443, 68 calls, 0 failures); layout fit VERIFIED LIVE 2026-09-28 (platformsbx, 1100×800: 1024 units in the 810px box, no scroll) |
| **Request → Service calls drill-down**: opening Service calls from a selected request selects an edge only when its `traceIds` include that request's correlation id. The panel states that basis. A request with no matching edge leaves the map unselected; the console never infers an edge from timing alone | VERIFIED BY TEST (`service-map-drill.test.ts`) |
| **Outbound**: one row per calling workload and destination, from the caller's own sidecar (outbound and PassthroughCluster lines; inbound, InboundPassthroughCluster and self-calls left out; gateways left out, their onward calls are the journeys). Destination is the Service, Pod or Node that claims the address, else the IP or host and port. An external address no object names carries a second line: Undeclared when the NetworkPolicy list was read whole, Unavailable when it was refused, Unverified when it stopped at the paging ceiling (`declaredBy` and `policyRead` in `egress-view.ts`); a named one names its declaring policy, pipeline or load balancer in the tooltip. Connections (+ tcp/http/mixed), Error rate, p50 (p95 and the lifetime note on hover), Bytes out / in ("—" when no line carried bytes, never 0), Linked request, Last seen. A line with a trace header links **exact** and names its journey, preferred as the row's sample; one without links **inferred** by time to the inbound request its pod was serving when the connection opened, the innermost when several were in flight ("inferred, 1 of N"), **unlinked** when none was. A pooled connection links only to the request that opened it; TCP duration is the connection's lifetime, not a latency. Top 100 rows. Tiles: Calling workloads, Destinations (N outside the cluster), Connections (N with no trace header), Failing (≥ 5%, press to filter); the Linked request column carries what a "Tied to a request" tile said (dropped 2026-09-28, 4-tile limit). A row opens its linked journey, whose waterfall shows the connection | VERIFIED LIVE 2026-09-25 (applecare: approuter → 18.213.242.208:443 2 TCP, linked /login/callback; srv → 3.214.110.153:443 1 TCP, linked /_stcore/stream); Undeclared line VERIFIED LIVE 2026-09-27 (compass-runtime-agent → 34.141.121.68:443, no policy names it) |
| **Outbound → Declaration and Policy columns**: `confidenceOf` in `journey-status.ts` reads Explicit (named by a NetworkPolicy annotation or ipBlock), Inferred (the resolver's other, less certain sources), or Undeclared (no NetworkPolicy names it) from the same `destination-names.js` resolver Outbound already used for its "Undeclared/Unavailable/Unverified" second line; the Policy column carries the declaring policy's name or "—". Both columns are priority 3 (`shed="wide"`, raised from `mid` for the now 10-column table) | VERIFIED BY TEST (`journey-status.test.ts`, `table-shed-tier.test.js`) |
| A TCP line counted as an error | Never: Envoy logs code 0 for every TCP connection, so a TCP line fails only on a response flag (`failed()` in `service-map.js`) |
| **Service map → journeys drill-down**: each arrow lists the up-to-10 newest journeys it carried (`edge.traceIds`/`traceIdsFound` from `service-map.js`'s `witness`), opening the one clicked in Journeys — already in the table, or fetched by id when older than its 200-row cap (`edgeJourneys` in `service-map-drill.ts`). A node touched by an arrow at or above the 5% failure-share threshold (`isFailing`, reused from `service-map-layout.ts`) is marked failing on the map, never singled out as "the" failing journey | VERIFIED BY TEST (`service-map-drill.test.ts`) |
| **Refused Requests** (fifth sub-tab, `TracesRefused.tsx`): every group from `ingress.refused` — the same edge-and-sidecar refusal read Ingress & Traffic's Access control links to, never a second collector. Columns: Time (`ago(lastSeen)`, `firstSeen` on hover), Host, Class, Method, Path, Code (`bad` for 4xx/5xx, "none" for a code of 0), Why, Decided by, Count. "Decided by" opens the deciding AuthorizationPolicy in the Live YAML drawer; a decider reads `named` (Envoy's own `matched_policy[...]`), `elimination` ("decided by elimination" — the ALLOW-miss proxy has exactly one selecting ALLOW policy, so it is the only one that could have refused, though Envoy itself logs `[none]`), or `inferred` (more than one selecting ALLOW policy, so no single name is certain). A TLS refusal before HTTP (`filter_chain_not_found`, no SNI) reads "TLS refused before HTTP" rather than a blank method or path. Filters: Policy, Class, Status (0 renders "none"), plus a search box over host/path/policy text only — never a client address. Four states: loading, an error banner with Retry, "This server did not send refused requests" (an older server), and "No refused requests found". The sub-tab count is the same lifted `/traffic-errors` read `TracesTab.tsx` already makes for the count chip — Refused Requests never fetches its own copy | VERIFIED BY TEST (`traces-tab-cleanup.test.js`, `refused-view.test.ts`); guarded against ever saying "attack", "hacker" or "malicious" |
| approuter → srv and srv → HANA arrows on the reference cluster | **PARTIAL** — srv's sidecar logs the calls inbound, but approuter's sidecar logs no outbound line and approuter forwards neither `x-request-id` nor `traceparent` (0 of 38 srv trace ids appear in approuter's 3,000 lines, measured 2026-09-25), so the caller cannot be named: the arrow reads In-mesh caller → srv. srv → HANA is TCP egress to the database's address. Naming approuter needs it to forward the headers, or its sidecar to log outbound |

The tab never claims a hop count is a topology. A proxy that was not tailed contributes no hop, so
a one-hop journey may be a five-hop request seen once — the proxies read, skipped and failed are
printed below the table as the denominator for every count above it.

#### Limitations — deliberate, not oversights

Each was investigated (`.superpowers/sdd/2026-09-28-traces-e2e-journey/investigate-*.md`) and
classed by why it cannot be built: **(A)** a small wiring change, already shipped in this phase;
**(B)** would need a grant this repo has already refused; **(C)** would need a platform or app
change outside this console's read-only scope; **(D)** not obtainable at all, by design of the
platform it reads.

| Gap | Class | Why |
|---|---|---|
| Load-balancer timing per request | D | The load balancer writes no access log; the Edge node is a static fact card (LB type, hostname, `externalTrafficPolicy`, source-range count, fronting Gateways), never a per-request hop |
| Envoy connection metrics (`upstream_cx_connect_ms`, `upstream_cx_length_ms`, live open connections) | B | Needs `pods/proxy` on every workload's admin port, cluster-wide — refused in the 2026-09-16 RBAC audit and again here; even granted it would show connection timing, never request latency |
| Exact Approuter → srv correlation | C-shaped in practice | No shared request id crosses that hop (approuter forwards neither `x-request-id` nor `traceparent`); the join is inferred by time, dashed, and counts its candidates — never presented as exact |
| Distributed tracing (real spans) | D | `enableTracing: false` on the mesh, no in-cluster trace store, and no OpenTelemetry SDK in `srv` or the approuter; access-log stitching is the only signal on the wire today |
| Live external connections (open now, not "seen in this window") | B | Same `pods/proxy` refusal as Envoy connection metrics above |

**Do not, to fix any of these:**
- flip `enableTracing: true`, add a `tracing` key to the Istio module CR, or touch `telemetry-config`
- add a TracePipeline, an in-cluster collector, or any Jaeger/Tempo/Zipkin deployment
- add `@cap-js/telemetry` or any `@opentelemetry/*` package to `srv` or the approuter
- request `pods/proxy`, `services/proxy` or `nodes/proxy` for the fleet's service account
- request or wire a CLS OpenSearch Dashboards/query credential, or add its host to the egress allowlist

### 4.15 Top Utilization — removed 2026-09-27

Its six sections (overview, namespaces, pods, allocation, qos, pressure) were retired; the ranking
lives on as the Top Consumers sub-tab of Namespaces & Workloads (§4.2), and the old URLs redirect
there. Recover the tab with `git show 652b4fb:src/pages/cluster-tabs/UtilizationTab.tsx`
and the folder beside it.

### 4.16 Former Observability tab (latency) — removed 2026-09-25

The latency screen that held `?tab=observability` on that date (service and route latency, TCP
connections, access-log sources) was removed completely: `ObservabilityTab.tsx` and its pure module
`latency.ts` are deleted. The id was reused since for the platform observability panels, so
`?tab=observability` now opens them (§4.8, the `observability` section) and no longer falls to
Overview. The server's latency aggregation in `/clusters/:id/traffic-errors` and
`/clusters/:id/observability` are unchanged, because Ingress & Traffic and Modules & Telemetry →
Observability still read them.

---

## 5. Cross-cutting machinery

These are not tabs; they are the parts every tab shares.

### 5.1 The resource drawer

`?res=Kind/namespace/name` opens any registered object from anywhere. Seventeen Kinds:

Deployment · StatefulSet · DaemonSet · Pod · Container · Node · Service · Ingress · APIRule ·
VirtualService · HorizontalPodAutoscaler · CronJob · PersistentVolumeClaim · ResourceQuota ·
Certificate · Namespace · HelmRelease

| Feature | Status |
|---|---|
| Resolvers never fetch — the drawer reads what the page already has | VERIFIED BY TEST |
| Related resources, grouped by relation, capped at 24 per relation | VERIFIED BY TEST |
| Every relation is a **real** one: `ownerReferences`, selectors, `targetRef`, service routing, volume mounts, Helm metadata | VERIFIED BY TEST |
| Live YAML for the selected object, with five redactions applied | VERIFIED BY TEST |
| "Not in view" is a real state — a ref can outlive a rename | VERIFIED BY TEST |
| Inline at ≥1200px as `role="complementary"` with no focus trap; overlay as `role="dialog"` + `aria-modal` with a real trap | VERIFIED LIVE |
| **Where else to look** — investigation steps for the selected object | VERIFIED LIVE |

**"Where else to look"**: for a Pod or Container it offers *View live logs*
always, and *Logs before the last restart* only when that specific container has restarted — with
the reason spelled out ("restarted 12 times — the reason is in the previous instance"). The
restart count is scoped to the selected container, so a flapping sidecar does not offer a
previous-instance link on a healthy app container. It is navigation only; nothing in it acts on
the cluster.

### 5.2 URL state

Every place is addressable: `#/clusters/<id>?tab=<tab>&section=<section>&res=<Kind/ns/name>`, plus
the Logs tab's `ns`/`pod`/`container`/`previous` and the Traffic tab's tail. All use
`replace: true` so the back button steps between *pages*, not between sub-tab clicks. Sub-tab
sections unmount rather than hide, so an unopened section costs nothing.

### 5.3 Two separate verdicts

| Verdict | Question | Where it lives |
|---|---|---|
| **Health** | is the thing working | per-Kind, per-domain; never a generic Kubernetes "Ready" |
| **Completeness** | did we manage to read it | `summary.unavailable[]` and `summary.truncated[]` on every envelope |

They never mix. `signals.js` relays the backend's verdicts and derives none, which is why 17 green
pills cannot appear on a crashlooping cluster. Health severity ranks `attention` worse than
`unknown` worse than `warn` worse than `partial` worse than `clear` — worst wins, and `unknown`
ranks worse than `warn` on purpose.

Only 1 of 12 real Kubernetes types has a `Ready` condition, so health is **declared per type**,
never derived.

### 5.4 Performance

| Mechanism | What it does | Status |
|---|---|---|
| GET coalescing | two components asking for the same URL share one request | VERIFIED BY TEST |
| Prefetch sweep | serial, low-priority, worst-first, 30 s TTL, 1.2 s head start | VERIFIED BY TEST |
| Hover-intent prefetch | hovering a row warms the click's read (6494 ms → 55 ms measured) — on ClusterDetail and HelmTab, not the Overview roster (§3.1) | VERIFIED BY TEST |
| Cache-key sharing | `/summary` and `/clusters/:id/summary` read each group per cluster, under that group's per-cluster route key (`clusterKey` in `SUMMARY_GROUPS`, else `<cacheKey>:<id>`), so a cluster tab opened after its summary reads warm; the fleet-wide group routes keep their own entries (test `/clusters/:id/summary shares a cache entry…`) | VERIFIED BY TEST |
| Metadata-only reads | `PartialObjectMetadataList` is 32× smaller where only names are needed | VERIFIED BY TEST |
| Concurrency gate | bounded parallelism per cluster, with backoff on 429 | VERIFIED BY TEST |
| gzip | 32% faster, 7× less bandwidth | VERIFIED BY TEST |
| Traffic cache with bypass | 15 s fresh + 585 s stale-while-revalidate, 10 minutes in all (user decision 2026-09-28; guard `traffic-cache-window.test.js`) (`FLEET_TRAFFIC_CACHE_STALE_MS`), `cache-control` bypass, proxy tails shared with `/traces` (`proxy-log-share.js`) | VERIFIED BY TEST |
| Logs never cached | the one read that must be current | IN SOURCE, UNVERIFIED |

Cache keys are shared between a summary and the per-cluster routes it summarises, not between a
fleet route and its per-cluster sibling: `/security` caches under `security` and
`/clusters/:id/security` under `sec:<id>` (`SUMMARY_GROUPS` in server/fleet/router.js), and `/report`
reuses the `/clusters`, `/compliance` and `/security` entries. A route the digest calls after one
that shares its entry answers warm, so §4 of `docs/research/FLEET_API_DIGEST.md` reads its timings
as first-visit cost in call order, not as a benchmark.

### 5.5 Tables

One container-query-driven table platform. Columns shed at container widths, set by the tier
classes in theme.css (`.tbl-mid`, `.tbl-wide`, `.tbl-xwide`, `.tbl-lean`), not at viewport widths,
because a table inside a 1090px pane at 1440px viewport is not a 1440px table. A shed tier set too
low sheds nothing and clips instead.

| Feature | Status |
|---|---|
| Container-query column shedding with declared `max` per column | VERIFIED LIVE |
| Pinned first column | VERIFIED LIVE |
| Column sorting with `aria-sort`, on every `DataTable` column that declares `sortValue` | IN SOURCE, UNVERIFIED |
| Scoped search on every table | **KNOWN GAP** (§11) — present on some, not all |
| URL-backed filter state | **KNOWN GAP** (§11) |

No hard pixel column widths and no new truncation work was needed for the predictive badging below:
`max` ceilings per column, `middleTruncate` for pod names and `test/fleet/table-fit.test.js (source repo, not ported)` already
own that, and the new badge rides inside the existing Status cell rather than adding a column that
would have pushed the Scheduled pods table past its width budget.

### 5.6 Limit-proximity badging — a forecast, kept apart from the facts

`assessResourceRisk` (`usage/resource-risk.ts`) is the single place that judges live usage
against a declared limit, so a pod flagged in one table and the same pod in the Nodes tab
cannot disagree. Memory and CPU are judged apart because the consequences differ: memory is
incompressible and the kernel kills at the limit, CPU is compressible and the kernel only makes the
container wait.

| Feature | Status |
|---|---|
| Memory ≥ 90% / ≥ 80% of limit → `OOMKill Risk` / `High Memory` | VERIFIED BY TEST |
| CPU ≥ 95% of limit → `CPU Throttled` | VERIFIED BY TEST |
| Every console-chosen threshold marked `heuristic` (dashed underline) | VERIFIED BY TEST |
| Nodes → Scheduled pods: worst container per pod, memory winning a tie | VERIFIED BY TEST (`node-pods.test.ts`) |
| No badge from a missing sample, a missing limit or an unjoined pod — `null`, never "fine" | VERIFIED BY TEST |
| CFS throttling itself observed | **IMPOSSIBLE** — no `container_cpu_cfs_throttled_periods_total` on this fleet; `CPU_THROTTLE_NOTE` says so on the badge |

An `OOM Risk` badge and an `OOMKilled` badge are different claims and are worded differently: the
first is conditional and forecast, the second is a kubelet fact in the past tense. `diagnosis.test.ts`
pins that wording.

### 5.7 "What went wrong?" — the explanation drawer

`diagnosis.ts` is a registry, not a generator: one entry per outcome this console can actually
explain, and `known: false` for anything else so the fallback is never dressed up as an answer.
`DiagnosisDrawer` renders it through `DetailPanel` (modal with a focus trap below 1280px, inline
above), and `DiagnosisBody` is exported so Ingress & Traffic can inline the same explanation in the
drawer it already has open — one body, so two tabs cannot give two accounts of the same 503.

| Clickable subject | Where | Status |
|---|---|---|
| `OOMKilled`, `CrashLoopBackOff` | Nodes → Scheduled pods, Status cell | VERIFIED BY TEST |
| `OOM Risk` / `Throttling Risk` badge | Nodes → Scheduled pods, Status cell | VERIFIED BY TEST |
| HTTP `403`, `404`, `502`, `503`, `504`, and code `0` | Traces hop steps; Ingress & Traffic failing-request drawer | VERIFIED BY TEST |
| Any other status code | anywhere above | renders `no guidance` rather than invented copy |
| Image drift | Reliability → Rollouts | explained by `DriftInspector`, **not** by this registry — it shows both image references, the owner-resolution reason and the quick-fix command, which a generic entry cannot |

Commands are **copied, never run** — this console holds a read-only credential and there is no
execution path behind the button. A refused clipboard write reads `Blocked` rather than flashing
`Copied` over a copy that did not happen.

### 5.8 Theme

A light theme as a pure token override, not a second design system.

| Feature | Status |
|---|---|
| `html.light` overrides the `@theme` tokens; `html.dark` sets `color-scheme` | VERIFIED LIVE |
| Toggle in the sidebar footer, `aria-pressed`, action-phrased label ("Switch to light theme") | VERIFIED LIVE |
| Three-state preference — `system` \| `dark` \| `light` — following the OS only while `system` | VERIFIED BY TEST |
| A hand-edited or unknown stored value falls back to `system` | VERIFIED BY TEST |
| Survives a `localStorage` that throws, which is the private-window case | VERIFIED BY TEST |
| Applied before `createRoot`, so there is no white first frame | VERIFIED LIVE |
| Favicon redrawn per theme; an inline-SVG fallback in `index.html` matches the mark | VERIFIED LIVE |
| Helm architecture graph reads `--graph-*` tokens via the CSS property, not the SVG attribute | VERIFIED LIVE |
| Toggle is two-position and never stops on `system` | VERIFIED BY TEST |

Measured, live: light `#f6f7f9` background ↔ dark `#0e1116`, `color-scheme` follows, preference
persists as `dark`/`light`, and the button's label and `aria-pressed` flip on the next render.

---

## 6. What the console deliberately does not do

| Not present | Why |
|---|---|
| restart · scale · delete · patch · apply · rollout restart · cordon · drain · exec · shell | Read-only is structurally enforced: two grep guards plus a pinned allowlist. A write path that existed (`allowRollout`) was removed. |
| Helm install · upgrade · rollback · uninstall | Same. The Helm surface views, compares and copies. |
| Policy modification | Same. Admission policy is inspected, never edited. |
| A generic Kubernetes "Ready" column | 1 of 12 real types has one. Health is declared per type. |
| Historical charts or trend lines from point-in-time state | Would be fabricated. The console has no time-series store. |
| Fabricated metrics of any kind | If it was not read, it is reported as unavailable. |
| Mock data, fixtures, or baked-in clusters | Removed, with a canaried guard test. `fleet:dev` starts empty. |
| A BTP services screen | Not built. The data is collected and nothing renders it, so the Overview has no tile for it (§4.1). |

---

## 7. Credential exposure — the complete answer

The question was: *should nothing but Helm chart material be visible?* The honest, enforced
position:

| Class | Exposed? | How it is enforced |
|---|---|---|
| Secret **values** | **Never** | Four independent redactors; the API returns Secret *keys* only |
| Bearer tokens | **Never** | Same |
| Private keys / TLS keys | **Never** | Same |
| Kubeconfig credentials | **Never** | `/clusters/kubeconfig/describe` returns no credential |
| CA material | **Never** | Same |
| `last-applied-configuration` annotation | **Deleted** | `resource-yaml.js` removes it — it would undo every other redaction on the page |
| Helm values | **Masked** | Masking inherits downward, with three inherited-only resets so it neither leaks nested credentials nor blanks 20 non-secrets |
| Container `env[].value` | **Redacted** | Covered by the sweep |
| **Pod log lines** | **Verbatim, by decision** | `collectors/logs.js` |

Enforced by `server/fleet/__tests__/no-credential-leak.test.js`: five sentinel values planted into Secret
data, TLS keys, container env, config maps and a fake `last-applied-configuration`, swept across
every route in the test's `FLEET_ROUTES` list, with a **canary** proving the detector bites and the
route is reached.

**The one documented exposure is raw pod log output.** It is passed through byte for byte, and
that is a decision, not an oversight. A log viewer whose job is to show why a container died must
not mangle the line that says so, and a pattern-based redactor over arbitrary application output
silently corrupts stack traces, base64 payloads and request ids that merely resemble a token.
`kubectl logs` is the baseline this matches; anyone with the dashboard's `pods/log` grant can
already read the same bytes. A **positive test** asserts logs *are* verbatim, so the exception
stays a decision somebody made rather than a hole nobody noticed. Reversing it is a one-module
change, which is why logs live in their own collector behind their own route and their own RBAC
rule.

---

## 8. Accessibility

| Contract | Status |
|---|---|
| Inline drawer is `role="complementary"`, no focus trap, at ≥1200px | VERIFIED LIVE |
| Overlay drawer is `role="dialog"` + `aria-modal` with a real focus trap | VERIFIED LIVE |
| Sub-tab strips are `role="tablist"` with `role="tab"` and `aria-selected` | VERIFIED LIVE |
| Theme toggle carries `aria-pressed` and an action-phrased `aria-label` | VERIFIED LIVE |
| Rail abbreviations are `aria-hidden`; the full label is the accessible name | VERIFIED LIVE |
| Sidebar resize handle is a `separator` with arrow-key, Home and End handling | VERIFIED LIVE |
| Table column sorting announced via `aria-sort` (`DataTable`) | IN SOURCE, UNVERIFIED |
| Skip-to-content link | **KNOWN GAP** (§11) |
| `aria-live` region for refresh and log follow state | **KNOWN GAP** (§11) |
| 44px minimum touch targets | **DEFERRED** (§11) |
| Disabled-CTA contrast (≈3.5:1 when measured) | **DEFERRED** (§11) |
| Architecture graph nodes are focusable and open on Enter or Space (HelmArchitecture.tsx) | IN SOURCE, UNVERIFIED — no arrow-key traversal between nodes |

---

## 9. Routes

`listRoutes` in `server/fleet/__tests__/helpers/router-harness.js` enumerates every registered route;
`docs/architecture/DASHBOARD_API_COMMAND_DATA_INVENTORY.md` maps each one to the screen that reads
it; `docs/research/FLEET_API_DIGEST.md` has each route's command, fields, console caller,
Kubernetes reads and measured latency. Three facts
those do not carry:

- `/clusters/:id/logs` is outside the credential sweep, and the digest calls it for its structure
  only: its output is verbatim by decision (§7).
- `/clusters/:id/traces/:traceId` shares the list route's cache entry and re-reads nothing.
- Several fleet-wide routes have no screen that reads them, and their cache entries are their own:
  both summaries read per cluster under the per-cluster route's key (`summarizeGroups` in
  server/fleet/router.js). A fleet-wide problem view is not built (§11).

**Four envelope shapes** are in use and each roots its payload differently — `wrapper`, `roster`,
`flattened`, `inline`. A panel author who assumes one shape finds the rows missing rather than
wrong. `docs/research/FLEET_API_DIGEST.md` §2 has the table; `shapeOf` in
`server/fleet/tools/api-digest.js` classifies them, and `server/fleet/__tests__/api-digest.test.js` pins it.

---

## 10. Tools

| Command | What it produces |
|---|---|
| `npm run fleet:dev` | the real router on `:8099`, no auth, empty registry, in-memory tokens |
| `npm run watch-fleet-ui` | Vite on `:5173`, proxying `/api/fleet` to `:8099` |
| `npm run fleet:onboard` | creates the `fleet-reader` RBAC and mints a token |
| `npm run fleet:inventory` | *what is in the cluster* — every API group and Kind, with counts and a permission verdict. Needs a kubeconfig and a token file. |
| `npm run fleet:digest` | *what this console already extracts* — every route, every field, every latency, value-free. Needs only a running server. |
| `npm test` | `test:fleet` (node --test) then `test:ui` (vitest) |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.json` over the UI (there is no lint script on this branch) |

`fleet:inventory` and `fleet:digest` are complements. A field in the digest can be rendered today
with no backend work; a Kind that appears only in the inventory needs a collector first.

---

## 11. Open gaps, ranked

Checked against the source on 2026-09-24, ordered by what an operator loses.

| # | Gap | Where it shows |
|---|---|---|
| 1 | The Traffic Errors redesign is built and not mounted | `traffic/TrafficErrorsPage.tsx` has no importer (§4.6) |
| 2 | Failing destination → its Service → workload → logs, as one path | the failures drawer links the reporting Pods only (§4.6) |
| 3 | An Overview tile opens its tab but does not filter it to the failing rows | §4.1 |
| 4 | Token Health ↔ Credentials has no link in either direction | pages/Tokens.tsx, §4.13 |
| 5 | Drift finding → the affected cluster's relevant section | pages/Drift.tsx links no cluster (§3.3) |
| 6 | HPA row → scale-target workload | the Target Workload cell is text (§4.5) |
| 7 | PVC → the pod that mounts it | no mount column on StorageTab.tsx (§4.10) |
| 8 | Search on some tables only, and no table's filter state is in the URL | §5.5 |
| 9 | Freshness is one console-wide "synced … ago" stamp; no per-page stamp | the rail footer in components/layout.tsx (§3.1) |
| 10 | Log follow state has no visible indicator and no `aria-live` announcement | §4.3, §8 |
| 11 | No skip-to-content link | §8 |
| 12 | No breadcrumbs on the three-deep admission views (`?section=admission&opa=…`) | §2.3 |
| 13 | No fleet-wide problem view over the fleet routes that have no screen | §9 |
| 14 | BTP services are collected and rendered nowhere | §4.1, §6 |
| 15 | `npm run lint` does not cover `app/fleet-ui` | §10 |

### Deferred on purpose

| Item | Reason |
|---|---|
| 44px touch targets, disabled-CTA contrast | One cross-cutting cosmetic pass; mixed into a feature change, neither is diagnosable |
| A BTP tile pointed at another tab | A tile that sends the operator to a tab without what it named is worse than no tile; build the screen (#14) |
| Row virtualization | Waits for a measurement showing a table slow at real row counts |
| Merging the two severity scales | `critical\|warning\|info` and `high\|medium\|low` are different axes; merging loses meaning |
| CSV export, row multi-select, pagination | No operator workflow asks for them |

### Still unverified

- Table rendering above ~1,000 rows: no virtualization exists.
- Contrast ratios and focus-visible across every control: no automated pass.
- Header and scope semantics in the tables not built on `DataTable`.
- Whether a `.tbl-mid` shed tier is mis-specified on a `DataTable` other than Nodes and Workloads.
- Two findings recorded open on 2026-09-18 that need a product decision rather than a fix: the
  `/summary` pod-list amplification and the OIDC discovery sink.
