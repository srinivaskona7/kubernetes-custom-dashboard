/**
 * Autoscaling & batch jobs, scoped to one cluster — the tab version of `Autoscaling.tsx`.
 *
 * Rendered as two sub-tabs of Namespaces & Workloads (`?tab=workloads&section=hpas|cronjobs`); it
 * was its own Autoscaling & Jobs tab until 2026-09-25. The strip is `WorkloadsArea`'s, so this
 * takes the active section as a prop and draws only its table and search box.
 *
 * No cluster picker, no fleet-wide summary tiles: the cluster is already known from the
 * page this renders inside. Fetches `api.clusterAutoscaling(id)` directly rather than the
 * fleet-wide `api.autoscaling()` + filter, since the server already scopes the read.
 *
 * `/clusters/:id/autoscaling` answers with the fan-out **envelope**, so the rows live at
 * `data.data.hpas`, not `data.hpas`. This file read the latter until `ClusterAutoscaling` was
 * corrected from `= FleetAutoscaling` to `ClusterGroupEnvelope<AutoscalingData>` — one level
 * too shallow, `undefined`, and therefore an empty table on every cluster with the compiler's
 * blessing. Nothing here should reach past `payload`.
 */
import { useCallback, useMemo, useState } from 'react';
import { COLUMN_INFO } from '../../components/table/column-info';
import { api } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { useAsync } from '../../useAsync';
import { ResourceLink, useRegisterResolver } from '../../components/ResourceLink';
import { makeAutoscalingResolver } from '../../resources/resolve';
import { Pill, ErrorBanner, ErrorState, Skeleton, TONE_TEXT } from '../../components/ui';
import { UnavailableEmptyBody, UnavailableNotice, envelopeScope } from '../../components/unavailable';
import { ago } from '../../format';
import { boundsLabel, hpaStatus, metricLine, replicaCount, replicaPressure } from './autoscaling-format';
import type { CronJobRow, HpaRow } from '../../api';

/**
 * What happens when a scheduled run is still going and the next one is due.
 *
 * `Allow` is the API default and is what an unset field means, so it is not a finding — but it
 * is the one that lets two runs of the same job overlap, which is worth seeing without opening
 * a detail panel. `Forbid` skips, `Replace` kills the running job.
 */
const CONCURRENCY_TONE: Record<string, 'ok' | 'warn' | 'unknown'> = {
  Forbid: 'ok',
  Replace: 'warn',
  Allow: 'unknown'
};

export default function AutoscalingTab({ id, section: activeTab }: { id: string; section: 'hpas' | 'cronjobs' }) {
  const { data, loading, error } = useAsync(useCallback(() => api.clusterAutoscaling(id), [id]), 0, id);
  const [search, setSearch] = useState('');

  useRegisterResolver(
    'autoscaling',
    useMemo(() => makeAutoscalingResolver(data?.ok ? data.data : undefined), [data])
  );

  const payload = data?.ok ? data.data : undefined;

  const filteredHpas = useMemo(() => {
    if (!payload?.hpas) return [];
    return payload.hpas.filter(
      h =>
        h.name.toLowerCase().includes(search.toLowerCase()) ||
        h.namespace.toLowerCase().includes(search.toLowerCase()) ||
        h.targetName.toLowerCase().includes(search.toLowerCase())
    );
  }, [payload?.hpas, search]);

  const filteredCronjobs = useMemo(() => {
    if (!payload?.cronjobs) return [];
    return payload.cronjobs.filter(
      c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.namespace.toLowerCase().includes(search.toLowerCase()) ||
        c.schedule.toLowerCase().includes(search.toLowerCase())
    );
  }, [payload?.cronjobs, search]);

  // Same reasoning as the fleet-wide page: HPAs and CronJobs are separate reads, so each
  // headline gets its own verdict rather than one page-wide one, scoped to this cluster only.
  const scope = useMemo(() => envelopeScope(id, payload?.summary), [payload?.summary, id]);
  // The completeness verdict for the HPA read — not an HPA's own status, which is `hpaStatus()`.
  const hpaReadState = scope.of('HorizontalPodAutoscalers', 'hpa', 'horizontalpodautoscalers');
  const cronStatus = scope.of('CronJobs', 'cronjobs');

  if (loading && !data) return <Skeleton rows={6} />;

  if (error && !data) {
    return (
      <div className="pb-4">
        <ErrorBanner code={error.code} message={error.message} />
      </div>
    );
  }

  if (data && !data.ok) {
    return (
      <ErrorState
        cluster={id}
        code={data.error?.code ?? 'UNKNOWN'}
        message={data.error?.message ?? 'this cluster did not answer'}
        needsReseed={data.error?.needsReseed}
      />
    );
  }

  /*
    Both tables are `DataTable`s now, and the HPA table lost its second detail surface with the
    migration. It had two: the row opened a local `DetailPanel`, and the name cell's `ResourceLink`
    opened the shared resource drawer — so clicking the name opened *both*, stacked, showing the
    same object twice in two different layouts. The drawer is the one every other Kind on this
    console uses and it already renders everything the panel did (`renderHpa` in
    resources/registry.tsx, which now carries each condition's message as well), so the panel is
    gone and the link is the single way in.
  */
  const hpaColumns: Column<HpaRow>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: h => h.name,
      render: h => <ResourceLink refTo={{ kind: 'HorizontalPodAutoscaler', namespace: h.namespace, name: h.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: h => h.namespace,
      render: h => <span className="text-muted">{h.namespace}</span>
    },
    {
      key: 'target',
      header: 'Target Workload',
      max: '260px',
      /*
        The first column to shed, and the only one on this row whose information is reachable from
        somewhere else *in the same row*: the `ResourceLink` on Name opens the HPA's drawer, whose
        Scale target field names this workload and links to it. Nothing else here has a second route.
      */
      priority: 3,
      sortValue: h => `${h.targetKind}/${h.targetName}`,
      title: h => `${h.targetKind}/${h.targetName}`,
      /*
        A Kind and a name are two different facts and used to render as one mono string, which gave
        `Deployment/istio-ingressgateway` no shape at all: the part that varies down the column is the
        name, and it started 80px in at a different offset on every row. The Kind is now a badge, so
        every name in the column starts at its own consistent left edge.
      */
      render: h => (
        <span className="flex items-center gap-2">
          <span className="shrink-0 rounded-[4px] border border-line bg-raised px-1.5 py-[1px] text-[11px] font-medium uppercase tracking-wide text-muted">
            {h.targetKind}
          </span>
          <span className="truncate text-[13px] text-text">{h.targetName}</span>
        </span>
      )
    },
    {
      /*
        The header used to spell the order out — "Replicas (Min / Max / Desired / Current)" — and that
        string alone made the column 315px wide. Then it was shortened to `Replicas` and the cell
        printed `3 / 15 / 3 / 3`, which is the same problem moved into the body: four numbers in one
        mono run, and the only way to tell which was which was to hover.

        Two lines instead. The counts an operator acts on are labelled on the first; the bounds, which
        are spec and change only when somebody edits them, are quiet helper text beneath. Both lines
        are 13px on purpose — a smaller second line in a `tabular-nums` column reads ragged however
        correct the alignment is.
      */
      key: 'replicas',
      header: 'Replicas (Current / Bounds)',
      ...NUMERIC,
      width: '180px',
      info: COLUMN_INFO.hpaReplicas,
      title: h =>
        `${replicaCount(h.currentReplicas)} current, ${replicaCount(h.desiredReplicas)} desired, ${
          boundsLabel(h.minReplicas, h.maxReplicas) ?? 'no bounds reported'
        }`,
      sortValue: h => replicaPressure(h),
      render: h => {
        const bounds = boundsLabel(h.minReplicas, h.maxReplicas);
        return (
          <span className="block leading-tight">
            <span className="mono block text-[13px] text-text">
              <span className="font-semibold">{replicaCount(h.currentReplicas)}</span>{' '}
              <span className="font-normal text-muted">current</span> ·{' '}
              <span className="font-semibold">{replicaCount(h.desiredReplicas)}</span>{' '}
              <span className="font-normal text-muted">desired</span>
            </span>
            {bounds && <span className="mono block text-[13px] text-muted">{bounds}</span>}
          </span>
        );
      }
    },
    {
      /*
        `Metric Thresholds` printed `Resource (cpu): 4% / 80%` and wrapped. Renamed because four of the
        five HPA metric types are not a utilisation at all — an `External` metric, which is what every
        KEDA scaler writes, is a queue depth — so "Target Utilization" would be a promise this column
        cannot keep. `align.ts` classifies `Scaling Metrics` as neither a magnitude nor an identity, so
        it renders left, which is where a subject-and-reading pair belongs.
      */
      key: 'metrics',
      header: 'Scaling Metrics',
      max: '240px',
      /*
        Sheds second, and only after Target. The metrics are a second copy of what the resource drawer
        prints, which is what makes them droppable at all — but this table is the only surface where a
        threshold appears without opening anything, so it survives one tier longer than Target.

        Replicas and Status carry no `priority` on purpose: nothing else on the row states either, and a
        table that has shed Replicas can no longer answer "is this autoscaler pinned at its ceiling",
        which is the question it exists for.
      */
      priority: 2,
      info: COLUMN_INFO.hpaMetrics,
      sortValue: h => h.metrics[0]?.kind ?? null,
      render: h =>
        h.metrics.length === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="block leading-tight">
            {h.metrics.map((m, idx) => {
              const line = metricLine(m);
              return (
                <span key={idx} className="block truncate text-[13px]" title={line.title}>
                  <span className="text-text">{line.subject}</span>{' '}
                  <span className={`mono ${TONE_TEXT[line.tone]}`}>{line.reading}</span>
                </span>
              );
            })}
          </span>
        )
    },
    {
      /*
        Seven states, not two — see `hpaStatus`. The pill used to say `Degraded` about an HPA whose
        conditions were empty (nobody had evaluated it) and `Active` about one pinned at its ceiling,
        which is the single reading this column exists to surface.
      */
      key: 'status',
      header: 'Status',
      sortValue: h => hpaStatus(h).rank,
      render: h => {
        const s = hpaStatus(h);
        return (
          <Pill tone={s.tone} title={s.title}>
            {s.label}
          </Pill>
        );
      }
    }
  ];

  const cronColumns: Column<CronJobRow>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: c => c.name,
      render: c => <ResourceLink refTo={{ kind: 'CronJob', namespace: c.namespace, name: c.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: c => c.namespace,
      render: c => <span className="text-muted">{c.namespace}</span>
    },
    {
      key: 'schedule',
      header: 'Schedule (Cron)',
      // 170px, not 160: the header needs 167px — 123px of label, 32px of cell padding and the 12px
      // sort mark `.th-sort` appends — so at 160 the column rendered `SCHEDULE (CRO…`. A cron
      // expression is the one value on this row an operator cannot reconstruct from the others, and
      // a clipped HEADER is worse than a clipped value: the label is the same for every row, so no
      // amount of hovering recovers it. `test/fleet/table-header-clip.test.js` owns the rule.
      max: '170px',
      sortValue: c => c.schedule,
      render: c => <span className="mono text-[13px] text-accent">{c.schedule}</span>
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: c => (c.suspend ? 0 : 1),
      render: c => <Pill tone={c.suspend ? 'unknown' : 'ok'}>{c.suspend ? 'Suspended' : 'Scheduled'}</Pill>
    },
    {
      // A concurrency policy is a spec detail, so it sheds first — see the tier note on the table.
      key: 'overlap',
      header: 'On overlap',
      priority: 3,
      sortValue: c => c.concurrencyPolicy,
      render: c => <Pill tone={CONCURRENCY_TONE[c.concurrencyPolicy] ?? 'unknown'}>{c.concurrencyPolicy}</Pill>
    },
    {
      key: 'active',
      header: 'Active Jobs',
      ...NUMERIC,
      sortValue: c => c.activeJobsCount,
      render: c => <span className="mono text-text">{c.activeJobsCount}</span>
    },
    {
      key: 'scheduled',
      header: 'Last Scheduled',
      ...NUMERIC,
      // Sorted on the timestamp, not on the "3d" the cell renders — and `null` (never scheduled)
      // lands last in both directions, which is where an absent value belongs.
      sortValue: c => (c.lastScheduleTime ? Date.parse(c.lastScheduleTime) : null),
      render: c => <span className="text-muted">{c.lastScheduleTime ? ago(c.lastScheduleTime) : 'Never'}</span>
    },
    {
      // Priority 2 rather than 3, because "it ran but never succeeded" is the sentence this table
      // exists to tell, and it needs both time columns to say it.
      key: 'successful',
      header: 'Last Successful',
      ...NUMERIC,
      priority: 2,
      sortValue: c => (c.lastSuccessfulTime ? Date.parse(c.lastSuccessfulTime) : null),
      render: c => <span className="text-ok">{c.lastSuccessfulTime ? ago(c.lastSuccessfulTime) : 'Never'}</span>
    },
    {
      key: 'age',
      header: 'Age',
      info: COLUMN_INFO.age,
      ...NUMERIC,
      priority: 3,
      sortValue: c => (c.createdAt ? Date.parse(c.createdAt) : null),
      render: c => <span className="text-muted">{c.createdAt ? ago(c.createdAt) : '—'}</span>
    }
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <UnavailableNotice scope={scope} className="mb-4" />

      {error && (
        <div className="pb-4">
          <ErrorBanner code={error.code} message={error.message} />
        </div>
      )}

      {/* Filter. The section strip above is WorkloadsArea's. */}
      <div className="flex items-center justify-end pb-3">
        <input
          type="text"
          placeholder="Filter by name, namespace, target..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-72 rounded-[6px] border border-line bg-raised px-3 py-1 text-[13px] text-text placeholder-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* Main Table */}
      <div className="flex-1 overflow-y-auto pb-4">
        {activeTab === 'hpas' && (
          /* `wide`, and two columns carrying a priority — the tier and the priorities are one
             mechanism and either alone does nothing. Six columns model 1216px of ceiling against the
             1167px container this table gets at 1440 with the rail expanded, so it has to be able to
             shed: above a 1300px container all six render (1216px, scrolling ~49px); at 1167 Target
             sheds and it fits at 956px; under 1000 — a detail panel open beside it — Metrics goes too,
             leaving 716px. Which column sheds first is argued at each column, not here. */
          <DataTable
            id="autoscaling.hpas"
            columns={hpaColumns}
            rows={filteredHpas}
            rowKey={h => h.id}
            shed="wide"
            empty={
              hpaReadState.state === 'ok' ? 'No HorizontalPodAutoscalers defined' : <UnavailableEmptyBody status={hpaReadState} />
            }
          />
        )}

        {activeTab === 'cronjobs' && (
          /* `wide`, chosen from the container width this table is given and never from its column
             count. Nine columns model 1269px against a 1167px container at 1440; `mid` sheds priority 3
             only below a 1000px container, so at 1167 its threshold never fires and the table scrolls
             with everything still rendered. `wide`'s first threshold is 1300px, which 1167 is under, so
             On-overlap and Age drop as they were designed to and the rest fits at 1029px. A tier picked
             from "nine columns, so mid" is exactly how that went wrong the first time. */
          <DataTable
            id="autoscaling.cronjobs"
            columns={cronColumns}
            rows={filteredCronjobs}
            rowKey={c => c.id}
            shed="wide"
            empty={cronStatus.state === 'ok' ? 'No CronJobs found' : <UnavailableEmptyBody status={cronStatus} />}
          />
        )}
      </div>
    </div>
  );
}
