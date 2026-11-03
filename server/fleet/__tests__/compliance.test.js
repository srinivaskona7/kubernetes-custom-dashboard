import { test } from 'vitest';
import assert from 'node:assert';

import _compliance from '../collectors/compliance.js';
import _complianceModule from '../collectors/compliance.js';
const {
  collect, checkIstio, checkPsa, checkPullSecret, checkRoleBinding, checkEgress,
  PASS, WARN, FAIL, NA
} = _compliance;

const ns = (name, labels = {}) => ({ metadata: { name, labels } });

// ------------------------------------------------------------------ unit checks

test('istio check passes only on istio-injection=enabled', () => {
  assert.strictEqual(checkIstio(ns('a', { 'istio-injection': 'enabled' })).status, PASS);
  assert.strictEqual(checkIstio(ns('a', { 'istio-injection': 'disabled' })).status, FAIL);
  assert.strictEqual(checkIstio(ns('a')).status, FAIL);
});

test('PSA accepts restricted as stricter than baseline, rejects privileged', () => {
  assert.strictEqual(checkPsa(ns('a', { 'pod-security.kubernetes.io/enforce': 'baseline' })).status, PASS);
  const restricted = checkPsa(ns('a', { 'pod-security.kubernetes.io/enforce': 'restricted' }));
  assert.strictEqual(restricted.status, PASS);
  assert.match(restricted.detail, /stricter/);
  assert.strictEqual(checkPsa(ns('a', { 'pod-security.kubernetes.io/enforce': 'privileged' })).status, FAIL);
  assert.strictEqual(checkPsa(ns('a')).status, FAIL);
});

test('an unsealed pull secret warns rather than passes', () => {
  const good = [{ metadata: { name: 'docker-registry-secret' }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': 'e30=' } }];
  assert.strictEqual(checkPullSecret(good).status, PASS);

  const noData = [{ metadata: { name: 'docker-registry-secret' }, type: 'kubernetes.io/dockerconfigjson', data: {} }];
  const w = checkPullSecret(noData);
  assert.strictEqual(w.status, WARN);
  assert.match(w.detail, /SealedSecret may not have been unsealed/);

  const wrongType = [{ metadata: { name: 'docker-registry-secret' }, type: 'Opaque', data: { '.dockerconfigjson': 'e30=' } }];
  assert.strictEqual(checkPullSecret(wrongType).status, WARN);

  assert.strictEqual(checkPullSecret([]).status, FAIL);
});

test('the RoleBinding check matches the deployer SA by namespace as well as name', () => {
  const right = [{
    metadata: { name: 'jenkins-deployer-cluster-admin' },
    roleRef: { kind: 'ClusterRole', name: 'cluster-admin' },
    subjects: [{ kind: 'ServiceAccount', name: 'jenkins-deployer', namespace: 'cicd-serviceaccount' }]
  }];
  assert.strictEqual(checkRoleBinding(right).status, PASS);

  // A same-named SA in a different namespace is a different identity and must not pass.
  const impostor = [{
    metadata: { name: 'x' },
    roleRef: { kind: 'ClusterRole', name: 'cluster-admin' },
    subjects: [{ kind: 'ServiceAccount', name: 'jenkins-deployer', namespace: 'somewhere-else' }]
  }];
  assert.strictEqual(checkRoleBinding(impostor).status, FAIL);

  const failed = checkRoleBinding([]);
  assert.strictEqual(failed.status, FAIL);
  assert.match(failed.detail, /403/, 'the finding should say what will actually break');
});

test('an egress policy that does not restrict egress warns', () => {
  const real = [{ metadata: { name: 'egress-allow-btp-traffic' }, spec: { policyTypes: ['Egress'] } }];
  assert.strictEqual(checkEgress(real).status, PASS);

  const ingressOnly = [{ metadata: { name: 'egress-allow-btp-traffic' }, spec: { policyTypes: ['Ingress'] } }];
  assert.strictEqual(checkEgress(ingressOnly).status, WARN);

  assert.strictEqual(checkEgress([]).status, FAIL);
});

// ------------------------------------------------------- the collector as a whole

/** A stand-in for k8s.list that answers by matching the path the collector asks for. */
function fakeList(responses) {
  return async ({ path }) => {
    const key = Object.keys(responses).find(k => path.includes(k));
    return key ? responses[key] : [];
  };
}

test('the collector groups cluster-wide lists by namespace and grades each one', async () => {
  const listFn = fakeList({
    '/api/v1/namespaces': [
      ns('btp-platform-foundation', { 'istio-injection': 'enabled', 'pod-security.kubernetes.io/enforce': 'baseline' }),
      ns('btp-cloud-gateway'),
      ns('kube-system')
    ],
    'secrets': [{
      metadata: { name: 'docker-registry-secret', namespace: 'btp-platform-foundation' },
      type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': 'e30=' }
    }],
    'rolebindings': [{
      metadata: { name: 'jenkins-deployer-x', namespace: 'btp-platform-foundation' },
      roleRef: { kind: 'ClusterRole', name: 'app-platform-cicd-deployer-role' },
      subjects: [{ kind: 'ServiceAccount', name: 'jenkins-deployer', namespace: 'cicd-serviceaccount' }]
    }],
    'networkpolicies': [{
      metadata: { name: 'egress-allow-btp-traffic', namespace: 'btp-platform-foundation' },
      spec: { policyTypes: ['Egress'] }
    }]
  });

  const out = await collect({ cluster: { id: 'platformsbx' }, token: 'x', listFn });

  const foundation = out.namespaces.find(n => n.namespace === 'btp-platform-foundation');
  assert.strictEqual(foundation.verdict, 'compliant');
  assert.strictEqual(foundation.findings, 0);

  // This is the real sbx situation: btp-cloud-gateway exists on the cluster but is not
  // in helm-values/platform-sbx.yaml, so it never got the bootstrap treatment.
  const gateway = out.namespaces.find(n => n.namespace === 'btp-cloud-gateway');
  assert.strictEqual(gateway.verdict, 'findings');
  assert.strictEqual(gateway.findings, 5, 'a namespace the chart never touched fails every check');

  const system = out.namespaces.find(n => n.namespace === 'kube-system');
  assert.strictEqual(system.verdict, 'system');
  assert.strictEqual(system.checks.filter(c => c.status === NA).length, 4);

  assert.deepStrictEqual(out.summary, {
    audited: 2, compliant: 1, withWarnings: 0, withFindings: 1, systemSkipped: 1,
    // This fixture's listFn answers /api/v1/pods with an empty list, which is a successful read
    // of a cluster with no pods — so the counts are known and there is no reason to report.
    podCountReason: null,
    unavailable: [], truncated: []
  });
});

test('system namespaces are excluded from the audited totals', async () => {
  const listFn = fakeList({
    '/api/v1/namespaces': [ns('kube-system'), ns('istio-system'), ns('sealed-secrets'), ns('cicd-serviceaccount')]
  });
  const out = await collect({ cluster: { id: 'platformsbx' }, token: 'x', listFn });
  assert.strictEqual(out.summary.audited, 0);
  assert.strictEqual(out.summary.systemSkipped, 4);
});

test('default is an application namespace, audited like any other', async () => {
  // `default` is where a workload lands when nobody named a namespace, so it is the operator's, not
  // the platform's. Security imports the same set, so this also puts it in the app-namespace counts.
  const { SYSTEM_NAMESPACES } = _complianceModule;
  assert.strictEqual(SYSTEM_NAMESPACES.has('default'), false);

  const listFn = fakeList({ '/api/v1/namespaces': [ns('default'), ns('kube-system')] });
  const out = await collect({ cluster: { id: 'platformsbx' }, token: 'x', listFn });
  const def = out.namespaces.find(n => n.namespace === 'default');
  assert.strictEqual(def.system, false);
  assert.strictEqual(def.verdict, 'findings', 'an unbootstrapped default fails the checks it has not met');
  assert.strictEqual(out.summary.audited, 1);
  assert.strictEqual(out.summary.systemSkipped, 1);
});
