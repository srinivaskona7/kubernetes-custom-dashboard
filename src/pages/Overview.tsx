/**
 * Overview — the whole fleet on one screen, and the page an operator leaves open.
 *
 * The column order encodes the triage order: is the cluster reachable, is its token
 * alive, are its nodes ready, are its pods running, is it out of room. A cluster that
 * cannot be reached shows why on the row itself, not behind a click.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PageProps } from '../App';
import { api, type ClusterEnvelope } from '../api';
import { Column, DataTable } from '../components/DataTable';
import { DetailPanel, Field, PageHeader, Section } from '../components/layout';
import RemoveCluster from '../components/RemoveCluster';
import { Btn, CapacityBar, Card, Empty, ErrorState, Pair, Pill, Skeleton } from '../components/ui';
import {
  MetricValue,
  Unavailable,
  UnavailableNotice,
  unavailableScope,
  type MetricStatus
} from '../components/unavailable';
import { ago, bytes, cores, duration, percent } from '../format';
import { seedCommand, TOKEN_LABEL, tokenTone } from '../status';
import { useAsync } from '../useAsync';

type Row = ClusterEnvelope;

export default function Overview({ onRefreshed }: PageProps) {
  const { data, error, initial, loading, reload } = useAsync(useCallback(() => api.clusters(), []), 30_000);
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * What the last removal left behind on the target cluster.
   *
   * Held here rather than inside `RemoveCluster`, because removing the cluster also removes the
   * row this page had selected — the detail rail unmounts, and the component's own summary would
   * go with it. These are objects still running on somebody's cluster; the console that stopped
   * managing them is the only thing that can say so.
   */
  const [removed, setRemoved] = useState<{ id: string; leftBehind: string } | null>(null);

  useEffect(() => {
    if (data) onRefreshed(data.collectedAt);
  }, [data, onRefreshed]);

  const rows = data?.clusters ?? [];
  const active = rows.filter(r => r.cluster.enabled);
  // `=== true`, not truthiness: `ok` is three-state and `null` means "registered, not read yet".
  // Summing over `!r.ok` would have folded a cluster added seconds ago into the same bucket as a
  // cluster whose token expired, and reported it as Down.
  const reachable = active.filter(r => r.ok === true);
  const nodesReady = reachable.reduce((n, r) => n + (r.data?.nodes.ready ?? 0), 0);
  const nodesTotal = reachable.reduce((n, r) => n + (r.data?.nodes.total ?? 0), 0);
  const podsRunning = reachable.reduce((n, r) => n + (r.data?.pods.running ?? 0), 0);
  const podsTotal = reachable.reduce((n, r) => n + (r.data?.pods.total ?? 0), 0);
  // Pending and failed drive the tile's colour. Without them the tile was hard-coded `tone="ok"`,
  // so it rendered green with a hundred pods in CrashLoopBackOff — a status colour that is always
  // the same is decoration, and worse than none, because it reads as a checked verdict.
  const podsFailed = reachable.reduce((n, r) => n + (r.data?.pods.failed ?? 0), 0);
  const podsPending = reachable.reduce((n, r) => n + (r.data?.pods.pending ?? 0), 0);

  /**
   * Tokens are this app's own bookkeeping, so unlike the cluster aggregates they are always
   * readable — a cluster that cannot be reached still has a known token record.
   *
   * Counted over `active`, not `rows`: a disabled registration is not something for anyone to act
   * on, and including it made the tile ask for attention nobody could usefully give.
   */
  const tokensToWatch = active.filter(r => r.token && r.token.status !== 'valid');
  const tokensExpired = tokensToWatch.some(r => r.token?.status === 'expired');

  /**
   * The aggregates above sum only over the clusters that answered, so a fleet where every
   * token has expired totals to a confident `0/0`. Reachability is the one tile that is
   * always honest — it is *about* the failure — so it is the only one left unqualified.
   */
  const scope = useMemo(
    () =>
      unavailableScope({
        clusters: active.map(r => ({ id: r.cluster.id, ok: r.ok, error: r.error, summary: r.data }))
      }),
    [active]
  );
  const nodeStatus = scope.of('node readings', 'nodes');
  const podStatus = scope.of('pod readings', 'pods');

  const current = rows.find(r => r.cluster.id === selected) ?? null;

  /** Why this row has no numbers: its own error, in the tooltip, on the cell itself. */
  const rowWhy = (r: Row, what: string) =>
    `could not read ${what} — ${r.error ? `${r.error.code}: ${r.error.message}` : 'the cluster returned no data'}`;

  const columns: Column<Row>[] = [
    {
      key: 'cluster',
      header: 'Cluster',
      pin: true,
      // `max`, not `width`: the cell truncates, and a `width` on the th is a suggestion a long
      // cluster id overrides. This table fits its 1100px container exactly today (measured 1101px of
      // content), so the ceiling is set AT the current rendered width — it can only prevent growth,
      // never cause a reflow.
      max: '230px',
      render: r => (
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Three states, so three pills. "Pending" is not "Down": a cluster onboarded a moment
              ago has not been read, and calling that a failure is the fleet asserting something
              it never checked. */}
          <Pill tone={!r.cluster.enabled ? 'unknown' : r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'unknown'}>
            {!r.cluster.enabled ? 'Off' : r.ok === true ? 'Up' : r.ok === false ? 'Down' : 'Pending'}
          </Pill>
          <Link
            to={`/clusters/${encodeURIComponent(r.cluster.id)}`}
            onClick={e => e.stopPropagation()}
            className="mono truncate font-medium text-text hover:text-accent hover:underline"
            title={`Open full dashboard for ${r.cluster.displayName || r.cluster.id}`}
          >
            {r.cluster.displayName || r.cluster.id}
          </Link>
        </div>
      )
    },
    { key: 'env', header: 'Env', priority: 2, render: r => <span className="mono uppercase">{r.cluster.env}</span> },
    {
      key: 'token',
      header: 'Token',
      render: r => {
        const t = r.token;
        if (!t) return <span className="text-muted">—</span>;
        return (
          <span className="flex items-center gap-2">
            <Pill tone={tokenTone(t.status)}>{TOKEN_LABEL[t.status]}</Pill>
            <span className="mono text-muted">{duration(t.expiresInMs)}</span>
          </span>
        );
      }
    },
    {
      key: 'nodes',
      header: 'Nodes',
      // Centre: the cell is `ready / total`, and `Pair` puts the separator on its own grid track so
      // the ratio reads down the column instead of only its last digit lining up.
      align: 'center',
      render: r =>
        r.ok && r.data ? (
          <Pair
            className={r.data.nodes.ready < r.data.nodes.total ? 'text-bad' : ''}
            a={r.data.nodes.ready}
            b={r.data.nodes.total}
            title={`${r.data.nodes.ready} of ${r.data.nodes.total} nodes Ready`}
          />
        ) : (
          <Unavailable what="nodes" why={rowWhy(r, 'nodes')} size="sm" variant="dash" />
        )
    },
    {
      key: 'pods',
      header: 'Pods',
      align: 'right',
      priority: 2,
      render: r =>
        r.ok && r.data ? (
          <span className="mono">
            {r.data.pods.running}
            {r.data.pods.pending > 0 && <span className="text-warn"> +{r.data.pods.pending}</span>}
            {r.data.pods.failed > 0 && <span className="text-bad"> !{r.data.pods.failed}</span>}
          </span>
        ) : (
          <Unavailable what="pods" why={rowWhy(r, 'pods')} size="sm" variant="dash" />
        )
    },
    {
      key: 'cpu',
      header: 'CPU',
      align: 'right',
      priority: 3,
      render: r =>
        r.ok && r.data ? (
          <span className="mono">{percent(r.data.capacity.cpu.percent)}</span>
        ) : (
          <Unavailable what="CPU" why={rowWhy(r, 'CPU')} size="sm" variant="dash" />
        )
    },
    {
      key: 'mem',
      header: 'Memory',
      align: 'right',
      priority: 3,
      render: r =>
        r.ok && r.data ? (
          <span className="mono">{percent(r.data.capacity.memory.percent)}</span>
        ) : (
          <Unavailable what="memory" why={rowWhy(r, 'memory')} size="sm" variant="dash" />
        )
    },
    {
      key: 'version',
      header: 'Version',
      priority: 3,
      render: r =>
        r.data?.kubernetesVersions.length ? (
          <span className={`mono ${r.data.kubernetesVersions.length > 1 ? 'text-warn' : ''}`}>
            {r.data.kubernetesVersions.join(', ')}
          </span>
        ) : r.ok ? (
          <span className="text-muted">—</span>
        ) : (
          <Unavailable what="the Kubernetes version" why={rowWhy(r, 'the Kubernetes version')} size="sm" variant="dash" />
        )
    }
  ];

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <PageHeader
          title="Fleet overview"
          icon="overview"
          info="One row per onboarded cluster, each a live read of that cluster's own API server \u2014 node readiness, pod counts and the worst finding per topic. A cluster that did not answer is marked unavailable, never counted as zero."
          subtitle={
            data
              ? `${reachable.length} of ${active.length} active clusters reachable · collected ${ago(data.collectedAt)}`
              : 'Collecting…'
          }
          actions={
            <Btn onClick={reload} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Btn>
          }
        />

        <UnavailableNotice scope={scope} className="mb-4" />

        {/* Not styled as an error — nothing failed. It is a receipt, and it stays until dismissed
            because the commands in it are the operator's next step on a cluster this console can
            no longer reach. */}
        {removed && (
          <div className="page-x pb-4">
            <div className="rounded-[7px] border border-line bg-raised/50 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13px] text-text">
                  <span className="mono font-medium">{removed.id}</span> is no longer registered. Its
                  token record is deleted; nothing on the cluster itself was changed.
                </p>
                <Btn variant="ghost" onClick={() => setRemoved(null)}>Dismiss</Btn>
              </div>
              <div className="mt-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                Still running on the cluster
              </div>
              <p className="mt-1 text-[13px] leading-[1.6] text-muted">{removed.leftBehind}</p>
            </div>
          </div>
        )}

        {/* Four tiles, and every one of them is a question this console can answer from what it
            actually read: is each cluster reachable, are its nodes Ready, are its pods Running, is
            a credential about to stop working. Anything the fleet cannot answer belongs behind a
            cluster's own tab, where the reason for the gap is on the same screen as the gap. */}
        <div className="grid grid-cols-2 gap-4 page-x pb-4 xl:grid-cols-4">
          <Stat label="Clusters reachable" value={`${reachable.length}/${active.length}`} tone={reachable.length < active.length ? 'bad' : 'ok'} />
          <Stat label="Nodes ready" value={`${nodesReady}/${nodesTotal}`} tone={nodesReady < nodesTotal ? 'bad' : 'ok'} status={nodeStatus} />
          <Stat
            label="Pods running"
            value={`${podsRunning}/${podsTotal}`}
            tone={podsFailed > 0 ? 'bad' : podsPending > 0 ? 'warn' : 'ok'}
            status={podStatus}
          />
          <Stat
            label="Tokens needing attention"
            value={String(tokensToWatch.length)}
            tone={tokensExpired ? 'bad' : tokensToWatch.length > 0 ? 'warn' : 'ok'}
          />
        </div>

        <div className="page-x pb-6">
          <Card title="Clusters" flush>
            {initial && <Skeleton />}
            {!initial && error && <ErrorState code={error.code} message={error.message} />}
            {!initial && !error && (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={r => r.cluster.id}
                selectedKey={selected}
                onSelect={r => setSelected(r.cluster.id)}
                empty={
                  <Empty
                    title="No clusters registered"
                    hint="Use Add cluster to onboard one with its kubeconfig and a fleet-reader token. Nothing is read until you do — this console ships knowing about no cluster."
                  />
                }
              />
            )}
          </Card>
        </div>
      </div>

      {current && (
        <DetailPanel title={current.cluster.displayName} subtitle={current.cluster.id} onClose={() => setSelected(null)}>
          <ClusterDetail
            row={current}
            canRemove={data?.canRemove ?? false}
            onRemoved={leftBehind => {
              // Drop the selection and re-read the fleet. Leaving the panel open on a cluster the
              // server has just forgotten would keep a row on screen that no longer exists, and
              // the next poll would blank it out 30 seconds later with no explanation.
              setRemoved({ id: current.cluster.id, leftBehind });
              setSelected(null);
              reload();
            }}
          />
        </DetailPanel>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  status
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'bad';
  /** Omitted for a tile that is true regardless of what the collectors managed to read. */
  status?: MetricStatus;
}) {
  const colour = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-text';
  return (
    <div className="card px-5 py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1 leading-tight">
        <MetricValue status={status} size="lg" className={`mono text-[26px] ${colour}`}>
          {value}
        </MetricValue>
      </div>
      {status && status.state !== 'ok' && (
        <div className="mt-1 line-clamp-2 text-[12px] text-warn" title={status.why}>
          {status.why}
        </div>
      )}
    </div>
  );
}

function ClusterDetail({
  row,
  canRemove,
  onRemoved
}: {
  row: ClusterEnvelope;
  canRemove: boolean;
  onRemoved: (leftBehind: string) => void;
}) {
  const c = row.cluster;
  const t = row.token;
  const navigate = useNavigate();

  return (
    <>
      {/* One action, not a launcher grid.
          What was here: a full-width accent button plus a seven-tile "Quick Jump to Features"
          panel of emoji links (Workloads, Autoscaling, Networking, Storage, Security, Nodes, Live
          Logs). Every one of them landed on the cluster page's own tab strip, which is visible the
          moment you arrive — so the panel duplicated the destination's navigation, took the top
          third of the rail, and put seven decorative glyphs on a console whose density budget is
          spent on data. The rail's job is to answer "what is true about this cluster"; getting to
          the cluster is one link. */}
      <div className="mb-4">
        <Btn variant="primary" onClick={() => navigate(`/clusters/${encodeURIComponent(c.id)}`)}>
          Open cluster dashboard
        </Btn>
      </div>

      <Section label="Registration">
        <Field label="Environment" value={c.env.toUpperCase()} mono />
        <Field label="API server" value={c.apiUrl} mono />
        <Field label="Namespace" value={c.namespace} mono />
        <Field label="Service account" value={c.serviceAccount} mono />
        <Field label="Enabled" value={c.enabled ? 'Yes' : 'No'} />
      </Section>

      <Section label="Token">
        {t ? (
          <>
            <Field label="Status" value={<Pill tone={tokenTone(t.status)}>{TOKEN_LABEL[t.status]}</Pill>} />
            <Field label="Expires in" value={duration(t.expiresInMs)} mono />
            <Field label="Last renewed" value={ago(t.renewedAt)} mono />
            <Field label="Due for renewal" value={t.dueForRenewal ? 'Yes' : 'No'} />
            {t.lastError && <p className="mt-2 text-[13px] text-bad">{t.lastError}</p>}
          </>
        ) : (
          <p className="text-[14px] text-muted">No token record.</p>
        )}
      </Section>

      {!row.ok && row.error && (
        <Section label="Why this cluster is unavailable">
          <ErrorState
            cluster={c.id}
            code={row.error.code}
            message={row.error.message}
            needsReseed={row.error.needsReseed}
            command={row.error.needsReseed ? seedCommand(c.namespace, c.serviceAccount) : undefined}
          />
        </Section>
      )}

      {row.ok && row.data && (
        <>
          <Section label="Capacity (requests against allocatable)">
            <div className="space-y-3">
              <CapacityBar
                label="CPU"
                used={`${cores(row.data.capacity.cpu.requested)} cores`}
                total={`${cores(row.data.capacity.cpu.allocatable)}`}
                pct={row.data.capacity.cpu.percent}
              />
              <CapacityBar
                label="Memory"
                used={bytes(row.data.capacity.memory.requested)}
                total={bytes(row.data.capacity.memory.allocatable)}
                pct={row.data.capacity.memory.percent}
              />
            </div>
            <p className="mt-2 text-[13px] text-muted">
              Requests, not live usage — metrics.k8s.io is not required, and requests are what actually govern
              scheduling.
            </p>
          </Section>

          <Section label={`Nodes (${row.data.nodes.ready}/${row.data.nodes.total} ready)`}>
            {row.data.nodes.items.map(n => (
              <div key={n.name} className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
                <div className="min-w-0">
                  <div className="mono truncate text-[14px] font-medium" title={n.name}>
                    {n.name}
                  </div>
                  <div className="mono mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                    {n.nodeGroup && (
                      <span className="rounded bg-raised border border-line px-1.5 py-0.2 text-accent">
                        {n.nodeGroup}
                      </span>
                    )}
                    {/* `{pods}/{podCapacity}` only when the capacity was actually read. The old
                        `n.podCapacity || 110` printed Kubernetes' *default* max-pods as if it were
                        this node's — a number nobody measured, on a node pool that may well be
                        configured differently, and indistinguishable on screen from a real reading. */}
                    <span>{n.podCapacity ? `${n.pods}/${n.podCapacity} pods` : `${n.pods} pods`}</span>
                    {n.cpuRequestedPercent !== undefined && <span>req: {n.cpuRequestedPercent}% cpu</span>}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="mono text-[13px] text-muted">{n.version}</span>
                  <Pill tone={n.ready ? 'ok' : 'bad'}>{n.ready ? 'Ready' : 'NotReady'}</Pill>
                </span>
              </div>
            ))}
          </Section>

          <Section label="Pods">
            {Object.entries(row.data.pods.byPhase).map(([phase, n]) => (
              <Field key={phase} label={phase} value={String(n)} mono />
            ))}
            <Field label="Total restarts" value={String(row.data.pods.restarts)} mono />
          </Section>
        </>
      )}

      {/* Last, and behind a typed confirmation — the same control the cluster's own Credentials
          tab renders. It sits at the bottom of a panel the operator had to open a row to reach,
          which is the shape that keeps a de-registration out of mis-click range while still
          putting it where someone looking at the fleet would go to find it. */}
      <RemoveCluster
        id={c.id}
        displayName={c.displayName || c.id}
        canRemove={canRemove}
        removable={row.removable ?? false}
        onRemoved={onRemoved}
        variant="inline"
      />
    </>
  );
}
