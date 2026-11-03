/**
 * Multi-Zone Topology & Node Distribution Collector.
 *
 * Discovers nodes, availability zones (AZs), node groups (worker pools),
 * instance types, container runtimes, pod placement, and CPU/Memory allocation.
 *
 * Two reads, two different contracts, because they are not equally central here — see the
 * comments in `collect`. Nodes fail loudly; pods degrade.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import healthModule from './health.js';
const { parseCpu, parseMemory, extractNodeGroup } = healthModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels, isTruncated } = safeListModule;
import taintsModule from './taints.js';
const { collectTaints } = taintsModule;
import fanoutModule from '../fanout.js';
const { publicCluster } = fanoutModule;

function pct(used, total) {
  if (!total) return null;
  return Math.round((used / total) * 1000) / 10;
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list}} ctx
 */
async function collect(ctx) {
  const listFn = ctx.listFn || list;

  const [nodesRaw, podsResult] = await Promise.all([
    // Nodes are this collector's entire subject, not one signal among several: the zone
    // map, the worker pools, the capacity, the readiness ratio and `isMultiZone` are all
    // derived from this single list. So the degrade path is not available to us here.
    // Reporting `totalNodes: 0, distinctZones: 0, isMultiZone: false` when the read was
    // refused publishes "this cluster is single-zone" as a resilience FINDING — an operator
    // reads that as something to go and fix, when the truth is that we never got to ask.
    // Annotating it afterwards does not undo it: the false numbers are still in the payload
    // for `/report`, for an export and for any consumer that does not know to look at
    // `unavailable` first.
    //
    // This read is therefore left outside safeList and still fails loudly, exactly as
    // security.js does with its pod audit and for the same stated reason: a cluster this
    // token cannot list nodes on is broken, not partially informative. fanOut turns the
    // throw into `ok: false` plus the original ClusterError — code, message and
    // needsReseed intact — and the page renders every tile as unavailable with the real
    // cause, which is strictly more than a zero with a footnote. A 404 is not special-cased
    // here either: `/api/v1/nodes` is core, always registered, and a Kubernetes API server
    // that does not serve it has earned a loud failure.
    listFn({ ...ctx, path: '/api/v1/nodes' }),
    // Pods are genuinely optional to this page. Without them the node inventory, the zones,
    // the pools, the capacity and the readiness ratio are all still true; only the
    // scheduling-density columns fall to zero, and `unavailable: ['pods']` says so.
    safeList(listFn, ctx, '/api/v1/pods', 'pods')
  ]);
  const podsRaw = podsResult.items;
  // The nodes read bypasses safeList, so its ceiling flag has to be picked up by hand. Not a
  // safeList result — it carries no `items`, only the one field `truncatedLabels` reads.
  const nodesTruncation = { label: 'nodes', truncated: isTruncated(nodesRaw) };

  // Aggregate pods and resource requests per node
  const podsOnNode = {};
  const podsListByNode = {};
  const requestedByNode = {};

  for (const p of podsRaw) {
    const nodeName = p.spec && p.spec.nodeName;
    if (!nodeName) continue;

    podsOnNode[nodeName] = (podsOnNode[nodeName] || 0) + 1;
    if (!requestedByNode[nodeName]) {
      requestedByNode[nodeName] = { cpu: 0, memory: 0 };
    }
    if (!podsListByNode[nodeName]) {
      podsListByNode[nodeName] = [];
    }

    const phase = (p.status && p.status.phase) || 'Unknown';
    let podCpuReq = 0;
    let podMemReq = 0;

    if (phase === 'Running' || phase === 'Pending') {
      for (const c of (p.spec && p.spec.containers) || []) {
        const req = (c.resources && c.resources.requests) || {};
        podCpuReq += parseCpu(req.cpu);
        podMemReq += parseMemory(req.memory);
      }
    }

    requestedByNode[nodeName].cpu += podCpuReq;
    requestedByNode[nodeName].memory += podMemReq;

    let restarts = 0;
    for (const cs of (p.status && p.status.containerStatuses) || []) {
      restarts += cs.restartCount || 0;
    }

    podsListByNode[nodeName].push({
      name: (p.metadata && p.metadata.name) || 'unknown',
      namespace: (p.metadata && p.metadata.namespace) || 'default',
      phase,
      restarts,
      cpuRequested: podCpuReq,
      memoryRequested: podMemReq
    });
  }

  const nodes = nodesRaw.map(n => {
    const meta = n.metadata || {};
    const status = n.status || {};
    const labels = meta.labels || {};
    const nodeInfo = status.nodeInfo || {};

    const readyCond = (status.conditions || []).find(c => c.type === 'Ready');
    const isReady = readyCond ? readyCond.status === 'True' : false;

    const zone = labels['topology.kubernetes.io/zone'] || labels['failure-domain.beta.kubernetes.io/zone'] || 'default-zone';
    const region = labels['topology.kubernetes.io/region'] || labels['failure-domain.beta.kubernetes.io/region'] || 'default-region';
    const instanceType = labels['node.kubernetes.io/instance-type'] || labels['beta.kubernetes.io/instance-type'] || 'standard';
    const nodeGroup = extractNodeGroup(labels);

    const cpuCap = parseCpu(status.capacity ? status.capacity.cpu : '0');
    const memCap = parseMemory(status.capacity ? status.capacity.memory : '0');
    const cpuAlloc = parseCpu(status.allocatable ? status.allocatable.cpu : (status.capacity ? status.capacity.cpu : '0'));
    const memAlloc = parseMemory(status.allocatable ? status.allocatable.memory : (status.capacity ? status.capacity.memory : '0'));
    /**
     * The node's pod ceiling, or null when it reported none.
     *
     * This used to read `parseInt(status.capacity ? status.capacity.pods : '110', 10) || 110`,
     * which printed Kubernetes' *default* kubelet setting as if the node had measured it. Same
     * rule as health.js now: allocatable pods, falling back to capacity, else null — the UI
     * prints "no pod capacity reported" rather than a number nobody read.
     */
    const podCap = parseInt(status.allocatable ? status.allocatable.pods : undefined, 10)
      || parseInt(status.capacity ? status.capacity.pods : undefined, 10)
      || null;
    const podCount = podsOnNode[meta.name] || 0;
    const nodeReq = requestedByNode[meta.name] || { cpu: 0, memory: 0 };

    return {
      name: meta.name,
      nodeGroup,
      zone,
      region,
      instanceType,
      isReady,
      kubeletVersion: nodeInfo.kubeletVersion || '—',
      osImage: nodeInfo.osImage || 'Linux',
      containerRuntime: nodeInfo.containerRuntimeVersion || 'containerd',
      architecture: nodeInfo.architecture || 'amd64',
      /**
       * The node's raw, unparsed capacity strings, relayed exactly as the API reported them —
       * and `null` where it reported nothing. This used to substitute `'0'`, which put a
       * fabricated claim of *zero* capacity in the same object whose parsed `podCapacity` was
       * honestly `null`; a consumer reading this block (the one that mirrors the API, so the
       * one that looks authoritative) was told the node has no room, not that nobody read it.
       */
      capacity: {
        cpu: (status.capacity && status.capacity.cpu) || null,
        memory: (status.capacity && status.capacity.memory) || null,
        pods: (status.capacity && status.capacity.pods) || null
      },
      podsScheduled: podCount,
      podCapacity: podCap,
      podUsagePercent: pct(podCount, podCap),
      cpuAllocatable: cpuAlloc,
      cpuCapacity: cpuCap,
      cpuRequested: nodeReq.cpu,
      cpuRequestedPercent: pct(nodeReq.cpu, cpuAlloc),
      memoryAllocatable: memAlloc,
      memoryCapacity: memCap,
      memoryRequested: nodeReq.memory,
      memoryRequestedPercent: pct(nodeReq.memory, memAlloc),
      podsList: podsListByNode[meta.name] || []
    };
  });

  // Calculate zone distribution
  const zoneDistribution = {};
  for (const n of nodes) {
    zoneDistribution[n.zone] = (zoneDistribution[n.zone] || 0) + 1;
  }

  // Calculate pod to zone placement
  const nodeZoneMap = new Map(nodes.map(n => [n.name, n.zone]));
  const zonePodCounts = {};
  for (const p of podsRaw) {
    const nodeName = p.spec && p.spec.nodeName;
    if (nodeName && nodeZoneMap.has(nodeName)) {
      const z = nodeZoneMap.get(nodeName);
      zonePodCounts[z] = (zonePodCounts[z] || 0) + 1;
    }
  }

  const distinctZones = Object.keys(zoneDistribution).length;
  const isMultiZone = distinctZones > 1;

  // Calculate Node Group (Worker Pool) distribution and resource aggregations
  const nodeGroupDistribution = {};
  for (const n of nodes) {
    const g = n.nodeGroup || 'default-pool';
    if (!nodeGroupDistribution[g]) {
      nodeGroupDistribution[g] = {
        name: g,
        nodeCount: 0,
        readyNodes: 0,
        instanceTypes: new Set(),
        zones: new Set(),
        podsScheduled: 0,
        podCapacity: 0,
        podCapacityNodesReporting: 0,
        cpuAllocatable: 0,
        cpuRequested: 0,
        memoryAllocatable: 0,
        memoryRequested: 0
      };
    }
    const grp = nodeGroupDistribution[g];
    grp.nodeCount += 1;
    if (n.isReady) grp.readyNodes += 1;
    if (n.instanceType) grp.instanceTypes.add(n.instanceType);
    if (n.zone) grp.zones.add(n.zone);
    grp.podsScheduled += n.podsScheduled;
    // A node that reported no pod ceiling contributes nothing to the sum and is counted, so a
    // partial sum can be told from a complete one. `+= null` would have made the whole group's
    // ceiling 0, and `+= 110` is the fabrication this change removed.
    if (n.podCapacity !== null) {
      grp.podCapacity += n.podCapacity;
      grp.podCapacityNodesReporting += 1;
    }
    grp.cpuAllocatable += n.cpuAllocatable;
    grp.cpuRequested += n.cpuRequested;
    grp.memoryAllocatable += n.memoryAllocatable;
    grp.memoryRequested += n.memoryRequested;
  }

  const nodeGroups = Object.values(nodeGroupDistribution).map(g => ({
    name: g.name,
    nodeCount: g.nodeCount,
    readyNodes: g.readyNodes,
    instanceTypes: [...g.instanceTypes],
    zones: [...g.zones].sort(),
    podsScheduled: g.podsScheduled,
    // null when no node in the pool reported a ceiling at all; a sum over only the nodes that
    // did when some are missing, with the count of reporters beside it so the reader can see
    // it is partial. The percentage is withheld unless every node in the pool reported —
    // a full numerator over a partial denominator reads over 100% and means nothing.
    podCapacity: g.podCapacityNodesReporting > 0 ? g.podCapacity : null,
    podCapacityNodesReporting: g.podCapacityNodesReporting,
    podUsagePercent: g.podCapacityNodesReporting === g.nodeCount ? pct(g.podsScheduled, g.podCapacity) : null,
    cpuAllocatable: Math.round(g.cpuAllocatable * 100) / 100,
    cpuRequested: Math.round(g.cpuRequested * 100) / 100,
    cpuRequestedPercent: pct(g.cpuRequested, g.cpuAllocatable),
    memoryAllocatable: g.memoryAllocatable,
    memoryRequested: g.memoryRequested,
    memoryRequestedPercent: pct(g.memoryRequested, g.memoryAllocatable)
  }));

  return {
    cluster: publicCluster(ctx.cluster),
    /**
     * Node taints, and the pod tolerations that answer them.
     *
     * Lives on this payload because both halves are projections of the two reads this collector
     * already performs — joining 120 pod specs against three nodes from a separate route would be
     * a second full list read of the same data.
     *
     * `nodesRead` is unconditionally true here: a refused node read throws above rather than
     * reaching this line, which is the same reason `isMultiZone` is trustworthy by construction.
     * `podsRead` is not — pods go through safeList and can fail alone, and when they do the
     * toleration half must read as unknown rather than as "no pod tolerates anything".
     */
    taints: collectTaints(nodesRaw, podsRaw, {
      nodesRead: true,
      podsRead: podsResult.ok !== false
    }),
    summary: {
      totalNodes: nodes.length,
      readyNodes: nodes.filter(n => n.isReady).length,
      distinctZones,
      // Trustworthy by construction: this line is only ever reached when the node list was
      // read, because a refused read threw above rather than reaching here as a zero.
      isMultiZone,
      distinctNodeGroups: nodeGroups.length,
      totalPodsAudited: podsRaw.length,
      totalPodsScheduled: nodes.reduce((sum, n) => sum + (n.podsScheduled || 0), 0),
      // Pod ceilings, summed over the nodes that reported one. null when none did, and
      // `totalPodCapacityNodesReporting` says how many of `totalNodes` are behind the sum, so a
      // partial total is never read as a fleet ceiling.
      totalPodCapacity: nodes.some(n => n.podCapacity !== null)
        ? nodes.reduce((sum, n) => sum + (n.podCapacity || 0), 0)
        : null,
      totalPodCapacityNodesReporting: nodes.filter(n => n.podCapacity !== null).length,
      // Reads that could not be performed at all. Only ever `[]` or `['pods']` here: a
      // failed node read never produces a summary.
      unavailable: unavailableLabels([podsResult]),
      // Reads that succeeded but stopped at the client's paging ceiling. The counts above
      // that derive from them are floors, not totals.
      truncated: truncatedLabels([nodesTruncation, podsResult])
    },
    zones: Object.entries(zoneDistribution).map(([zone, count]) => ({
      zone,
      nodeCount: count,
      podCount: zonePodCounts[zone] || 0
    })),
    nodeGroups,
    nodes
  };
}

export default { collect };
