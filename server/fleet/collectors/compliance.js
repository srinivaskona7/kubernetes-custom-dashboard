/**
 * Namespace bootstrap compliance — does a namespace actually have the treatment the
 * `namespace-bootstrapping` Helm chart is supposed to give it?
 *
 * This is the audit the charts themselves cannot perform. `helm upgrade` reports success
 * when it applied what it was told to apply; it cannot tell you that a namespace was
 * created by hand six weeks ago and was never in any values file. The checks below are
 * derived one-for-one from the chart templates in btp-kyma-sapdevsecops:
 *
 *   namespaces.yaml       -> istio-injection, pod-security enforce
 *   sealed-secrets.yaml   -> docker-registry-secret
 *   rolebindings.yaml     -> a RoleBinding onto cicd-serviceaccount/jenkins-deployer
 *   egress-network-policies/ -> NetworkPolicy egress-allow-btp-traffic
 *
 * Strictly read-only, and it never proposes to fix anything on its own — the remediation
 * shown in the UI is the operator's own `helm upgrade` command, run by a human.
 */
import k8sModule from '../k8s.js';
const { list, METADATA_ONLY } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;

/**
 * Namespaces that belong to Kubernetes, Istio, Kyma or the bootstrap tooling itself.
 * Auditing them against an application-namespace policy produces noise, not findings:
 * nobody wants a report saying kube-system is missing its Jenkins RoleBinding.
 *
 * `default` is deliberately absent: it is where a workload lands when nobody named a namespace,
 * so it is the operator's and is audited like any application namespace.
 */
const SYSTEM_NAMESPACES = new Set([
  'kube-system', 'kube-public', 'kube-node-lease',
  'istio-system', 'kyma-system', 'kyma-integration',
  'sealed-secrets', 'cicd-serviceaccount', 'gatekeeper-system',
  'compass-system', 'serverless', 'fleet-dashboard'
]);

const CICD_NAMESPACE = 'cicd-serviceaccount';
const DEPLOYER_SA = 'jenkins-deployer';
const PULL_SECRET = 'docker-registry-secret';
const EGRESS_POLICY = 'egress-allow-btp-traffic';

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';
const NA = 'na';

/** One check result. `inspected` is the literal thing looked at, shown in the UI. */
function result(id, name, status, inspected, detail) {
  return { id, name, status, inspected, detail: detail || null };
}

function checkIstio(ns) {
  const labels = ns.metadata.labels || {};
  const value = labels['istio-injection'];
  // Revision-tagged injection (`istio.io/rev=<revision>`) is the modern, canary-safe
  // replacement for the boolean label and is equally valid — a namespace pinned to a
  // specific Istio control-plane revision must not be reported as uninjected just because
  // it opted into the more precise of the two mechanisms.
  const revision = Object.keys(labels).find(k => k === 'istio.io/rev' || k.startsWith('istio.io/rev'));
  const ok = value === 'enabled' || Boolean(revision && labels[revision]);
  const inspected = revision && ok
    ? `label ${revision}=${labels[revision]}`
    : 'label istio-injection=enabled';
  return result(
    'istio', 'Istio injection', ok ? PASS : FAIL,
    inspected,
    ok ? null : `label is ${value === undefined ? 'absent' : `"${value}"`}; sidecars will not be injected and mTLS will not apply`
  );
}

function checkPsa(ns) {
  const labels = ns.metadata.labels || {};
  const value = labels['pod-security.kubernetes.io/enforce'];
  if (value === 'baseline' || value === 'restricted') {
    // restricted is stricter than the chart asks for, so it passes rather than warns.
    return result('psa', 'PSA baseline', PASS, 'label pod-security.kubernetes.io/enforce=baseline',
      value === 'restricted' ? 'enforcing "restricted", stricter than the baseline the chart sets' : null);
  }
  if (value === 'privileged') {
    return result('psa', 'PSA baseline', FAIL, 'label pod-security.kubernetes.io/enforce=baseline',
      'enforcing "privileged" — the namespace accepts pods the baseline profile would reject');
  }
  return result('psa', 'PSA baseline', FAIL, 'label pod-security.kubernetes.io/enforce=baseline',
    'label is absent; no Pod Security Standard is enforced in this namespace');
}

function checkPullSecret(secrets) {
  const secret = secrets.find(s => s.metadata.name === PULL_SECRET);
  if (!secret) {
    return result('pullSecret', 'Pull secret', FAIL, `secret ${PULL_SECRET}`,
      'absent; pods referencing it will fail to pull images with ImagePullBackOff');
  }
  if (secret.type !== 'kubernetes.io/dockerconfigjson') {
    return result('pullSecret', 'Pull secret', WARN, `secret ${PULL_SECRET}`,
      `exists but its type is "${secret.type}", not kubernetes.io/dockerconfigjson`);
  }
  // A SealedSecret that has not been unsealed leaves a Secret with no data behind.
  const keys = Object.keys(secret.data || {});
  if (!keys.includes('.dockerconfigjson')) {
    return result('pullSecret', 'Pull secret', WARN, `secret ${PULL_SECRET}`,
      'exists with the right type but has no .dockerconfigjson key — the SealedSecret may not have been unsealed');
  }
  return result('pullSecret', 'Pull secret', PASS, `secret ${PULL_SECRET}`, null);
}

function checkRoleBinding(roleBindings) {
  const bound = roleBindings.filter(rb =>
    (rb.subjects || []).some(s =>
      s.kind === 'ServiceAccount' && s.name === DEPLOYER_SA && s.namespace === CICD_NAMESPACE
    )
  );
  if (bound.length === 0) {
    return result('roleBinding', 'Deployer RoleBinding', FAIL,
      `rolebinding -> ${CICD_NAMESPACE}/${DEPLOYER_SA}`,
      `nothing in this namespace binds ${CICD_NAMESPACE}/${DEPLOYER_SA}; Jenkins deploys here will fail with a 403`);
  }
  const roles = bound.map(rb => `${rb.roleRef.kind}/${rb.roleRef.name}`);
  return result('roleBinding', 'Deployer RoleBinding', PASS,
    `rolebinding -> ${CICD_NAMESPACE}/${DEPLOYER_SA}`, `bound to ${roles.join(', ')}`);
}

function checkEgress(policies) {
  const policy = policies.find(p => p.metadata.name === EGRESS_POLICY);
  if (!policy) {
    return result('egress', 'Egress policy', FAIL, `networkpolicy ${EGRESS_POLICY}`,
      'absent; pods in this namespace have unrestricted egress');
  }
  const types = policy.spec.policyTypes || [];
  if (!types.includes('Egress')) {
    return result('egress', 'Egress policy', WARN, `networkpolicy ${EGRESS_POLICY}`,
      `exists but its policyTypes are [${types.join(', ')}] — it does not restrict egress`);
  }
  return result('egress', 'Egress policy', PASS, `networkpolicy ${EGRESS_POLICY}`, null);
}

/**
 * How many Pods live in each namespace, or `null` for every namespace if the answer cannot be
 * trusted.
 *
 * Read `PartialObjectMetadataList`: a cluster-wide pod list is the largest collection this
 * console touches (3.5 MB plain on a small cluster), and a count needs the namespace field and
 * nothing else — the metadata-only form measured ~32x smaller.
 *
 * The all-or-nothing null is the point. A refused read is obvious, but a *truncated* one is the
 * dangerous case: the pods came back, they are real, and they are short. Rendered as numbers they
 * are an undercount that looks exactly like a count, and the namespace that lost rows is
 * whichever one the paging ceiling happened to fall in. There is no per-namespace way to know, so
 * no namespace gets a number.
 *
 * @returns {{counts: Map<string, number>|null, reason: 'unavailable'|'truncated'|null}}
 */
function podCounts(result) {
  if (result.unavailable) return { counts: null, reason: 'unavailable' };
  if (result.truncated) return { counts: null, reason: 'truncated' };
  const counts = new Map();
  for (const pod of result.items) {
    const ns = pod && pod.metadata && pod.metadata.namespace;
    if (!ns) continue;
    counts.set(ns, (counts.get(ns) || 0) + 1);
  }
  return { counts, reason: null };
}

/**
 * Audit every namespace on one cluster.
 *
 * Five list calls total for the whole cluster, not five per namespace — the results are
 * grouped in memory. On a cluster with thirty namespaces that is the difference between
 * 5 requests and 150.
 *
 * @param {{cluster: object, token: string, listFn?: typeof list}} ctx
 *   listFn is an injection seam; the default is the real k8s client.
 */
async function collect({ cluster, token, listFn = list }) {
  const baseCtx = { cluster, token };
  const [namespacesResult, secretsResult, roleBindingsResult, policiesResult, podsResult] = await Promise.all([
    safeList(listFn, baseCtx, '/api/v1/namespaces', 'namespaces'),
    // fieldSelector keeps the payload to the one Secret we care about per namespace
    // instead of every Secret on the cluster, which would include Helm release blobs.
    safeList(listFn, baseCtx, `/api/v1/secrets?fieldSelector=metadata.name%3D${PULL_SECRET}`, 'secrets'),
    safeList(listFn, baseCtx, '/apis/rbac.authorization.k8s.io/v1/rolebindings', 'rolebindings'),
    safeList(listFn, baseCtx, '/apis/networking.k8s.io/v1/networkpolicies', 'networkpolicies'),
    // Wrapped rather than passed through: `safeList` forwards only `path`, and the Accept header
    // is what makes this read cheap. It is also part of k8s.js's list-cache key, so the
    // metadata-only copy can never be served to a caller that wanted the full pod.
    safeList(a => listFn({ ...a, accept: METADATA_ONLY }), baseCtx, '/api/v1/pods', 'pods')
  ]);

  const namespaces = namespacesResult.items;
  const secrets = secretsResult.items;
  const roleBindings = roleBindingsResult.items;
  const policies = policiesResult.items;

  const byNamespace = (items) => {
    const map = new Map();
    for (const item of items) {
      const ns = item.metadata.namespace;
      if (!map.has(ns)) map.set(ns, []);
      map.get(ns).push(item);
    }
    return map;
  };

  const secretsByNs = byNamespace(secrets);
  const rbByNs = byNamespace(roleBindings);
  const npByNs = byNamespace(policies);
  const { counts: podsByNs, reason: podCountReason } = podCounts(podsResult);
  // A namespace absent from the map really has no pods; a map that is absent means we do not
  // know. Only the second is null — see `podCounts`.
  const podsIn = name => (podsByNs ? podsByNs.get(name) || 0 : null);

  const rows = namespaces.map(ns => {
    const name = ns.metadata.name;
    const system = SYSTEM_NAMESPACES.has(name) || name.startsWith('kube-');

    if (system) {
      // System namespaces get the istio check only — whether the mesh covers them is a
      // real question — and everything else is marked not-applicable.
      const checks = [
        checkIstio(ns),
        result('psa', 'PSA baseline', NA, 'not audited for system namespaces'),
        result('pullSecret', 'Pull secret', NA, 'not audited for system namespaces'),
        result('roleBinding', 'Deployer RoleBinding', NA, 'not audited for system namespaces'),
        result('egress', 'Egress policy', NA, 'not audited for system namespaces')
      ];
      return { namespace: name, cluster: cluster.id, system: true, pods: podsIn(name), verdict: 'system', findings: 0, warnings: 0, checks };
    }

    const checks = [
      checkIstio(ns),
      checkPsa(ns),
      checkPullSecret(secretsByNs.get(name) || []),
      checkRoleBinding(rbByNs.get(name) || []),
      checkEgress(npByNs.get(name) || [])
    ];
    const findings = checks.filter(c => c.status === FAIL).length;
    const warnings = checks.filter(c => c.status === WARN).length;

    return {
      namespace: name,
      cluster: cluster.id,
      system: false,
      pods: podsIn(name),
      verdict: findings > 0 ? 'findings' : warnings > 0 ? 'warnings' : 'compliant',
      findings,
      warnings,
      checks
    };
  });

  const audited = rows.filter(r => !r.system);
  return {
    summary: {
      audited: audited.length,
      compliant: audited.filter(r => r.verdict === 'compliant').length,
      withWarnings: audited.filter(r => r.verdict === 'warnings').length,
      withFindings: audited.filter(r => r.verdict === 'findings').length,
      systemSkipped: rows.length - audited.length,
      // Deliberately NOT folded into `unavailable` / `truncated` below. Those two describe the
      // bootstrap audit, and a refused pod list does not make the audit any less complete — it
      // would turn every compliance verdict on the page amber for a count that is beside them.
      podCountReason,
      unavailable: unavailableLabels([namespacesResult, secretsResult, roleBindingsResult, policiesResult]),
      truncated: truncatedLabels([namespacesResult, secretsResult, roleBindingsResult, policiesResult])
    },
    namespaces: rows
  };
}

export default {
  collect, SYSTEM_NAMESPACES, PASS, WARN, FAIL, NA, podCounts,
  checkIstio, checkPsa, checkPullSecret, checkRoleBinding, checkEgress
};
