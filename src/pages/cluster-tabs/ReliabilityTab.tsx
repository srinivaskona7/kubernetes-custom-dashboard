/**
 * Reliability — the cluster's five `reliability.js` findings: crashloops, rollout drift,
 * under-capacity Deployments, DaemonSet coverage, and zero-endpoint Services.
 *
 * There is no fleet-wide counterpart. `/reliability` (the fan-out route) exists on the server and has
 * no consumer in this app — the `pages/Reliability.tsx` this docstring used to name was removed, and
 * `pages/Drift.tsx` is a different feature over `/drift`, composed by the router from health,
 * workloads and modules rather than from this collector.
 *
 * One cluster is already known (the `id` prop), so there is no cluster picker and no "N clusters"
 * framing. `api.clusterReliability(id)` returns one envelope rather than a `clusters[]` array, so
 * completeness rides on the same `unavailableScope` single-cluster-slot shape ClusterDetail.tsx uses.
 */
import { Fragment, useCallback, useMemo, useState } from 'react';
import { COLUMN_INFO } from '../../components/table/column-info';
import { api } from '../../api';
import { ACTIONS, CENTER, DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { usePodLogs } from '../../components/pod-logs';
import { Btn, Card, CellList, Empty, ErrorState, Pair, Pill, Skeleton } from '../../components/ui';
import { Count, StatTile, UnavailableEmptyBody, UnavailableNotice, unavailableEntries, truncatedEntries, unavailableScope } from '../../components/unavailable';
import { useAsync } from '../../useAsync';
import { DriftInspector, type DriftSelection } from './DriftInspector';
import {
  driftListState,
  ownerResolutionReasonText,
  rolloutTabLabel,
  uncomparableTotal,
  type OwnerResolution,
  type PodDrift,
  type PodUncomparable
} from './image-drift';

// Wire shapes are typed loosely in api.ts (`unknown[]`) — these mirror reliability.js's
// actual `collect()` return.
interface CrashLoop {
  namespace: string;
  pod: string;
  container: string;
  restartCount: number;
  restartsPerHour: number;
  reason: string | null;
  detectedBy: 'waiting-reason' | 'recency';
}

interface DeploymentRollout {
  kind: 'Deployment';
  name: string;
  namespace: string;
  available: boolean;
  revisionInProgress: boolean;
  drifted: boolean;
  driftDetails: PodDrift[];
  /**
   * Pods on the old image because a rollout is *in flight* — the same per-container symptom as drift,
   * attributed to the revision instead. The collector pays for this distinction specifically so a
   * rolling update does not page anyone as a stuck image.
   */
  revisionDetails?: PodDrift[];
  /**
   * How `reliability.js` decided which pods belong to this Deployment. `'unavailable'` means the
   * pod → ReplicaSet → Deployment owner chain could not be built, so `drifted: false` and the
   * empty `driftDetails` below are not a clean verdict — see `image-drift.ts`. Optional because an
   * older backend sends no such field.
   */
  ownerResolution?: OwnerResolution;
  ownerResolutionReason?: string | null;
  /**
   * Containers looked at and not comparable — the live image is a bare image ID. The collector's own
   * rule is that a clean verdict needs `drifted: false` AND `uncomparableImages === 0`, so these are
   * surfaced rather than folded into the clean case.
   */
  uncomparableImages?: number;
  uncomparableDetails?: PodUncomparable[];
}

interface StatefulSetRollout {
  kind: 'StatefulSet';
  name: string;
  namespace: string;
  current: boolean;
}

interface DaemonSetCoverage {
  name: string;
  namespace: string;
  desiredNumberScheduled: number;
  numberAvailable: number;
  stuckRollout: boolean;
  underCovered: boolean;
}

interface UnderCapacity {
  name: string;
  namespace: string;
  desired: number;
  ready: number;
}

interface ZeroEndpointService {
  name: string;
  namespace: string;
  readyEndpoints: number;
}

type Tab = 'crashloops' | 'rollouts' | 'undercapacity' | 'daemonsets' | 'endpoints';

export default function ReliabilityTab({ id }: { id: string }): JSX.Element {
  const { data, error, initial, loading, reload } = useAsync(useCallback(() => api.clusterReliability(id), [id]), 0, id);
  const [activeTab, setActiveTab] = useState<Tab>('crashloops');
  const [search, setSearch] = useState('');
  // Which drift the inspector is open on. Local state, not `?res=`: the drawer's subject is a
  // *finding* on this tab's payload, not a Kind in the resource registry, and `?res=Deployment/…`
  // already means "show me the object" — a second meaning for the same parameter is how a deep link
  // starts opening the wrong panel.
  const [drift, setDrift] = useState<DriftSelection | null>(null);
  // The shared drawer, not a second log implementation: a crashlooping container is the one row on
  // this tab where the next question is always "what did it say before it died".
  const { openPodLogs } = usePodLogs();

  const d = data?.ok ? data.data : null;

  const crashLoops = (d?.crashLoops ?? []) as unknown as CrashLoop[];
  const deploymentRollouts = (d?.rollouts.deployments ?? []) as unknown as DeploymentRollout[];
  const statefulSetRollouts = (d?.rollouts.statefulSets ?? []) as unknown as StatefulSetRollout[];
  const daemonSets = (d?.daemonSets ?? []) as unknown as DaemonSetCoverage[];
  const underCapacity = (d?.underCapacity ?? []) as unknown as UnderCapacity[];
  const zeroEndpointServices = (d?.zeroEndpointServices ?? []) as unknown as ZeroEndpointService[];

  const driftedDeployments = useMemo(() => deploymentRollouts.filter(r => r.drifted), [deploymentRollouts]);
  /*
    Whether an empty drift table may be read as "nothing drifted".

    `reliability.js` returns `drifted: false` with empty detail arrays for every Deployment when the
    ReplicaSet read that the owner chain is built from failed or stopped at the paging ceiling — and
    `summary.driftedDeployments` is then `null` rather than 0. Believing the rows instead would print
    "No image-drifted Deployments" for a cluster on which drift was never evaluated.
  */
  const driftState = useMemo(() => driftListState(deploymentRollouts), [deploymentRollouts]);
  const driftUnknownReason = useMemo(
    () => deploymentRollouts.find(r => r.ownerResolution === 'unavailable')?.ownerResolutionReason ?? null,
    [deploymentRollouts]
  );
  /*
    The third state the drift table cannot hold: a Deployment whose live containers report a bare
    image ID was looked at and could not be compared, so it is neither drifted (no row) nor clean.
    Listed beside the table rather than in it — a row in a table headed "Image-drifted Deployments"
    would be a claim the collector did not make.
  */
  /*
    Summed from the per-rollout field rather than read from `summary.uncomparableImages`, which is
    `null` on an unread pod or ReplicaSet sweep. The two can only disagree in exactly that case — the
    unavailable path emits `uncomparableImages: 0` per entry, and an unread pod sweep produces no
    entries at all — and the notice below is gated on `driftState === 'ok'`, where they are equal. The
    per-rollout field is also what names WHICH Deployments, which the summary cannot.
  */
  const uncomparableCount = useMemo(() => uncomparableTotal(deploymentRollouts), [deploymentRollouts]);
  const uncomparableRollouts = useMemo(
    () => deploymentRollouts.filter(r => !r.drifted && (r.uncomparableImages ?? 0) > 0),
    [deploymentRollouts]
  );
  /*
    Deployments the collector deliberately kept OUT of the drift table: their pods are on the old
    image because the rollout is still running. Naming them is what stops the operator reading the
    absence as "and nothing else is mid-change" — the distinction is computed either way, and until
    now it was computed and thrown away.
  */
  const rollingOut = useMemo(
    () => deploymentRollouts.filter(r => (r.revisionDetails ?? []).length > 0),
    [deploymentRollouts]
  );  const staleStatefulSets = useMemo(() => statefulSetRollouts.filter(r => !r.current), [statefulSetRollouts]);
  const stuckDaemonSets = useMemo(() => daemonSets.filter(ds => ds.stuckRollout || ds.underCovered), [daemonSets]);

  const needle = search.trim().toLowerCase();
  const matches = (namespace: string, name: string) => !needle || `${namespace} ${name}`.toLowerCase().includes(needle);

  const filteredCrashLoops = useMemo(() => crashLoops.filter(c => matches(c.namespace, c.pod)), [crashLoops, needle]);
  const filteredDrifted = useMemo(() => driftedDeployments.filter(r => matches(r.namespace, r.name)), [driftedDeployments, needle]);
  const filteredStale = useMemo(() => staleStatefulSets.filter(r => matches(r.namespace, r.name)), [staleStatefulSets, needle]);
  const filteredUnderCapacity = useMemo(() => underCapacity.filter(u => matches(u.namespace, u.name)), [underCapacity, needle]);
  const filteredDaemonSets = useMemo(() => stuckDaemonSets.filter(ds => matches(ds.namespace, ds.name)), [stuckDaemonSets, needle]);
  const filteredEndpoints = useMemo(() => zeroEndpointServices.filter(s => matches(s.namespace, s.name)), [zeroEndpointServices, needle]);

  // The Rollouts pill: a count, or no count at all when the drift half was never evaluated.
  const rolloutsTab = rolloutTabLabel(driftState, filteredDrifted.length, filteredStale.length);

  // Same single-cluster-slot pattern ClusterDetail.tsx uses: the fleet page's `unavailableScope`
  // signature ({summary, clusters, cluster}) does not fit a one-envelope response, so the scope
  // is built from the one slot directly.
  const scope = useMemo(() => {
    if (!d) return unavailableScope({});
    return unavailableScope({
      clusters: [{ id, ok: true, unavailable: unavailableEntries(d.summary), truncated: truncatedEntries(d.summary) }]
    });
  }, [d, id]);

  const crashLoopStatus = scope.of('crashlooping containers', 'pods');
  const rolloutStatus = scope.of('rollout truth', 'pods', 'deployments', 'statefulsets');
  const underCapacityStatus = scope.of('under-capacity Deployments', 'pods', 'deployments');
  const daemonSetStatus = scope.of('DaemonSet coverage', 'pods', 'daemonsets');
  const endpointStatus = scope.of('zero-endpoint Services', 'pods', 'services', 'endpointslices');

  if (initial) return <Skeleton rows={8} />;

  if (!data) {
    return error ? <ErrorState code={error.code} message={error.message} /> : <Empty title="No reliability data" hint="Refresh to fetch this cluster's crashloop and rollout state." />;
  }

  if (!data.ok && data.error) {
    return <ErrorState cluster={id} code={data.error.code} message={data.error.message} needsReseed={data.error.needsReseed} />;
  }

  if (!d) return <Empty title="No reliability data" hint="Refresh to fetch this cluster's crashloop and rollout state." />;

  /*
    The six finding tables are `DataTable`s rather than hand-written `<table className="tbl">` markup.
    They rendered the same borders and header before — `.tbl` gave them that — and none of the
    behaviour the rest of the console has: no sortable headers, no resize, no Columns menu, no wrap
    mode, and no ceiling on a long pod name, which is the column a crashloop table is read by.

    Identity first, namespace second, which is the order every other pod and workload table on this
    console uses. The previous namespace-first order made these six the only tables where the row's
    own name was not the first thing on the row.

    Names are text rather than `ResourceLink`s deliberately: the drawer resolves a ref against data a
    *mounted* tab lends it, and this tab lends none — a Service link here would open a drawer saying
    it cannot find the object, which is the dead affordance the link was supposed to be.
  */
  const crashLoopColumns: Column<CrashLoop>[] = [
    {
      key: 'pod',
      header: 'Pod',
      pin: true,
      max: '220px',
      sortValue: c => c.pod,
      render: c => <span className="mono text-[13px] text-text">{c.pod}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: c => c.namespace,
      render: c => <span className="text-muted">{c.namespace}</span>
    },
    {
      key: 'container',
      header: 'Container',
      max: '150px',
      sortValue: c => c.container,
      render: c => <span className="mono text-[13px] text-text">{c.container}</span>
    },
    {
      key: 'restarts',
      header: 'Restarts',
      info: COLUMN_INFO.restarts,
      ...NUMERIC,
      sortValue: c => c.restartCount,
      render: c => <span className="mono text-bad">{c.restartCount}</span>
    },
    {
      key: 'rate',
      header: 'Restarts/hr',
      ...NUMERIC,
      sortValue: c => c.restartsPerHour,
      render: c => <span className="mono text-muted">{c.restartsPerHour}</span>
    },
    {
      key: 'reason',
      header: 'Reason',
      max: '180px',
      sortValue: c => c.reason,
      render: c => <span className="text-muted">{c.reason ?? '—'}</span>
    },
    {
      key: 'detectedBy',
      header: 'Detected by',
      priority: 2,
      max: '140px',
      sortValue: c => c.detectedBy,
      render: c => <span className="text-muted">{c.detectedBy}</span>
    },
    {
      key: 'act',
      ...ACTIONS,
      // `previous: true` — the log worth reading on a crashlooping container is the instance that
      // already died, and the drawer falls back to the live one when no previous instance exists.
      render: c => (
        <Btn onClick={() => openPodLogs({ cluster: id, namespace: c.namespace, pod: c.pod, container: c.container, previous: true })}>
          Logs
        </Btn>
      )
    }
  ];

  /** Open the inspector on one Deployment, optionally highlighting the pod that was clicked. */
  const openDrift = (r: DeploymentRollout, pod: string | null) => setDrift({ ...r, focusPod: pod });

  const driftColumns: Column<DeploymentRollout>[] = [
    {
      key: 'name',
      header: 'Deployment',
      pin: true,
      max: '220px',
      sortValue: r => r.name,
      render: r => <span className="font-medium text-text">{r.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: r => r.namespace,
      render: r => <span className="text-muted">{r.namespace}</span>
    },
    {
      /*
        Headed `Availability` rather than `Available`: `Available` is a count elsewhere on this
        console and the alignment classifier reads it as one, while this cell is the Deployment's
        Available condition — a state, which reads left.
      */
      key: 'available',
      header: 'Availability',
      sortValue: r => (r.available ? 1 : 0),
      render: r => <Pill tone={r.available ? 'ok' : 'bad'}>{r.available ? 'available' : 'unavailable'}</Pill>
    },
    {
      key: 'pods',
      // `Drifted pod names`, not `Drifted pods`: the cell is a list of names, and `pods` is a count
      // everywhere else on this console — the classifier reads the plural as a quantity and would
      // right-align it. Naming the column for what the cell holds is the fix; declaring `left`
      // against a header that says "count" only hides the disagreement.
      header: 'Drifted pod names',
      info: COLUMN_INFO.imageDrift,
      align: 'left',
      max: '260px',
      sortValue: r => r.driftDetails[0]?.pod ?? null,
      // Each name is its own control, so "why is *this* pod on the list" is one click rather than a
      // row click followed by a hunt down the panel. `stopPropagation` keeps it from also firing the
      // row's own select, which would open the same drawer with no pod highlighted.
      render: r => (
        <span className="mono text-[13px] text-bad">
          {r.driftDetails.length === 0 ? (
            <CellList items={[]} />
          ) : (
            r.driftDetails.map((dd, i) => (
              <Fragment key={dd.pod}>
                {i > 0 && ', '}
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    openDrift(r, dd.pod);
                  }}
                  className="underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                >
                  {dd.pod}
                </button>
              </Fragment>
            ))
          )}
        </span>
      )
    },
    {
      key: 'act',
      ...ACTIONS,
      render: r => <Btn onClick={() => openDrift(r, null)}>Inspect</Btn>
    }
  ];

  const staleColumns: Column<StatefulSetRollout>[] = [
    {
      key: 'name',
      header: 'StatefulSet',
      pin: true,
      max: '220px',
      sortValue: r => r.name,
      render: r => <span className="font-medium text-text">{r.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: r => r.namespace,
      render: r => <span className="text-muted">{r.namespace}</span>
    },
    {
      // `Revision state`, not `Revision`: the Helm tab's `Revision` column holds a number and is
      // right-aligned, and one label meaning two alignments is what makes a console feel assembled.
      key: 'revision',
      header: 'Revision state',
      render: () => <span className="text-warn">currentRevision ≠ updateRevision</span>
    }
  ];

  const underCapacityColumns: Column<UnderCapacity>[] = [
    {
      key: 'name',
      header: 'Deployment',
      pin: true,
      max: '220px',
      sortValue: u => u.name,
      render: u => <span className="font-medium text-text">{u.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: u => u.namespace,
      render: u => <span className="text-muted">{u.namespace}</span>
    },
    {
      key: 'ready',
      header: 'Ready / Desired',
      info: COLUMN_INFO.ready,
      // `CENTER`, not `NUMERIC`: the header already names the separator, so the label belongs over it.
      ...CENTER,
      // Sorted on the shortfall rather than on either number: two of three and twenty of thirty are
      // the same ratio and not the same incident.
      sortValue: u => u.desired - u.ready,
      render: u => (
        <Pair className="text-bad" a={u.ready} b={u.desired} title={`${u.ready} of ${u.desired} replicas ready`} />
      )
    }
  ];

  const daemonSetColumns: Column<DaemonSetCoverage>[] = [
    {
      key: 'name',
      header: 'DaemonSet',
      pin: true,
      max: '220px',
      sortValue: ds => ds.name,
      render: ds => <span className="font-medium text-text">{ds.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: ds => ds.namespace,
      render: ds => <span className="text-muted">{ds.namespace}</span>
    },
    {
      key: 'desired',
      header: 'Desired',
      ...NUMERIC,
      sortValue: ds => ds.desiredNumberScheduled,
      render: ds => <span className="mono text-muted">{ds.desiredNumberScheduled}</span>
    },
    {
      key: 'available',
      header: 'Available',
      ...NUMERIC,
      sortValue: ds => ds.numberAvailable,
      render: ds => <span className="mono text-muted">{ds.numberAvailable}</span>
    },
    {
      key: 'issue',
      header: 'Issue',
      max: '200px',
      sortValue: ds => `${ds.stuckRollout ? 0 : 1}${ds.underCovered ? 0 : 1}`,
      render: ds => (
        <span className="text-warn">
          {[ds.stuckRollout && 'stuck rollout', ds.underCovered && 'under-covered'].filter(Boolean).join(', ')}
        </span>
      )
    }
  ];

  const endpointColumns: Column<ZeroEndpointService>[] = [
    {
      key: 'name',
      header: 'Service',
      pin: true,
      max: '220px',
      sortValue: s => s.name,
      render: s => <span className="font-medium text-text">{s.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: s => s.namespace,
      render: s => <span className="text-muted">{s.namespace}</span>
    },
    {
      key: 'ready',
      header: 'Ready endpoints',
      ...NUMERIC,
      sortValue: s => s.readyEndpoints,
      render: s => <span className="mono text-bad">{s.readyEndpoints}</span>
    }
  ];

  return (
    <div className="space-y-4">
      <UnavailableNotice scope={scope} />

      {/*
        The collector's own one-word verdict on whether any of the five findings below mean
        anything. `unknown` is not "nothing found" — it is "the pod sweep failed, so every array
        is empty by construction". Every check here rides on that single read, and five separate
        em-dashes do not say the thing an operator needs to hear: the emptiness is ours, not the
        cluster's. `reliability.js` deliberately gates even `daemonSetCoverage` on it, which
        needs no pod data at all, so that one clean-looking panel cannot imply the others are.
      */}
      {d.summary.verdict === 'unknown' && (
        <div className="border-y border-warn/25 bg-warn/5 py-2.5 text-[13px]" role="status">
          <span className="font-medium text-warn">These five checks are inconclusive, not clean.</span>{' '}
          <span className="text-muted">
            The pod sweep for this cluster did not complete, so every finding below is empty because it was never
            computed — a crashlooping container would not appear here. Fix the pod read and refresh before drawing
            any conclusion from an empty panel.
          </span>
        </div>
      )}

      <div className="flex items-center justify-end">
        <Btn onClick={reload} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Btn>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile
          label="Crashlooping containers"
          status={crashLoopStatus}
          value={<Count status={crashLoopStatus} value={filteredCrashLoops.length} />}
          caption="Waiting-reason or a recent, repeated restart rate"
          valueClass={filteredCrashLoops.length > 0 ? 'text-bad' : 'text-text'}
        />
        <StatTile
          label="Drifted / stale rollouts"
          status={rolloutStatus}
          /*
            `null` — an em-dash — rather than the sum when drift is unknown. The drifted half of the
            sum would be a confident 0 that no read produced, and a tile is the one place on the page
            an operator reads without opening anything.
          */
          value={
            <Count
              status={rolloutStatus}
              value={driftState === 'unknown' ? null : filteredDrifted.length + filteredStale.length}
            />
          }
          caption={
            driftState === 'unknown'
              ? `Image drift was not evaluated on this cluster. ${filteredStale.length} StatefulSet${
                  filteredStale.length === 1 ? '' : 's'
                } on a stale revision.`
              : 'Deployments off-image or StatefulSets on a stale revision'
          }
          valueClass={filteredDrifted.length + filteredStale.length > 0 ? 'text-warn' : 'text-text'}
        />
        <StatTile
          label="Under-capacity Deployments"
          status={underCapacityStatus}
          value={<Count status={underCapacityStatus} value={filteredUnderCapacity.length} />}
          caption="Rollout finished, still short of desired replicas"
          valueClass={filteredUnderCapacity.length > 0 ? 'text-bad' : 'text-text'}
        />
        <StatTile
          label="DaemonSets not covering nodes"
          status={daemonSetStatus}
          value={<Count status={daemonSetStatus} value={filteredDaemonSets.length} />}
          caption="Stuck rollout or fewer available pods than desired"
          valueClass={filteredDaemonSets.length > 0 ? 'text-warn' : 'text-text'}
        />
        <StatTile
          label="Services with zero ready endpoints"
          status={endpointStatus}
          value={<Count status={endpointStatus} value={filteredEndpoints.length} />}
          caption="Excludes ExternalName Services by design"
          valueClass={filteredEndpoints.length > 0 ? 'text-bad' : 'text-text'}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex gap-2">
          {(
            [
              ['crashloops', `Crashloops (${filteredCrashLoops.length})`],
              /*
                No number at all when the drift half was not evaluated — see `rolloutTabLabel`, which
                owns that decision so a test can hold it.
              */
              ['rollouts', rolloutsTab.label, rolloutsTab.why],
              ['undercapacity', `Under capacity (${filteredUnderCapacity.length})`],
              ['daemonsets', `DaemonSets (${filteredDaemonSets.length})`],
              ['endpoints', `Zero-endpoint Services (${filteredEndpoints.length})`]
            ] as [Tab, string, string?][]
          ).map(([tab, label, why]) => (
            <button
              key={tab}
              type="button"
              title={why}
              onClick={() => setActiveTab(tab)}
              className={`rounded-[6px] px-3 py-1 text-[14px] font-medium transition-colors ${
                activeTab === tab ? 'bg-accent text-white' : 'text-muted hover:text-text'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter by namespace or name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-64 rounded-[6px] border border-line bg-raised px-3 py-1 text-[13px] text-text placeholder-muted focus:border-accent focus:outline-none"
        />
      </div>

      {activeTab === 'crashloops' && (
        <Card title="Crashlooping containers" flush>
          <DataTable
            id="reliability.crashloops"
            columns={crashLoopColumns}
            rows={filteredCrashLoops}
            rowKey={c => `${c.namespace}/${c.pod}/${c.container}`}
            empty={
              crashLoopStatus.state === 'ok' ? (
                <Empty title="No crashlooping containers" />
              ) : (
                <UnavailableEmptyBody status={crashLoopStatus} />
              )
            }
          />
        </Card>
      )}

      {activeTab === 'rollouts' && (
        <div className="space-y-4">
          <Card title="Image-drifted Deployments" flush>
            <DataTable
              id="reliability.drift"
              columns={driftColumns}
              rows={filteredDrifted}
              rowKey={r => `${r.namespace}/${r.name}`}
              selectedKey={drift ? `${drift.namespace}/${drift.name}` : null}
              onSelect={r => openDrift(r, null)}
              empty={
                driftState === 'unknown' ? (
                  <Empty
                    title="Image drift could not be evaluated"
                    hint={`This is not an empty list. Which pods belong to a Deployment is resolved through the pod → ReplicaSet → Deployment owner chain, and ${ownerResolutionReasonText(
                      driftUnknownReason
                    )} No drift verdict was computed for any Deployment on this cluster — a stale image would not appear here. This console does not fall back to matching pods by label selector, because overlapping selectors report drift that does not exist.`}
                  />
                ) : rolloutStatus.state === 'ok' ? (
                  <Empty title="No image-drifted Deployments" />
                ) : (
                  <UnavailableEmptyBody status={rolloutStatus} />
                )
              }
            />
          </Card>

          {/*
            Not a table and not an error: the read succeeded, and these containers cannot be compared
            at all. Each name opens the same inspector, which is where the two references and the
            collector's own sentence are — a count with no way to see what it counts is a dead end.
          */}
          {driftState === 'ok' && uncomparableCount > 0 && (
            <p className="border-y border-line bg-raised/40 py-2.5 text-[13px]" role="status">
              <span className="font-medium text-text">
                {uncomparableCount} container{uncomparableCount === 1 ? '' : 's'} could not be compared with{' '}
                {uncomparableCount === 1 ? 'its' : 'their'} template.
              </span>{' '}
              <span className="text-muted">
                The running container reports a bare image ID instead of an image reference, so it is neither
                drifted nor confirmed matching. A restart does not change that.
              </span>{' '}
              {uncomparableRollouts.map((r, i) => (
                <Fragment key={`${r.namespace}/${r.name}`}>
                  {i > 0 && <span className="text-muted">, </span>}
                  <button
                    type="button"
                    onClick={() => openDrift(r, null)}
                    className="mono text-[13px] underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  >
                    {r.name}
                  </button>
                </Fragment>
              ))}
            </p>
          )}

          {/*
            Not a finding either: these pods are on the old image because the rollout is still
            running, which the collector separates from drift on purpose. Text only — there is no
            comparison to open, and a button leading to a drawer that would call this drift would
            undo the separation.
          */}
          {driftState === 'ok' && rollingOut.length > 0 && (
            <p className="border-y border-line bg-raised/40 py-2.5 text-[13px]" role="status">
              <span className="font-medium text-text">
                {rollingOut.length} Deployment{rollingOut.length === 1 ? '' : 's'} mid-rollout, excluded from the
                table above.
              </span>{' '}
              <span className="text-muted">
                Their pods are still on the old image because the rollout has not finished — a rolling update in
                flight, not a stuck one. Refresh in a minute: if a name is still here, that is when it is worth
                looking at.
              </span>{' '}
              <span className="mono text-[13px] text-muted">
                {rollingOut.map(r => `${r.namespace}/${r.name}`).join(', ')}
              </span>
            </p>
          )}

          <Card title="StatefulSets on a stale revision" flush>
            <DataTable
              id="reliability.stale"
              columns={staleColumns}
              rows={filteredStale}
              rowKey={r => `${r.namespace}/${r.name}`}
              empty={
                rolloutStatus.state === 'ok' ? (
                  <Empty title="No StatefulSets on a stale revision" />
                ) : (
                  <UnavailableEmptyBody status={rolloutStatus} />
                )
              }
            />
          </Card>
        </div>
      )}

      {activeTab === 'undercapacity' && (
        <Card title="Under-capacity Deployments" flush>
          <DataTable
            id="reliability.undercapacity"
            columns={underCapacityColumns}
            rows={filteredUnderCapacity}
            rowKey={u => `${u.namespace}/${u.name}`}
            empty={
              underCapacityStatus.state === 'ok' ? (
                <Empty title="No Deployment is short of its desired replicas" />
              ) : (
                <UnavailableEmptyBody status={underCapacityStatus} />
              )
            }
          />
        </Card>
      )}

      {activeTab === 'daemonsets' && (
        <Card title="DaemonSet coverage" flush>
          <DataTable
            id="reliability.daemonsets"
            columns={daemonSetColumns}
            rows={filteredDaemonSets}
            rowKey={ds => `${ds.namespace}/${ds.name}`}
            empty={
              daemonSetStatus.state === 'ok' ? (
                <Empty title="Every DaemonSet covers the nodes it targets" />
              ) : (
                <UnavailableEmptyBody status={daemonSetStatus} />
              )
            }
          />
        </Card>
      )}

      {activeTab === 'endpoints' && (
        <Card title="Services with zero ready endpoints" flush>
          <DataTable
            id="reliability.endpoints"
            columns={endpointColumns}
            rows={filteredEndpoints}
            rowKey={s => `${s.namespace}/${s.name}`}
            empty={
              endpointStatus.state === 'ok' ? (
                <Empty title="No Service has zero ready endpoints" />
              ) : (
                <UnavailableEmptyBody status={endpointStatus} />
              )
            }
          />
        </Card>
      )}
      {/*
        Mounted from the tab body, not from inside the Card: `.table-wrap` sets `overflow-x: auto`,
        which computes `overflow-y` to `auto` and clips a panel positioned inside it.
      */}
      {drift && <DriftInspector selection={drift} onClose={() => setDrift(null)} />}
    </div>
  );
}
