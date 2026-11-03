/**
 * Namespaces → "Top by CPU" / "Top by memory": one ranking at a time, picked by the view switch.
 *
 * Ranked by live usage only (`top-namespaces.ts`); the bar is each namespace against the top row,
 * so request and limit never enter it. A namespace name opens its Top Consumers (the pods behind the
 * number); "Pods" opens the Pods sub-tab on it. Reads nothing of its own.
 */
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { Empty } from '../../components/ui';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { COLUMN_INFO } from '../../components/table/column-info';
import { share } from './usage/shared';
import type { UtilizationNamespace } from './usage/utilization-model';
import type { Metric } from './top-consumers';
import {
  namespaceTopLabel,
  namespaceUsage,
  rankNamespaces,
  rankedEmpty,
  usageBar,
  usageText,
  type NamespaceTop,
  type NamespaceView
} from './top-namespaces';

const VIEWS: readonly { view: NamespaceView; label: string; title: string }[] = [
  { view: 'list', label: 'All namespaces', title: 'Every namespace the filters list, with its workloads, status and resources' },
  { view: 'cpu', label: 'Top by CPU', title: 'The namespaces using the most CPU now, summed over their pods. Requests and limits are not used.' },
  { view: 'memory', label: 'Top by memory', title: 'The namespaces using the most memory now, summed over their pods. Requests and limits are not used.' }
];

/** All namespaces | Top by CPU | Top by memory. */
export function NamespaceViewSwitch({ value, onChange }: { value: NamespaceView; onChange: (next: NamespaceView) => void }): JSX.Element {
  return (
    <div role="group" aria-label="Namespaces view" className="inline-flex items-center gap-1">
      {VIEWS.map(v => {
        const active = v.view === value;
        return (
          <button
            key={v.view}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(v.view)}
            title={v.title}
            className={`inline-flex h-7 items-center rounded-[6px] border px-2.5 text-[12px] transition-colors ${
              active ? 'border-accent bg-accent/10 text-text' : 'border-line text-muted hover:border-line-strong hover:text-text'
            }`}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

export function TopNamespaces({
  metric,
  top,
  namespaces,
  visible,
  metricsAvailable,
  workloadsRead,
  onOpenTopConsumers,
  onOpenNamespace
}: {
  metric: Metric;
  /** How many rows, from the toolbar's Show picker (`?ntop=`). */
  top: NamespaceTop;
  namespaces: readonly UtilizationNamespace[];
  /** The namespaces the filters list, so the ranking answers the same scope as the list view. */
  visible: ReadonlySet<string>;
  metricsAvailable: boolean;
  /** False when the workloads read failed: the empty state names that read, not the sample. */
  workloadsRead: boolean;
  onOpenTopConsumers: (namespace: string) => void;
  onOpenNamespace: (namespace: string) => void;
}): JSX.Element {
  const what = metric === 'cpu' ? 'CPU' : 'Memory';
  const { rows, unsampled } = metricsAvailable ? rankNamespaces(namespaces, visible, metric, top) : { rows: [], unsampled: 0 };
  const max = rows[0] ? (namespaceUsage(rows[0], metric) ?? 0) : 0;
  const rank = new Map(rows.map((r, i) => [r.namespace, i + 1]));

  const columns: Column<UtilizationNamespace>[] = [
    { key: 'rank', header: '#', ...NUMERIC, width: '56px', min: '56px', max: '56px', render: r => <span className="mono">{rank.get(r.namespace)}</span> },
    {
      key: 'namespace',
      header: 'Namespace',
      pin: true,
      // The ranking has the section's full width, so the longest platformsbx name
      // (`sap-transp-proxy-system`, 23 characters) fits beside its "N pods · Pods" line.
      width: '280px',
      min: '280px',
      max: '280px',
      render: r => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onOpenTopConsumers(r.namespace)}
            title={`Top ${what} pods in ${r.namespace}`}
            className="truncate text-left underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            {r.namespace}
          </button>
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            <span className="tabular-nums">
              {r.pods} pod{r.pods === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={() => onOpenNamespace(r.namespace)}
              title={`Open the Pods sub-tab on ${r.namespace}`}
              className="ml-auto shrink-0 text-accent underline decoration-dotted underline-offset-[3px] hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              Pods
            </button>
          </span>
        </span>
      )
    },
    {
      key: metric,
      header: what,
      render: r => (
        <span className="flex min-w-[180px] flex-col gap-1" title={r.usageMissing > 0 ? `${r.usageMissing} of its pods reported no sample, so this is a floor` : undefined}>
          <span className="mono text-[13px] text-text">{usageText(r, metric)}</span>
          <span className="relative h-[6px] w-full rounded-[3px] bg-line-strong/70" aria-hidden="true">
            <span
              className="absolute inset-y-0 left-0 rounded-[3px] bg-ok"
              style={{ width: `${usageBar(namespaceUsage(r, metric) ?? 0, max) * 100}%` }}
            />
          </span>
        </span>
      )
    },
    {
      key: 'share',
      header: 'Share',
      info: COLUMN_INFO.namespaceShare,
      ...NUMERIC,
      width: '104px',
      min: '104px',
      max: '104px',
      render: r => <span className="mono">{share(metric === 'cpu' ? r.cpuShare : r.memoryShare)}</span>
    }
  ];

  return (
    <section aria-labelledby={`top-ns-${metric}`} className="min-w-0">
      <h3 id={`top-ns-${metric}`} className="mb-2 text-[14px] font-semibold text-text">
        {namespaceTopLabel(top, metric, rows.length)}
      </h3>
      {rows.length === 0 ? (
        <Empty {...rankedEmpty({ metricsAvailable, workloadsRead, listed: visible.size, metric })} />
      ) : (
        <div className={CARD_TABLE_CLASS}>
          <DataTable id={`top-ns-${metric}`} columns={columns} rows={rows} rowKey={r => r.namespace} shed="wide" empty={null} />
        </div>
      )}
      {unsampled > 0 && (
        <p className="mt-2 text-[12px] text-muted">
          {unsampled} listed namespace{unsampled === 1 ? '' : 's'} reported no {what} sample and {unsampled === 1 ? 'is' : 'are'} not ranked.
        </p>
      )}
    </section>
  );
}
