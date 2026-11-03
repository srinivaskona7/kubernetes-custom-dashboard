/**
 * Namespaces & Workloads → Namespaces: one row per namespace, never one per pod.
 *
 * The inventory, the pod counts and the system flag come from `/clusters/:id/namespaces` — the read
 * the Overview's Namespaces tile makes, so the two totals are one number. CPU and memory come from
 * the workloads rows this page already holds, through `buildUtilizationModel` and
 * `mergeNamespaceUsage`. Every rule lives in
 * `namespace-table.ts`, where it has a test.
 *
 * Opening a namespace lands on the Pods section with `?ns=` set, so the namespace filter there is
 * the drill-down.
 */

import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type WorkloadRow } from '../../api';
import { useAsync } from '../../useAsync';
import { Empty, ErrorBanner, Icon, InfoTip, Pill, type Tone } from '../../components/ui';
import { ACTIONS, CENTER, DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { COLUMN_INFO } from '../../components/table/column-info';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { FilterBar, FilterSelect, FilterToggle, SearchBox } from '../../components/filters';
import type { MetricStatus } from '../../components/unavailable';
import { flattenPods } from './pod-inventory';
import { buildUtilizationModel } from './usage/utilization-model';
import { NamespaceViewSwitch, TopNamespaces } from './TopNamespaces';
import { NAMESPACE_TOPS, namespaceTop, namespaceView, type NamespaceTop, type NamespaceView } from './top-namespaces';
import { MeterLegend, ResourceMeter } from './ResourceMeter';
import {
  activeNamespaceFilters,
  buildNamespaceTable,
  filterNamespaceTable,
  namespaceTypeCounts,
  NAMESPACE_STATUS_LABEL,
  NO_NAMESPACE_FILTER,
  hiddenSystemCount,
  showsSystem,
  withShowSystem,
  withType,
  resourceCell,
  type NamespaceStatus,
  type NamespaceTableFilter,
  type NamespaceTableRow
} from './namespace-table';

const STATUS_TONE: Record<NamespaceStatus, Tone> = {
  healthy: 'ok',
  warning: 'warn',
  critical: 'bad',
  empty: 'unknown',
  unknown: 'unknown'
};

function ResourceCellView({ row, metric }: { row: NamespaceTableRow; metric: 'cpu' | 'memory' }) {
  const cell = resourceCell(row.usage);
  if (cell.kind === 'text') {
    // The meter's own height, so a row without one is not 20px shorter than its neighbours.
    return (
      <span className="flex h-[48px] items-center text-[13px] text-muted" title={cell.title}>
        {cell.text}
      </span>
    );
  }
  return (
    <ResourceMeter
      compact
      label={metric === 'cpu' ? 'CPU' : 'Memory'}
      metric={metric}
      figures={metric === 'cpu' ? row.usage.cpu : row.usage.memory}
    />
  );
}

export function NamespacesSection({
  id,
  items,
  metricsAvailable,
  status,
  onOpenNamespace,
  onOpenTopConsumers
}: {
  id: string;
  /** The workloads rows the page already holds — workload counts, status and the CPU/memory join. */
  items: WorkloadRow[];
  metricsAvailable: boolean;
  /** Completeness of the workloads read, so a partial read is named rather than shown as zeros. */
  status: MetricStatus;
  /** Open the Pods section filtered to this namespace. */
  onOpenNamespace: (namespace: string) => void;
  /** Namespace → Top Consumers with `?ns=` set: the pods behind a top-namespace figure. */
  onOpenTopConsumers: (namespace: string) => void;
}): JSX.Element {
  const ns = useAsync(useCallback(() => api.namespaces(id), [id]), 0, id);
  const payload = ns.data?.ok ? ns.data.data : null;
  const [filter, setFilter] = useState<NamespaceTableFilter>(NO_NAMESPACE_FILTER);
  const set = (patch: Partial<NamespaceTableFilter>) => setFilter(f => ({ ...f, ...patch }));
  // All namespaces (default) or one ranking; in the URL so a ranking survives reload and Back.
  const [params, setParams] = useSearchParams();
  const view = namespaceView(params.get('nsview'));
  const top = namespaceTop(params.get('ntop'));
  // Copied, not mutated: the object react-router hands the updater is its own.
  const setParam = (key: 'nsview' | 'ntop', value: string | null) =>
    setParams(
      prev => {
        const p = new URLSearchParams(prev);
        if (value === null) p.delete(key);
        else p.set(key, value);
        return p;
      },
      { replace: true }
    );
  const setView = (next: NamespaceView) => setParam('nsview', next === 'list' ? null : next);
  const setTop = (next: NamespaceTop) => setParam('ntop', next === 10 ? null : String(next));

  const util = useMemo(() => buildUtilizationModel(items, null, flattenPods).namespaces, [items]);
  const all = useMemo(
    () =>
      buildNamespaceTable(
        payload?.namespaces ?? [],
        status.state === 'unavailable' ? null : util,
        items,
        status.state === 'ok'
      ),
    [payload, util, items, status.state]
  );
  const rows = useMemo(() => filterNamespaceTable(all, filter), [all, filter]);
  // The scope the top-namespace tables rank over, so they answer the same filters as the table.
  // Not an option list, which is why it does not go through `namespacesOf`.
  const visible = useMemo(() => {
    const listed = rows.map(r => r.namespace);
    return new Set(listed);
  }, [rows]);
  const counts = useMemo(
    () => namespaceTypeCounts(payload?.namespaces ?? [], payload?.summary),
    [payload]
  );

  if (ns.error && !payload) return <ErrorBanner code={ns.error.code} message={ns.error.message} />;
  if (ns.initial && !payload) return <div className="h-[240px] animate-pulse rounded-[8px] bg-raised" />;
  if (!payload) return <></>;
  if (counts.list === 'unavailable') {
    return (
      <Empty
        title="Namespace list unavailable"
        hint="The cluster did not answer GET /api/v1/namespaces, so no namespace can be listed. This is an unread value, not an empty cluster."
      />
    );
  }

  const workloadsRead = status.state !== 'unavailable';
  const columns: Column<NamespaceTableRow>[] = [
    {
      key: 'ns',
      header: 'Namespace',
      pin: true,
      // Fits the longest name on platformsbx (`btp-platform-foundation`, 23 characters of 13px mono)
      // plus the card's 12px start inset and the cell's 16px end padding; a longer one truncates and
      // keeps its title. Fixed rather than capped, so no name moves the columns beside it.
      width: '212px',
      min: '212px',
      max: '212px',
      sortValue: r => r.namespace,
      render: r => (
        <span className="mono truncate text-[13px] font-medium" title={r.namespace}>
          {r.namespace}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      // Centred and fixed at the widest pill (`Critical`, `Warning`) plus the header's sort mark, so a
      // badge never moves its neighbours. The one centred Status in the console, by request.
      ...CENTER,
      width: '112px',
      min: '112px',
      max: '112px',
      sortValue: r => r.status,
      render: r => (
        <Pill size="sm" tone={STATUS_TONE[r.status]} title={r.statusReason}>
          {NAMESPACE_STATUS_LABEL[r.status]}
        </Pill>
      )
    },
    {
      key: 'workloads',
      header: 'Workloads',
      // 120px: the label with its sort mark (96px), the InfoTip and its 5px margin need 114px, so the
      // wrapper trims this header's padding to 2px a side. Held by `width` + `min` and uncapped: the
      // 50% meter pair takes all the spare room, and a count never outgrows it.
      ...CENTER,
      width: '120px',
      min: '120px',
      info: COLUMN_INFO.namespaceWorkloads,
      sortValue: r => r.workloads,
      render: r =>
        workloadsRead ? (
          <span className={`inline-flex items-center gap-1.5 ${r.workloads === 0 ? 'text-muted' : ''}`}>
            <Icon name="workloads" size={16} className="text-muted" />
            <span className="mono tabular-nums">{r.workloads}</span>
          </span>
        ) : (
          <span className="text-muted" title="The workloads read failed, so this count is unknown — not zero.">
            —
          </span>
        )
    },
    {
      key: 'cpu',
      // The dominant columns: every other column is fixed, so these two split what is left. The
      // over-full 50% pair is what makes them take all of it. Auto layout hands each its min-content
      // first and splits the rest, and the Memory header's min-content is 4px more than CPU's, so an
      // equal `min` above both is what makes the two equal.
      // Numeric, as the classifier reads them; the compact meter fills the cell and starts its bar and
      // figures at the left padding whatever the cell's text-align says.
      ...NUMERIC,
      width: '50%',
      min: '220px',
      header: 'CPU · Used/Req/Lim',
      info: COLUMN_INFO.namespaceCpu,
      render: r => <ResourceCellView row={r} metric="cpu" />
    },
    {
      key: 'mem',
      ...NUMERIC,
      width: '50%',
      min: '220px',
      header: 'Memory · Used/Req/Lim',
      info: COLUMN_INFO.namespaceMemory,
      render: r => <ResourceCellView row={r} metric="memory" />
    },
    {
      key: 'actions',
      ...ACTIONS,
      // 10px either side of the 24px button, set by the wrapper below. Uncapped for the same reason
      // as Workloads; the header is sr-only, so there is nothing to clip.
      width: '44px',
      min: '44px',
      // The row itself is the click target, so the column is one glyph wide; the word stays for a
      // screen reader. The `th` is `position: sticky`, which contains the sr-only span.
      header: <span className="sr-only">Actions</span>,
      render: r => {
        const empty = r.workloads === 0;
        const why = empty
          ? 'No Deployment, StatefulSet or DaemonSet here, so the Pods view would be empty.'
          : `Open Pods filtered to ${r.namespace}`;
        return (
          <button
            type="button"
            // The row's `onSelect` makes the same call; stopping here keeps it to one write.
            onClick={e => {
              e.stopPropagation();
              onOpenNamespace(r.namespace);
            }}
            disabled={empty}
            aria-label={why}
            title={why}
            className="inline-flex size-6 items-center justify-center rounded-[6px] border border-transparent text-muted transition-colors hover:border-line-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:text-muted"
          >
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
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        );
      }
    }
  ];

  const podLine =
    counts.pods === null ? (
      'pod count unavailable'
    ) : (
      <>
        <span className="font-medium tabular-nums text-text">{counts.pods}</span> pod{counts.pods === 1 ? '' : 's'}
      </>
    );

  return (
    <div className="space-y-3">
      <NamespaceViewSwitch value={view} onChange={setView} />
      {!metricsAvailable && (
        <p className="text-[13px] text-muted">
          metrics-server is not answering on this cluster, so used CPU and memory read as no sample. Requests and limits are
          read from the pod spec and remain exact.
        </p>
      )}
      {counts.list === 'truncated' && (
        <p className="text-[13px] text-warn">
          The namespace list came back short of the whole cluster, so this is not every namespace.
        </p>
      )}
      {status.state !== 'ok' && (
        <p className="text-[13px] text-warn">
          {status.why || 'The workloads read was incomplete'} — workload counts, status and CPU/memory are floors or unavailable.
        </p>
      )}

      <FilterBar
        activeCount={activeNamespaceFilters(filter) + (view !== 'list' && top !== 10 ? 1 : 0)}
        onReset={() => {
          setFilter(NO_NAMESPACE_FILTER);
          setTop(10);
        }}
        resultLine={
          <>
            <span className="whitespace-nowrap">
              <span className="font-medium tabular-nums text-text">
                {rows.length === all.length ? `${all.length}` : `${rows.length} of ${all.length}`}
                {counts.list === 'truncated' ? '+' : ''}
              </span>{' '}
              namespace{all.length === 1 ? '' : 's'} · {podLine}
              {hiddenSystemCount(filter, counts.system) > 0 && (
                <span className="text-muted"> · {hiddenSystemCount(filter, counts.system)} system hidden</span>
              )}
            </span>
          </>
        }
      >
        {/* Capped, or it grows into whatever the wrap leaves and the bar stops reading as one row. */}
        <label className="relative flex min-w-[180px] max-w-[300px] flex-1 [&>input]:min-w-[180px]">
          <span className="sr-only">Search namespaces</span>
          <SearchBox value={filter.search} onChange={v => set({ search: v })} placeholder="Search namespaces..." />
        </label>
        <FilterSelect
          label="Type"
          value={filter.type}
          onChange={v => setFilter(f => withType(f, v as NamespaceTableFilter['type']))}
          options={[
            { value: 'all', label: `All (${counts.total})` },
            { value: 'application', label: `Application (${counts.application})` },
            { value: 'system', label: `System (${counts.system})` },
            { value: 'other', label: `Other (${counts.other})` }
          ]}
        />
        <FilterSelect
          label="Status"
          value={filter.status}
          onChange={v => set({ status: v as NamespaceTableFilter['status'] })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'healthy', label: 'Healthy' },
            { value: 'warning', label: 'Warning' },
            { value: 'critical', label: 'Critical' },
            { value: 'empty', label: 'Empty' },
            { value: 'unknown', label: 'Unknown' }
          ]}
        />
        {view !== 'list' && (
          <FilterSelect
            label="Show"
            value={String(top)}
            onChange={v => setTop(namespaceTop(v))}
            options={NAMESPACE_TOPS.map(t => ({ value: String(t), label: t === 'all' ? 'All' : `Top ${t}` }))}
          />
        )}
        <FilterToggle
          label="Show system namespaces"
          checked={showsSystem(filter)}
          onChange={v => setFilter(f => withShowSystem(f, v))}
          title="Adds the namespaces the server classifies as system (Kubernetes, Istio, Kyma and the bootstrap tooling). Off by default, so the table opens on application namespaces."
        />
      </FilterBar>

      {view === 'list' ? (
        <>
      {/*
        One card surface for header, pinned column and rows. Scoped here: the arbitrary variants
        override `.tbl`'s flush outer edge and `.table-wrap`'s 8px gutter for this table only (no row is
        ever selected, so the gutter's selected-row bar has nothing to draw). The wrapper also breaks
        `.filter-bar + .table-block`, so the toolbar-row collapse that rule gives is restated, and the
        legend sits in that row's left half, where the hover-only tools leave empty space.
        Every header is centred over its column, by request, whatever its cells do: the `th` centres
        its inline label, and the sort button drops `.num`/`.ctr`'s full width so the label, sort mark
        and InfoTip centre as one run. The last column's padding is what makes it 44px.
      */}
      <div
        className={`${CARD_TABLE_CLASS} [&_th[data-col-key=workloads]]:px-[2px]`}
      >
        <span className="absolute left-0 top-0 flex h-[18px] items-center gap-1.5">
          <MeterLegend />
          <InfoTip text="Usage is summed over the pods that reported a sample, so with any pod silent it is a floor. Pods not selected by a Deployment, StatefulSet or DaemonSet are outside the figures." />
        </span>
        <DataTable
          id="namespaces"
          columns={columns}
          rows={rows}
          rowKey={r => r.namespace}
          shed="wide"
          onSelect={r => {
            if (r.workloads > 0) onOpenNamespace(r.namespace);
          }}
          empty={
            all.length === 0 ? (
              <Empty
                title="No namespace was returned"
                hint="The cluster answered the namespace list with nothing in it — treat this as a read to investigate."
              />
            ) : (
              <Empty
                title="No matching namespaces"
                hint={
                  hiddenSystemCount(filter, counts.system) > 0
                    ? `None of the ${all.length} namespaces match the current filters; ${hiddenSystemCount(filter, counts.system)} system namespaces are hidden. Turn on Show system namespaces to include them.`
                    : `None of the ${all.length} namespaces match the current filters.`
                }
              />
            )
          }
        />
      </div>
        </>
      ) : (
        <TopNamespaces
          metric={view}
          top={top}
          namespaces={status.state === 'unavailable' ? [] : util}
          visible={visible}
          workloadsRead={workloadsRead}
          metricsAvailable={metricsAvailable}
          onOpenTopConsumers={onOpenTopConsumers}
          onOpenNamespace={onOpenNamespace}
        />
      )}
    </div>
  );
}
