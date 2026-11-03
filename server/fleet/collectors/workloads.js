/**
 * Workloads and recent warning events — the "what is broken right now" view.
 *
 * Three things a fleet console is repeatedly asked for, and which this collector answers
 * without a second round trip:
 *
 *   - which node did this pod land on (a failure confined to one node looks exactly like
 *     a failure of the workload until you can see the placement)
 *   - what containers does it have, and which of them is the one restarting
 *   - what is it actually using right now, next to what it asked for
 *
 * Live usage comes from metrics-server and is optional: a cluster without it still gets
 * every other column, and the UI shows the usage cells as unavailable rather than zero.
 * Zero would be a lie, and a convincing one.
 */
import k8sModule from '../k8s.js';
const { list, namespaceSegment, normaliseNamespaces } = k8sModule;
import metrics from './metrics.js';
import safeListModule from './safe-list.js';
const { safeList, requiredList, unavailableLabels, truncatedLabels } = safeListModule;
import errorsModule from '../errors.js';
const { ClusterError, NOT_FOUND } = errorsModule;

/**
 * Ready/desired for a Deployment, StatefulSet or DaemonSet, plus a status word.
 *
 * A DaemonSet has neither `spec.replicas` nor `status.readyReplicas` — it is sized by the
 * scheduler against node taints/selectors, not a replica count, and reports itself via
 * `desiredNumberScheduled`/`numberReady`. Falling through to the Deployment/StatefulSet
 * fields for a DaemonSet reads `desired` as the undefined-default of 1 and `ready` as 0,
 * so every DaemonSet in the fleet — including ones the platform itself runs on every
 * node — renders "0/1 Unavailable" regardless of its real health.
 *
 * A StatefulSet has no availability condition at all (unlike a Deployment, which reports
 * `status.conditions[type=Available]`), so `readyReplicas === desired` is the only signal
 * this function has for it — and it is an incomplete one: a StatefulSet mid-rollout can
 * have every replica "ready" on the *old* revision while the new one never comes up, and
 * `readyReplicas` alone reports that as healthy. `currentRevision === updateRevision` is
 * the rollout-truth signal that number is missing, so a StatefulSet is only "Ready" when
 * both agree — replicas ready AND rollout current.
 */
function readiness(obj, kind) {
  const spec = obj.spec || {};
  const status = obj.status || {};
  const desired = kind === 'DaemonSet'
    ? (status.desiredNumberScheduled || 0)
    : (spec.replicas === undefined ? 1 : spec.replicas);
  const ready = kind === 'DaemonSet' ? (status.numberReady || 0) : (status.readyReplicas || 0);

  // currentRevision/updateRevision are absent on a StatefulSet that has never been updated
  // since creation, in which case there is nothing stale to detect and rollout is current.
  const rolloutCurrent = kind !== 'StatefulSet'
    || !status.currentRevision || !status.updateRevision
    || status.currentRevision === status.updateRevision;

  let state;
  if (desired === 0) state = 'Scaled to zero';
  else if (ready === desired && rolloutCurrent) state = 'Ready';
  else if (ready === 0) state = 'Unavailable';
  else if (!rolloutCurrent) state = 'Progressing';
  else state = 'Progressing';

  return { kind, desired, ready, state };
}

/**
 * The tag out of an image reference — `null` when there isn't one.
 *
 * The last `:` is NOT the tag separator in general. A registry may carry a port
 * (`myreg.local:5000/agent`, where the last colon is in the *host*, so a naive split reports
 * the tag as "5000/agent"), and a digest-pinned reference (`app@sha256:abc…`) has no tag at
 * all — splitting it reports the 64-hex digest as the tag. A colon only separates a tag when
 * it comes after the final `/`, and a `@` anywhere means the ref is digest-pinned.
 */
function imageTag(image) {
  if (typeof image !== 'string' || image.includes('@')) return null;
  const colon = image.lastIndexOf(':');
  if (colon === -1 || colon < image.lastIndexOf('/')) return null;
  return image.slice(colon + 1) || null;
}

/** The first container's image is what people mean by "the image" for these workloads. */
function primaryImage(obj) {
  const containers = (obj.spec && obj.spec.template && obj.spec.template.spec && obj.spec.template.spec.containers) || [];
  return containers.length ? containers[0].image : null;
}

/**
 * Pods are what actually reveal CrashLoopBackOff — a Deployment's own status only says
 * "not available", never why. Restart counts and waiting reasons come from here.
 *
 * A LabelSelector can carry `matchLabels` (an equality map), `matchExpressions` (In/NotIn/
 * Exists/DoesNotExist), or both — and the two combine with AND, not OR. A Deployment
 * selected purely by `matchExpressions` (e.g. `env In (prod, staging)`) has no `matchLabels`
 * at all, so a selector that only checked `matchLabels` returned every pod for it as `[]`
 * and the workload rendered as a clean "Ready" with nobody actually examined.
 */
function matchesExpression(labels, expr) {
  const values = Array.isArray(expr.values) ? expr.values : [];
  switch (expr.operator) {
    case 'In': return values.includes(labels[expr.key]);
    case 'NotIn': return !values.includes(labels[expr.key]);
    case 'Exists': return Object.prototype.hasOwnProperty.call(labels, expr.key);
    case 'DoesNotExist': return !Object.prototype.hasOwnProperty.call(labels, expr.key);
    default: return false; // an operator we do not recognise must not silently match everything
  }
}

function podsForSelector(pods, namespace, selector) {
  const matchLabels = (selector && selector.matchLabels) || null;
  const matchExpressions = (selector && selector.matchExpressions) || null;
  if (!matchLabels && !matchExpressions) return [];
  return pods.filter(p => {
    if (p.metadata.namespace !== namespace) return false;
    const labels = p.metadata.labels || {};
    if (matchLabels && !Object.entries(matchLabels).every(([k, v]) => labels[k] === v)) return false;
    if (matchExpressions && !matchExpressions.every(expr => matchesExpression(labels, expr))) return false;
    return true;
  });
}

/**
 * The `sha256:…` digest out of a container status's `imageID`, which arrives either as a
 * fully-qualified reference with the digest appended or as the bare digest alone.
 */
function imageDigest(imageID) {
  if (typeof imageID !== 'string') return null;
  const match = /sha256:[a-f0-9]{64}/.exec(imageID);
  return match ? match[0] : null;
}

/** Sum the requests and limits declared across a pod's containers. */
function podResources(pod) {
  const containers = (pod.spec && pod.spec.containers) || [];
  const total = { cpuRequest: 0, cpuLimit: 0, memoryRequest: 0, memoryLimit: 0 };
  for (const c of containers) {
    const r = (c.resources && c.resources.requests) || {};
    const l = (c.resources && c.resources.limits) || {};
    total.cpuRequest += metrics.parseCpu(r.cpu);
    total.cpuLimit += metrics.parseCpu(l.cpu);
    total.memoryRequest += metrics.parseMemory(r.memory);
    total.memoryLimit += metrics.parseMemory(l.memory);
  }
  return total;
}

/**
 * @param {object} pod
 * @param {object} [usage] the metrics entry for this pod, when metrics-server answered
 */
function podSummary(pod, usage) {
  const spec = pod.spec || {};
  const status = pod.status || {};
  const statuses = status.containerStatuses || [];
  const initStatuses = status.initContainerStatuses || [];
  const restarts = statuses.reduce((n, cs) => n + (cs.restartCount || 0), 0);
  // A container that is waiting carries the reason people actually need:
  // CrashLoopBackOff, ImagePullBackOff, CreateContainerConfigError. Every container is
  // checked, not just the first — a healthy first container must not hide a crashlooping
  // second one behind a `.find()` that stops at the first truthy match.
  const waitingReasons = statuses.map(cs => cs.state && cs.state.waiting).filter(Boolean);
  const crashWaiting = waitingReasons.find(w => /BackOff|Error|Invalid/.test(w.reason || ''));
  const waiting = crashWaiting || waitingReasons[0];

  const byName = new Map([...statuses, ...initStatuses].map(cs => [cs.name, cs]));
  const usageByContainer = new Map(((usage && usage.containers) || []).map(c => [c.name, c]));

  const containers = [...(spec.containers || []), ...(spec.initContainers || [])].map(c => {
    const cs = byName.get(c.name) || {};
    const u = usageByContainer.get(c.name) || null;
    const req = (c.resources && c.resources.requests) || {};
    const lim = (c.resources && c.resources.limits) || {};
    return {
      name: c.name,
      image: c.image,
      init: (spec.initContainers || []).some(i => i.name === c.name),
      ready: Boolean(cs.ready),
      restarts: cs.restartCount || 0,
      state: Object.keys(cs.state || {})[0] || 'unknown',
      reason: (cs.state && cs.state.waiting && cs.state.waiting.reason)
        || (cs.state && cs.state.terminated && cs.state.terminated.reason)
        || null,
      lastStateReason: (cs.lastState && cs.lastState.terminated && cs.lastState.terminated.reason) || null,
      // Nullish, not `||`: exit code 0 (clean exit) is a real, meaningful value and must
      // not be swallowed as "no exit code" the way `0 || null` would swallow it.
      lastExitCode: (cs.lastState && cs.lastState.terminated && cs.lastState.terminated.exitCode) ?? null,
      // The image actually running, per the kubelet — as opposed to `c.image`, the spec's
      // request, which can differ once a tag resolves to a digest or a rollout is mid-flight.
      runtimeImage: cs.image || null,
      // The digest the kubelet actually pulled, split out of `imageID`
      // (`docker.io/x/y@sha256:…` or a bare `sha256:…`). This is the only field that answers
      // "are these three replicas running the same bits" when the tag is mutable — two pods
      // on `:latest` look identical until you compare digests.
      imageDigest: imageDigest(cs.imageID),
      // Names only, never values: an `env` entry holds a literal in plain text often enough
      // that echoing the values back would turn this dashboard into a credential dump. The
      // keys are what an operator needs to confirm configuration wiring.
      envKeys: ((c.env || []).map(e => e.name).filter(Boolean)).sort(),
      // Where whole blocks of env come from — the ConfigMaps and Secrets this container
      // depends on, which is also half of the "related resources" graph.
      envFrom: (c.envFrom || [])
        .map(e => (e.configMapRef ? { kind: 'ConfigMap', name: e.configMapRef.name }
          : e.secretRef ? { kind: 'Secret', name: e.secretRef.name } : null))
        .filter(Boolean),
      // `Boolean(...)`, because the chain it wraps yields `undefined` rather than `false` for a
      // container that is simply running: `cs.lastState` is absent, so `undefined || (cs.state &&
      // cs.state.terminated && …)` is `undefined`, and `JSON.stringify` **drops the key**. The
      // field was therefore absent from the wire on every healthy container, which reads to a
      // consumer as "this container has no OOM information" rather than "it was not OOMKilled".
      isOOMKilled: Boolean(
        (cs.lastState && cs.lastState.terminated && cs.lastState.terminated.reason === 'OOMKilled')
        || (cs.state && cs.state.terminated && cs.state.terminated.reason === 'OOMKilled')
      ),
      // PRESENCE, not value. The kubelet decides a pod's QoS class on whether a request or
      // limit key EXISTS, so `requests: {cpu: "0"}` is a *set* request that happens to be zero.
      // The parsed numbers below cannot express that: they are numbers, so an absent request
      // and an explicit "0" both arrive as 0. `hasOwnProperty`, never `!!req.cpu` — truthiness
      // is exactly the bug that makes "0" read as unset and turns a Burstable pod into a
      // fabricated BestEffort one.
      qosBasis: {
        cpuRequestSet: Object.prototype.hasOwnProperty.call(req, 'cpu'),
        cpuLimitSet: Object.prototype.hasOwnProperty.call(lim, 'cpu'),
        memoryRequestSet: Object.prototype.hasOwnProperty.call(req, 'memory'),
        memoryLimitSet: Object.prototype.hasOwnProperty.call(lim, 'memory')
      },
      // Init containers participate in the pod's QoS class, so a consumer explaining the class
      // must see which rows are which. `init` above already carries that; this is the narrower
      // distinction — a restartable init container (a sidecar: `restartPolicy: Always` on an
      // init container) runs for the pod's whole life rather than to completion.
      sidecar: c.restartPolicy === 'Always'
        && (spec.initContainers || []).some(i => i.name === c.name),
      cpuRequest: metrics.parseCpu(req.cpu),
      cpuLimit: metrics.parseCpu(lim.cpu),
      memoryRequest: metrics.parseMemory(req.memory),
      memoryLimit: metrics.parseMemory(lim.memory),
      cpuUsage: u ? u.cpu : null,
      memoryUsage: u ? u.memory : null
    };
  });

  const resources = podResources(pod);
  const isOOMKilled = containers.some(c => c.isOOMKilled);

  return {
    name: pod.metadata.name,
    namespace: pod.metadata.namespace,
    phase: status.phase || 'Unknown',
    restarts,
    isOOMKilled,
    reason: (waiting && waiting.reason) || null,
    message: (waiting && waiting.message) || null,
    startedAt: status.startTime || null,

    // Placement. `node` is what the pod landed on; the rest explains why a pending pod
    // has not landed anywhere.
    node: spec.nodeName || null,
    nodeSelector: spec.nodeSelector || null,
    podIP: status.podIP || null,
    qosClass: status.qosClass || null,
    // PodScheduled/Initialized/ContainersReady/Ready — the operator-facing detail behind
    // "why is this pod stuck", one level up from a single container's waiting reason.
    conditions: (status.conditions || []).map(c => ({
      type: c.type,
      status: c.status,
      reason: c.reason || null,
      message: c.message || null
    })),

    containers,
    ...resources,
    cpuUsage: usage ? usage.cpu : null,
    memoryUsage: usage ? usage.memory : null
  };
}

/**
 * @param {{cluster: object, token: string, namespace?: string|string[],
 *          listFn?: typeof list}} ctx `namespace` may name one namespace, several (an array or a
 *   comma-separated string, OR'd together), or none at all for the whole cluster.
 */
async function collect({ cluster, token, namespace, listFn = list }) {
  const namespaces = normaliseNamespaces(namespace);
  /**
   * The namespaces to read, or a single `null` meaning "the whole cluster" — `namespaceSegment`
   * already maps a falsy value to the cluster-wide path, so one loop serves both shapes.
   */
  const scopes = namespaces.length ? namespaces : [null];

  /**
   * Why a namespaced read PER namespace, rather than one cluster-wide read filtered here.
   *
   * The cheap-looking option is to keep the four cluster-wide lists and drop the rows whose
   * namespace was not selected: four API calls regardless of N, against 4N for the fan-out, and
   * those four are the same cache keys (see the list cache in k8s.js) that the rest of the
   * console has usually already warmed. It was rejected for two reasons, in this order.
   *
   *  1. **The paging ceiling.** `k8s.list` stops at MAX_LIST_ITEMS and marks the array
   *     truncated. On a cluster past that ceiling the cluster-wide pod list is a partial one,
   *     and filtering a partial list down to two namespaces cannot tell whether the cut fell
   *     inside them — so the honest answer would have to be "truncated" even when those two
   *     namespaces are complete, and the tempting answer is a confident count that is wrong.
   *     A namespaced read of the selected namespaces on the same cluster is a complete read and
   *     reports itself as one. This is a correctness argument, not a performance one, which is
   *     why it outranks the second.
   *  2. **Bytes.** The cluster-wide pod list measured 3.5 MB on platformsbx (see the
   *     Accept-Encoding note in k8s.js) and is transferred in full to serve any selection at
   *     all. A namespace holds a fraction of it.
   *
   * A `fieldSelector` cannot collapse the fan-out back into one call, which is the obvious
   * third option: `metadata.namespace` IS selectable on every resource type, but field
   * selectors only support `=`, `==` and `!=` — there is no set membership — so "namespace in
   * (a, b)" is still one request per namespace, and a namespaced path is the better-indexed way
   * to write the same request.
   *
   * The fan-out is 4N reads, and N is capped at MAX_NAMESPACE_SELECTION for exactly that
   * reason. They are not 4N uncoordinated calls: every one goes through `call`'s per-cluster
   * gate, so no more than MAX_IN_FLIGHT_PER_CLUSTER are ever in flight against one apiserver
   * and the rest queue. `Promise.all` over `safeList` is how the other multi-read collectors
   * here express the same thing (`security.js` fans out twelve ways on the same gate).
   */
  const baseCtx = { cluster, token };
  /**
   * The operator-facing label for one read, suffixed with its namespace only when there is
   * more than one scope. Unsuffixed for the cluster-wide and single-namespace cases so those
   * payloads stay byte-identical to what every existing consumer of `unavailable` already
   * matches on; suffixed for a set, because "a read failed" is a different fact from "the read
   * for namespace kyma-system failed" and the operator can only act on the second.
   */
  const labelFor = (base, ns) => (scopes.length > 1 ? `${base}[ns=${ns}]` : base);

  const [scopeResults, usage] = await Promise.all([
    Promise.all(scopes.map(ns => {
      const nsQuery = namespaceSegment(ns);
      return Promise.all([
        safeList(listFn, baseCtx, `/apis/apps/v1/${nsQuery}deployments`, labelFor('deployments', ns)),
        safeList(listFn, baseCtx, `/apis/apps/v1/${nsQuery}statefulsets`, labelFor('statefulsets', ns)),
        safeList(listFn, baseCtx, `/apis/apps/v1/${nsQuery}daemonsets`, labelFor('daemonsets', ns)),
        safeList(listFn, baseCtx, `/api/v1/${nsQuery}pods?limit=2000`, labelFor('pods', ns))
      ]);
    })),
    // ONE metrics read for the whole selection, namespace-scoped only when a single namespace
    // was asked for. `podUsage` answers with a single {available, reason} verdict and N
    // per-namespace verdicts have no honest merge: "available" with one namespace's usage
    // missing would render that namespace's cells as 0, and "unavailable" would blank the
    // N-1 namespaces whose usage did arrive. The map it returns is keyed `namespace/name`, so
    // a cluster-wide read costs one request and the unselected entries are simply never
    // looked up. Usage is optional data — a cluster without metrics-server already renders
    // these cells as unavailable — so a wider read here cannot turn into a wrong number.
    metrics.podUsage({ cluster, token, namespace: namespaces.length === 1 ? namespaces[0] : undefined, listFn })
  ]);

  /**
   * Every read across every scope, flat, so `unavailableLabels`/`truncatedLabels` see the whole
   * fan-out. One namespace's 403 must land in `summary.unavailable` and not merely as fewer
   * rows: fewer rows is indistinguishable from "that namespace is empty", which is the same
   * silent lie the safe-list module exists to prevent, arriving one level up.
   */
  const results = scopeResults.flat();
  const deployments = scopeResults.flatMap(r => r[0].items);
  const statefulSets = scopeResults.flatMap(r => r[1].items);
  const daemonSets = scopeResults.flatMap(r => r[2].items);
  const pods = scopeResults.flatMap(r => r[3].items);

  const build = (obj, kind) => {
    const ns = obj.metadata.namespace;
    const owned = podsForSelector(pods, ns, obj.spec && obj.spec.selector)
      .map(p => podSummary(p, usage.pods[`${ns}/${p.metadata.name}`]));
    const restarts = owned.reduce((n, p) => n + p.restarts, 0);
    const r = readiness(obj, kind);

    /**
     * A Deployment's state must be a Deployment state.
     *
     * This used to substitute the crashing container's *waiting reason* for the controller's
     * own state — `state = crashing.reason` — so the cell read `CrashLoopBackOff` for a
     * Deployment. No Deployment ever reports that string: it is a container-level reason from
     * one of N pods, printed in the slot reserved for `Ready`/`Progressing`/`Unavailable`,
     * naming neither the pod it came from nor the container inside it.
     *
     * The diagnosis is not lost, it is moved to where it can be attributed. `podIssues`
     * reports each distinct waiting reason with the pods and containers that carry it, which
     * is what lets a row render `Progressing — 2 pods CrashLoopBackOff (ns/pod, container)`.
     */
    const state = r.state;
    const CRASH_REASON = /BackOff|Error|Invalid/;
    const issuesByReason = new Map();
    for (const p of owned) {
      // Per container, not per pod: a pod's single `reason` field already collapsed a
      // multi-container failure to one string, and the container name is half the answer.
      for (const c of p.containers) {
        if (!c.reason || !CRASH_REASON.test(c.reason)) continue;
        if (!issuesByReason.has(c.reason)) issuesByReason.set(c.reason, []);
        issuesByReason.get(c.reason).push({ namespace: p.namespace, pod: p.name, container: c.name });
      }
    }
    const podIssues = [...issuesByReason.entries()]
      .map(([reason, containers]) => ({
        reason,
        // Pods, not container instances: two crashing containers in one pod is one broken pod.
        pods: new Set(containers.map(c => `${c.namespace}/${c.pod}`)).size,
        containers
      }))
      .sort((a, b) => b.pods - a.pods || a.reason.localeCompare(b.reason));

    const sum = key => owned.reduce((n, p) => n + (p[key] || 0), 0);

    return {
      name: obj.metadata.name,
      namespace: ns,
      cluster: cluster.id,
      kind,
      ready: r.ready,
      desired: r.desired,
      state,
      /**
       * The container-level diagnosis, attributed. One entry per distinct waiting reason:
       * `{reason, pods, containers: [{namespace, pod, container}]}`. Empty array means no
       * pod of this workload reports a back-off/error waiting reason — not that the
       * workload is healthy (`state` says that).
       */
      podIssues,
      healthy: r.state === 'Ready',
      image: primaryImage(obj),
      restarts,
      createdAt: obj.metadata.creationTimestamp,

      // Where this workload's pods actually are. One entry per node, so a workload pinned
      // to a single node — or spread across five — is visible without opening the pods.
      nodes: [...new Set(owned.map(p => p.node).filter(Boolean))].sort(),

      // The rollout the dashboard's restart button drives. `restartedAt` is the annotation
      // kubectl rollout restart writes, so a restart triggered here and one triggered from
      // a terminal are indistinguishable, as they should be.
      restartedAt: (((obj.spec.template || {}).metadata || {}).annotations || {})['kubectl.kubernetes.io/restartedAt'] || null,
      updatedReplicas: (obj.status && obj.status.updatedReplicas) || 0,
      availableReplicas: (obj.status && obj.status.availableReplicas) || 0,
      generation: obj.metadata.generation || null,
      observedGeneration: (obj.status && obj.status.observedGeneration) || null,
      // Only a Deployment can be rollout-restarted through this dashboard; a DaemonSet is
      // shown for completeness but restarting one is a node-level event, not an app one.
      restartable: kind === 'Deployment' || kind === 'StatefulSet',

      cpuRequest: sum('cpuRequest'),
      cpuLimit: sum('cpuLimit'),
      memoryRequest: sum('memoryRequest'),
      memoryLimit: sum('memoryLimit'),
      cpuUsage: usage.available ? sum('cpuUsage') : null,
      memoryUsage: usage.available ? sum('memoryUsage') : null,

      pods: owned
    };
  };

  const items = [
    ...deployments.map(d => build(d, 'Deployment')),
    ...statefulSets.map(s => build(s, 'StatefulSet')),
    ...daemonSets.map(s => build(s, 'DaemonSet'))
  ].sort((a, b) =>
    // Unhealthy first — that is what the page is for — then alphabetical.
    (a.healthy === b.healthy)
      ? (a.namespace + a.name).localeCompare(b.namespace + b.name)
      : (a.healthy ? 1 : -1)
  );

  return {
    summary: {
      total: items.length,
      notReady: items.filter(w => !w.healthy).length,
      restarts: items.reduce((n, w) => n + w.restarts, 0),
      pods: pods.length,
      cpuUsage: usage.available ? items.reduce((n, w) => n + (w.cpuUsage || 0), 0) : null,
      memoryUsage: usage.available ? items.reduce((n, w) => n + (w.memoryUsage || 0), 0) : null,
      cpuRequest: items.reduce((n, w) => n + w.cpuRequest, 0),
      memoryRequest: items.reduce((n, w) => n + w.memoryRequest, 0),
      // A 403/timeout on any of the four reads means every count above is a floor, not a
      // total — this collector had none of this before, unlike its siblings. Across a
      // namespace set the same holds per namespace: one namespace that could not be read
      // leaves its workloads out of every number here, and the label naming it is the only
      // thing standing between the operator and a total that looks complete.
      unavailable: unavailableLabels(results),
      truncated: truncatedLabels(results)
    },
    metrics: { available: usage.available, reason: usage.reason || null },
    items
  };
}

/**
 * The dependency graph around ONE workload: what routes traffic to it, what it is built from,
 * and what configuration it reads.
 *
 * Deliberately a separate, lazily-called collector rather than extra fields on `collect()`.
 * `collect()` runs on every cluster in the fleet sweep and on a 60s poll; folding six more
 * list calls into it would multiply the cost of the *overview* to serve a panel that is only
 * on screen when somebody has clicked a single row. This runs once per click, scoped to one
 * namespace, and every read degrades independently: no Istio means no VirtualServices, which
 * is a true zero and not an error.
 *
 * @param {{cluster: object, token: string, namespace: string, kind: string, name: string,
 *          listFn?: typeof list}} ctx
 */
async function graph({ cluster, token, namespace, kind, name, listFn = list }) {
  const ctx = { cluster, token };
  const nsQuery = namespaceSegment(namespace);
  const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[kind];
  if (!plural) {
    const err = new Error(`unsupported workload kind '${kind}'`);
    err.status = 400;
    throw err;
  }

  const [ownerResult, replicaSetsResult, podsResult, servicesResult, hpasResult, ingressesResult, apirulesResult] =
    await Promise.all([
      // Listed and filtered rather than fetched by name: `list` is the verb this dashboard's
      // role is guaranteed, and one namespace's workloads is a small read either way.
      safeList(listFn, ctx, `/apis/apps/v1/${nsQuery}${plural}`, kind.toLowerCase()),
      safeList(listFn, ctx, `/apis/apps/v1/${nsQuery}replicasets`, 'replicasets'),
      safeList(listFn, ctx, `/api/v1/${nsQuery}pods?limit=2000`, 'pods'),
      safeList(listFn, ctx, `/api/v1/${nsQuery}services`, 'services'),
      safeList(listFn, ctx, `/apis/autoscaling/v2/${nsQuery}horizontalpodautoscalers`, 'hpa'),
      safeList(listFn, ctx, `/apis/networking.k8s.io/v1/${nsQuery}ingresses`, 'ingresses'),
      safeList(listFn, ctx, `/apis/gateway.kyma-project.io/v2/${nsQuery}apirules`, 'apirules')
    ]);

  const owner = ownerResult.items.find(o => o.metadata && o.metadata.name === name) || null;
  if (!owner) {
    // A typed NOT_FOUND, not a bare Error: `fanout.failed()` flattens anything that is not a
    // ClusterError to UPSTREAM, which would report a deleted Deployment as a broken cluster.
    throw new ClusterError(NOT_FOUND,
      `${kind} '${name}' not found in namespace '${namespace}'`,
      { cluster: cluster.id, status: 404 });
  }

  const selector = owner.spec && owner.spec.selector;
  const ownerReadiness = readiness(owner, kind);
  const template = (owner.spec && owner.spec.template) || {};
  const templateLabels = (template.metadata && template.metadata.labels) || {};
  const podSpec = template.spec || {};
  const pods = podsForSelector(podsResult.items, namespace, selector);
  const podNames = new Set(pods.map(p => p.metadata.name));

  // ReplicaSets by ownerReference, not by label: a rolled-back Deployment keeps several
  // ReplicaSets whose pod-template labels are identical, and only the ownerRef distinguishes
  // "belongs to this Deployment" from "belongs to that one".
  const replicaSets = replicaSetsResult.items
    .filter(rs => (rs.metadata.ownerReferences || []).some(o => o.kind === kind && o.name === name))
    .map(rs => ({
      name: rs.metadata.name,
      revision: (rs.metadata.annotations || {})['deployment.kubernetes.io/revision'] || null,
      desired: (rs.spec && rs.spec.replicas) || 0,
      ready: (rs.status && rs.status.readyReplicas) || 0,
      current: (rs.status && rs.status.replicas) || 0,
      createdAt: rs.metadata.creationTimestamp,
      /** The one the rollout has settled on — the others are history kept for rollback. */
      active: ((rs.spec && rs.spec.replicas) || 0) > 0
    }))
    .sort((a, b) => Number(b.revision || 0) - Number(a.revision || 0));

  // A Service selects pods, not workloads, so the honest test is "does this Service's
  // selector match the pod template we are about to run". A selector-less Service (manual
  // Endpoints) matches nothing here, which is correct — it is not wired to this workload.
  const services = servicesResult.items
    .filter(svc => {
      const sel = svc.spec && svc.spec.selector;
      if (!sel || Object.keys(sel).length === 0) return false;
      return Object.entries(sel).every(([k, v]) => templateLabels[k] === v);
    })
    .map(svc => ({
      name: svc.metadata.name,
      type: (svc.spec && svc.spec.type) || 'ClusterIP',
      clusterIP: (svc.spec && svc.spec.clusterIP) || null,
      ports: ((svc.spec && svc.spec.ports) || []).map(p => ({
        name: p.name || null, port: p.port, targetPort: p.targetPort ?? null, protocol: p.protocol || 'TCP'
      }))
    }));

  const serviceNames = new Set(services.map(s => s.name));

  const hpas = hpasResult.items
    .filter(h => {
      const t = (h.spec && h.spec.scaleTargetRef) || {};
      return t.kind === kind && t.name === name;
    })
    .map(h => ({
      name: h.metadata.name,
      min: (h.spec && h.spec.minReplicas) ?? null,
      max: (h.spec && h.spec.maxReplicas) ?? null,
      current: (h.status && h.status.currentReplicas) ?? null,
      desired: (h.status && h.status.desiredReplicas) ?? null
    }));

  // The ingress edge, from either direction Kyma offers. Both are matched by the Service
  // they point at, which is the only link that actually exists in the spec.
  const ingresses = ingressesResult.items
    .filter(ing => ((ing.spec && ing.spec.rules) || []).some(rule =>
      (((rule.http || {}).paths) || []).some(p =>
        serviceNames.has(((p.backend || {}).service || {}).name))))
    .map(ing => ({
      kind: 'Ingress',
      name: ing.metadata.name,
      hosts: [...new Set(((ing.spec && ing.spec.rules) || []).map(r => r.host).filter(Boolean))]
    }));

  const apirules = apirulesResult.items
    .filter(r => serviceNames.has((((r.spec || {}).service) || {}).name))
    .map(r => ({
      kind: 'APIRule',
      name: r.metadata.name,
      hosts: (((r.spec || {}).hosts) || []).map(String),
      state: ((r.status || {}).state) || null
    }));

  // Configuration this workload reads, gathered from the pod template only — the declared
  // truth, which stays right even when zero pods are running.
  const configRefs = new Map();
  const addRef = (kindName, refName, via) => {
    if (!refName) return;
    const key = `${kindName}/${refName}`;
    const entry = configRefs.get(key) || { kind: kindName, name: refName, via: new Set() };
    entry.via.add(via);
    configRefs.set(key, entry);
  };
  for (const c of [...(podSpec.containers || []), ...(podSpec.initContainers || [])]) {
    for (const e of c.envFrom || []) {
      if (e.configMapRef) addRef('ConfigMap', e.configMapRef.name, 'envFrom');
      if (e.secretRef) addRef('Secret', e.secretRef.name, 'envFrom');
    }
    for (const e of c.env || []) {
      const from = e.valueFrom || {};
      if (from.configMapKeyRef) addRef('ConfigMap', from.configMapKeyRef.name, 'env');
      if (from.secretKeyRef) addRef('Secret', from.secretKeyRef.name, 'env');
    }
  }
  for (const v of podSpec.volumes || []) {
    if (v.configMap) addRef('ConfigMap', v.configMap.name, 'volume');
    if (v.secret) addRef('Secret', v.secret.secretName, 'volume');
    if (v.persistentVolumeClaim) addRef('PersistentVolumeClaim', v.persistentVolumeClaim.claimName, 'volume');
    for (const p of (v.projected && v.projected.sources) || []) {
      if (p.configMap) addRef('ConfigMap', p.configMap.name, 'projected volume');
      if (p.secret) addRef('Secret', p.secret.name, 'projected volume');
    }
  }
  for (const s of podSpec.imagePullSecrets || []) addRef('Secret', s.name, 'imagePullSecret');
  if (podSpec.serviceAccountName) addRef('ServiceAccount', podSpec.serviceAccountName, 'pod spec');

  const results = [ownerResult, replicaSetsResult, podsResult, servicesResult, hpasResult, ingressesResult, apirulesResult];

  return {
    workload: { kind, name, namespace, cluster: cluster.id },
    /**
     * The traffic path, ingress-first, as a list of stages the UI renders left to right.
     * A stage with an empty `items` is drawn greyed rather than omitted: "no Service points
     * at this Deployment" is a finding, and a diagram that silently skips the stage hides it.
     */
    flow: [
      { stage: 'ingress', label: 'APIRule / Ingress', items: [...apirules, ...ingresses] },
      { stage: 'service', label: 'Service', items: services.map(s => ({ kind: 'Service', name: s.name, detail: s.type })) },
      /**
       * Ready/desired comes from `readiness()`, never from the raw replica fields: a DaemonSet has
       * neither `spec.replicas` nor `status.readyReplicas`, so reading them renders a healthy
       * DaemonSet as "0/N ready". See the note on `readiness()` above.
       */
      { stage: 'workload', label: kind, items: [{ kind, name, detail: `${ownerReadiness.ready}/${ownerReadiness.desired} ready` }] },
      ...(kind === 'Deployment'
        ? [{ stage: 'replicaset', label: 'ReplicaSet', items: replicaSets.filter(r => r.active).map(r => ({ kind: 'ReplicaSet', name: r.name, detail: `rev ${r.revision ?? '—'}` })) }]
        : []),
      { stage: 'pods', label: 'Pods', items: [...podNames].sort().map(n => ({ kind: 'Pod', name: n, detail: null })) }
    ],
    services,
    hpas,
    replicaSets,
    ingress: [...apirules, ...ingresses],
    config: [...configRefs.values()]
      .map(r => ({ kind: r.kind, name: r.name, via: [...r.via].sort() }))
      .sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name)),
    /**
     * Container specs off the pod template, plus the digests the running pods resolved to.
     * A tag is a promise; the digest set is what is actually running, so more than one digest
     * behind a single tag means the replicas have drifted apart.
     */
    containers: [...(podSpec.containers || []), ...(podSpec.initContainers || [])].map(c => {
      const digests = new Set();
      for (const p of pods) {
        for (const cs of [...((p.status || {}).containerStatuses || []), ...((p.status || {}).initContainerStatuses || [])]) {
          if (cs.name !== c.name) continue;
          const d = imageDigest(cs.imageID);
          if (d) digests.add(d);
        }
      }
      const req = (c.resources && c.resources.requests) || {};
      const lim = (c.resources && c.resources.limits) || {};
      return {
        name: c.name,
        init: (podSpec.initContainers || []).some(i => i.name === c.name),
        image: c.image || null,
        imageTag: imageTag(c.image),
        digests: [...digests].sort(),
        cpuRequest: metrics.parseCpu(req.cpu),
        cpuLimit: metrics.parseCpu(lim.cpu),
        memoryRequest: metrics.parseMemory(req.memory),
        memoryLimit: metrics.parseMemory(lim.memory),
        /** Keys only. See the note in `podSummary` on why the values never leave the cluster. */
        envKeys: ((c.env || []).map(e => e.name).filter(Boolean)).sort(),
        envFromCount: (c.envFrom || []).length,
        ports: (c.ports || []).map(p => ({ name: p.name || null, containerPort: p.containerPort, protocol: p.protocol || 'TCP' })),
        probes: {
          liveness: Boolean(c.livenessProbe),
          readiness: Boolean(c.readinessProbe),
          startup: Boolean(c.startupProbe)
        }
      };
    }),
    summary: {
      unavailable: unavailableLabels(results),
      truncated: truncatedLabels(results)
    }
  };
}

/**
 * Recent Warning events, newest first.
 *
 * Returns an ENVELOPE, not a bare array. Two reasons, both correctness:
 *
 *   - the read went through `listFn` directly, so a 403 on events threw — and this collector
 *     runs inside `/overview`'s `Promise.all`, where one throw fails health, compliance and
 *     workloads along with it. `requiredList` degrades it instead: events is a resource that
 *     always exists, so a 404 here is a red flag rather than an honest zero.
 *   - a bare array cannot carry `unavailable`/`truncated` over JSON (only indices survive
 *     `JSON.stringify`), so the UI's `unavailableEntries(d.events)` could never fire and the
 *     Events section's unavailable branch was unreachable by construction.
 *
 * `count` is the number of Event objects read (which is also the page size, so a full page is
 * a floor); `occurrences` sums each event's own count, because two rows at ×200 are 400
 * occurrences and 2 objects.
 */
async function events({ cluster, token, namespace, limit = 50, listFn = list }) {
  const nsQuery = namespaceSegment(namespace);
  const result = await requiredList('events', () => listFn({
    cluster, token,
    path: `/api/v1/${nsQuery}events?fieldSelector=type%3DWarning&limit=${limit}`
  }));

  const stamp = e => e.lastTimestamp || e.eventTime || (e.series && e.series.lastObservedTime) || e.firstTimestamp;

  const items = result.items
    .map(e => ({
      namespace: e.metadata.namespace,
      cluster: cluster.id,
      reason: e.reason,
      message: e.message,
      count: e.count || (e.series && e.series.count) || 1,
      object: e.involvedObject ? `${e.involvedObject.kind}/${e.involvedObject.name}` : null,
      at: stamp(e)
    }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  return {
    items,
    count: items.length,
    occurrences: items.reduce((n, e) => n + (e.count || 0), 0),
    // A full page means there may be more warnings than were read: the count is a floor,
    // which is exactly what `truncated` means everywhere else in this codebase.
    atLimit: items.length >= limit,
    limit,
    unavailable: unavailableLabels([result]),
    truncated: [...new Set([...truncatedLabels([result]), ...(items.length >= limit ? ['events'] : [])])]
  };
}

export default { collect, graph, events, readiness, primaryImage, podSummary, podsForSelector, podResources, imageDigest, imageTag };
