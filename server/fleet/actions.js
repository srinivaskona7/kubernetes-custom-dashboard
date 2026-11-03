/**
 * Rollout status.
 *
 * This module was named for write actions and held two: `restart` (a strategic-merge PATCH of
 * the pod template annotation) and `scale` (a PATCH of the /scale subresource). Both are
 * removed. Kyma Fleet is a strictly read-only observability and investigation platform — it
 * must never mutate cluster state — so the functions are gone rather than merely unrouted. An
 * unreachable PATCH is still a PATCH one `require` away, and "no mutation" has to be a property
 * of the code, not of the current wiring.
 *
 * What is left is a GET: read one workload and report whether the rollout it is in the middle
 * of has actually landed. That was always the more useful half — it answers the question an
 * operator arrives with. Acting on the answer belongs in their own kubectl session, where the
 * change is audited as theirs.
 */
import k8sModule from './k8s.js';
const { call } = k8sModule;

const KINDS = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets'
};

/**
 * Current rollout progress for one workload. A read: GET the object and compare
 * observedGeneration/updatedReplicas/availableReplicas against spec.replicas.
 */
async function rolloutStatus({ cluster, token, namespace, name, kind = 'Deployment', callFn = call }) {
  const plural = KINDS[kind];
  if (!plural) throw Object.assign(new Error(`unsupported kind ${kind}`), { status: 400 });

  const obj = await callFn({
    cluster, token,
    path: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/${plural}/${encodeURIComponent(name)}`
  });
  const spec = obj.spec || {};
  const status = obj.status || {};
  const desired = spec.replicas === undefined ? 1 : spec.replicas;
  const updated = status.updatedReplicas || 0;
  const available = status.availableReplicas || 0;

  const settled = (status.observedGeneration || 0) >= (obj.metadata.generation || 0)
    && updated === desired
    && available === desired;

  return {
    cluster: cluster.id, namespace, name, kind,
    desired, updated, available,
    ready: status.readyReplicas || 0,
    complete: settled,
    restartedAt: (((spec.template || {}).metadata || {}).annotations || {})['kubectl.kubernetes.io/restartedAt'] || null,
    conditions: (status.conditions || []).map(c => ({
      type: c.type, status: c.status, reason: c.reason || null, message: c.message || null
    }))
  };
}

export default { rolloutStatus, KINDS };
