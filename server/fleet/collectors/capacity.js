/**
 * Capacity: limit overcommit / burst exposure, unbounded-container inventory, QoS mix,
 * metrics-server availability, and pending-pod detection.
 *
 * Everything here reads nodes, pods and metrics.k8s.io — resources the fleet-reader
 * ClusterRole already grants get/list/watch on. No new RBAC is required by this file.
 *
 * D1 is deliberately NOT an eviction-risk score. That framing was rejected: summing
 * container limits is monotone in sidecar count (every mesh-injected pod gets a bigger
 * number) and says nothing about whether a pod is actually likely to be evicted. What it
 * *does* say honestly is how much burst a namespace or node could draw if every container
 * were to actually use its ceiling — "overcommit", not "risk". Ranking nodes/namespaces
 * therefore uses a different, ENFORCEABLE triple: requests vs allocatable, pod-slot count
 * vs allocatable slots, and live usage from metrics.k8s.io. That triple's identity does not
 * change depending on whether metrics-server happens to answer at read time, which a score
 * built on top of usage would.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList } = safeListModule;
import metrics from './metrics.js';
import healthModule from './health.js';
const { parseCpu, parseMemory, isProblemCondition } = healthModule;

/**
 * The effective container set for sidecar-aware limit summing (D1/D2):
 *
 *   spec.containers  UNION  spec.initContainers WHERE restartPolicy === 'Always'
 *
 * Native sidecars (KEP-753, GA in 1.29) declare `restartPolicy: Always` on an init
 * container entry and then run for the pod's whole lifetime, concurrently with
 * spec.containers — so they belong in a straight sum. Ordinary init containers run
 * sequentially, one at a time, and never concurrently with anything else, so their
 * contribution to a *concurrent* limit ceiling is `max()` over them, not a sum — summing
 * would overstate the pod's actual burst ceiling by however many init containers it has.
 */
function effectiveContainers(pod) {
  const spec = pod.spec || {};
  const containers = spec.containers || [];
  const initContainers = spec.initContainers || [];
  const nativeSidecars = initContainers.filter(c => c.restartPolicy === 'Always');
  const ordinaryInit = initContainers.filter(c => c.restartPolicy !== 'Always');
  return { containers, nativeSidecars, ordinaryInit };
}

/** cpu/memory request+limit sums for one container, in cores / bytes. */
function containerResources(c) {
  const req = (c.resources && c.resources.requests) || {};
  const lim = (c.resources && c.resources.limits) || {};
  return {
    cpuRequest: parseCpu(req.cpu),
    cpuLimit: lim.cpu !== undefined ? parseCpu(lim.cpu) : null,
    memoryRequest: parseMemory(req.memory) ?? 0,
    memoryLimit: lim.memory !== undefined ? (parseMemory(lim.memory) ?? null) : null,
    hasCpuLimit: lim.cpu !== undefined,
    hasMemoryLimit: lim.memory !== undefined
  };
}

/**
 * Pod-level rollup for D1 (limit sums, sidecar-aware) and D2 (unbounded inventory).
 *
 * The ordinary-init-container max() only ever affects the *limit* ceiling used for burst
 * exposure — requests are always summed straight (the scheduler reserves the max of
 * concurrent + sequential phases too, but this collector's request figure is used only in
 * the D1 ranking triple against allocatable, where the existing workloads.js convention of
 * summing spec.containers requests already governs; ordinary init containers rarely carry
 * meaningful requests and are excluded from that sum here to match that convention).
 */
function podCapacityRollup(pod) {
  const { containers, nativeSidecars, ordinaryInit } = effectiveContainers(pod);
  const sidecarLimitContainers = nativeSidecars;
  const mainAndSidecars = [...containers, ...sidecarLimitContainers];

  let cpuLimitSum = 0;
  let memoryLimitSum = 0;
  let cpuRequestSum = 0;
  let memoryRequestSum = 0;
  let sidecarCpuLimit = 0;
  let sidecarMemoryLimit = 0;
  let anyLimitUnbounded = false; // true when a limit had to be treated as 0 (no ceiling) for the sum
  let unboundedCpuCount = 0;
  let unboundedMemoryCount = 0;
  let unboundedBothCount = 0;
  let totalEffectiveContainers = 0;

  for (const c of mainAndSidecars) {
    const r = containerResources(c);
    cpuRequestSum += r.cpuRequest;
    memoryRequestSum += r.memoryRequest;
    cpuLimitSum += r.cpuLimit ?? 0;
    memoryLimitSum += r.memoryLimit ?? 0;
    if (r.cpuLimit === null || r.memoryLimit === null) anyLimitUnbounded = true;
    totalEffectiveContainers += 1;
    const noCpu = r.cpuLimit === null;
    const noMem = r.memoryLimit === null;
    if (noCpu) unboundedCpuCount += 1;
    if (noMem) unboundedMemoryCount += 1;
    if (noCpu && noMem) unboundedBothCount += 1;
    if (nativeSidecars.includes(c)) {
      sidecarCpuLimit += r.cpuLimit ?? 0;
      sidecarMemoryLimit += r.memoryLimit ?? 0;
    }
  }

  // Ordinary init containers run sequentially and never concurrently with anything else,
  // so their contribution to the pod's *concurrent* ceiling is the single largest one
  // among them, not their sum. They still count toward D2's unbounded inventory: an init
  // container with no memory limit is a real gap even though it never adds to the burst
  // ceiling.
  let initMaxCpuLimit = 0;
  let initMaxMemoryLimit = 0;
  for (const c of ordinaryInit) {
    const r = containerResources(c);
    initMaxCpuLimit = Math.max(initMaxCpuLimit, r.cpuLimit ?? 0);
    initMaxMemoryLimit = Math.max(initMaxMemoryLimit, r.memoryLimit ?? 0);
    if (r.cpuLimit === null || r.memoryLimit === null) anyLimitUnbounded = true;
    totalEffectiveContainers += 1;
    const noCpu = r.cpuLimit === null;
    const noMem = r.memoryLimit === null;
    if (noCpu) unboundedCpuCount += 1;
    if (noMem) unboundedMemoryCount += 1;
    if (noCpu && noMem) unboundedBothCount += 1;
  }

  const totalCpuLimit = cpuLimitSum + initMaxCpuLimit;
  const totalMemoryLimit = memoryLimitSum + initMaxMemoryLimit;

  return {
    cpuRequestSum,
    memoryRequestSum,
    totalCpuLimit,
    totalMemoryLimit,
    sidecarCpuLimit,
    sidecarMemoryLimit,
    sidecarCpuLimitShare: totalCpuLimit > 0 ? sidecarCpuLimit / totalCpuLimit : 0,
    sidecarMemoryLimitShare: totalMemoryLimit > 0 ? sidecarMemoryLimit / totalMemoryLimit : 0,
    limitSumIsFloor: anyLimitUnbounded,
    totalEffectiveContainers,
    unboundedCpuCount,
    unboundedMemoryCount,
    unboundedBothCount
  };
}

/** PodScheduled condition with status false + reason Unschedulable == a pending pod stuck on scheduling. */
function isUnschedulable(pod) {
  const conds = (pod.status && pod.status.conditions) || [];
  const scheduled = conds.find(c => c.type === 'PodScheduled');
  return Boolean(scheduled && scheduled.status === 'False' && scheduled.reason === 'Unschedulable');
}

function pct(used, total) {
  if (!total) return null;
  return Math.round((used / total) * 1000) / 10;
}

/**
 * D4: metrics-server four-state detection, extending metrics.js's own three states
 * (available / not-installed / forbidden) with a fourth: installed-but-backend-down.
 *
 * metrics.js's `reasonFor` already collapses a 503 into the generic "installed but not
 * answering yet" sentence and metrics.nodeUsage/podUsage report only `{available, reason}`
 * — a boolean, not the three-vs-four-state distinction this collector needs to surface
 * (an operator seeing "not installed" when it is actually "installed, backend down" reaches
 * for the wrong runbook). So this collector re-probes independently rather than trusting
 * metrics.js's collapsed reason string, using the same nodes-usage path metrics.js itself
 * calls, but reading the raw error status here where the 503-vs-404 distinction survives.
 */
async function metricsServerState({ cluster, token, listFn }) {
  try {
    await listFn({ cluster, token, path: '/apis/metrics.k8s.io/v1beta1/nodes' });
    return { installed: true, reporting: true, reason: null };
  } catch (err) {
    const status = err && err.status;
    if (status === 503) {
      return { installed: true, reporting: false, reason: 'BACKEND_DOWN' };
    }
    if (status === 404) {
      return { installed: false, reporting: false, reason: 'NOT_INSTALLED' };
    }
    if (status === 403 || status === 401) {
      return { installed: null, reporting: false, reason: 'FORBIDDEN' };
    }
    return { installed: null, reporting: false, reason: 'UPSTREAM' };
  }
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, callFn?: Function}} ctx
 */
async function collect({ cluster, token, listFn = list }) {
  const [nodesResult, podsResult, usage, metricsState] = await Promise.all([
    safeList(listFn, { cluster, token }, '/api/v1/nodes', 'nodes'),
    safeList(listFn, { cluster, token }, '/api/v1/pods?limit=2000', 'pods'),
    metrics.nodeUsage({ cluster, token, listFn }),
    metricsServerState({ cluster, token, listFn })
  ]);

  const nodes = nodesResult.items;
  const pods = podsResult.items;

  const nodeByName = {};
  for (const n of nodes) {
    const allocatable = (n.status && n.status.allocatable) || {};
    const capacity = (n.status && n.status.capacity) || {};
    nodeByName[n.metadata.name] = {
      name: n.metadata.name,
      cpuAllocatable: parseCpu(allocatable.cpu),
      memoryAllocatable: parseMemory(allocatable.memory) ?? 0,
      // Same ceiling as health.js's `podCap`: allocatable pods, falling back to capacity,
      // null when the node reported neither. Reading allocatable only — as this line used to —
      // gave the same node a pod ceiling on `nodes/slots` and `null` on `nodes/headroom`,
      // two sub-tabs of one tab disagreeing about a number the node states once.
      podSlotsCapacity: parseInt(allocatable.pods, 10) || parseInt(capacity.pods, 10) || null,
      cpuRequested: 0,
      memoryRequested: 0,
      podSlotsUsed: 0,
      cpuUsage: usage.available ? (usage.nodes[n.metadata.name] ? usage.nodes[n.metadata.name].cpu : null) : null,
      memoryUsage: usage.available ? (usage.nodes[n.metadata.name] ? usage.nodes[n.metadata.name].memory : null) : null
    };
  }

  const namespaceRollup = {};
  function nsBucket(ns) {
    if (!namespaceRollup[ns]) {
      namespaceRollup[ns] = {
        namespace: ns,
        cpuRequested: 0,
        memoryRequested: 0,
        podSlotsUsed: 0,
        totalCpuLimit: 0,
        totalMemoryLimit: 0,
        sidecarCpuLimit: 0,
        sidecarMemoryLimit: 0
      };
    }
    return namespaceRollup[ns];
  }

  let totalEffectiveContainers = 0;
  let unboundedCpuCount = 0;
  let unboundedMemoryCount = 0;
  let unboundedBothCount = 0;
  let anyLimitSumIsFloor = false;
  let totalCpuLimitSum = 0;
  let totalMemoryLimitSum = 0;
  let totalSidecarCpuLimit = 0;
  let totalSidecarMemoryLimit = 0;

  const qosCounts = {};
  const pendingPods = [];

  // pods degrades via safeList above: on failure `pods` is simply `[]` and every derived
  // field below is the honest empty/zero that produces, never a throw — D4's metrics-server
  // verdict and the node panel above have nothing to do with whether this list succeeded,
  // and must not be discarded because it failed.
  for (const pod of pods) {
    const namespace = (pod.metadata && pod.metadata.namespace) || 'default';
    const nodeName = pod.spec && pod.spec.nodeName;
    const phase = (pod.status && pod.status.phase) || 'Unknown';

    const qos = (pod.status && pod.status.qosClass) || 'Unknown';
    qosCounts[qos] = (qosCounts[qos] || 0) + 1;

    if (isUnschedulable(pod)) {
      pendingPods.push({
        name: pod.metadata.name,
        namespace,
        reason: 'Unschedulable',
        message: (() => {
          const conds = (pod.status && pod.status.conditions) || [];
          const c = conds.find(cc => cc.type === 'PodScheduled');
          return (c && c.message) || null;
        })(),
        since: pod.status && pod.status.startTime || null
      });
    }

    const roll = podCapacityRollup(pod);
    totalEffectiveContainers += roll.totalEffectiveContainers;
    unboundedCpuCount += roll.unboundedCpuCount;
    unboundedMemoryCount += roll.unboundedMemoryCount;
    unboundedBothCount += roll.unboundedBothCount;
    if (roll.limitSumIsFloor) anyLimitSumIsFloor = true;
    totalCpuLimitSum += roll.totalCpuLimit;
    totalMemoryLimitSum += roll.totalMemoryLimit;
    totalSidecarCpuLimit += roll.sidecarCpuLimit;
    totalSidecarMemoryLimit += roll.sidecarMemoryLimit;

    // Succeeded/Failed pods hold no live resources and would inflate overcommit figures
    // with completed Jobs — same convention health.js uses for its request sum.
    const countsTowardCapacity = phase === 'Running' || phase === 'Pending';

    const ns = nsBucket(namespace);
    ns.totalCpuLimit += roll.totalCpuLimit;
    ns.totalMemoryLimit += roll.totalMemoryLimit;
    ns.sidecarCpuLimit += roll.sidecarCpuLimit;
    ns.sidecarMemoryLimit += roll.sidecarMemoryLimit;
    if (countsTowardCapacity) {
      ns.cpuRequested += roll.cpuRequestSum;
      ns.memoryRequested += roll.memoryRequestSum;
      ns.podSlotsUsed += 1;
    }

    if (nodeName && nodeByName[nodeName] && countsTowardCapacity) {
      nodeByName[nodeName].cpuRequested += roll.cpuRequestSum;
      nodeByName[nodeName].memoryRequested += roll.memoryRequestSum;
      nodeByName[nodeName].podSlotsUsed += 1;
    }
  }

  const nodeRanking = Object.values(nodeByName).map(n => ({
    name: n.name,
    cpuRequestedPercent: pct(n.cpuRequested, n.cpuAllocatable),
    memoryRequestedPercent: pct(n.memoryRequested, n.memoryAllocatable),
    podSlotsPercent: pct(n.podSlotsUsed, n.podSlotsCapacity),
    cpuUsagePercent: n.cpuUsage !== null ? pct(n.cpuUsage, n.cpuAllocatable) : null,
    memoryUsagePercent: n.memoryUsage !== null ? pct(n.memoryUsage, n.memoryAllocatable) : null,
    cpuRequested: n.cpuRequested,
    memoryRequested: n.memoryRequested,
    podSlotsUsed: n.podSlotsUsed,
    podSlotsCapacity: n.podSlotsCapacity
  })).sort((a, b) => (b.cpuRequestedPercent || 0) - (a.cpuRequestedPercent || 0));

  const namespaceRanking = Object.values(namespaceRollup).map(ns => ({
    namespace: ns.namespace,
    cpuRequested: ns.cpuRequested,
    memoryRequested: ns.memoryRequested,
    podSlotsUsed: ns.podSlotsUsed,
    totalCpuLimit: ns.totalCpuLimit,
    totalMemoryLimit: ns.totalMemoryLimit,
    sidecarCpuLimit: ns.sidecarCpuLimit,
    sidecarMemoryLimit: ns.sidecarMemoryLimit,
    sidecarCpuLimitShare: ns.totalCpuLimit > 0 ? Math.round((ns.sidecarCpuLimit / ns.totalCpuLimit) * 1000) / 1000 : 0,
    sidecarMemoryLimitShare: ns.totalMemoryLimit > 0 ? Math.round((ns.sidecarMemoryLimit / ns.totalMemoryLimit) * 1000) / 1000 : 0
  })).sort((a, b) => b.cpuRequested - a.cpuRequested);

  const nodeProblemCounts = nodes.reduce((n, node) => {
    const conds = (node.status && node.status.conditions) || [];
    return n + (conds.some(isProblemCondition) ? 1 : 0);
  }, 0);

  return {
    overcommit: {
      nodes: nodeRanking,
      namespaces: namespaceRanking,
      sidecarCpuLimitShare: totalCpuLimitSum > 0 ? Math.round((totalSidecarCpuLimit / totalCpuLimitSum) * 1000) / 1000 : 0,
      sidecarMemoryLimitShare: totalMemoryLimitSum > 0 ? Math.round((totalSidecarMemoryLimit / totalMemoryLimitSum) * 1000) / 1000 : 0,
      totalCpuLimit: totalCpuLimitSum,
      totalMemoryLimit: totalMemoryLimitSum,
      limitSumIsFloor: anyLimitSumIsFloor
    },
    unboundedContainers: {
      totalEffectiveContainers,
      noCpuLimit: unboundedCpuCount,
      noMemoryLimit: unboundedMemoryCount,
      noEitherLimit: unboundedBothCount,
      limitSumIsFloor: anyLimitSumIsFloor
    },
    qos: {
      counts: qosCounts,
      total: pods.length
    },
    metricsServer: metricsState,
    pending: {
      count: pendingPods.length,
      items: pendingPods
    },
    nodesWithProblems: nodeProblemCounts,
    summary: {
      // `installed: null` is the "we could not tell" verdict metricsServerState produces for a
      // 403/401 or any other non-404/503 failure, and it has to reach the completeness contract
      // or the tile renders a green pill over numbers whose usage half was never readable. A
      // clean 404 is deliberately excluded: that read succeeded and the answer is "not
      // installed", which is knowledge rather than a gap. This probe builds its own error path
      // instead of going through safeList, which is exactly why it has to say so by hand.
      unavailable: [
        ...[nodesResult, podsResult].filter(r => r.unavailable).map(r => r.label),
        ...(metricsState.installed === null ? ['metrics-server'] : [])
      ],
      truncated: [nodesResult, podsResult].filter(r => r.truncated).map(r => r.label)
    }
  };
}

export default {
  collect,
  effectiveContainers,
  podCapacityRollup,
  isUnschedulable,
  metricsServerState
};
