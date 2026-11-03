/**
 * The workload that owns a pod, from ownerReferences and the pod-template-hash label. A ReplicaSet
 * whose name ends in the pod's template hash is a Deployment's, so the Deployment is named.
 * Shared by the service map and the proxy sampler, so both count the same workload.
 */
function ownerOf(pod) {
  const meta = (pod && pod.metadata) || {};
  const refs = meta.ownerReferences || [];
  const owner = refs.find(o => o.controller) || refs[0];
  if (!owner) return { kind: 'Pod', name: meta.name };
  const hash = (meta.labels || {})['pod-template-hash'];
  if (owner.kind === 'ReplicaSet' && hash && owner.name.endsWith(`-${hash}`)) {
    return { kind: 'Deployment', name: owner.name.slice(0, -(hash.length + 1)) };
  }
  return { kind: owner.kind, name: owner.name };
}

export default { ownerOf };
