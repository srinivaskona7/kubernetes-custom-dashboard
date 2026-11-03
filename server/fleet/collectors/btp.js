/**
 * BTP service instance/binding inventory, kept as its own collector (never merged into
 * modules.js) so that a 403 on the Kyma module CRDs cannot discard otherwise-readable BTP
 * data, and vice versa — the two API groups are unrelated and fail independently on a
 * partially-onboarded cluster.
 *
 * Five reads, three CRD families:
 *   services.cloud.sap.com/v1        serviceinstances, servicebindings   (B3, B4, B6)
 *   serverless.kyma-project.io/v1alpha2 functions                        (B5)
 *   eventing.kyma-project.io/v1alpha2   subscriptions                    (B5)
 * plus one core read, pods, for B6's in-use cross-reference.
 */
import k8sModule from '../k8s.js';
const { list, call } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, absentList, unavailableLabels, truncatedLabels } = safeListModule;

const BTP_GROUP = 'services.cloud.sap.com';
// The SAP BTP service operator serves v1 and v1alpha1. This read v1beta2 until 2026-10-01, a version
// the group never served, and every 404 counted as "not installed": 0 instances on a cluster with 8.
const BTP_VERSION = 'v1';
const INSTANCES_PATH = `/apis/${BTP_GROUP}/${BTP_VERSION}/serviceinstances`;
const BINDINGS_PATH = `/apis/${BTP_GROUP}/${BTP_VERSION}/servicebindings`;
const INSTANCES_LABEL = 'serviceinstances';
const BINDINGS_LABEL = 'servicebindings';

const SERVERLESS_GROUP = 'serverless.kyma-project.io';
const SERVERLESS_VERSION = 'v1alpha2';
const FUNCTIONS_PATH = `/apis/${SERVERLESS_GROUP}/${SERVERLESS_VERSION}/functions`;
const FUNCTIONS_LABEL = 'functions';

const EVENTING_GROUP = 'eventing.kyma-project.io';
const EVENTING_VERSION = 'v1alpha2';
const SUBSCRIPTIONS_PATH = `/apis/${EVENTING_GROUP}/${EVENTING_VERSION}/subscriptions`;
const SUBSCRIPTIONS_LABEL = 'subscriptions';

const PODS_PATH = '/api/v1/pods';
const PODS_LABEL = 'pods';

/**
 * B3: fields allowed onto a ServiceInstance's projection. Anything not named here never
 * reaches the collector's return value — an allowlist rather than a denylist, because a
 * denylist only protects against the fields someone remembered to name. `spec.userInfo` (the
 * identity that created the instance), `spec.parameters` and `spec.parametersFrom` (binding
 * parameters, which for many BTP services carry credentials or PII) must never appear here.
 */
function projectInstance(instance) {
  const metadata = instance.metadata || {};
  const spec = instance.spec || {};
  const status = instance.status || {};
  return {
    id: `${metadata.namespace}/${metadata.name}`,
    name: metadata.name,
    namespace: metadata.namespace,
    // spec.userInfo / spec.parameters / spec.parametersFrom intentionally absent — see above.
    offering: spec.serviceOfferingName || null,
    plan: spec.servicePlanName || null,
    externalName: spec.externalName || null,
    ready: (status.conditions || []).some(c => c.type === 'Ready' && c.status === 'True'),
    instanceID: status.instanceID || null,
    createdAt: metadata.creationTimestamp || null
  };
}

/** B4: a ServiceBinding's own projection. No parameters here either, same reasoning as B3. */
function projectBinding(binding) {
  const metadata = binding.metadata || {};
  const spec = binding.spec || {};
  const status = binding.status || {};
  return {
    id: `${metadata.namespace}/${metadata.name}`,
    name: metadata.name,
    namespace: metadata.namespace,
    secretName: spec.secretName || metadata.name,
    instanceRef: (spec.serviceInstanceName && metadata.namespace)
      ? `${metadata.namespace}/${spec.serviceInstanceName}`
      : null,
    instanceID: status.instanceID || null,
    ready: (status.conditions || []).some(c => c.type === 'Ready' && c.status === 'True'),
    // Readable directly off spec/status, no duration math: see the module note on why
    // staleRotation is deliberately not implemented.
    rotationEnabled: Boolean(spec.credentialsRotationPolicy && spec.credentialsRotationPolicy.enabled),
    neverRotated: !status.lastCredentialsRotationTime,
    createdAt: metadata.creationTimestamp || null
  };
}

/**
 * B4: join instances to bindings. `status.instanceID` is the primary key both sides populate
 * once reconciled; falling back to a (namespace,name) match is only for a binding whose
 * `status.instanceID` has not landed yet (freshly created, or the operator degraded) — using
 * it as anything but a fallback would silently prefer a guess over the operator's own answer.
 */
function reconcileInstancesToBindings(instances, bindings) {
  const byInstanceId = new Map();
  const byNamespaceName = new Map();
  for (const binding of bindings) {
    const meta = binding.metadata || {};
    const status = binding.status || {};
    if (status.instanceID) {
      const matches = byInstanceId.get(status.instanceID) || [];
      matches.push(binding);
      byInstanceId.set(status.instanceID, matches);
    } else {
      const spec = binding.spec || {};
      const key = `${meta.namespace}/${spec.serviceInstanceName}`;
      const matches = byNamespaceName.get(key) || [];
      matches.push(binding);
      byNamespaceName.set(key, matches);
    }
  }

  return instances.map(instance => {
    const meta = instance.metadata || {};
    const status = instance.status || {};
    const key = `${meta.namespace}/${meta.name}`;
    let matched = status.instanceID ? (byInstanceId.get(status.instanceID) || []) : [];
    // Fallback only when the instance itself has no ID to match on yet, or nothing matched
    // by ID — never a second, competing match on top of a real ID hit.
    if (matched.length === 0) matched = byNamespaceName.get(key) || [];
    return {
      id: key,
      boundBindingCount: matched.length,
      boundBindingIds: matched.map(b => `${(b.metadata || {}).namespace}/${(b.metadata || {}).name}`)
    };
  });
}

/**
 * B5: three payload shapes that must never collapse into each other.
 *   crd-absent     the CRD itself does not exist on this cluster (a confirmed 404 on the
 *                  group) — not a fact about any Function/Subscription, so no per-item verdict.
 *   measured-zero  the CRD exists and the list genuinely came back empty.
 *   unavailable    the read failed for a reason that is not a confirmed absence.
 */
function evidenceFor(result) {
  if (result.unavailable) return { evidence: 'unavailable', reason: result.reason, detail: result.detail };
  if (result.absent === true) return { evidence: 'crd-absent' };
  if (result.items.length === 0) {
    // absent === false/null with a genuinely empty items array (safeList never swallowed a
    // 404 here, or the probe already resolved it) is a measured zero either way — the
    // distinction that matters for the evidence field is "did we get to look", not the
    // finer absent/absentEvidence detail, which callers can still read off `result` itself.
    return { evidence: 'measured-zero' };
  }
  return { evidence: 'measured', count: result.items.length };
}

/**
 * A 404 the group probe could not explain is a failed read, never a zero. Only a group the cluster
 * does not register is a true absence; a registered group that does not serve this version, a probe
 * that failed, or a served version whose list still 404'd all mean the read found nothing out.
 * A probe that failed keeps its own reason (`absentProbeReason`): a 403 on discovery is a missing
 * RBAC rule, and reported as UPSTREAM it sent the operator to the API server instead.
 */
function servedOrUnavailable(result) {
  if (result.absent !== null || !result.absentEvidence) return result;
  return { ...result, unavailable: true, reason: result.absentProbeReason || 'UPSTREAM', detail: result.absentEvidence };
}

/**
 * B5: idle-module detector for one Function — has anything ever subscribed to events it
 * might emit, and how confidently do we know that. `noEventSubscribers` names a fact about
 * the eventing subscriptions in this namespace, not a judgement that the Function is unused;
 * a Function can be invoked directly (HTTP, gateway) with zero event subscribers and be
 * perfectly busy.
 */
function functionEventEvidence(fn, subscriptionsByNamespace, subscriptionsEvidence) {
  const meta = fn.metadata || {};
  if (subscriptionsEvidence.evidence === 'unavailable' || subscriptionsEvidence.evidence === 'crd-absent') {
    return { noEventSubscribers: null, evidence: subscriptionsEvidence.evidence };
  }
  const inNamespace = subscriptionsByNamespace.get(meta.namespace) || [];
  const subscribed = inNamespace.some(sub => {
    const sink = (sub.spec && sub.spec.sink) || '';
    // The sink URL Eventing writes for a Function-backed subscriber names the Function's
    // own service, conventionally "<name>.<namespace>.svc.cluster.local" — a substring match
    // on the name is the least brittle check available without parsing the full URL grammar.
    return typeof sink === 'string' && sink.includes(meta.name);
  });
  return { noEventSubscribers: !subscribed, evidence: subscriptionsEvidence.evidence };
}

/**
 * B6: does any workload pod actually consume this ServiceBinding's secret — via a container's
 * `envFrom`, a projected `spec.volumes`, or (optionally) `imagePullSecrets`? Only ever emits a
 * POSITIVE finding, per the task: "this binding IS in use, here, in this cluster." A pod not
 * referencing a binding proves nothing fleet-wide, so there is deliberately no "unused" verdict
 * on the other side of this join.
 */
function bindingUsage(secretName, pods) {
  const consumers = [];
  for (const pod of pods) {
    const meta = pod.metadata || {};
    const spec = pod.spec || {};
    const containers = spec.containers || [];
    const usesEnvFrom = containers.some(c =>
      (c.envFrom || []).some(ef => ef.secretRef && ef.secretRef.name === secretName)
    );
    const usesVolume = (spec.volumes || []).some(v => v.secret && v.secret.secretName === secretName);
    // imagePullSecrets is optional on a workload; absence is not evidence of anything, so it
    // reports null rather than false when the pod simply has none.
    const pullSecrets = Array.isArray(spec.imagePullSecrets) ? spec.imagePullSecrets : null;
    const usesPullSecret = pullSecrets ? pullSecrets.some(s => s.name === secretName) : null;

    if (usesEnvFrom || usesVolume || usesPullSecret === true) {
      consumers.push({
        pod: `${meta.namespace}/${meta.name}`,
        via: { envFrom: usesEnvFrom, volume: usesVolume, imagePullSecret: usesPullSecret }
      });
    }
  }
  return consumers;
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, callFn?: typeof call}} ctx
 * @returns {Promise<object>}
 */
async function collect({ cluster, token, listFn = list, callFn = call }) {
  const baseCtx = { cluster, token };
  const btpGroup = { group: BTP_GROUP, version: BTP_VERSION, callFn };

  const [reads, podsResult] = await Promise.all([
    Promise.all([
      absentList(listFn, baseCtx, INSTANCES_PATH, INSTANCES_LABEL, btpGroup),
      absentList(listFn, baseCtx, BINDINGS_PATH, BINDINGS_LABEL, btpGroup),
      absentList(listFn, baseCtx, FUNCTIONS_PATH, FUNCTIONS_LABEL, {
        group: SERVERLESS_GROUP, version: SERVERLESS_VERSION, callFn
      }),
      absentList(listFn, baseCtx, SUBSCRIPTIONS_PATH, SUBSCRIPTIONS_LABEL, {
        group: EVENTING_GROUP, version: EVENTING_VERSION, callFn
      })
    ]),
    safeList(listFn, baseCtx, PODS_PATH, PODS_LABEL)
  ]);
  const [instancesResult, bindingsResult, functionsResult, subscriptionsResult] = reads.map(servedOrUnavailable);

  const instances = instancesResult.items.map(projectInstance);
  const bindings = bindingsResult.items.map(projectBinding);
  const reconciliation = reconcileInstancesToBindings(instancesResult.items, bindingsResult.items);
  const reconciliationById = new Map(reconciliation.map(r => [r.id, r]));

  // A join is only known when both sides were read. A refused list arrives here as [], so with the
  // bindings refused every instance joined to nothing and was named as unbound.
  const joinRead = !instancesResult.unavailable && !bindingsResult.unavailable;
  const instancesWithNoBindingInThisCluster = joinRead
    ? instances
      .filter(inst => (reconciliationById.get(inst.id) || { boundBindingCount: 0 }).boundBindingCount === 0)
      .map(inst => inst.id)
    : null;
  // referenceScope: 'this-cluster-only' — a binding could legitimately live in a different
  // onboarded cluster (cross-cluster consumption, or a binding not yet onboarded here); this
  // list is never presented as "these instances are unused fleet-wide".

  const subscriptionsEvidence = evidenceFor(subscriptionsResult);
  const functionsEvidence = evidenceFor(functionsResult);
  const subscriptionsByNamespace = new Map();
  for (const sub of subscriptionsResult.items) {
    const ns = (sub.metadata || {}).namespace;
    const arr = subscriptionsByNamespace.get(ns) || [];
    arr.push(sub);
    subscriptionsByNamespace.set(ns, arr);
  }

  const functions = functionsResult.items.map(fn => {
    const meta = fn.metadata || {};
    const { noEventSubscribers, evidence } = functionEventEvidence(fn, subscriptionsByNamespace, subscriptionsEvidence);
    return {
      id: `${meta.namespace}/${meta.name}`,
      name: meta.name,
      namespace: meta.namespace,
      noEventSubscribers,
      subscriptionEvidence: evidence
    };
  });

  const bindingUsageByBinding = bindings.map(b => ({
    binding: b.id,
    secretName: b.secretName,
    consumers: bindingUsage(b.secretName, podsResult.items)
  }));

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    summary: {
      // A list's own count follows the read, and `unavailable` names a refused list (consumers
      // gate with it); only the join below, which a refused side would invent, is null.
      instanceCount: instances.length,
      bindingCount: bindings.length,
      instancesWithNoBindingInThisClusterCount: instancesWithNoBindingInThisCluster
        ? instancesWithNoBindingInThisCluster.length
        : null,
      functionsEvidence,
      subscriptionsEvidence,
      unavailable: unavailableLabels([instancesResult, bindingsResult, functionsResult, subscriptionsResult, podsResult]),
      truncated: truncatedLabels([instancesResult, bindingsResult, functionsResult, subscriptionsResult, podsResult])
    },
    instances,
    bindings,
    instancesWithNoBindingInThisCluster,
    functions,
    bindingUsage: bindingUsageByBinding
  };
}

export default {
  collect,
  projectInstance,
  projectBinding,
  reconcileInstancesToBindings,
  evidenceFor,
  servedOrUnavailable,
  functionEventEvidence,
  bindingUsage
};
