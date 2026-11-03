/**
 * Namespaces & Workloads → Pods: one row per pod, opened inline for its containers and events.
 *
 * Nothing here reads the cluster on its own account. The rows are the workloads payload the page
 * already holds, flattened and deduplicated by `podInventoryRows`; the namespace selection is the
 * `?ns=` the Namespaces table's drill-down writes; the system flag is the server's, from the same
 * `/clusters/:id/namespaces` read the Namespaces table makes; the events are the page's warning
 * events. CPU and memory are the Namespaces table's `ResourceMeter` on the same ladder
 * (`usageVerdict`), fed by `podFigures` — see `pod-table.ts`, where every rule has a test.
 */

import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { api, type EventRow } from '../../api';
import { useAsync } from '../../useAsync';
import { ago } from '../../format';
import { Btn, Empty, InfoTip, Pill } from '../../components/ui';
import { ACTIONS, CENTER, DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { COLUMN_INFO } from '../../components/table/column-info';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { toggleKey } from '../../components/table/expand';
import { FilterBar, FilterSelect, FilterToggle, SearchBox } from '../../components/filters';
import { NamespaceFilter } from '../../components/NamespaceFilter';
import { Popover } from '../../components/table/Popover';
import { resultLine } from '../../components/namespace-filter';
import { ResourceLink } from '../../components/ResourceLink';
import { StatTile, UnavailableEmptyBody, type MetricStatus } from '../../components/unavailable';
import type { ResourceKind } from '../../resources/types';
import { MeterLegend, ResourceMeter } from './ResourceMeter';
import type { InventoryPod } from './pod-inventory';
import { podState, reasonLabel } from './pod-state';
import {
  activePodFilters,
  ADVANCED_POD_FILTER_LABEL,
  ADVANCED_POD_FILTER_TITLE,
  ADVANCED_POD_FILTERS,
  containerFigures,
  filterPodTable,
  NO_POD_FILTER,
  nextUsageBand,
  podEvents,
  podFigures,
  podSummaryCounts,
  POD_STATUS_LABEL,
  podsInScope,
  RESTARTS_WARN,
  USAGE_BAND_LABEL,
  USAGE_BANDS,
  usageBandCounts,
  workloadCell,
  type AdvancedPodFilter,
  type PodStatusFilter,
  type PodTableFilter,
  type UsageBand
} from './pod-table';
import { ALL_NAMESPACES } from './workload-filter';
import { useNamespaceSelection } from '../../components/use-namespace-selection';

type ViewLogs = (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;

const podKey = (p: InventoryPod) => `${p.namespace}/${p.name}`;

/** The Namespaces table's chevron, turned a quarter when its row is open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`transition-transform duration-[120ms] motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/**
 * A band's label colour: amber from 50%, red from 75% — the chip says how hot the band is before it
 * is pressed. The selected chip is carried by the accent border and fill, never by the label colour,
 * so violet stays a selection and the tone stays a level.
 */
const BAND_TONE: Record<UsageBand, string> = {
  all: '',
  lt25: '',
  '25to50': '',
  '50to75': 'text-warn',
  gt75: 'text-bad'
};

/**
 * One metric's quick-filter chips: All | <25% | 25–50% | 50–75% | >75%, each with its pod count.
 * Pressing the selected chip unselects it, back to All (`nextUsageBand`).
 */
function UsageChips({
  label,
  value,
  counts,
  unread,
  onChange
}: {
  label: 'CPU' | 'Memory';
  value: UsageBand;
  counts: Record<UsageBand, number>;
  unread: boolean;
  onChange: (next: UsageBand) => void;
}) {
  return (
    <div role="group" aria-label={`${label} usage`} className="inline-flex items-center gap-1">
      <span className="mr-1 text-[13px] text-muted">{label}</span>
      {USAGE_BANDS.map(b => {
        const active = b === value;
        return (
          <button
            key={b}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(nextUsageBand(value, b))}
            title={
              b === 'all'
                ? `Every pod, whatever its ${label.toLowerCase()} usage`
                : active
                  ? `Selected. Press again to show every pod, whatever its ${label.toLowerCase()} usage`
                  : `Pods using ${USAGE_BAND_LABEL[b]} of their summed ${label.toLowerCase()} request. A pod with no request or no sample is in none.`
            }
            className={`inline-flex h-7 items-center gap-1 rounded-[6px] border px-2 text-[12px] transition-colors ${
              active ? 'border-accent bg-accent/10 text-text' : 'border-line text-muted hover:border-line-strong hover:text-text'
            }`}
          >
            <span className={BAND_TONE[b]}>{USAGE_BAND_LABEL[b]}</span>
            {!unread && <span className="mono tabular-nums text-[11px] text-muted">{counts[b]}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** "More filters": the spec-fact checkboxes, in the same popover the namespace filter uses. */
function MoreFilters({ value, onChange }: { value: ReadonlySet<AdvancedPodFilter>; onChange: (next: ReadonlySet<AdvancedPodFilter>) => void }) {
  const flip = (a: AdvancedPodFilter) => {
    const next = new Set(value);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    onChange(next);
  };
  return (
    <Popover
      label={
        <>
          <span className="filter-tool-label">More filters</span>
          {value.size > 0 && <span className="filter-tool-value mono">{value.size}</span>}
          <span aria-hidden="true" className="filter-tool-caret">
            ▾
          </span>
        </>
      }
      title="Pods missing a request or a limit, or restarting often"
      align="left"
      triggerClass={value.size > 0 ? 'filter-tool filter-tool-on' : 'filter-tool'}
    >
      <ul className="popover-list">
        {ADVANCED_POD_FILTERS.map(a => (
          <li key={a}>
            <label title={ADVANCED_POD_FILTER_TITLE[a]}>
              <input type="checkbox" checked={value.has(a)} onChange={() => flip(a)} />
              <span>{ADVANCED_POD_FILTER_LABEL[a]}</span>
            </label>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

function StatusPill({ pod }: { pod: InventoryPod }) {
  const s = podState(pod);
  return (
    <Pill size="sm" tone={s.tone} title={reasonLabel(s) ?? undefined}>
      {s.phase}
      {s.readyText && <span className="opacity-80">{s.readyText}</span>}
    </Pill>
  );
}

/**
 * The server's namespace classification, the flag the Namespaces table reads. `system` is null until
 * it answers, or when it fails — and then nothing is hidden as system: see `hiddenAsSystem`.
 * Called by `WorkloadsArea`, which needs it for the sub-tab counter as well as this section.
 */
export function useSystemNamespaces(id: string): { system: ReadonlySet<string> | null; settled: boolean } {
  const ns = useAsync(useCallback(() => api.namespaces(id), [id]), 0, id);
  const system = useMemo(() => {
    const payload = ns.data?.ok ? ns.data.data : null;
    if (!payload || payload.summary?.unavailable?.includes('namespaces')) return null;
    return new Set(payload.namespaces.filter(r => r.system).map(r => r.namespace));
  }, [ns.data]);
  return { system, settled: !ns.initial };
}

export function PodsSection({
  allPods,
  system,
  systemSettled,
  showSystem,
  onShowSystem,
  metricsAvailable,
  status,
  events,
  eventStatus,
  namespaceOptions,
  onViewNode,
  onViewLogs
}: {
  /** Every pod on the cluster, deduplicated by `flattenPods`; the namespace filter applies here. */
  allPods: InventoryPod[];
  /** From `useSystemNamespaces`; the toggle lives in `WorkloadsArea` so its counter follows it. */
  system: ReadonlySet<string> | null;
  systemSettled: boolean;
  showSystem: boolean;
  onShowSystem: (show: boolean) => void;
  metricsAvailable: boolean;
  status: MetricStatus;
  events: EventRow[];
  eventStatus: MetricStatus;
  namespaceOptions: readonly string[];
  onViewNode: (nodeName: string) => void;
  onViewLogs: ViewLogs;
}): JSX.Element {
  // `?ns=`, the parameter the Namespaces drill-down writes and `WorkloadsArea` counts from. The hook
  // holds nothing but the URL, so this and the sub-tab counter cannot disagree.
  const [namespaces, onNamespaces] = useNamespaceSelection('ns', namespaceOptions);
  const total = allPods.length;

  const [query, setQuery] = useState<Omit<PodTableFilter, 'showSystem'>>(NO_POD_FILTER);
  const filter: PodTableFilter = useMemo(() => ({ ...query, showSystem }), [query, showSystem]);
  const set = (patch: Partial<Omit<PodTableFilter, 'showSystem'>>) => setQuery(q => ({ ...q, ...patch }));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setExpanded(prev => toggleKey(prev, key)), []);

  const scoped = useMemo(() => podsInScope(allPods, namespaces, system, showSystem), [allPods, namespaces, system, showSystem]);
  const counts = useMemo(() => podSummaryCounts(scoped), [scoped]);
  const rows = useMemo(() => filterPodTable(scoped, filter), [scoped, filter]);
  // Each chip group counts over the rows every *other* filter leaves, so a chip's number is the row
  // count pressing it would show.
  const cpuCounts = useMemo(() => usageBandCounts(filterPodTable(scoped, { ...filter, cpu: 'all' }), 'cpu'), [scoped, filter]);
  const memCounts = useMemo(() => usageBandCounts(filterPodTable(scoped, { ...filter, memory: 'all' }), 'memory'), [scoped, filter]);

  const columns: Column<InventoryPod>[] = [
    {
      key: 'pod',
      header: 'Pod',
      pin: true,
      // Every column but the two meters is fixed, and at 1440 with the rail open the table has 1150px:
      // 232 + 132 + 150 + 2×240 + 112 + 44 fills it exactly.
      width: '232px',
      min: '232px',
      max: '232px',
      sortValue: p => p.name,
      // Name, then the namespace — or the container's reason when there is one, because that is the
      // line an operator opened the list to find. The pill beside it carries the phase alone.
      render: p => {
        const reason = reasonLabel(podState(p));
        return (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="mono truncate text-[13px] font-medium" title={p.name}>
              {p.name}
            </span>
            {reason ? (
              <span className="mono truncate text-[11px] text-bad" title={reason}>
                {reason}
              </span>
            ) : (
              <span className="mono truncate text-[11px] text-muted" title={p.namespace}>
                {p.namespace}
              </span>
            )}
          </span>
        );
      }
    },
    {
      key: 'status',
      header: 'Status',
      ...CENTER,
      width: '132px',
      min: '132px',
      max: '132px',
      sortValue: p => `${podState(p).tone === 'ok' ? 1 : 0}${p.phase}`,
      render: p => <StatusPill pod={p} />
    },
    {
      key: 'workload',
      header: 'Workload',
      width: '150px',
      min: '150px',
      max: '150px',
      sortValue: p => p.owners[0] ?? '',
      render: p => {
        const w = workloadCell(p.owners);
        return (
          <span className="flex min-w-0 flex-col leading-tight" title={w.title}>
            {w.kind === 'one' ? (
              <>
                <span className="mono truncate text-[13px]">{w.name}</span>
                <span className="truncate text-[11px] text-muted">{w.workloadKind}</span>
              </>
            ) : w.kind === 'ambiguous' ? (
              <span className="truncate text-[12px] text-warn">{w.count} workloads</span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </span>
        );
      }
    },
    {
      key: 'cpu',
      ...NUMERIC,
      // Equal `min`s at the wider header's min-content, so the two meters split the rest evenly.
      width: '50%',
      min: '240px',
      header: 'CPU · Used/Req/Lim',
      info: COLUMN_INFO.podCpu,
      sortValue: p => podFigures(p, 'cpu').used ?? -1,
      render: p => <ResourceMeter compact scope="pod" label="CPU" metric="cpu" figures={podFigures(p, 'cpu')} />
    },
    {
      key: 'mem',
      ...NUMERIC,
      width: '50%',
      min: '240px',
      header: 'Memory · Used/Req/Lim',
      info: COLUMN_INFO.podMemory,
      sortValue: p => podFigures(p, 'memory').used ?? -1,
      render: p => <ResourceMeter compact scope="pod" label="Memory" metric="memory" figures={podFigures(p, 'memory')} />
    },
    {
      key: 'restarts',
      header: 'Restarts',
      ...NUMERIC,
      width: '112px',
      min: '112px',
      info: COLUMN_INFO.restarts,
      sortValue: p => p.restarts,
      render: p => <span className={`mono tabular-nums ${p.restarts > RESTARTS_WARN ? 'text-warn' : p.restarts === 0 ? 'text-muted' : ''}`}>{p.restarts}</span>
    },
    {
      key: 'actions',
      ...ACTIONS,
      width: '44px',
      min: '44px',
      header: <span className="sr-only">Details</span>,
      render: p => {
        const open = expanded.has(podKey(p));
        return (
          <button
            type="button"
            // The row's `onSelect` makes the same toggle; stopping here keeps it to one.
            onClick={e => {
              e.stopPropagation();
              toggle(podKey(p));
            }}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} details for ${p.name}`}
            title={open ? 'Hide details' : 'Show details'}
            className="inline-flex size-6 items-center justify-center rounded-[6px] border border-transparent text-muted transition-colors hover:border-line-strong hover:text-text"
          >
            <Chevron open={open} />
          </button>
        );
      }
    }
  ];

  const tiles: { key: PodStatusFilter; label: string; value: number; caption: string; tone?: string }[] = [
    { key: 'all', label: 'Pods', value: counts.total, caption: `${counts.attention} need attention` },
    { key: 'running', label: 'Running', value: counts.running, caption: 'phase Running', tone: counts.running ? 'text-ok' : undefined },
    { key: 'completed', label: 'Completed', value: counts.completed, caption: 'phase Succeeded' },
    { key: 'pending', label: 'Pending', value: counts.pending, caption: 'not yet running', tone: counts.pending ? 'text-warn' : undefined },
    { key: 'failed', label: 'Failed', value: counts.failed, caption: 'phase Failed', tone: counts.failed ? 'text-bad' : undefined }
  ];

  // A failed workloads read has no rows to count, and "Running (0)" would state a zero it never read.
  const unread = status.state === 'unavailable';
  const statusOptions = (['all', 'running', 'completed', 'pending', 'failed', 'unknown', 'attention'] as const).map(k => {
    const label = POD_STATUS_LABEL[k];
    return { value: k, label: unread ? label : `${label} (${k === 'all' ? counts.total : counts[k]})` };
  });

  return (
    <div className="space-y-3">
      {!metricsAvailable && (
        <p className="text-[13px] text-muted">
          metrics-server is not answering on this cluster, so used CPU and memory read as No data. Requests and limits are
          read from the pod spec and remain exact.
        </p>
      )}
      {status.state !== 'ok' && status.state !== 'unavailable' && (
        <p className="text-[13px] text-warn">{status.why || 'The workloads read was incomplete'} — pod counts are floors.</p>
      )}
      {system === null && systemSettled && (
        <p className="text-[13px] text-muted">
          The namespace classification did not answer, so no pod is hidden as a system pod.
        </p>
      )}

      {/* Summary cards: the scope's live counts by phase. Each one filters the table to its rows. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(t => (
          <StatTile
            key={t.key}
            label={t.label}
            status={status}
            value={<span className="mono tabular-nums">{t.value}</span>}
            valueClass={t.tone ?? 'text-text'}
            caption={t.caption}
            onClick={() => set({ status: t.key })}
            actionLabel={t.key === 'all' ? 'Show every pod' : `Show ${t.label.toLowerCase()} pods`}
          />
        ))}
      </div>

      <FilterBar
        activeCount={activePodFilters(filter, namespaces.size)}
        onReset={() => {
          setQuery(NO_POD_FILTER);
          onShowSystem(false);
          onNamespaces(ALL_NAMESPACES);
        }}
        resultLine={unread ? 'Pods unavailable' : resultLine(rows.length, total, 'pods')}
      >
        <NamespaceFilter options={namespaceOptions} selected={namespaces} onChange={onNamespaces} />
        <label className="relative flex min-w-[180px] max-w-[300px] flex-1 [&>input]:min-w-[180px]">
          <span className="sr-only">Search pods</span>
          <SearchBox value={filter.search} onChange={v => set({ search: v })} placeholder="Search pods..." />
        </label>
        <FilterSelect label="Status" value={filter.status} onChange={v => set({ status: v as PodStatusFilter })} options={statusOptions} />
        <FilterToggle
          label="Show system pods"
          checked={showSystem}
          onChange={onShowSystem}
          title="Shows pods in the namespaces the server classifies as system (Kubernetes, Istio, Kyma and the bootstrap tooling). A namespace you selected is always shown."
        />
        {/* One flex item, so it wraps as a unit: beside the controls on a wide window, onto its own
            row (the result line after it) when they do not fit. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <UsageChips label="CPU" value={filter.cpu} counts={cpuCounts} unread={unread} onChange={v => set({ cpu: v })} />
          <UsageChips label="Memory" value={filter.memory} counts={memCounts} unread={unread} onChange={v => set({ memory: v })} />
          <MoreFilters value={filter.advanced} onChange={v => set({ advanced: v })} />
        </div>
      </FilterBar>

      <div className={`${CARD_TABLE_CLASS} [&_th[data-col-key=restarts]]:px-[2px]`}>
        <span className="absolute left-0 top-0 flex h-[18px] items-center gap-1.5">
          <MeterLegend />
          <InfoTip text="A pod's figures are summed over its regular containers. Only pods selected by a Deployment, StatefulSet or DaemonSet are listed." />
        </span>
        <DataTable
          id="pods"
          columns={columns}
          rows={rows}
          rowKey={podKey}
          shed="wide"
          onSelect={p => toggle(podKey(p))}
          renderExpandedRow={p => (
            <PodDetail pod={p} events={events} eventStatus={eventStatus} onViewNode={onViewNode} onViewLogs={onViewLogs} />
          )}
          expandedKeys={expanded}
          onToggleExpand={toggle}
          expandChevron="none"
          empty={
            status.state === 'unavailable' ? (
              <UnavailableEmptyBody status={status} />
            ) : total === 0 ? (
              <Empty title="No pods" hint="No Deployment, StatefulSet or DaemonSet on this cluster selects any pod." />
            ) : (
              <Empty title="No matching pods" hint={`None of the ${total} pods match the current filters.`} />
            )
          }
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the opened row

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-text">{children}</dd>
    </>
  );
}

function PodDetail({
  pod,
  events,
  eventStatus,
  onViewNode,
  onViewLogs
}: {
  pod: InventoryPod;
  events: EventRow[];
  eventStatus: MetricStatus;
  onViewNode: (nodeName: string) => void;
  onViewLogs: ViewLogs;
}) {
  const w = workloadCell(pod.owners);
  const recent = podEvents(events, pod);
  const s = podState(pod);

  return (
    <div className="grid gap-4 text-[12px] lg:grid-cols-[260px_minmax(0,1fr)]">
      <section className="min-w-0">
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Pod details</h4>
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
          <Detail label="Name">
            <ResourceLink refTo={{ kind: 'Pod', namespace: pod.namespace, name: pod.name }} className="mono" />
          </Detail>
          <Detail label="Namespace">
            <span className="mono">{pod.namespace}</span>
          </Detail>
          <Detail label="Workload">
            {w.kind === 'one' ? (
              <ResourceLink refTo={{ kind: w.workloadKind as ResourceKind, namespace: pod.namespace, name: w.name }} className="mono" />
            ) : w.kind === 'ambiguous' ? (
              <span className="text-warn" title={w.title}>
                {w.count} workloads select it
              </span>
            ) : (
              <span className="text-muted">none</span>
            )}
          </Detail>
          <Detail label="Workload type">{w.kind === 'one' ? w.workloadKind : <span className="text-muted">—</span>}</Detail>
          <Detail label="Node">
            {pod.node ? (
              <button
                type="button"
                onClick={() => onViewNode(pod.node!)}
                className="mono truncate underline decoration-dotted hover:text-accent"
                title="View this node in the Nodes tab"
              >
                {pod.node}
              </button>
            ) : (
              <span className="mono text-muted">unscheduled</span>
            )}
          </Detail>
          <Detail label="Pod IP">
            <span className="mono">{pod.podIP ?? <span className="text-muted">—</span>}</span>
          </Detail>
          {/* The pods payload carries `status.startTime`, not `metadata.creationTimestamp`. */}
          <Detail label="Started">
            <span className="mono" title={pod.startedAt ?? undefined}>
              {ago(pod.startedAt)}
            </span>
          </Detail>
          <Detail label="Status">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <StatusPill pod={pod} />
              {pod.qosClass && <span className="mono text-muted">{pod.qosClass}</span>}
            </span>
          </Detail>
          {reasonLabel(s) && (
            <Detail label="Reason">
              <span className="mono text-bad" title={pod.message ?? undefined}>
                {reasonLabel(s)}
              </span>
            </Detail>
          )}
        </dl>
        <div className="mt-2">
          <Btn onClick={() => onViewLogs(pod.namespace, pod.name)}>Logs</Btn>
        </div>
      </section>

      <div className="min-w-0 space-y-4">
        <section className="min-w-0">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Containers <span className="mono font-normal">{pod.containers.length}</span>
          </h4>
          {pod.containers.length === 0 ? (
            <p className="text-muted">This pod reported no containers.</p>
          ) : (
            // Fixed layout: an auto-sized table grows to its longest image string and pushed the
            // status column past the detail row's edge. Here the image truncates instead.
            <table className="tbl-inline w-full table-fixed">
              <colgroup>
                <col />
                <col className="w-[208px]" />
                <col className="w-[208px]" />
                <col className="w-[64px]" />
                <col className="w-[128px]" />
                <col className="w-[64px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>container</th>
                  <th className="num">cpu · used/req/lim</th>
                  <th className="num">memory · used/req/lim</th>
                  <th className="num">restarts</th>
                  <th>status</th>
                  <th className="num">
                    <span className="sr-only">Logs</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pod.containers.map(c => (
                  <tr key={c.name}>
                    <td className="min-w-0">
                      <span className="mono block truncate font-medium" title={c.name}>
                        {c.name}
                        {c.init && <span className="ml-1 text-[11px] uppercase text-muted">{c.sidecar ? 'sidecar' : 'init'}</span>}
                      </span>
                      <div className="mono truncate text-[11px] text-muted" title={c.image}>
                        {c.image}
                      </div>
                    </td>
                    <td>
                      <ResourceMeter compact scope="container" label="CPU" metric="cpu" figures={containerFigures(c, 'cpu')} />
                    </td>
                    <td>
                      <ResourceMeter compact scope="container" label="Memory" metric="memory" figures={containerFigures(c, 'memory')} />
                    </td>
                    <td className={`mono num tabular-nums ${c.restarts > 0 ? 'text-warn' : 'text-muted'}`}>{c.restarts}</td>
                    <td className="min-w-0">
                      <span className={`block truncate ${c.ready ? 'text-ok' : c.reason ? 'text-bad' : 'text-warn'}`} title={c.reason ?? c.state}>
                        {c.reason ?? c.state}
                      </span>
                      {c.lastStateReason && (
                        <div className="text-[11px] text-muted" title={c.lastExitCode === null ? undefined : `exit ${c.lastExitCode}`}>
                          last: {c.lastStateReason}
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <Btn onClick={() => onViewLogs(pod.namespace, pod.name, c.name, { previous: c.restarts > 0 && !c.ready })}>Logs</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="min-w-0">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Recent events</h4>
          {eventStatus.state === 'unavailable' ? (
            <p className="text-warn">{eventStatus.why || 'The events read failed'}, so this pod's events are unknown.</p>
          ) : recent.length === 0 ? (
            <p className="text-muted">
              No warning events for this pod{eventStatus.truncated ? ' among the events read — the read stopped early, so this is not conclusive' : ''}.
            </p>
          ) : (
            <table className="tbl-inline w-full">
              <thead>
                <tr>
                  <th>time</th>
                  <th>reason</th>
                  <th>message</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e, i) => (
                  <Fragment key={`${e.at}-${e.reason}-${i}`}>
                    <tr>
                      <td className="mono whitespace-nowrap text-muted" title={e.at ?? undefined}>
                        {ago(e.at)}
                      </td>
                      <td className="whitespace-nowrap text-warn">
                        {e.reason}
                        {e.count > 1 && <span className="mono ml-1 text-muted">×{e.count}</span>}
                      </td>
                      <td className="max-w-0 w-full">
                        <span className="block truncate" title={e.message}>
                          {e.message}
                        </span>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
