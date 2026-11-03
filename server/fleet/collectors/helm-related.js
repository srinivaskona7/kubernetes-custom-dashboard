/**
 * One Helm release, joined to what is actually running.
 *
 * `helm.js` answers "what did Helm store" — the chart, the values, the rendered manifest, and a
 * ready/desired join for the three workload kinds that report one. This file answers the other
 * half: **what is on the cluster right now that belongs to this release, and by what evidence**.
 *
 * The evidence question is the whole design. A release view that lists every object whose name
 * starts with the release name is wrong in both directions — it claims a `redis-master` Service
 * installed by a different chart, and it misses the ReplicaSet Helm never rendered. So nothing
 * here is matched by name similarity. Every row carries the relationship that put it there and
 * the exact field that proves it:
 *
 *   helm-owned              `meta.helm.sh/release-name` + `-namespace` annotations match
 *   helm-managed            present in the rendered manifest, without those annotations
 *   owner-reference         `ownerReferences` chains up to something already accepted
 *   selector                a selector on this object matches something already accepted
 *   configuration-reference an accepted pod template names this ConfigMap/Secret/PVC/SA
 *   runtime                 a live spec field points at something accepted (scaleTargetRef,
 *                           an Ingress backend, a VirtualService destination, a TLS secret)
 *
 * The passes run in that order and never downgrade a row, so the strongest available evidence
 * is the one reported.
 *
 * Cost: this is ~20 namespace-scoped lists for ONE release, run only when a release page is
 * open — the same trade `workloads.graph()` makes for one workload. It is deliberately not part
 * of `helm.collect()`, which runs on the fleet sweep. Every read degrades on its own: no Istio
 * means no VirtualServices, which is a true zero and not an error.
 *
 * Secret VALUES never appear here. A Secret row carries its type and its key names, which is
 * the same contract every other Secret read in server/fleet honours.
 */
import k8sModule from '../k8s.js';
const { list, namespaceSegment } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;
import errorsModule from '../errors.js';
const { ClusterError, NOT_FOUND } = errorsModule;
import workloads from './workloads.js';
import policy from './policy.js';
import helm from './helm.js';

const HELM_SECRET_TYPE = 'helm.sh/release.v1';

/** How many events to pull for the release's namespace. Events are the noisiest read here. */
const MAX_EVENTS = 500;

/**
 * The live reads, in the order they are declared on screen.
 *
 * `group` is the section heading in the Resources tab, and it is data rather than a UI lookup so
 * that adding a Kind here is one edit instead of two. `optional: true` marks a CRD that is
 * simply absent on a plain cluster — `safeList` already turns its 404 into a true zero, this
 * flag only keeps the intent readable.
 */
const LIVE_KINDS = [
  { kind: 'Deployment', group: 'Workloads', path: ns => `/apis/apps/v1/${ns}deployments`, label: 'deployments' },
  { kind: 'StatefulSet', group: 'Workloads', path: ns => `/apis/apps/v1/${ns}statefulsets`, label: 'statefulsets' },
  { kind: 'DaemonSet', group: 'Workloads', path: ns => `/apis/apps/v1/${ns}daemonsets`, label: 'daemonsets' },
  { kind: 'ReplicaSet', group: 'Workloads', path: ns => `/apis/apps/v1/${ns}replicasets`, label: 'replicasets' },
  { kind: 'Job', group: 'Workloads', path: ns => `/apis/batch/v1/${ns}jobs`, label: 'jobs' },
  { kind: 'CronJob', group: 'Workloads', path: ns => `/apis/batch/v1/${ns}cronjobs`, label: 'cronjobs' },
  { kind: 'Pod', group: 'Pods', path: ns => `/api/v1/${ns}pods?limit=2000`, label: 'pods' },
  { kind: 'Service', group: 'Networking', path: ns => `/api/v1/${ns}services`, label: 'services' },
  { kind: 'EndpointSlice', group: 'Networking', path: ns => `/apis/discovery.k8s.io/v1/${ns}endpointslices`, label: 'endpointslices' },
  { kind: 'Ingress', group: 'Networking', path: ns => `/apis/networking.k8s.io/v1/${ns}ingresses`, label: 'ingresses' },
  { kind: 'APIRule', group: 'Networking', path: ns => `/apis/gateway.kyma-project.io/v2/${ns}apirules`, label: 'apirules', optional: true },
  { kind: 'VirtualService', group: 'Networking', path: ns => `/apis/networking.istio.io/v1beta1/${ns}virtualservices`, label: 'virtualservices', optional: true },
  { kind: 'Gateway', group: 'Networking', path: ns => `/apis/networking.istio.io/v1beta1/${ns}gateways`, label: 'istio-gateways', optional: true },
  { kind: 'HorizontalPodAutoscaler', group: 'Scaling', path: ns => `/apis/autoscaling/v2/${ns}horizontalpodautoscalers`, label: 'hpa' },
  { kind: 'PersistentVolumeClaim', group: 'Storage', path: ns => `/api/v1/${ns}persistentvolumeclaims`, label: 'pvcs' },
  { kind: 'ConfigMap', group: 'Configuration', path: ns => `/api/v1/${ns}configmaps`, label: 'configmaps' },
  { kind: 'Secret', group: 'Configuration', path: ns => `/api/v1/${ns}secrets`, label: 'secrets' },
  { kind: 'ServiceAccount', group: 'Security and Policy', path: ns => `/api/v1/${ns}serviceaccounts`, label: 'serviceaccounts' },
  { kind: 'PodDisruptionBudget', group: 'Security and Policy', path: ns => `/apis/policy/v1/${ns}poddisruptionbudgets`, label: 'pdbs' },
  { kind: 'NetworkPolicy', group: 'Security and Policy', path: ns => `/apis/networking.k8s.io/v1/${ns}networkpolicies`, label: 'networkpolicies' },
  { kind: 'AuthorizationPolicy', group: 'Security and Policy', path: ns => `/apis/security.istio.io/v1/${ns}authorizationpolicies`, label: 'authorizationpolicies', optional: true },
  { kind: 'Certificate', group: 'Certificates', path: ns => `/apis/cert.gardener.cloud/v1alpha1/${ns}certificates`, label: 'gardener certificates', optional: true },
  { kind: 'Certificate', group: 'Certificates', path: ns => `/apis/cert-manager.io/v1/${ns}certificates`, label: 'cert-manager certificates', optional: true }
];

const key = (kind, namespace, name) => `${kind}/${namespace || '-'}/${name}`;

function labelsOf(obj) {
  return (obj.metadata && obj.metadata.labels) || {};
}

function annotationsOf(obj) {
  return (obj.metadata && obj.metadata.annotations) || {};
}

/** The pod template's labels — what a Service, PDB or NetworkPolicy selector is written against. */
function templateLabels(obj) {
  const t = (obj.spec && obj.spec.template) || {};
  return (t.metadata && t.metadata.labels) || {};
}

function podSpecOf(obj) {
  if (obj.kind === 'Pod' || (obj.spec && obj.spec.containers)) return obj.spec || {};
  const t = (obj.spec && obj.spec.template) || {};
  // A CronJob nests one level deeper: spec.jobTemplate.spec.template.spec.
  if (obj.spec && obj.spec.jobTemplate) {
    const jt = obj.spec.jobTemplate.spec || {};
    return ((jt.template || {}).spec) || {};
  }
  return t.spec || {};
}

/**
 * Native status per Kind — declared, never derived.
 *
 * Of the twenty-two Kinds above, most have no Ready condition at all: a ConfigMap, a Secret, a
 * ServiceAccount, a NetworkPolicy and an Istio VirtualService either exist or do not. Those
 * return `null`, which the UI renders as a dash. Inventing "Healthy" for them would put a green
 * tick beside an object nothing has ever checked.
 */
function statusOf(kind, obj, ctx) {
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet': {
      const r = workloads.readiness(obj, kind);
      return { text: `${r.ready}/${r.desired} ${r.state}`, tone: toneForReadiness(r), ready: r.ready, desired: r.desired };
    }
    case 'ReplicaSet': {
      const desired = (obj.spec && obj.spec.replicas) || 0;
      const ready = (obj.status && obj.status.readyReplicas) || 0;
      if (desired === 0) return { text: 'Scaled down', tone: 'unknown', ready, desired };
      return { text: `${ready}/${desired} Ready`, tone: ready >= desired ? 'ok' : ready === 0 ? 'bad' : 'warn', ready, desired };
    }
    case 'Pod':
      return podStatus(obj);
    case 'Job': {
      const s = obj.status || {};
      if (s.succeeded) return { text: 'Complete', tone: 'ok' };
      if (s.failed) return { text: `Failed (${s.failed})`, tone: 'bad' };
      if (s.active) return { text: `Running (${s.active})`, tone: 'warn' };
      return { text: 'Pending', tone: 'warn' };
    }
    case 'CronJob': {
      if (obj.spec && obj.spec.suspend) return { text: 'Suspended', tone: 'unknown' };
      const active = ((obj.status || {}).active || []).length;
      return { text: active > 0 ? `Active (${active})` : 'Scheduled', tone: 'ok' };
    }
    case 'Service': {
      const sel = (obj.spec && obj.spec.selector) || null;
      const ready = ctx.readyEndpointsByService.get(obj.metadata.name);
      if (!sel || Object.keys(sel).length === 0) return { text: 'No selector', tone: 'unknown' };
      // `undefined` means the EndpointSlice read did not happen, which is not zero endpoints.
      if (ready === undefined) return { text: 'Endpoints unread', tone: 'unknown' };
      return { text: ready > 0 ? `${ready} ready endpoint${ready === 1 ? '' : 's'}` : 'No ready endpoints', tone: ready > 0 ? 'ok' : 'bad', readyEndpoints: ready };
    }
    case 'EndpointSlice': {
      const ready = readyEndpointCount(obj);
      const total = (obj.endpoints || []).length;
      return { text: `${ready}/${total} ready`, tone: ready > 0 ? 'ok' : 'bad', readyEndpoints: ready };
    }
    case 'Ingress': {
      const addrs = (((obj.status || {}).loadBalancer || {}).ingress) || [];
      return addrs.length > 0 ? { text: 'Address assigned', tone: 'ok' } : { text: 'No address', tone: 'warn' };
    }
    case 'APIRule': {
      const state = (obj.status || {}).state || null;
      if (!state) return { text: 'No status', tone: 'unknown' };
      return { text: state, tone: state === 'Ready' ? 'ok' : state === 'Warning' ? 'warn' : 'bad' };
    }
    case 'HorizontalPodAutoscaler': {
      const spec = obj.spec || {};
      const s = obj.status || {};
      const current = s.currentReplicas ?? null;
      const max = spec.maxReplicas ?? null;
      const atMax = current !== null && max !== null && current >= max;
      const able = ((s.conditions || []).find(c => c.type === 'ScalingActive') || {}).status;
      if (able === 'False') return { text: 'Not scaling', tone: 'warn', current, max };
      return {
        text: current === null ? 'No status' : `${current}/${max ?? '?'} replicas`,
        tone: current === null ? 'unknown' : atMax ? 'warn' : 'ok',
        current, max, atMax
      };
    }
    case 'PersistentVolumeClaim': {
      const phase = (obj.status || {}).phase || null;
      if (!phase) return { text: 'No status', tone: 'unknown' };
      return { text: phase, tone: phase === 'Bound' ? 'ok' : phase === 'Pending' ? 'warn' : 'bad' };
    }
    case 'PersistentVolume': {
      const phase = (obj.status || {}).phase || null;
      return phase ? { text: phase, tone: phase === 'Bound' ? 'ok' : 'warn' } : { text: 'No status', tone: 'unknown' };
    }
    case 'PodDisruptionBudget': {
      const s = obj.status || {};
      const allowed = s.disruptionsAllowed ?? null;
      if (allowed === null) return { text: 'No status', tone: 'unknown' };
      return {
        text: allowed > 0 ? `${s.currentHealthy ?? '?'} healthy` : 'Blocking disruption',
        tone: allowed > 0 ? 'ok' : 'warn',
        disruptionsAllowed: allowed
      };
    }
    case 'Certificate': {
      // Gardener writes `status.state`; cert-manager writes a Ready condition. Both are read
      // rather than one being assumed, because a Kyma cluster can have either.
      const s = obj.status || {};
      if (s.state) return { text: s.state, tone: s.state === 'Ready' ? 'ok' : s.state === 'Pending' ? 'warn' : 'bad' };
      const ready = ((s.conditions || []).find(c => c.type === 'Ready') || {}).status;
      if (ready === 'True') return { text: 'Ready', tone: 'ok' };
      if (ready === 'False') return { text: 'Not ready', tone: 'bad' };
      return { text: 'No status', tone: 'unknown' };
    }
    default:
      return null;
  }
}

function toneForReadiness(r) {
  if (r.state === 'Ready') return 'ok';
  if (r.state === 'Scaled to zero') return 'unknown';
  return r.ready === 0 ? 'bad' : 'warn';
}

/**
 * A pod's state as an operator reads it — the waiting reason wins over the phase.
 *
 * `phase: Running` with a container in `CrashLoopBackOff` is the single most important state
 * this whole view can show, and the phase alone hides it.
 */
function podStatus(pod) {
  const s = pod.status || {};
  const statuses = [...(s.containerStatuses || []), ...(s.initContainerStatuses || [])];
  const waiting = statuses.map(c => (c.state && c.state.waiting && c.state.waiting.reason) || null).filter(Boolean);
  const bad = waiting.find(r => /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|Error/.test(r));
  if (bad) return { text: bad, tone: 'bad', crashing: /CrashLoop/.test(bad) };
  if (s.phase === 'Succeeded') return { text: 'Succeeded', tone: 'ok' };
  if (s.phase === 'Failed') return { text: 'Failed', tone: 'bad' };
  const ready = statuses.filter(c => c.ready).length;
  const total = (pod.spec && (pod.spec.containers || []).length) || statuses.length;
  const allReady = ((s.conditions || []).find(c => c.type === 'Ready') || {}).status === 'True';
  if (s.phase === 'Running' && allReady) return { text: 'Running', tone: 'ok', ready, total };
  if (s.phase === 'Running') return { text: `Not ready (${ready}/${total})`, tone: 'warn', ready, total, notReady: true };
  return { text: s.phase || 'Unknown', tone: s.phase ? 'warn' : 'unknown', ready, total };
}

function readyEndpointCount(slice) {
  let n = 0;
  for (const ep of slice.endpoints || []) {
    const cond = ep.conditions || {};
    // An absent `ready` means ready, per the discovery.k8s.io API contract.
    if (cond.ready === undefined || cond.ready === true) n += (ep.addresses || []).length || 1;
  }
  return n;
}

/** Every ConfigMap/Secret/PVC/ServiceAccount an accepted pod template names, and how. */
function configReferences(obj) {
  const spec = podSpecOf(obj);
  const refs = [];
  const add = (kind, name, via) => { if (name) refs.push({ kind, name, via }); };
  for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
    for (const e of c.envFrom || []) {
      if (e.configMapRef) add('ConfigMap', e.configMapRef.name, 'envFrom');
      if (e.secretRef) add('Secret', e.secretRef.name, 'envFrom');
    }
    for (const e of c.env || []) {
      const from = e.valueFrom || {};
      if (from.configMapKeyRef) add('ConfigMap', from.configMapKeyRef.name, 'env');
      if (from.secretKeyRef) add('Secret', from.secretKeyRef.name, 'env');
    }
  }
  for (const v of spec.volumes || []) {
    if (v.configMap) add('ConfigMap', v.configMap.name, 'volume');
    if (v.secret) add('Secret', v.secret.secretName, 'volume');
    if (v.persistentVolumeClaim) add('PersistentVolumeClaim', v.persistentVolumeClaim.claimName, 'volume');
    for (const p of (v.projected && v.projected.sources) || []) {
      if (p.configMap) add('ConfigMap', p.configMap.name, 'projected volume');
      if (p.secret) add('Secret', p.secret.name, 'projected volume');
    }
  }
  for (const s of spec.imagePullSecrets || []) add('Secret', s.name, 'imagePullSecret');
  if (spec.serviceAccountName) add('ServiceAccount', spec.serviceAccountName, 'pod spec');
  return refs;
}

/**
 * Container-level facts the Insights findings need, as flags and counts only.
 *
 * No image, no env value, no command line — the finding needs to know THAT a container runs
 * privileged, and the drawer for the workload itself is where the detail lives.
 */
function containerFacts(obj) {
  const spec = podSpecOf(obj);
  const all = [...(spec.containers || []), ...(spec.initContainers || [])];
  const missing = [];
  const privileged = [];
  for (const c of all) {
    const res = c.resources || {};
    const req = res.requests || {};
    const lim = res.limits || {};
    if (!req.cpu || !req.memory || !lim.memory) missing.push(c.name);
    const sc = c.securityContext || {};
    if (sc.privileged === true || sc.allowPrivilegeEscalation === true) privileged.push(c.name);
  }
  return { containerCount: all.length, containersMissingResources: missing, privilegedContainers: privileged };
}

/** The host in an Istio destination, reduced to the Service name it can only mean. */
function serviceFromHost(host, namespace) {
  if (typeof host !== 'string' || host.length === 0) return null;
  const parts = host.split('.');
  if (parts.length === 1) return parts[0];
  // `svc.ns` / `svc.ns.svc.cluster.local` — only accept it when the namespace matches, because
  // a short host in another namespace is a different Service that happens to share a name.
  if (parts[1] === namespace) return parts[0];
  return null;
}

/**
 * The `x-forwarded-host` an APIRule's rules set, or `null`.
 *
 * HTTP header names are case-insensitive and a hand-written manifest uses either casing, so the
 * key is matched lowercased. The first non-empty value across `spec.rules[]` wins: rules differ
 * by path, not by the external host they answer on.
 */
function forwardedHostOf(spec) {
  for (const rule of (spec || {}).rules || []) {
    const headers = ((rule || {}).request || {}).headers;
    if (!headers || typeof headers !== 'object') continue;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== 'x-forwarded-host') continue;
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
  }
  return null;
}

/**
 * The live inventory, relationship graph and events for one Helm release.
 */
async function related({ cluster, token, listFn = list, namespace, name }) {
  const ctx = { cluster, token };
  const ns = namespaceSegment(namespace);

  const releaseSecrets = await safeList(
    listFn,
    ctx,
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets?labelSelector=${encodeURIComponent(`owner=helm,name=${name}`)}&limit=200`,
    'helm release'
  );

  const decoded = [];
  for (const secret of releaseSecrets.items) {
    if (secret.type && secret.type !== HELM_SECRET_TYPE) continue;
    const raw = secret.data && secret.data.release;
    if (!raw) continue;
    const rel = helm.decodeRelease(raw);
    if (rel && (!rel.name || rel.name === name)) decoded.push(rel);
  }
  decoded.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
  const current = decoded.find(r => (r.info || {}).status === 'deployed') || decoded[0] || null;

  if (!current) {
    if (releaseSecrets.unavailable) {
      return emptyPayload({ namespace, name, reads: [releaseSecrets] });
    }
    throw new ClusterError(NOT_FOUND,
      `Helm release '${name}' not found in namespace '${namespace}'`,
      { cluster: cluster.id, status: 404 });
  }

  const rendered = helm.parseManifest(current.manifest);
  const renderedSet = new Set(rendered.resources.map(r => key(r.kind, r.namespace || namespace, r.name)));

  const reads = await Promise.all(
    LIVE_KINDS.map(spec => safeList(listFn, ctx, spec.path(ns), spec.label).then(r => ({ spec, r })))
  );
  const eventsRead = await safeList(listFn, ctx, `/api/v1/${ns}events?limit=${MAX_EVENTS}`, 'events');

  /** Every live object seen, keyed, with the read that produced it. */
  const live = new Map();
  for (const { spec, r } of reads) {
    for (const obj of r.items) {
      const meta = obj.metadata || {};
      if (!meta.name) continue;
      const k = key(spec.kind, meta.namespace || namespace, meta.name);
      // Two Certificate CRDs can both answer; first one wins and the second is a duplicate name
      // in a different group, which is vanishingly rare and not worth a second row.
      if (!live.has(k)) live.set(k, { kind: spec.kind, group: spec.group, obj });
    }
  }

  const readyEndpointsByService = new Map();
  for (const { spec, r } of reads) {
    if (spec.kind !== 'EndpointSlice') continue;
    for (const slice of r.items) {
      const svc = labelsOf(slice)['kubernetes.io/service-name'];
      if (!svc) continue;
      readyEndpointsByService.set(svc, (readyEndpointsByService.get(svc) || 0) + readyEndpointCount(slice));
    }
  }
  const endpointSliceReadable = reads.some(x => x.spec.kind === 'EndpointSlice' && !x.r.unavailable);
  // A refused EndpointSlice read must not render every Service as "No ready endpoints". The
  // lookup returns `undefined` in that case, which `statusOf` reports as "Endpoints unread".
  const statusCtx = {
    readyEndpointsByService: endpointSliceReadable ? readyEndpointsByService : { get: () => undefined }
  };

  // ------------------------------------------------------------------ relationship resolution
  /** k -> {relationship, evidence}. Set once; the first (strongest) pass wins. */
  const accepted = new Map();
  const accept = (k, relationship, evidence) => {
    if (!live.has(k) || accepted.has(k)) return false;
    accepted.set(k, { relationship, evidence });
    return true;
  };

  // Pass 1 — Helm's own claim, then the manifest it rendered.
  for (const [k, entry] of live) {
    const ann = annotationsOf(entry.obj);
    if (ann['meta.helm.sh/release-name'] === name && ann['meta.helm.sh/release-namespace'] === namespace) {
      accept(k, 'helm-owned', 'meta.helm.sh/release-name and -namespace annotations name this release');
    }
  }
  for (const k of live.keys()) {
    if (accepted.has(k)) continue;
    if (renderedSet.has(k)) {
      accept(k, 'helm-managed', `present in the rendered manifest of revision ${Number(current.version) || '?'}, without Helm's ownership annotations`);
    }
  }

  // Pass 2 — ownerReferences, repeated so Pod -> ReplicaSet -> Deployment resolves in one call.
  for (let round = 0; round < 3; round += 1) {
    let added = 0;
    for (const [k, entry] of live) {
      if (accepted.has(k)) continue;
      const meta = entry.obj.metadata || {};
      for (const owner of meta.ownerReferences || []) {
        const ownerKey = key(owner.kind, meta.namespace || namespace, owner.name);
        if (accepted.has(ownerKey)) {
          if (accept(k, 'owner-reference', `ownerReferences names ${owner.kind}/${owner.name}, which belongs to this release`)) added += 1;
          break;
        }
      }
    }
    if (added === 0) break;
  }

  /** The accepted workloads and pods every selector pass is written against. */
  const acceptedOf = kinds => [...accepted.keys()]
    .map(k => ({ k, ...live.get(k) }))
    .filter(e => e && kinds.includes(e.kind));

  const acceptedPods = acceptedOf(['Pod']);
  const acceptedWorkloads = acceptedOf(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']);

  // Pass 3a — a Service selects an accepted pod. Selectors, never names.
  for (const [k, entry] of live) {
    if (accepted.has(k) || entry.kind !== 'Service') continue;
    const sel = (entry.obj.spec && entry.obj.spec.selector) || null;
    if (!sel || Object.keys(sel).length === 0) continue;
    const hit = acceptedPods.find(p => Object.entries(sel).every(([kk, vv]) => labelsOf(p.obj)[kk] === vv));
    if (hit) accept(k, 'selector', `spec.selector matches Pod/${hit.obj.metadata.name}, which belongs to this release`);
  }

  const acceptedServiceNames = new Set(acceptedOf(['Service']).map(e => e.obj.metadata.name));

  // Pass 3b — EndpointSlices carry the Service they back as a label. That is the API's own link.
  for (const [k, entry] of live) {
    if (accepted.has(k) || entry.kind !== 'EndpointSlice') continue;
    const svc = labelsOf(entry.obj)['kubernetes.io/service-name'];
    if (svc && acceptedServiceNames.has(svc)) {
      accept(k, 'selector', `kubernetes.io/service-name=${svc}`);
    }
  }

  // Pass 3c — PDB and NetworkPolicy selectors against an accepted workload's pod template.
  for (const [k, entry] of live) {
    if (accepted.has(k)) continue;
    const sel = entry.kind === 'PodDisruptionBudget'
      ? (entry.obj.spec || {}).selector
      : entry.kind === 'NetworkPolicy'
        ? (entry.obj.spec || {}).podSelector
        : null;
    if (!sel) continue;
    const empty = !sel.matchLabels && !sel.matchExpressions;
    // An empty NetworkPolicy podSelector legitimately means "every pod in the namespace". It is
    // related, but by namespace rather than by this release — said as such rather than claimed.
    if (empty && entry.kind === 'NetworkPolicy') {
      accept(k, 'runtime', 'empty podSelector — applies to every pod in this namespace, including this release’s');
      continue;
    }
    const hitWorkload = acceptedWorkloads.find(w => policy.selectorMatches(templateLabels(w.obj), sel));
    if (hitWorkload) {
      accept(k, 'selector', `selector matches the pod template of ${hitWorkload.kind}/${hitWorkload.obj.metadata.name}`);
      continue;
    }
    const hitPod = acceptedPods.find(p => policy.selectorMatches(labelsOf(p.obj), sel));
    if (hitPod) accept(k, 'selector', `selector matches Pod/${hitPod.obj.metadata.name}`);
  }

  // Pass 4 — configuration an accepted pod template names.
  for (const w of [...acceptedWorkloads, ...acceptedPods]) {
    for (const ref of configReferences(w.obj)) {
      const k = key(ref.kind, w.obj.metadata.namespace || namespace, ref.name);
      accept(k, 'configuration-reference', `${ref.via} of ${w.kind}/${w.obj.metadata.name}`);
    }
  }

  // Pass 5 — live spec fields that point at something accepted.
  for (const [k, entry] of live) {
    if (accepted.has(k)) continue;
    const spec = entry.obj.spec || {};
    if (entry.kind === 'HorizontalPodAutoscaler') {
      const t = spec.scaleTargetRef || {};
      if (accepted.has(key(t.kind, entry.obj.metadata.namespace || namespace, t.name))) {
        accept(k, 'runtime', `scaleTargetRef names ${t.kind}/${t.name}`);
      }
      continue;
    }
    if (entry.kind === 'Ingress') {
      const backends = (spec.rules || []).flatMap(r => (((r.http || {}).paths) || []).map(p => (((p.backend || {}).service) || {}).name));
      const hit = backends.find(b => acceptedServiceNames.has(b));
      if (hit) accept(k, 'runtime', `a rule's backend routes to Service/${hit}`);
      continue;
    }
    if (entry.kind === 'APIRule') {
      const svc = ((spec.service || {}).name) || null;
      if (svc && acceptedServiceNames.has(svc)) accept(k, 'runtime', `spec.service.name routes to Service/${svc}`);
      continue;
    }
    if (entry.kind === 'VirtualService') {
      const hosts = [
        ...(spec.http || []).flatMap(h => (h.route || []).map(r => ((r.destination || {}).host))),
        ...(spec.tcp || []).flatMap(h => (h.route || []).map(r => ((r.destination || {}).host)))
      ];
      const hit = hosts.map(h => serviceFromHost(h, namespace)).find(s => s && acceptedServiceNames.has(s));
      if (hit) accept(k, 'runtime', `a route destination resolves to Service/${hit}`);
    }
  }

  // Pass 6 — Gateways an accepted VirtualService names, then TLS material those reference.
  const acceptedVs = acceptedOf(['VirtualService']);
  for (const [k, entry] of live) {
    if (accepted.has(k) || entry.kind !== 'Gateway') continue;
    const gwName = entry.obj.metadata.name;
    const hit = acceptedVs.find(v => ((v.obj.spec || {}).gateways || []).some(g => g === gwName || g.endsWith(`/${gwName}`)));
    if (hit) accept(k, 'runtime', `spec.gateways of VirtualService/${hit.obj.metadata.name} names this Gateway`);
  }

  const tlsSecretNames = new Set();
  for (const e of [...acceptedOf(['Gateway']), ...acceptedOf(['Ingress'])]) {
    const spec = e.obj.spec || {};
    for (const server of spec.servers || []) {
      const cred = ((server.tls || {}).credentialName) || null;
      if (cred) tlsSecretNames.add(cred);
    }
    for (const tls of spec.tls || []) {
      if (tls.secretName) tlsSecretNames.add(tls.secretName);
    }
  }
  for (const [k, entry] of live) {
    if (accepted.has(k)) continue;
    if (entry.kind === 'Secret' && tlsSecretNames.has(entry.obj.metadata.name)) {
      accept(k, 'runtime', 'named as the TLS credential of a Gateway or Ingress in this release');
      continue;
    }
    if (entry.kind === 'Certificate') {
      const secretName = (entry.obj.spec || {}).secretName || (((entry.obj.spec || {}).secretRef || {}).name) || null;
      if (secretName && (tlsSecretNames.has(secretName) || accepted.has(key('Secret', namespace, secretName)))) {
        accept(k, 'runtime', `spec.secretName is ${secretName}, which this release uses for TLS`);
      }
    }
  }

  // ------------------------------------------------------------------ rows
  const resources = [];
  for (const [k, meta] of accepted) {
    const entry = live.get(k);
    if (!entry) continue;
    const objMeta = entry.obj.metadata || {};
    resources.push({
      id: k,
      kind: entry.kind,
      name: objMeta.name,
      namespace: objMeta.namespace || namespace,
      group: entry.group,
      relationship: meta.relationship,
      evidence: meta.evidence,
      status: statusOf(entry.kind, entry.obj, statusCtx),
      createdAt: objMeta.creationTimestamp || null,
      facts: factsFor(entry.kind, entry.obj)
    });
  }
  resources.sort((a, b) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  // A PersistentVolume is cluster-scoped, so it is read only when an accepted PVC is actually
  // bound to one — never speculatively, and never as a whole-cluster list on page open.
  const boundVolumes = resources
    .filter(r => r.kind === 'PersistentVolumeClaim' && r.facts && r.facts.volumeName)
    .map(r => r.facts.volumeName);
  let pvRead = null;
  if (boundVolumes.length > 0) {
    pvRead = await safeList(listFn, ctx, '/api/v1/persistentvolumes?limit=500', 'persistentvolumes');
    for (const pv of pvRead.items) {
      if (!boundVolumes.includes(pv.metadata.name)) continue;
      const claim = ((pv.spec || {}).claimRef || {}).name || null;
      resources.push({
        id: key('PersistentVolume', null, pv.metadata.name),
        kind: 'PersistentVolume',
        name: pv.metadata.name,
        namespace: null,
        group: 'Storage',
        relationship: 'runtime',
        evidence: claim ? `spec.claimRef names PersistentVolumeClaim/${claim}` : 'bound to a claim in this release',
        status: statusOf('PersistentVolume', pv, statusCtx),
        createdAt: pv.metadata.creationTimestamp || null,
        facts: { claim, storageClass: (pv.spec || {}).storageClassName || null }
      });
    }
  }

  const byId = new Map(resources.map(r => [r.id, r]));

  // ------------------------------------------------------------------ manifest entries with no live object
  const missing = rendered.resources
    .map(r => ({ kind: r.kind, name: r.name, namespace: r.namespace || namespace }))
    .filter(r => r.name && !byId.has(key(r.kind, r.namespace, r.name)))
    .map(r => ({
      ...r,
      /**
       * Whether this can be called missing at all. A Kind nothing read cannot be reported as
       * absent — that is the "a failed read is never a zero" rule applied to an inventory.
       */
      readable: reads.some(x => x.spec.kind === r.kind && !x.r.unavailable && !x.r.truncated)
    }));

  // ------------------------------------------------------------------ events, by involvedObject
  const events = [];
  for (const e of eventsRead.items) {
    const io = e.involvedObject || {};
    if (!io.kind || !io.name) continue;
    const k = key(io.kind, io.namespace || namespace, io.name);
    const target = byId.get(k);
    // No name-similarity fallback: an event whose involvedObject is not in the resolved set is
    // not this release's event, however close the names look.
    if (!target) continue;
    events.push({
      at: e.lastTimestamp || e.eventTime || ((e.series || {}).lastObservedTime) || e.firstTimestamp || null,
      firstSeen: e.firstTimestamp || null,
      lastSeen: e.lastTimestamp || ((e.series || {}).lastObservedTime) || null,
      type: e.type || 'Normal',
      reason: e.reason || null,
      message: e.message || '',
      source: (e.source && (e.source.component || e.source.host)) || (e.reportingComponent || null),
      count: e.count || ((e.series || {}).count) || 1,
      resource: { kind: target.kind, namespace: target.namespace, name: target.name }
    });
  }
  events.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  const graph = buildGraph({ release: { name, namespace }, resources, live, namespace });

  const allReads = [releaseSecrets, ...reads.map(x => x.r), eventsRead, ...(pvRead ? [pvRead] : [])];
  return {
    release: {
      name,
      namespace,
      revision: Number(current.version) || null,
      status: (current.info || {}).status || null
    },
    rendered: {
      count: rendered.resources.length,
      kinds: rendered.kinds,
      /** Rendered entries with no live object — a real finding when the Kind was readable. */
      missing
    },
    resources,
    counts: countsOf(resources),
    graph,
    events,
    eventCoverage: {
      /**
       * Events are read for the release's namespace only, and the API caps its own retention at
       * an hour by default. Both are stated so a short list is never read as a quiet release.
       */
      namespaceOnly: true,
      limit: MAX_EVENTS,
      readable: !eventsRead.unavailable,
      truncated: Boolean(eventsRead.truncated)
    },
    summary: {
      unavailable: unavailableLabels(allReads),
      truncated: truncatedLabels(allReads)
    },
    collectedAt: new Date().toISOString()
  };
}

/** Per-kind extras the Insights findings and the graph edges need. No values, ever. */
function factsFor(kind, obj) {
  const spec = obj.spec || {};
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
    case 'CronJob':
    case 'Pod': {
      const facts = containerFacts(obj);
      if (kind === 'Deployment') {
        const progressing = ((obj.status || {}).conditions || []).find(c => c.type === 'Progressing') || {};
        facts.rolloutComplete = progressing.status === 'True' && progressing.reason === 'NewReplicaSetAvailable';
        facts.rolloutReason = progressing.reason || null;
        facts.rolloutMessage = progressing.status === 'False' ? (progressing.message || null) : null;
      }
      if (kind === 'Pod') {
        facts.node = spec.nodeName || null;
        facts.restarts = ((obj.status || {}).containerStatuses || []).reduce((n, c) => n + (c.restartCount || 0), 0);
      }
      facts.selector = spec.selector || null;
      return facts;
    }
    case 'Service':
      return {
        type: spec.type || 'ClusterIP',
        selector: spec.selector || null,
        ports: (spec.ports || []).map(p => ({ name: p.name || null, port: p.port, targetPort: p.targetPort ?? null }))
      };
    case 'EndpointSlice':
      return { service: labelsOf(obj)['kubernetes.io/service-name'] || null, addressType: obj.addressType || null };
    case 'Ingress':
      return {
        hosts: [...new Set((spec.rules || []).map(r => r.host).filter(Boolean))],
        backends: [...new Set((spec.rules || []).flatMap(r => (((r.http || {}).paths) || []).map(p => (((p.backend || {}).service) || {}).name).filter(Boolean)))],
        tlsSecrets: [...new Set((spec.tls || []).map(t => t.secretName).filter(Boolean))]
      };
    case 'APIRule':
      return {
        hosts: (spec.hosts || []).map(String),
        service: (spec.service || {}).name || null,
        port: (spec.service || {}).port ?? null,
        gateway: spec.gateway || null,
        /**
         * The address operators actually type. A Kyma APIRule fronting an external hostname
         * rewrites `x-forwarded-host`, so the value in `spec.hosts` is the cluster-internal
         * shoot domain and not what the traffic arrives as. Absent means absent: no header,
         * no guess, and no scheme — whether it is https is not in the manifest.
         */
        forwardedHost: forwardedHostOf(spec)
      };
    case 'VirtualService':
      return {
        hosts: (spec.hosts || []).map(String),
        gateways: (spec.gateways || []).map(String),
        destinations: [
          ...(spec.http || []).flatMap(h => (h.route || []).map(r => ((r.destination || {}).host)).filter(Boolean)),
          ...(spec.tcp || []).flatMap(h => (h.route || []).map(r => ((r.destination || {}).host)).filter(Boolean))
        ]
      };
    case 'Gateway':
      return {
        servers: (spec.servers || []).map(s => ({
          hosts: (s.hosts || []).map(String),
          port: (s.port || {}).number ?? null,
          tlsCredential: ((s.tls || {}).credentialName) || null
        }))
      };
    case 'HorizontalPodAutoscaler':
      return {
        target: spec.scaleTargetRef ? { kind: spec.scaleTargetRef.kind, name: spec.scaleTargetRef.name } : null,
        min: spec.minReplicas ?? null,
        max: spec.maxReplicas ?? null
      };
    case 'PersistentVolumeClaim':
      return {
        volumeName: spec.volumeName || null,
        storageClass: spec.storageClassName || null,
        requested: (((spec.resources || {}).requests) || {}).storage || null,
        accessModes: spec.accessModes || []
      };
    case 'ConfigMap':
      return { keys: Object.keys(obj.data || {}).sort() };
    case 'Secret':
      // Keys only. The contract in server/fleet is absolute: this file returns names, never values.
      return { type: obj.type || null, keys: Object.keys(obj.data || {}).sort() };
    case 'PodDisruptionBudget':
      return {
        minAvailable: spec.minAvailable ?? null,
        maxUnavailable: spec.maxUnavailable ?? null,
        selector: spec.selector || null,
        disruptionsAllowed: (obj.status || {}).disruptionsAllowed ?? null
      };
    case 'NetworkPolicy':
      return {
        podSelector: spec.podSelector || null,
        policyTypes: spec.policyTypes || [],
        ingressRules: (spec.ingress || []).length,
        egressRules: (spec.egress || []).length
      };
    case 'Certificate':
      return {
        secretName: spec.secretName || ((spec.secretRef || {}).name) || null,
        dnsNames: spec.dnsNames || (spec.commonName ? [spec.commonName] : []),
        expiresAt: ((obj.status || {}).expirationDate) || ((obj.status || {}).notAfter) || null
      };
    default:
      return {};
  }
}

function countsOf(resources) {
  const byGroup = {};
  const byKind = {};
  const byRelationship = {};
  for (const r of resources) {
    byGroup[r.group] = (byGroup[r.group] || 0) + 1;
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    byRelationship[r.relationship] = (byRelationship[r.relationship] || 0) + 1;
  }
  return { total: resources.length, byGroup, byKind, byRelationship };
}

/**
 * Nodes and typed edges, from the same evidence the rows carry.
 *
 * Every edge names the field that proves it. There is deliberately no edge type that means
 * "these look related" — a graph that draws one because two names match is worse than no graph,
 * because it is confidently wrong about the thing it exists to explain.
 */
function buildGraph({ release, resources, live, namespace }) {
  const nodes = [
    { id: 'release', kind: 'HelmRelease', name: release.name, namespace: release.namespace, group: 'Helm Release', relationship: 'helm-owned', status: null }
  ];
  for (const r of resources) {
    nodes.push({
      id: r.id,
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      group: r.group,
      relationship: r.relationship,
      status: r.status ? { text: r.status.text, tone: r.status.tone } : null
    });
  }
  const present = new Set(nodes.map(n => n.id));
  const edges = [];
  const add = (from, to, type, evidence, explanation) => {
    if (!present.has(from) || !present.has(to) || from === to) return;
    const id = `${from}|${type}|${to}`;
    if (edges.some(e => e.id === id)) return;
    edges.push({ id, from, to, type, evidence, explanation });
  };

  const byKindName = new Map(resources.map(r => [`${r.kind}/${r.name}`, r]));
  const svc = n => byKindName.get(`Service/${n}`);

  for (const r of resources) {
    if (r.relationship === 'helm-owned' || r.relationship === 'helm-managed') {
      add('release', r.id, 'helm-managed', r.evidence, `Helm installed this ${r.kind} as part of ${release.name}.`);
    }
    const entry = live.get(r.id);
    const meta = entry ? (entry.obj.metadata || {}) : {};
    for (const owner of meta.ownerReferences || []) {
      const ownerId = `${owner.kind}/${r.namespace || namespace}/${owner.name}`;
      add(ownerId, r.id, 'owner', `ownerReferences names ${owner.kind}/${owner.name}`,
        `Kubernetes created this ${r.kind} on behalf of ${owner.kind}/${owner.name}; deleting the owner deletes it.`);
    }
    const f = r.facts || {};
    if (r.kind === 'Service' && f.selector) {
      for (const p of resources.filter(x => x.kind === 'Pod')) {
        const labels = live.get(p.id) ? labelsOf(live.get(p.id).obj) : {};
        if (Object.entries(f.selector).every(([k, v]) => labels[k] === v)) {
          add(r.id, p.id, 'selector', `spec.selector matches the labels on Pod/${p.name}`,
            `Traffic sent to ${r.name} reaches this pod because its labels satisfy the Service selector.`);
        }
      }
    }
    if (r.kind === 'EndpointSlice' && f.service) {
      const s = svc(f.service);
      if (s) add(r.id, s.id, 'associated-with', `kubernetes.io/service-name=${f.service}`,
        `This EndpointSlice is the API's record of which addresses currently back ${f.service}.`);
    }
    if (r.kind === 'HorizontalPodAutoscaler' && f.target) {
      const t = byKindName.get(`${f.target.kind}/${f.target.name}`);
      if (t) add(r.id, t.id, 'targets', `scaleTargetRef names ${f.target.kind}/${f.target.name}`,
        `This autoscaler writes the replica count of ${f.target.name}.`);
    }
    if (r.kind === 'Ingress') {
      for (const b of f.backends || []) {
        const s = svc(b);
        if (s) add(r.id, s.id, 'routes-to', `a rule's backend names Service/${b}`, `External requests matching this Ingress are forwarded to ${b}.`);
      }
      for (const sec of f.tlsSecrets || []) {
        const t = byKindName.get(`Secret/${sec}`);
        if (t) add(r.id, t.id, 'tls-binding', `spec.tls names Secret/${sec}`, `The certificate this Ingress serves is read from ${sec}.`);
      }
    }
    if (r.kind === 'APIRule' && f.service) {
      const s = svc(f.service);
      // The external host, when the manifest states one. With neither a forwarded host nor a
      // `spec.hosts` entry the edge still holds — the backend is named — so it says only that.
      const external = f.forwardedHost || (f.hosts || [])[0] || null;
      if (s) {
        add(r.id, s.id, 'routes-to',
          external
            ? `APIRule routes external host ${external} to Service/${f.service}`
            : `spec.service.name names Service/${f.service}`,
          external
            ? `Requests arriving at ${external} are forwarded to ${f.service}.`
            : `The APIRule exposes ${f.service}; no host is declared on it.`);
      }
    }
    if (r.kind === 'VirtualService') {
      for (const host of f.destinations || []) {
        const short = serviceFromHost(host, r.namespace || namespace);
        const s = short ? svc(short) : null;
        if (s) add(r.id, s.id, 'routes-to', `a route destination resolves to Service/${short}`, `Istio routes matching traffic to ${short}.`);
      }
      for (const g of f.gateways || []) {
        const gwName = g.includes('/') ? g.split('/').pop() : g;
        const gw = byKindName.get(`Gateway/${gwName}`);
        if (gw) add(gw.id, r.id, 'associated-with', `spec.gateways names ${g}`, `This Gateway admits the traffic this VirtualService then routes.`);
      }
    }
    if (r.kind === 'Gateway') {
      for (const server of f.servers || []) {
        if (!server.tlsCredential) continue;
        const t = byKindName.get(`Secret/${server.tlsCredential}`);
        if (t) add(r.id, t.id, 'tls-binding', `a server's tls.credentialName is ${server.tlsCredential}`, `The Gateway terminates TLS with the certificate in ${server.tlsCredential}.`);
      }
    }
    if (r.kind === 'Certificate' && f.secretName) {
      const t = byKindName.get(`Secret/${f.secretName}`);
      if (t) add(r.id, t.id, 'tls-binding', `spec.secretName is ${f.secretName}`, `This Certificate's issued material is written into ${f.secretName}.`);
    }
    if (r.kind === 'PodDisruptionBudget' && f.selector) {
      for (const w of resources.filter(x => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(x.kind))) {
        const obj = live.get(w.id);
        if (obj && policy.selectorMatches(templateLabels(obj.obj), f.selector)) {
          add(r.id, w.id, 'selector', `spec.selector matches the pod template of ${w.kind}/${w.name}`,
            `This budget governs how many of ${w.name}'s pods may be evicted at once.`);
        }
      }
    }
    if (r.kind === 'NetworkPolicy' && f.podSelector) {
      const empty = !f.podSelector.matchLabels && !f.podSelector.matchExpressions;
      for (const w of resources.filter(x => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(x.kind))) {
        const obj = live.get(w.id);
        if (!obj) continue;
        if (empty || policy.selectorMatches(templateLabels(obj.obj), f.podSelector)) {
          add(r.id, w.id, 'selector', empty ? 'empty podSelector — every pod in the namespace' : `podSelector matches the pod template of ${w.kind}/${w.name}`,
            `This policy governs the traffic allowed to and from ${w.name}'s pods.`);
        }
      }
    }
  }

  // Configuration edges come from the pod templates, so they are read off the live objects
  // rather than re-derived from the rows.
  for (const r of resources) {
    if (!['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'].includes(r.kind)) continue;
    const entry = live.get(r.id);
    if (!entry) continue;
    for (const ref of configReferences(entry.obj)) {
      const target = byKindName.get(`${ref.kind}/${ref.name}`);
      if (!target) continue;
      const type = ref.via === 'volume' || ref.via === 'projected volume' ? 'mounts' : 'references';
      add(r.id, target.id, type, `${ref.via} names ${ref.kind}/${ref.name}`,
        `${r.name} reads ${ref.name} through its ${ref.via}; a missing or changed ${ref.kind} changes what it runs with.`);
    }
  }

  return { nodes, edges };
}

function emptyPayload({ namespace, name, reads }) {
  return {
    release: { name, namespace, revision: null, status: null },
    rendered: { count: 0, kinds: {}, missing: [] },
    resources: [],
    counts: { total: 0, byGroup: {}, byKind: {}, byRelationship: {} },
    graph: { nodes: [], edges: [] },
    events: [],
    eventCoverage: { namespaceOnly: true, limit: MAX_EVENTS, readable: false, truncated: false },
    summary: { unavailable: unavailableLabels(reads), truncated: truncatedLabels(reads) },
    collectedAt: new Date().toISOString()
  };
}

export default {
  related,
  // exported for tests
  statusOf, podStatus, configReferences, containerFacts, serviceFromHost, buildGraph, factsFor,
  LIVE_KINDS, MAX_EVENTS
};
