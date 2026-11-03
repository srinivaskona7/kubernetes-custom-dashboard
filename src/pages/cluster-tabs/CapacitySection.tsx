/**
 * Headroom & scheduling (D1–D5) — the capacity half of the old Topology tab.
 *
 * Lives beside NodesTab rather than inside it because it is fed by a *different* collector
 * (`/clusters/:id/capacity`) than the node table above it (`/overview`). Keeping it a separate
 * component keeps the two failure modes separate too: a refused capacity read must leave the
 * node table intact, and vice versa — which is exactly what the old two-scope Topology tab did
 * and what would have been lost by inlining these cards into NodesTab's own render.
 */
import { useCallback, useMemo } from 'react';
import { api } from '../../api';
import { Empty, ErrorState, Pill, Skeleton } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Count,
  MetricValue,
  NotInstalled,
  StatTile,
  UnavailableEmptyBody,
  UnavailableNotice,
  envelopeScope,
  unavailableScope
} from '../../components/unavailable';
import { bytes, cores, percent } from '../../format';
import { useAsync } from '../../useAsync';

export default function CapacitySection({ id }: { id: string }): JSX.Element {
  const cap = useAsync(useCallback(() => api.clusterCapacity(id), [id]), 0, id);
  const c = cap.data?.ok ? cap.data.data : null;

  /**
   * `capacity.js` publishes its `unavailable`/`truncated` labels under `summary`, not at the
   * top level. This read them off the payload root, which silently produced an always-empty
   * scope: a refused `nodes` or `pods` list rendered every tile below as a confident 0 — the
   * exact defect `unavailable.tsx` exists to prevent, arrived at by looking one key too high.
   */
  const capScope = useMemo(() => (c ? envelopeScope(id, c.summary) : unavailableScope({})), [c, id]);
  const nodeStatus = capScope.of('node capacity', 'nodes');
  const podStatus = capScope.of('pod capacity', 'pods');

  const metricsVerdict: 'ok' | 'backend-down' | 'not-installed' | 'forbidden' | 'unknown' = !c?.metricsServer
    ? 'unknown'
    : c.metricsServer.installed && c.metricsServer.reporting
      ? 'ok'
      : c.metricsServer.installed && !c.metricsServer.reporting
        ? 'backend-down'
        : c.metricsServer.installed === false
          ? 'not-installed'
          : 'forbidden';

  const nodeRows = useMemo(
    () => [...(c?.overcommit.nodes ?? [])].sort((a, b) => (b.cpuRequestedPercent || 0) - (a.cpuRequestedPercent || 0)).slice(0, 8),
    [c]
  );
  const nsRows = useMemo(
    () => [...(c?.overcommit.namespaces ?? [])].sort((a, b) => b.totalCpuLimit - a.totalCpuLimit).slice(0, 8),
    [c]
  );
  const pendingItems = (c?.pending.items ?? []).slice(0, 20);

  /**
   * The unschedulable-pod columns.
   *
   * The `cap-*` classes this table used to carry were the same ceilings `Column.max` states —
   * `cap-sm` 140, `cap-md` 200, `cap-lg` 260 — so they map across one for one, and stating them on
   * the column means the header and the cell can no longer be given different ones. The per-cell
   * `title` attributes are gone for the same reason: a capped `DataTable` cell derives its tooltip
   * from what it renders, which cannot drift from what is on screen.
   */
  const pendingColumns: Column<(typeof pendingItems)[number]>[] = [
    {
      key: 'pod',
      header: 'Pod',
      pin: true,
      max: '200px',
      sortValue: p => p.name,
      render: p => <span className="font-mono text-[13px] text-text">{p.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: p => p.namespace,
      render: p => <span className="text-muted">{p.namespace}</span>
    },
    {
      key: 'reason',
      header: 'Reason',
      sortValue: p => p.reason,
      render: p => <Pill tone="warn">{p.reason}</Pill>
    },
    {
      key: 'message',
      header: 'Message',
      max: '260px',
      render: p => <span className="text-[12px] text-muted">{p.message || '—'}</span>
    }
  ];

  return (
    <div className="space-y-3 border-t border-line pt-5">
      <h2 className="text-[15px] font-semibold uppercase tracking-wider text-text">Headroom &amp; Scheduling</h2>
      {/* The heading promises headroom, and this section reports scheduling *pressure* rather than a
          pod-slot total — the slot bar lives on Nodes, over Ready and uncordoned nodes only. Said
          here so the two screens cannot be read as two answers to the same question, and because
          `Pending Pods (unschedulable)` below is the only observed scheduling verdict on the page:
          a free slot elsewhere is a kubelet ceiling, not a placement. */}
      <p className="text-[12px] text-muted">
        Scheduling pressure, not spare capacity. Pod-slot capacity is on Nodes → Overview, counted over Ready,
        uncordoned nodes; a free slot there is not a placement guarantee (taints, affinity and CPU/memory fit
        also apply). Pending Pods below is the scheduler&apos;s own verdict.
      </p>

      {!cap.data && cap.error && <ErrorState code={cap.error.code} message={cap.error.message} />}
      {cap.initial && <Skeleton rows={6} />}

      <UnavailableNotice scope={capScope} />

      {c && (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatTile
              label="Unbounded Containers (no CPU or memory limit)"
              status={podStatus}
              value={<Count status={podStatus} value={c.unboundedContainers.noEitherLimit} size="lg" />}
              caption={`of ${c.unboundedContainers.totalEffectiveContainers} effective containers`}
              valueClass={c.unboundedContainers.noEitherLimit ? 'text-warn' : 'text-text'}
            />
            <StatTile
              label="Pending Pods (unschedulable)"
              status={podStatus}
              value={<Count status={podStatus} value={c.pending.count} size="lg" />}
              caption="stuck on PodScheduled=False"
              valueClass={c.pending.count ? 'text-bad' : 'text-text'}
            />
            <StatTile
              label="Nodes with Problem Conditions"
              status={nodeStatus}
              value={<Count status={nodeStatus} value={c.nodesWithProblems} size="lg" />}
              caption="including NotReady"
              valueClass={c.nodesWithProblems ? 'text-warn' : 'text-text'}
            />
            <div className="rounded-[8px] border border-line bg-surface p-4">
              <div className="text-[13px] text-muted">Metrics Server</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-2">
                {metricsVerdict === 'not-installed' ? (
                  <NotInstalled what="metrics-server" size="lg" />
                ) : metricsVerdict === 'unknown' ? (
                  <span className="mono text-[22px] text-muted">—</span>
                ) : (
                  <Pill tone={metricsVerdict === 'ok' ? 'ok' : metricsVerdict === 'backend-down' ? 'bad' : 'warn'}>
                    {metricsVerdict === 'ok' ? 'Reporting' : metricsVerdict === 'backend-down' ? 'Backend Down' : 'RBAC Forbidden'}
                  </Pill>
                )}
              </div>
              <div className="mt-1 text-[12px] text-muted">
                {metricsVerdict === 'forbidden'
                  ? 'the probe itself was refused — installed or not is unknown'
                  : metricsVerdict === 'backend-down'
                    ? 'the API is registered but returning 503; live usage is stale'
                    : 'live CPU/memory usage, as opposed to requests'}
              </div>
            </div>
          </div>

          {/*
            The three unbounded-limit facts, as one strip rather than three more tiles: they are
            one question — "can this cluster's declared limits be trusted, and by how much" —
            and each half is meaningless without the others.

            The `noCpuLimit` / `noMemoryLimit` split matters because `noEitherLimit` above is
            their *intersection*, not their union: a cluster where every container caps memory
            but none caps CPU shows `noEitherLimit: 0`, which reads as fully bounded and is not.
            `limitSumIsFloor` is the same trap one level up — an unlimited container contributes
            0 to the limit sum it can in fact exceed without bound, so the totals below are a
            lower bound whenever it is set. Printing them without it is the more dangerous of
            the two numbers, which is why the marker sits on the sums themselves.
          */}
          <div className="rounded-[8px] border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <div className="text-[13px] text-muted">Declared limits &amp; what is missing them</div>
              {c.overcommit.limitSumIsFloor && (
                <span
                  className="border-b border-dotted border-muted/60 pb-px text-[12px] text-muted"
                  tabIndex={0}
                  title="At least one container declares no limit. An unlimited container contributes 0 to these sums while being able to exceed them without bound, so both totals are a floor."
                >
                  sums are a floor — some containers are unlimited
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
              <div>
                <div className="text-[12px] text-muted">CPU limit sum</div>
                <div className="mono text-[16px] text-text">
                  <MetricValue status={podStatus} size="md">
                    {cores(c.overcommit.totalCpuLimit)}
                    {c.overcommit.limitSumIsFloor ? '+' : ''}
                  </MetricValue>
                </div>
                <div className="text-[12px] text-muted">
                  {c.overcommit.totalCpuLimit > 0
                    ? `${percent(Math.round(c.overcommit.sidecarCpuLimitShare * 100))} of it is Istio sidecars`
                    : 'no container on this cluster declares a CPU limit'}
                </div>
              </div>
              <div>
                <div className="text-[12px] text-muted">Memory limit sum</div>
                <div className="mono text-[16px] text-text">
                  <MetricValue status={podStatus} size="md">
                    {bytes(c.overcommit.totalMemoryLimit)}
                    {c.overcommit.limitSumIsFloor ? '+' : ''}
                  </MetricValue>
                </div>
                <div className="text-[12px] text-muted">
                  {c.overcommit.totalMemoryLimit > 0
                    ? `${percent(Math.round(c.overcommit.sidecarMemoryLimitShare * 100))} of it is Istio sidecars`
                    : 'no container on this cluster declares a memory limit'}
                </div>
              </div>
              <div>
                <div className="text-[12px] text-muted">Containers with no CPU limit</div>
                <div
                  className={`mono text-[16px] ${c.unboundedContainers.noCpuLimit ? 'text-warn' : 'text-text'}`}
                >
                  <Count status={podStatus} value={c.unboundedContainers.noCpuLimit} size="md" />
                </div>
                <div className="text-[12px] text-muted">throttled by nothing but the node</div>
              </div>
              <div>
                <div className="text-[12px] text-muted">Containers with no memory limit</div>
                <div
                  className={`mono text-[16px] ${c.unboundedContainers.noMemoryLimit ? 'text-bad' : 'text-text'}`}
                >
                  <Count status={podStatus} value={c.unboundedContainers.noMemoryLimit} size="md" />
                </div>
                <div className="text-[12px] text-muted">an OOM here takes the node&apos;s other pods with it</div>
              </div>
            </div>
          </div>

          <div className="rounded-[8px] border border-line bg-surface p-4">
            <div className="mb-2 text-[13px] text-muted">Pod QoS Mix (of {c.qos.total} pods)</div>
            {c.qos.total === 0 ? (
              <div className="text-[13px] text-muted">No pods in scope</div>
            ) : (
              <div className="flex h-2 w-full overflow-hidden rounded-[2px] border border-line/40 bg-raised">
                {(['Guaranteed', 'Burstable', 'BestEffort'] as const).map(q => {
                  const n = c.qos.counts[q] || 0;
                  const w = (n / c.qos.total) * 100;
                  const tone = q === 'Guaranteed' ? 'bg-ok' : q === 'Burstable' ? 'bg-accent' : 'bg-warn';
                  return w > 0 ? <div key={q} className={`h-full ${tone}`} style={{ width: `${w}%` }} title={`${q}: ${n}`} /> : null;
                })}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-muted">
              {Object.entries(c.qos.counts).map(([q, n]) => (
                <span key={q} className="font-mono">
                  {q}: <span className="text-text">{n}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-[8px] border border-line bg-surface">
              <div className="panel-head py-2 text-[13px] font-semibold uppercase tracking-wider text-text">
                Hottest Nodes (CPU requested %)
              </div>
              <div className="divide-y divide-line/60">
                {nodeRows.length === 0 ? (
                  nodeStatus.state === 'ok' ? (
                    <div className="panel-x py-4 text-[13px] text-muted">No node data in scope</div>
                  ) : (
                    <UnavailableEmptyBody status={nodeStatus} />
                  )
                ) : (
                  nodeRows.map(n => (
                    <div key={n.name} className="flex items-center justify-between gap-3 panel-x py-2 text-[13px]">
                      <div className="min-w-0 truncate font-mono text-text" title={n.name}>
                        {n.name}
                      </div>
                      <div className="font-mono text-muted">{percent(n.cpuRequestedPercent)} cpu req</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-[8px] border border-line bg-surface">
              <div className="panel-head py-2 text-[13px] font-semibold uppercase tracking-wider text-text">
                Hottest Namespaces (CPU limit sum)
              </div>
              <div className="divide-y divide-line/60">
                {nsRows.length === 0 ? (
                  podStatus.state === 'ok' ? (
                    <div className="panel-x py-4 text-[13px] text-muted">No namespace data in scope</div>
                  ) : (
                    <UnavailableEmptyBody status={podStatus} />
                  )
                ) : (
                  nsRows.map(n => (
                    <div key={n.namespace} className="flex items-center justify-between gap-3 panel-x py-2 text-[13px]">
                      <div className="min-w-0 truncate font-mono text-text" title={n.namespace}>
                        {n.namespace}
                      </div>
                      <div className="font-mono text-muted">{cores(n.totalCpuLimit)} limit</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="rounded-[8px] border border-line bg-surface">
            <div className="panel-head py-2 text-[13px] font-semibold uppercase tracking-wider text-text">
              Pending / Unschedulable Pods (<Count status={podStatus} value={c.pending.count} />)
            </div>
            {/* `card-body-flush`, so the first column starts under the panel title rather than at the
                panel's own border — the inset `Card` gives a table-only body. */}
            <div className="card-body-flush">
              <DataTable
                id="capacity.pending"
                columns={pendingColumns}
                rows={pendingItems}
                rowKey={p => `${p.namespace}/${p.name}`}
                empty={
                  podStatus.state === 'ok' ? (
                    <Empty title="No unschedulable pods" />
                  ) : (
                    <UnavailableEmptyBody status={podStatus} />
                  )
                }
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
