/**
 * Development fixtures: a fake Kubernetes API and a fake token mount.
 *
 * These exist so the UI can be built and reviewed without pointing anything at a real
 * cluster. The important design decision is *where* the fake sits: it replaces the
 * transport (`listFn`) and nothing else, so every response the browser sees has been
 * produced by the real collectors doing their real parsing, grouping and grading. A set
 * of hand-written response fixtures would drift from the collectors within a week and
 * would let the UI be built against shapes the server never actually emits.
 *
 * Each cluster is deliberately in a different state, because the states that need design
 * attention are the unhappy ones: an unreachable cluster, an expiring token, a
 * crash-looping workload, a namespace that never got the bootstrap treatment.
 *
 * Only platformsbx is a real cluster id. The rest are invented demo entries whose API
 * URLs sit on the reserved .invalid TLD — the fleet is being rolled out one cluster at a
 * time, and nothing here should be capable of naming, let alone contacting, a cluster
 * another team owns.
 *
 * Loaded only by tests. No server — deployed or local — can reach this file: `srv/server.js`
 * and `srv/fleet/dev-server.js` both have exactly one data path, the real transport.
 */
import _errors from '../errors.js';
const { ClusterError, UNREACHABLE } = _errors;

const HOUR = 3600_000;

/** The per-cluster script. Everything below is derived from this table. */
const SCENARIOS = {
  platformsbx: { nodes: 3, pods: 41, token: 18.5 * HOUR, broken: null, unmanagedNs: ['btp-cloud-gateway'] },
  'demo-dev': { nodes: 2, pods: 27, token: 21 * HOUR, broken: 'crashloop', unmanagedNs: [] },
  'demo-uat': { nodes: 2, pods: 19, token: 2.4 * HOUR, broken: 'pending', unmanagedNs: ['sandbox-scratch'] },
  'demo-unreachable': { nodes: 4, pods: 63, token: 9 * HOUR, broken: 'unreachable', unmanagedNs: [] },
  'demo-offboarded': { nodes: 0, pods: 0, token: null, broken: null, unmanagedNs: [] }
};

const MANAGED_NS = ['btp-platform-foundation', 'btp-integration', 'btp-observability'];
const SYSTEM_NS = ['kube-system', 'istio-system', 'kyma-system', 'sealed-secrets', 'cicd-serviceaccount'];

const iso = ms => new Date(ms).toISOString();

// ------------------------------------------------------------------ raw objects

function node(cluster, i) {
  // One node deliberately mid-upgrade on UAT, so the "more than one version" case the
  // health collector reports is actually visible somewhere in the UI.
  const version = (cluster === 'demo-unreachable' && i === 0) ? 'v1.31.4' : 'v1.30.7';
  const ready = !(cluster === 'demo-dev' && i === 1);
  const zone = ['eu10-a', 'eu10-b', 'eu10-c'][i % 3];
  return {
    metadata: {
      name: nodeName(cluster, i),
      creationTimestamp: iso(Date.now() - (30 + i) * 24 * HOUR),
      labels: {
        'node-role.kubernetes.io/worker': '',
        'kubernetes.io/arch': 'amd64',
        'kubernetes.io/os': 'linux',
        'topology.kubernetes.io/zone': zone,
        'node.kubernetes.io/instance-type': 'm5.2xlarge',
        'worker.gardener.cloud/pool': i === 0 ? 'system' : 'cpu-worker'
      }
    },
    spec: {
      // One cordoned node on UAT, because a cordon is invisible in a ready/total count
      // and the design needs somewhere to show that it is not.
      unschedulable: cluster === 'demo-uat' && i === 1,
      taints: cluster === 'demo-uat' && i === 1
        ? [{ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' }]
        : []
    },
    status: {
      conditions: [
        { type: 'Ready', status: ready ? 'True' : 'False', reason: ready ? 'KubeletReady' : 'KubeletNotReady', message: ready ? 'kubelet is posting ready status' : 'kubelet stopped posting node status' },
        { type: 'MemoryPressure', status: cluster === 'demo-dev' && i === 0 ? 'True' : 'False', reason: 'KubeletHasInsufficientMemory', message: 'kubelet has insufficient memory available' },
        { type: 'DiskPressure', status: 'False' },
        { type: 'PIDPressure', status: 'False' }
      ],
      capacity: { cpu: '8', memory: '32612204Ki', pods: '110' },
      // Allocatable is always less than capacity: the kubelet and the system reserve some,
      // and showing requests against capacity rather than allocatable understates pressure.
      allocatable: { cpu: '7910m', memory: '30515052Ki', pods: '110' },
      nodeInfo: { kubeletVersion: version, operatingSystem: 'linux', containerRuntimeVersion: 'containerd://1.7.16' }
    }
  };
}

function nodeName(cluster, i) {
  return `shoot--kyma--${cluster}-worker-${String(i + 1).padStart(2, '0')}`;
}

function pod(cluster, ns, app, index, { phase = 'Running', reason = null, restarts = 0 } = {}) {
  return {
    metadata: {
      name: `${app}-7d9f8b6c5-${cluster.slice(0, 3)}${index}`,
      namespace: ns,
      labels: { app }
    },
    spec: {
      // Real pods land on real nodes, and "which node" is a first-class column in the UI,
      // so the fixture spreads them the way a scheduler would.
      nodeName: nodeName(cluster, index % Math.max(1, (SCENARIOS[cluster] || { nodes: 1 }).nodes)),
      containers: [{
        name: app,
        image: `registry.example.com/${app}:1.4.2`,
        resources: {
          requests: { cpu: '250m', memory: '512Mi' },
          limits: { cpu: '1', memory: '1Gi' }
        }
      }],
      qosClass: 'Burstable'
    },
    status: {
      phase,
      podIP: `10.42.${index % 250}.${(index * 7) % 250}`,
      qosClass: 'Burstable',
      startTime: iso(Date.now() - 6 * HOUR),
      containerStatuses: [{
        name: app,
        restartCount: restarts,
        state: reason
          ? { waiting: { reason, message: reason === 'CrashLoopBackOff'
              ? 'back-off 5m0s restarting failed container=api pod=api-7d9f8b6c5'
              : 'containers with unready status: [api]' } }
          : { running: { startedAt: iso(Date.now() - 6 * HOUR) } }
      }]
    }
  };
}

function deployment(cluster, ns, app, { replicas = 2, ready = 2 } = {}) {
  return {
    metadata: { name: app, namespace: ns, creationTimestamp: iso(Date.now() - 30 * 24 * HOUR) },
    spec: {
      replicas,
      selector: { matchLabels: { app } },
      template: { spec: { containers: [{ name: app, image: `registry.example.com/${app}:1.4.2` }] } }
    },
    status: { readyReplicas: ready, replicas }
  };
}

/** Build the whole fake cluster once, then answer list calls out of it. */
function buildCluster(id) {
  const s = SCENARIOS[id] || SCENARIOS['demo-offboarded'];
  const namespaces = [...MANAGED_NS, ...s.unmanagedNs, ...SYSTEM_NS];

  const nodes = Array.from({ length: s.nodes }, (_, i) => node(id, i));

  const apps = ['api', 'worker', 'gateway'];
  const pods = [];
  const deployments = [];

  for (const ns of MANAGED_NS) {
    for (const app of apps) {
      const isBroken = s.broken === 'crashloop' && ns === MANAGED_NS[0] && app === 'api';
      const isPending = s.broken === 'pending' && ns === MANAGED_NS[1] && app === 'worker';

      if (isBroken) {
        deployments.push(deployment(id, ns, app, { replicas: 2, ready: 0 }));
        pods.push(pod(id, ns, app, 1, { phase: 'Running', reason: 'CrashLoopBackOff', restarts: 147 }));
        pods.push(pod(id, ns, app, 2, { phase: 'Running', reason: 'CrashLoopBackOff', restarts: 143 }));
      } else if (isPending) {
        deployments.push(deployment(id, ns, app, { replicas: 3, ready: 1 }));
        pods.push(pod(id, ns, app, 1));
        pods.push(pod(id, ns, app, 2, { phase: 'Pending', reason: 'ImagePullBackOff' }));
        pods.push(pod(id, ns, app, 3, { phase: 'Pending', reason: 'ImagePullBackOff' }));
      } else {
        deployments.push(deployment(id, ns, app));
        pods.push(pod(id, ns, app, 1));
        pods.push(pod(id, ns, app, 2, { restarts: 1 }));
      }
    }
  }

  // Pad out to the scenario's pod count with system pods, so the totals look plausible.
  let filler = 0;
  while (pods.length < s.pods) {
    pods.push(pod(id, SYSTEM_NS[filler % SYSTEM_NS.length], 'controller', filler++));
  }

  const nsObjects = namespaces.map(name => {
    const managed = MANAGED_NS.includes(name);
    const labels = {};
    if (managed) {
      labels['istio-injection'] = 'enabled';
      labels['pod-security.kubernetes.io/enforce'] = 'baseline';
    }
    return { metadata: { name, labels } };
  });

  // Only bootstrapped namespaces carry the four artefacts the compliance checks look for;
  // the unmanaged ones fail every check, which is the finding worth surfacing.
  const secrets = MANAGED_NS.map(ns => ({
    metadata: { name: 'docker-registry-secret', namespace: ns },
    type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': 'e30=' }
  }));
  const roleBindings = MANAGED_NS.map(ns => ({
    metadata: { name: 'jenkins-deployer-binding', namespace: ns },
    roleRef: { kind: 'ClusterRole', name: 'app-platform-cicd-deployer-role' },
    subjects: [{ kind: 'ServiceAccount', name: 'jenkins-deployer', namespace: 'cicd-serviceaccount' }]
  }));
  const networkPolicies = MANAGED_NS.map(ns => ({
    metadata: { name: 'egress-allow-btp-traffic', namespace: ns },
    spec: { policyTypes: ['Egress'] }
  }));

  const events = s.broken === 'crashloop'
    ? [{
        metadata: { namespace: MANAGED_NS[0] },
        reason: 'BackOff', type: 'Warning', count: 412,
        message: 'Back-off restarting failed container api in pod api-7d9f8b6c5',
        involvedObject: { kind: 'Pod', name: 'api-7d9f8b6c5-app1' },
        lastTimestamp: iso(Date.now() - 4 * 60_000)
      }]
    : s.broken === 'pending'
      ? [{
          metadata: { namespace: MANAGED_NS[1] },
          reason: 'Failed', type: 'Warning', count: 38,
          message: 'Failed to pull image "registry.example.com/worker:1.4.2": unauthorized',
          involvedObject: { kind: 'Pod', name: 'worker-7d9f8b6c5-app2' },
          lastTimestamp: iso(Date.now() - 11 * 60_000)
        }]
      : [];

  return { nodes, pods, namespaces: nsObjects, secrets, roleBindings, networkPolicies, events, deployments };
}

const built = new Map();
function clusterData(id) {
  if (!built.has(id)) built.set(id, buildCluster(id));
  return built.get(id);
}

/**
 * Give a cluster onboarded through the UI something to show.
 *
 * Without this an unknown id falls back to the offboarded scenario — zero nodes, zero pods —
 * and the cluster you just added looks broken rather than new. A healthy two-node cluster is
 * the honest fixture for "onboarding worked".
 */
function registerScenario(id) {
  if (SCENARIOS[id]) return;
  SCENARIOS[id] = { nodes: 2, pods: 22, token: 23.5 * HOUR, broken: null, unmanagedNs: [] };
  built.delete(id);
}

/**
 * A stand-in for k8s.call — the write path onboarding uses.
 *
 * Onboarding is the one flow that does not go through the collectors, so it needs its own
 * seam or the "Add cluster" dialog is unusable without a real cluster. Everything is
 * answered optimistically except the TokenRequest for a service account named
 * `no-renew`, which is refused: the warning path in the dialog — a token that cannot mint
 * its successor — is the one worth being able to look at.
 *
 * Also answers the two discovery GETs (`/apis` and `/apis/<group>`) that `absentList`
 * (safe-list.js) probes when a 404'd list needs telling "CRD absent" apart from "CRD
 * present but this read failed another way" — networking.js's APIRule read is the first
 * caller. `DISCOVERY_OVERRIDES` lets a later wave's test pick 403/404/200-empty per
 * resource type without having to grow this function's own branching for each one.
 */

/**
 * Per-scenario discovery overrides, keyed by cluster id then by group. A later wave sets
 * these before calling `listFn`/`callFn` so a test can force a specific resource type to
 * read as 403, 404, or 200-with-an-empty-list without touching this module's source.
 *
 * `{ list: 403 | 404 | 'empty' }` controls what the *list* call for that group's resources
 * does; `{ group: 403 | 404 }` controls what the discovery probe for that group answers.
 * Absent means "behave as the synthetic defaults below say".
 *
 * @type {Map<string, Map<string, {list?: 403|404|'empty', group?: 403|404}>>}
 */
const discoveryOverrides = new Map();

/** Set (or clear, with `undefined`) the discovery override for one cluster + group. */
function setDiscoveryOverride(clusterId, group, override) {
  if (!discoveryOverrides.has(clusterId)) discoveryOverrides.set(clusterId, new Map());
  const forCluster = discoveryOverrides.get(clusterId);
  if (override === undefined) forCluster.delete(group);
  else forCluster.set(group, override);
}

function overrideFor(clusterId, group) {
  const forCluster = discoveryOverrides.get(clusterId);
  return (forCluster && forCluster.get(group)) || null;
}

/** Every API group this fixture cluster actually serves, and the versions it serves them at. */
const SERVED_GROUPS = {
  'gateway.kyma-project.io': ['v1beta1', 'v2alpha1', 'v2'],
  'networking.istio.io': ['v1beta1'],
  'networking.k8s.io': ['v1'],
  'rbac.authorization.k8s.io': ['v1'],
  'apps': ['v1'],
  'metrics.k8s.io': ['v1beta1']
};

function apiGroupList() {
  return {
    kind: 'APIGroupList',
    groups: Object.entries(SERVED_GROUPS).map(([name, versions]) => ({
      name,
      versions: versions.map(v => ({ groupVersion: `${name}/${v}`, version: v })),
      preferredVersion: { groupVersion: `${name}/${versions[versions.length - 1]}`, version: versions[versions.length - 1] }
    }))
  };
}

function notFound(path) {
  return new ClusterError('UPSTREAM', `the server could not find the requested resource (${path})`, { status: 404 });
}

/**
 * Answer the two discovery GETs `absentList` makes: the flat list of every served group
 * (`/apis`), and one group's own served versions (`/apis/<group>`). Returns `null` when the
 * path is not a discovery path at all, so the caller can fall through to its other routing.
 */
function discoveryResponse(clusterId, path) {
  if (path === '/apis' || path.startsWith('/apis?')) return apiGroupList();

  const m = /^\/apis\/([^/?]+)/.exec(path);
  if (!m) return null;
  const group = decodeURIComponent(m[1]);
  const override = overrideFor(clusterId, group);
  if (override && override.group === 403) {
    throw new ClusterError('FORBIDDEN', `apis/${group.replace(/\//g, '~1')} is forbidden (fixture)`, { status: 403 });
  }
  if ((override && override.group === 404) || !SERVED_GROUPS[group]) throw notFound(path);

  const versions = SERVED_GROUPS[group];
  return {
    kind: 'APIGroup',
    name: group,
    versions: versions.map(v => ({ groupVersion: `${group}/${v}`, version: v })),
    preferredVersion: { groupVersion: `${group}/${versions[versions.length - 1]}`, version: versions[versions.length - 1] }
  };
}

async function callFn({ cluster, path, method = 'GET' }) {
  if (path === '/version') return { gitVersion: 'v1.30.7', platform: 'linux/amd64' };

  const discovered = discoveryResponse(cluster ? cluster.id : null, path);
  if (discovered !== null) return discovered;

  if (path.endsWith('/token') && method === 'POST') {
    if (/serviceaccounts\/no-renew\/token$/.test(path)) {
      throw new ClusterError('FORBIDDEN', 'serviceaccounts "no-renew" is forbidden: cannot create token (fixture)', { status: 403 });
    }
    const expiresAt = iso(Date.now() + 24 * HOUR);
    return { status: { token: `FIXTURE-MINTED-NOT-A-REAL-TOKEN.${Date.now()}`, expirationTimestamp: expiresAt } };
  }

  if (method === 'GET' && (path.startsWith('/api/v1/namespaces?') || path === '/api/v1/namespaces')) {
    return { items: [{ metadata: { name: 'kube-system' } }] };
  }

  // Every apply() lands here: POST creates, and nothing pre-exists in a fixture cluster.
  return { metadata: { name: 'fixture', resourceVersion: '1' } };
}

// -------------------------------------------------------------------- the fakes

/** A stand-in for k8s.list. Routes on path the same way the real API server does. */
async function listFn({ cluster, path }) {
  const s = SCENARIOS[cluster.id];
  if (s && s.broken === 'unreachable') {
    throw new ClusterError(UNREACHABLE, `${cluster.id}: connect ETIMEDOUT (fixture)`, { cluster: cluster.id });
  }

  // Per-scenario override, keyed by the resource's API group — set by a later wave's test
  // via `setDiscoveryOverride` to force one resource type to 403, 404, or answer with a
  // genuinely empty list, without adding another branch to this routing table.
  const groupMatch = /^\/apis\/([^/]+)\//.exec(path);
  const group = groupMatch ? decodeURIComponent(groupMatch[1]) : (path.startsWith('/api/v1/') ? 'core' : null);
  const override = group && overrideFor(cluster.id, group);
  if (override && override.list === 403) {
    throw new ClusterError('FORBIDDEN', `${path} is forbidden (fixture override)`, { cluster: cluster.id, status: 403 });
  }
  if (override && override.list === 404) throw notFound(path);
  if (override && override.list === 'empty') return [];

  const d = clusterData(cluster.id);
  const inNs = path.match(/\/namespaces\/([^/]+)\//);
  const scope = items => (inNs ? items.filter(i => i.metadata.namespace === decodeURIComponent(inNs[1])) : items);

  // metrics.k8s.io must be matched before the generic /pods rule below, or pod objects
  // would be handed back as metrics and every usage figure would read zero.
  if (path.startsWith('/apis/metrics.k8s.io')) {
    // UAT has no metrics-server, so the degraded panel is reachable in the fixtures.
    if (cluster.id === 'demo-uat') {
      throw new ClusterError('UPSTREAM', 'the server could not find the requested resource', { cluster: cluster.id, status: 404 });
    }
    if (path.includes('/nodes')) {
      return d.nodes.map((n, i) => ({
        metadata: { name: n.metadata.name },
        timestamp: iso(Date.now() - 30_000),
        usage: { cpu: `${2100 + i * 640}m`, memory: `${9 + i * 2}Gi` }
      }));
    }
    return scope(d.pods).map(p => ({
      metadata: { name: p.metadata.name, namespace: p.metadata.namespace },
      timestamp: iso(Date.now() - 30_000),
      containers: (p.spec.containers || []).map(c => ({
        name: c.name,
        usage: { cpu: `${120_000_000 + p.metadata.name.length * 3_000_000}n`, memory: `${180 + (p.metadata.name.length % 7) * 20}Mi` }
      }))
    }));
  }

  if (path.startsWith('/api/v1/namespaces?') || path === '/api/v1/namespaces') return d.namespaces;
  if (path.startsWith('/api/v1/nodes')) return d.nodes;
  if (path.includes('/pods')) return scope(d.pods);
  if (path.includes('/events')) return scope(d.events);
  if (path.includes('/secrets')) return scope(d.secrets);
  if (path.includes('/rolebindings')) return scope(d.roleBindings);
  if (path.includes('/networkpolicies')) return scope(d.networkPolicies);
  if (path.includes('/deployments')) return scope(d.deployments);
  if (path.includes('/statefulsets')) return [];
  if (path.includes('/daemonsets')) return [];
  return [];
}

/**
 * A stand-in for TokenStore. Same contract, no filesystem: health() never returns a
 * token, and tokenFor() returns an obviously-fake string so a fixture value can never be
 * mistaken for a real bearer in a log.
 *
 * `adopt` is what makes the "Add cluster" dialog worth opening in development: a cluster
 * onboarded through the UI gets a record here, so it appears on the fleet with a live
 * countdown instead of as permanently unseeded.
 */
function createTokenStore({ now = Date.now } = {}) {
  /** @type {Map<string, {expiresAt: string, renewedAt: string}>} */
  const adopted = new Map();
  return {
    adopt(id, { expiresAt, renewedAt }) {
      adopted.set(id, { expiresAt, renewedAt: renewedAt || iso(now()) });
    },
    health(id) {
      const own = adopted.get(id);
      if (own) {
        const expiresInMs = Date.parse(own.expiresAt) - now();
        return {
          status: expiresInMs <= 0 ? 'expired' : expiresInMs < 6 * HOUR ? 'expiring' : 'valid',
          expiresAt: own.expiresAt,
          expiresInMs,
          renewedAt: own.renewedAt,
          lastError: null,
          dueForRenewal: expiresInMs < 12 * HOUR
        };
      }
      const s = SCENARIOS[id];
      if (!s || s.token === null) {
        return { status: 'unseeded', expiresAt: null, expiresInMs: null, renewedAt: null, lastError: null, dueForRenewal: true };
      }
      const expiresInMs = s.token;
      const status = expiresInMs <= 0 ? 'expired' : expiresInMs < 6 * HOUR ? 'expiring' : 'valid';
      return {
        status,
        expiresAt: iso(now() + expiresInMs),
        expiresInMs,
        renewedAt: iso(now() + expiresInMs - 24 * HOUR),
        lastError: s.broken === 'unreachable' ? 'UNREACHABLE: connect ETIMEDOUT (fixture)' : null,
        dueForRenewal: expiresInMs < 12 * HOUR
      };
    },
    tokenFor(id) {
      if (adopted.has(id)) return `FIXTURE-NOT-A-REAL-TOKEN-${id}`;
      const s = SCENARIOS[id];
      return s && s.token !== null ? `FIXTURE-NOT-A-REAL-TOKEN-${id}` : null;
    }
  };
}


/**
 * Fake log text, so the Logs page can be designed against something that reads like a
 * real log — mixed levels, a stack trace, a restart boundary — rather than lorem ipsum.
 *
 * The shape is exactly what the API server returns with `timestamps=true`: an RFC3339
 * stamp, a space, then the application's own line. The parser in collectors/logs.js is
 * the real one, so anything wrong with the split shows up in the browser.
 */
const LOG_SCRIPT = [
  ['info', 'server listening on :4004'],
  ['info', 'connected to hana pool (size 10)'],
  ['debug', 'DEBUG cache warm: 412 entries'],
  ['info', 'GET /odata/v4/catalog/Books 200 14ms'],
  ['warn', 'WARN slow query: SELECT * FROM Books took 1483ms'],
  ['info', 'GET /odata/v4/catalog/Books 200 11ms'],
  ['error', 'ERROR upstream timeout calling credstore: ETIMEDOUT'],
  ['error', 'Exception in handler: TypeError: cannot read property id of undefined'],
  ['info', '    at Object.<anonymous> (/app/srv/catalog-service.js:42:17)'],
  ['info', 'GET /health 200 1ms']
];

function textFn({ cluster, path }) {
  const previous = /previous=true/.test(path);
  const requested = Number((/tailLines=(\d+)/.exec(path) || [])[1] || 200);
  const podName = decodeURIComponent((/\/pods\/([^/]+)\/log/.exec(path) || [])[1] || 'pod');

  // A previous instance ends where the crash happened; that boundary is the whole reason
  // the toggle exists, so the fixture makes it visible.
  const script = previous
    ? [...LOG_SCRIPT.slice(0, 7), ['fatal', 'FATAL out of memory, killing process'], ['info', `signal: killed (OOMKilled) — ${podName}`]]
    : LOG_SCRIPT;

  const count = Math.min(requested, script.length * 4);
  const base = Date.now() - count * 1500;
  const lines = [];
  for (let i = 0; i < count; i++) {
    const [, message] = script[i % script.length];
    lines.push(`${iso(base + i * 1500)} ${message} [${cluster.id}]`);
  }
  return Promise.resolve(lines.join('\n') + '\n');
}

export default { listFn, textFn, callFn, createTokenStore, registerScenario, SCENARIOS, setDiscoveryOverride };
