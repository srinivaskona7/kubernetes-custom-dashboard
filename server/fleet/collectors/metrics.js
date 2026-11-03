/**
 * Live resource usage, from metrics.k8s.io.
 *
 * Requests and limits — what the workloads collector reports — say what a pod *asked
 * for*. This says what it is *using right now*. The gap between the two is where cluster
 * cost and OOMKills both live, so the dashboard shows them side by side.
 *
 * metrics-server is an add-on. It is present on Kyma clusters, but a cluster without it
 * answers 404 on this API group, and that must degrade a panel rather than fail a page —
 * so every function here returns `{available: false, reason}` instead of throwing.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import quantity from './quantity.js';

/** "100m" -> 0.1 cores. "2" -> 2. */
const parseCpu = quantity.parseCpu;

/**
 * "512Mi" -> bytes, and `0` when the quantity is absent or carries a unit we do not define.
 *
 * The `0` is this module's own convention, kept because `workloads.js` sums these and its wire
 * contract already spells "no limit is set" as `0` — Kubernetes rejects a literal zero limit, so
 * the encoding is unambiguous downstream. What changed is what happens to an unrecognised unit:
 * it used to become the bare number (so `4194304k` read as 4 MB instead of 4.19 GB); now it
 * becomes `0`, which the UI already renders as "No limit" instead of a confidently wrong ratio.
 * See `quantity.js` for the measured case that forced this.
 */
function parseMemory(value) {
  return quantity.parseMemory(value) ?? 0;
}

/**
 * Per-pod and per-container live usage, keyed `namespace/pod`.
 *
 * @param {{cluster: object, token: string, namespace?: string, listFn?: typeof list}} ctx
 * @returns {Promise<{available: boolean, reason?: string, pods: Map|object}>}
 */
async function podUsage({ cluster, token, namespace, listFn = list }) {
  const scope = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
  try {
    const items = await listFn({ cluster, token, path: `/apis/metrics.k8s.io/v1beta1${scope}/pods` });
    const byPod = {};
    for (const m of items) {
      const containers = (m.containers || []).map(c => ({
        name: c.name,
        cpu: parseCpu(c.usage && c.usage.cpu),
        memory: parseMemory(c.usage && c.usage.memory)
      }));
      byPod[`${m.metadata.namespace}/${m.metadata.name}`] = {
        cpu: containers.reduce((n, c) => n + c.cpu, 0),
        memory: containers.reduce((n, c) => n + c.memory, 0),
        containers,
        at: m.timestamp || null
      };
    }
    return { available: true, pods: byPod };
  } catch (err) {
    return { available: false, reason: reasonFor(err), pods: {} };
  }
}

/** Per-node live usage, keyed by node name. */
async function nodeUsage({ cluster, token, listFn = list }) {
  try {
    const items = await listFn({ cluster, token, path: '/apis/metrics.k8s.io/v1beta1/nodes' });
    const byNode = {};
    for (const m of items) {
      byNode[m.metadata.name] = {
        cpu: parseCpu(m.usage && m.usage.cpu),
        memory: parseMemory(m.usage && m.usage.memory),
        at: m.timestamp || null
      };
    }
    return { available: true, nodes: byNode };
  } catch (err) {
    return { available: false, reason: reasonFor(err), nodes: {} };
  }
}

function reasonFor(err) {
  if (err && err.status === 404) return 'metrics-server is not installed on this cluster';
  if (err && err.code === 'FORBIDDEN') return 'the fleet-reader role lacks get/list on metrics.k8s.io';
  if (err && err.status === 503) return 'metrics-server is installed but not answering yet';
  return (err && err.message) || 'metrics unavailable';
}

export default { podUsage, nodeUsage, parseCpu, parseMemory };
