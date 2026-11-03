/**
 * Storage & resource quotas, scoped to one cluster.
 *
 * Reads `api.clusterStorage(id)`, **not** the fleet-wide `api.storage()` it used to filter in
 * the browser. Two reasons, and the first is not efficiency:
 *
 *   1. `GET /storage` re-derives its own summary as five fleet totals and drops
 *      `defaultStorageClassState`, `limitRangesCount`, `limitRanges` and `quotaCoverage` on the
 *      floor. StorageClasses and LimitRanges were being *read on every poll and never shown*.
 *      The per-cluster route is the only place those four facts exist.
 *   2. One cluster's read instead of the whole fleet's, landing on the `stor:<id>:*` cache
 *      entry the Overview tile already primed.
 *
 * The `Cluster` column stays dropped — the server scopes the read now, so there is nothing to
 * filter and no second cluster's rows to disambiguate.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, type PvcRow, type DefaultStorageClassState } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { useAsync } from '../../useAsync';
import { SubTabs, useSection } from '../../components/SubTabs';
import { TAB_SECTIONS } from './tabs';
import { ResourceLink, useRegisterResolver } from '../../components/ResourceLink';
import { makeStorageResolver } from '../../resources/resolve';
import { CellList, ErrorBanner, ErrorState, Pill, Skeleton, type Tone } from '../../components/ui';
import {
  Count,
  MetricValue,
  StatTile,
  UnavailableEmptyBody,
  UnavailableNotice,
  Unavailable,
  envelopeScope
} from '../../components/unavailable';
import { ago, bytes } from '../../format';
import { COLUMN_INFO } from '../../components/table/column-info';
import {
  capacityLabel,
  pvcCapacityBytes,
  pvcSearchText,
  quotaDimensionLabel,
  quotaSourceNote,
  quotaSourceTone,
  quotaWireOf,
  storageClassIsAbsent,
  storageClassLabel
} from './storage-cells';

type StorageSection = 'pvcs' | 'quotas' | 'limitranges';

/**
 * The four states a default StorageClass can be in, and how each should read.
 *
 * `unavailable` is not `missing`. "No StorageClass is marked default" is a finding an operator
 * can act on; "we could not list StorageClasses" is a gap in our knowledge and must never be
 * drawn as the finding — that is the same false-confidence bug as a refused read rendering 0.
 */
const SC_TONE: Record<DefaultStorageClassState['state'], Tone> = {
  ready: 'ok',
  missing: 'warn',
  ambiguous: 'bad',
  unavailable: 'unknown'
};

const SC_WORD: Record<DefaultStorageClassState['state'], string> = {
  ready: 'Default set',
  missing: 'No default',
  ambiguous: 'Ambiguous',
  unavailable: 'Unread'
};

const STORAGE_SECTIONS = TAB_SECTIONS.storage;

export default function StorageTab({ id }: { id: string }) {
  const { data, loading, error } = useAsync(useCallback(() => api.clusterStorage(id), [id]), 0, id);
  const [search, setSearch] = useState('');
  // URL-backed for the same reason `?tab=` is — see components/SubTabs.tsx.
  const [activeTab, setActiveTab] = useSection<StorageSection>(STORAGE_SECTIONS, STORAGE_SECTIONS[0].id);

  useRegisterResolver('storage', useMemo(() => makeStorageResolver(data?.ok ? data.data : undefined), [data]));

  const payload = data?.ok ? data.data : undefined;
  const summary = payload?.summary;
  const needle = search.trim().toLowerCase();

  const filteredPvcs = useMemo(() => {
    if (!payload?.pvcs) return [];
    if (!needle) return payload.pvcs;
    return payload.pvcs.filter(p => pvcSearchText(p).includes(needle));
  }, [payload?.pvcs, needle]);

  const filteredQuotas = useMemo(() => {
    if (!payload?.quotas) return [];
    if (!needle) return payload.quotas;
    return payload.quotas.filter(
      q => q.name.toLowerCase().includes(needle) || q.namespace.toLowerCase().includes(needle)
    );
  }, [payload?.quotas, needle]);

  const filteredLimitRanges = useMemo(() => {
    if (!payload?.limitRanges) return [];
    if (!needle) return payload.limitRanges;
    return payload.limitRanges.filter(
      l => l.name.toLowerCase().includes(needle) || l.namespace.toLowerCase().includes(needle)
    );
  }, [payload?.limitRanges, needle]);

  // Four independent reads behind this one tab, so four verdicts. A refused `storageclasses`
  // list must not make the PVC count look doubtful, and vice versa.
  const scope = useMemo(() => envelopeScope(id, summary), [summary, id]);
  const pvcStatus = scope.of('PVCs', 'pvc', 'persistentvolumeclaims');
  const quotaStatus = scope.of('ResourceQuotas', 'quotas', 'resourcequotas');
  const limitStatus = scope.of('LimitRanges', 'limitranges');
  const classStatus = scope.of('StorageClasses', 'storageclasses');

  if (loading && !data) return <Skeleton rows={6} />;

  // The fetch itself failed and no envelope ever arrived — not "data.ok === false", which the
  // next branch already handles. Falling through here used to read `summary?.boundPvcs ?? 0`
  // and print a confident "0 / 0", indistinguishable from a genuinely empty cluster.
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

  const sc = summary?.defaultStorageClassState;
  // A percentage, not a namespace count: several quotas can share one namespace, so the
  // number of quota objects is not the number of covered namespaces. The collector already
  // did that division against a denominator it can see; null when it could not.
  const coverage = summary?.quotaCoverage;

  /*
    The PVC table is a `DataTable`, and it lost a second detail surface on the way: the row opened a
    local `DetailPanel` while the name cell's `ResourceLink` opened the shared resource drawer, so
    clicking the name opened both at once with the same object in two layouts. `renderPvc` in
    resources/registry.tsx already shows strictly more than the panel did (status, requested, bound
    capacity, volume, access modes, age), so the panel is gone and the link is the way in.
  */
  const pvcColumns: Column<PvcRow>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '220px',
      sortValue: p => p.name,
      render: p => <ResourceLink refTo={{ kind: 'PersistentVolumeClaim', namespace: p.namespace, name: p.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '160px',
      sortValue: p => p.namespace,
      render: p => <span className="text-muted">{p.namespace}</span>
    },
    {
      key: 'status',
      header: 'Status',
      // Worst first: a Lost claim is a volume that went away under a running workload, and Pending
      // is one that never arrived.
      sortValue: p => (p.status === 'Bound' ? 2 : p.status === 'Pending' ? 1 : 0),
      render: p => (
        <Pill tone={p.status === 'Bound' ? 'ok' : p.status === 'Pending' ? 'warn' : 'bad'}>{p.status}</Pill>
      )
    },
    {
      key: 'requested',
      // The caveat belongs where the number is. It used to live only on the tile caption below,
      // three columns away from the figure an operator actually reads as "how full is this".
      // No filesystem usage is read anywhere on this path — the API server cannot see it.
      header: 'Requested (not usage)',
      ...NUMERIC,
      info: COLUMN_INFO.pvcCapacity,
      // The bytes the collector already parsed, not the `10Gi` string: `512Mi` sorts above `5Gi` as
      // text and below it as a quantity.
      sortValue: p => p.requestedBytes ?? null,
      render: p => <span className="mono text-[13px] text-text">{p.requested}</span>
    },
    {
      // The other half of the pair, and the one that used to be a copy of the request. Absent
      // until the volume is bound and the provisioner states what it gave — which can exceed the
      // ask — so an absent value says so instead of echoing the request back as an answer.
      key: 'capacity',
      header: 'Bound capacity',
      ...NUMERIC,
      info: COLUMN_INFO.pvcCapacity,
      sortValue: p => pvcCapacityBytes(p),
      render: p =>
        p.capacity ? (
          <span className="mono text-[13px] text-text">{p.capacity}</span>
        ) : (
          <span className="text-[13px] text-muted">{capacityLabel(p.capacity)}</span>
        )
    },
    {
      key: 'class',
      header: 'StorageClass',
      max: '180px',
      sortValue: p => p.storageClass ?? null,
      render: p => (
        <span className={storageClassIsAbsent(p.storageClass) ? 'text-[12px] text-muted italic' : 'text-muted'}>
          {storageClassLabel(p.storageClass)}
        </span>
      )
    },
    {
      key: 'modes',
      header: 'Access Modes',
      max: '200px',
      sortValue: p => p.accessModes[0] ?? null,
      render: p => (
        <span className="mono text-[12px] text-muted">
          <CellList items={p.accessModes} />
        </span>
      )
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

      {/* ---------------------------------------------------------------- headline numbers */}
      <div className="grid grid-cols-2 gap-3 border-b border-line pb-4 lg:grid-cols-5">
        <StatTile
          label="Bound / total PVCs"
          status={pvcStatus}
          value={
            <MetricValue status={pvcStatus} size="md">
              <span className="mono">
                {summary?.boundPvcs ?? 0} / {summary?.totalPvcs ?? 0}
              </span>
            </MetricValue>
          }
          caption="A Pending claim has no volume behind it yet"
          valueClass={(summary?.pendingPvcs ?? 0) > 0 ? 'text-warn' : 'text-text'}
        />
        <StatTile
          label="Pending PVCs"
          status={pvcStatus}
          value={<Count status={pvcStatus} value={summary?.pendingPvcs ?? null} />}
          caption="Unbound: no matching volume, or no provisioner"
          valueClass={(summary?.pendingPvcs ?? 0) > 0 ? 'text-bad' : 'text-text'}
        />
        <StatTile
          label="Requested storage"
          status={pvcStatus}
          value={
            <MetricValue status={pvcStatus} size="md">
              <span className="mono">{bytes(summary?.totalRequestedBytes)}</span>
            </MetricValue>
          }
          caption="Sum of PVC requests, not provisioned capacity"
        />
        <StatTile
          label="Default StorageClass"
          status={classStatus}
          value={
            sc ? (
              <Pill tone={SC_TONE[sc.state] ?? 'unknown'}>{SC_WORD[sc.state] ?? sc.state}</Pill>
            ) : (
              <Unavailable what="StorageClasses" why={classStatus.why} size="sm" />
            )
          }
          caption={
            sc?.state === 'ready'
              ? String(sc.name)
              : sc?.detail || 'a claim with no storageClassName has nothing to bind to'
          }
        />
        <StatTile
          label="Namespaces with a quota"
          status={quotaStatus}
          value={
            coverage === null || coverage === undefined ? (
              <Unavailable what="quota coverage" why={quotaStatus.why} size="sm" />
            ) : (
              <span className="mono">{Math.round(coverage * 100)}%</span>
            )
          }
          caption={`${summary?.quotasCount ?? 0} ResourceQuota object(s) · ${summary?.limitRangesCount ?? 0} LimitRange(s)`}
          valueClass={coverage !== null && coverage !== undefined && coverage < 1 ? 'text-warn' : 'text-text'}
        />
      </div>

      {/* Controls & Tab Filter */}
      <div className="flex items-center justify-between border-b border-line py-3">
        <SubTabs
          sections={STORAGE_SECTIONS}
          active={activeTab}
          onSelect={setActiveTab}
          counts={{
            pvcs: pvcStatus.state === 'ok' ? filteredPvcs.length : null,
            quotas: quotaStatus.state === 'ok' ? filteredQuotas.length : null,
            limitranges: limitStatus.state === 'ok' ? filteredLimitRanges.length : null
          }}
          className="mb-0 border-b-0 pb-0"
        />

        <input
          type="text"
          placeholder="Filter by name, namespace, storage class..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-72 rounded-[6px] border border-line bg-raised px-3 py-1 text-[13px] text-text placeholder-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* Main Table */}
      <div className="flex-1 overflow-y-auto py-4">
        {activeTab === 'pvcs' && (
          <DataTable
            id="storage.pvcs"
            columns={pvcColumns}
            rows={filteredPvcs}
            rowKey={p => `${p.namespace}/${p.name}`}
            empty={
              pvcStatus.state === 'ok' ? 'No PersistentVolumeClaims found' : <UnavailableEmptyBody status={pvcStatus} />
            }
          />
        )}

        {activeTab === 'quotas' && (
          <div className="grid grid-cols-2 gap-4">
            {filteredQuotas.length === 0 ? (
              <div className="col-span-2">
                {quotaStatus.state === 'ok' ? (
                  <div className="py-8 text-center text-muted">No ResourceQuotas defined</div>
                ) : (
                  <UnavailableEmptyBody status={quotaStatus} />
                )}
              </div>
            ) : (
              filteredQuotas.map(row => {
                const q = quotaWireOf(row);
                return (
                <div key={`${row.namespace}/${row.name}`} className="rounded-[8px] border border-line bg-surface p-4">
                  <div className="flex items-center justify-between border-b border-line pb-2">
                    <div className="font-semibold text-text">
                      <ResourceLink refTo={{ kind: 'ResourceQuota', namespace: row.namespace, name: row.name }} />
                    </div>
                    <div className="text-[13px] text-muted">{row.namespace}</div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {/*
                      Whose numbers these are. `status.hard` is what the quota controller accepted
                      and enforces; `spec.hard` is only what an author asked for. The two used to
                      render identically, so a quota enforcing nothing looked like one in force.
                    */}
                    {quotaSourceNote(q.hardSource) && (
                      <div
                        className={`text-[12px] ${
                          quotaSourceTone(q.hardSource) === 'warn' ? 'text-warn' : 'text-muted'
                        }`}
                      >
                        {quotaSourceNote(q.hardSource)}
                      </div>
                    )}
                    {q.dimensions.map(d => (
                      <div key={d.dimension} className="text-[13px]">
                        <div className="flex justify-between text-muted">
                          <span>{d.dimension}</span>
                          <span
                            className={
                              d.used == null || d.hard == null
                                ? 'font-mono text-[13px] text-muted'
                                : 'font-mono text-[13px] text-text'
                            }
                          >
                            {quotaDimensionLabel(d.used, d.hard)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                );
              })
            )}
          </div>
        )}

        {/*
          LimitRanges: the defaults a container inherits when it declares none. This is the
          other half of `CapacitySection`'s `limitSumIsFloor` warning — a cluster with a
          LimitRange defaulting every container is a cluster whose limit sums can be trusted.
        */}
        {activeTab === 'limitranges' && (
          <div className="space-y-3">
            {filteredLimitRanges.length === 0 ? (
              limitStatus.state === 'ok' ? (
                <div className="py-8 text-center text-muted">
                  No LimitRanges defined — a container that declares no limit gets none
                </div>
              ) : (
                <UnavailableEmptyBody status={limitStatus} />
              )
            ) : (
              filteredLimitRanges.map(l => (
                <div key={`${l.namespace}/${l.name}`} className="rounded-[8px] border border-line bg-surface p-4">
                  <div className="flex items-center justify-between border-b border-line pb-2">
                    <div className="font-semibold text-text">{l.name}</div>
                    <div className="text-[13px] text-muted">
                      {l.namespace}
                      {l.createdAt ? ` · ${ago(l.createdAt)}` : ''}
                    </div>
                  </div>
                  <table className="tbl-inline mt-3">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Default limit</th>
                        <th>Default request</th>
                        <th>Min</th>
                        <th>Max</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l.limits.map((lim, i) => (
                        <tr key={`${lim.type}-${i}`}>
                          <td className="font-medium text-text">{lim.type}</td>
                          <td className="mono text-muted">{resourceList(lim.default)}</td>
                          <td className="mono text-muted">{resourceList(lim.defaultRequest)}</td>
                          <td className="mono text-muted">{resourceList(lim.min)}</td>
                          <td className="mono text-muted">{resourceList(lim.max)}</td>
                        </tr>
                      ))}
                      {l.limits.length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-muted">
                            no limit items declared
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A Kubernetes resource-list map (`{cpu: '500m', memory: '1Gi'}`) as one line.
 *
 * An em-dash for a `null` block, which is what the collector sends when a LimitRange declares
 * no `default` at all — different from declaring an empty one, and worth not conflating.
 */
function resourceList(map: Record<string, string> | null): string {
  if (!map) return '—';
  const entries = Object.entries(map);
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k} ${v}`).join(' · ');
}
