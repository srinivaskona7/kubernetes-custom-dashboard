/**
 * Cost & budget — what this cluster's nodes cost, what fraction of that is doing work, and
 * which namespaces are responsible for it.
 *
 * ## The honesty contract, which is most of this file
 *
 * Every other collector reports facts read from the cluster. This one multiplies facts by a
 * **rate card that is not readable from anywhere** — see the module note in `cost-catalog.js`.
 * That makes two failure modes specific to this collector, and both are handled by refusing to
 * produce a number rather than by producing a smaller one:
 *
 *   1. **An unpriced node.** A machine type absent from the catalog whose shape we also could
 *      not read has no price. Summing the rest and calling it "the cluster's monthly cost"
 *      would understate the bill by exactly the machines nobody could price, silently. So any
 *      unpriced node sets `costIsFloor: true` and is counted in `unpricedNodes`; the totals
 *      remain real, but they are a floor and say so.
 *   2. **A failed node read.** Then there is no cost at all — every money field is `null`,
 *      never `0`. `0` would read as a free cluster.
 *
 * ## Utilization is measured against allocatable; price is charged on capacity
 *
 * These are different denominators and mixing them produces a plausible, wrong answer. You pay
 * for the whole machine (`status.capacity`), but you can only schedule onto what is left after
 * the kubelet's reservations (`status.allocatable`) — typically 5-10% less. So:
 *
 *   - pricing uses **capacity**, because that is the hardware on the invoice;
 *   - `requestedCpuPct` / `requestedMemPct` use **allocatable**, because 100% of allocatable is
 *     genuinely full, whereas 100% of capacity is unreachable and would make a full cluster
 *     look like it had headroom left.
 *
 * ## Attribution attributes spend, not requests
 *
 * A namespace's share is its share of *requested* resources, and the requests of a half-empty
 * cluster do not add up to its bill. Distributing the whole bill across namespaces by request
 * share would charge tenants for idle capacity nobody asked for and hide the single most
 * actionable number on the page. So the unrequested remainder is its own row — `unallocated` —
 * and the namespace rows plus that row sum to the cluster total.
 *
 * The per-namespace weight is the **mean of its CPU share and its memory share**, the same
 * rule `cost-catalog.js` uses for normalized units, because a node's price covers both and
 * neither one alone explains it.
 */

import k8sModule from '../k8s.js';
const { list } = k8sModule;
import healthModule from './health.js';
const { parseCpu, parseMemory } = healthModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;
import metrics from './metrics.js';
import costCatalogModule from './cost-catalog.js';
const {
  HOURS_PER_MONTH,
  CU_RATE_EUR,
  CU_RATE_USD,
  NORMALIZED_UNIT,
  DEFAULT_CATALOG,
  loadCatalog,
  getMachineRate
} = costCatalogModule;

const BYTES_PER_GIB = 1024 ** 3;

/** One decimal percent, or null when the denominator is unknown — never 0 for "unknown". */
function pct(part, total) {
  if (!(total > 0)) return null;
  return Math.round((part / total) * 1000) / 10;
}

function round(n, places) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * A node's billable shape, from its own `status.capacity`.
 *
 * `capacity` rather than `allocatable` on purpose: the invoice is for the machine, not for the
 * schedulable remainder. Returns nulls rather than zeros when the field is missing, so
 * `getMachineRate` refuses to price it instead of pricing a 0-vCPU machine.
 */
function billableShape(node) {
  const capacity = (node.status && node.status.capacity) || {};
  const cpu = parseCpu(capacity.cpu);
  const memBytes = parseMemory(capacity.memory);
  return {
    cpu: cpu > 0 ? cpu : null,
    memGiB: memBytes > 0 ? round(memBytes / BYTES_PER_GIB, 2) : null
  };
}

/**
 * Is this node one we should be billing for at all?
 *
 * A node that exists in the API is being paid for whether or not it is Ready — a broken node
 * still bills — so readiness is reported but never used to exclude one. A node being *deleted*
 * is different: it is on its way out and double-counting it against its replacement would
 * overstate the bill during every rolling node upgrade.
 */
function isBillable(node) {
  return !(node.metadata && node.metadata.deletionTimestamp);
}

function readyState(node) {
  const cond = ((node.status && node.status.conditions) || []).find(c => c.type === 'Ready');
  if (!cond) return null;
  return cond.status === 'True';
}

/**
 * Per-node cost rows plus the cluster roll-up.
 *
 * @param {object[]} nodes raw Node objects
 * @param {object} catalog the rate card in force
 */
function priceNodes(nodes, catalog) {
  const rows = [];
  let hourlyUsd = 0;
  let monthlyUsd = 0;
  let monthlyEur = 0;
  let monthlyCu = 0;
  let unpricedNodes = 0;
  let derivedRateNodes = 0;
  let cpuCapacity = 0;
  let memGiBCapacity = 0;

  for (const node of nodes) {
    if (!isBillable(node)) continue;
    const meta = node.metadata || {};
    const labels = meta.labels || {};
    const instanceType = labels['node.kubernetes.io/instance-type']
      || labels['beta.kubernetes.io/instance-type']
      || null;
    const zone = labels['topology.kubernetes.io/zone']
      || labels['failure-domain.beta.kubernetes.io/zone']
      || null;
    const shape = billableShape(node);
    const rate = getMachineRate(instanceType, node.spec && node.spec.providerID, shape, { catalog });

    if (shape.cpu) cpuCapacity += shape.cpu;
    if (shape.memGiB) memGiBCapacity += shape.memGiB;

    if (!rate) {
      unpricedNodes += 1;
      rows.push({
        name: meta.name,
        zone,
        instanceType,
        // Reported as read, which may be null — a shape we could not read is why this row has
        // no price, and blanking it would hide the reason.
        vCpu: shape.cpu,
        memoryGiB: shape.memGiB,
        ready: readyState(node),
        hourlyUsd: null,
        monthlyUsd: null,
        monthlyEur: null,
        monthlyCu: null,
        rateSource: null,
        unpricedReason: instanceType ? 'UNKNOWN_INSTANCE_TYPE' : 'NO_INSTANCE_TYPE_LABEL'
      });
      continue;
    }

    hourlyUsd += rate.hourlyUsd;
    monthlyUsd += rate.monthlyUsd;
    monthlyEur += rate.monthlyEur;
    if (rate.monthlyCu !== null) monthlyCu += rate.monthlyCu;
    /*
      A derived rate is not a rate for this machine — it is the m5 family's per-unit price applied
      to a shape the catalog has never heard of. The catalog's own numbers put c5 at $0.1467 and r5
      at $0.1057 against the derived $0.126, so the error runs in BOTH directions and can be ~16%.
      It is therefore counted separately from `unpricedNodes`: an unpriced node makes the total a
      lower bound, a derived node makes it an approximation with no known direction. Collapsing the
      two would either claim a bound that does not hold or lose the disclosure entirely.
    */
    if (rate.source === 'derived') derivedRateNodes += 1;

    rows.push({
      name: meta.name,
      zone,
      instanceType: rate.instanceType,
      provider: rate.provider,
      vCpu: rate.cpu,
      memoryGiB: rate.memGiB,
      ready: readyState(node),
      hourlyUsd: rate.hourlyUsd,
      monthlyUsd: rate.monthlyUsd,
      monthlyEur: rate.monthlyEur,
      monthlyCu: rate.monthlyCu,
      normalizedUnits: rate.normalizedUnits,
      nodeHourlyUsd: rate.nodeHourlyUsd,
      sapFeeHourlyUsd: rate.sapFeeHourlyUsd,
      rateSource: rate.source,
      modelDivergencePct: rate.modelDivergencePct,
      unpricedReason: null
    });
  }

  return {
    rows,
    unpricedNodes,
    derivedRateNodes,
    cpuCapacity: round(cpuCapacity, 2),
    memGiBCapacity: round(memGiBCapacity, 2),
    hourlyUsd: round(hourlyUsd, 4),
    monthlyUsd: round(monthlyUsd, 2),
    monthlyEur: round(monthlyEur, 2),
    monthlyCu: round(monthlyCu, 2)
  };
}

/**
 * Requested CPU/memory per namespace, and the cluster totals.
 *
 * Only Running and Pending pods count, matching `capacity.js` and `topology.js`: a Succeeded or
 * Failed pod holds no reservation and counting it would inflate a namespace's share of the bill
 * with work that finished. Init containers are deliberately excluded for the same reason they
 * are elsewhere here — they do not hold their request for the pod's life.
 */
function requestsByNamespace(pods) {
  const byNamespace = new Map();
  let cpuTotal = 0;
  let memGiBTotal = 0;

  for (const pod of pods) {
    const phase = (pod.status && pod.status.phase) || 'Unknown';
    if (phase !== 'Running' && phase !== 'Pending') continue;
    const namespace = (pod.metadata && pod.metadata.namespace) || 'default';

    let cpu = 0;
    let memBytes = 0;
    for (const c of (pod.spec && pod.spec.containers) || []) {
      const req = (c.resources && c.resources.requests) || {};
      cpu += parseCpu(req.cpu);
      memBytes += parseMemory(req.memory);
    }
    const memGiB = memBytes / BYTES_PER_GIB;

    const bucket = byNamespace.get(namespace) || { namespace, cpuRequested: 0, memGiBRequested: 0, pods: 0 };
    bucket.cpuRequested += cpu;
    bucket.memGiBRequested += memGiB;
    bucket.pods += 1;
    byNamespace.set(namespace, bucket);
    cpuTotal += cpu;
    memGiBTotal += memGiB;
  }

  return { byNamespace, cpuTotal, memGiBTotal };
}

/**
 * Namespace spend attribution, plus the `unallocated` remainder.
 *
 * @param {Map} byNamespace
 * @param {{cpuAllocatable: number, memGiBAllocatable: number}} allocatable
 * @param {number|null} monthlyUsd the cluster total, or null when it is not known
 */
function attribute(byNamespace, totals, allocatable, monthlyUsd) {
  const rows = [];
  // The share of the CLUSTER (allocatable), not of the requested subtotal — that is what makes
  // the rows sum to less than 100% and leaves the remainder visible instead of inflating
  // everyone's bill to cover idle nodes.
  for (const bucket of byNamespace.values()) {
    const cpuShare = allocatable.cpuAllocatable > 0 ? bucket.cpuRequested / allocatable.cpuAllocatable : null;
    const memShare = allocatable.memGiBAllocatable > 0 ? bucket.memGiBRequested / allocatable.memGiBAllocatable : null;
    const share = cpuShare === null || memShare === null ? null : (cpuShare + memShare) / 2;
    rows.push({
      namespace: bucket.namespace,
      pods: bucket.pods,
      cpuRequested: round(bucket.cpuRequested, 3),
      memGiBRequested: round(bucket.memGiBRequested, 2),
      cpuSharePct: cpuShare === null ? null : round(cpuShare * 100, 1),
      memSharePct: memShare === null ? null : round(memShare * 100, 1),
      sharePct: share === null ? null : round(share * 100, 1),
      monthlyUsd: share === null || monthlyUsd === null ? null : round(share * monthlyUsd, 2)
    });
  }
  rows.sort((a, b) => (b.sharePct || 0) - (a.sharePct || 0));

  /*
    A null share is a namespace we could not weigh, not a namespace using nothing.

    Summing with `|| 0` made those namespaces contribute 0% to `claimed`, so their spend fell
    straight into the "Unallocated capacity (available cluster buffer)" row — the tab's most
    actionable number — as though idle. So they are counted instead, and while any of them exists
    the remainder is **unknown**: 100 minus an incomplete sum is not the idle share, and printing
    it would be the same error one level up.
  */
  const unattributedNamespaces = rows.filter(r => r.sharePct === null).length;
  const claimed = rows.reduce((n, r) => n + (r.sharePct === null ? 0 : r.sharePct), 0);
  // Clamped at 0: an overcommitted cluster can request more than it can schedule, and a
  // negative "idle" row is not a thing. It reads as 0% idle, which is true.
  const unallocatedPct = unattributedNamespaces > 0 ? null : round(Math.max(0, 100 - claimed), 1);

  return {
    namespaces: rows,
    unattributedNamespaces,
    unallocated: {
      sharePct: unallocatedPct,
      monthlyUsd: unallocatedPct === null || monthlyUsd === null ? null : round((unallocatedPct / 100) * monthlyUsd, 2)
    }
  };
}

/**
 * The simulator's menu. Sent from the server so the browser never holds a rate card of its own
 * — one rate card, one place, and an operator override reaches the UI without a rebuild.
 */
function catalogForSimulator(catalog) {
  const out = {};
  for (const [provider, family] of Object.entries(catalog)) {
    out[provider] = Object.entries(family).map(([instanceType, entry]) => {
      const rate = getMachineRate(instanceType, `${provider === 'gcp' ? 'gce' : provider}://`, null, { catalog });
      return {
        instanceType,
        cpu: entry.cpu,
        memGiB: entry.memGiB,
        normalizedUnits: rate ? rate.normalizedUnits : null,
        hourlyUsd: rate ? rate.hourlyUsd : null,
        monthlyUsd: rate ? rate.monthlyUsd : null,
        monthlyEur: rate ? rate.monthlyEur : null,
        monthlyCu: rate ? rate.monthlyCu : null,
        modelDivergencePct: rate ? rate.modelDivergencePct : null
      };
    });
  }
  return out;
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, env?: object}} ctx
 */
async function collect({ cluster, token, listFn = list, env }) {
  const { catalog, source: catalogSource, region, regionNote, asOf, asOfBasis } = loadCatalog(env || process.env);
  const baseCtx = { cluster, token };

  const [nodesResult, podsResult, usage] = await Promise.all([
    safeList(listFn, baseCtx, '/api/v1/nodes', 'nodes'),
    safeList(listFn, baseCtx, '/api/v1/pods?limit=2000', 'pods'),
    metrics.nodeUsage({ cluster, token, listFn })
  ]);

  const nodesOk = !nodesResult.unavailable;
  const podsOk = !podsResult.unavailable;

  const priced = nodesOk
    ? priceNodes(nodesResult.items, catalog)
    : { rows: [], unpricedNodes: 0, derivedRateNodes: 0, cpuCapacity: null, memGiBCapacity: null, hourlyUsd: null, monthlyUsd: null, monthlyEur: null, monthlyCu: null };

  // Allocatable is the utilization denominator — see the module note. Summed only over billable
  // nodes so the two halves of this payload describe the same set of machines.
  let cpuAllocatable = 0;
  let memGiBAllocatable = 0;
  let cpuUsage = 0;
  let memGiBUsage = 0;
  let usageNodesSeen = 0;
  if (nodesOk) {
    for (const node of nodesResult.items) {
      if (!isBillable(node)) continue;
      const alloc = (node.status && node.status.allocatable) || {};
      cpuAllocatable += parseCpu(alloc.cpu);
      memGiBAllocatable += (parseMemory(alloc.memory) || 0) / BYTES_PER_GIB;
      const u = usage.available && usage.nodes ? usage.nodes[node.metadata.name] : null;
      if (u) {
        cpuUsage += u.cpu;
        memGiBUsage += (u.memory || 0) / BYTES_PER_GIB;
        usageNodesSeen += 1;
      }
    }
  }

  const requests = podsOk ? requestsByNamespace(podsResult.items) : { byNamespace: new Map(), cpuTotal: 0, memGiBTotal: 0 };

  // Attribution rides on the pod list. Without it there is no attribution at all — an empty
  // namespace table is a defensible "nothing to show"; a table showing one namespace at 100%
  // because the read half-failed is not, and `unavailable: ['pods']` is what says which.
  const attribution = podsOk && nodesOk
    ? attribute(requests.byNamespace, requests, { cpuAllocatable, memGiBAllocatable }, priced.monthlyUsd)
    : {
        namespaces: [],
        // `null`, not `0`: nothing was weighed, so "no namespace failed to be weighed" is a claim
        // we cannot make. The UI says the count is not reported rather than drawing a clean sweep.
        unattributedNamespaces: null,
        unallocated: { sharePct: null, monthlyUsd: null }
      };

  // A usage percentage is only honest when metrics-server answered for the nodes we are
  // dividing by. A partial answer (some nodes missing) is reported as a partial count rather
  // than averaged into a cluster figure that silently omits machines.
  const usageComplete = usage.available && nodesOk && usageNodesSeen === priced.rows.length && usageNodesSeen > 0;

  const unavailable = unavailableLabels([nodesResult, podsResult]);
  const truncated = truncatedLabels([nodesResult, podsResult]);

  return {
    summary: {
      // 'ok' only when the node list — this collector's entire subject — was read. Money is
      // null rather than 0 in every other case.
      verdict: nodesOk ? 'ok' : 'unknown',
      hourlyUsd: priced.hourlyUsd,
      monthlyUsd: priced.monthlyUsd,
      monthlyEur: priced.monthlyEur,
      monthlyCu: priced.monthlyCu,
      /**
       * True when at least one node could not be priced, so every total above is a LOWER BOUND
       * — "at least $x", never "$x". Same vocabulary as `truncated`: the numbers are real, the
       * total is incomplete, and the two must not be confused with `unavailable`.
       */
      costIsFloor: priced.unpricedNodes > 0,
      unpricedNodes: priced.unpricedNodes,
      /**
       * True when at least one node was priced off the m5 family's per-unit rate instead of a
       * stated rate for its own machine type. The totals are then an APPROXIMATION whose error has
       * no known direction (the catalog's own families imply ±16%), which is a different statement
       * from `costIsFloor` and must not be folded into it.
       */
      costIsApproximate: priced.derivedRateNodes > 0,
      derivedRateNodes: priced.derivedRateNodes,
      /**
       * The single word the UI needs to qualify every dollar figure it prints, computed once here
       * so the tiles, the node rows, the namespace rows and the idle row cannot disagree:
       *
       *   exact             — every billable node had a stated rate
       *   floor             — some node had no rate at all; the real bill is higher      ('≥')
       *   approximate       — some node's rate was derived from its shape                ('≈')
       *   approximate-floor — both, so neither an exact figure nor a bound is claimable  ('≈')
       */
      costQualifier: priced.unpricedNodes > 0
        ? (priced.derivedRateNodes > 0 ? 'approximate-floor' : 'floor')
        : (priced.derivedRateNodes > 0 ? 'approximate' : 'exact'),
      nodeCount: priced.rows.length,
      cpuCapacity: priced.cpuCapacity,
      memGiBCapacity: priced.memGiBCapacity,
      cpuAllocatable: nodesOk ? round(cpuAllocatable, 2) : null,
      memGiBAllocatable: nodesOk ? round(memGiBAllocatable, 2) : null,
      requestedCpu: podsOk ? round(requests.cpuTotal, 3) : null,
      requestedMemGiB: podsOk ? round(requests.memGiBTotal, 2) : null,
      requestedCpuPct: podsOk && nodesOk ? pct(requests.cpuTotal, cpuAllocatable) : null,
      requestedMemPct: podsOk && nodesOk ? pct(requests.memGiBTotal, memGiBAllocatable) : null,
      // Live usage from metrics-server, null when it is absent or answered for only some nodes.
      cpuUtilizationPct: usageComplete ? pct(cpuUsage, cpuAllocatable) : null,
      memoryUtilizationPct: usageComplete ? pct(memGiBUsage, memGiBAllocatable) : null,
      usageSource: usage.available ? (usageComplete ? 'metrics-server' : 'metrics-server:partial') : null,
      hoursPerMonth: HOURS_PER_MONTH,
      /**
       * The second meter's own dollar figure, and how far it sits from the authoritative one.
       *
       * Both are published rather than reconciled: an operator shown €340 of Capacity Units beside
       * $368 of list price will multiply them and find a third number, so the gap is stated here
       * instead of being left for them to discover. `null` when there is no CU figure to compare.
       */
      cuRateEur: CU_RATE_EUR,
      cuRateUsd: CU_RATE_USD,
      /*
        The CU meter's own definition, published rather than restated in the UI: a normalized node
        unit and the CU it bills per hour. The tab prints the sentence "a 2 vCPU / 8 GiB node-hour at
        0.14 CU" from these three numbers, so changing the meter changes the explanation with it.
      */
      cuUnitCpu: NORMALIZED_UNIT.cpu,
      cuUnitMemGiB: NORMALIZED_UNIT.memoryGiB,
      cuHourlyPerUnit: NORMALIZED_UNIT.hourlyCu,
      monthlyUsdOnCuMeter: priced.monthlyCu === null ? null : round(priced.monthlyCu * CU_RATE_USD, 2),
      modelDivergencePct:
        priced.monthlyCu === null || !(priced.monthlyUsd > 0)
          ? null
          : round(((priced.monthlyCu * CU_RATE_USD - priced.monthlyUsd) / priced.monthlyUsd) * 100, 1),
      /**
       * Where the rate card came from, and the standing disclaimer. No number in this payload
       * is read from a bill — the UI must label the whole tab an estimate.
       */
      rateCard: catalogSource,
      /**
       * The rest of the rate card's provenance, because "built-in" alone does not let an operator
       * judge a price. `rateCardRegion` is **null** for the built-in list, which genuinely has no
       * region dimension — `rateCardRegionNote` carries that sentence rather than leaving the UI to
       * invent a region. `rateCardAsOf` is the date the rates were last edited here, and
       * `rateCardAsOfBasis` says that is what it means, so it is never read as a market quote.
       */
      rateCardRegion: region,
      rateCardRegionNote: regionNote,
      rateCardAsOf: asOf,
      rateCardAsOfBasis: asOfBasis,
      /** Namespaces whose request share could not be computed — see `attribute`. */
      unattributedNamespaces: attribution.unattributedNamespaces,
      estimate: true,
      unavailable,
      truncated
    },
    nodes: priced.rows,
    attribution: attribution.namespaces,
    unallocated: attribution.unallocated,
    hyperscalerCatalog: catalogForSimulator(catalog)
  };
}

export default {
  collect,
  billableShape,
  isBillable,
  priceNodes,
  requestsByNamespace,
  attribute,
  catalogForSimulator,
  DEFAULT_CATALOG
};
