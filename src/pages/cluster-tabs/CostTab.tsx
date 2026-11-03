/**
 * Cost & budget for one cluster — what its nodes cost, how much of that is doing work, and which
 * namespaces are responsible for it.
 *
 * ## Why this tab talks about itself more than the others do
 *
 * Every other tab renders facts read from the cluster. This one renders facts *multiplied by a
 * rate card*, and the rate card is not readable from anywhere — not from the cluster, not from SAP
 * BTP, not from the hyperscaler. So the screen has three obligations no other tab carries:
 *
 *   1. **Say it is an estimate, everywhere it shows money.** Not in a footnote. An operator who
 *      takes one of these figures into a budget conversation as an invoice figure has been
 *      misled by this screen, and "$1,103.76" to the cent invites exactly that.
 *   2. **Show the two meters as two meters.** USD list price plus the Kyma surcharge is the
 *      authoritative one; SAP Capacity Units are a second, normalized model that disagrees with
 *      it by around 20%. Printing them side by side without that number lets an operator
 *      discover the gap by multiplying and getting a third answer.
 *   3. **Never turn an unknown into a zero, and qualify every figure the same way.** A node whose
 *      machine type is not in the rate card has no price, so the cluster total is a FLOOR and reads
 *      `≥`; a node priced from its shape makes the total an approximation with no known direction
 *      and reads `≈`. That qualifier comes from the server once (`costQualifier`) and is applied by
 *      `cost-provenance.ts` to every dollar on the screen — tiles, node rows, namespace rows and
 *      the idle row — because a header reading "at least $4,102" above rows of exact dollars over
 *      the same data is worse than either rendering alone. `null` money renders as unavailable,
 *      never as `$0`, and a namespace whose share could not be computed is reported as unweighed
 *      rather than folded into the idle row as though nobody were paying for it.
 *   4. **Say where the rate card came from.** Source, region and price date, all three, including
 *      when the honest answer is that the built-in list has no region dimension at all.
 *
 * The simulator is arithmetic over rates the *server* computed (`hyperscalerCatalog`): the browser
 * multiplies, it never holds a rate card. Its headroom projection is the one derived figure on the
 * tab and the panel says so — it scales today's kubelet reservation ratio onto the simulated
 * machines, because what a node reserves is a property of the node and cannot be read for a node
 * that does not exist.
 */
import { useCallback, useMemo, useState } from 'react';
import { api } from '../../api';
import { CENTER, DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { Card, ErrorBanner, ErrorState, Pill, Skeleton, TONE_TEXT } from '../../components/ui';
import {
  MetricValue,
  StatTile,
  UnavailableEmptyBody,
  UnavailableNotice,
  envelopeScope,
  unavailableScope
} from '../../components/unavailable';
import { COLUMN_INFO } from '../../components/table/column-info';
import { band, percent } from '../../format';
import { useAsync } from '../../useAsync';
import type { CostAttributionRow, CostCatalogEntry, CostNode } from '../../api';
import {
  qualifiedHourlyUsd,
  qualifiedUsd,
  qualifierCaption,
  qualifierPillLabel,
  rateCardProvenance,
  unattributedNote,
  usd,
  type CostQualifier,
  type RateCardProvenance
} from './cost-provenance';

/*
  The provenance and qualifier fields `/clusters/:id/cost` now returns are not yet declared on
  `CostSummary` in api.ts (a file this change does not own), so they are read through this shape.
  Every field is optional and every consumer treats absence as unknown, never as a default.
*/
type CostProvenance = RateCardProvenance & {
  costQualifier?: CostQualifier | null;
  derivedRateNodes?: number | null;
  unattributedNamespaces?: number | null;
};

/*
  There is no second currency on this screen, deliberately.
  `/clusters/:id/cost` still returns a derived `monthlyEur`, and presenting it beside the dollar
  figure put two currencies and two meters — four numbers for one machine — in front of an operator
  whose next action depends on exactly one of them. USD is the authoritative figure for this feature,
  so USD is the only money rendered; the Capacity Unit meter stays because it is what SAP actually
  bills, and it is stated in CU, not converted.
*/
function signedUsd(n: number | null): string {
  if (n === null) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${usd(Math.abs(n))}`;
}

/** Why a node has no price. Two different operator actions, so never collapsed into one word. */
const UNPRICED_TEXT: Record<string, string> = {
  UNKNOWN_INSTANCE_TYPE: 'this machine type is not in the rate card',
  NO_INSTANCE_TYPE_LABEL: 'the node carries no instance-type label'
};

export default function CostTab({ id }: { id: string }) {
  const { data, loading, error } = useAsync(useCallback(() => api.clusterCost(id), [id]), 0, id);
  const payload = data?.ok ? data.data : undefined;
  const summary = payload?.summary;
  const prov: CostProvenance | undefined = summary as CostProvenance | undefined;
  /*
    One qualifier for every dollar on this screen. Derived from the server's `costQualifier`, with
    `costIsFloor` as the fallback for a server that predates it — so an old payload still qualifies
    its headline rather than printing an exact-looking total.
  */
  const qualifier: CostQualifier = prov?.costQualifier ?? (summary?.costIsFloor ? 'floor' : 'exact');

  // Two reads behind this payload, and they fail independently: without nodes there is no cost at
  // all, without pods there is cost but no attribution. One scope, two statuses.
  const scope = useMemo(() => (summary ? envelopeScope(id, summary) : unavailableScope({})), [summary, id]);
  const nodeStatus = scope.of('node costs', 'nodes');
  const podStatus = scope.of('namespace attribution', 'pods');

  // --- simulator state. Seeded from the cluster, so the panel opens on "what I have now".
  const [simType, setSimType] = useState<string | null>(null);
  const [simCount, setSimCount] = useState<number | null>(null);

  const catalogOptions = useMemo(() => {
    const out: { provider: string; entries: CostCatalogEntry[] }[] = [];
    for (const [provider, entries] of Object.entries(payload?.hyperscalerCatalog ?? {})) {
      out.push({ provider, entries: [...entries].sort((a, b) => a.cpu - b.cpu || a.instanceType.localeCompare(b.instanceType)) });
    }
    return out.sort((a, b) => a.provider.localeCompare(b.provider));
  }, [payload?.hyperscalerCatalog]);

  const flatCatalog = useMemo(() => catalogOptions.flatMap(g => g.entries), [catalogOptions]);

  /** The cluster's most common priced machine — the honest default for "change one thing". */
  const dominantType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of payload?.nodes ?? []) {
      if (!n.instanceType) continue;
      counts.set(n.instanceType, (counts.get(n.instanceType) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [type, count] of counts) {
      if (count > bestCount && flatCatalog.some(e => e.instanceType === type)) {
        best = type;
        bestCount = count;
      }
    }
    return best ?? flatCatalog[0]?.instanceType ?? null;
  }, [payload?.nodes, flatCatalog]);

  const activeType = simType ?? dominantType;
  const activeCount = simCount ?? summary?.nodeCount ?? 0;
  const selected = useMemo(() => flatCatalog.find(e => e.instanceType === activeType) ?? null, [flatCatalog, activeType]);

  const sim = useMemo(() => {
    if (!selected || !summary) return null;
    const monthlyUsd = selected.monthlyUsd === null ? null : Math.round(selected.monthlyUsd * activeCount * 100) / 100;
    const monthlyCu = selected.monthlyCu === null ? null : Math.round(selected.monthlyCu * activeCount * 10) / 10;
    const delta = monthlyUsd === null || summary.monthlyUsd === null ? null : Math.round((monthlyUsd - summary.monthlyUsd) * 100) / 100;
    const cpuCapacity = Math.round(selected.cpu * activeCount * 100) / 100;
    const memCapacity = Math.round(selected.memGiB * activeCount * 100) / 100;

    /*
      Simulated allocatable, not simulated capacity: requests land on allocatable, so comparing
      today's requests with tomorrow's raw capacity would flatter the projection by the whole
      kubelet reservation. The reservation ratio is measured on the nodes that exist — the one
      derived number on this tab, and the panel labels it a projection for that reason.
    */
    const cpuRatio = summary.cpuCapacity && summary.cpuAllocatable ? summary.cpuAllocatable / summary.cpuCapacity : null;
    const memRatio = summary.memGiBCapacity && summary.memGiBAllocatable ? summary.memGiBAllocatable / summary.memGiBCapacity : null;
    const cpuAllocatable = cpuRatio === null ? null : cpuCapacity * cpuRatio;
    const memAllocatable = memRatio === null ? null : memCapacity * memRatio;
    const cpuPct =
      cpuAllocatable && summary.requestedCpu !== null ? Math.round((summary.requestedCpu / cpuAllocatable) * 1000) / 10 : null;
    const memPct =
      memAllocatable && summary.requestedMemGiB !== null
        ? Math.round((summary.requestedMemGiB / memAllocatable) * 1000) / 10
        : null;

    return { monthlyUsd, monthlyCu, delta, cpuCapacity, memCapacity, cpuPct, memPct };
  }, [selected, summary, activeCount]);

  const nodeColumns: Column<CostNode>[] = [
    {
      key: 'name',
      header: 'Node',
      pin: true,
      max: '240px',
      sortValue: n => n.name,
      render: n => <span className="mono text-[13px] text-text">{n.name}</span>
    },
    {
      key: 'type',
      header: 'Machine type',
      max: '160px',
      sortValue: n => n.instanceType,
      render: n =>
        n.instanceType ? <span className="mono text-[13px] text-accent">{n.instanceType}</span> : <span className="text-muted">unlabelled</span>
    },
    {
      key: 'zone',
      header: 'Zone',
      max: '140px',
      priority: 3,
      sortValue: n => n.zone,
      render: n => <span className="text-muted">{n.zone ?? '—'}</span>
    },
    {
      key: 'shape',
      header: 'vCPU / GiB',
      ...NUMERIC,
      width: '120px',
      title: () => 'Billable capacity, as the node declares it — the whole machine, not the schedulable remainder',
      sortValue: n => n.vCpu,
      render: n => (
        <span className="mono text-[13px] text-muted">
          {n.vCpu ?? '—'} / {n.memoryGiB ?? '—'}
        </span>
      )
    },
    {
      key: 'ready',
      header: 'Ready',
      ...CENTER,
      priority: 3,
      title: () => 'A NotReady node still bills, so this never changes the price beside it',
      sortValue: n => (n.ready === null ? -1 : n.ready ? 1 : 0),
      render: n =>
        n.ready === null ? (
          <Pill tone="unknown">No condition</Pill>
        ) : (
          <Pill tone={n.ready ? 'ok' : 'bad'}>{n.ready ? 'Ready' : 'NotReady'}</Pill>
        )
    },
    {
      key: 'hourly',
      header: 'Per hour',
      ...NUMERIC,
      width: '110px',
      priority: 2,
      sortValue: n => n.hourlyUsd,
      render: n => (
        <span className="mono text-[13px] text-muted">
          {n.hourlyUsd === null ? '—' : `${n.rateSource === 'derived' ? '≈' : ''}$${n.hourlyUsd.toFixed(3)}`}
        </span>
      )
    },
    {
      key: 'monthly',
      header: 'Per month (est.)',
      ...NUMERIC,
      width: '150px',
      title: () => 'A row priced from its shape rather than from a stated rate reads ≈ — the rate card has no entry for that machine',
      sortValue: n => n.monthlyUsd,
      render: n =>
        n.monthlyUsd === null ? (
          <span className="text-warn" title={UNPRICED_TEXT[n.unpricedReason ?? ''] ?? 'no rate for this machine'}>
            Not priced
          </span>
        ) : (
          // Per row, not the cluster qualifier: this row is exact when its own rate was stated.
          <span className={`mono text-[13px] font-semibold ${n.rateSource === 'derived' ? 'text-warn' : 'text-text'}`}>
            {qualifiedUsd(n.monthlyUsd, n.rateSource === 'derived' ? 'approximate' : 'exact')}
          </span>
        )
    },
    {
      key: 'cu',
      header: 'Capacity Units',
      ...NUMERIC,
      width: '130px',
      priority: 2,
      title: () => 'The second meter: normalized 2 vCPU / 8 GiB units at 0.14 CU per hour. Not the same model as the dollar column',
      sortValue: n => n.monthlyCu,
      render: n => <span className="mono text-[13px] text-muted">{n.monthlyCu === null ? '—' : n.monthlyCu.toFixed(1)}</span>
    },
    {
      key: 'source',
      // "Priced from", not "Rate": the alignment classifier reads a header ending in "rate" as a
      // magnitude and would right-align a column of pills. See components/table/align.ts.
      header: 'Priced from',
      priority: 3,
      title: () =>
        'catalog: a stated rate for this exact machine. derived: priced from its shape at the m5 family per-unit rate, which runs above some families and below others — an approximation with no known direction',
      sortValue: n => n.rateSource,
      render: n =>
        n.rateSource === null ? (
          <span className="text-warn text-[12px]">{UNPRICED_TEXT[n.unpricedReason ?? ''] ?? 'no rate'}</span>
        ) : (
          <Pill tone={n.rateSource === 'catalog' ? 'ok' : 'warn'}>{n.rateSource === 'catalog' ? 'Rate card' : 'Derived'}</Pill>
        )
    }
  ];

  const attributionColumns: Column<CostAttributionRow>[] = [
    {
      key: 'ns',
      header: 'Namespace',
      pin: true,
      max: '240px',
      sortValue: r => r.namespace,
      render: r => <span className="mono text-[13px] text-text">{r.namespace}</span>
    },
    {
      key: 'pods',
      header: 'Pods',
      ...NUMERIC,
      width: '90px',
      // Sheds first: the count is context, the requests and the share are what the bill is made of.
      priority: 3,
      sortValue: r => r.pods,
      render: r => <span className="mono text-[13px] text-muted">{r.pods}</span>
    },
    {
      key: 'cpu',
      header: 'CPU requested',
      ...NUMERIC,
      width: '130px',
      sortValue: r => r.cpuRequested,
      render: r => <span className="mono text-[13px] text-muted">{r.cpuRequested === null ? '—' : `${r.cpuRequested} vCPU`}</span>
    },
    {
      key: 'mem',
      header: 'Memory requested',
      ...NUMERIC,
      width: '140px',
      sortValue: r => r.memGiBRequested,
      render: r => <span className="mono text-[13px] text-muted">{r.memGiBRequested === null ? '—' : `${r.memGiBRequested} GiB`}</span>
    },
    {
      // One share column: the two resource shares it is averaged from ride in the cell's tooltip,
      // so the number the monthly figure is computed from is the only one an operator has to read.
      key: 'share',
      header: 'Cost share',
      ...NUMERIC,
      width: '120px',
      info: COLUMN_INFO.costShare,
      title: r => `CPU ${percent(r.cpuSharePct)} · Memory ${percent(r.memSharePct)} of cluster allocatable`,
      sortValue: r => r.sharePct,
      render: r => <span className={`mono text-[13px] ${TONE_TEXT[band(r.sharePct)]}`}>{percent(r.sharePct)}</span>
    },
    {
      key: 'spend',
      header: 'Monthly (est.)',
      ...NUMERIC,
      width: '140px',
      title: () => 'This namespace’s share of the cluster total, so it carries the same qualifier as the headline figure',
      sortValue: r => r.monthlyUsd,
      // The same qualifier as the tile above: these are shares OF that possibly-floored total.
      render: r => <span className="mono text-[13px] font-semibold text-text">{qualifiedUsd(r.monthlyUsd, qualifier)}</span>
    }
  ];

  if (loading && !data) return <Skeleton rows={8} />;

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

  const qualified = qualifier !== 'exact';

  return (
    <div className="space-y-5">
      {error && <ErrorBanner code={error.code} message={error.message} />}

      <UnavailableNotice scope={scope} />

      {/*
        The disclaimer sits above the numbers, not below them. It is the first thing the tab says
        because it is the thing that changes how every figure underneath should be read.
      */}
      <div className="rounded-[8px] border border-line bg-raised p-4 text-[13px] leading-relaxed text-muted">
        <span className="font-semibold text-text">These figures are an estimate, not a bill.</span> Nothing on this tab is read from
        an SAP BTP or hyperscaler invoice — no such API is reachable from this console. Each node&apos;s declared machine type and
        capacity is priced against a rate card held on the server ({rateCardProvenance(prov)}), at{' '}
        {summary?.hoursPerMonth ?? 730} hours per month. Reserved instances, savings plans, storage, egress, load balancers and
        support are not modelled and would each move the real figure.
        {summary?.modelDivergencePct !== null && summary?.modelDivergencePct !== undefined && (
          <>
            {' '}
            The <span className="text-text">SAP Capacity Unit</span> column is a second, independent model: on this cluster it values
            the same hardware {Math.abs(summary.modelDivergencePct)}% {summary.modelDivergencePct >= 0 ? 'above' : 'below'} the dollar
            figure ({qualifiedUsd(summary.monthlyUsdOnCuMeter, qualifier)} against {qualifiedUsd(summary.monthlyUsd, qualifier)} per month). Both are shown; neither is
            reconciled into the other — the dollar column is hyperscaler list rate plus the Kyma management fee, while a
            Capacity Unit is a normalized {summary.cuUnitCpu} vCPU / {summary.cuUnitMemGiB} GiB node-hour at{' '}
            {summary.cuHourlyPerUnit} CU, billed at {usd(summary.cuRateUsd, 2)} per CU.
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile
          label="Projected spend (USD list + Kyma fee)"
          status={nodeStatus}
          value={<MetricValue status={nodeStatus} size="lg">{qualifiedUsd(summary?.monthlyUsd, qualifier)}</MetricValue>}
          caption={qualifierCaption(qualifier, summary?.unpricedNodes, prov?.derivedRateNodes)}
          valueClass={qualified ? 'text-warn' : 'text-text'}
        />
        <StatTile
          label="Hourly burn"
          status={nodeStatus}
          value={
            <MetricValue status={nodeStatus} size="lg">
              {qualifiedHourlyUsd(summary?.hourlyUsd, qualifier)}
            </MetricValue>
          }
          caption={`${summary?.nodeCount ?? '—'} billable nodes, ${summary?.cpuCapacity ?? '—'} vCPU / ${summary?.memGiBCapacity ?? '—'} GiB of hardware`}
        />
        <StatTile
          label="Requested against allocatable"
          status={podStatus}
          value={
            <MetricValue status={podStatus} size="lg">
              {percent(summary?.requestedCpuPct)}
            </MetricValue>
          }
          caption={`CPU requested; memory at ${percent(summary?.requestedMemPct)}. Reservations, not live usage`}
          valueClass={`${TONE_TEXT[band(summary?.requestedCpuPct)]}`}
        />
        <StatTile
          label="Live utilization"
          status={nodeStatus}
          value={
            <MetricValue status={nodeStatus} size="lg">
              {percent(summary?.cpuUtilizationPct)}
            </MetricValue>
          }
          caption={
            summary?.usageSource === 'metrics-server'
              ? `CPU now; memory at ${percent(summary.memoryUtilizationPct)} — a current sample, not an average`
              : summary?.usageSource === 'metrics-server:partial'
                ? 'metrics-server answered for only some nodes, so no cluster figure is claimed'
                : 'metrics-server did not answer — only requested resources are known'
          }
          valueClass={`${TONE_TEXT[band(summary?.cpuUtilizationPct)]}`}
        />
      </div>

      {/*
        The simulator. Two inputs, and every output is a multiplication of a rate the server
        computed — the browser holds no rate card, so an operator override on the server reaches
        this panel without a rebuild.
      */}
      <Card
        title="What if this cluster ran different machines?"
        action={
          <span className="text-[12px] text-muted">
            Read-only arithmetic. Nothing here scales, provisions or changes the cluster.
          </span>
        }
      >
        {flatCatalog.length === 0 ? (
          <UnavailableEmptyBody status={nodeStatus} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
            <div className="space-y-4">
              <label className="block">
                <span className="text-[13px] text-muted">Machine type</span>
                <select
                  value={activeType ?? ''}
                  onChange={e => setSimType(e.target.value)}
                  className="mt-1 w-full rounded-[6px] border border-line bg-raised px-3 py-1.5 text-[13px] text-text focus:border-accent focus:outline-none"
                >
                  {catalogOptions.map(group => (
                    <optgroup key={group.provider} label={group.provider.toUpperCase()}>
                      {group.entries.map(entry => (
                        <option key={`${group.provider}/${entry.instanceType}`} value={entry.instanceType}>
                          {entry.instanceType} — {entry.cpu} vCPU / {entry.memGiB} GiB
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-[13px] text-muted">
                  Node count: <span className="mono text-text">{activeCount}</span>
                </span>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={Math.min(20, Math.max(1, activeCount))}
                  onChange={e => setSimCount(Number(e.target.value))}
                  className="mt-2 w-full accent-[var(--accent)]"
                  aria-label="Simulated node count"
                />
                <span className="mt-1 block text-[12px] text-muted">
                  Cluster has {summary?.nodeCount ?? '—'} billable node{summary?.nodeCount === 1 ? '' : 's'} today.
                </span>
              </label>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                <div>
                  <div className="text-[13px] text-muted">Projected monthly</div>
                  <div className="mono mt-1 text-[22px] font-semibold leading-7 text-text">{usd(sim?.monthlyUsd ?? null)}</div>
                </div>
                <div>
                  <div className="text-[13px] text-muted">Change against today</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span
                      className={`mono text-[22px] font-semibold leading-7 ${
                        sim?.delta === null || sim?.delta === undefined ? 'text-muted' : sim.delta > 0 ? 'text-bad' : sim.delta < 0 ? 'text-ok' : 'text-muted'
                      }`}
                    >
                      {signedUsd(sim?.delta ?? null)}
                    </span>
                    {qualifierPillLabel(qualifier) && <Pill tone="warn">{qualifierPillLabel(qualifier)}</Pill>}
                  </div>
                </div>
                <div>
                  <div className="text-[13px] text-muted">Capacity Units</div>
                  <div className="mono mt-1 text-[22px] font-semibold leading-7 text-muted">
                    {sim?.monthlyCu === null || sim?.monthlyCu === undefined ? '—' : sim.monthlyCu.toFixed(1)}
                  </div>
                </div>
              </div>

              <div className="rounded-[6px] border border-line bg-surface p-3 text-[12px] leading-relaxed text-muted">
                <div>
                  Hardware: <span className="mono text-text">{sim?.cpuCapacity ?? '—'}</span> vCPU /{' '}
                  <span className="mono text-text">{sim?.memCapacity ?? '—'}</span> GiB.
                </div>
                <div className="mt-1">
                  Today&apos;s requests would then sit at <span className="mono text-text">{percent(sim?.cpuPct ?? null)}</span> of CPU
                  and <span className="mono text-text">{percent(sim?.memPct ?? null)}</span> of memory — a projection, not a reading:
                  it scales this cluster&apos;s current kubelet reservation ratio onto machines that do not exist yet, and assumes the
                  same workloads still fit and still schedule.
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card title={`Node spend (${payload?.nodes.length ?? 0})`} flush>
        <DataTable
          id="cost.nodes"
          columns={nodeColumns}
          rows={payload?.nodes ?? []}
          rowKey={n => n.name}
          shed="mid"
          empty={nodeStatus.state === 'ok' ? 'No billable nodes found' : <UnavailableEmptyBody status={nodeStatus} />}
        />
      </Card>

      <Card
        title="Namespace attribution"
        action={
          <span className="text-[12px] text-muted">
            Each namespace&apos;s slice of the monthly bill, based on the CPU and memory its workloads reserve
          </span>
        }
      >
        <div className="space-y-3">
          {/*
            The idle row is above the table, not a footer inside it: it is the largest single line
            item on most clusters and the most actionable number on the tab. Rows below it sum to
            the remainder, which is why they do not add up to 100% — that is the point of showing
            it rather than distributing it across tenants who did not ask for it.
          */}
          <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-[6px] border border-line bg-raised px-3 py-2">
            <span
              className="text-[13px] text-text"
              title="Allocatable CPU and memory no workload has requested. It is paid for with the nodes and is the headroom new pods schedule into"
            >
              Unallocated capacity <span className="text-muted">(available cluster buffer)</span>
            </span>
            <span className="flex items-baseline gap-3">
              <span className={`mono text-[15px] font-semibold ${TONE_TEXT[band(payload?.unallocated.sharePct)]}`}>
                {percent(payload?.unallocated.sharePct)}
              </span>
              {/* The same qualifier as the headline: this row is a share of the same total. */}
              <span className="mono text-[15px] text-muted">({qualifiedUsd(payload?.unallocated.monthlyUsd ?? null, qualifier)} / mo)</span>
            </span>
          </div>
          {unattributedNote(prov?.unattributedNamespaces) && (
            <div className="rounded-[6px] border border-line bg-surface px-3 py-2 text-[12px] leading-relaxed text-warn">
              {unattributedNote(prov?.unattributedNamespaces)}
            </div>
          )}
          <DataTable
            id="cost.attribution"
            columns={attributionColumns}
            rows={payload?.attribution ?? []}
            rowKey={r => r.namespace}
            shed="mid"
            empty={
              podStatus.state === 'ok' ? 'No Running or Pending pods to attribute' : <UnavailableEmptyBody status={podStatus} />
            }
          />
        </div>
      </Card>
    </div>
  );
}
