/**
 * Cluster health: nodes, version, pod phases, and capacity.
 *
 * Every call here is a read. The fleet-reader ClusterRole grants get/list/watch and
 * nothing else, so this collector is structurally incapable of changing a cluster.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import metrics from './metrics.js';
import safeListModule from './safe-list.js';
const { requiredList, unavailableLabels, truncatedLabels, isTruncated } = safeListModule;

/**
 * Kubernetes quantities are not numbers. CPU arrives as "8" or "7900m"; memory as
 * "32612204Ki" or "16Gi". Parsing them is unavoidable and easy to get subtly wrong, so
 * it lives in one place with tests rather than being inlined per call site — and that one
 * place is now `quantity.js`, shared with `metrics.js`. Re-exported here because callers
 * and tests already import them from this module.
 */
import quantityModule from './quantity.js';
const { parseCpu, parseMemory } = quantityModule;

/** A node is Ready when its Ready condition is "True". */
function isNodeReady(node) {
  const conds = (node.status && node.status.conditions) || [];
  const ready = conds.find(c => c.type === 'Ready');
  return !!ready && ready.status === 'True';
}

function nodeRole(node) {
  const labels = (node.metadata && node.metadata.labels) || {};
  for (const key of Object.keys(labels)) {
    const m = key.match(/^node-role\.kubernetes\.io\/(.+)$/);
    if (m) return m[1] || 'worker';
  }
  return labels['kubernetes.io/role'] || 'worker';
}

function extractNodeGroup(labels = {}) {
  return (
    labels['worker.gardener.cloud/pool'] ||
    labels['cloud.google.com/gke-nodepool'] ||
    labels['eks.amazonaws.com/nodegroup'] ||
    labels['alpha.eksctl.io/nodegroup-name'] ||
    labels['kubernetes.azure.com/agentpool'] ||
    labels['agentpool'] ||
    labels['karpenter.sh/nodepool'] ||
    labels['node.kubernetes.io/instance-type'] ||
    'default-pool'
  );
}

function aggregateNodeGroups(nodeRows) {
  const groups = {};
  for (const n of nodeRows) {
    const g = n.nodeGroup || 'default-pool';
    if (!groups[g]) {
      groups[g] = {
        name: g,
        totalNodes: 0,
        readyNodes: 0,
        instanceTypes: new Set(),
        zones: new Set(),
        pods: 0,
        podCapacity: 0,
        podCapacityNodesReporting: 0,
        cpuAllocatable: 0,
        cpuRequested: 0,
        cpuUsage: 0,
        hasUsage: false,
        memoryAllocatable: 0,
        memoryRequested: 0,
        memoryUsage: 0
      };
    }
    const grp = groups[g];
    grp.totalNodes += 1;
    if (n.ready) grp.readyNodes += 1;
    if (n.instanceType) grp.instanceTypes.add(n.instanceType);
    if (n.zone) grp.zones.add(n.zone);
    grp.pods += n.pods || 0;
    // A node that reported no pod ceiling contributes nothing and is NOT counted as a zero:
    // `|| 0` here would publish one node's 110 as the whole pool's ceiling and then divide
    // the pool's pods by it, yielding percentages above 100. Same rule as topology.js.
    if (n.podCapacity !== null && n.podCapacity !== undefined) {
      grp.podCapacity += n.podCapacity;
      grp.podCapacityNodesReporting += 1;
    }
    const cpuAlloc = n.cpuAllocatable || n.cpuCapacity || 0;
    const memAlloc = n.memoryAllocatable || n.memoryCapacity || 0;
    grp.cpuAllocatable += cpuAlloc;
    grp.cpuRequested += n.cpuRequested || 0;
    if (n.cpuUsage !== null && n.cpuUsage !== undefined) {
      grp.cpuUsage += n.cpuUsage;
      grp.hasUsage = true;
    }
    grp.memoryAllocatable += memAlloc;
    grp.memoryRequested += n.memoryRequested || 0;
    if (n.memoryUsage !== null && n.memoryUsage !== undefined) {
      grp.memoryUsage += n.memoryUsage;
    }
  }

  return Object.values(groups).map(g => ({
    name: g.name,
    totalNodes: g.totalNodes,
    readyNodes: g.readyNodes,
    instanceTypes: [...g.instanceTypes],
    zones: [...g.zones].sort(),
    pods: g.pods,
    // null, not 0, when no node in the pool reported a ceiling; and the percentage is only
    // published when EVERY node reported one, because a sum over part of the pool is a
    // partial denominator and the ratio over it is wrong, not approximate.
    podCapacity: g.podCapacityNodesReporting > 0 ? g.podCapacity : null,
    podCapacityNodesReporting: g.podCapacityNodesReporting,
    podUsagePercent:
      g.podCapacityNodesReporting === g.totalNodes ? pct(g.pods, g.podCapacity) : null,
    cpuAllocatable: Math.round(g.cpuAllocatable * 100) / 100,
    cpuRequested: Math.round(g.cpuRequested * 100) / 100,
    cpuUsage: g.hasUsage ? Math.round(g.cpuUsage * 100) / 100 : null,
    cpuRequestedPercent: pct(g.cpuRequested, g.cpuAllocatable),
    cpuUsagePercent: g.hasUsage ? pct(g.cpuUsage, g.cpuAllocatable) : null,
    memoryAllocatable: g.memoryAllocatable,
    memoryRequested: g.memoryRequested,
    memoryUsage: g.hasUsage ? g.memoryUsage : null,
    memoryRequestedPercent: pct(g.memoryRequested, g.memoryAllocatable),
    memoryUsagePercent: g.hasUsage ? pct(g.memoryUsage, g.memoryAllocatable) : null
  }));
}

/**
 * Every condition other than Ready is a *problem* condition when it drifts from its healthy
 * value — MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable are healthy when
 * False, so True is the problem. A handful of kubelet-reported condition types invert that:
 * SystemdUnitsReady (and Ready itself, handled separately) are healthy when True, so False
 * — or 'Unknown', which is not the healthy value either way — is the problem. Getting this
 * backwards for SystemdUnitsReady means every healthy node on a systemd-managed kubelet
 * reports a permanent, false problem.
 */
const HEALTHY_WHEN_TRUE = new Set(['Ready', 'SystemdUnitsReady']);

/**
 * THE node-problem predicate. One function, two call sites: `nodeProblems` below and
 * `capacity.js`'s `nodesWithProblems`.
 *
 * There used to be two predicates that disagreed on one condition type — this one excluded
 * `Ready`, capacity.js's included it — so the same cluster reported two different
 * "nodes with problems" counts in two sub-tabs of one tab, and the conditions sub-tab's empty
 * state ("No node is reporting NotReady, MemoryPressure, DiskPressure or PIDPressure") printed
 * its all-clear beside a red NotReady pill on the row above.
 *
 * The one kept is the INCLUSIVE one: a node whose Ready condition is False or Unknown is the
 * single most important problem a node can report, and the empty-state sentence the UI already
 * ships names NotReady first. `Ready` is rendered separately as the row's own pill as well; a
 * condition appearing in both places is duplication, whereas dropping it was a contradiction.
 */
function isProblemCondition(cond) {
  const healthyValue = HEALTHY_WHEN_TRUE.has(cond.type) ? 'True' : 'False';
  // 'Unknown' is never a healthy value for any condition type — a node whose kubelet has
  // stopped reporting is not "probably fine", it is exactly the case this exists to surface.
  return cond.status !== healthyValue;
}

function nodeProblems(node) {
  const conds = (node.status && node.status.conditions) || [];
  return conds
    .filter(isProblemCondition)
    .map(c => ({ type: c.type, reason: c.reason || null, message: c.message || null }));
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list}} ctx
 * @returns {Promise<object>} the health summary for one cluster
 */
async function collect({ cluster, token, listFn = list }) {
  // Three reads, run together. Pods across all namespaces is the expensive one; on a
  // large cluster it dominates, so there is no point serialising them. Node metrics are
  // optional and never fail the collection — see collectors/metrics.js.
  //
  // The node read is deliberately left outside the degradation helper and still fails loudly:
  // every count on this collector — versions, capacity totals, node groups — is derived from
  // it, so a refused node read has no partial answer to report and must reach the operator as
  // a page-level error, not as a cluster with zero nodes. Its paging-ceiling flag is therefore
  // picked up by hand (`isTruncated`), the same way topology.js does it.
  //
  // The pod read goes through `requiredList`: it is the one read here that CAN fail on its own
  // while the rest of the answer stands (pod RBAC is narrower than node RBAC on more than one
  // cluster), and it is capped at `?limit=2000`, so a cluster past that ceiling returns a real
  // but short list. Both facts have to leave this collector, because a count from a truncated
  // list is a floor and a count from a refused read is not a number at all.
  const [nodes, podsResult, usage] = await Promise.all([
    listFn({ cluster, token, path: '/api/v1/nodes' }),
    requiredList('pods', () => listFn({ cluster, token, path: '/api/v1/pods?limit=2000' })),
    metrics.nodeUsage({ cluster, token, listFn })
  ]);
  const pods = podsResult.items;
  // Not a safeList result — it carries no `items`, only the one field `truncatedLabels` reads.
  const nodesTruncation = { label: 'nodes', truncated: isTruncated(nodes) };

  // Aggregate pods and requested resources per node and across the cluster
  const podsOnNode = {};
  const podsListByNode = {};
  const requestedByNode = {};
  const requested = { cpu: 0, memory: 0 };
  const phases = {};
  let restarts = 0;

  for (const pod of pods) {
    const phase = (pod.status && pod.status.phase) || 'Unknown';
    phases[phase] = (phases[phase] || 0) + 1;
    const nodeName = pod.spec && pod.spec.nodeName;

    let podCpuReq = 0;
    let podMemReq = 0;

    // Succeeded and Failed pods hold no resources; counting them would inflate
    // utilisation with the ghosts of every completed Job on the cluster.
    if (phase === 'Running' || phase === 'Pending') {
      for (const c of (pod.spec && pod.spec.containers) || []) {
        const req = (c.resources && c.resources.requests) || {};
        const cCpu = parseCpu(req.cpu);
        // A quantity that failed to parse contributes nothing to a sum rather than NaN-ing
        // the running total for the rest of the cluster — parseMemory's null means "unknown
        // for this one value", not "the aggregate is now unknown".
        const cMem = parseMemory(req.memory) ?? 0;
        podCpuReq += cCpu;
        podMemReq += cMem;
        requested.cpu += cCpu;
        requested.memory += cMem;
      }
    }

    let podRestarts = 0;
    for (const cs of (pod.status && pod.status.containerStatuses) || []) {
      const r = cs.restartCount || 0;
      restarts += r;
      podRestarts += r;
    }

    // Per-node accounting covers non-terminated pods only, which is the same population
    // `kubectl describe node` counts under "Non-terminated Pods". A Succeeded or Failed pod
    // still carries `spec.nodeName` for as long as its record is retained, but it holds no
    // scheduler slot — counting it made a node with CronJob history read 27/20 pods, 135%,
    // and "-7 free", and put completed Jobs in the node's own pod list. Cluster-wide phase
    // counts (`pods.byPhase`) still report every pod; this is the per-node slot view.
    const terminal = phase === 'Succeeded' || phase === 'Failed';

    if (nodeName && !terminal) {
      podsOnNode[nodeName] = (podsOnNode[nodeName] || 0) + 1;
      if (!requestedByNode[nodeName]) {
        requestedByNode[nodeName] = { cpu: 0, memory: 0 };
      }
      requestedByNode[nodeName].cpu += podCpuReq;
      requestedByNode[nodeName].memory += podMemReq;

      if (!podsListByNode[nodeName]) {
        podsListByNode[nodeName] = [];
      }
      podsListByNode[nodeName].push({
        name: (pod.metadata && pod.metadata.name) || 'unknown',
        namespace: (pod.metadata && pod.metadata.namespace) || 'default',
        phase,
        restarts: podRestarts,
        cpuRequested: podCpuReq,
        memoryRequested: podMemReq
      });
    }
  }

  const nodeRows = nodes.map(n => {
    const labels = (n.metadata && n.metadata.labels) || {};
    const capacity = (n.status && n.status.capacity) || {};
    const allocatable = (n.status && n.status.allocatable) || {};
    const info = (n.status && n.status.nodeInfo) || {};
    const live = usage.nodes[n.metadata.name] || null;
    const cpuCapacity = parseCpu(capacity.cpu);
    const memoryCapacity = parseMemory(capacity.memory) ?? 0;
    const cpuAllocatable = parseCpu(allocatable.cpu) || cpuCapacity;
    const memoryAllocatable = (parseMemory(allocatable.memory) ?? 0) || memoryCapacity;

    const nodeName = n.metadata.name;
    const nodeReq = requestedByNode[nodeName] || { cpu: 0, memory: 0 };
    const podCount = podsOnNode[nodeName] || 0;
    // Allocatable pods, falling back to capacity — the bar this feeds is labelled
    // "schedulable", and `allocatable.pods` is the number the kubelet will actually admit.
    // The two are equal on essentially every real node, but taking capacity while claiming
    // allocatable is the same mislabel the CPU/memory totals were just corrected for.
    const podCap = parseInt(allocatable.pods, 10) || parseInt(capacity.pods, 10) || null;
    const pool = extractNodeGroup(labels);

    return {
      name: nodeName,
      ready: isNodeReady(n),
      role: nodeRole(n),
      nodeGroup: pool,
      version: info.kubeletVersion || null,
      cpuCapacity,
      memoryCapacity,

      // Allocatable is capacity minus what the kubelet and system daemons reserve. It is
      // the number the scheduler actually uses, and it is always the smaller one — showing
      // capacity alone overstates how much room is left.
      cpuAllocatable,
      memoryAllocatable,

      pods: podCount,
      podCapacity: podCap,
      podUsagePercent: pct(podCount, podCap),

      // Resource Requests on this node
      cpuRequested: nodeReq.cpu,
      cpuRequestedPercent: pct(nodeReq.cpu, cpuAllocatable),
      memoryRequested: nodeReq.memory,
      memoryRequestedPercent: pct(nodeReq.memory, memoryAllocatable),

      // Live Usage (metrics-server)
      cpuUsage: live ? live.cpu : null,
      memoryUsage: live ? live.memory : null,
      cpuUsagePercent: live && cpuAllocatable ? pct(live.cpu, cpuAllocatable) : null,
      memoryUsagePercent: live && memoryAllocatable ? pct(live.memory, memoryAllocatable) : null,

      zone: labels['topology.kubernetes.io/zone'] || null,
      instanceType: labels['node.kubernetes.io/instance-type'] || null,
      os: info.osImage || null,
      kernelVersion: info.kernelVersion || null,
      containerRuntime: info.containerRuntimeVersion || null,
      createdAt: n.metadata.creationTimestamp || null,
      unschedulable: Boolean(n.spec && n.spec.unschedulable),
      taints: ((n.spec && n.spec.taints) || []).map(t => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`),
      problems: nodeProblems(n),
      podsList: podsListByNode[nodeName] || []
    };
  });

  // Two totals, deliberately both reported.
  //
  // `capacity` is the hardware. `allocatable` is capacity minus what the kubelet and the
  // system daemons reserve, and it is the number the scheduler actually divides up — so it is
  // the only honest denominator for "how full is this cluster". They differ by a few percent
  // per node (an m5.2xlarge shows 32 GiB capacity and ~30 GiB allocatable), which is small
  // enough to look like a rounding artefact and large enough to overstate real headroom.
  //
  // This used to sum capacity alone while the UI labelled the result "requested / allocatable",
  // so the cluster header claimed 93 GiB where every node row added up to 90 GiB. Reporting
  // both, and driving every percentage off allocatable, is what makes the two agree.
  const totals = nodeRows.reduce(
    (acc, n) => ({
      cpuCapacity: acc.cpuCapacity + n.cpuCapacity,
      memoryCapacity: acc.memoryCapacity + n.memoryCapacity,
      cpuAllocatable: acc.cpuAllocatable + n.cpuAllocatable,
      memoryAllocatable: acc.memoryAllocatable + n.memoryAllocatable
    }),
    { cpuCapacity: 0, memoryCapacity: 0, cpuAllocatable: 0, memoryAllocatable: 0 }
  );

  const versions = [...new Set(nodeRows.map(n => n.version).filter(Boolean))];
  const liveCpu = usage.available ? nodeRows.reduce((n, r) => n + (r.cpuUsage || 0), 0) : null;
  const liveMemory = usage.available ? nodeRows.reduce((n, r) => n + (r.memoryUsage || 0), 0) : null;

  return {
    nodes: {
      total: nodeRows.length,
      ready: nodeRows.filter(n => n.ready).length,
      unschedulable: nodeRows.filter(n => n.unschedulable).length,
      withProblems: nodeRows.filter(n => n.problems.length > 0).length,
      zones: [...new Set(nodeRows.map(n => n.zone).filter(Boolean))].sort(),
      nodeGroups: aggregateNodeGroups(nodeRows),
      items: nodeRows
    },
    // A fleet-wide rolling upgrade shows up here as more than one version. Reporting the
    // list rather than just the first means a half-upgraded cluster is visible.
    kubernetesVersion: versions[0] || null,
    kubernetesVersions: versions,
    pods: {
      total: pods.length,
      running: phases.Running || 0,
      pending: phases.Pending || 0,
      failed: phases.Failed || 0,
      succeeded: phases.Succeeded || 0,
      restarts,
      byPhase: phases
    },
    capacity: {
      cpu: {
        capacity: totals.cpuCapacity,
        allocatable: totals.cpuAllocatable,
        requested: requested.cpu,
        percent: pct(requested.cpu, totals.cpuAllocatable),
        // Live usage next to requests is the whole point: a cluster requesting 90% and
        // using 12% is over-provisioned, not busy, and the two numbers look identical
        // until you put them side by side.
        used: liveCpu,
        usedPercent: liveCpu === null ? null : pct(liveCpu, totals.cpuAllocatable)
      },
      memory: {
        capacity: totals.memoryCapacity,
        allocatable: totals.memoryAllocatable,
        requested: requested.memory,
        percent: pct(requested.memory, totals.memoryAllocatable),
        used: liveMemory,
        usedPercent: liveMemory === null ? null : pct(liveMemory, totals.memoryAllocatable)
      }
    },
    metrics: { available: usage.available, reason: usage.reason || null },
    /**
     * The completeness contract, at the root of the payload because that is where the page
     * reads it from (`unavailableEntries(d.health)`), and in the same two-key vocabulary every
     * sibling collector uses.
     *
     *   unavailable  the read did not happen. `pods.total`, every per-node pod count and the
     *                requested-resource totals are not numbers, they are em-dashes.
     *   truncated    the read happened and the rows are real, but it stopped at the client's
     *                paging ceiling (`?limit=2000` for pods), so every count derived from it
     *                is a FLOOR. A count from a truncated list is not a count.
     *
     * Relayed, never derived: this collector reports what safe-list told it and adds no
     * verdict of its own.
     */
    unavailable: unavailableLabels([podsResult]),
    truncated: truncatedLabels([nodesTruncation, podsResult])
  };
}

function pct(used, total) {
  if (!total) return null;
  return Math.round((used / total) * 1000) / 10;
}

export default {
  collect,
  parseCpu,
  parseMemory,
  isNodeReady,
  nodeRole,
  nodeProblems,
  isProblemCondition,
  HEALTHY_WHEN_TRUE,
  extractNodeGroup,
  aggregateNodeGroups
};
