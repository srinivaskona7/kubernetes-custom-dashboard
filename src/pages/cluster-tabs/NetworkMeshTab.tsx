/**
 * Networking, Istio & Mesh, and TLS & Certificates: three sections that share this file and are
 * mounted as three tabs (`networking`, `istio`, `certificates`), one `view` each. Ported from the
 * three standalone fleet-wide pages (Networking.tsx, Mesh.tsx, Certificates.tsx), with the
 * PageHeader, cluster picker, and "compared across clusters" summary cards stripped out — those
 * only make sense fleet-wide.
 *
 * All three sections use their per-cluster endpoint — `api.clusterNetworking`,
 * `api.clusterMesh`, `api.clusterCertificates`. Networking used to call the fleet-wide
 * `api.networking()` and filter every row list in the browser, which was wrong twice over:
 * `GET /networking` re-derives its own summary and **drops all three APIRule-migration facts**,
 * so `apirulesByVersion`, `apirulesNeedingMigration` and `apirulesUnavailable` were read on
 * every poll and never reachable; and it paid for the whole fleet's read to draw one cluster.
 *
 * Three independent `useAsync` calls, three independent scopes — one section's failure never
 * blanks the other two, the same defensive posture the standalone pages already use.
 */
import { useCallback, useMemo, useState } from 'react';
import { COLUMN_INFO } from '../../components/table/column-info';
import { api, type MeshData } from '../../api';
import { Card, CellList, ErrorBanner, ErrorState, Pill } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Count,
  StatTile,
  UnavailableEmptyBody,
  unavailableEntries,
  unavailableScope,
  truncatedEntries,
  envelopeScope,
  NotInstalled
} from '../../components/unavailable';
import { useAsync } from '../../useAsync';
import { ResourceLink, useRegisterResolver } from '../../components/ResourceLink';
import { makeCertificatesResolver, makeNetworkingResolver } from '../../resources/resolve';
import { TAB_SECTIONS } from './tabs';
import {
  alongsideCaption,
  coverageByNamespace,
  coverageForVerdict,
  fleetCoverage,
  meshWideCoverage,
  mtlsBasisNote,
  mtlsModeCell,
  portOverrideMarkers,
  portOverrideTone
} from './mesh-mtls';

// Same local narrowing Mesh.tsx uses for the four `unknown`-typed collector fields — matched
// to srv/fleet/collectors/mesh.js's real return shape, not (yet) settled in api.ts.

interface SidecarDeployment {
  namespace: string;
  name: string;
  kind: string | null;
  ambient: boolean;
  podCount: number;
  inMeshCount: number;
  coveragePercent: number | null;
}

interface SidecarCoverage {
  byDeployment: SidecarDeployment[] | null;
  totalPods: number;
  ambientPods: number;
  ztunnelPresent: boolean | null;
  coveragePercent: number | null;
}

interface MtlsVerdict {
  scope: 'mesh' | 'namespace' | 'workload';
  namespace: string;
  name: string | null;
  mode: string;
  modeSource: string;
  /**
   * Stamped `'configuration'` by the collector on every verdict: these come from PeerAuthentication
   * and DestinationRule specs, never from an observed handshake. Rendered under the card title.
   */
  mtlsBasis?: string;
  /** Resolved port-level overrides, workload > namespace > mesh. Rendered as its own column. */
  portOverrides?: Record<string, string> | null;
  clientSideOverrides: { namespace: string; host: string; subset: string | null; mode: string }[];
}

interface IngressBinding {
  unboundGateways: string[] | null;
  virtualServicesWithMissingGateway: string[] | null;
  duplicateHostExposures: { host: string; gateways: string[] }[] | null;
}

interface AuthzPolicy {
  namespace: string;
  name: string;
  action: string;
  scope: 'workload' | 'namespace-or-mesh';
  classification: string;
}

interface AuthzPosture {
  policies: AuthzPolicy[] | null;
  unenforceablePolicies: { namespace: string; name: string }[] | null;
}

function classificationTone(c: string): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (c === 'allowAll' || c === 'inert') return 'warn';
  if (c === 'deny') return 'ok';
  if (c === 'allow') return 'ok';
  return 'unknown';
}

// ------------------------------------------------------------------------- Networking

/**
 * The APIRule version an object was *created* as, and whether that is still reconciled.
 *
 * `v1beta1` is not a stylistic preference: Kyma's API Gateway stopped reconciling it in 3.10
 * (Aug/Sep 2026), so a rule left on it has a spec nobody is acting on — the host may still
 * resolve from a stale Istio config and stop without warning on the next module restart.
 * `unknown` is a rule with no original-version annotation, which is the normal state for one
 * created directly as v2 by a recent client.
 */
const VERSION_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'unknown'> = {
  v2: 'ok',
  v2alpha1: 'warn',
  v1beta1: 'bad',
  unknown: 'unknown'
};

/** Fixed order, so the ledger reads oldest-to-newest rather than in object-key order. */
const VERSION_ORDER = ['v1beta1', 'v2alpha1', 'v2', 'unknown'] as const;

function NetworkingSection({ id }: { id: string }) {
  const { data, error, loading } = useAsync(useCallback(() => api.clusterNetworking(id), [id]), 0, id);
  const [activeTab, setActiveTab] = useState<'apirules' | 'virtualservices' | 'ingresses' | 'services'>('apirules');

  const payload = data?.ok ? data.data : undefined;
  const summary = payload?.summary;

  // Lend this section's rows to the cluster-wide resource drawer while it is mounted.
  useRegisterResolver('networking', useMemo(() => makeNetworkingResolver(payload), [payload]));

  const apirules = payload?.apirules ?? [];
  const virtualservices = payload?.virtualservices ?? [];
  const ingresses = payload?.ingresses ?? [];
  const services = payload?.services ?? [];

  /**
   * `envelopeScope` would do for the other three sections, but the APIRule read publishes a
   * *reason* the bare `unavailable` label cannot carry — and for this one read the reason is
   * the whole point. "The API Gateway module is absent" and "the module is too old to serve
   * v2" both arrive as a 404 and mean opposite things; the collector already distinguished
   * them into `apirulesUnavailable`, so the rich entry is put **first** so that both
   * `sentence()` (which takes the first entry with a detail) and `UnavailableNotice` (which
   * keeps the first entry per label) show the cause instead of the fallback guess.
   */
  const scope = useMemo(() => {
    if (!summary) return unavailableScope({});
    const rich = summary.apirulesUnavailable ? [summary.apirulesUnavailable] : [];
    return unavailableScope({
      clusters: [
        {
          id,
          ok: true,
          unavailable: [...rich, ...unavailableEntries(summary)],
          truncated: truncatedEntries(summary)
        }
      ]
    });
  }, [summary, id]);

  const apiruleStatus = scope.of('APIRules', 'apirules');
  const vsStatus = scope.of('VirtualServices', 'virtualservices');
  const gatewayStatus = scope.of('Istio Gateways', 'istio-gateways');
  const ingressStatus = scope.of('Ingresses', 'ingresses');
  const serviceStatus = scope.of('Services', 'services');

  if (loading && !data) {
    return <p className="px-1 py-4 text-[14px] text-muted">Loading networking…</p>;
  }
  if (error && !payload) {
    return <ErrorBanner code={error.code} message={error.message} />;
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

  const byVersion = summary?.apirulesByVersion;
  const needsMigration = summary?.apirulesNeedingMigration;

  /** A Service list can repeat a namespace/name pair, so the row's position is part of its key. */
  const serviceRows = services.map((s, idx) => ({ ...s, rowId: `${s.namespace}/${s.name}/${idx}` }));

  /*
    The four row lists below are `DataTable`s rather than hand-rolled `<table className="tbl">`
    markup. They looked identical before — `.tbl` and the `cap-*` classes gave them the same borders,
    sticky header and ceilings — but they had none of the behaviour every other table in the console
    has: no sortable headers, no resizable or reorderable columns, no Columns menu, no wrap mode. A
    table that looks like its neighbours and does not behave like them is the harder inconsistency to
    live with, because nothing about it says which kind it is.

    The `cap-*` classes map straight onto `max` (sm 140, md 200, lg 260), and the explicit per-cell
    `title` attributes are gone: `DataTable` derives the tooltip from a capped cell's own text, which
    is the same string those attributes were repeating by hand.
  */
  const apiruleColumns: Column<(typeof apirules)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: ar => ar.name,
      render: ar => <ResourceLink refTo={{ kind: 'APIRule', namespace: ar.namespace, name: ar.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: ar => ar.namespace,
      render: ar => <span className="text-muted">{ar.namespace}</span>
    },
    {
      key: 'host',
      header: 'Host URL',
      max: '200px',
      sortValue: ar => ar.host,
      render: ar => <span className="font-mono text-[13px] text-accent">{ar.host}</span>
    },
    {
      key: 'target',
      header: 'Target Service',
      max: '140px',
      priority: 2,
      sortValue: ar => ar.serviceName,
      render: ar => (
        <span className="text-muted">
          {ar.serviceName}:{ar.servicePort}
        </span>
      )
    },
    {
      /*
        Created-as, not served-as. Every row is *read* at v2 — that is what `servedVersion` says and
        it is the same for all of them, so putting it in a column would spend width on a constant.
        What differs per row is the version the object was authored at, and whether the spec shown
        here came from the live `spec` or from the stored v1beta1 annotation the conversion webhook
        left behind. The latter is worth surfacing: it is a spec no controller is currently
        reconciling.
      */
      key: 'createdAs',
      header: 'Created as',
      // Sorted by risk, not alphabetically: the rows worth finding are the unreconciled ones.
      sortValue: ar => `${ar.needsMigration ? 0 : 1} ${ar.originalVersion ?? 'unannotated'}`,
      render: ar => (
        <span className="inline-flex items-baseline gap-1.5">
          <Pill tone={VERSION_TONE[ar.originalVersion ?? 'unknown'] ?? 'unknown'}>
            {ar.originalVersion ?? 'unannotated'}
          </Pill>
          {ar.needsMigration && (
            <span
              className="text-[12px] font-medium text-bad"
              title={`Created as v1beta1, which the API Gateway stopped reconciling in Kyma 3.10. The spec above came from ${ar.specSource}.`}
            >
              migrate
            </span>
          )}
        </span>
      )
    },
    {
      key: 'state',
      header: 'Status',
      sortValue: ar => ar.state,
      render: ar => <Pill tone={ar.state === 'OK' || ar.state === 'Ready' ? 'ok' : 'unknown'}>{ar.state}</Pill>
    },
    {
      key: 'auth',
      header: 'Auth Handler',
      priority: 2,
      sortValue: ar => ar.paths[0]?.accessStrategies.join(', ') || 'noop',
      render: ar => (
        <span className="rounded bg-raised px-2 py-0.5 font-mono text-[12px] text-text">
          {ar.paths[0]?.accessStrategies.join(', ') || 'noop'}
        </span>
      )
    }
  ];

  const vsColumns: Column<(typeof virtualservices)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: vs => vs.name,
      render: vs => <ResourceLink refTo={{ kind: 'VirtualService', namespace: vs.namespace, name: vs.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: vs => vs.namespace,
      render: vs => <span className="text-muted">{vs.namespace}</span>
    },
    {
      key: 'hosts',
      header: 'Hosts',
      max: '260px',
      // `CellList` renders "first + N more" with the full set in its own tooltip, so the sort key is
      // the first host — the one actually on screen.
      sortValue: vs => vs.hosts[0] ?? null,
      render: vs => (
        <span className="font-mono text-[13px] text-text">
          <CellList items={vs.hosts} />
        </span>
      )
    },
    {
      key: 'gateways',
      header: 'Gateways',
      max: '200px',
      priority: 2,
      sortValue: vs => vs.gateways[0] ?? null,
      render: vs => (
        <span className="text-muted">
          <CellList items={vs.gateways} empty="mesh" />
        </span>
      )
    },
    {
      key: 'destinations',
      header: 'Destinations',
      max: '260px',
      sortValue: vs => vs.routes[0]?.destinationHost ?? null,
      render: vs => (
        <span className="font-mono text-[13px] text-muted">
          <CellList
            items={vs.routes.map(r => `${r.destinationHost}${r.destinationPort ? `:${r.destinationPort}` : ''}`)}
          />
        </span>
      )
    }
  ];

  const ingressColumns: Column<(typeof ingresses)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: ing => ing.name,
      render: ing => <ResourceLink refTo={{ kind: 'Ingress', namespace: ing.namespace, name: ing.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: ing => ing.namespace,
      render: ing => <span className="text-muted">{ing.namespace}</span>
    },
    {
      key: 'host',
      header: 'Host',
      max: '260px',
      sortValue: ing => ing.rules[0]?.host ?? null,
      render: ing => (
        <span className="font-mono text-[13px] text-text">
          <CellList items={ing.rules.map(r => r.host)} />
        </span>
      )
    },
    {
      key: 'tls',
      header: 'TLS Secrets',
      max: '220px',
      priority: 2,
      // Secret *names* only, which is the convention everywhere in this console — a Secret's value
      // is never read, let alone rendered.
      sortValue: ing => ing.tls[0]?.secretName ?? null,
      render: ing => (
        <span className="font-mono text-[13px] text-muted">
          <CellList items={ing.tls.map(t => t.secretName)} empty="None" />
        </span>
      )
    },
    {
      key: 'class',
      header: 'Class',
      sortValue: ing => ing.ingressClassName || 'default',
      render: ing => <span className="text-muted">{ing.ingressClassName || 'default'}</span>
    }
  ];

  const serviceColumns: Column<(typeof serviceRows)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: s => s.name,
      render: s => <ResourceLink refTo={{ kind: 'Service', namespace: s.namespace, name: s.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: s => s.namespace,
      render: s => <span className="text-muted">{s.namespace}</span>
    },
    {
      key: 'type',
      header: 'Type',
      sortValue: s => s.type,
      render: s => (
        <span className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[12px] text-text">
          {s.type}
        </span>
      )
    },
    {
      key: 'ip',
      header: 'Cluster IP',
      priority: 2,
      sortValue: s => s.clusterIP || null,
      render: s => <span className="font-mono text-[13px] text-muted">{s.clusterIP || 'None'}</span>
    },
    {
      key: 'ports',
      header: 'Ports',
      max: '260px',
      sortValue: s => s.ports[0]?.port ?? null,
      render: s => (
        <span className="font-mono text-[13px] text-text">
          <CellList items={s.ports.map(p => `${p.port}:${p.targetPort}/${p.protocol}`)} />
        </span>
      )
    }
  ];

  /*
    A refused Ingress read still arrives as an empty list, so the collector's count is 0 — printed
    raw it reads as "this cluster has no Ingress routes" inside an otherwise honest tile. The
    Ingress scope decides whether the number means anything at all.
  */
  const ingressCaption = alongsideCaption(
    ingressStatus.state === 'unavailable' ? null : summary?.ingressesCount ?? null,
    'Ingress route'
  );


  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-4 lg:grid-cols-5">
        <StatTile
          label="Kyma APIRules"
          status={apiruleStatus}
          value={<Count status={apiruleStatus} value={summary?.apirulesCount ?? null} size="lg" />}
          caption="Gateway endpoints — all read as v2"
        />
        <StatTile
          label="Need migration"
          status={apiruleStatus}
          value={<Count status={apiruleStatus} value={needsMigration ?? null} size="lg" />}
          caption="Created as v1beta1, which the API Gateway no longer reconciles"
          valueClass={(needsMigration ?? 0) > 0 ? 'text-bad' : 'text-text'}
        />
        <StatTile
          label="Istio Gateways"
          status={gatewayStatus}
          value={<Count status={gatewayStatus} value={summary?.gatewaysCount ?? null} size="lg" />}
          caption="Binding integrity is under Istio & Mesh"
        />
        <StatTile
          label="VirtualServices"
          status={vsStatus}
          value={<Count status={vsStatus} value={summary?.virtualServicesCount ?? null} size="lg" />}
          caption="Mesh routing rules"
        />
        <StatTile
          label="Services"
          status={serviceStatus}
          value={<Count status={serviceStatus} value={summary?.servicesCount ?? null} size="lg" />}
          caption={ingressCaption}
        />
      </div>

      {/*
        The version ledger. A strip rather than four more tiles: it is one fact split four
        ways, and at this density another row of card containers would read as four unrelated
        metrics. Hidden entirely when the read failed — a ledger of zeros is the false
        confidence this console exists to avoid, and the tiles above already say so.
      */}
      {byVersion && apiruleStatus.state !== 'unavailable' && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-y border-line py-2 text-[13px]">
          <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Created as</span>
          {VERSION_ORDER.map(v => (
            <span key={v} className="inline-flex items-baseline gap-1.5">
              <Pill tone={VERSION_TONE[v] ?? 'unknown'}>{v}</Pill>
              <span className={`mono ${byVersion[v] > 0 ? 'text-text' : 'text-muted'}`}>{byVersion[v]}</span>
            </span>
          ))}
          <span className="text-muted">
            {(needsMigration ?? 0) > 0
              ? 'v1beta1 rules are served from a stored spec and are not being reconciled'
              : 'nothing is left on the unreconciled v1beta1'}
          </span>
        </div>
      )}

      <div className="mb-3 flex gap-2 border-b border-line pb-3">
        {(
          [
            ['apirules', 'APIRules', apiruleStatus, apirules.length],
            ['virtualservices', 'VirtualServices', vsStatus, virtualservices.length],
            ['ingresses', 'Ingresses', ingressStatus, ingresses.length],
            ['services', 'Services', serviceStatus, services.length]
          ] as const
        ).map(([key, label, status, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`rounded-[6px] px-3 py-1 text-[14px] font-medium transition-colors ${
              activeTab === key ? 'bg-accent text-white' : 'text-muted hover:text-text'
            }`}
          >
            {label} (<Count status={status} value={count} />)
          </button>
        ))}
      </div>

      {activeTab === 'apirules' && (
        <DataTable
          columns={apiruleColumns}
          rows={apirules}
          rowKey={ar => ar.id}
          empty={
            apiruleStatus.state === 'ok' ? 'No APIRules found' : <UnavailableEmptyBody status={apiruleStatus} />
          }
        />
      )}

      {activeTab === 'virtualservices' && (
        <DataTable
          columns={vsColumns}
          rows={virtualservices}
          rowKey={vs => vs.id}
          empty={vsStatus.state === 'ok' ? 'No VirtualServices found' : <UnavailableEmptyBody status={vsStatus} />}
        />
      )}

      {activeTab === 'ingresses' && (
        <DataTable
          columns={ingressColumns}
          rows={ingresses}
          rowKey={ing => ing.id}
          empty={
            ingressStatus.state === 'ok' ? 'No Ingresses found' : <UnavailableEmptyBody status={ingressStatus} />
          }
        />
      )}

      {activeTab === 'services' && (
        <DataTable
          columns={serviceColumns}
          rows={serviceRows}
          // The row's own position is part of the key, as it was before: a Service list can repeat a
          // namespace/name pair, and two rows sharing a key is a React identity bug rather than a
          // cosmetic one — it would let one row's state (a dragged width, a selection) land on the
          // other.
          rowKey={s => s.rowId}
          empty={serviceStatus.state === 'ok' ? 'No Services found' : <UnavailableEmptyBody status={serviceStatus} />}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------ Mesh

function MeshSection({ id }: { id: string }) {
  const { data, error, loading } = useAsync(useCallback(() => api.clusterMesh(id), [id]), 0, id);

  const hasData = Boolean(data?.ok && data.data);
  const payload = hasData ? (data!.data as MeshData) : null;

  const scope = useMemo(
    () =>
      unavailableScope({
        clusters: [
          {
            id,
            ok: Boolean(data?.ok),
            unavailable: data?.unavailable ?? [],
            truncated: data?.truncated ?? []
          }
        ]
      }),
    [data, id]
  );

  const sidecarStatus = scope.of('Sidecar Coverage', 'pods');
  const mtlsStatus = scope.of('mTLS', 'peerauthentications', 'destinationrules');
  const bindingStatus = scope.of('Ingress Binding', 'istio-gateways', 'virtualservices');
  const authzStatus = scope.of('Authorization Posture', 'authorizationpolicies');

  if (loading && !data) {
    return <p className="px-1 py-4 text-[14px] text-muted">Loading service mesh…</p>;
  }
  if (error && !hasData) {
    return <ErrorBanner code={error.code} message={error.message} />;
  }
  if (!hasData) {
    return <UnavailableEmptyBody status={sidecarStatus} />;
  }

  const sidecarCoverage = payload!.sidecarCoverage as unknown as SidecarCoverage | null;
  const sidecarRows = sidecarCoverage?.byDeployment || [];
  const totalPods = sidecarCoverage?.totalPods ?? null;
  /*
    Relayed, never re-derived. The collector publishes `coveragePercent: null` when there are no
    meshable pods; the old browser-side sum clamped its denominator to a minimum of one, which
    turned that null into a confident `0%` — a cluster that was never audited reading as a cluster
    with no mesh.
  */
  const fleetCoveragePercent = fleetCoverage(sidecarCoverage);

  const mtlsEnvelope = payload!.mtls as unknown as { verdicts: MtlsVerdict[] | null; mtlsBasis?: string };
  const mtlsRows = mtlsEnvelope.verdicts || [];
  /*
    The coverage join behind the mode pill. A declared STRICT is only enforced by a proxy that
    terminates the connection, so a namespace whose pods carry no sidecar must not read green.
    `null` here means the pod read itself was refused — then the pill is `unknown`, not `ok`.

    The gate is on the payload, not on the status label: an empty `Map` from an absent
    `byDeployment` would have made every STRICT row assert "no pods in scope" about pods that were
    never read, and only an exactly-`unavailable` status would have caught it.
  */
  const coverageJoinRows =
    sidecarCoverage == null || sidecarStatus.state === 'unavailable' ? null : sidecarCoverage.byDeployment ?? null;
  const nsCoverage = coverageByNamespace(coverageJoinRows);
  const meshCoverage = meshWideCoverage(coverageJoinRows);

  const binding = payload!.ingressBindingIntegrity as unknown as IngressBinding;
  const unboundGateways = binding.unboundGateways || [];
  const missingGatewayVs = binding.virtualServicesWithMissingGateway || [];
  const anyBindingRead = binding.unboundGateways !== null;

  const authz = payload!.authorizationPosture as unknown as AuthzPosture;
  const authzPolicies = authz.policies || [];
  const unenforceable = authz.unenforceablePolicies || [];
  const anyAuthzRead = authz.policies !== null;

  /*
    Three `DataTable`s, each named with an explicit `id`. The default id is the joined column keys,
    and these three would have collided with other five-column `name|ns|…` tables elsewhere in the
    console — two unrelated tables sharing one stored width is a preference that appears to move on
    its own.
  */
  const sidecarColumns: Column<SidecarDeployment>[] = [
    {
      key: 'workload',
      header: 'Workload',
      pin: true,
      max: '240px',
      sortValue: d => d.name,
      render: d => <span className="font-medium text-text">{d.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '180px',
      sortValue: d => d.namespace,
      render: d => <span className="text-muted">{d.namespace}</span>
    },
    {
      key: 'kind',
      header: 'Kind',
      sortValue: d => d.kind,
      render: d => <span className="text-muted">{d.kind || 'Unknown'}</span>
    },
    {
      key: 'mode',
      header: 'Mode',
      // Pod count is what the pill shows for a sidecar workload, and an ambient one has no count to
      // compare — it sorts to the end rather than pretending to be zero pods.
      sortValue: d => (d.ambient ? null : d.podCount),
      render: d =>
        d.ambient ? (
          <Pill tone="accent">ambient</Pill>
        ) : (
          <Pill tone={d.coveragePercent === 100 ? 'ok' : d.coveragePercent === 0 ? 'bad' : 'warn'}>
            {d.podCount} pods
          </Pill>
        )
    },
    {
      key: 'coverage',
      header: 'Coverage',
      info: COLUMN_INFO.sidecarCoverage,
      align: 'right',
      sortValue: d => (d.ambient ? null : d.coveragePercent),
      render: d => (
        <span className="font-mono text-[13px] text-text">
          {d.ambient ? '— (ztunnel)' : d.coveragePercent === null ? '—' : `${d.coveragePercent}%`}
        </span>
      )
    }
  ];

  const mtlsColumns: Column<MtlsVerdict>[] = [
    {
      key: 'scope',
      header: 'Scope',
      pin: true,
      sortValue: v => v.scope,
      render: v => <span className="font-medium capitalize text-text">{v.scope}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '200px',
      sortValue: v => v.namespace,
      render: v => <span className="text-muted">{v.namespace}</span>
    },
    {
      key: 'mode',
      header: 'Declared Mode',
      sortValue: v => v.mode,
      render: v => {
        const cell = mtlsModeCell(v.mode, v.modeSource, coverageForVerdict(v.scope, v.namespace, nsCoverage, meshCoverage));
        return (
          <span className="inline-flex flex-col items-start gap-0.5">
            <Pill tone={cell.tone} title={cell.note ?? undefined}>
              {cell.label}
            </Pill>
            {cell.note && <span className="text-[12px] leading-tight text-muted">{cell.note}</span>}
          </span>
        );
      }
    },
    {
      key: 'ports',
      header: 'Port Overrides',
      max: '220px',
      // A row with no contradicting port override sorts after the rows that have one: those are
      // the rows that change what the declared mode actually means.
      sortValue: v => {
        const n = portOverrideMarkers(v.portOverrides, v.mode).length;
        return n === 0 ? null : -n;
      },
      render: v => {
        const overrides = portOverrideMarkers(v.portOverrides, v.mode);
        // "none" would be a claim about `portLevelMtls` itself; what this column knows is only that
        // nothing in it contradicts the declared mode — a `portLevelMtls` block restating STRICT is
        // still there.
        if (overrides.length === 0) return <span className="text-muted">no contradicting override</span>;
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Pill
              tone={portOverrideTone(overrides)}
              title={`portLevelMtls contradicts the declared ${v.mode} on ${overrides.length} port(s)`}
            >
              {overrides.length} port override{overrides.length === 1 ? '' : 's'}
            </Pill>
            <span className="font-mono text-[12px] text-muted">
              <CellList items={overrides.map(o => `${o.port}:${o.mode}`)} />
            </span>
          </span>
        );
      }
    },
    {
      key: 'source',
      header: 'Source',
      max: '220px',
      sortValue: v => v.modeSource,
      render: v => <span className="text-muted">{v.modeSource}</span>
    },
    {
      key: 'overrides',
      header: 'Client Overrides',
      max: '260px',
      sortValue: v => v.clientSideOverrides.length,
      render: v => (
        <span className="font-mono text-[13px] text-muted">
          <CellList items={v.clientSideOverrides.map(o => `${o.host}:${o.mode}`)} />
        </span>
      )
    }
  ];

  const authzColumns: Column<AuthzPolicy>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: p => p.name,
      render: p => <span className="font-medium text-text">{p.name}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: p => p.namespace,
      render: p => <span className="text-muted">{p.namespace}</span>
    },
    {
      key: 'scope',
      header: 'Scope',
      max: '140px',
      sortValue: p => p.scope,
      render: p => <span className="text-muted">{p.scope}</span>
    },
    {
      key: 'action',
      header: 'Action',
      sortValue: p => p.action,
      render: p => <span className="text-muted">{p.action}</span>
    },
    {
      key: 'classification',
      header: 'Classification',
      sortValue: p => p.classification,
      render: p => <Pill tone={classificationTone(p.classification)}>{p.classification}</Pill>
    },
    {
      key: 'enforceable',
      header: 'Enforceable',
      // The unenforceable rows are the reason this table exists, so they sort first.
      sortValue: p =>
        p.scope === 'workload'
          ? unenforceable.some(u => u.namespace === p.namespace && u.name === p.name)
            ? 0
            : 1
          : null,
      render: p => {
        const gap = unenforceable.some(u => u.namespace === p.namespace && u.name === p.name);
        return p.scope === 'workload' ? (
          <Pill tone={gap ? 'bad' : 'ok'}>{gap ? 'no enforcement' : 'enforced'}</Pill>
        ) : (
          <span className="text-muted">n/a</span>
        );
      }
    }
  ];

  return (
    <div>
      <div className="mb-4 grid grid-cols-4 gap-4">
        <StatTile
          label="Sidecar Coverage"
          status={sidecarStatus}
          value={<Count status={sidecarStatus} value={fleetCoveragePercent === null ? null : fleetCoveragePercent} />}
          caption={
            fleetCoveragePercent === null
              ? 'no meshable pods audited'
              : totalPods === null
                ? 'pod total not reported'
                : `${totalPods} pods audited`
          }
        />
        <StatTile
          label="mTLS Verdicts"
          status={mtlsStatus}
          value={<Count status={mtlsStatus} value={mtlsEnvelope.verdicts === null ? null : mtlsRows.length} />}
          caption="Declared scopes — mesh, namespace, and workload"
        />
        <StatTile
          label="Unbound Gateways"
          status={bindingStatus}
          value={<Count status={bindingStatus} value={anyBindingRead ? unboundGateways.length : null} />}
          caption="No VirtualService references them"
        />
        <StatTile
          label="Unenforceable AuthZ Policies"
          status={authzStatus}
          value={<Count status={authzStatus} value={anyAuthzRead ? unenforceable.length : null} />}
          caption="Workload-scoped, no sidecar or ztunnel"
        />
      </div>

      <Card title="Sidecar Coverage" className="mb-4">
        {sidecarStatus.state === 'unavailable' ? (
          <UnavailableEmptyBody status={sidecarStatus} />
        ) : sidecarCoverage == null || sidecarCoverage.byDeployment === null ? (
          <p className="px-1 py-4 text-[14px] text-muted">Pods were not read — sidecar coverage not reported.</p>
        ) : sidecarRows.length === 0 ? (
          <p className="px-1 py-4 text-[14px] text-muted">No workloads found in scope.</p>
        ) : (
          <DataTable
            id="mesh.sidecar"
            columns={sidecarColumns}
            rows={sidecarRows}
            rowKey={d => `${d.namespace}/${d.name}`}
            empty="No workloads found in scope."
          />
        )}
      </Card>

      <Card title="Declared mTLS (configuration)" className="mb-4">
        <p className="px-1 pb-2 text-[13px] leading-snug text-muted">{mtlsBasisNote(mtlsEnvelope.mtlsBasis)}</p>
        {mtlsStatus.state === 'unavailable' ? (
          <UnavailableEmptyBody status={mtlsStatus} />
        ) : mtlsEnvelope.verdicts === null ? (
          // A null verdict list is an unread PeerAuthentication/DestinationRule pair, not an empty
          // mesh. "None found" here would assert a configuration nobody looked at.
          <p className="px-1 py-4 text-[14px] text-muted">
            PeerAuthentication was not read — mTLS verdicts not reported.
          </p>
        ) : mtlsRows.length === 0 ? (
          <p className="px-1 py-4 text-[14px] text-muted">No PeerAuthentication scopes found.</p>
        ) : (
          <DataTable
            id="mesh.mtls"
            columns={mtlsColumns}
            rows={mtlsRows}
            rowKey={v => `${v.scope}/${v.namespace}/${v.name ?? '-'}`}
            empty="No PeerAuthentication scopes found."
          />
        )}
      </Card>

      <Card title="Ingress Binding Integrity" className="mb-4">
        {bindingStatus.state === 'unavailable' || !anyBindingRead ? (
          <UnavailableEmptyBody status={bindingStatus} />
        ) : unboundGateways.length === 0 && missingGatewayVs.length === 0 ? (
          <p className="px-1 py-4 text-[14px] text-muted">Every Gateway is referenced; every VirtualService resolves.</p>
        ) : (
          <div className="space-y-3">
            {unboundGateways.length > 0 && (
              <div>
                <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                  Unbound Gateways ({unboundGateways.length})
                </div>
                <ul className="divide-y divide-line text-[14px]">
                  {unboundGateways.map((g, i) => (
                    <li key={i} className="py-1.5 font-mono text-text">
                      {g}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {missingGatewayVs.length > 0 && (
              <div>
                <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                  VirtualServices with a Missing Gateway ({missingGatewayVs.length})
                </div>
                <ul className="divide-y divide-line text-[14px]">
                  {missingGatewayVs.map((v, i) => (
                    <li key={i} className="py-1.5 font-mono text-text">
                      {v}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Authorization Posture">
        {authzStatus.state === 'unavailable' || !anyAuthzRead ? (
          <UnavailableEmptyBody status={authzStatus} />
        ) : authzPolicies.length === 0 ? (
          <NotInstalled what="AuthorizationPolicy" detail="no AuthorizationPolicy objects found on this cluster" />
        ) : (
          <DataTable
            id="mesh.authz"
            columns={authzColumns}
            rows={authzPolicies}
            rowKey={p => `${p.namespace}/${p.name}`}
            empty="No AuthorizationPolicy objects found"
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------- Certificates

/**
 * `/clusters/:id/certificates` answers with the fan-out **envelope**, so everything lives at
 * `data.data`. This section read `data.certificates` and `data.summary` until
 * `ClusterCertificates` was corrected from `= FleetCertificates` to
 * `ClusterGroupEnvelope<CertificatesData>` — one level too shallow on every field, so the table
 * rendered "No certificates found" on every cluster and all four tiles showed 0, with the
 * compiler agreeing. Nothing below reaches past `payload`.
 */
function CertificatesSection({ id }: { id: string }) {
  const { data, error, loading } = useAsync(useCallback(() => api.clusterCertificates(id), [id]), 0, id);

  const payload = data?.ok ? data.data : undefined;
  const summary = payload?.summary;

  useRegisterResolver('certificates', useMemo(() => makeCertificatesResolver(payload), [payload]));

  const scope = useMemo(() => envelopeScope(id, summary), [summary, id]);
  const certStatus = scope.of('Certificates', 'certificates');
  const ingressStatus = scope.of('Ingress TLS bindings', 'ingresses');

  const certs = payload?.certificates ?? [];
  const ingressTls = payload?.ingressTls ?? [];
  const providers = summary?.providers ?? [];

  if (loading && !data) {
    return <p className="px-1 py-4 text-[14px] text-muted">Loading certificates…</p>;
  }
  if (error && !payload) {
    return <ErrorBanner code={error.code} message={error.message} />;
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

  const certColumns: Column<(typeof certs)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      pin: true,
      max: '200px',
      sortValue: c => c.name,
      render: c => <ResourceLink refTo={{ kind: 'Certificate', namespace: c.namespace, name: c.name }} />
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '140px',
      sortValue: c => c.namespace,
      render: c => <span className="text-muted">{c.namespace}</span>
    },
    {
      /*
        Capped rather than left to grow: the full list stays reachable on hover, which matters here —
        a wildcard vs an exact host is the whole question an operator is asking of this column.
        `CellList` carries the `title`.
      */
      key: 'dns',
      header: 'DNS Names',
      max: '200px',
      sortValue: c => c.dnsNames[0] ?? null,
      render: c => (
        <span className="font-mono text-[13px] text-text">
          <CellList items={c.dnsNames} />
        </span>
      )
    },
    {
      key: 'issuer',
      header: 'Issuer',
      max: '140px',
      priority: 2,
      sortValue: c => c.issuerRef,
      render: c => <span className="text-muted">{c.issuerRef}</span>
    },
    {
      key: 'expires',
      header: 'Expires',
      info: COLUMN_INFO.certExpiry,
      align: 'right',
      // Days, not the rendered "42d" string — a text sort puts 9d after 42d.
      sortValue: c => c.daysRemaining,
      render: c => (
        <span className="font-mono text-[13px] text-muted">{c.daysRemaining === null ? '—' : `${c.daysRemaining}d`}</span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      // Worst first: expired, then expiring, then the healthy ones.
      sortValue: c => (c.isExpired ? 0 : c.isExpiringSoon ? 1 : c.isReady ? 3 : 2),
      render: c => (
        <Pill tone={c.isExpired ? 'bad' : c.isExpiringSoon ? 'warn' : c.isReady ? 'ok' : 'unknown'}>
          {c.isExpired ? 'expired' : c.isExpiringSoon ? 'expiring soon' : c.isReady ? 'ready' : 'not ready'}
        </Pill>
      )
    }
  ];

  /** One Ingress can bind several Secrets, so the row's position is part of its key. */
  const ingressTlsRows = ingressTls.map((t, idx) => ({ ...t, rowId: `${t.ingressName}/${t.namespace}/${idx}` }));

  const ingressTlsColumns: Column<(typeof ingressTlsRows)[number]>[] = [
    {
      key: 'ingress',
      header: 'Ingress',
      pin: true,
      max: '240px',
      sortValue: t => t.ingressName,
      render: t => <span className="font-medium text-text">{t.ingressName}</span>
    },
    {
      key: 'ns',
      header: 'Namespace',
      max: '180px',
      sortValue: t => t.namespace,
      render: t => <span className="text-muted">{t.namespace}</span>
    },
    {
      key: 'hosts',
      header: 'Hosts',
      max: '260px',
      sortValue: t => t.hosts[0] ?? null,
      render: t => (
        <span className="font-mono text-[13px] text-text">
          <CellList items={t.hosts} />
        </span>
      )
    },
    {
      // The Secret's *name*. Its contents are never read, here or anywhere in this console.
      key: 'secret',
      header: 'Secret',
      max: '240px',
      sortValue: t => t.secretName,
      render: t => <span className="font-mono text-[13px] text-muted">{t.secretName}</span>
    }
  ];

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-4 lg:grid-cols-5">
        {/*
          The collector's own counts, not re-derived from the rows. `totalCertificates` is null
          when *neither* provider answered, which is a different fact from `certs.length === 0`
          — and the three alarm counts below are the collector's too, so a truncated read makes
          them floors on an alarm rather than silently-recomputed zeros.
        */}
        <StatTile
          label="Certificates"
          status={certStatus}
          value={<Count status={certStatus} value={summary?.totalCertificates ?? null} size="lg" />}
          caption={
            providers.length > 0
              ? `via ${providers.join(' + ')}`
              : certStatus.state === 'unavailable'
                ? ''
                : 'no provider answered'
          }
        />
        <StatTile
          label="Expiring Soon"
          status={certStatus}
          value={<Count status={certStatus} value={summary?.expiringSoon ?? null} size="lg" />}
          caption="≤ 14 days remaining"
          valueClass={(summary?.expiringSoon ?? 0) > 0 ? 'text-warn' : 'text-text'}
        />
        <StatTile
          label="Expired"
          status={certStatus}
          value={<Count status={certStatus} value={summary?.expired ?? null} size="lg" />}
          caption="Past notAfter"
          valueClass={(summary?.expired ?? 0) > 0 ? 'text-bad' : 'text-text'}
        />
        <StatTile
          label="Not Ready"
          status={certStatus}
          value={<Count status={certStatus} value={summary?.unready ?? null} size="lg" />}
          caption="Issuance or renewal failing"
          valueClass={(summary?.unready ?? 0) > 0 ? 'text-warn' : 'text-text'}
        />
        {/*
          Hosts, not bindings: one Ingress TLS block can carry several hostnames, so this is
          the count of names actually terminating TLS here — the number that matters when
          asking "how much stops working if this Secret is wrong". Fed by the Ingress read,
          not the certificate providers, so it carries its own verdict.
        */}
        <StatTile
          label="TLS hosts on Ingress"
          status={ingressStatus}
          value={<Count status={ingressStatus} value={summary?.totalIngressTlsHosts ?? null} size="lg" />}
          caption={`across ${ingressTls.length} TLS binding(s)`}
        />
      </div>

      <DataTable
        columns={certColumns}
        rows={certs}
        rowKey={c => c.id}
        empty={certStatus.state === 'ok' ? 'No certificates found' : <UnavailableEmptyBody status={certStatus} />}
      />

      {ingressTls.length > 0 && (
        <Card title="Ingress TLS Bindings" className="mt-4" flush>
          <DataTable
            id="certs.ingressTls"
            columns={ingressTlsColumns}
            rows={ingressTlsRows}
            rowKey={t => t.rowId}
            empty="No TLS bindings"
          />
        </Card>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------- tab

const NETWORKING = TAB_SECTIONS.networking;
const ISTIO = TAB_SECTIONS.istio;
const CERTIFICATES = TAB_SECTIONS.certificates;

// Each of the three is a tab of its own with a single view, so the tab picks the section and there
// is no sub-tab strip. The ids come from the registered lists (the ones an Overview tile and an old
// `?section=` alias resolve against), so a renamed id is a compile error below, not a blank tab.
const SECTION_OF = {
  networking: NETWORKING[0].id,
  istio: ISTIO[0].id,
  certificates: CERTIFICATES[0].id
} as const;

export default function NetworkMeshTab({ id, view }: { id: string; view: keyof typeof SECTION_OF }): JSX.Element {
  const section = SECTION_OF[view];
  return (
    <div>
      {section === 'networking' && <NetworkingSection id={id} />}
      {section === 'mesh' && <MeshSection id={id} />}
      {section === 'certificates' && <CertificatesSection id={id} />}
    </div>
  );
}
