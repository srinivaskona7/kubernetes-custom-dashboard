/**
 * Namespaces & Workloads → Top Consumers: the pods using the most CPU, then the most memory.
 *
 * Reads nothing of its own: the usage figures are the workloads payload the page holds, and the
 * system-namespace flag and its toggle come from `WorkloadsArea`, which shares them with the Pods
 * sub-tab. The rules live in `top-consumers.ts`, where each one is tested.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Workloads } from '../../api';
import { Dot, Empty } from '../../components/ui';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { FilterBar, FilterSelect, FilterToggle } from '../../components/filters';
import { NamespaceFilter } from '../../components/NamespaceFilter';
import { useNamespaceSelection } from '../../components/use-namespace-selection';
import { ResourceLink } from '../../components/ResourceLink';
import type { MetricStatus } from '../../components/unavailable';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { COLUMN_INFO } from '../../components/table/column-info';
import { MeterLegend, ResourceMeter } from './ResourceMeter';
import { flattenPods } from './pod-inventory';
import { ALL_NAMESPACES, filterByNamespace } from './workload-filter';
import { FreshnessStrip } from './usage/FreshnessStrip';
import { PressureCell, share } from './usage/shared';
import { USAGE_SAMPLE_NOTE, buildUtilizationModel, type UtilizationPod } from './usage/utilization-model';
import {
  TOP_COUNTS,
  emptyReason,
  parseTop,
  podNameParts,
  rankConsumers,
  scopeConsumers,
  serializeTop,
  topFigures,
  unsampledNote,
  type Metric,
  type TopCount
} from './top-consumers';

export interface TopConsumersProps {
  workloads: Workloads;
  /** `WorkloadsArea`'s `useSystemNamespaces(id)` result — one read, shared with the Pods sub-tab. */
  system: ReadonlySet<string> | null;
  /** The system-namespace read has answered or failed; `system === null` then means it failed. */
  systemSettled: boolean;
  /** `WorkloadsArea`'s toggle, shared with Pods so switching sub-tab keeps it. */
  showSystem: boolean;
  onShowSystem: (v: boolean) => void;
  status: MetricStatus;
  namespaceOptions: readonly string[];
  fetchedAt: number | null;
  onRefresh: () => void;
  onViewLogs: (namespace: string, pod: string) => void;
  onWarmLogs: () => void;
}

export function TopConsumersSection(props: TopConsumersProps): JSX.Element {
  const { workloads, system, systemSettled, showSystem, onShowSystem, status, namespaceOptions, fetchedAt, onRefresh } = props;
  const [params, setParams] = useSearchParams();
  const top = parseTop(params.get('top'));
  const setTop = useCallback(
    (n: TopCount) =>
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          const v = serializeTop(n);
          if (v === null) p.delete('top');
          else p.set('top', v);
          return p;
        },
        { replace: true }
      ),
    [setParams]
  );

  const [namespaces, onNamespaces] = useNamespaceSelection('ns', namespaceOptions);

  const model = useMemo(
    () => buildUtilizationModel(workloads.items, workloads.summary?.pods, flattenPods),
    [workloads.items, workloads.summary?.pods]
  );
  const inNamespaces = useMemo(() => filterByNamespace(model.pods, namespaces), [model.pods, namespaces]);
  const scoped = useMemo(
    () => scopeConsumers(inNamespaces, system, showSystem, namespaces),
    [inNamespaces, system, showSystem, namespaces]
  );
  const empty = emptyReason({
    inNamespaces: inNamespaces.length,
    scoped: scoped.length,
    selected: namespaces.size,
    status
  });

  const metricsOff = workloads.metrics?.available === false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          activeCount={namespaces.size + (showSystem ? 1 : 0) + (top !== 10 ? 1 : 0)}
          onReset={() => {
            onNamespaces(ALL_NAMESPACES);
            onShowSystem(false);
            setTop(10);
          }}
          resultLine={`${scoped.length} pods in scope`}
        >
          <NamespaceFilter options={namespaceOptions} selected={namespaces} onChange={onNamespaces} />
          <FilterSelect
            label="Show"
            value={String(top)}
            onChange={v => setTop(parseTop(v))}
            options={TOP_COUNTS.map(n => ({ value: String(n), label: `Top ${n}` }))}
          />
          <FilterToggle
            label="Show system pods"
            checked={showSystem}
            onChange={onShowSystem}
            title="Shows pods in the namespaces the server classifies as system. A namespace you selected is always shown."
          />
        </FilterBar>
        <FreshnessStrip fetchedAt={fetchedAt} onRefresh={onRefresh} />
      </div>

      {metricsOff ? (
        <div className="rounded-[8px] border border-line bg-raised px-4 py-3">
          <p className="flex items-start gap-2 text-[13px] text-text">
            <span className="mt-[6px]">
              <Dot tone="warn" />
            </span>
            <span className="max-w-[110ch]">
              <span className="font-medium">Live usage unavailable.</span>{' '}
              {workloads.metrics?.reason ?? 'metrics-server did not answer for this snapshot.'} Nothing is ranked,
              because ranking by a declared request would put a different list under the same heading.
            </span>
          </p>
        </div>
      ) : empty ? (
        <Empty
          title="No pods to rank"
          hint={
            empty.kind === 'unavailable'
              ? `The workloads read for this snapshot was unavailable${status.why ? ` — ${status.why}` : ''}, so there is nothing to rank. This is not a count of zero.`
              : empty.kind === 'system'
                ? `All ${empty.hidden} pods in scope are in system namespaces. Turn on Show system pods to rank them.`
                : empty.kind === 'namespaces'
                  ? 'No pod in the selected namespaces belongs to a Deployment, StatefulSet or DaemonSet.'
                  : 'This cluster reported no pods belonging to a Deployment, StatefulSet or DaemonSet.'
          }
        />
      ) : (
        // Side by side where each half keeps its 567px ceiling (1440 and wider); stacked below that, so
        // a narrower window scrolls neither table sideways.
        <div className="grid grid-cols-1 gap-4 min-[1440px]:grid-cols-2">
          <ConsumerTable metric="cpu" pods={scoped} top={top} {...props} />
          <ConsumerTable metric="memory" pods={scoped} top={top} {...props} />
        </div>
      )}

      <div className="flex flex-col gap-1.5 border-t border-line pt-3 text-[12px] text-muted">
        <p className="max-w-[110ch]">{USAGE_SAMPLE_NOTE}</p>
        {status.state !== 'ok' && (
          <p className="flex items-start gap-2 text-warn">
            <span className="mt-[5px]">
              <Dot tone="warn" />
            </span>
            <span className="max-w-[110ch]">
              The workloads read for this snapshot was {status.state}
              {status.why ? ` — ${status.why}` : ''}. Rankings cover what was returned.
            </span>
          </p>
        )}
        {system === null && systemSettled && (
          <p>The namespace classification did not answer, so no pod is hidden as a system pod.</p>
        )}
        {model.coverage.outside > 0 && (
          <p className="max-w-[110ch]">
            {model.coverage.outside} of the {model.coverage.total} pods this cluster reported — Job, CronJob and
            standalone pods — belong to no Deployment, StatefulSet or DaemonSet and are not ranked.
          </p>
        )}
      </div>
    </div>
  );
}

function ConsumerTable({
  metric,
  pods,
  top,
  onViewLogs,
  onWarmLogs
}: { metric: Metric; pods: UtilizationPod[]; top: TopCount } & TopConsumersProps): JSX.Element {
  const { rows, unsampled } = useMemo(() => rankConsumers(pods, metric, top), [pods, metric, top]);
  const what = metric === 'cpu' ? 'CPU' : 'Memory';
  const rank = new Map(rows.map((p, i) => [p.key, i + 1]));

  const columns: Column<UtilizationPod>[] = [
    { key: 'rank', header: '#', ...NUMERIC, width: '56px', min: '56px', max: '56px', render: p => <span className="mono">{rank.get(p.key)}</span> },
    {
      // Namespace, pressure and Logs ride under the pod name: the two tables sit side by side, and
      // half the 1150px budget holds four columns, not eight. 56 + 194 + 212 (the compact meter's
      // 180px floor plus padding) + 104 = 566, the half-width wrap at 1440.
      key: 'pod',
      header: 'Pod',
      pin: true,
      width: '194px',
      min: '194px',
      max: '194px',
      render: p => {
        const { head, tail } = podNameParts(p.name);
        return (
          <span className="flex min-w-0 flex-col gap-0.5">
            <ResourceLink refTo={{ kind: 'Pod', namespace: p.namespace, name: p.name }}>
              <span className="flex min-w-0">
                <span className="truncate">{head}</span>
                <span className="shrink-0">{tail}</span>
              </span>
            </ResourceLink>
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
              <span className="mono truncate" title={`Namespace ${p.namespace}`}>
                {p.namespace}
              </span>
              {p.pressure.length > 0 && (
                <span className="shrink-0">
                  <PressureCell findings={p.pressure} />
                </span>
              )}
              <button
                type="button"
                onClick={() => onViewLogs(p.namespace, p.name)}
                title={`Read the log tail for ${p.namespace}/${p.name}`}
                className="ml-auto shrink-0 text-accent underline decoration-dotted underline-offset-[3px] hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              >
                Logs
              </button>
            </span>
          </span>
        );
      }
    },
    {
      key: metric,
      header: what,
      render: p => <ResourceMeter compact scope="pod" label={what} metric={metric} figures={topFigures(p, metric)} />
    },
    {
      key: 'share',
      // "Share", not "Share of cluster": the longer label needs 176px and this column prints four
      // characters. The tooltip names the denominator.
      header: 'Share',
      info: COLUMN_INFO.clusterShare,
      ...NUMERIC,
      width: '104px',
      min: '104px',
      max: '104px',
      render: p => <span className="mono">{share(metric === 'cpu' ? p.cpuShare : p.memoryShare)}</span>
    },
  ];

  return (
    <section aria-labelledby={`top-${metric}`} className="min-w-0">
      <h3 id={`top-${metric}`} className="mb-2 text-[14px] font-semibold text-text">
        Top {what}
      </h3>
      {rows.length === 0 ? (
        <Empty title={`No ${what} sample`} hint={`None of the ${pods.length} pods in scope reported a ${what} sample in this snapshot.`} />
      ) : (
        <div className={CARD_TABLE_CLASS} onPointerEnter={onWarmLogs}>
          <span className="absolute left-0 top-0 flex h-[18px] items-center gap-1.5">
            <MeterLegend />
          </span>
          <DataTable id={`top-${metric}`} columns={columns} rows={rows} rowKey={p => p.key} shed="wide" empty={null} />
        </div>
      )}
      {unsampledNote(unsampled, pods.length) && (
        <p className="mt-2 flex items-start gap-2 text-[12px] text-warn">
          <span className="mt-[5px]">
            <Dot tone="warn" />
          </span>
          <span>{unsampledNote(unsampled, pods.length)}</span>
        </p>
      )}
    </section>
  );
}
