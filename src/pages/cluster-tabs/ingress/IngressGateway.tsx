/**
 * Ingress & Traffic → Gateway tier.
 *
 * The gateway as objects: its pods, the autoscaler and disruption budget around them, the
 * LoadBalancer Service with the addresses its hostname resolves to, the DNSEntries that publish names
 * onto it, and the EnvoyFilters patching it. Nothing here comes from an access log, so it answers the
 * question a log cannot — "can this edge take more load, and is its config still the config that
 * runs".
 *
 * An EnvoyFilter whose `proxyVersion` match cannot match the running istiod is dead config: it
 * applies to nothing and still reads as if it does. The server decides `applies`; this screen flags
 * `applies === false` and says which Istio version it was compared against.
 */
import type { IngressDnsEntry, IngressEnvoyFilters, TrafficIngress } from '../../../api';
import { CENTER, DataTable, type Column } from '../../../components/DataTable';
import { Field } from '../../../components/layout';
import { CellList, Dot, Empty, Pill } from '../../../components/ui';
import { ago } from '../../../format';
import { Bytes, IngressCard, ReadGap } from './parts';
import { ingressWasRead, rateLine } from './shared';
import { lbAddressRows, notFromServer, readFailed, type LbAddressRow } from './edge-view';
import { podTone } from './IngressOverview';

type EnvoyFilterRow = IngressEnvoyFilters['items'][number];

export function IngressGateway({ ingress }: { ingress: TrafficIngress | undefined }): JSX.Element {
  const read = ingressWasRead(ingress);
  const tier = ingress?.tier;
  const s = ingress?.summary;
  const rate = rateLine(s?.rate);
  const lb = ingress?.lb;
  const dnsGap = readFailed('DNSEntries', ingress?.dnsEntries);
  const filters = ingress?.envoyFilters;
  const filterGap = readFailed('EnvoyFilters', filters);

  const lbRows = lb ? lbAddressRows(lb) : [];
  const lbColumns: Column<LbAddressRow>[] = [
    {
      key: 'address',
      header: 'Address',
      pin: true,
      max: '360px',
      sortValue: d => d.address,
      render: d => (
        <span className="mono block truncate text-[12px]" title={d.kind === 'ip' ? `${d.address}, published by the provider as an IP` : d.address}>
          {d.address}
        </span>
      )
    },
    {
      key: 'ips',
      header: 'Resolves to',
      max: '320px',
      sortValue: d => d.ips.length,
      render: d =>
        d.kind === 'ip' ? (
          <span className="text-[12px] text-muted" title="The provider published this address directly; there is no hostname to look up.">
            published as an IP
          </span>
        ) : d.error ? (
          <span className="text-[12px] text-warn" title={d.error}>
            lookup failed: {d.error}
          </span>
        ) : (
          <CellList items={d.ips} empty="no address" className="mono text-[12px]" />
        )
    },
    {
      key: 'resolved',
      header: 'Resolved',
      width: '104px',
      sortValue: d => d.resolvedAt,
      render: d => <span className="text-[12px] text-muted">{d.resolvedAt ? ago(d.resolvedAt) : '—'}</span>
    }
  ];

  const dnsColumns: Column<IngressDnsEntry>[] = [
    {
      key: 'entry',
      header: 'DNSEntry',
      pin: true,
      max: '260px',
      sortValue: e => `${e.namespace}/${e.name}`,
      render: e => (
        <span className="mono block truncate text-[12px]" title={`${e.namespace}/${e.name}`}>
          {e.namespace}/{e.name}
        </span>
      )
    },
    {
      key: 'dnsName',
      header: 'DNS name',
      max: '320px',
      sortValue: e => e.dnsName,
      render: e => (
        // Targets sheds under 900px; its value stays here, since a DNSEntry pointing at the wrong
        // load balancer is exactly what an operator looks for.
        <span className="mono block truncate text-[12px]" title={`${e.dnsName}\nTargets: ${e.targets.length ? e.targets.join(', ') : 'no target'}`}>
          {e.dnsName}
        </span>
      )
    },
    {
      key: 'targets',
      header: 'Targets',
      // Sheds under 900px; the DNS name's tooltip carries it.
      priority: 3,
      max: '280px',
      sortValue: e => e.targets[0] ?? null,
      render: e => <CellList items={e.targets} empty="no target" className="mono text-[12px] text-muted" />
    },
    {
      key: 'state',
      header: 'State',
      width: '104px',
      sortValue: e => e.state,
      render: e => <Pill tone={e.state === 'Ready' ? 'ok' : e.state ? 'warn' : 'unknown'}>{e.state ?? 'not reported'}</Pill>
    }
  ];

  const filterColumns: Column<EnvoyFilterRow>[] = [
    {
      key: 'name',
      header: 'EnvoyFilter',
      pin: true,
      max: '360px',
      sortValue: f => `${f.namespace}/${f.name}`,
      render: f => (
        <span className="mono block truncate text-[12px]" title={`${f.namespace}/${f.name}`}>
          {f.namespace}/{f.name}
        </span>
      )
    },
    {
      key: 'proxyVersion',
      header: 'Proxy version',
      max: '200px',
      sortValue: f => f.proxyVersion,
      render: f => <span className="mono block truncate text-[12px] text-muted">{f.proxyVersion ?? 'any'}</span>
    },
    {
      key: 'applies',
      header: 'Applies',
      ...CENTER,
      width: '92px',
      sortValue: f => (f.applies === null ? -1 : f.applies ? 1 : 0),
      render: f =>
        f.applies === false ? (
          <Pill tone="warn" title={`Its proxyVersion match cannot match Istio ${filters?.istioVersion ?? '(version not read)'}, so it patches nothing.`}>
            dead
          </Pill>
        ) : f.applies ? (
          <Pill tone="ok">yes</Pill>
        ) : (
          <Pill tone="unknown" title="The running Istio version was not read, so whether this applies is unknown.">
            unknown
          </Pill>
        )
    }
  ];

  return (
    <div className="space-y-5">
      <IngressCard
        title="Gateway pods"
        hint="The ingress gateway Deployment's pods, its autoscaler and its disruption budget, read from the API server."
      >
        {tier ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
            <Field
              label="Pods"
              value={
                <span className="inline-flex items-baseline gap-2" title={tier.pods.names.join(', ') || 'No pod matched the ingress gateway selector.'}>
                  <Dot tone={podTone(tier.pods)} />
                  <span className="mono">
                    {tier.pods.ready} ready / {tier.pods.running} running / {tier.pods.total}
                  </span>
                </span>
              }
            />
            <Field
              label="Container restarts"
              value={<span className={`mono ${tier.pods.restarts > 0 ? 'text-warn' : ''}`}>{tier.pods.restarts}</span>}
            />
            <Field
              label="Autoscaler"
              value={
                tier.hpa ? (
                  <span
                    className="inline-flex items-baseline gap-2"
                    title={tier.hpa.conditions.map(c => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`).join(', ') || `HPA ${tier.hpa.namespace}/${tier.hpa.name}`}
                  >
                    <span className="mono">
                      {tier.hpa.current ?? '—'} of {tier.hpa.min ?? '—'}–{tier.hpa.max ?? '—'}
                    </span>
                    {tier.hpa.atCeiling && (
                      <Pill tone="warn" title="Current replicas equal the configured maximum; added load turns into latency or 503s rather than more pods.">
                        at ceiling
                      </Pill>
                    )}
                  </span>
                ) : (
                  <span className="text-muted">no HorizontalPodAutoscaler targets the gateway</span>
                )
              }
            />
            <Field
              label="Disruption budget"
              value={
                tier.pdb ? (
                  <span className="inline-flex items-baseline gap-2" title={`PDB ${tier.pdb.namespace}/${tier.pdb.name}: minAvailable ${tier.pdb.minAvailable ?? '—'}, maxUnavailable ${tier.pdb.maxUnavailable ?? '—'}`}>
                    <span className="mono">
                      {tier.pdb.disruptionsAllowed ?? '—'} allowed, {tier.pdb.currentHealthy ?? '—'} healthy of {tier.pdb.expectedPods ?? '—'}
                    </span>
                    {tier.pdb.disruptionsAllowed === 0 && (
                      <Pill tone="warn" title="A node drain touching a gateway pod blocks until the budget recovers.">
                        0 allowed
                      </Pill>
                    )}
                  </span>
                ) : (
                  <span className="text-muted">no PodDisruptionBudget covers the gateway</span>
                )
              }
            />
            <Field label="Namespaces" value={<CellList items={tier.pods.namespaces} empty="none" className="mono text-[13px]" />} />
            <Field label="Edge rate" value={<span className="mono" title={rate.why}>{rate.value}</span>} />
            <Field label="Bytes sent" value={read ? <Bytes total={s?.bytesSent ?? null} /> : <span className="text-muted">—</span>} />
            <Field label="Bytes received" value={read ? <Bytes total={s?.bytesReceived ?? null} /> : <span className="text-muted">—</span>} />
          </div>
        ) : (
          <Empty
            title="The ingress tier could not be read"
            hint="The pod, Service, HPA and PDB reads behind this panel did not all answer. The page-level notice above names which one and why."
          />
        )}
      </IngressCard>

      <IngressCard
        title="Load balancer"
        label={lb ? String(lbRows.length) : undefined}
        hint="The gateway's LoadBalancer Service: each hostname its provider published with what srv resolved it to at read time, then any address published directly as an IP."
      >
        {tier?.service && (
          <p className="mb-2 text-[12px] text-muted">
            Service <span className="mono text-text">{tier.service.namespace}/{tier.service.name}</span>, type{' '}
            <span className="mono">{tier.service.type ?? 'not recorded'}</span>
            {tier.service.ports.length > 0 && (
              <>
                , ports <span className="mono">{tier.service.ports.map(p => p.port ?? '—').join(', ')}</span>
              </>
            )}
          </p>
        )}
        {lb ? (
          <DataTable
            columns={lbColumns}
            rows={lbRows}
            rowKey={d => `${d.kind}:${d.address}`}
            empty={<Empty title="No load balancer address reported" hint="status.loadBalancer.ingress is empty: the provider has not assigned an address, or the Service is not a LoadBalancer." />}
          />
        ) : (
          <ReadGap
            status={
              lb === null
                ? { ...notFromServer('Load balancer DNS'), why: 'the Services read failed or the load balancer DNS was not resolved on this read' }
                : notFromServer('Load balancer DNS')
            }
          />
        )}
      </IngressCard>

      <IngressCard
        title="DNSEntries"
        label={ingress?.dnsEntries && !ingress.dnsEntries.unavailable ? String(ingress.dnsEntries.items.length) : undefined}
        hint="Gardener DNSEntries: the names published onto the load balancer. A host with no DNSEntry is reachable only by whoever set its DNS by hand."
      >
        {dnsGap ? (
          <ReadGap status={dnsGap} />
        ) : (
          <DataTable
            columns={dnsColumns}
            rows={ingress?.dnsEntries?.items ?? []}
            rowKey={e => `${e.namespace}/${e.name}`}
            empty={<Empty title="No DNSEntry exists" hint="Names on this edge are published some other way, or not at all." />}
          />
        )}
      </IngressCard>

      {/* `gateway-envoyfilters`: where a dead-EnvoyFilter Problems row lands (problem-landing.ts). */}
      <div id="gateway-envoyfilters" className="rounded-[8px]">
      <IngressCard
        title="EnvoyFilters"
        label={filters && !filters.unavailable ? `${filters.items.length}${filters.dead ? ` · ${filters.dead} dead` : ''}` : undefined}
        hint={`EnvoyFilters patching the mesh, with whether their proxyVersion match can match the running Istio${filters?.istioVersion ? ` (${filters.istioVersion})` : ''}. A dead one patches nothing.`}
      >
        {filterGap ? (
          <ReadGap status={filterGap} />
        ) : (
          <DataTable
            columns={filterColumns}
            rows={[...(filters?.items ?? [])].sort((a, b) => Number(a.applies !== false) - Number(b.applies !== false))}
            rowKey={f => `${f.namespace}/${f.name}`}
            empty={<Empty title="No EnvoyFilter exists" hint="Nothing patches the gateway's generated Envoy config." />}
          />
        )}
      </IngressCard>
      </div>
    </div>
  );
}
