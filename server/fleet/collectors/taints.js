
/**
 * Node taints and pod tolerations, and the four ways this pairing lies.
 *
 * A taint is a node saying "do not schedule here unless you hold a matching toleration". A
 * toleration is a pod saying "I am willing". The pairing looks like a simple join and is not one:
 *
 *  1. **Every pod has tolerations.** The DefaultTolerationSeconds admission controller injects
 *     `node.kubernetes.io/not-ready` and `node.kubernetes.io/unreachable` (NoExecute, 300s) into
 *     essentially every pod on the cluster. Measured on a live 120-pod cluster: 120 of 120 pods
 *     carried a toleration, and only 50 carried one a human wrote. A list of "pods with
 *     tolerations" is therefore a list of every pod, which ranks nothing. `authored()` is the
 *     filter that makes the question answerable, and the defaults stay reachable rather than
 *     being dropped — a pod whose *only* tolerations are the defaults is a real answer.
 *
 *  2. **A toleration is permission, never placement.** A pod holding a toleration for a taint was
 *     not necessarily scheduled because of it, and is very often not on a tainted node at all.
 *     Nothing here derives "this pod is on that node because of this toleration"; the node name
 *     travels alongside as a fact about where the pod is, and `matchesTaint` answers only
 *     "would this toleration permit that taint", which is a different and much weaker claim.
 *
 *  3. **An empty field is a wildcard, not an absence.** `operator: Exists` with no `key` tolerates
 *     EVERY taint. An empty `effect` matches every effect. This is the highest-consequence rule
 *     here and the easiest to render backwards: a row with blank cells is the most permissive
 *     toleration on the cluster, not the least. Measured: 42 of 50 authored tolerations on the
 *     live cluster were exactly this universal form. `isUniversal()` names it so the UI can.
 *
 *  4. **Zero taints is a true zero.** A cluster where no node declares a taint reads identically
 *     to a cluster whose node list failed — unless the two are kept apart. The caller passes the
 *     node read's own outcome; `summarize` never infers "no taints" from an absent list.
 *
 * `tolerationSeconds` applies to NoExecute only: it is how long an already-running pod is allowed
 * to stay after the taint appears, not a scheduling input. Reporting it on a NoSchedule toleration
 * would be reporting a field Kubernetes ignores.
 */

/**
 * The two tolerations Kubernetes injects itself. Matched on key AND effect: a pod that explicitly
 * declares `not-ready:NoSchedule` wrote that itself — it is not the injected NoExecute default, and
 * three pods on the live cluster do exactly this.
 */
const INJECTED = [
  { key: 'node.kubernetes.io/not-ready', effect: 'NoExecute' },
  { key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' }
];

/** True for a toleration the admission controller added rather than a human. */
function isInjectedDefault(t) {
  if (!t) return false;
  return INJECTED.some(d => d.key === t.key && d.effect === t.effect);
}

/**
 * True when this toleration tolerates every taint on the cluster.
 *
 * `operator: Exists` with no key is the Kubernetes wildcard. Combined with an empty effect it
 * defeats every taint a node can carry, which is why a DaemonSet that must run everywhere declares
 * it. Rendered without a name it is a row of blanks that reads as "nothing set".
 */
function isUniversal(t) {
  if (!t) return false;
  return t.operator === 'Exists' && !t.key;
}

/**
 * Would this toleration permit this taint?
 *
 * Kubernetes' own rule, not an approximation of it: the effects must match (or the toleration
 * declares no effect, meaning all), and then either the toleration has no key (wildcard), or the
 * keys match under the declared operator. `Exists` ignores the value entirely; `Equal` — the
 * default when `operator` is absent — requires the values to be equal, treating both absent values
 * as the empty string, which is how the API server compares them.
 */
function matchesTaint(toleration, taint) {
  if (!toleration || !taint) return false;
  if (toleration.effect && toleration.effect !== taint.effect) return false;
  if (!toleration.key) return toleration.operator === 'Exists';
  if (toleration.key !== taint.key) return false;
  if (toleration.operator === 'Exists') return true;
  return (toleration.value || '') === (taint.value || '');
}

/** The tolerations on this pod that a human wrote, in declaration order. */
function authored(tolerations) {
  return ((tolerations || [])).filter(t => !isInjectedDefault(t));
}

/** A taint as one stable string, used as an identity across the node and pod reads. */
function taintId(t) {
  return `${t.key || ''}=${t.value || ''}:${t.effect || ''}`;
}

/**
 * Project one node's taints.
 *
 * `effect` is reported verbatim and never defaulted: a taint with no effect is not a thing the API
 * server accepts, so an absent one means the read is malformed and saying so beats inventing
 * NoSchedule.
 */
function nodeTaints(node) {
  const name = (node.metadata && node.metadata.name) || null;
  return (((node.spec && node.spec.taints) || [])).map(t => ({
    id: taintId(t),
    node: name,
    key: t.key || null,
    value: t.value || null,
    effect: t.effect || null,
    timeAdded: t.timeAdded || null
  }));
}

/**
 * Project one pod's tolerations against the cluster's actual taints.
 *
 * `inert` is the load-bearing field. A toleration that matches no taint anywhere on the cluster
 * grants nothing today — on a cluster with no taints at all, that is every toleration on it. Saying
 * so is what stops the tab implying 42 pods are being let somewhere special when no node is
 * restricting anything. It is explicitly `null`, not `true`, when the node read did not succeed:
 * "this grants nothing" and "we could not check" are different answers.
 */
function podTolerations(pod, allTaints, nodesRead) {
  const spec = pod.spec || {};
  const list = authored(spec.tolerations);
  const tolerations = list.map(t => {
    const matched = nodesRead ? allTaints.filter(x => matchesTaint(t, x)) : [];
    return {
      key: t.key || null,
      value: t.value || null,
      operator: t.operator || 'Equal',
      effect: t.effect || null,
      tolerationSeconds: t.effect === 'NoExecute' || !t.effect ? (t.tolerationSeconds ?? null) : null,
      universal: isUniversal(t),
      // null means unchecked, not "matches nothing".
      inert: nodesRead ? matched.length === 0 : null,
      matchesNodes: nodesRead ? [...new Set(matched.map(x => x.node))].sort() : []
    };
  });
  return {
    name: (pod.metadata && pod.metadata.name) || null,
    namespace: (pod.metadata && pod.metadata.namespace) || null,
    node: spec.nodeName || null,
    phase: (pod.status && pod.status.phase) || null,
    tolerations,
    // A pod whose only tolerations were injected still belongs in the "all pods" view, so the
    // count of what was hidden travels with it rather than being silently dropped.
    injectedCount: (spec.tolerations || []).length - list.length
  };
}

/**
 * Build both sub-tab payloads from one node read and one pod read.
 *
 * `nodesRead` is the node list's own outcome, passed in rather than inferred. Without it a cluster
 * whose node read failed reports "no node declares a taint", which is the confident-zero failure
 * this project treats as a bug rather than a rounding issue.
 */
function collectTaints(nodes, pods, { nodesRead = true, podsRead = true } = {}) {
  const taints = (nodes || []).flatMap(nodeTaints);
  const tolerating = (pods || []).map(p => podTolerations(p, taints, nodesRead));

  // Pods that tolerate each taint — permission to land there, NOT a claim any of them did.
  const byTaint = taints.map(t => {
    const permitted = tolerating.filter(p =>
      (p.tolerations || []).some(x =>
        matchesTaint({ key: x.key, value: x.value, operator: x.operator, effect: x.effect }, t)
      )
    );
    return {
      ...t,
      podsTolerating: permitted.length,
      // Of those permitted, the ones actually placed on this node. The gap between the two
      // numbers is the point: tolerating a taint is not being scheduled by it.
      podsOnNode: permitted.filter(p => p.node === t.node).length
    };
  });

  const authoredPods = tolerating.filter(p => p.tolerations.length > 0);
  return {
    summary: {
      nodesReporting: nodesRead ? (nodes || []).length : null,
      taints: nodesRead ? taints.length : null,
      // Distinct across nodes: one taint applied to a whole worker pool is one policy, N rows.
      distinctTaints: nodesRead ? new Set(taints.map(t => t.id)).size : null,
      taintedNodes: nodesRead ? new Set(taints.map(t => t.node)).size : null,
      podsRead: podsRead ? (pods || []).length : null,
      podsWithAuthoredTolerations: podsRead ? authoredPods.length : null,
      // The headline that keeps the tab honest on an untainted cluster.
      podsWithUniversalToleration: podsRead
        ? authoredPods.filter(p => p.tolerations.some(t => t.universal)).length
        : null,
      allTolerationsInert:
        nodesRead && podsRead && taints.length === 0 && authoredPods.length > 0 ? true : false
    },
    taints: byTaint,
    pods: tolerating
  };
}

export default {
  INJECTED,
  authored,
  collectTaints,
  isInjectedDefault,
  isUniversal,
  matchesTaint,
  nodeTaints,
  podTolerations,
  taintId
};
