/**
 * Istio mesh collector: sidecar coverage, effective mTLS, ingress binding integrity, and
 * authorization posture. Wired to GET /mesh and GET /clusters/:id/mesh by a later wave —
 * this module only builds the four verdicts, it does not add routes.
 *
 * Every read here goes through `safeList`, and a 404 on any Istio CRD (`networking.istio.io`,
 * `security.istio.io`) is read the same way `networking.js` reads VirtualServices/Gateways:
 * a true zero, because Istio simply not being installed on a cluster is the honest common
 * case, not an outage. Pods and Namespaces are core APIs that always exist, so they go
 * through `requiredList` — a 404 on either is a red flag, never a confident "no pods".
 *
 * Every verdict below is built to degrade to `null` rather than to `0` or `false` the moment
 * one of its inputs is unavailable. See the per-verdict comment for exactly which inputs
 * gate which fields — the gating is deliberately per-verdict, not "any read failed anywhere
 * nulls the whole payload", because that would make one flaky read (say, DaemonSets) blank
 * out verdicts (A3, A4) that never touch it.
 */
import k8sModule from '../k8s.js';
const { namespaceSegment, list } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, requiredList, unavailableLabels, truncatedLabels } = safeListModule;

/** networking.istio.io/v1: VirtualServices, Gateways, DestinationRules. */
const NETWORKING_GROUP = 'networking.istio.io';
/** security.istio.io/v1: PeerAuthentications, AuthorizationPolicies. */
const SECURITY_GROUP = 'security.istio.io';
const ISTIO_VERSION = 'v1';

/**
 * Where the mesh-wide root namespace assumption comes from. Istio's actual root namespace
 * is a MeshConfig field (`rootNamespace`, default `istio-system`) set on istiod's own
 * ConfigMap, which this collector has no RBAC to read (and reading istiod's config just to
 * learn a namespace name would be a second round trip on every single collection). The
 * platform's clusters have never overridden it, so `istio-system` is used — but the origin
 * of that assumption is exactly `istiod` and every mTLS verdict says so plainly rather than
 * silently trusting the guess.
 */
const ROOT_NAMESPACE = 'istio-system';
const ROOT_NAMESPACE_SOURCE = 'inferred-from-istiod';

/** Ambient mode is opted into with either the OSS or the (older, still-served) alpha label. */
const AMBIENT_LABEL_KEYS = ['istio.io/dataplane-mode', 'dataplane-mode'];
const AMBIENT_VALUE = 'ambient';

/** Native sidecar mode (k8s 1.35+) injects `istio-proxy` as an init container, not a container. */
const SIDECAR_CONTAINER_NAME = 'istio-proxy';
const SIDECAR_STATUS_ANNOTATION = 'sidecar.istio.io/status';

/** Trailing hash Kubernetes appends when a ReplicaSet or Pod name is generated from a template. */
const GENERATED_SUFFIX = /-[a-z0-9]{8,10}$/;

function labelValue(labels, keys) {
  for (const key of keys) {
    if (labels && Object.prototype.hasOwnProperty.call(labels, key)) return labels[key];
  }
  return undefined;
}

function isAmbient(labels) {
  return labelValue(labels, AMBIENT_LABEL_KEYS) === AMBIENT_VALUE;
}

/**
 * The Deployment (or DaemonSet/StatefulSet) a pod belongs to, from its owner chain — never
 * from parsing the pod's own name, which is not guaranteed to encode anything.
 *
 * A pod owned by a ReplicaSet is owned by a Deployment one level further up, but a Pod's own
 * `ownerReferences` never lists the Deployment directly (Kubernetes owner chains are exactly
 * one hop): only the ReplicaSet is there, named `<deployment>-<hash>`. Stripping that hash is
 * the only way to recover the Deployment name without a second list call for ReplicaSets,
 * which this collector's RBAC was not granted to read and does not need for anything else.
 * A pod with no owner at all (a bare Pod, or a controller this collector does not recognise)
 * gets its own bucket rather than being dropped — a coverage report that silently drops rows
 * undercounts without saying so.
 */
function ownerBucket(pod) {
  const owners = (pod.metadata && pod.metadata.ownerReferences) || [];
  const owner = owners.find(o => o && o.controller !== false) || owners[0];
  if (!owner || !owner.name) return { bucket: 'unowned', kind: null };
  if (owner.kind === 'ReplicaSet') {
    const stripped = owner.name.replace(GENERATED_SUFFIX, '');
    return { bucket: stripped || owner.name, kind: 'Deployment' };
  }
  // DaemonSet and StatefulSet own their pods directly; the owner name IS the workload name.
  return { bucket: owner.name, kind: owner.kind || 'Unknown' };
}

/**
 * A1 — sidecar coverage for one pod: is `istio-proxy` present, natively or classically, and
 * does the injector's own status annotation agree?
 */
function podSidecarState(pod, namespaceAmbient) {
  const spec = pod.spec || {};
  const containers = spec.containers || [];
  const initContainers = spec.initContainers || [];
  const inContainers = containers.some(c => c.name === SIDECAR_CONTAINER_NAME);
  const inInit = initContainers.some(c => c.name === SIDECAR_CONTAINER_NAME);
  const inMesh = inContainers || inInit;
  const sidecarMode = inInit ? 'native' : (inContainers ? 'classic' : null);

  const annotations = (pod.metadata && pod.metadata.annotations) || {};
  const statusAnnotation = annotations[SIDECAR_STATUS_ANNOTATION];
  // The annotation is written by the injector and corroborates the container-list evidence;
  // it must never override it — a stale annotation from a pod that was later hand-edited to
  // remove the container is not proof the sidecar is still there.
  const annotationSaysInjected = typeof statusAnnotation === 'string' && statusAnnotation.length > 0;

  const podLabels = (pod.metadata && pod.metadata.labels) || {};
  const ambient = namespaceAmbient || isAmbient(podLabels);

  return {
    inMesh,
    sidecarMode,
    ambient,
    corroboratedByAnnotation: inMesh ? annotationSaysInjected : null,
    // A pod that carries the injector's annotation but has neither container is a real
    // contradiction worth a flag of its own — injection was attempted/recorded but the
    // container is absent (evicted sidecar, injector/webhook mismatch, hand-edited pod).
    annotationWithoutContainer: !inMesh && annotationSaysInjected
  };
}

/**
 * A1 — group every pod's sidecar state by the Deployment/DaemonSet/StatefulSet that owns it.
 * `null` (not `0`/`false`) on every derived field once `pods` failed to read; a namespace
 * lookup failure alone does not null this out, since sidecar/annotation evidence still
 * stands without it — only the ambient corroboration from namespace labels is lost.
 */
function sidecarCoverage(pods, namespacesByName, ztunnelPresent) {
  const byBucket = new Map();
  for (const pod of pods) {
    const ns = (pod.metadata && pod.metadata.namespace) || '';
    const namespaceAmbient = namespacesByName ? isAmbient(namespacesByName.get(ns)) : false;
    const state = podSidecarState(pod, namespaceAmbient);
    const { bucket, kind } = ownerBucket(pod);
    const key = `${ns}/${bucket}`;
    if (!byBucket.has(key)) {
      byBucket.set(key, { namespace: ns, name: bucket, kind, pods: [], inMeshCount: 0, ambient: state.ambient });
    }
    const entry = byBucket.get(key);
    entry.pods.push({
      name: pod.metadata && pod.metadata.name,
      inMesh: state.inMesh,
      sidecarMode: state.sidecarMode,
      ambient: state.ambient,
      corroboratedByAnnotation: state.corroboratedByAnnotation,
      annotationWithoutContainer: state.annotationWithoutContainer
    });
    if (state.inMesh) entry.inMeshCount += 1;
    // Ambient is a namespace/pod-label property, not a per-pod sidecar fact, so once any pod
    // in the bucket reports it the whole bucket is ambient — they share the namespace.
    if (state.ambient) entry.ambient = true;
  }

  const byDeployment = [...byBucket.values()].map(entry => ({
    namespace: entry.namespace,
    name: entry.name,
    kind: entry.kind,
    ambient: entry.ambient,
    podCount: entry.pods.length,
    inMeshCount: entry.inMeshCount,
    // Ambient workloads are meshed via ztunnel, not a sidecar; reporting 0/N sidecar coverage
    // for them would read as "unmeshed" when the opposite is true, so their coverage is a
    // separate concept (see `ambient`) and their sidecar percentage is not meaningful.
    coveragePercent: entry.ambient ? null : (entry.pods.length === 0 ? null : Math.round((entry.inMeshCount / entry.pods.length) * 100)),
    pods: entry.pods
  }));

  const meshablePods = pods.filter(p => {
    const { bucket } = ownerBucket(p);
    return !byBucket.get(`${p.metadata.namespace}/${bucket}`).ambient;
  });
  const totalMeshable = meshablePods.length;
  const inMeshCount = byDeployment.reduce((n, d) => n + (d.ambient ? 0 : d.inMeshCount), 0);

  return {
    byDeployment,
    totalPods: pods.length,
    ambientPods: pods.length - totalMeshable,
    // ztunnel absence is corroborating only: a fleet that is 100% classic-sidecar has no
    // ztunnel DaemonSet either, and that is correct, not a finding. `null` when the DaemonSet
    // read itself failed — see the caller, which never treats "empty" and "unreadable" alike.
    ztunnelPresent,
    coveragePercent: totalMeshable === 0 ? null : Math.round((inMeshCount / totalMeshable) * 100)
  };
}

/**
 * A2 — resolve the top-level STRICT/PERMISSIVE/DISABLE mode for one scope chain, walking
 * workload -> namespace -> mesh. An object with no `mode` at its own scope is not a bare
 * "UNSET" value: it resolves upward to whichever broader scope defines one, and only the
 * mesh-wide scope's own absence of a mode falls back to Istio's documented default
 * (PERMISSIVE when no PeerAuthentication exists anywhere).
 */
function resolveTopLevelMode({ workloadPA, namespacePA, meshPA }) {
  if (workloadPA && workloadPA.mode) return { mode: workloadPA.mode, source: 'workload' };
  if (namespacePA && namespacePA.mode) return { mode: namespacePA.mode, source: 'namespace' };
  if (meshPA && meshPA.mode) return { mode: meshPA.mode, source: 'mesh' };
  return { mode: 'PERMISSIVE', source: 'default' };
}

/**
 * A2 — the port-level walk. `portLevelMtls` on ANY scope can override that scope's own
 * top-level mode for one port, and the override still has to be resolved through the same
 * workload > namespace > mesh precedence — a workload's port 9090 override beats a
 * namespace-wide STRICT even though the workload's own top-level mode says nothing about
 * port 9090 at all.
 */
function resolvePortModes({ workloadPA, namespacePA, meshPA }, topLevel) {
  const ports = new Set();
  for (const pa of [workloadPA, namespacePA, meshPA]) {
    if (pa && pa.portLevelMtls) Object.keys(pa.portLevelMtls).forEach(p => ports.add(p));
  }
  const overrides = {};
  for (const port of ports) {
    const fromWorkload = workloadPA && workloadPA.portLevelMtls && workloadPA.portLevelMtls[port];
    const fromNamespace = namespacePA && namespacePA.portLevelMtls && namespacePA.portLevelMtls[port];
    const fromMesh = meshPA && meshPA.portLevelMtls && meshPA.portLevelMtls[port];
    const resolved = (fromWorkload && fromWorkload.mode) || (fromNamespace && fromNamespace.mode) || (fromMesh && fromMesh.mode) || topLevel.mode;
    overrides[port] = resolved;
  }
  return overrides;
}

/** Parse a PeerAuthentication object into the fields the resolver needs. */
function parsePeerAuth(obj) {
  const spec = obj.spec || {};
  const mtls = spec.mtls || {};
  return {
    namespace: obj.metadata && obj.metadata.namespace,
    name: obj.metadata && obj.metadata.name,
    selector: (spec.selector && spec.selector.matchLabels) || null,
    targetRefs: spec.targetRefs || null,
    mode: mtls.mode || undefined,
    portLevelMtls: spec.portLevelMtls || null
  };
}

/**
 * A2 — every DestinationRule subset's client-side TLS setting, flattened to
 * `{namespace, host, mode}` so it can be matched against a workload by host string. This is
 * a client-side override: it can force plaintext or mTLS on the CALLER's side regardless of
 * what the callee's PeerAuthentication says, which is precisely why it rides in the same
 * walk rather than as a footnote.
 */
function destinationRuleOverrides(drItems) {
  const overrides = [];
  for (const dr of drItems) {
    const spec = dr.spec || {};
    const host = spec.host;
    if (!host) continue;
    const topTls = spec.trafficPolicy && spec.trafficPolicy.tls;
    if (topTls && topTls.mode) {
      overrides.push({ namespace: dr.metadata.namespace, host, subset: null, mode: topTls.mode });
    }
    for (const subset of spec.subsets || []) {
      const tls = subset.trafficPolicy && subset.trafficPolicy.tls;
      if (tls && tls.mode) {
        overrides.push({ namespace: dr.metadata.namespace, host, subset: subset.name || null, mode: tls.mode });
      }
    }
  }
  return overrides;
}

/**
 * A2 — build one verdict per PeerAuthentication scope found on the cluster, plus a mesh-wide
 * verdict even when no object names it explicitly (absence of any PeerAuthentication is
 * itself the PERMISSIVE default and is worth reporting, not silently skipping).
 *
 * `null` when either `peerAuthentications` or `destinationRules` is unavailable: a hidden
 * DestinationRule override can flip the answer for any workload, so a verdict built without
 * being able to see it is not a verdict this collector can stand behind — see the module
 * note on why gating is per-verdict rather than global.
 */
function mtlsVerdicts(paItems, drItems) {
  const meshPA = paItems.map(parsePeerAuth).find(pa => pa.namespace === ROOT_NAMESPACE && !hasSelectorParsed(pa)) || null;
  const namespacePAs = paItems.map(parsePeerAuth).filter(pa => !hasSelectorParsed(pa) && pa.namespace !== ROOT_NAMESPACE);
  const workloadPAs = paItems.map(parsePeerAuth).filter(pa => hasSelectorParsed(pa));
  const drOverrides = destinationRuleOverrides(drItems);

  function hasSelectorParsed(pa) {
    return Boolean((pa.selector && Object.keys(pa.selector).length > 0) || (pa.targetRefs && pa.targetRefs.length > 0));
  }

  const namespacePAByNs = new Map(namespacePAs.map(pa => [pa.namespace, pa]));

  const verdicts = [];

  // Mesh-wide verdict, always emitted — even the implicit PERMISSIVE default is a fact
  // operators need to see, not a blank.
  const meshTop = resolveTopLevelMode({ workloadPA: null, namespacePA: null, meshPA });
  verdicts.push({
    scope: 'mesh',
    namespace: ROOT_NAMESPACE,
    name: meshPA ? meshPA.name : null,
    mode: meshTop.mode,
    modeSource: meshTop.source,
    portOverrides: resolvePortModes({ workloadPA: null, namespacePA: null, meshPA }, meshTop),
    clientSideOverrides: [],
    mtlsBasis: 'configuration',
    rootNamespaceSource: ROOT_NAMESPACE_SOURCE
  });

  for (const nsPA of namespacePAs) {
    const top = resolveTopLevelMode({ workloadPA: null, namespacePA: nsPA, meshPA });
    verdicts.push({
      scope: 'namespace',
      namespace: nsPA.namespace,
      name: nsPA.name,
      mode: top.mode,
      modeSource: top.source,
      portOverrides: resolvePortModes({ workloadPA: null, namespacePA: nsPA, meshPA }, top),
      clientSideOverrides: drOverrides.filter(o => o.namespace === nsPA.namespace),
      mtlsBasis: 'configuration',
      rootNamespaceSource: ROOT_NAMESPACE_SOURCE
    });
  }

  for (const wPA of workloadPAs) {
    const nsPA = namespacePAByNs.get(wPA.namespace) || null;
    const top = resolveTopLevelMode({ workloadPA: wPA, namespacePA: nsPA, meshPA });
    verdicts.push({
      scope: 'workload',
      namespace: wPA.namespace,
      name: wPA.name,
      selector: wPA.selector,
      targetRefs: wPA.targetRefs,
      mode: top.mode,
      modeSource: top.source,
      portOverrides: resolvePortModes({ workloadPA: wPA, namespacePA: nsPA, meshPA }, top),
      clientSideOverrides: drOverrides.filter(o => o.namespace === wPA.namespace),
      mtlsBasis: 'configuration',
      rootNamespaceSource: ROOT_NAMESPACE_SOURCE
    });
  }

  return verdicts;
}

/** A3 — the literal keyword a VirtualService uses to mean "the mesh's internal gateway". */
const MESH_GATEWAY_KEYWORD = 'mesh';

/** A3 — resolve one `spec.gateways` entry to the `namespace/name` id it refers to. */
function resolveGatewayRef(ref, vsNamespace) {
  if (!ref || ref === MESH_GATEWAY_KEYWORD) return null;
  if (ref.includes('/')) return ref;
  return `${vsNamespace}/${ref}`;
}

/**
 * A3 — the three ingress-binding joins, symmetrically gated: unless both Gateways and
 * VirtualServices were readable, every field is `null`, never a one-sided partial (a
 * "0 unbound Gateways" computed while VirtualServices failed to load is not 0, it is
 * unknown, and reporting it as 0 tells an operator their ingress is fine when it might not
 * be). Raw VS/Gateway/DestinationRule counts are intentionally not part of this return —
 * `/networking` already owns those; duplicating them here would give two pages two numbers
 * for the same objects the moment either drifts.
 */
function ingressBindingIntegrity(gwItems, vsItems) {
  const gatewayIds = gwItems.map(gw => `${gw.metadata.namespace}/${gw.metadata.name}`);
  const referenced = new Set();
  const vsMissingGateway = [];

  for (const vs of vsItems) {
    const refs = (vs.spec && vs.spec.gateways) || [];
    let anyMissing = false;
    for (const ref of refs) {
      const resolved = resolveGatewayRef(ref, vs.metadata.namespace);
      if (resolved === null) continue; // the mesh keyword: not an ingress Gateway, not "unbound"
      if (gatewayIds.includes(resolved)) referenced.add(resolved);
      else anyMissing = true;
    }
    if (anyMissing) vsMissingGateway.push(`${vs.metadata.namespace}/${vs.metadata.name}`);
  }

  const unboundGateways = gatewayIds.filter(id => !referenced.has(id));

  // Duplicate host exposure: the exact same host string declared under more than one
  // Gateway's servers[].hosts. Exact-string only, per the contract — no wildcard expansion,
  // since matching "*.example.com" against "api.example.com" is a judgment call this
  // collector must not silently make.
  const hostToGateways = new Map();
  for (const gw of gwItems) {
    const id = `${gw.metadata.namespace}/${gw.metadata.name}`;
    const servers = (gw.spec && gw.spec.servers) || [];
    const hosts = new Set(servers.flatMap(s => s.hosts || []));
    for (const host of hosts) {
      if (!hostToGateways.has(host)) hostToGateways.set(host, new Set());
      hostToGateways.get(host).add(id);
    }
  }
  const duplicateHostExposures = [...hostToGateways.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([host, ids]) => ({ host, gateways: [...ids] }));

  return { unboundGateways, virtualServicesWithMissingGateway: vsMissingGateway, duplicateHostExposures };
}

/** A4 — DENY with no rules matches nothing (denies nothing); ALLOW with no rules allows everything. */
function classifyAuthzPolicy(ap) {
  const spec = ap.spec || {};
  const action = spec.action || 'ALLOW';
  const rules = spec.rules || [];
  if (action === 'DENY' && rules.length === 0) return 'inert';
  if (action === 'ALLOW' && rules.length === 0) return 'allowAll';
  if (action === 'ALLOW') return 'allow';
  if (action === 'DENY') return 'deny';
  return action.toLowerCase(); // AUDIT / CUSTOM pass through as-is, lowercased
}

function authzScope(ap) {
  const spec = ap.spec || {};
  const selector = spec.selector && spec.selector.matchLabels;
  const targetRefs = spec.targetRefs;
  if ((selector && Object.keys(selector).length > 0) || (Array.isArray(targetRefs) && targetRefs.length > 0)) {
    return 'workload';
  }
  // No selector/targetRefs at all: mesh-wide, applies to the whole fleet — every namespace,
  // not one inferred root. AuthorizationPolicy (unlike PeerAuthentication) has no special
  // root-namespace meaning; a namespace-scoped-but-unselected policy already applies to
  // every workload in ITS namespace by the same rule, one level down.
  return 'namespace-or-mesh';
}

/**
 * A4 — authorization posture: every AuthorizationPolicy classified, plus which
 * workload-scoped policies have nothing that can enforce them (no sidecar, and not ambient —
 * ambient enforces via ztunnel, so it is excluded here rather than flagged as a gap).
 *
 * `null` when `authorizationPolicies` is unavailable. `unenforceablePolicies` is additionally
 * `null` when sidecar coverage itself is null (pods unavailable) — there is no coverage
 * evidence to check a policy's namespace against.
 */
function authorizationPosture(apItems, coverageByNamespace) {
  const policies = apItems.map(ap => ({
    namespace: ap.metadata.namespace,
    name: ap.metadata.name,
    action: (ap.spec && ap.spec.action) || 'ALLOW',
    scope: authzScope(ap),
    classification: classifyAuthzPolicy(ap),
    usesTargetRefs: Array.isArray(ap.spec && ap.spec.targetRefs) && ap.spec.targetRefs.length > 0
  }));

  if (!coverageByNamespace) {
    return { policies, unenforceablePolicies: null };
  }

  const unenforceablePolicies = policies
    .filter(p => p.scope === 'workload')
    .filter(p => {
      const cov = coverageByNamespace.get(p.namespace);
      // No coverage evidence at all for this namespace (no pods matched), ambient (enforced
      // via ztunnel, not a sidecar — not a gap), or genuine sidecar presence: none of those
      // are "unenforceable". Only a namespace with pods, none ambient, none carrying a
      // sidecar, counts.
      if (!cov || cov.ambient) return false;
      return cov.inMeshCount === 0;
    })
    .map(p => ({ namespace: p.namespace, name: p.name }));

  return { policies, unenforceablePolicies };
}

/**
 * @param {{cluster: object, token: string, namespace?: string, listFn?: typeof list}} ctx
 */
async function collect({ cluster, token, namespace, listFn = list }) {
  const nsQuery = namespaceSegment(namespace);
  const baseCtx = { cluster, token };

  const [
    podsResult, namespacesResult, virtualservices, gateways, destinationrules,
    peerauthentications, authorizationpolicies, daemonsets
  ] = await Promise.all([
    requiredList('pods', () => listFn({ ...baseCtx, path: `/api/v1/${nsQuery}pods` })),
    requiredList('namespaces', () => listFn({ ...baseCtx, path: '/api/v1/namespaces' })),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/${nsQuery}virtualservices`, 'virtualservices'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/${nsQuery}gateways`, 'istio-gateways'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/${nsQuery}destinationrules`, 'destinationrules'),
    safeList(listFn, baseCtx, `/apis/${SECURITY_GROUP}/${ISTIO_VERSION}/${nsQuery}peerauthentications`, 'peerauthentications'),
    safeList(listFn, baseCtx, `/apis/${SECURITY_GROUP}/${ISTIO_VERSION}/${nsQuery}authorizationpolicies`, 'authorizationpolicies'),
    safeList(listFn, baseCtx, '/apis/apps/v1/namespaces/istio-system/daemonsets', 'ztunnel-daemonset')
  ]);

  const allResults = [
    podsResult, namespacesResult, virtualservices, gateways, destinationrules,
    peerauthentications, authorizationpolicies, daemonsets
  ];

  // ---------------------------------------------------------------- A1 sidecar coverage
  let sidecar = null;
  let coverageByNamespace = null;
  if (!podsResult.unavailable) {
    const namespacesByName = namespacesResult.unavailable
      ? null
      : new Map(namespacesResult.items.map(n => [n.metadata.name, n]));
    const ztunnelPresent = daemonsets.unavailable
      ? null
      : daemonsets.items.some(ds => (ds.metadata && ds.metadata.name || '').includes('ztunnel'));
    sidecar = sidecarCoverage(podsResult.items, namespacesByName, ztunnelPresent);

    coverageByNamespace = new Map();
    for (const entry of sidecar.byDeployment) {
      const existing = coverageByNamespace.get(entry.namespace) || { inMeshCount: 0, podCount: 0, ambient: false };
      existing.inMeshCount += entry.inMeshCount;
      existing.podCount += entry.podCount;
      if (entry.ambient) existing.ambient = true;
      coverageByNamespace.set(entry.namespace, existing);
    }
  }

  // ---------------------------------------------------------------- A2 mTLS
  const mtlsInputsAvailable = !peerauthentications.unavailable && !destinationrules.unavailable;
  const mtls = {
    verdicts: mtlsInputsAvailable ? mtlsVerdicts(peerauthentications.items, destinationrules.items) : null,
    mtlsBasis: 'configuration',
    rootNamespaceSource: ROOT_NAMESPACE_SOURCE
  };

  // ---------------------------------------------------------------- A3 ingress binding integrity
  const bindingInputsAvailable = !gateways.unavailable && !virtualservices.unavailable;
  const binding = bindingInputsAvailable
    ? ingressBindingIntegrity(gateways.items, virtualservices.items)
    : { unboundGateways: null, virtualServicesWithMissingGateway: null, duplicateHostExposures: null };

  // ---------------------------------------------------------------- A4 authorization posture
  const authz = authorizationpolicies.unavailable
    ? { policies: null, unenforceablePolicies: null }
    : authorizationPosture(authorizationpolicies.items, coverageByNamespace);

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    sidecarCoverage: sidecar,
    mtls,
    ingressBindingIntegrity: binding,
    authorizationPosture: authz,
    summary: {
      unavailable: unavailableLabels(allResults),
      truncated: truncatedLabels(allResults)
    },
    collectedAt: new Date().toISOString()
  };
}

export default {
  collect,
  // exported for tests / callers that want the pure functions without a full collect()
  sidecarCoverage,
  mtlsVerdicts,
  ingressBindingIntegrity,
  authorizationPosture,
  ownerBucket,
  podSidecarState
};
