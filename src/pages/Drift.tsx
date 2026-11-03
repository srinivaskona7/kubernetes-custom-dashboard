/**
 * Drift — the page with the most assertions per pixel, and therefore the most to get wrong.
 *
 * Every headline here is a claim of sameness: "Control plane in parity", "All modules
 * uniform", "100% aligned". Each of those is computed from a comparison, and a comparison
 * over nothing compares equal. A fleet whose tokens have all expired therefore renders as
 * the most reassuring page in the console. Each claim is now gated on having actually read
 * the clusters it claims to have compared.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fleetApiUrl, type FleetDrift } from '../api';
import { DataTable, NUMERIC, type Column } from '../components/DataTable';
import { PageHeader } from '../components/layout';
import { useSection, type SubTab } from '../components/SubTabs';
import { useAsync } from '../useAsync';
import { Pill, ErrorBanner, Dot } from '../components/ui';
import type { Tone } from '../components/ui';
import {
  Count,
  MetricValue,
  Unavailable,
  UnavailableEmptyBody,
  UnavailableNotice,
  unavailableScope
} from '../components/unavailable';
import { bytes, cores } from '../format';
import type { PageProps } from '../App';

type TabView = 'modules' | 'kubernetes' | 'workloads';

/**
 * The three views, as data, so the URL reader can validate `?section=` against them.
 *
 * This strip was the only one of the sixteen in the product still held in `useState`. That made
 * it the only one where a link an operator copied out of the address bar always reopened on
 * Modules, however deep into Workload Image Drift they were when they copied it — and this page
 * exists to be shared, since its whole subject is a discrepancy someone else has to look at.
 *
 * It uses the shared `?section=` key rather than a private one for the same reason every cluster
 * tab does: `useSection` falls back to its own default whenever the current value is not one of
 * its own ids, so arriving here carrying `?section=mesh` from somewhere else lands on Modules
 * rather than on a blank page.
 */
const DRIFT_VIEWS: readonly SubTab<TabView>[] = [
  { id: 'modules', label: 'Kyma Core Modules' },
  { id: 'kubernetes', label: 'Kubernetes & Node Parity' },
  { id: 'workloads', label: 'Workload Image Drift' }
];

/**
 * `moduleParity[].clusterStatus[id].status` used to be a fixed enum
 * ('active'|'degraded'|'missing'|'unknown') guessed from Deployment name substrings. Wave 2
 * rewired it to `modules.js`'s own Kyma CR read (B1), so `status` is now either 'missing'
 * (module not requested/reconciled on this cluster), 'unknown' (the cluster's Kyma CR list
 * itself could not be read), or the real `status.modules[].state` string the Kyma operator
 * wrote — 'Ready', 'Warning', 'Error', 'Processing', 'Deleting', and whatever else the
 * operator emits. This maps that open-ended state to the validated palette's tone rather
 * than pretending it is still a closed enum.
 */
function moduleTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === 'ready') return 'ok';
  if (s === 'error') return 'bad';
  if (s === 'warning' || s === 'processing' || s === 'deleting') return 'warn';
  return 'unknown';
}

export default function Drift({ onRefreshed }: PageProps) {
  const { data, loading, error, reload } = useAsync<FleetDrift>(useCallback(() => api.drift(), []));
  const [activeTab, setActiveTab] = useSection<TabView>(DRIFT_VIEWS, 'modules');
  const [search, setSearch] = useState('');
  const [driftOnly, setDriftOnly] = useState(false);

  useEffect(() => {
    if (data) onRefreshed(data.collectedAt || new Date().toISOString());
  }, [data, onRefreshed]);

  const handleDownloadReport = () => {
    window.open(fleetApiUrl('/report'), '_blank');
  };

  const clusters = data?.clusterParity || [];
  const modules = data?.moduleParity || [];
  const workloads = data?.items || [];

  const filteredWorkloads = workloads.filter(item => {
    const matchesSearch =
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.namespace.toLowerCase().includes(search.toLowerCase());
    const matchesDrift = driftOnly ? item.isDrifted : true;
    return matchesSearch && matchesDrift;
  });

  const k8sPrimaryVersion = data?.summary.k8sVersions?.[0] || '—';

  /**
   * `clusterParity` is built from the registry, so an unreachable cluster still gets a row —
   * with zeroed capacity and a blank version. That row is the honest part; the summary cards
   * above it, which fold those zeros into a fleet-wide verdict, are not.
   */
  const scope = useMemo(
    () => unavailableScope({ summary: data?.summary, clusters: data?.clusterParity }),
    [data?.summary, data?.clusterParity]
  );
  const parityStatus = scope.of('cluster versions', 'nodes', 'version');
  // The labels the module collector actually emits — `kymas` and `modulereleasemetas`
  // (modules.js:34-35) — not just the generic 'modules'. Naming only the generic one meant a
  // refused `modulereleasemetas` left this status at 'ok', and the card below then rendered a
  // green "All modules uniform" over an empty comparison table. A read that never happened
  // cannot certify parity.
  const moduleStatus = scope.of(
    'Kyma module parity',
    'modules',
    'kymas',
    'modulereleasemetas',
    'kyma modules',
    'deployments'
  );
  const imageStatus = scope.of('workload images', 'workloads', 'deployments');

  /** Why one row has no numbers: its own reachability, said on the row itself. */
  const rowWhy = (what: string) => `could not read ${what} — this cluster did not answer`;

  /*
    The three matrices are `DataTable`s. The module matrix is the interesting one: its columns are
    the fleet, so the array is built from `clusters` and grows with the registry — which is exactly
    why it has to come from one column definition applied to the `th` and the `td` together. The
    hand-written version declared `min-w-[180px]` on the header only, and the body cell below it
    was sized by whatever the longest module state happened to be.

    Cluster columns state `align: 'left'` rather than letting the classifier read the header: that
    header is a cluster's display name, and a fleet with a cluster called `prod-metrics-01` would
    otherwise have one column right-aligned because its name contains a word the classifier knows.
  */
  const moduleColumns: Column<(typeof modules)[number]>[] = [
    {
      key: 'module',
      header: 'Module Component',
      pin: true,
      max: '260px',
      sortValue: mod => mod.module,
      render: mod => (
        <div>
          <div className="font-medium text-text">{mod.module}</div>
          <div className="text-[12px] text-muted">
            {mod.module.includes('Istio') && 'istio-system · Service mesh & ingress gateway'}
            {mod.module.includes('Telemetry') && 'kyma-system · OpenTelemetry collectors & logging'}
            {mod.module.includes('Serverless') && 'kyma-system · Knative & Kubeless serverless functions'}
            {mod.module.includes('Keda') && 'kyma-system · Event-driven auto-scaler & metrics'}
            {mod.module.includes('Eventing') && 'kyma-system · NATS JetStream event broker'}
            {mod.module.includes('BTP') && 'kyma-system · SAP BTP Service Manager binding operator'}
          </div>
        </div>
      )
    },
    {
      key: 'parity',
      header: 'Fleet Parity',
      // Drift first: the row worth reading is the one that disagrees with itself.
      sortValue: mod => (mod.isDrifted ? 0 : 1),
      render: mod => <Pill tone={mod.isDrifted ? 'warn' : 'ok'}>{mod.isDrifted ? 'Drift Detected' : 'Aligned'}</Pill>
    },
    ...clusters.map<Column<(typeof modules)[number]>>(c => ({
      key: `cluster:${c.id}`,
      align: 'left',
      min: '180px',
      header: (
        <>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-text">{c.displayName || c.id}</span>
            <span className="mono rounded border border-line bg-raised px-1 py-0.2 text-[10px] font-bold uppercase text-muted">
              {c.env}
            </span>
          </div>
          <div className="mono text-[11px] font-normal lowercase text-muted">{c.id}</div>
        </>
      ),
      sortValue: mod => mod.clusterStatus[c.id]?.status ?? 'unknown',
      render: mod => {
        const st = mod.clusterStatus[c.id] || { status: 'unknown', installed: false };
        // `status` is no longer a closed enum (see moduleTone doc above) — 'missing' (module not
        // present on this cluster) and 'unknown' (this cluster's Kyma CR read itself failed) are
        // the two states with no version to show; everything else is the operator's own `state`
        // string, rendered with a dot in the matching tone.
        if (st.status === 'missing' || st.status === 'unknown') {
          return (
            <div className="flex items-center gap-1.5 text-muted">
              <Dot tone="unknown" />
              <span className="text-[13px]">{st.status === 'missing' ? 'Not installed' : 'Unreachable'}</span>
            </div>
          );
        }
        return (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Dot tone={moduleTone(st.status)} />
              <span className={`text-[13px] font-medium text-${moduleTone(st.status)}`}>{st.status}</span>
            </div>
            {st.version && (
              <span className="mono max-w-[150px] truncate text-[11px] text-muted" title={st.version}>
                tag: {st.version}
              </span>
            )}
          </div>
        );
      }
    }))
  ];

  const parityColumns: Column<(typeof clusters)[number]>[] = [
    {
      key: 'cluster',
      header: 'Cluster',
      pin: true,
      max: '220px',
      sortValue: cp => cp.displayName || cp.id,
      render: cp => (
        <div>
          <div className="font-semibold text-text">{cp.displayName || cp.id}</div>
          <div className="mono text-[12px] text-muted">{cp.id}</div>
        </div>
      )
    },
    {
      key: 'env',
      header: 'Environment',
      sortValue: cp => cp.env,
      render: cp => (
        <span className="mono rounded border border-line bg-raised px-1.5 py-0.5 text-[11px] font-bold uppercase text-muted">
          {cp.env}
        </span>
      )
    },
    {
      key: 'reach',
      header: 'Reachability',
      // Unreachable first, then not-read-yet, then connected: `null` is waiting, not failed, so it
      // sorts between the two rather than with either.
      sortValue: cp => (cp.ok === false ? 0 : cp.ok === null ? 1 : 2),
      render: cp => (
        <Pill tone={cp.ok === true ? 'ok' : cp.ok === false ? 'bad' : 'unknown'}>
          {cp.ok === true ? 'Connected' : cp.ok === false ? 'Unreachable' : 'Not read yet'}
        </Pill>
      )
    },
    {
      key: 'version',
      header: 'Kubernetes Version',
      sortValue: cp => (cp.ok ? cp.version : null),
      render: cp =>
        cp.ok ? (
          <span className={`mono text-[14px] font-semibold ${cp.isDrifted ? 'text-warn' : 'text-text'}`}>
            {cp.version}
          </span>
        ) : (
          <Unavailable what="Kubernetes version" why={rowWhy('the version')} size="sm" variant="dash" />
        )
    },
    {
      key: 'nodes',
      header: 'Node Health',
      // The shortfall, not the ratio: 9 of 10 ready is one node down and 90 of 100 is ten.
      sortValue: cp => (cp.ok ? cp.nodesReady - cp.nodesTotal : null),
      render: cp =>
        cp.ok ? (
          <span className="mono">
            {cp.nodesReady}/{cp.nodesTotal} ready
          </span>
        ) : (
          <Unavailable what="node health" why={rowWhy('the node list')} size="sm" variant="dash" />
        )
    },
    {
      key: 'cpu',
      header: 'Allocatable CPU',
      ...NUMERIC,
      sortValue: cp => (cp.ok ? cp.cpuAllocatable : null),
      render: cp =>
        cp.ok ? (
          <span className="mono text-muted">{cores(cp.cpuAllocatable)} cores</span>
        ) : (
          <Unavailable what="allocatable CPU" why={rowWhy('node capacity')} size="sm" variant="dash" />
        )
    },
    {
      key: 'mem',
      header: 'Allocatable Memory',
      ...NUMERIC,
      sortValue: cp => (cp.ok ? cp.memoryAllocatable : null),
      render: cp =>
        cp.ok ? (
          <span className="mono text-muted">{bytes(cp.memoryAllocatable)}</span>
        ) : (
          <Unavailable what="allocatable memory" why={rowWhy('node capacity')} size="sm" variant="dash" />
        )
    },
    {
      // Left, like every other status column on this console. It was right-aligned here alone,
      // which put the one word an operator scans for at a different edge from the rest of them.
      key: 'parity',
      header: 'Parity Status',
      sortValue: cp => (cp.ok === false || cp.ok === null ? 0 : cp.isDrifted ? 1 : 2),
      render: cp =>
        // "Baseline" on a cluster we never read is an unearned pass.
        cp.ok ? (
          <Pill tone={cp.isDrifted ? 'warn' : 'ok'}>{cp.isDrifted ? 'Version Divergence' : 'Baseline'}</Pill>
        ) : (
          <Pill tone="unknown">Not compared</Pill>
        )
    }
  ];

  const workloadColumns: Column<(typeof workloads)[number]>[] = [
    {
      key: 'workload',
      header: 'Workload',
      pin: true,
      max: '240px',
      sortValue: item => item.name,
      render: item => (
        <div className="font-medium text-text">
          <div>{item.name}</div>
          <span className="mono text-[11px] font-normal uppercase text-muted">{item.kind}</span>
        </div>
      )
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '180px',
      sortValue: item => item.namespace,
      render: item => <span className="mono text-muted">{item.namespace}</span>
    },
    {
      key: 'parity',
      header: 'Parity Status',
      sortValue: item => (item.isDrifted ? 0 : 1),
      render: item => <Pill tone={item.isDrifted ? 'warn' : 'ok'}>{item.isDrifted ? 'Version Drift' : 'In Parity'}</Pill>
    },
    {
      key: 'images',
      // `Container image per cluster`, not `... Images & Replicas`: `replicas` is a count everywhere
      // else on this console, so the classifier read the old header as a quantity and would have
      // right-aligned a column of image names. The ready counter is still in the cell; it is not
      // what the column is for.
      header: 'Container image per cluster',
      /*
        The ceiling, and why it is on the column rather than only inside the cell.

        This cell is a stack: one line per cluster, each `cluster (env): image (n/m ready)`. Every
        line was already bounded on its own — `w-24` on the cluster, `max-w-lg` on the image — which
        reads as bounded and is not: 96 + 512 + the ready counter put the column near 740px, and a
        `truncate` inside a `.tbl` cell with no `max` on the column is inert, because the column
        grows to its longest row regardless. The image span is now capped at 260px, so a line lands
        under 500px, and the column states the ceiling that actually holds it.
      */
      max: '520px',
      align: 'left',
      sortValue: item => Object.keys(item.clusterVersions).length,
      render: item => (
        <div className="space-y-1.5">
          {Object.entries(item.clusterVersions).map(([clusterId, ver]) => (
            <div key={clusterId} className="flex items-center gap-2 text-[13px]">
              <span className="mono w-24 truncate text-[11px] font-bold uppercase text-muted">
                {clusterId} ({ver.env}):
              </span>
              <span
                className={`mono max-w-[260px] truncate rounded border px-1.5 py-0.5 text-[12px] ${
                  item.isDrifted ? 'border-warn/30 bg-warn/10 text-warn' : 'border-line bg-raised text-text'
                }`}
                title={ver.image || '—'}
              >
                {ver.image || '—'}
              </span>
              <span className="mono shrink-0 text-[12px] text-muted">
                ({ver.ready}/{ver.replicas} ready)
              </span>
            </div>
          ))}
        </div>
      )
    }
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg">
      <PageHeader
        title="Cross-Cluster Drift & Parity Matrix"
        icon="drift"
        info="Compares every onboarded cluster on Kubernetes version, Kyma module channels and workload container image tags. It reports differences, not a target \u2014 the console has no notion of which cluster is correct."
        subtitle="Multi-cluster audit of Kubernetes control plane versions, Kyma core modules, and workload container images"
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadReport}
              className="rounded-[6px] border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-white shadow-sm hover:opacity-90 transition-opacity cursor-pointer"
            >
              Export Fleet Report (.md)
            </button>
            <button
              type="button"
              onClick={() => reload()}
              disabled={loading}
              className="rounded-[6px] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-text hover:bg-raised disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        }
      />

      {/*
       * Gate on `data` being present, not merely on the absence of an error: a page-level
       * fetch failure with no prior successful load must never let the summary cards or the
       * matrix render at all, because every fallback below (`data?.moduleParity || []`, etc.)
       * turns "we never asked" into an empty array — and an empty array reads as a confident
       * zero, indistinguishable from a genuinely drift-free fleet. `useAsync` keeps the last
       * good `data` across a failed refetch, so this only ever hides the page on the very
       * first load failing — a stale-but-real render is still preferred over a fresh blank.
       */}
      {!data ? (
        <div className="flex flex-1 items-center justify-center p-10">
          {error ? (
            <ErrorBanner code={error.code} message={error.message} />
          ) : (
            <span className="text-[14px] text-muted">Loading drift data…</span>
          )}
        </div>
      ) : (
        <>
      {/* Summary Stat Cards */}
      <div className="grid grid-cols-2 gap-4 page-x pb-4 lg:grid-cols-4">
        {/* K8s Version Parity Card */}
        <div className="rounded-[8px] border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted">K8s Control Plane</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <MetricValue status={parityStatus} size="md" className="mono text-[20px] font-semibold text-text truncate">
              {data?.summary.hasK8sDrift ? 'Version Drift' : k8sPrimaryVersion}
            </MetricValue>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {/* "In parity" over an unread fleet is a claim about clusters nobody asked. */}
            {parityStatus.state === 'unavailable' ? (
              <Pill tone="unknown">Parity not established</Pill>
            ) : data?.summary.hasK8sDrift ? (
              <Pill tone="warn">{data.summary.k8sVersions.length} versions across fleet</Pill>
            ) : parityStatus.state === 'partial' ? (
              <Pill tone="unknown">In parity across the {parityStatus.total - parityStatus.blind} we could read</Pill>
            ) : (
              <Pill tone="ok">Control plane in parity</Pill>
            )}
          </div>
        </div>

        {/* Kyma Core Modules Card */}
        <div className="rounded-[8px] border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted">Kyma Core Modules</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <MetricValue status={moduleStatus} size="md" className="text-[20px] font-semibold text-text">
              {modules.length > 0
                ? `${modules.filter(m => !m.isDrifted).length}/${modules.length} Aligned`
                : '—'}
            </MetricValue>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {moduleStatus.state === 'unavailable' ? (
              <Pill tone="unknown">Modules not compared</Pill>
            ) : modules.length === 0 ? (
              // Zero modules to compare is never a passing parity check. The status may read
              // 'ok' — every list the scope names came back — and the comparison still be
              // empty, so this branch has to sit ahead of the green one.
              <Pill tone="unknown">Nothing to compare</Pill>
            ) : data?.summary.driftedModulesCount && data.summary.driftedModulesCount > 0 ? (
              <Pill tone="warn">{data.summary.driftedModulesCount} module drift</Pill>
            ) : moduleStatus.state === 'partial' ? (
              <Pill tone="unknown">Uniform across the {moduleStatus.total - moduleStatus.blind} we could read</Pill>
            ) : (
              <Pill tone="ok">All modules uniform</Pill>
            )}
          </div>
        </div>

        {/* Workload Image Parity Card */}
        <div className="rounded-[8px] border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted">Workload Images</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <MetricValue
              status={imageStatus}
              size="md"
              className={`text-[20px] font-semibold ${data?.summary.driftedWorkloadsCount ? 'text-warn' : 'text-ok'}`}
            >
              {data?.summary.driftedWorkloadsCount ?? 0} Drifted
            </MetricValue>
            {imageStatus.state !== 'unavailable' && (
              <span className="text-[13px] text-muted">/ {data?.summary.totalWorkloadsCompared ?? 0} total</span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {/* The old fallback said "100% aligned" when nothing had been compared at all. */}
            {imageStatus.state === 'unavailable' || !data?.summary.totalWorkloadsCompared ? (
              <Pill tone="unknown">
                {imageStatus.state === 'unavailable' ? 'Images not compared' : 'Nothing to compare'}
              </Pill>
            ) : (
              <Pill tone={data.summary.driftedWorkloadsCount ? 'warn' : 'ok'}>
                {Math.round(
                  ((data.summary.totalWorkloadsCompared - data.summary.driftedWorkloadsCount) /
                    data.summary.totalWorkloadsCompared) *
                    100
                )}
                % release parity
                {imageStatus.state === 'partial' ? ` (${imageStatus.total - imageStatus.blind} of ${imageStatus.total} clusters)` : ''}
              </Pill>
            )}
          </div>
        </div>

        {/* Fleet Reachability Card */}
        <div className="rounded-[8px] border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted">Fleet Reachability</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[20px] font-semibold text-text">
              {clusters.filter(c => c.ok === true).length} / {clusters.length}
            </span>
            <span className="text-[13px] text-muted">clusters active</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {/* `=== false`, so a cluster added seconds ago and not yet read is not announced as
                offline. `null` is its own state: waiting, not failed. */}
            <Pill tone={clusters.some(c => c.ok === false) ? 'bad' : clusters.some(c => c.ok === null) ? 'unknown' : 'ok'}>
              {clusters.some(c => c.ok === false)
                ? 'Some clusters offline'
                : clusters.some(c => c.ok === null)
                  ? 'Some clusters not read yet'
                  : 'All endpoints healthy'}
            </Pill>
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex items-center justify-between border-b border-line page-x bg-surface/40">
        {/* A real tablist, matching the other fifteen strips in the product. The buttons carried
            colour alone before, so the active view was unannounced to a screen reader. */}
        <div role="tablist" className="flex gap-1 py-2">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'modules'}
            onClick={() => setActiveTab('modules')}
            className={`flex items-center gap-2 rounded-[6px] px-3.5 py-1.5 text-[14px] font-medium transition-colors cursor-pointer ${
              activeTab === 'modules'
                ? 'bg-accent text-white shadow-sm'
                : 'text-muted hover:bg-raised hover:text-text'
            }`}
          >
            <span>Kyma Core Modules</span>
            {data?.summary.driftedModulesCount && data.summary.driftedModulesCount > 0 ? (
              <span className="rounded-full bg-warn/20 px-1.5 py-0.2 text-[11px] font-bold text-warn">
                {data.summary.driftedModulesCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'kubernetes'}
            onClick={() => setActiveTab('kubernetes')}
            className={`flex items-center gap-2 rounded-[6px] px-3.5 py-1.5 text-[14px] font-medium transition-colors cursor-pointer ${
              activeTab === 'kubernetes'
                ? 'bg-accent text-white shadow-sm'
                : 'text-muted hover:bg-raised hover:text-text'
            }`}
          >
            <span>Kubernetes & Node Parity</span>
            {data?.summary.hasK8sDrift ? (
              <span className="rounded-full bg-warn/20 px-1.5 py-0.2 text-[11px] font-bold text-warn">
                Drift
              </span>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'workloads'}
            onClick={() => setActiveTab('workloads')}
            className={`flex items-center gap-2 rounded-[6px] px-3.5 py-1.5 text-[14px] font-medium transition-colors cursor-pointer ${
              activeTab === 'workloads'
                ? 'bg-accent text-white shadow-sm'
                : 'text-muted hover:bg-raised hover:text-text'
            }`}
          >
            <span>Workload Image Drift</span>
            {data?.summary.driftedWorkloadsCount && data.summary.driftedWorkloadsCount > 0 ? (
              <span className="rounded-full bg-warn/20 px-1.5 py-0.2 text-[11px] font-bold text-warn">
                {data.summary.driftedWorkloadsCount}
              </span>
            ) : null}
          </button>
        </div>

        {/* Tab-specific toolbar action */}
        {activeTab === 'workloads' && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[13px] text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={driftOnly}
                onChange={e => setDriftOnly(e.target.checked)}
                className="rounded border-line bg-raised accent-accent cursor-pointer"
              />
              <span>Drifted only</span>
            </label>
            <input
              type="text"
              placeholder="Filter workload or namespace…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-64 rounded-[6px] border border-line bg-raised px-3 py-1 text-[13px] text-text placeholder-muted focus:border-accent focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <UnavailableNotice scope={scope} className="-mx-6 -mt-6" />

        {error && (
          <ErrorBanner code={error.code} message={error.message} />
        )}

        {/* ================= VIEW 1: KYMA CORE MODULES MATRIX ================= */}
        {activeTab === 'modules' && (
          <div className="space-y-4">
            <div className="rounded-[8px] border border-line bg-surface overflow-hidden shadow-sm">
              <div className="panel-head py-3.5 bg-raised/20 flex items-center justify-between">
                <div>
                  <h3 className="text-[15px] font-semibold text-text">Kyma Core Module Distribution</h3>
                  <p className="text-[13px] text-muted">
                    Side-by-side status of essential Kyma runtime components across all target clusters
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-[12px] text-muted">
                    <Dot tone="ok" /> Ready
                  </span>
                  <span className="flex items-center gap-1 text-[12px] text-muted">
                    <Dot tone="warn" /> Warning / Processing
                  </span>
                  <span className="flex items-center gap-1 text-[12px] text-muted">
                    <Dot tone="bad" /> Error
                  </span>
                  <span className="flex items-center gap-1 text-[12px] text-muted">
                    <Dot tone="unknown" /> Not Installed / Unreachable
                  </span>
                </div>
              </div>

              <div className="card-body-flush">
                <DataTable
                  id="drift.modules"
                  columns={moduleColumns}
                  rows={modules}
                  rowKey={mod => mod.module}
                  // Two fixed columns plus one per cluster, so the widest tier — and the module
                  // name stays pinned while the fleet scrolls past it.
                  shed="wide"
                  empty={
                    moduleStatus.state === 'ok' ? (
                      'No module parity data collected yet'
                    ) : (
                      <UnavailableEmptyBody status={moduleStatus} />
                    )
                  }
                />
              </div>
            </div>

            {/* Architecture Guidelines */}
            <div className="rounded-[8px] border border-line bg-surface p-4 text-[13px] text-muted space-y-2">
              <div className="font-semibold text-text flex items-center gap-1.5">
                <span>Kyma Module Lifecycle & Governance</span>
              </div>
              <p>
                Core modules can be dynamically enabled or customized per cluster via Kyma custom resources in{' '}
                <code className="mono rounded bg-raised px-1 py-0.5 text-text">kyma-system</code>. Modules marked with{' '}
                <span className="text-warn font-medium">Drift Detected</span> indicate discrepancies where workloads
                on one cluster rely on extensions that are missing or running in degraded states on other clusters.
              </p>
            </div>
          </div>
        )}

        {/* ================= VIEW 2: KUBERNETES & NODE PARITY ================= */}
        {activeTab === 'kubernetes' && (
          <div className="space-y-4">
            <div className="rounded-[8px] border border-line bg-surface overflow-hidden shadow-sm">
              <div className="panel-head py-3.5 bg-raised/20">
                <h3 className="text-[15px] font-semibold text-text">Kubernetes Control Plane & Infrastructure Parity</h3>
                <p className="text-[13px] text-muted">
                  Comparison of Kubernetes control plane release channels, worker node allocations, and schedulable
                  capacity — allocatable, so these figures match each cluster's own detail page
                </p>
              </div>

              <div className="card-body-flush">
                <DataTable
                  id="drift.parity"
                  columns={parityColumns}
                  rows={clusters}
                  rowKey={cp => cp.id}
                  shed="mid"
                  empty="No cluster parity data available"
                />
              </div>
            </div>

            {data?.summary.hasK8sDrift && (
              <div className="rounded-[8px] border border-warn/30 bg-warn/10 p-4 text-[13px] text-warn flex items-start gap-3">
                {/* A dot, not the warning-sign emoji that was here. The glyph was the only non-colour signal
                    on this banner, so it could not simply be deleted — status is never colour
                    alone in this console, and a decorative emoji is not a status indicator either. */}
                <span className="pt-1">
                  <Dot tone="warn" />
                </span>
                <div>
                  <div className="font-semibold">Kubernetes Version Mismatch Detected</div>
                  <p className="mt-0.5 text-warn/80">
                    Different clusters in your fleet are operating on disparate Kubernetes control plane versions ({data.summary.k8sVersions.join(', ')}).
                    Ensure workload deployment manifests and APIs used are compatible with the lowest common Kubernetes version.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================= VIEW 3: WORKLOAD IMAGE DRIFT ================= */}
        {activeTab === 'workloads' && (
          <div className="space-y-4">
            <div className="rounded-[8px] border border-line bg-surface overflow-hidden shadow-sm">
              <div className="panel-head py-3.5 bg-raised/20 flex items-center justify-between">
                <div>
                  <h3 className="text-[15px] font-semibold text-text">Workload Container Image Parity</h3>
                  <p className="text-[13px] text-muted">
                    Deployment image tags and replica availability compared across dev, sbx, and uat environments
                  </p>
                </div>
                <div className="mono text-[13px] text-muted">
                  Showing <Count status={imageStatus} value={filteredWorkloads.length} /> of{' '}
                  <Count status={imageStatus} value={workloads.length} /> workloads
                </div>
              </div>

              <div className="card-body-flush">
                <DataTable
                  id="drift.workloads"
                  columns={workloadColumns}
                  rows={filteredWorkloads}
                  rowKey={item => `${item.kind}/${item.namespace}/${item.name}`}
                  empty={
                    imageStatus.state === 'ok' ? (
                      'No matching workload drift records found'
                    ) : (
                      <UnavailableEmptyBody status={imageStatus} />
                    )
                  }
                />
              </div>
            </div>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}
