/**
 * Taints and Tolerations — the two halves of one scheduling constraint, as two sub-tabs.
 *
 * Owns its own read for the same reason `CapacitySection` does: keeping the fetch here keeps the
 * failure modes separate, so a refused pod list leaves the taint inventory standing.
 *
 * The three rules that shape what is on screen, all of them things a correct-looking table gets
 * wrong:
 *
 *  1. **A toleration is permission, not placement.** The node column says where a pod is; it never
 *     says a toleration put it there. The taint table carries two counts for the same reason —
 *     pods that *may* land on a node, and pods that *are* on it — because collapsing them into one
 *     number turns a permission into a scheduling claim.
 *  2. **An empty toleration field is a wildcard.** `Exists` with no key tolerates everything. Every
 *     such row is labelled rather than rendered as blanks; see `taint-labels.ts`.
 *  3. **Zero taints is a real answer.** On a managed cluster it is the common one. It renders as a
 *     statement about the cluster, and only an unread node list renders as unknown.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, type PodToleration, type TolerantPod } from '../../api';
import { Empty, ErrorState, Pill, Skeleton, type Tone } from '../../components/ui';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { useAsync } from '../../useAsync';
import { COLUMN_INFO } from '../../components/table/column-info';
import {
  effectMeaning,
  taintText,
  taintsHeadline,
  tolerationSortRank,
  tolerationState,
  tolerationStateText,
  tolerationText,
  tolerationsHeadline
} from './taint-labels';

/** The tone for a toleration's state. Never green: a toleration is not a health signal. */
function stateTone(state: ReturnType<typeof tolerationState>): Tone {
  switch (state) {
    // Warn, not bad: a universal toleration is legitimate and often required (a CNI DaemonSet
    // needs one). It is flagged because it is the broadest permission on the page, not because
    // it is wrong.
    case 'universal':
      return 'warn';
    case 'active':
      return 'accent';
    case 'unchecked':
      return 'unknown';
    // An inert toleration grants nothing today and is not a finding, so it takes the quietest
    // tone the palette has rather than a colour that implies a verdict.
    default:
      return 'unknown';
  }
}

export default function NodeTaintsSection({
  id,
  view
}: {
  id: string;
  view: 'taints' | 'tolerations';
}): JSX.Element {
  const topo = useAsync(useCallback(() => api.clusterTopology(id), [id]), 0, `${id}:${view}`);
  const data = topo.data?.ok ? topo.data.data : null;
  const t = data?.taints ?? null;

  /**
   * Off by default. Every pod on every cluster carries the two injected tolerations, so the
   * unfiltered list is the whole pod inventory and ranks nothing — 120 of 120 on the cluster this
   * was built against. The view stays reachable rather than being deleted, because "this pod has
   * only the defaults" is a real answer to a real question.
   */
  const [showAll, setShowAll] = useState(false);

  const pods = useMemo(() => {
    const all = t?.pods ?? [];
    const rows = showAll ? all : all.filter(p => p.tolerations.length > 0);
    // Broadest permission first: a universal toleration is the one worth seeing, and sorting by
    // pod name would bury 42 of them among 120 rows.
    return [...rows].sort((a, b) => {
      const ra = Math.min(...(a.tolerations.length ? a.tolerations.map(tolerationSortRank) : [9]));
      const rb = Math.min(...(b.tolerations.length ? b.tolerations.map(tolerationSortRank) : [9]));
      if (ra !== rb) return ra - rb;
      return (a.namespace ?? '').localeCompare(b.namespace ?? '') || (a.name ?? '').localeCompare(b.name ?? '');
    });
  }, [t, showAll]);

  if (topo.loading) return <Skeleton />;
  if (topo.error) return <ErrorState code={topo.error.code} message={topo.error.message} />;
  if (!t) {
    return (
      <Empty
        title="Taints were not reported"
        hint="This cluster's topology read returned no taint section. Nothing can be said about taints or tolerations from it — this is not the same as the cluster having none."
      />
    );
  }

  const taintColumns: Column<(typeof t.taints)[number]>[] = [
    {
      key: 'node',
      header: 'Node',
      max: '260px',
      render: r => <span className="mono text-[12px]">{r.node ?? '—'}</span>
    },
    {
      key: 'taint',
      header: 'Taint',
      max: '280px',
      render: r => <span className="ns-tag mono">{taintText(r)}</span>
    },
    {
      key: 'effect',
      header: 'Effect',
      max: '170px',
      render: r => (
        <span title={effectMeaning(r.effect)} className="text-[12px]">
          {r.effect ?? <span className="text-warn">no effect</span>}
        </span>
      )
    },
    {
      key: 'tolerating',
      header: 'Pods tolerating',
      info: COLUMN_INFO.podsTolerating,
      priority: 2,
      ...NUMERIC,
      render: r => <span className="mono tabular-nums">{r.podsTolerating}</span>
    },
    {
      key: 'placed',
      header: 'Pods on node',
      info: COLUMN_INFO.podsOnTaintedNode,
      priority: 2,
      ...NUMERIC,
      render: r => <span className="mono tabular-nums">{r.podsOnNode}</span>
    }
  ];

  const podColumns: Column<TolerantPod>[] = [
    {
      key: 'pod',
      header: 'Pod',
      max: '280px',
      render: p => <span className="mono text-[12px]">{p.name ?? '—'}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '190px',
      render: p => <span className="ns-tag mono">{p.namespace ?? '—'}</span>
    },
    {
      key: 'node',
      header: 'Node',
      info: COLUMN_INFO.tolerationNode,
      max: '220px',
      render: p => <span className="mono text-[12px]">{p.node ?? <span className="text-muted">unscheduled</span>}</span>
    },
    {
      key: 'tolerations',
      header: 'Tolerations',
      info: COLUMN_INFO.podTolerations,
      max: '340px',
      render: p =>
        p.tolerations.length === 0 ? (
          <span className="text-[12px] text-muted" title={`Only the ${p.injectedCount} tolerations Kubernetes injects into every pod.`}>
            defaults only
          </span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {p.tolerations.map((x: PodToleration, i: number) => {
              const state = tolerationState(x);
              return (
                <Pill
                  key={`${x.key ?? '*'}:${x.effect ?? '*'}:${i}`}
                  tone={stateTone(state)}
                  title={`${tolerationText(x)}\n\n${tolerationStateText(state)}`}
                >
                  {x.universal ? 'any taint' : (x.key ?? 'any taint')}
                  {x.effect ? `:${x.effect}` : ''}
                </Pill>
              );
            })}
          </div>
        )
    },
    {
      key: 'count',
      header: 'Declared',
      priority: 3,
      ...NUMERIC,
      render: p => <span className="mono tabular-nums">{p.tolerations.length}</span>
    }
  ];

  if (view === 'taints') {
    // The headline and the empty state say the same sentence, so only one of them renders. With a
    // populated table the paragraph is the summary above it; with no taints the Empty carries it,
    // and printing both put the identical paragraph on screen twice.
    return (
      <div className="space-y-4">
        {t.taints.length === 0 ? (
          <Empty title="No node declares a taint" hint={taintsHeadline(t.summary)} />
        ) : (
          <>
            <p className="text-[13px] text-muted">{taintsHeadline(t.summary)}</p>
            <DataTable
              columns={taintColumns}
              rows={t.taints}
              rowKey={r => `${r.node}/${r.id}`}
              shed="mid"
              empty={<Empty title="No taints" hint={taintsHeadline(t.summary)} />}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">{tolerationsHeadline(t.summary)}</p>
      <label className="flex items-center gap-2 text-[12px] text-muted">
        <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
        Include pods whose only tolerations are the two Kubernetes injects
        {t.summary.podsRead !== null && t.summary.podsWithAuthoredTolerations !== null && (
          <span className="mono">
            ({t.summary.podsRead - t.summary.podsWithAuthoredTolerations} more)
          </span>
        )}
      </label>
      {pods.length === 0 ? (
        <Empty
          title="No pod declares a toleration of its own"
          hint="Every pod here carries only the not-ready and unreachable tolerations Kubernetes injects. Nothing on this cluster is asking for access to a tainted node."
        />
      ) : (
        <DataTable
          columns={podColumns}
          rows={pods}
          rowKey={p => `${p.namespace}/${p.name}`}
          shed="mid"
          empty={<Empty title="No pods" hint={tolerationsHeadline(t.summary)} />}
        />
      )}
    </div>
  );
}
