/**
 * One cluster, everything about it, on one page.
 *
 * The fleet pages answer "which cluster should I care about"; this one is where you go
 * once you know. It is fed by a single `/clusters/:id/overview` request that fans out
 * health, compliance, workloads and events server-side — four round trips from the
 * browser would have shown four independent spinners and four independent failure modes
 * for what is conceptually one question.
 *
 * The sections are tabs rather than a long scroll because the four bodies are genuinely
 * different subjects, and stacking them would bury the node table — the thing most
 * often being looked for — under a compliance list nobody scrolled past.
 */
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { PageProps } from '../App';
import {
  api,
  type ComplianceRollup,
  type EventRow,
  type NamespaceRow,
  type NodeRow,
  type WorkloadRow,
  type Workloads
} from '../api';
import { ACTIONS, Column, DataTable } from '../components/DataTable';
import { DetailPanel, Field, PageHeader, Section } from '../components/layout';
import { DiagnosisDrawer } from '../components/DiagnosisDrawer';
import { diagnose, type DiagnosisSubject } from '../diagnosis';
import { RolloutStatusView } from '../components/Rollout';
import {
  RelatedInvestigationLinks,
  ResourceDataProvider,
  ResourceDetailDrawer,
  ResourceLink
} from '../components/ResourceLink';
import { investigationSteps } from '../resources/investigate';
import { makeOverviewResolver } from '../resources/resolve';
import { refFromParam, type ResourceKind } from '../resources/types';
import { isKind, RESOURCE_REGISTRY } from '../resources/registry';
import {
  Btn,
  CapacityBar,
  Card,
  Empty,
  ErrorState,
  Pair,
  Pill,
  Skeleton,
  TabErrorBoundary,
  TONE_TEXT,
  type Tone
} from '../components/ui';
import {
  Count,
  MetricValue,
  truncatedEntries,
  UnavailableEmptyBody,
  UnavailableNotice,
  unavailableEntries,
  unavailableScope,
  type MetricStatus
} from '../components/unavailable';
// Both CPU formatters, deliberately: `cores` for a node's or the cluster's capacity, rendered next
// to the word "cores"; `cpu` for one pod's or container's sample and request, where a real 7m
// reading has to read as `7m` rather than `0`. See the doc comments in format.ts.
import { ago, bytes, cores, cpu, duration, percent } from '../format';
import { CHECK_LABEL, checkTone, seedCommand, TOKEN_LABEL, tokenTone, verdictTone, workloadTone } from '../status';
import { useAsync } from '../useAsync';
import * as prefetch from '../prefetch';
import CapacitySection from './cluster-tabs/CapacitySection';
import NodeTaintsSection from './cluster-tabs/NodeTaintsSection';
import { SubTabs, useSection } from '../components/SubTabs';
/*
 * The tab bodies, loaded when a tab is first opened.
 *
 * Sixteen tabs were imported eagerly here, so every one of them — their tables, their filter models,
 * their charts — was in the chunk that has to arrive before the page paints, whichever single tab the
 * operator actually wanted. A cluster page opens on Overview.
 *
 * The same boundary `HelmReleasePage` draws around its graph, for the same reason and with the same
 * `<Suspense>` fallback. Two tabs stay eager and both earn it:
 *
 *   OverviewTab   the default tab — lazily loading what always renders first would add a round trip
 *                 to the one path every operator takes.
 *   TokensTab     small, and it is the tab an operator reaches for when the others are failing with
 *                 an auth error; it must not itself depend on a fetch that may 401.
 */
const AutoscalingTab = lazy(() => import('./cluster-tabs/AutoscalingTab'));
const CostTab = lazy(() => import('./cluster-tabs/CostTab'));
const HelmTab = lazy(() => import('./cluster-tabs/HelmTab'));
const LogsTab = lazy(() => import('./cluster-tabs/LogsTab'));
const ModulesIntegrityTab = lazy(() => import('./cluster-tabs/ModulesIntegrityTab'));
const NetworkOperationsTab = lazy(() => import('./cluster-tabs/NetworkOperationsTab'));
const NetworkMeshTab = lazy(() => import('./cluster-tabs/NetworkMeshTab'));
const ObservabilityTab = lazy(() => import('./cluster-tabs/ObservabilityTab'));
const SecurityTab = lazy(() => import('./cluster-tabs/SecurityTab'));
const StorageTab = lazy(() => import('./cluster-tabs/StorageTab'));
import TokensTab from './cluster-tabs/TokensTab';
import OverviewTab from './cluster-tabs/OverviewTab';
// The tab vocabulary — ids, labels, groups, and which tab a cluster opens on — lives in
// `cluster-tabs/tabs.ts` rather than here, so that a tab can link to another tab (the Overview
// tiles do) without importing the page that renders it.
import {
  DEFAULT_TAB,
  TAB_ABOUT,
  TAB_ICON,
  tabSubtitle,
  TAB_IDS,
  TAB_LABEL,
  TAB_ORDER,
  TAB_SECTIONS,
  isWorkspaceTab,
  resolveTabAlias,
  type Tab
} from './cluster-tabs/tabs';
import { COLUMN_INFO } from '../components/table/column-info';
import { tabSwitchParams } from './cluster-tabs/tab-params';
import { flattenPods, ownerVerdict, type InventoryPod } from './cluster-tabs/pod-inventory';
import { isUnbounded, limitText, metricTitle, requestText, usedText } from './cluster-tabs/pod-metric-cell';
import { podState, reasonLabel, workloadStateSummary } from './cluster-tabs/pod-state';
import { isSchedulable, nodeConditionsEmpty, slotAccounting, slotExclusionNote } from './cluster-tabs/node-slots';
import {
  BOOTSTRAP_CHART,
  BOOTSTRAP_VERDICT_LABEL,
  bootstrapCheckName,
  bootstrapCheckNote,
  bootstrapSummary
} from './cluster-tabs/compliance-labels';
import {
  activeNodePodFilters,
  filterNodePods,
  indexWorkloadPods,
  nodePodNamespaces,
  nodePodRows,
  nodePodWorkloads,
  UNOWNED,
  type NodePodRow
} from './cluster-tabs/node-pods';
import {
  activeWorkloadFilters,
  ALL_NAMESPACES,
  filterByNamespace,
  filterWorkloads,
  namespaceOptions,
  podInventoryRows,
  workloadPillCounts,
  workloadShownOfTotal,
  type WorkloadFilterState
} from './cluster-tabs/workload-filter';
import { NamespaceFilter } from '../components/NamespaceFilter';
// Aliased: `resultLine` is also the name of `FilterBar`'s prop, and `resultLine={resultLine(...)}`
// reads as a recursive definition rather than as a call.
import { resultLine as countLine } from '../components/namespace-filter';
import { serializeNamespaceParam, useNamespaceSelection } from '../components/use-namespace-selection';
import { NamespacesSection } from './cluster-tabs/NamespacesSection';
import { PodsSection, useSystemNamespaces } from './cluster-tabs/PodsSection';
import { TopConsumersSection } from './cluster-tabs/TopConsumersSection';
import { podsInScope } from './cluster-tabs/pod-table';
import { FilterBar, FilterSelect, SearchBox } from '../components/filters';
import { usePodLogs } from '../components/pod-logs';

export default function ClusterDetail({ onRefreshed }: PageProps) {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { openPodLogs, warmPodLogs } = usePodLogs();
  // A retired tab id with a new home (`?tab=autoscaling`) is rewritten in place, so an old bookmark
  // lands on the screen it meant instead of falling to Overview. The tab renders from the rewrite
  // at once, so the retired screen never paints for the frame before the URL catches up.
  const alias = useMemo(() => resolveTabAlias(params), [params]);
  const tabParam = alias?.get('tab') ?? params.get('tab');
  const tab: Tab = tabParam && TAB_IDS.has(tabParam) ? (tabParam as Tab) : DEFAULT_TAB;
  useEffect(() => {
    if (alias) setParams(alias, { replace: true });
  }, [alias, setParams]);
  /*
    Warm the tabs the operator has not clicked yet.

    Every per-cluster read is expensive exactly once — the server caches routes for 30s — so
    the latency anyone actually feels is the cost of being first to ask. This asks first, one
    read at a time and at low server priority, starting a beat after the clicked tab has had
    the gate to itself. `prefetch.start` supersedes its own previous sweep, so switching tabs
    re-aims the warming instead of stacking a second sweep on the first.
  */
  useEffect(() => {
    if (!id) return;
    return prefetch.start(id, tab);
  }, [id, tab]);
  /**
   * Go to a tab, optionally landing on one of its sub-sections.
   *
   * The `section` argument exists for the Overview grid. A tile named "Admission & policy" that set
   * only `?tab=security` landed on `isolation`, because `useSection` falls back whenever the
   * current `?section=` is not one of the target tab's ids — so the tile named a topic and the tab
   * chose a different one, silently and with a plausible-looking screen at the end of it. Three of
   * the seventeen tiles pointed at Security and all three arrived at the same section.
   *
   * With no `section`, the parameter is **deleted** rather than left alone. Carrying `mesh` out of
   * Networking and into Security was harmless only because of that same fallback; the URL still
   * claimed a section the page was not showing, which is exactly the sort of half-true address
   * someone pastes into a ticket.
   */
  const setTab = useCallback(
    (next: Tab, section?: string) => {
      setParams(tabSwitchParams(params, next, section), { replace: true });
    },
    [params, setParams]
  );
  // Cross-tab drill-downs: a pod's node (Workloads) jumps to Nodes pre-expanded on it; a
  // node's pod list (Nodes) jumps straight into that pod's live log.
  const viewNode = useCallback(
    (nodeName: string) => {
      const p = new URLSearchParams(params);
      p.set('tab', 'nodes');
      p.set('node', nodeName);
      setParams(p, { replace: true });
    },
    [params, setParams]
  );
  /**
   * Every "Logs" action on this page, and there are five of them.
   *
   * It used to write `?tab=logs&ns=…&pod=…` and navigate. That answered the question and destroyed
   * the context that raised it: the node you had selected, the namespace filter you had set, the row
   * you had scrolled to. Now it opens the bottom drawer — same reader, same controls, over the page
   * you are already on, with the URL untouched. The drawer's own "Open in Live Pod Logs" performs
   * exactly the old navigation for the cases where the full tab is what you want.
   *
   * One callback for all five call sites (node pods, workload pods, the pod inventory table, Traffic
   * Errors, the resource drawer's investigation links) is the whole mechanism behind "every Logs
   * button uses one implementation" — there is no second place that could drift.
   */
  const viewLogs = useCallback(
    (namespace: string, podName: string, containerName?: string | null, opts?: { previous?: boolean }) => {
      openPodLogs({ cluster: id, namespace, pod: podName, container: containerName ?? null, previous: opts?.previous });
    },
    [id, openPodLogs]
  );
  const expandedNode = params.get('node');

  /**
   * The drawer's "Where else to look" section.
   *
   * `ResourceDetailDrawer` has always accepted this callback — its docstring named "an events
   * list, a log shortcut" as the intent — and nothing ever passed one, so the Pod drawer was a
   * dead end. An operator who reached a pod from the Traffic tab's failing-upstream table had the
   * pod identified on screen and still had to close the drawer, switch to Logs, and find the same
   * pod again by name in a namespace select. The identity was already in hand; the console threw
   * it away.
   *
   * The rule that decides which steps to offer lives in `resources/investigate.ts` so it can be
   * tested without a drawer; this only turns each step into a click.
   */
  const investigationExtras = useCallback(
    (ref: Parameters<typeof investigationSteps>[0], _view: unknown, row: unknown) => {
      const steps = investigationSteps(ref, row).map(s => ({
        label: s.label,
        why: s.why,
        onClick: () =>
          viewLogs(s.target.namespace, s.target.pod, s.target.container, {
            previous: s.kind === 'logs-previous'
          })
      }));
      return <RelatedInvestigationLinks steps={steps} />;
    },
    [viewLogs]
  );

  /**
   * The open workload, in the URL rather than in component state.
   *
   * It used to be `useState`, seeded by an in-page callback the Helm resource tree called. Now
   * the tree lives on its own route, so the only way it can hand a workload over is a link —
   * and a link can only carry what the URL holds. Keeping it here also means the selection
   * survives a reload and can be pasted to a colleague, which the state version could not.
   *
   * The value is WorkloadsTab's own key format, `namespace/kind/name`, resolved against the
   * cluster-wide overview list — so the target is found regardless of which namespace filter
   * the Workloads tab was last left on.
   */
  const selectedWorkload = params.get('workload');
  const setSelectedWorkload = useCallback(
    (next: string | null) => {
      const p = new URLSearchParams(params);
      if (next) p.set('workload', next);
      else p.delete('workload');
      setParams(p, { replace: true });
    },
    [params, setParams]
  );

  // `id` is the key, not just a dependency of the fetcher: without it the first load is the
  // only load, and a cluster→cluster move (reachable from the collapsed rail's cluster dots)
  // leaves this page showing the previous cluster's header, nodes and capacity for a whole
  // poll interval. `App.tsx` also keys the route element on `id`; both are deliberate.
  const { data, error, initial, fetchedAt, reload } = useAsync(
    useCallback(() => api.overview(id), [id]),
    30_000,
    id
  );
  // `reload` and the `api.me()` capability probe are both gone with the mutation controls. The
  // page polls on its own 30s interval, so nothing needed a manual reload once there was no
  // write to reload *after*; and `capabilities.rollout` gated a Restart button that no longer
  // exists. This console is read-only, so there is no capability left to branch on here.

  useEffect(() => {
    if (data) onRefreshed(new Date().toISOString());
  }, [data, onRefreshed]);

  // Rebuilt on each poll so the open drawer re-renders with the new snapshot rather than
  // freezing on the data that was current when it was opened.
  const resolveResource = useMemo(() => makeOverviewResolver(data?.data ?? null), [data]);

  // A resource link is only half a destination. Resolvers are lent by whichever tab is mounted,
  // so following `?res=Certificate/...` from the Storage tab would land on "not in view" — the
  // Networking tab's Certificates section, which owns that payload, is not on screen. When a
  // ref names a Kind that lives elsewhere, go there; the drawer fills in when that fetch lands.
  //
  // Kinds the overview already covers (workloads, Pods, Containers, Nodes, Namespaces) carry no
  // `home` and stay put, because they resolve from every tab and moving would be a jarring
  // no-op.
  const resParam = params.get('res');
  useEffect(() => {
    const ref = refFromParam(resParam, isKind);
    if (!ref) return;
    const home = RESOURCE_REGISTRY[ref.kind].home;
    if (!home) return;
    const needsTab = home.tab !== tab;
    const needsSection = Boolean(home.section) && params.get('section') !== home.section;
    if (!needsTab && !needsSection) return;
    setParams(
      prev => {
        const p = new URLSearchParams(prev);
        p.set('tab', home.tab);
        if (home.section) p.set('section', home.section);
        return p;
      },
      { replace: true }
    );
  }, [resParam, tab, params, setParams]);


  /**
   * One request fans out to four collectors, and they fail independently: the node list can
   * come back while the workload list is refused. A cluster-wide error already renders as an
   * ErrorState above, so what is left to catch here is the partial answer — the case that
   * currently reaches the operator as "0 workloads not ready", which reads as all clear.
   */
  const scope = useMemo(() => {
    const d = data?.ok ? data.data : null;
    if (!d) return unavailableScope({});
    return unavailableScope({
      clusters: [
        {
          id,
          ok: true,
          unavailable: [
            ...unavailableEntries(d.health),
            ...unavailableEntries(d.workloads.summary),
            ...unavailableEntries(d.compliance),
            ...unavailableEntries(d.events)
          ],
          // Folded the same way and kept apart: these reads happened, they just stopped at
          // the paging ceiling, so their counts are floors rather than em-dashes.
          truncated: [
            ...truncatedEntries(d.health),
            ...truncatedEntries(d.workloads.summary),
            ...truncatedEntries(d.compliance),
            ...truncatedEntries(d.events)
          ]
        }
      ]
    });
  }, [data, id]);

  const nodeStatus = scope.of('nodes', 'nodes');
  const podStatus = scope.of('pods', 'pods');
  const workloadStatus = scope.of('workloads', 'workloads', 'deployments', 'statefulsets', 'daemonsets');
  const complianceStatus = scope.of('namespace compliance', 'namespaces', 'compliance');
  const eventStatus = scope.of('events', 'events');

  // Which of the two page layouts this tab gets. Read once here and threaded through the four
  // places that make up the height chain, rather than re-tested at each — one source, so the
  // links cannot disagree and half-apply.
  const workspace = isWorkspaceTab(tab);


  return (
    // The provider wraps the whole page, not the tab area, so a resolver registered by a tab is
    // still reachable by the drawer, which is a sibling of the tab area rather than a child.
    <ResourceDataProvider>
    {/* One of two layouts, decided by `isWorkspaceTab` and nowhere else.
        A *document* tab scrolls here, in the page column, with the tables scrolling internally on
        top of that. A *workspace* tab (Live Pod Logs) must not: it owns the viewport and each of
        its panes scrolls itself, so the page column is `overflow-hidden` and the four `min-h-0`
        links below hand the viewport height down to it. See the note on `IS_WORKSPACE` in
        cluster-tabs/tabs.ts — all four have to be present or the panes fall back to auto height. */}
    <div className={`flex min-w-0 flex-1 flex-col ${workspace ? 'overflow-hidden' : 'overflow-y-auto'}`}>
      {/* The section's own title, not the cluster's. Identity — name, environment, API URL — is
          already in the rail and on the Credentials tab (`?tab=tokens`); repeating it
          above every tab cost a header's worth of vertical space to say what the left column
          had already said. Logs and Refresh went with it: Logs was a second control for a rail
          destination, and the page polls on its own interval. */}
      <PageHeader title={TAB_LABEL[tab]} icon={TAB_ICON[tab]} info={TAB_ABOUT[tab]} subtitle={tabSubtitle(tab, params.get('section'))} />

      {initial && (
        <div className="page-x pb-6">
          <Card>
            <Skeleton rows={8} />
          </Card>
        </div>
      )}

      {!initial && error && (
        <div className="page-x pb-6">
          <Card>
            <ErrorState code={error.code} message={error.message} />
          </Card>
        </div>
      )}

      {!initial && data && !data.ok && data.error && (
        <div className="page-x pb-6">
          <Card>
            <ErrorState
              cluster={data.cluster.id}
              code={data.error.code}
              message={data.error.message}
              needsReseed={data.error.needsReseed}
              command={
                data.error.needsReseed
                  ? seedCommand(data.cluster.namespace, data.cluster.serviceAccount)
                  : undefined
              }
            />
          </Card>
        </div>
      )}

      {/* `ok: null` — registered, not read yet. Without this the page rendered nothing at all
          between the header and the footer: no skeleton (the request succeeded), no error (there
          is none) and no data. A blank page is the one answer that tells the operator nothing. */}
      {!initial && data && data.ok === null && (
        <div className="page-x pb-6">
          <Card>
            <div className="py-6 text-center">
              <p className="text-[14px] text-text">
                {data.cluster.displayName || data.cluster.id} has not been read yet.
              </p>
              <p className="mt-1 text-[13px] text-muted">
                {data.notRead === 'disabled'
                  ? 'It is registered but disabled, so the fleet is not collecting from it.'
                  : 'It was added moments ago; the next collection pass will pick it up. This page refreshes on its own.'}
              </p>
            </div>
          </Card>
        </div>
      )}

      {!initial && data && !data.cluster.renewable && (
        <div className="page-x pb-4">
          <div className="rounded-[8px] border border-warn/40 bg-warn/10 px-4 py-3 text-[14px] text-warn">
            <strong className="font-semibold">This cluster&apos;s token cannot renew itself.</strong> It was onboarded
            from a pasted token whose service account may not call{' '}
            <span className="mono">serviceaccounts/token</span>, so nothing here will load once the token expires.
            Apply <span className="mono">cluster-rbac/fleet-reader.yaml</span> to the cluster and add it again.
          </div>
        </div>
      )}

      {!initial && data?.ok && data.data && (
        <>
          <UnavailableNotice scope={scope} className="mb-4 shrink-0" />

          {/* No section navigation here. The ten destinations live in the fleet rail, grouped,
              directly under the cluster they belong to — see `ClusterSections` in
              components/layout.tsx. They were briefly a second vertical rail in this column,
              which put two navs side by side and cost the tables 200px. `ClusterSectionStrip`
              stays for narrow viewports, where the fleet rail is the first thing to go. */}
          <div className={`flex min-w-0 flex-1 ${workspace ? 'min-h-0 items-stretch' : 'items-start'}`}>
            <div className={`min-w-0 flex-1 ${workspace ? 'flex min-h-0 flex-col' : ''}`}>
              <ClusterSectionStrip tab={tab} onSelect={setTab} />
          {tab === 'nodes' && (
            <>
              <div className="grid grid-cols-2 gap-4 page-x pb-4 lg:grid-cols-4">
                <Stat
                  label="Nodes ready"
                  value={`${data.data.health.nodes.ready}/${data.data.health.nodes.total}`}
                  tone={data.data.health.nodes.ready === data.data.health.nodes.total ? 'ok' : 'bad'}
                  status={nodeStatus}
                  hint={
                    data.data.health.nodes.withProblems > 0
                      ? `${data.data.health.nodes.withProblems} reporting a problem`
                      : data.data.health.nodes.zones.join(', ') || undefined
                  }
                />
                <Stat
                  label="Pods running"
                  value={String(data.data.health.pods.running)}
                  tone={data.data.health.pods.failed > 0 ? 'bad' : 'ok'}
                  status={podStatus}
                  hint={`${data.data.health.pods.pending} pending · ${data.data.health.pods.failed} failed`}
                />
                <Stat
                  label="Workloads not ready"
                  value={String(data.data.workloads.summary.notReady)}
                  tone={data.data.workloads.summary.notReady > 0 ? 'bad' : 'ok'}
                  status={workloadStatus}
                  hint={`${data.data.workloads.summary.total} total`}
                />
                <Stat
                  label="Token"
                  value={data.token ? duration(data.token.expiresInMs) : '—'}
                  tone={data.token ? tokenTone(data.token.status) : 'unknown'}
                  hint={data.token ? TOKEN_LABEL[data.token.status] : undefined}
                />
              </div>

              <div className="page-x pb-4">
                <Card>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <CapacityBar
                      label="CPU requested / allocatable"
                      used={`${cores(data.data.health.capacity.cpu.requested)} cores`}
                      total={cores(data.data.health.capacity.cpu.allocatable)}
                      pct={data.data.health.capacity.cpu.percent}
                    />
                    <CapacityBar
                      label="Memory requested / allocatable"
                      used={bytes(data.data.health.capacity.memory.requested)}
                      total={bytes(data.data.health.capacity.memory.allocatable)}
                      pct={data.data.health.capacity.memory.percent}
                    />
                    {data.data.health.metrics.available ? (
                      <>
                        <CapacityBar
                          label="CPU in use (live)"
                          used={`${cores(data.data.health.capacity.cpu.used)} cores`}
                          total={cores(data.data.health.capacity.cpu.allocatable)}
                          pct={data.data.health.capacity.cpu.usedPercent}
                        />
                        <CapacityBar
                          label="Memory in use (live)"
                          used={bytes(data.data.health.capacity.memory.used)}
                          total={bytes(data.data.health.capacity.memory.allocatable)}
                          pct={data.data.health.capacity.memory.usedPercent}
                        />
                      </>
                    ) : (
                      <p className="self-end text-[13px] text-muted md:col-span-2">
                        Live usage unavailable — {data.data.health.metrics.reason ?? 'metrics-server did not answer'}.
                        Requests and limits above are still exact.
                      </p>
                    )}
                  </div>
                </Card>
              </div>
            </>
          )}

          {/* The content gutter for every tab, applied once here.
              A tab must not add `page-x` of its own: Autoscaling, Storage, Traffic, Logs and
              Reliability each did, and the second copy doubled the inset — their tables started at
              x=263 while the page heading above them was at x=239.
              For a workspace tab this is also the last link in the height chain: `flex-1 min-h-0`
              here is what gives the tab's own root a definite height to divide between its panes. */}
          <div className={`page-x py-4 ${workspace ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
            <TabErrorBoundary label={TAB_LABEL[tab] ?? tab} resetKey={tab}>
              {/*
                Inside the error boundary, not outside it: a chunk that fails to load (a deploy that
                replaced the assets under a long-lived tab is the ordinary cause) throws during render,
                and the boundary is what turns that into an in-page error with a retry rather than a
                blank page. The fallback is the same `Skeleton` every tab shows while its data loads,
                so a first open reads as one wait instead of two.
              */}
              <Suspense fallback={<Skeleton rows={8} />}>
              {tab === 'overview' && <OverviewTab id={id} onOpenTab={setTab} />}
              {tab === 'nodes' && (
                <NodesTab
                  id={id}
                  nodes={data.data.health.nodes.items}
                  /* The Scheduled pods table joins against these. Already in this payload — the
                     overview fans out health *and* workloads server-side — so the Workload column
                     and the live CPU/memory figures cost no extra read. */
                  workloads={data.data.workloads.items}
                  metricsAvailable={data.data.workloads.metrics.available}
                  status={nodeStatus}
                  expandedNode={expandedNode}
                  onExpandNode={n => {
                    const p = new URLSearchParams(params);
                    if (n) p.set('node', n);
                    else p.delete('node');
                    setParams(p, { replace: true });
                  }}
                  onViewLogs={viewLogs}
                  onWarmLogs={() => warmPodLogs(id)}
                />
              )}
              {tab === 'workloads' && (
                <WorkloadsArea
                  id={id}
                  items={data.data.workloads.items}
                  metricsAvailable={data.data.workloads.metrics.available}
                  selected={selectedWorkload}
                  onSelect={setSelectedWorkload}
                  status={workloadStatus}
                  events={data.data.events}
                  eventStatus={eventStatus}
                  onViewNode={viewNode}
                  onViewLogs={viewLogs}
                  workloads={data.data.workloads}
                  fetchedAt={fetchedAt}
                  onRefresh={reload}
                  onWarmLogs={() => warmPodLogs(id)}
                />
              )}
              {tab === 'network' && <NetworkOperationsTab id={id} onViewLogs={viewLogs} />}
              {tab === 'networking' && <NetworkMeshTab id={id} view="networking" />}
              {tab === 'istio' && <NetworkMeshTab id={id} view="istio" />}
              {tab === 'observability' && <ObservabilityTab id={id} />}
              {tab === 'certificates' && <NetworkMeshTab id={id} view="certificates" />}
              {tab === 'storage' && <StorageTab id={id} />}
              {tab === 'security' && (
                <SecurityTab
                  id={id}
                  /* Namespace compliance is a section of the Security tab, not a card stapled
                     under it. It is passed in rather than fetched there because it rides on the
                     overview payload this page already holds — a second read for data already
                     in hand is the kind of cost this console refuses. */
                  compliance={
                    <ComplianceTab
                      rows={data.data.compliance.namespaces}
                      rollup={data.data.compliance.summary}
                      status={complianceStatus}
                      onViewIsolation={() => setTab('security', 'isolation')}
                    />
                  }
                />
              )}
              {tab === 'platform' && <ModulesIntegrityTab id={id} />}
              {/* Helm has its own tab rather than sharing Modules & Telemetry. It was folded in
                  there when it was one table; it is now the entry point to a per-release page
                  with resources, values, manifest and revision history, and an entry point
                  nobody can find is a feature nobody uses. Strictly read-only throughout. */}
              {tab === 'helm' && <HelmTab id={id} />}
              {tab === 'logs' && <LogsTab id={id} />}
              {tab === 'cost' && <CostTab id={id} />}
              {tab === 'tokens' && <TokensTab id={id} />}
              </Suspense>
            </TabErrorBoundary>
          </div>

          {/* One drawer for the whole cluster page, driven by `?res=` rather than by whichever
              tab is mounted. That is what makes a resource link work across tabs: a Pod named
              on the Nodes tab and the same Pod named on Workloads open the identical renderer,
              and the address bar carries the selection into a ticket. Read-only throughout —
              it navigates, it copies, it never writes. */}
          <ResourceDetailDrawer resolve={resolveResource} extraFor={investigationExtras} />
            </div>
          </div>
        </>
      )}
    </div>
    </ResourceDataProvider>
  );
}


/**
 * The same ten destinations for narrow viewports, where a 196px rail would leave nothing for
 * the page. One scrolling row of pills, group labels dropped: they are a scanning aid for a
 * vertical list and pure noise in a horizontal one.
 */
function ClusterSectionStrip({ tab, onSelect }: { tab: Tab; onSelect: (next: Tab) => void }) {
  return (
    <nav
      aria-label="Cluster sections"
      className="hidden"
    >
      <div className="flex gap-2">
        {/* Same sequence as the rail — `TAB_ORDER`, not the declaration order in `TABS` — so the
            narrow-viewport strip and the wide-viewport list do not disagree about where a
            destination sits. */}
        {TAB_ORDER.map(id => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-current={active ? 'true' : undefined}
              className={`whitespace-nowrap rounded-full border px-3 py-1 text-[13px] transition-colors ${
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-line text-muted hover:border-accent hover:text-text'
              }`}
            >
              {TAB_LABEL[id]}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
  status
}: {
  label: string;
  value: string;
  tone: Tone;
  hint?: string;
  /** Omitted for a tile whose truth does not depend on a collector answering. */
  status?: MetricStatus;
}) {
  const dead = status?.state === 'unavailable';
  return (
    <div className="card px-5 py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <MetricValue status={status} size="lg" className="mono text-[26px]">
          {value}
        </MetricValue>
        {/* A verdict pill over a number nobody read would be the same false confidence. */}
        {!dead && (
          <Pill tone={tone}>{tone === 'ok' ? 'OK' : tone === 'bad' ? 'Attention' : tone === 'warn' ? 'Watch' : '—'}</Pill>
        )}
      </div>
      {(dead || hint) && (
        <div
          className={`mt-1 line-clamp-2 text-[13px] ${dead ? 'text-warn' : 'truncate text-muted'}`}
          title={dead ? status.why : undefined}
        >
          {dead ? status.why : hint}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------- nodes

const NODE_SECTIONS = TAB_SECTIONS.nodes;

type NodeSection = (typeof NODE_SECTIONS)[number]['id'];

/**
 * Nodes and topology as six sections.
 *
 * Five of them render from the overview payload the page already holds — zone and pool spread,
 * pod slots and node conditions are all derivations of the same `nodes` array, which is why the
 * old standalone Topology tab and its lazy pod refetch were removed. Only `headroom` fetches,
 * and only when it is opened.
 */
function NodesTab({
  id,
  nodes,
  workloads,
  metricsAvailable,
  status,
  expandedNode,
  onExpandNode,
  onViewLogs,
  onWarmLogs
}: {
  id: string;
  nodes: NodeRow[];
  /** Every workload on the cluster, for the Scheduled pods join. See `node-pods.ts`. */
  workloads: WorkloadRow[];
  /** Whether `metrics.k8s.io` answered at all — the difference between "0 cores" and "not read". */
  metricsAvailable: boolean;
  status: MetricStatus;
  expandedNode: string | null;
  onExpandNode: (node: string | null) => void;
  onViewLogs: (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;
  /** Pointer-intent hook: warms the read the log drawer will make. Cheap and deduped for 30s. */
  onWarmLogs: () => void;
}) {
  const [section, setSection] = useSection<NodeSection>(NODE_SECTIONS, NODE_SECTIONS[0].id);

  /**
   * The failure an operator clicked on, if any.
   *
   * `OOMKilled` and `CrashLoopBackOff` are the two verdicts in this table that a reader either
   * already knows by heart or cannot act on at all, and the cell has room for neither explanation.
   * The subject is built from the row — namespace, pod, and the first container name when the
   * workload join found one — so the commands in the drawer name the real pod rather than a
   * template. Nothing here is derived: the drawer explains only the kubelet's own reason.
   */
  const [diagnosed, setDiagnosed] = useState<DiagnosisSubject | null>(null);

  // Zone/pool distribution and the per-node pod list both come out of the overview response
  // that already fed this table — the old separate Topology tab and its lazy pod refetch were
  // two extra round trips for data sitting in `nodes` all along.
  const distribution = useMemo(() => {
    const zones = new Map<string, { nodes: number; pods: number }>();
    const pools = new Map<string, number>();
    let pods = 0;
    // Numerator and denominator have to describe the same nodes, and they have to describe nodes a
    // pod could actually land on. `slotAccounting` applies the one readiness/cordon predicate this
    // page uses — the same `ready && !unschedulable` the card beside it counts — so "schedulable"
    // means one thing on this screen instead of two. Pod capacity is left null unless at least one
    // counted node reported one, so "no slots" and "nobody said" stay distinguishable: a 0/0 bar
    // would read as a full cluster. See `node-slots.ts`.
    for (const n of nodes) {
      const zone = n.zone ?? 'unzoned';
      const z = zones.get(zone) ?? { nodes: 0, pods: 0 };
      zones.set(zone, { nodes: z.nodes + 1, pods: z.pods + n.pods });
      const pool = n.nodeGroup || 'default-pool';
      pools.set(pool, (pools.get(pool) ?? 0) + 1);
      pods += n.pods;
    }
    const slots = slotAccounting(nodes);
    return {
      zones: [...zones.entries()].map(([zone, v]) => ({ zone, ...v })).sort((a, b) => a.zone.localeCompare(b.zone)),
      pools: [...pools.entries()].map(([pool, count]) => ({ pool, count })).sort((a, b) => a.pool.localeCompare(b.pool)),
      pods,
      slots,
      ready: nodes.filter(isSchedulable).length
    };
  }, [nodes]);

  const node = expandedNode ? (nodes.find(n => n.name === expandedNode) ?? null) : null;

  /*
    The scheduled-pod table's data, and its filters.

    Built here rather than inside the detail card so the filter state survives a poll — the card is
    re-rendered every 30s with a fresh `node` object, and state declared inside it would reset the
    namespace the operator had just chosen. The index is over the whole cluster and the rows over one
    node, so the expensive half is memoised on `workloads` and the cheap half on the selected node.
  */
  const podIndex = useMemo(() => indexWorkloadPods(workloads), [workloads]);
  const nodePods = useMemo(() => nodePodRows(node?.podsList ?? [], podIndex), [node, podIndex]);
  const [podNs, setPodNs] = useState('');
  const [podWorkload, setPodWorkload] = useState('');
  const [podSearch, setPodSearch] = useState('');
  const podFilter = { namespace: podNs, workload: podWorkload, search: podSearch };
  const shownPods = useMemo(() => filterNodePods(nodePods, podFilter), [nodePods, podNs, podWorkload, podSearch]);
  const podNamespaceOptions = useMemo(() => nodePodNamespaces(nodePods), [nodePods]);
  const podWorkloadOptions = useMemo(() => nodePodWorkloads(nodePods), [nodePods]);
  // A filter naming a namespace that is not on the newly selected node would show an empty table and
  // blame the node. Selecting a different node resets the scope; it does not carry the old one over.
  useEffect(() => {
    setPodNs('');
    setPodWorkload('');
    setPodSearch('');
  }, [expandedNode]);
  const resetPodFilters = useCallback(() => {
    setPodNs('');
    setPodWorkload('');
    setPodSearch('');
  }, []);

  /*
    The eight columns the scheduled-pod table shows.

    Alignment is the console-wide rule and it is not a judgement call: identifiers and names left,
    every numeric right, the action column right. `DataTable` applies the same class and the same
    width ceiling to the `th` and the `td` from one `Column` object, so a header cannot drift from
    the column under it, and `align.ts` derives the rule from the header text for any column that
    does not state it.

    Every column carries a `sortValue`, and each one is the *underlying* value rather than the string
    in the cell: CPU sorts on the sample in cores, not on `"7m"`, and Workload sorts on the owner name
    this console resolved rather than on `"2 workloads"`. A pod list on a busy node is the one table
    here an operator re-ranks by hand — usually by restarts, to find what is crashing.

    CPU and Memory are two facts in one cell, and they are labelled as two. `usage` comes from
    `metrics.k8s.io` and is `null` when that read did not happen — rendered as `—`, never as 0, or an
    idle pod and an unmeasured pod would look identical. `request` is what the scheduler counted and
    is always shown beneath it, because on this cluster the request is the number that decides
    placement and the usage is the number that explains pressure.
  */
  const nodePodColumns: Column<NodePodRow>[] = [
    {
      key: 'pod',
      header: 'Pod',
      pin: true,
      // Pod names are unbounded (a Deployment adds two hash suffixes); without a ceiling this one
      // column decides the table's width and pushes the numerics off the container.
      //
      // 210px, not 300: at 1440 with the navigation open the container is 1117px, and eight columns
      // at the old ceilings rendered a 1137px table — 20px over, which clipped the *Actions* column
      // to "Log" and put a horizontal scrollbar under a table that fits. The tier below does the rest
      // of the work. Measured, not estimated: see the width budget in `test/fleet/table-fit.test.js`.
      max: '210px',
      sortValue: p => p.name,
      render: p => <ResourceLink refTo={{ kind: 'Pod', namespace: p.namespace, name: p.name }} className="mono" />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '130px',
      sortValue: p => p.namespace,
      render: p => (
        <ResourceLink refTo={{ kind: 'Namespace', namespace: null, name: p.namespace }} className="mono" />
      )
    },
    {
      key: 'workload',
      header: 'Workload',
      priority: 2,
      max: '170px',
      // Never a name this console guessed. One claimant is named; several are counted and listed in
      // the tooltip; none is an em dash. `ownerVerdict` owns the rule and is tested separately.
      title: p => {
        const v = ownerVerdict(p.owners);
        if (v.kind === 'one') return v.full;
        if (v.kind === 'ambiguous') return `Selected by ${v.count} workloads: ${v.candidates.join(', ')}`;
        return 'No Deployment, StatefulSet or DaemonSet selects this pod — a static, bare or Job pod.';
      },
      // Sorts on the resolved owner, so the pods of one Deployment group together. A pod no workload
      // claims sorts last rather than under the letter its placeholder happens to start with.
      sortValue: p => {
        const v = ownerVerdict(p.owners);
        return v.kind === 'one' ? v.name : v.kind === 'ambiguous' ? v.candidates[0] ?? null : null;
      },
      render: p => {
        const v = ownerVerdict(p.owners);
        if (v.kind === 'one') return <span className="mono">{v.name}</span>;
        if (v.kind === 'ambiguous') return <span className="mono text-muted">{v.count} workloads</span>;
        return <span className="text-muted">—</span>;
      }
    },
    {
      key: 'cpu',
      header: 'CPU',
      align: 'right',
      // The sample when there is one, the request when there is not: those are the two numbers the
      // cell shows, in that order of interest. A pod with neither sorts last.
      sortValue: p => p.cpuUsage ?? p.cpuRequest ?? null,
      render: p => <PodResource used={p.cpuUsage} request={p.cpuRequest} fmt={cpu} />
    },
    {
      key: 'mem',
      header: 'Memory',
      align: 'right',
      sortValue: p => p.memoryUsage ?? p.memoryRequest ?? null,
      render: p => <PodResource used={p.memoryUsage} request={p.memoryRequest} fmt={bytes} />
    },
    {
      key: 'status',
      header: 'Status',
      // Sorts on the phase, with anything the kubelet gave a reason for first — which is the order an
      // operator scanning a node for trouble actually wants.
      sortValue: p => (p.reason || p.isOOMKilled ? `0 ${p.phase}` : `1 ${p.phase}`),
      render: p => (
        <div className="flex items-center gap-2">
          <Pill tone={p.reason || p.isOOMKilled ? 'bad' : p.phase !== 'Running' && p.phase !== 'Succeeded' ? 'bad' : 'ok'}>
            {p.phase}
          </Pill>
          {/* The kubelet's own reason, not a derived one. OOMKilled is called out separately
              because it is the one reason whose fix is a limit change rather than a code change.

              Both are buttons: two words is the right size for a cell and the wrong size for an
              explanation, so the cell carries the verdict and the drawer carries the mechanism, the
              next steps and the commands. A `<button>` rather than a clickable span — this is a
              real control and belongs in the tab order. */}
          {p.isOOMKilled && (
            <button
              type="button"
              onClick={() => setDiagnosed({ kind: 'oom-killed', namespace: p.namespace, pod: p.name, container: p.containers[0] })}
              className="mono rounded-[4px] text-[12px] text-bad underline decoration-dotted underline-offset-2 hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              title="Explain what OOMKilled means for this pod, and what to do about it."
            >
              OOMKilled
            </button>
          )}
          {p.reason && !p.isOOMKilled && (
            /* Only CrashLoopBackOff has tailored copy; every other kubelet reason keeps the plain
               text it always had rather than opening a drawer that would have nothing to add. */
            p.reason === 'CrashLoopBackOff' ? (
              <button
                type="button"
                onClick={() => setDiagnosed({ kind: 'crashloop', namespace: p.namespace, pod: p.name, container: p.containers[0] })}
                className="mono rounded-[4px] text-[12px] text-bad underline decoration-dotted underline-offset-2 hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                title="Explain CrashLoopBackOff for this pod, and what to look at first."
              >
                {p.reason}
              </button>
            ) : (
              <span className="mono text-[12px] text-bad" title={p.reason}>
                {p.reason}
              </span>
            )
          )}
          {/* Proximity to a declared limit — a forecast, and kept visually apart from the two facts
              above it. It rides in this cell rather than a column of its own because the Scheduled
              pods table is already at its width budget (`test/fleet/table-fit.test.js`), and because
              "what is wrong with this pod" is one question.

              Clickable only when there is a limit to quote: `diagnose()` writes "N% of its 512 MiB
              limit", and with `limitText` null there is no such sentence to write, so the badge keeps
              the assessment's own title as a tooltip instead.

              Drawn as Top Consumers' Pressure column draws the same verdicts — coloured text with a dashed underline
              for `heuristic` — rather than as a `Pill`, so one threshold does not wear two visuals in
              two tabs. */}
          {p.limitRisk &&
            (p.limitRisk.percentOfLimit !== null && p.limitRisk.limitText !== null ? (
              <button
                type="button"
                onClick={() =>
                  setDiagnosed({
                    kind: p.limitRisk?.unit === 'memory' ? 'oom-risk' : 'cpu-throttle',
                    namespace: p.namespace,
                    pod: p.name,
                    container: p.limitRisk?.container,
                    percent: p.limitRisk?.percentOfLimit ?? 0,
                    limit: p.limitRisk?.limitText ?? ''
                  })
                }
                className={`rounded-[2px] text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  p.limitRisk.level === 'critical' ? 'text-bad' : 'text-warn'
                } ${p.limitRisk.basis === 'heuristic' ? 'border-b border-dashed border-current pb-px' : ''}`}
                title={`${p.limitRisk.title} — click for what this means and what to do.`}
              >
                {p.limitRisk.badge}
              </button>
            ) : (
              <span
                className={`text-[12px] ${p.limitRisk.level === 'critical' ? 'text-bad' : 'text-warn'} ${
                  p.limitRisk.basis === 'heuristic' ? 'border-b border-dashed border-current pb-px' : ''
                }`}
                title={p.limitRisk.title}
              >
                {p.limitRisk.badge}
              </span>
            ))}
        </div>
      )
    },
    {
      key: 'restarts',
      header: 'Restarts',
      info: COLUMN_INFO.restarts,
      align: 'right',
      sortValue: p => p.restarts,
      // Null means neither source reported a count, which is not the same as zero restarts.
      render: p =>
        p.restarts === null ? (
          <span className="text-muted">—</span>
        ) : (
          <span className={`mono ${p.restarts > 0 ? 'text-warn' : ''}`}>{p.restarts}</span>
        )
    },
    {
      key: 'actions',
      ...ACTIONS,
      // Read-only, and the only action there is. The row itself is not a click target here — the Pod
      // cell's link is — so nothing has to be stopped from propagating.
      render: p => <Btn onClick={() => onViewLogs(p.namespace, p.name)}>Logs</Btn>
    }
  ];

  const columns: Column<NodeRow>[] = [
    {
      key: 'name',
      header: 'Node',
      pin: true,
      // Rendered 355px against this declared 260px and put the table 75px over its container —
      // the same `width`-is-only-a-suggestion behaviour, at smaller scale because the rest of this
      // table is numeric and already bounded.
      max: '260px',
      render: n => (
        <div className="flex items-center gap-2.5">
          <Pill tone={n.ready ? (n.unschedulable ? 'warn' : 'ok') : 'bad'}>
            {n.ready ? (n.unschedulable ? 'Cordoned' : 'Ready') : 'NotReady'}
          </Pill>
          <ResourceLink refTo={{ kind: 'Node', namespace: null, name: n.name }} className="mono" />
        </div>
      )
    },
    { key: 'zone', header: 'Zone', priority: 2, render: n => <span className="mono">{n.zone ?? '—'}</span> },
    {
      key: 'pool',
      header: 'Pool',
      priority: 2,
      render: n => (
        <span className="mono rounded bg-raised border border-line px-1.5 py-0.5 text-[12px]">
          {n.nodeGroup || 'default-pool'}
        </span>
      )
    },
    {
      key: 'type',
      header: 'Instance',
      priority: 3,
      render: n => <span className="mono">{n.instanceType ?? '—'}</span>
    },
    { key: 'ver', header: 'Kubelet', priority: 3, render: n => <span className="mono">{n.version ?? '—'}</span> },
    {
      key: 'pods',
      header: 'Pods',
      align: 'right',
      render: n => (
        <span className="mono">
          {n.pods}
          {n.podCapacity ? `/${n.podCapacity}` : ''}
        </span>
      )
    },
    {
      key: 'cpuReq',
      header: 'CPU req',
      align: 'right',
      render: n => <Usage value={n.cpuRequested !== undefined ? `${cores(n.cpuRequested)}` : '—'} pct={n.cpuRequestedPercent ?? null} />
    },
    {
      key: 'cpu',
      header: 'CPU used',
      align: 'right',
      render: n => <Usage value={n.cpuUsage === null ? null : `${cores(n.cpuUsage)}`} pct={n.cpuUsagePercent} />
    },
    {
      key: 'memReq',
      header: 'Mem req',
      align: 'right',
      render: n => <Usage value={n.memoryRequested !== undefined ? bytes(n.memoryRequested) : '—'} pct={n.memoryRequestedPercent ?? null} />
    },
    {
      key: 'mem',
      // `Mem used`, not `Memory used`: the column beside it is `Mem req`, and one table abbreviating
      // the same word in one header and not the next is the kind of drift that makes a console read
      // as assembled. CPU/Mem, req/used, in that order, across all four.
      header: 'Mem used',
      align: 'right',
      render: n => <Usage value={n.memoryUsage === null ? null : bytes(n.memoryUsage)} pct={n.memoryUsagePercent} />
    },
    {
      key: 'alloc',
      header: 'Allocatable',
      info: COLUMN_INFO.allocatable,
      // Centre, not right: `Pair` puts the `/` on a column of its own, and the header belongs over
      // that axis rather than above the memory figure's last digit.
      align: 'center',
      priority: 3,
      render: n => (
        <Pair
          className="text-muted"
          a={cores(n.cpuAllocatable)}
          b={bytes(n.memoryAllocatable)}
          title={`${cores(n.cpuAllocatable)} CPU and ${bytes(n.memoryAllocatable)} memory allocatable to pods`}
        />
      )
    },
    { key: 'age', header: 'Age', align: 'right', priority: 3, render: n => <span className="mono">{ago(n.createdAt)}</span> }
  ];

  const problems = nodes.filter(n => n.problems.length > 0);

  // Per-node pod slots, fullest first. The summary bar says how full the cluster is; this says
  // which node fills first, which is the one an operator actually needs before a drain or a
  // scale-out. Nodes that reported no capacity sort last and say so rather than showing 0%.
  const slotRows = useMemo(
    () =>
      [...nodes]
        .map(n => ({
          name: n.name,
          zone: n.zone,
          pool: n.nodeGroup || 'default-pool',
          pods: n.pods,
          capacity: n.podCapacity,
          percent: n.podCapacity ? Math.round((n.pods / n.podCapacity) * 100) : null
        }))
        .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1)),
    [nodes]
  );

  const nodesCard = (
          <Card title="Nodes">
            <div className="mono text-[22px] text-text">
              {distribution.ready}
              <span className="text-[15px] text-muted"> / {nodes.length} schedulable</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {distribution.pools.map(p => (
                <span key={p.pool} className="mono rounded border border-line bg-raised px-1.5 py-0.5 text-[12px]">
                  {p.pool} ×{p.count}
                </span>
              ))}
            </div>
          </Card>
  );

  const zonesCard = (
          <Card
            title={
              distribution.zones.length > 1
                ? `Zones (${distribution.zones.length} — multi-AZ)`
                : `Zones (${distribution.zones.length})`
            }
          >
            <ul className="divide-y divide-line">
              {distribution.zones.map(z => (
                <li key={z.zone} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="mono text-[13px]">{z.zone}</span>
                  <span className="mono text-[12px] text-muted">
                    {z.nodes} node{z.nodes === 1 ? '' : 's'} · {z.pods} pods
                  </span>
                </li>
              ))}
            </ul>
          </Card>
  );

  /* Pod slots, NOT a second CPU/memory panel.
              This card used to repeat "Requested / allocatable" for CPU and memory, which the
              header band above already shows — and it repeated them from its own summation, so
              the two disagreed (90 GiB here, 93 GiB there, because the header was summing raw
              capacity). Capacity now has exactly one owner: `health.capacity` on the server.
              Pod slots are the one scheduling limit nothing else on the page reports, and they
     bind long before CPU does on a cluster of small pods. */
  const slotsCard = (
          <Card title="Pod slots">
            <div className="space-y-3">
              <CapacityBar
                label="Pod slots used / capacity on Ready, uncordoned nodes"
                used={String(distribution.slots.used)}
                total={distribution.slots.capacity === null ? '—' : String(distribution.slots.capacity)}
                pct={distribution.slots.pct}
              />
              <p className="text-[12px] text-muted">
                {distribution.slots.capacity === null
                  ? 'No Ready, uncordoned node reported a pod capacity.'
                  : `${distribution.slots.free} free across ${distribution.slots.countedNodes} node${
                      distribution.slots.countedNodes === 1 ? '' : 's'
                    }.`}
                {/* Named rather than folded in silently: the bar is honest about the nodes it
                    covers, so it has to say which ones it does not. */}
                {slotExclusionNote(distribution.slots) && <> {slotExclusionNote(distribution.slots)}</>}
              </p>
              {/* A slot is a kubelet ceiling, not a placement. Everything that also has to agree
                  before a pod lands is named here, because a bar that stops at the ceiling reads
                  as a guarantee to anyone planning a rollout. */}
              <p className="text-[12px] text-muted">
                A free slot is not a placement guarantee — taints, nodeSelector/affinity and CPU/memory fit
                also apply. The scheduler&apos;s own verdict is the Pending Pods (unschedulable) tile on
                Headroom &amp; Scheduling.
              </p>
            </div>
          </Card>
  );

  const conditionsCard =
    problems.length > 0 ? (
        <Card title="Node conditions needing attention">
          <ul className="divide-y divide-line">
            {problems.map(n =>
              n.problems.map(p => (
                <li key={`${n.name}-${p.type}`} className="py-2">
                  <div className="flex items-center gap-2">
                    <Pill tone="bad">{p.type}</Pill>
                    <span className="mono text-[14px]">{n.name}</span>
                    {p.reason && <span className="mono text-[13px] text-muted">{p.reason}</span>}
                  </div>
                  {p.message && <p className="mt-1 text-[13px] text-muted">{p.message}</p>}
                </li>
              ))
            )}
          </ul>
        </Card>
    ) : null;

  return (
    <div>
      <SubTabs
        sections={NODE_SECTIONS}
        active={section}
        onSelect={setSection}
        counts={{ nodes: nodes.length, conditions: problems.length }}
      />

      {section === 'overview' && (
        <div className="space-y-4">
          {nodes.length > 0 && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {nodesCard}
              {zonesCard}
              {slotsCard}
            </div>
          )}
          {conditionsCard}
        </div>
      )}

      {section === 'nodes' && <div className="space-y-4">
      <Card
        title={
          <>
            Nodes (<Count status={status} value={nodes.length} />)
          </>
        }
      >
        <DataTable
          columns={columns}
          rows={nodes}
          rowKey={n => n.name}
          selectedKey={expandedNode}
          onSelect={n => onExpandNode(expandedNode === n.name ? null : n.name)}
          // Twelve columns: the widest table in the console. `wide` was too low a tier to help —
          // measured at a 1728px viewport the container is 1415px, above `wide`'s 1300px prio-3
          // threshold, so nothing shed and the twelve columns summed to 1497px: 82px of clipped
          // overflow. `xwide` sheds prio-3 (Instance, Kubelet, Allocatable, Age — 416px) at
          // ≤1440px, which covers every laptop width, and gives all twelve back above that.
          shed="xwide"
          empty={
            status.state === 'ok' ? (
              <Empty title="No nodes" hint="The API server returned an empty node list." />
            ) : (
              <UnavailableEmptyBody status={status} />
            )
          }
        />
      </Card>

      {node && (
        <Card
          title={<span className="mono">{node.name}</span>}
          action={<Btn onClick={() => onExpandNode(null)}>Close</Btn>}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-6 lg:grid-cols-3">
              <Field label="Zone" value={<span className="mono">{node.zone ?? '—'}</span>} />
              <Field label="Instance type" value={<span className="mono">{node.instanceType ?? '—'}</span>} />
              <Field label="Kubelet" value={<span className="mono">{node.version ?? '—'}</span>} />
              <Field label="OS image" value={<span className="mono">{node.os ?? '—'}</span>} />
              <Field label="Kernel" value={<span className="mono">{node.kernelVersion ?? '—'}</span>} />
              <Field label="Container runtime" value={<span className="mono">{node.containerRuntime ?? '—'}</span>} />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <CapacityBar
                label="CPU requested / allocatable"
                used={`${cores(node.cpuRequested ?? 0)} cores`}
                total={cores(node.cpuAllocatable)}
                pct={node.cpuRequestedPercent ?? null}
              />
              <CapacityBar
                label="Memory requested / allocatable"
                used={bytes(node.memoryRequested ?? 0)}
                total={bytes(node.memoryAllocatable)}
                pct={node.memoryRequestedPercent ?? null}
              />
            </div>

            {node.taints.length > 0 && (
              <Field label="Taints" value={<span className="mono text-[13px]">{node.taints.join(', ')}</span>} />
            )}

            {/*
              Scheduled pods, in the node's own page.

              The whole point of the design: a node is selected, and the pods on it are answerable
              here — filtered by namespace, narrowed to a workload, searched by name — without
              leaving for the Workloads tab and rebuilding the same scope by hand. Nothing here
              navigates. `Logs` opens the bottom drawer over this table, so the node stays selected
              and the filters stay set.
            */}
            <div>
              <h3 className="mb-2 flex items-baseline gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
                Scheduled pods
                <span className="mono text-[12px] font-normal normal-case tracking-normal">
                  {shownPods.length === nodePods.length
                    ? nodePods.length
                    : `${shownPods.length} of ${nodePods.length}`}
                </span>
              </h3>
              {nodePods.length === 0 ? (
                <Empty title="No pods" hint="Nothing is currently scheduled on this node." />
              ) : (
                <>
                  <FilterBar
                    activeCount={activeNodePodFilters(podFilter)}
                    onReset={resetPodFilters}
                    resultLine={
                      metricsAvailable ? null : (
                        <span className="text-warn" title="metrics.k8s.io did not answer for this cluster">
                          live usage unavailable
                        </span>
                      )
                    }
                  >
                    <SearchBox value={podSearch} onChange={setPodSearch} placeholder="search pod name" />
                    <FilterSelect
                      label="Namespace"
                      value={podNs}
                      onChange={setPodNs}
                      options={[
                        { value: '', label: `all (${podNamespaceOptions.length})` },
                        ...podNamespaceOptions.map(ns => ({ value: ns, label: ns }))
                      ]}
                    />
                    <FilterSelect
                      label="Workload"
                      value={podWorkload}
                      onChange={setPodWorkload}
                      options={[
                        { value: '', label: `all (${podWorkloadOptions.length})` },
                        ...podWorkloadOptions.map(w => ({ value: w, label: w })),
                        // Real option, not an omission: static, bare and Job pods are the ones an
                        // operator is least able to find anywhere else in this console.
                        { value: UNOWNED, label: 'no workload' }
                      ]}
                    />
                  </FilterBar>
                  <DataTable
                    columns={nodePodColumns}
                    rows={shownPods}
                    rowKey={p => `${p.namespace}/${p.name}`}
                    onIntent={onWarmLogs}
                    /* `wide`, not `mid`, and the difference is the whole reason this table used to
                       clip. A tier's first number sheds priority 3 and its second sheds priority 2
                       (see theme.css); `mid` sheds priority 2 only below a 700px container, which no
                       real window reaches here — so at a 1280px viewport the container is ~950px,
                       nothing shed, and the eight columns ran 66px past the edge. `wide` sheds
                       priority 2 below 1000px, which is exactly the band where Workload has to go.
                       Nothing is priority 3 on purpose: every other column is one the design asks
                       for at the default width, and priority 3 would shed it at 1440 (container
                       1117 < 1300). Measured at 1440 / 1280 / 1120 / 1024, all fitting. */
                    shed="wide"
                    empty={
                      <Empty
                        title="No matching pods"
                        hint={`None of the ${nodePods.length} pods on this node match the current filters.`}
                      />
                    }
                  />
                </>
              )}
            </div>
          </div>
        </Card>
      )}
      </div>}

      {section === 'zones' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {zonesCard}
          <Card title={`Node pools (${distribution.pools.length})`}>
            <ul className="divide-y divide-line">
              {distribution.pools.map(p => (
                <li key={p.pool} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="mono text-[13px]">{p.pool}</span>
                  <span className="mono text-[12px] text-muted">
                    {p.count} node{p.count === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {section === 'slots' && (
        <div className="space-y-4">
          {slotsCard}
          <Card title="Pod slots by node">
            <ul className="divide-y divide-line">
              {slotRows.map(r => (
                <li key={r.name} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate">
                    <ResourceLink refTo={{ kind: 'Node', namespace: null, name: r.name }} className="mono" />
                    <span className="mono ml-2 text-[12px] text-muted">
                      {r.zone ?? 'unzoned'} · {r.pool}
                    </span>
                  </span>
                  {r.capacity === null ? (
                    <span className="text-[12px] text-muted">no pod capacity reported</span>
                  ) : (
                    <span className="mono text-[13px]">
                      {r.pods}/{r.capacity}
                      <span className={`ml-2 text-[12px] ${(r.percent ?? 0) >= 90 ? 'text-warn' : 'text-muted'}`}>
                        {r.percent}%
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {section === 'conditions' && (
        <div className="space-y-4">
          {conditionsCard ?? (
            /* `health.js` builds `problems` from the pressure conditions and filters `Ready` out,
               so the old all-clear claimed NotReady had been checked here when it had not — and a
               NotReady node got this empty state beside its own red pill on the Nodes list.
               `nodeConditionsEmpty` claims only what was read, and surfaces readiness instead of
               contradicting it. */
            <Empty {...nodeConditionsEmpty(nodes)} />
          )}
        </div>
      )}

      {/* Taints and tolerations are two views of one constraint, so they share a component and a
          read. Both own their fetch rather than taking `nodes` from this tab: the node rows here
          carry taints only as pre-flattened strings, and the toleration half needs pod specs this
          tab never loads. */}
      {section === 'taints' && <NodeTaintsSection id={id} view="taints" />}
      {section === 'tolerations' && <NodeTaintsSection id={id} view="tolerations" />}

      {section === 'headroom' && <CapacitySection id={id} />}

      {/* The explanation behind a clicked verdict. Rendered at the tab's root rather than inside the
          table, because `DetailPanel` is modal below 1280px and a dialog mounted inside a
          horizontally scrolling `.table-wrap` would be clipped by it. */}
      {diagnosed && <DiagnosisDrawer diagnosis={diagnose(diagnosed)} onClose={() => setDiagnosed(null)} />}
    </div>
  );
}

/**
 * One pod's CPU or memory: what it is using, over what it asked for.
 *
 * Two numbers rather than one, stacked, because they answer different questions and this console has
 * been wrong in both directions by conflating them. Usage explains pressure; the request is what the
 * scheduler actually counted against the node's allocatable, and it is the only one of the two that
 * exists on a cluster with no metrics-server.
 *
 * A null usage renders as `—`, never as `0`. `metrics.k8s.io` returning nothing and a genuinely idle
 * container are different facts, and a zero would make the second the visible answer for the first.
 * A null *request* is also `—`: a pod with no resources block has a real request of 0, and neither
 * source reporting one is not that.
 */
function PodResource({
  used,
  request,
  fmt
}: {
  used: number | null;
  request: number | null;
  fmt: (n: number | null | undefined) => string;
}) {
  return (
    <span className="mono inline-flex flex-col items-end leading-tight">
      <span className={used === null ? 'text-muted' : ''}>{used === null ? '—' : fmt(used)}</span>
      <span className="text-[11px] text-muted" title="requested — what the scheduler counted">
        req {request === null ? '—' : fmt(request)}
      </span>
    </span>
  );
}

function Usage({ value, pct }: { value: string | null; pct: number | null }) {
  if (value === null) return <span className="mono text-muted">—</span>;
  const tone = pct === null ? '' : pct >= 90 ? 'text-bad' : pct >= 70 ? 'text-warn' : '';
  return (
    <span className="mono">
      {value} <span className={tone}>({percent(pct)})</span>
    </span>
  );
}

// --------------------------------------------------------------------- workloads

/** The sub-navigation over the workloads table. `Pods` counts pods, not workload rows. */
type WorkloadFilter = 'all' | 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'pods';

const WORKLOAD_FILTERS: { id: WorkloadFilter; label: string; description: string }[] = [
  { id: 'all', label: 'All Workloads', description: 'Show every collected workload controller.' },
  { id: 'Deployment', label: 'Deployments', description: 'Show apps/v1 Deployments and their owned Pods.' },
  { id: 'StatefulSet', label: 'StatefulSets', description: 'Show apps/v1 StatefulSets and their ordered Pods.' },
  { id: 'DaemonSet', label: 'DaemonSets', description: 'Show apps/v1 DaemonSets and node coverage.' },
  { id: 'pods', label: 'Pods', description: 'Show the Pods owned by collected workload controllers.' }
];

const WORKLOAD_SECTIONS = TAB_SECTIONS.workloads;

type WorkloadSection = (typeof WORKLOAD_SECTIONS)[number]['id'];

/**
 * Workloads, Pods, Reliability and Events as four sections rather than one long scroll.
 *
 * Workloads and Pods are the *same* table with a different opening filter — a second pod list
 * would be a second answer about one object, which is the thing the resource layer exists to
 * prevent. `key` forces a remount so the chip actually changes when the section does.
 *
 * Reliability is the only section here that fetches; Workloads, Pods and Events all render from
 * the overview payload the page already holds, so three of the four cost nothing to open.
 */
function WorkloadsArea({
  id,
  items,
  metricsAvailable,
  selected,
  onSelect,
  status,
  events,
  eventStatus,
  onViewNode,
  onViewLogs,
  workloads,
  fetchedAt,
  onRefresh,
  onWarmLogs
}: {
  id: string;
  items: WorkloadRow[];
  metricsAvailable: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
  status: MetricStatus;
  events: EventRow[];
  eventStatus: MetricStatus;
  onViewNode: (nodeName: string) => void;
  onViewLogs: (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;
  workloads: Workloads;
  fetchedAt: number | null;
  onRefresh: () => void;
  onWarmLogs: () => void;
}) {
  const [section, setSection] = useSection<WorkloadSection>(WORKLOAD_SECTIONS, WORKLOAD_SECTIONS[0].id);

  /*
   * The namespace selection lives here — above the `key={section}` remount below — and in the URL.
   *
   * Both halves are load-bearing. Inside `WorkloadsTab` it would be destroyed the moment the operator
   * moved between the Workloads and Pods sub-tabs, because the remount that makes the opening chip
   * follow the section also discards that component's state: the table would quietly return every row
   * while the toolbar still named a namespace. Lifting it here survives that remount, and
   * `useNamespaceSelection` puts it in `?ns=` so it also survives a reload and can be pasted to a
   * colleague mid-incident.
   *
   * Filtering is client-side on this tab, and that is the correct answer rather than the cheap one:
   * these rows are the `/clusters/:id/overview` payload this page has *already* fetched for its tiles
   * and counts. `/overview` takes no namespace parameter, so filtering server-side here would not
   * shrink what the browser downloaded — it would add a second cluster read of data already in hand.
   * `/clusters/:id/workloads?namespace=` exists for the other shape, a namespace-scoped view whose
   * whole dataset is the filtered set.
   */
  const options = useMemo(() => namespaceOptions(items), [items]);
  const [namespaces, setNamespaces] = useNamespaceSelection('ns', options);

  /*
   * Two of the three sub-tab counters follow the namespace selection, because they label the two
   * sections the filter scopes. `events` deliberately does not: the Events section carries no
   * namespace control, so a filtered number over an unfiltered table would be the same lie in the
   * other direction.
   *
   * `pods` calls the function the Pods table itself calls instead of summing `w.pods.length`. A pod
   * claimed by overlapping selectors is one row but several summands, so the old total promised more
   * rows than the table could draw on any cluster with a shared selector — `kyma-system` has three
   * Deployments sharing `control-plane: controller-manager`.
   */
  const workloadCount = useMemo(() => filterByNamespace(items, namespaces).length, [items, namespaces]);

  const allPods = useMemo(() => flattenPods(items), [items]);
  // The Pods table's own scope, system toggle included — lifted here so the counter follows it.
  const { system, settled: systemSettled } = useSystemNamespaces(id);
  const [showSystem, setShowSystem] = useState(false);
  const podCount = useMemo(
    () => podsInScope(allPods, namespaces, system, showSystem).length,
    [allPods, namespaces, system, showSystem]
  );

  /*
   * Namespaces → one namespace: the Pods (or Top Consumers) section with `?ns=` set. One URL write, not
   * `setSection` then `setNamespaces` — two functional `setSearchParams` calls in one tick each start
   * from the same location, so the second would silently drop the first.
   */
  const [, setParams] = useSearchParams();
  const openNamespaceIn = useCallback(
    (section: 'pods' | 'top', ns: string) =>
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          p.set('section', section);
          // A drawer left open on another namespace's workload or resource would sit on top of the
          // filtered list and contradict it — the drawer resolves against the unfiltered items.
          p.delete('res');
          p.delete('workload');
          const value = serializeNamespaceParam(new Set([ns]));
          if (value === null) p.delete('ns');
          else p.set('ns', value);
          return p;
        },
        { replace: true }
      ),
    [setParams]
  );
  const openNamespace = useCallback((ns: string) => openNamespaceIn('pods', ns), [openNamespaceIn]);
  const openTopConsumers = useCallback((ns: string) => openNamespaceIn('top', ns), [openNamespaceIn]);

  return (
    <div>
      <SubTabs
        sections={WORKLOAD_SECTIONS}
        active={section}
        onSelect={setSection}
        counts={{ workloads: workloadCount, pods: podCount, events: events.length }}
      />
      {section === 'namespaces' && (
        <NamespacesSection
          id={id}
          items={items}
          metricsAvailable={metricsAvailable}
          status={status}
          onOpenNamespace={openNamespace}
          onOpenTopConsumers={openTopConsumers}
        />
      )}
      {section === 'pods' && (
        <PodsSection
          allPods={allPods}
          system={system}
          systemSettled={systemSettled}
          showSystem={showSystem}
          onShowSystem={setShowSystem}
          metricsAvailable={metricsAvailable}
          status={status}
          events={events}
          eventStatus={eventStatus}
          namespaceOptions={options}
          onViewNode={onViewNode}
          onViewLogs={onViewLogs}
        />
      )}
      {section === 'top' && (
        <TopConsumersSection
          workloads={workloads}
          system={system}
          systemSettled={systemSettled}
          showSystem={showSystem}
          onShowSystem={setShowSystem}
          status={status}
          namespaceOptions={options}
          fetchedAt={fetchedAt}
          onRefresh={onRefresh}
          onViewLogs={onViewLogs}
          onWarmLogs={onWarmLogs}
        />
      )}
      {section === 'workloads' && (
        <WorkloadsTab
          key={section}
          cluster={id}
          items={items}
          metricsAvailable={metricsAvailable}
          selected={selected}
          onSelect={onSelect}
          status={status}
          onViewNode={onViewNode}
          onViewLogs={onViewLogs}
          initialFilter="all"
          namespaces={namespaces}
          onNamespaces={setNamespaces}
          namespaceOptions={options}
        />
      )}
      {(section === 'hpas' || section === 'cronjobs') && <AutoscalingTab key={section} id={id} section={section} />}
      {section === 'events' && <EventsTab rows={events} status={eventStatus} />}
    </div>
  );
}

function WorkloadsTab({
  cluster,
  items,
  metricsAvailable,
  selected,
  onSelect,
  status,
  onViewNode,
  onViewLogs,
  initialFilter = 'all',
  namespaces,
  onNamespaces,
  namespaceOptions
}: {
  cluster: string;
  items: WorkloadRow[];
  metricsAvailable: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
  status: MetricStatus;
  onViewNode: (nodeName: string) => void;
  onViewLogs: (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;
  /** Which chip the list opens on. The Pods sub-tab is this component with `'pods'`, rather
   *  than a second pod list — one renderer, two entrances. */
  initialFilter?: WorkloadFilter;
  /** The namespace selection, owned by `WorkloadsArea` so it outlives this component's remount.
   *  Empty means every namespace — see `components/namespace-filter.ts` for why that, not "none". */
  namespaces: ReadonlySet<string>;
  onNamespaces: (next: ReadonlySet<string>) => void;
  /** Every namespace present in `items`, already derived and sorted by the owner of the selection. */
  namespaceOptions: readonly string[];
}) {
  /*
   * The kind pill stays in component state while the namespace selection does not, and the asymmetry
   * is the point: the pill *is* the sub-navigation, so the `key={section}` remount resetting it to
   * `initialFilter` is exactly the behaviour that makes the Pods sub-tab open on pods. A namespace is
   * a filter the operator set, which the same remount must not touch.
   */
  const [filter, setFilter] = useState<WorkloadFilter>(initialFilter);
  const key = (r: WorkloadRow) => `${r.namespace}/${r.kind}/${r.name}`;
  /*
   * Resolved against the **unfiltered** `items`, on purpose.
   *
   * The drawer's subject is the thing being read, not a row of the list: `?workload=` is a deep link a
   * colleague can be sent, and the resource drawers elsewhere on this console all resolve the same
   * way. Closing it because a namespace was ticked would make a filter destroy work in progress, and
   * an operator comparing a workload against its neighbours would lose the comparison to the click
   * that set it up. The toolbar above stays on screen with the selection named, so a drawer showing a
   * workload absent from the table below is explained rather than mysterious.
   */
  const current = items.find(r => key(r) === selected) ?? null;

  /** The pill and the namespaces as one value, so the row filter and the count line cannot drift. */
  const filterState: WorkloadFilterState = useMemo(() => ({ kind: filter, namespaces }), [filter, namespaces]);

  // Counts follow the namespace selection and ignore the pill — a pill has to show how many rows it
  // would reveal, which under a namespace filter means "within the selected namespaces". Counting the
  // kind-filtered list would make every inactive pill read 0; ignoring the namespaces would leave
  // `Deployment 14` on a pill that reveals 2. See `workload-filter.ts` for the rest of that argument.
  const counts = useMemo(() => workloadPillCounts(items, namespaces), [items, namespaces]);

  const rows = useMemo(() => filterWorkloads(items, filterState), [items, filterState]);

  // The Pods view renders from the workloads payload turned inside out, so the namespace filter has to
  // land here rather than on `rows` — computed once and handed to `PodInventoryList`, which used to
  // re-flatten the unfiltered `items` itself and would otherwise ignore the filter entirely.
  const pods = useMemo(() => podInventoryRows(items, namespaces), [items, namespaces]);

  // Named in the toolbar rather than left to the table's own row count: a number that shrank silently
  // is indistinguishable from a read that returned less, which is the failure this console exists to
  // avoid. `total` is the active pill across every namespace, so the line names exactly what the
  // selection hid.
  const shownOfTotal = useMemo(() => workloadShownOfTotal(items, filterState), [items, filterState]);

  // The rows' own noun, not "rows": the count line sits above a table of one specific kind, and
  // `kubectl`'s lowercase plural is the word an operator already uses for it.
  const noun = filter === 'pods' ? 'pods' : filter === 'all' ? 'workloads' : `${filter.toLowerCase()}s`;

  /**
   * Nine columns, and `shed="wide"` rather than the `mid` its count suggests.
   *
   * The tiers in theme.css key off CONTAINER width, not viewport. At 1440 with the rail expanded
   * this container measures 1090px — above mid's 1000px trigger, so mid stayed quiet, all nine
   * columns rendered, and the table overflowed by 596px with Workload alone at 528px. Capping the
   * three unbounded columns took that to 180px; `wide` (1300/1000) is the tier that actually fires
   * here, shedding Kind and Nodes and bringing the row to 1010px inside 1090px. Both columns come
   * back at a container of 1300px or more.
   */
  const columns: Column<WorkloadRow>[] = [
    {
      key: 'name',
      header: 'Workload',
      pin: true,
      // `max`, not `width`: measured at 1440 this column rendered 528px against its declared 260px,
      // because `.tbl tbody td` sets `white-space: nowrap` and `table-layout: auto` lets the widest
      // cell override a header width. The Pill plus a long Deployment name is what pushed it.
      max: '260px',
      /*
       * The status is an 8px dot here and its word moved to its own `State` column.
       *
       * It used to be a `Pill` in front of the name, which made every workload name start at
       * `12px + pill width`, and the pill's width is the status *text*. A DOM canary measured the
       * cost: a row whose state read `CreateContainerConfigError` pushed its name 136px right of
       * every other row's. On a healthy cluster all the pills are the same width, so the defect is
       * invisible until the one row you are looking for is the one that moves.
       *
       * A fixed-width status slot was the other option and was rejected: the `State` cell appends
       * the container-level reasons from `podIssues`, so this string is not a closed vocabulary and
       * a fixed slot would truncate the one row that has something to say. A dot is
       * fixed-width by construction, and the `State` column that follows is left-aligned with a
       * ceiling and a `title`, so a long reason ellipsises in its own column instead of displacing
       * the identity of every row around it.
       */
      render: r => (
        <ResourceLink
          refTo={{ kind: r.kind as ResourceKind, namespace: r.namespace, name: r.name }}
          className="mono"
          tone={workloadTone(r.state, r.healthy)}
        />
      )
    },
    {
      key: 'state',
      header: 'State',
      // Left, and an identity-style ceiling rather than a numeric one: the value is a sentence
      // fragment (`CreateContainerConfigError`, `ImagePullBackOff`), not a magnitude.
      max: '150px',
      // The controller's own state, plus the container-level diagnosis the collector attributes
      // separately in `podIssues`. These are two vocabularies: `state` is only ever
      // Ready/Progressing/Unavailable, and a waiting reason like `CrashLoopBackOff` belongs to a
      // container in one pod. Printing the reason alone in this slot named neither the pod nor the
      // container; `workloadStateSummary` keeps the state and appends "— 2 pods CrashLoopBackOff",
      // with every namespace/pod/container in the tooltip. The ceiling stays 150px: the appended
      // clause ellipsises in its own column and the tooltip carries the full attribution.
      render: r => {
        const s = workloadStateSummary(r.state, r.podIssues);
        return (
          <span className={`truncate text-[13px] ${TONE_TEXT[workloadTone(r.state, r.healthy)]}`} title={s.title}>
            {s.text}
          </span>
        );
      }
    },
    {
      key: 'ns',
      header: 'Namespace',
      // Namespace names are unbounded; uncapped this ran to 214px.
      max: '170px',
      render: r => (
        <ResourceLink refTo={{ kind: 'Namespace', namespace: null, name: r.namespace }} className="mono" />
      )
    },
    { key: 'kind', header: 'Kind', priority: 3, render: r => r.kind },
    {
      key: 'ready',
      header: 'Ready',
      info: COLUMN_INFO.ready,
      // Centre: `Pair` puts the `/` on its own grid track, and this is a fixed-width ratio rather
      // than a magnitude — the number an operator compares is `ready` against `desired`, not either
      // one against the row above.
      align: 'center',
      render: r => (
        <Pair
          className={r.ready < r.desired ? 'text-bad' : ''}
          a={r.ready}
          b={r.desired}
          title={`${r.ready} of ${r.desired} replicas ready`}
        />
      )
    },
    {
      key: 'nodes',
      // "Scheduled on", not "Nodes": this cell renders a node *name* — a string, left-aligned —
      // while the fleet Overview's column of the same old name renders `ready/total`, a count that
      // belongs on the right. One label meaning two different facts is what made those two tables
      // disagree about where a value sits; `test/fleet/table-alignment.test.js` now fails on it.
      header: 'Scheduled on',
      // Priority 3, not 2. When the panel squeezes this table, CPU and memory are the numbers
      // an operator scans a list for; "2 nodes" is a spread question that the panel answers
      // per pod, with the node names, which this cell only ever counted.
      priority: 3,
      // The `truncate` below was inert without a ceiling: a single-node row prints the node name in
      // full, so the column grew to the longest node name — 254px measured.
      max: '150px',
      render: r => (
        <span className="mono truncate text-[13px]" title={r.nodes.join('\n')}>
          {r.nodes.length === 0 ? '—' : r.nodes.length === 1 ? r.nodes[0] : `${r.nodes.length} nodes`}
        </span>
      )
    },
    /*
     * Two shapes per column, because the column holds one number or two.
     *
     * With metrics-server up this is `used / requested` and the `/` is the axis an operator reads
     * down, so it goes through `Pair` and the header centres over it. With metrics unavailable there
     * is only the request, a plain magnitude, and it stays flush right — centring a single number
     * would leave it floating in the middle of its column for no reason.
     */
    {
      key: 'cpu',
      header: metricsAvailable ? 'CPU (used/req)' : 'CPU req',
      info: metricsAvailable ? COLUMN_INFO.cpuUsedReq : COLUMN_INFO.cpuRequest,
      align: metricsAvailable ? 'center' : 'right',
      priority: 2,
      render: r =>
        metricsAvailable ? (
          <Pair a={cpu(r.cpuUsage)} b={cpu(r.cpuRequest)} title={`using ${cpu(r.cpuUsage)} of ${cpu(r.cpuRequest)} requested`} />
        ) : (
          <span className="mono">{cpu(r.cpuRequest)}</span>
        )
    },
    {
      key: 'mem',
      header: metricsAvailable ? 'Mem (used/req)' : 'Mem req',
      info: metricsAvailable ? COLUMN_INFO.memUsedReq : COLUMN_INFO.memRequest,
      align: metricsAvailable ? 'center' : 'right',
      priority: 2,
      render: r =>
        metricsAvailable ? (
          <Pair
            a={bytes(r.memoryUsage)}
            b={bytes(r.memoryRequest)}
            title={`using ${bytes(r.memoryUsage)} of ${bytes(r.memoryRequest)} requested`}
          />
        ) : (
          <span className="mono">{bytes(r.memoryRequest)}</span>
        )
    },
    {
      key: 'restarts',
      header: 'Restarts',
      info: COLUMN_INFO.restarts,
      align: 'right',
      // Priority 2, not 3. Under `wide` the priority-3 set all sheds at a 1090px container, and this
      // table had four columns in it — a restart count is the health signal an operator scans a
      // workload list for, so it outranks Kind, Nodes and the restart timestamp.
      priority: 2,
      render: r => <span className={`mono ${r.restarts > 10 ? 'text-warn' : ''}`}>{r.restarts}</span>
    },
    {
      key: 'rolled',
      header: 'Last restart',
      align: 'right',
      priority: 3,
      render: r => <span className="mono">{r.restartedAt ? ago(r.restartedAt) : '—'}</span>
    }
  ];

  return (
    <div className="space-y-4">
      {!metricsAvailable && (
        <p className="text-[13px] text-muted">
          metrics-server is not answering on this cluster, so live CPU and memory are hidden. Requests and limits are
          read from the pod spec and remain exact.
        </p>
      )}

      {/*
        One toolbar row, not two. The kind pills and the namespace control narrow the same table, and
        a control of its own row would sit beside 800px of nothing on a console whose density budget is
        spent on data. `FilterBar` brings the rule under the row, the `ml-auto` count line and the
        reset — so requirement 13's "show the active filter in the toolbar" and requirement 14's clear
        action land in the row the pills already occupy.

        It also has to sit OUTSIDE `DataTable`, which returns its empty state *instead of* its `<thead>`
        and toolbar when it has no rows: a filter that matched nothing would otherwise take the only
        control that could clear it off the screen with the rows.
      */}
      <FilterBar
        activeCount={activeWorkloadFilters(filterState)}
        onReset={() => onNamespaces(ALL_NAMESPACES)}
        resultLine={countLine(shownOfTotal.shown, shownOfTotal.total, noun)}
      >
        {/* The pills stay one group so they wrap as a block rather than one pill at a time. */}
        <div className="flex flex-wrap items-center gap-2">
          {WORKLOAD_FILTERS.map(f => {
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={on}
                title={f.description}
                className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${
                  on
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-line text-muted hover:border-accent hover:text-text'
                }`}
              >
                {f.label}
                <span className="mono ml-1.5 text-[12px] opacity-70">{counts[f.id]}</span>
              </button>
            );
          })}
        </div>
        <NamespaceFilter options={namespaceOptions} selected={namespaces} onChange={onNamespaces} />
      </FilterBar>

      {/* A flex ROW, and that is load-bearing rather than cosmetic: `DetailPanel` picks its
          inline layout only when its parent lays children out in a row (see layout.tsx). As a
          real flex sibling the panel takes its 420px *away from* the table instead of covering
          it, so `.table-wrap`'s inline-size container queries finally fire and the table sheds
          its priority-3 then priority-2 columns rather than overflowing. Selecting a workload
          used to append a full-width card *below* a 68-row table — the detail was reliably off
          screen at the moment it was asked for. */}
      <div className="flex min-w-0 items-start gap-4">
        <div className="min-w-0 flex-1 space-y-4">
          {filter === 'pods' ? (
            <PodInventoryList
              pods={pods}
              total={shownOfTotal.total}
              metricsAvailable={metricsAvailable}
              onViewNode={onViewNode}
              onViewLogs={onViewLogs}
            />
          ) : (
            <Card title={`${WORKLOAD_FILTERS.find(f => f.id === filter)!.label} (${rows.length})`}>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={key}
                shed="wide"
                selectedKey={selected}
                onSelect={r => onSelect(key(r) === selected ? null : key(r))}
                empty={
                  status.state === 'ok' ? (
                    /*
                     * Two different facts, and the old copy stated the first while meaning either.
                     * "Nothing outside the system namespaces" is a claim about the *cluster*, so under
                     * a filter that matched nothing it told the operator the cluster was empty when
                     * their own selection was doing the hiding. The Nodes tab's Scheduled pods table
                     * already draws this line; this follows it, and names the number the filter is
                     * hiding so the way out is obvious.
                     */
                    items.length === 0 ? (
                      <Empty title="No workloads" hint="Nothing outside the system namespaces." />
                    ) : (
                      <Empty
                        title="No matching workloads"
                        hint={`None of the ${items.length} collected workloads match the current filters.`}
                      />
                    )
                  ) : (
                    <UnavailableEmptyBody status={status} />
                  )
                }
              />
            </Card>
          )}
        </div>

        {current && (
          <DetailPanel
            title={<span className="mono">{current.name}</span>}
            subtitle={`${current.namespace} · ${current.kind}`}
            onClose={() => onSelect(null)}
            /* 84px clears the two-row tab strip, which is sticky in the same scroll container
               that this panel sticks to — without the offset the panel slides underneath it.
               Only the Workloads group is ever two rows, and this panel exists only here. */
            inlineClassName="sticky top-[84px] max-h-[calc(100vh-100px)] rounded-[8px] border border-line"
          >
            <Section label="Rollout">
              <RolloutStatusView cluster={cluster} workload={current} />
            </Section>
            <Section label="Status">
              <Field
                label="State"
                value={<Pill tone={workloadTone(current.state, current.healthy)}>{current.state}</Pill>}
              />
              <Field label="Ready" value={`${current.ready}/${current.desired}`} mono />
              <Field label="Updated" value={`${current.updatedReplicas}/${current.desired}`} mono />
              <Field label="Available" value={`${current.availableReplicas}/${current.desired}`} mono />
              <Field
                label="Generation"
                value={`${current.observedGeneration ?? '—'} / ${current.generation ?? '—'}`}
                mono
              />
              <Field label="Created" value={ago(current.createdAt)} mono />
            </Section>
            <Section label="Resources">
              <Field label="CPU request" value={`${cores(current.cpuRequest)} cores`} mono />
              <Field label="CPU limit" value={current.cpuLimit ? `${cores(current.cpuLimit)} cores` : 'none'} mono />
              <Field label="Memory request" value={bytes(current.memoryRequest)} mono />
              <Field label="Memory limit" value={current.memoryLimit ? bytes(current.memoryLimit) : 'none'} mono />
              {metricsAvailable && (
                <>
                  <Field label="CPU in use" value={`${cores(current.cpuUsage)} cores`} mono />
                  <Field label="Memory in use" value={bytes(current.memoryUsage)} mono />
                </>
              )}
            </Section>

            <Section label={`Pods (${current.pods.length})`}>
              {current.pods.length === 0 && <p className="text-[14px] text-muted">No pods match this selector.</p>}
              <div className="space-y-3">
                {current.pods.map(p => {
                  const s = podState(p);
                  const reason = reasonLabel(s);
                  return (
                  <div key={p.name} className="rounded-[6px] border border-line p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="mono min-w-0 truncate text-[14px]" title={p.name}>
                        {p.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {p.qosClass && <span className="mono text-[12px] text-muted">{p.qosClass}</span>}
                        {/* Phase, readiness and the container reason are three facts and get three
                            slots. See `pod-state.ts` for why folding them into one was wrong. */}
                        {reason && <span className="mono text-[12px] text-bad">{reason}</span>}
                        <Pill tone={s.tone}>
                          {s.phase}
                          {s.readyText && <span className="ml-1.5 opacity-80">{s.readyText}</span>}
                        </Pill>
                        <Btn onClick={() => onViewLogs(p.namespace, p.name)}>Logs</Btn>
                      </span>
                    </div>

                    <div className="mono mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
                      {p.node ? (
                        <button
                          type="button"
                          onClick={() => onViewNode(p.node!)}
                          title="View this node in the Nodes tab"
                          className="rounded border border-line bg-raised px-1.5 py-0.5 text-text transition-colors hover:border-accent hover:text-accent"
                        >
                          node {p.node}
                        </button>
                      ) : (
                        <span title="No node assigned">node unscheduled</span>
                      )}
                      {p.podIP && <span>ip {p.podIP}</span>}
                      <span>{p.restarts} restarts</span>
                      <span>started {ago(p.startedAt)}</span>
                      {metricsAvailable && p.cpuUsage !== null && (
                        <span>
                          using {cpu(p.cpuUsage)} CPU · {bytes(p.memoryUsage)}
                        </span>
                      )}
                    </div>

                    {p.nodeSelector && Object.keys(p.nodeSelector).length > 0 && (
                      <div className="mono mt-1 text-[12px] text-muted">
                        nodeSelector{' '}
                        {Object.entries(p.nodeSelector)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(', ')}
                      </div>
                    )}

                    <table className="tbl-inline mt-2">
                      <thead>
                        <tr>
                          <th>container</th>
                          <th>state</th>
                          <th className="num">restarts</th>
                          <th className={metricsAvailable ? 'ctr' : 'num'}>
                            cpu {metricsAvailable ? 'use/req' : 'req'}
                          </th>
                          <th className={metricsAvailable ? 'ctr' : 'num'}>
                            mem {metricsAvailable ? 'use/req' : 'req'}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.containers.map(c => (
                          <tr key={c.name}>
                            <td className="mono align-top">
                              {c.name}
                              {c.init && <span className="ml-1 text-[11px] uppercase text-muted">init</span>}
                              <div className="mono max-w-[36ch] truncate text-[11px] text-muted" title={c.image}>
                                {c.image}
                              </div>
                            </td>
                            <td>
                              <span className={c.ready ? 'text-ok' : c.reason ? 'text-bad' : 'text-warn'}>
                                {c.reason ?? c.state}
                              </span>
                            </td>
                            <td className="mono num">{c.restarts}</td>
                            <td className={metricsAvailable ? 'ctr' : 'mono num'}>
                              {metricsAvailable ? (
                                <Pair a={cpu(c.cpuUsage)} b={cpu(c.cpuRequest)} />
                              ) : (
                                cpu(c.cpuRequest)
                              )}
                            </td>
                            <td className={metricsAvailable ? 'ctr' : 'mono num'}>
                              {metricsAvailable ? (
                                <Pair a={bytes(c.memoryUsage)} b={bytes(c.memoryRequest)} />
                              ) : (
                                bytes(c.memoryRequest)
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  );
                })}
              </div>
            </Section>
          </DetailPanel>
        )}
      </div>

      {current && <WorkloadGraphPanel cluster={cluster} workload={current} />}
    </div>
  );
}

/**
 * Every pod of every workload, flat. This is the `Pods` pill's view: the same data the
 * per-workload drawer shows, re-cut for the times the question is "which pod is unhealthy"
 * rather than "is this Deployment healthy". No extra request — it is the workloads payload
 * turned inside out.
 *
 * Takes the pods rather than the workloads, deliberately. It used to take `items` and call
 * `flattenPods` itself, which meant the namespace filter applied to the workloads table above had no
 * effect here at all — one component filtered, the other re-derived from the unfiltered payload. The
 * rows and the count beside them now come from one array computed in one place.
 */
function PodInventoryList({
  pods,
  total,
  metricsAvailable,
  onViewNode,
  onViewLogs
}: {
  /** One row per pod, already namespace-filtered and deduplicated by `podInventoryRows`. */
  pods: InventoryPod[];
  /** Every pod across every namespace, so the empty state can name what the filter is hiding. */
  total: number;
  metricsAvailable: boolean;
  onViewNode: (nodeName: string) => void;
  onViewLogs: (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;
}) {
  const columns: Column<(typeof pods)[number]>[] = [
    {
      key: 'pod',
      header: 'Pod',
      pin: true,
      // Measured at 1440 in a 1090px container: this table overflowed by 885px with Pod at 639px
      // against its declared 280px, Owner 415px, Node 254px and Namespace 214px — four unbounded
      // text columns and not one ceiling among them. `width` cannot bind a nowrap cell.
      max: '260px',
      sortValue: p => p.name,
      // The name opens the resource drawer, as it does in the Scheduled pods table above and in Top
      // Consumers. It was plain text here alone, which made the same pod clickable on one tab and
      // inert on another — the kind of inconsistency an operator reads as a broken row rather than a
      // deliberate difference. The Pill stays outside the link: the phase is a fact about the row,
      // not part of the resource's identity.
      //
      // Phase and reason are two slots, never one. `reason ?? phase` printed `CrashLoopBackOff`
      // where the phase belongs — a string no pod phase ever takes — and toned every `Running` pod
      // green whether or not its containers were ready. `podState` keeps them apart and reserves
      // the green pill for Running with ContainersReady=True; see `pod-state.ts`.
      render: p => {
        const s = podState(p);
        const reason = reasonLabel(s);
        // The Owner column is gone from this table, but the fact it carried is not. One owner is a
        // fact, several is an ambiguity, and naming the first of them is a guess dressed as a fact —
        // so the verdict moves into this cell's hover rather than being deleted with the column.
        // `ownerVerdict` still owns the rule and is still tested in `pod-inventory.test.ts`; the
        // Workloads table above remains the place where ownership is a column of its own.
        const owner = ownerVerdict(p.owners);
        const ownerTitle =
          owner.kind === 'ambiguous'
            ? `${owner.count} workloads select this pod:\n${owner.candidates.join('\n')}`
            : owner.kind === 'one'
              ? `Selected by ${owner.full}`
              : 'No workload in this cluster selects this pod';
        return (
          <div className="flex items-center gap-2.5">
            <Pill tone={s.tone}>
              {s.phase}
              {s.readyText && <span className="ml-1.5 opacity-80">{s.readyText}</span>}
            </Pill>
            {reason && (
              <span className="mono truncate text-[12px] text-bad" title={reason}>
                {reason}
              </span>
            )}
            {/* `ResourceLink` takes no `title`, so the owner verdict hangs on a wrapper rather
                than being dropped. */}
            <span title={ownerTitle} className="min-w-0">
              <ResourceLink refTo={{ kind: 'Pod', namespace: p.namespace, name: p.name }} className="mono" />
            </span>
            {owner.kind === 'ambiguous' && (
              // Ambiguity is the one owner state that must stay visible without a hover: it means
              // the console cannot tell you which workload owns this pod, and a silent tooltip
              // would let that read as a settled fact.
              <span className="shrink-0 text-[11px] text-warn" title={ownerTitle}>
                {owner.count} owners
              </span>
            )}
          </div>
        );
      }
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '170px',
      sortValue: p => p.namespace,
      // Tinted, because this table lists pods from every namespace at once and the namespace is the
      // first thing an operator scans for. It reads as a tag rather than as a second name beside the
      // pod's own. Palette tokens only — `accent-bright` is the AA-legible sibling of the brand
      // violet and has a light-theme value, so this stays readable in both themes.
      render: p => (
        <ResourceLink
          refTo={{ kind: 'Namespace', namespace: null, name: p.namespace }}
          className="ns-tag mono"
        />
      )
    },
    {
      key: 'node',
      header: 'Node',
      priority: 2,
      max: '150px',
      render: p =>
        p.node ? (
          <button
            type="button"
            onClick={() => onViewNode(p.node!)}
            className="mono truncate text-[13px] text-text underline decoration-dotted hover:text-accent"
            title="View this node in the Nodes tab"
          >
            {p.node}
          </button>
        ) : (
          <span className="mono text-muted">unscheduled</span>
        )
    },
    // Order: Pod, Namespace, Node, CPU, Memory, Restarts, Actions. Restarts moved to the right of
    // the two metric columns — it is a symptom you check after reading consumption, not an identity
    // field, and sitting between Node and CPU it split the placement columns from the resource ones.
    //
    // Both metric columns now carry three values, `used / request / limit`. The limit is the half
    // that decides what the kubelet does: exceeding a memory limit is an OOMKill (memory is
    // incompressible), exceeding a CPU limit is throttling (CPU is compressible). A row showing
    // usage against a request alone cannot tell you how close either is.
    {
      key: 'cpu',
      header: metricsAvailable ? 'CPU (use/req/lim)' : 'CPU (req/lim)',
      info: metricsAvailable ? COLUMN_INFO.cpuUsedReq : COLUMN_INFO.cpuRequest,
      // Centred like `Pair`, and for the same reason: the separators land on a column, so the
      // header centres over them rather than over the last operand's final digit.
      align: 'center',
      priority: 3,
      max: '200px',
      render: p => {
        const used = usedText(p.cpuUsage, cpu);
        const req = requestText(p.cpuRequest, cpu);
        const lim = limitText(p.cpuLimit, cpu);
        return (
          <span className="mono tabular-nums text-[12px]" title={metricTitle('CPU', used, req, lim)}>
            {metricsAvailable && <span>{used} / </span>}
            <span>{req}</span>
            <span className={isUnbounded(p.cpuLimit) ? 'text-muted' : ''}> / {lim}</span>
          </span>
        );
      }
    },
    {
      key: 'mem',
      header: metricsAvailable ? 'Memory (use/req/lim)' : 'Memory (req/lim)',
      info: metricsAvailable ? COLUMN_INFO.memUsedReq : COLUMN_INFO.memRequest,
      align: 'center',
      priority: 3,
      max: '230px',
      render: p => {
        const used = usedText(p.memoryUsage, bytes);
        const req = requestText(p.memoryRequest, bytes);
        const lim = limitText(p.memoryLimit, bytes);
        return (
          <span className="mono tabular-nums text-[12px]" title={metricTitle('Memory', used, req, lim)}>
            {metricsAvailable && <span>{used} / </span>}
            <span>{req}</span>
            {/* An absent memory limit is the one worth toning: it is the OOMKill ceiling, and
                without it the pod is evicted on node pressure instead of being capped. */}
            <span className={isUnbounded(p.memoryLimit) ? 'text-warn' : ''}> / {lim}</span>
          </span>
        );
      }
    },
    {
      key: 'restarts',
      header: 'Restarts',
      info: COLUMN_INFO.restarts,
      align: 'right',
      render: p => <span className={`mono tabular-nums ${p.restarts > 10 ? 'text-warn' : ''}`}>{p.restarts}</span>
    },
    {
      key: 'logs',
      ...ACTIONS,
      render: p => <Btn onClick={() => onViewLogs(p.namespace, p.name)}>Logs</Btn>
    }
  ];

  return (
    <Card title={`Pods (${pods.length})`} flush>
      <DataTable
        columns={columns}
        rows={pods}
        rowKey={p => `${p.namespace}/${p.name}`}
        // `mid`, not `wide`. `wide` sheds priority 3 at a container of 1300px, and this container is
        // 1165px at a 1440px viewport with the rail expanded — so CPU and memory were hidden at the
        // default width, on the one table whose job is to show them. That tier was chosen when this
        // table had ten columns; dropping `Owner` left seven, and `mid` (1000 / 700) is the tier the
        // CSS comment already names for a pod inventory. At 1165px nothing sheds: the columns
        // compress toward their content instead, which is the trade this table already prefers for
        // identity — scroll rather than hide, because the Pod name is sticky.
        shed="mid"
        empty={
          /* "No workload on this cluster has any pods" was a claim about the cluster on a table that
             can now be showing a subset of it — the filter's own work read as a finding about the
             fleet. Same split as the workloads table above. */
          total === 0 ? (
            <Empty title="No pods" hint="No workload on this cluster has any pods." />
          ) : (
            <Empty title="No matching pods" hint={`None of the ${total} pods match the current filters.`} />
          )
        }
      />
    </Card>
  );
}

/**
 * The dependency graph around the selected workload: how traffic reaches it, what it is
 * built from, what configuration it reads, and what its containers actually declare.
 *
 * Fetched lazily and keyed on the selection — `useAsync` cannot watch the fetcher itself
 * (see its `key` doc), and this component's whole purpose changes every time the operator
 * clicks a different row.
 */
function WorkloadGraphPanel({ cluster, workload }: { cluster: string; workload: WorkloadRow }) {
  const selection = `${workload.namespace}/${workload.kind}/${workload.name}`;
  const fetcher = useCallback(
    () => api.workloadGraph(cluster, workload.namespace, workload.kind, workload.name),
    [cluster, workload.namespace, workload.kind, workload.name]
  );
  const graph = useAsync(fetcher, 0, selection);

  if (graph.initial) return <Card title="Dependencies">{<p className="text-[14px] text-muted">Reading…</p>}</Card>;
  if (graph.error || !graph.data?.data) {
    return (
      <Card title="Dependencies">
        <p className="text-[14px] text-muted">
          {graph.error?.message ?? 'This workload’s dependency graph could not be read.'}
        </p>
      </Card>
    );
  }

  const g = graph.data.data;
  const missing = g.summary.unavailable;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Dependencies
          <span className="mono text-[13px] text-muted">{selection}</span>
        </span>
      }
      action={<Btn onClick={graph.reload}>Reload</Btn>}
    >
      <div className="space-y-6">
        {missing.length > 0 && (
          <p className="text-[13px] text-warn">
            Could not read {missing.join(', ')} — anything below that would come from those reads is missing, not absent.
          </p>
        )}

        {/* The flow. Horizontal on a wide screen, stacked on a narrow one, because the
            arrow between stages is the meaning and a wrapped row of boxes loses it. */}
        <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-start">
          {g.flow.map((stage, i) => (
            <Fragment key={stage.stage}>
              {i > 0 && (
                <div aria-hidden className="self-center px-1 text-[16px] text-muted lg:pt-8">
                  <span className="lg:hidden">↓</span>
                  <span className="hidden lg:inline">→</span>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                  {stage.label}
                </h3>
                {stage.items.length === 0 ? (
                  // Greyed, never omitted: a stage with nothing in it is the finding.
                  <div className="rounded-[6px] border border-dashed border-line px-2.5 py-2 text-[13px] text-muted">
                    none
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {stage.items.map(n => (
                      <li
                        key={`${n.kind}/${n.name}`}
                        className={`rounded-[6px] border px-2.5 py-2 ${
                          stage.stage === 'workload' ? 'border-accent bg-accent/5' : 'border-line bg-raised'
                        }`}
                      >
                        <div className="mono truncate text-[13px]" title={n.name}>
                          {n.name}
                        </div>
                        <div className="text-[11px] text-muted">
                          {n.kind}
                          {n.detail ? ` · ${n.detail}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Fragment>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <Section label={`Services (${g.services.length})`}>
              {g.services.length === 0 ? (
                <p className="text-[13px] text-muted">No Service selects this workload’s pods.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {g.services.map(s => (
                    <li key={s.name} className="py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="mono truncate text-[13px]">{s.name}</span>
                        <span className="mono shrink-0 text-[12px] text-muted">{s.type}</span>
                      </div>
                      <div className="mono text-[12px] text-muted">
                        {s.ports.length === 0
                          ? 'no ports'
                          : s.ports.map(p => `${p.port}→${p.targetPort ?? p.port}/${p.protocol}`).join('  ')}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section label={`Autoscaling (${g.hpas.length})`}>
              {g.hpas.length === 0 ? (
                <p className="text-[13px] text-muted">No HorizontalPodAutoscaler targets this workload.</p>
              ) : (
                g.hpas.map(h => (
                  <Field
                    key={h.name}
                    label={h.name}
                    value={`${h.current ?? '—'} now · desired ${h.desired ?? '—'} · range ${h.min ?? '—'}–${h.max ?? '—'}`}
                    mono
                  />
                ))
              )}
            </Section>

            {g.replicaSets.length > 0 && (
              <Section label={`ReplicaSets (${g.replicaSets.length})`}>
                <ul className="divide-y divide-line">
                  {g.replicaSets.map(rs => (
                    <li key={rs.name} className="flex items-center justify-between gap-3 py-2">
                      <span className="mono min-w-0 truncate text-[13px]" title={rs.name}>
                        {rs.name}
                      </span>
                      <span className="mono shrink-0 text-[12px] text-muted">
                        rev {rs.revision ?? '—'} · {rs.ready}/{rs.desired}
                        {!rs.active && ' · retained'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>

          <Section label={`Configuration (${g.config.length})`}>
            {g.config.length === 0 ? (
              <p className="text-[13px] text-muted">This workload reads no ConfigMap, Secret or volume claim.</p>
            ) : (
              <ul className="divide-y divide-line">
                {g.config.map(c => (
                  <li key={`${c.kind}/${c.name}`} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="mono block truncate text-[13px]" title={c.name}>
                        {c.name}
                      </span>
                      <span className="text-[11px] text-muted">{c.kind}</span>
                    </span>
                    <span className="mono shrink-0 text-[12px] text-muted">{c.via.join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <Section label={`Containers (${g.containers.length})`}>
          <div className="space-y-3">
            {g.containers.map(c => (
              <div key={c.name} className="rounded-[6px] border border-line p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="mono text-[14px]">
                    {c.name}
                    {c.init && <span className="ml-1.5 text-[11px] uppercase text-muted">init</span>}
                  </span>
                  <span className="mono shrink-0 text-[12px] text-muted">
                    {c.probes.liveness ? 'liveness ' : ''}
                    {c.probes.readiness ? 'readiness ' : ''}
                    {c.probes.startup ? 'startup' : ''}
                    {!c.probes.liveness && !c.probes.readiness && !c.probes.startup && 'no probes'}
                  </span>
                </div>

                <div className="mono mt-1 break-all text-[12px] text-muted" title={c.image ?? ''}>
                  {c.image ?? '—'}
                </div>
                {/* One digest is the normal case. Two means the replicas are not running the
                    same bits, which a mutable tag hides completely. */}
                {c.digests.length > 0 && (
                  <div className={`mono mt-0.5 break-all text-[11px] ${c.digests.length > 1 ? 'text-warn' : 'text-muted'}`}>
                    {c.digests.join('  ')}
                    {c.digests.length > 1 && ' — replicas differ'}
                  </div>
                )}

                <div className="mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                  <span>
                    cpu {cpu(c.cpuRequest)} / {c.cpuLimit ? cpu(c.cpuLimit) : 'unbounded'}
                  </span>
                  <span>
                    mem {bytes(c.memoryRequest)} / {c.memoryLimit ? bytes(c.memoryLimit) : 'unbounded'}
                  </span>
                  {c.ports.length > 0 && <span>ports {c.ports.map(p => p.containerPort).join(', ')}</span>}
                </div>

                {(c.envKeys.length > 0 || c.envFromCount > 0) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[12px] text-muted hover:text-text">
                      {c.envKeys.length} env {c.envKeys.length === 1 ? 'variable' : 'variables'}
                      {c.envFromCount > 0 && ` + ${c.envFromCount} envFrom`}
                    </summary>
                    {/* Keys only. The values are deliberately not fetched — see the server note. */}
                    <div className="mono mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                      {c.envKeys.map(k => (
                        <span key={k} className="rounded border border-line bg-raised px-1.5 py-0.5 text-muted">
                          {k}
                        </span>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </Card>
  );
}

// -------------------------------------------------------------------- compliance

function ComplianceTab({
  rows,
  rollup,
  status,
  onViewIsolation
}: {
  rows: NamespaceRow[];
  /** The collector's own roll-up. Absent on a server older than the completeness contract. */
  rollup?: ComplianceRollup;
  status: MetricStatus;
  /** Jumps to Security & Isolation, which is where a workload-level verdict actually lives. */
  onViewIsolation: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) {
    // "Nothing audited" and "the audit was refused" are opposite findings; only one of them
    // means the cluster is clean.
    return status.state === 'ok' ? (
      <Empty title="Nothing audited" hint="No non-system namespaces on this cluster." />
    ) : (
      <UnavailableEmptyBody status={status} />
    );
  }

  return (
    <div className="space-y-2">
      {/*
        What was measured, named before any verdict.

        The pill used to read `Compliant`, which reads as certification against a standard — and no
        standard was named anywhere on screen. The five checks come one-for-one from the
        `namespace-bootstrapping` Helm chart (see `srv/fleet/collectors/compliance.js`), so that is
        what the heading says, and the cross-link points at the sub-tab that does look at workloads.
      */}
      <div className="space-y-1 pb-1">
        <p className="text-[13px] text-text">
          Bootstrap conventions from the <span className="mono">{BOOTSTRAP_CHART}</span> Helm chart — five
          checks on labels, a pull secret, a RoleBinding and an egress NetworkPolicy. Not a certification
          against an external standard, and not a workload verdict.
        </p>
        <button
          type="button"
          onClick={onViewIsolation}
          className="text-[12px] text-accent underline decoration-dotted underline-offset-2 hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Workload-level evidence is on Security &amp; Isolation
        </button>
      </div>
      {/*
        The verdict, before the list. Scrolling 30 namespace rows to learn "one has findings"
        is the work this strip removes, and it is also the only place `systemSkipped` can be
        seen — the denominator question an operator asks the moment they see "28 compliant":
        compliant out of how many, and what was deliberately left out? A skipped system
        namespace is not a pass and not a gap; folding it into either would misstate the audit.
        Every number here is the collector's, so a partial namespace read marks them floors
        rather than silently shrinking the denominator.
      */}
      {rollup && (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 border-b border-line pb-3 text-[13px]">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-muted">Audited</span>
            <span className="mono text-text">
              <Count status={status} value={rollup.audited} />
            </span>
          </span>
          {/* Not "Compliant", and not green: this counts namespaces where all five bootstrap
              conventions are present. Green here read as a certification against a named
              standard, which is not what any of the five checks establishes, and it contradicted
              the prose and the row pills directly beneath it. */}
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-muted">All conventions present</span>
            <span className="mono text-text">
              <Count status={status} value={rollup.compliant} />
            </span>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-muted">With warnings</span>
            <span className={`mono ${rollup.withWarnings > 0 ? 'text-warn' : 'text-text'}`}>
              <Count status={status} value={rollup.withWarnings} />
            </span>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-muted">With findings</span>
            <span className={`mono ${rollup.withFindings > 0 ? 'text-bad' : 'text-text'}`}>
              <Count status={status} value={rollup.withFindings} />
            </span>
          </span>
          <span
            className="inline-flex items-baseline gap-1.5"
            title="System namespaces (kube-*, istio-system and the like) are excluded from the audit on purpose — a system namespace with no egress policy is not a finding. They are neither passes nor gaps."
            tabIndex={0}
          >
            <span className="border-b border-dotted border-muted/60 pb-px text-muted">System, not audited</span>
            <span className="mono text-muted">
              <Count status={status} value={rollup.systemSkipped} />
            </span>
          </span>
        </div>
      )}
      {rows.map(r => (
        <div key={r.namespace} className="card">
          <button
            type="button"
            onClick={() => setOpen(open === r.namespace ? null : r.namespace)}
            className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left hover:bg-raised"
            aria-expanded={open === r.namespace}
          >
            <span className="flex min-w-0 items-center gap-3">
              <Pill tone={verdictTone(r.verdict)}>{BOOTSTRAP_VERDICT_LABEL[r.verdict]}</Pill>
              <span className="mono truncate">{r.namespace}</span>
              {r.system && <span className="text-[12px] uppercase text-muted">system</span>}
            </span>
            <span className="mono shrink-0 text-[13px] text-muted">
              {bootstrapSummary(r.checks)} · {r.findings} findings · {r.warnings} warnings
            </span>
          </button>
          {open === r.namespace && (
            <div className="border-t border-line px-5 py-3">
              {r.checks.map(c => (
                <div key={c.id} className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-b-0">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex min-w-0 items-baseline gap-2.5">
                      <Pill tone={checkTone(c.status)}>{CHECK_LABEL[c.status]}</Pill>
                      {/* PSA is renamed here: `PSA baseline` claims a workload verdict the
                          collector never evaluates — it reads one label. */}
                      <span className="text-[14px]">{bootstrapCheckName(c.id, c.name)}</span>
                    </span>
                    {bootstrapCheckNote(c.id) && (
                      <span className="text-[12px] text-muted">{bootstrapCheckNote(c.id)}</span>
                    )}
                  </span>
                  <span className="min-w-0 text-right">
                    {c.inspected && <div className="mono text-[12px] text-muted">{c.inspected}</div>}
                    {c.detail && <div className="text-[13px] text-muted">{c.detail}</div>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------ events

function EventsTab({ rows, status }: { rows: EventRow[]; status: MetricStatus }) {
  if (rows.length === 0) {
    return status.state === 'ok' ? (
      <Empty title="No warning events" hint="Nothing on this cluster has reported a warning recently." />
    ) : (
      <UnavailableEmptyBody status={status} />
    );
  }
  return (
    <Card
      title={
        <>
          Warning events (<Count status={status} value={rows.length} />)
        </>
      }
    >
      <ul className="divide-y divide-line">
        {rows.map((e, i) => (
          <li key={`${e.object}-${e.at}-${i}`} className="py-2.5">
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2">
                <Pill tone="warn">{e.reason}</Pill>
                <span className="mono truncate">{e.object ?? e.namespace}</span>
              </span>
              <span className="mono shrink-0 text-[13px] text-muted">
                ×{e.count} · {ago(e.at)}
              </span>
            </div>
            <p className="mt-1 text-[13px] text-muted">{e.message}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
