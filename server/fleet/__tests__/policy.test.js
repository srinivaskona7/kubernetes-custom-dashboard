/**
 * Policy & governance collector — admission enforcement verdict (C1), fail-closed webhook
 * blast radius (C2), and PodDisruptionBudget coverage (C3).
 *
 * Every list is an injected double; no test opens a socket.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import policy from '../collectors/policy.js';
const { collect, selectorMatches, effectiveAdmissionActions, backendStatus, failClosedRisk, effectiveReplicas, constraintPlural } = policy;
import _errors from '../errors.js';
const { ClusterError } = _errors;

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

const notFound = new ClusterError('UPSTREAM', '404 Not Found: the server could not find the requested resource', { status: 404 });
const forbidden = () => new ClusterError('FORBIDDEN', 'forbidden: no RBAC rule', { status: 403 });

/** Route by substring, same convention every collector test in this repo uses. */
function fakeList(responses) {
  return async ({ path }) => {
    const key = Object.keys(responses).find(k => path.includes(k));
    if (key) {
      const value = responses[key];
      if (value instanceof Error) throw value;
      return value;
    }
    return [];
  };
}

/** callFn double for the group-discovery probe absentList makes on a swallowed 404. */
function fakeCall(groups) {
  return async ({ path }) => {
    const match = /\/apis\/([^/]+)$/.exec(path);
    const group = match && match[1];
    if (group && groups[group]) return { versions: groups[group].map(v => ({ version: v })) };
    throw notFound;
  };
}

// ------------------------------------------------------------------ shared helpers

test('selectorMatches: matchLabels and matchExpressions, absent selector matches everything', () => {
  assert.equal(selectorMatches({ app: 'x' }, null), true);
  assert.equal(selectorMatches({ app: 'x' }, {}), true);
  assert.equal(selectorMatches({ app: 'x' }, { matchLabels: { app: 'x' } }), true);
  assert.equal(selectorMatches({ app: 'y' }, { matchLabels: { app: 'x' } }), false);
  assert.equal(selectorMatches({ env: 'prod' }, { matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'staging'] }] }), true);
  assert.equal(selectorMatches({ env: 'dev' }, { matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'staging'] }] }), false);
  assert.equal(selectorMatches({}, { matchExpressions: [{ key: 'env', operator: 'DoesNotExist' }] }), true);
  assert.equal(selectorMatches({ env: 'x' }, { matchExpressions: [{ key: 'env', operator: 'DoesNotExist' }] }), false);
});

test('constraintPlural is the ConstraintTemplate\'s own metadata.name, never a guessed plural', () => {
  const ct = { metadata: { name: 'k8srequiredlabels' }, spec: { crd: { spec: { names: { kind: 'K8sRequiredLabels' } } } } };
  assert.equal(constraintPlural(ct), 'k8srequiredlabels');
});

// ------------------------------------------------------------------ C1: admission verdict

test('effectiveAdmissionActions: absent enforcementAction defaults to deny', () => {
  assert.deepEqual(effectiveAdmissionActions({ spec: {} }), ['deny']);
});

test('effectiveAdmissionActions: scoped only counts entries for the validation enforcement point', () => {
  const scoped = {
    spec: {
      enforcementAction: 'scoped',
      scopedEnforcementActions: [
        { action: 'warn', enforcementPoints: [{ name: 'validation.gatekeeper.sh' }] },
        { action: 'deny', enforcementPoints: [{ name: 'gator' }] }
      ]
    }
  };
  // CANARY: without the enforcementPoint filter this would also return 'deny' from the
  // gator-only entry, which does not run at admission at all.
  assert.deepEqual(effectiveAdmissionActions(scoped), ['warn']);

  const noMatch = { spec: { enforcementAction: 'scoped', scopedEnforcementActions: [{ action: 'deny', enforcementPoints: [{ name: 'gator' }] }] } };
  assert.deepEqual(effectiveAdmissionActions(noMatch), []);
});

function admissionFixture({ templates = [], constraints = {}, webhookConfigs = [], slices = [] } = {}) {
  const listFn = fakeList({
    validatingwebhookconfigurations: webhookConfigs,
    mutatingwebhookconfigurations: [],
    validatingadmissionpolicybindings: [],
    validatingadmissionpolicies: [],
    constrainttemplates: templates,
    namespaces: [],
    endpointslices: slices,
    deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const constraintListFn = async ({ path }) => {
    for (const plural of Object.keys(constraints)) {
      if (path.includes(`/${plural}`)) {
        const v = constraints[plural];
        if (v instanceof Error) throw v;
        return v;
      }
    }
    return listFn({ path });
  };
  return constraintListFn;
}

const gatekeeperWebhookConfig = (name, service = { name: 'gatekeeper-webhook-service', namespace: 'gatekeeper-system' }) => ({
  metadata: { name: 'gatekeeper-validating-webhook-configuration' },
  webhooks: [{ name, clientConfig: { service }, rules: [] }]
});

const readySlice = (svcName, ns) => ({
  metadata: { namespace: ns, labels: { 'kubernetes.io/service-name': svcName } },
  endpoints: [{ conditions: { ready: true } }]
});
const deadSlice = (svcName, ns) => ({
  metadata: { namespace: ns, labels: { 'kubernetes.io/service-name': svcName } },
  endpoints: [{ conditions: { ready: false } }]
});

test('policyEngineVerdict is "enforcing" only with a live webhook AND a real admission action', async () => {
  const template = { metadata: { name: 'k8srequiredlabels' }, spec: { crd: { spec: { names: { kind: 'K8sRequiredLabels' } } } } };
  const listFn = admissionFixture({
    templates: [template],
    constraints: { k8srequiredlabels: [{ spec: {} }] }, // enforcementAction absent -> deny
    webhookConfigs: [gatekeeperWebhookConfig('validation.gatekeeper.sh')],
    slices: [readySlice('gatekeeper-webhook-service', 'gatekeeper-system')]
  });

  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.admission.policyEngineVerdict, 'enforcing');
  assert.equal(out.summary.policyEngineVerdict, 'enforcing');

  // CANARY: same fixture, but the webhook's own endpoints are all ready:false — the verdict
  // must flip to the dedicated suspended state, not stay "enforcing".
  const suspendedListFn = admissionFixture({
    templates: [template],
    constraints: { k8srequiredlabels: [{ spec: {} }] },
    webhookConfigs: [gatekeeperWebhookConfig('validation.gatekeeper.sh')],
    slices: [deadSlice('gatekeeper-webhook-service', 'gatekeeper-system')]
  });
  const suspended = await collect({ cluster, token: 't', listFn: suspendedListFn });
  assert.equal(suspended.admission.policyEngineVerdict, 'enforcement-suspended');
});

test('policyEngineVerdict is "installed-inert" when constraints exist but none enforce at admission', async () => {
  const template = { metadata: { name: 'k8sallowedrepos' }, spec: { crd: { spec: { names: { kind: 'K8sAllowedRepos' } } } } };
  const listFn = admissionFixture({
    templates: [template],
    constraints: { k8sallowedrepos: [{ spec: { enforcementAction: 'dryrun' } }] },
    webhookConfigs: [gatekeeperWebhookConfig('validation.gatekeeper.sh')],
    slices: [readySlice('gatekeeper-webhook-service', 'gatekeeper-system')]
  });
  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.admission.policyEngineVerdict, 'installed-inert');
});

test('policyEngineVerdict is "absent" when Gatekeeper is confirmed not installed', async () => {
  // constrainttemplates itself 404s; absentList needs a callFn to confirm the group is gone.
  const listFn = admissionFixture({ templates: notFound, webhookConfigs: [] });
  const out = await collect({
    cluster, token: 't',
    listFn,
    callFn: fakeCall({}) // no groups served at all -> group probe 404s -> absent: true
  });
  assert.equal(out.admission.policyEngineVerdict, 'absent');
});

test('policyEngineVerdict is plainly "unknown" past 25 ConstraintTemplates, never a dressed-up partial answer', async () => {
  const templates = Array.from({ length: 26 }, (_, i) => ({
    metadata: { name: `template${i}` }, spec: { crd: { spec: { names: { kind: `Template${i}` } } } }
  }));
  const listFn = admissionFixture({ templates, webhookConfigs: [gatekeeperWebhookConfig('validation.gatekeeper.sh')] });
  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.admission.policyEngineVerdict, 'unknown');

  // CANARY: one fewer template and the same fixture produces a real verdict, proving the
  // 'unknown' above comes from the count, not from some other property of the fixture.
  const under = templates.slice(0, 25);
  const listFnUnder = admissionFixture({ templates: under, constraints: {}, webhookConfigs: [gatekeeperWebhookConfig('validation.gatekeeper.sh')] });
  const outUnder = await collect({ cluster, token: 't', listFn: listFnUnder });
  assert.notEqual(outUnder.admission.policyEngineVerdict, 'unknown');
});

test('a forbidden read on constrainttemplates makes the verdict "unknown", not a fabricated zero', async () => {
  const listFn = admissionFixture({ templates: forbidden() });
  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.admission.policyEngineVerdict, 'unknown');
  assert.ok(out.summary.unavailable.includes('constrainttemplates'));
});

// ------------------------------------------------------------------ C2: fail-closed webhook risk

test('backendStatus: ready / none / unknown, never guessed from a missing join', () => {
  const svc = { name: 'x', namespace: 'ns' };
  assert.equal(backendStatus(svc, [readySlice('x', 'ns')]), 'ready');
  assert.equal(backendStatus(svc, [deadSlice('x', 'ns')]), 'none');
  assert.equal(backendStatus(svc, []), 'unknown');
  assert.equal(backendStatus(null, [readySlice('x', 'ns')]), 'unknown');
});

test('failClosedRisk: absent failurePolicy is treated as literal Fail, not safe-by-omission', () => {
  // CANARY: if an absent failurePolicy were treated as "safe", this would come back
  // 'fail-open' instead of the active-outage-risk a down backend actually causes.
  assert.equal(failClosedRisk(undefined, 'none'), 'active-outage-risk');
  assert.equal(failClosedRisk('Fail', 'none'), 'active-outage-risk');
  assert.equal(failClosedRisk('Fail', 'ready'), 'latent-risk');
  assert.equal(failClosedRisk('Fail', 'unknown'), 'unknown');
  assert.equal(failClosedRisk('Ignore', 'none'), 'fail-open');
});

test('collect: blast radius honours objectSelector and reports namespaceSelector against the real namespace list', async () => {
  const webhookConfigs = [{
    metadata: { name: 'my-admission-webhook' },
    webhooks: [{
      name: 'validate.example.com',
      failurePolicy: 'Fail',
      clientConfig: { service: { name: 'validator-svc', namespace: 'validator-ns' } },
      rules: [{ apiGroups: ['apps'], resources: ['deployments'], operations: ['CREATE', 'UPDATE'] }],
      objectSelector: { matchLabels: { 'my.io/scan': 'true' } },
      namespaceSelector: { matchLabels: { env: 'prod' } }
    }]
  }];
  const listFn = fakeList({
    validatingwebhookconfigurations: webhookConfigs,
    mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [], validatingadmissionpolicybindings: [],
    constrainttemplates: [],
    namespaces: [
      { metadata: { name: 'prod-a', labels: { env: 'prod' } } },
      { metadata: { name: 'dev-a', labels: { env: 'dev' } } }
    ],
    endpointslices: [readySlice('validator-svc', 'validator-ns')],
    deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });

  const out = await collect({ cluster, token: 't', listFn });
  const wh = out.failClosedWebhooks[0];
  assert.equal(wh.objectSelectorPresent, true);
  assert.equal(wh.blastRadius.namespaceScope.matchedNamespaceCount, 1);
  assert.deepEqual(wh.blastRadius.namespaceScope.matchedNamespaces, ['prod-a']);
  assert.equal(wh.blastRadius.wildcard, false);
  assert.equal(wh.risk, 'latent-risk');

  // CANARY: drop objectSelector and namespaceSelector cannot be evaluated (namespaces
  // read fails) -> matchedNamespaceCount must go null, not silently assume cluster-wide.
  const unavailableNsListFn = fakeList({
    validatingwebhookconfigurations: webhookConfigs,
    mutatingwebhookconfigurations: [], validatingadmissionpolicies: [], validatingadmissionpolicybindings: [],
    constrainttemplates: [], namespaces: forbidden(), endpointslices: [readySlice('validator-svc', 'validator-ns')],
    deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const out2 = await collect({ cluster, token: 't', listFn: unavailableNsListFn });
  assert.equal(out2.failClosedWebhooks[0].blastRadius.namespaceScope.evaluable, false);
  assert.equal(out2.failClosedWebhooks[0].blastRadius.namespaceScope.matchedNamespaceCount, null);
});

// ------------------------------------------------------------------ C3: PDB coverage

test('effectiveReplicas: max(spec.replicas ?? 1, status.replicas) guards a stale scaled-down spec', () => {
  // CANARY: a naive `spec.replicas` alone would read 1 here and miss the 5 real pods.
  assert.equal(effectiveReplicas({ spec: { replicas: 1 }, status: { replicas: 5 } }, 'Deployment'), 5);
  assert.equal(effectiveReplicas({ spec: {}, status: {} }, 'Deployment'), 1);
  assert.equal(effectiveReplicas({ status: { desiredNumberScheduled: 3 } }, 'DaemonSet'), 3);
});

function workload(kind, name, ns, labels) {
  return {
    metadata: { name, namespace: ns },
    spec: { replicas: 2, template: { metadata: { labels } } },
    status: { replicas: 2 }
  };
}
function pdb(name, ns, selector, { disruptionsAllowed = 1, generation = 1, observedGeneration = 1 } = {}) {
  return {
    metadata: { name, namespace: ns, generation },
    spec: { selector },
    status: { disruptionsAllowed, observedGeneration }
  };
}

test('collect: coveragePercent, selectorUnmatched (formerly "orphan"), and gated drainBlockers', async () => {
  const deployments = [
    workload('Deployment', 'covered', 'app', { app: 'covered' }),
    workload('Deployment', 'uncovered', 'app', { app: 'uncovered' })
  ];
  const pdbs = [
    pdb('covered-pdb', 'app', { matchLabels: { app: 'covered' } }, { disruptionsAllowed: 0 }),
    // Selector matches nothing in this namespace: Istio-style benign mismatch, not an error.
    pdb('stray-pdb', 'app', { matchLabels: { app: 'never-existed' } }),
    // disruptionsAllowed: 0 but the controller has not reconciled this generation yet.
    // Matches the same workload as covered-pdb, so this case is isolated from selectorUnmatched.
    pdb('stale-pdb', 'app', { matchLabels: { app: 'covered' } }, { disruptionsAllowed: 0, generation: 3, observedGeneration: 2 })
  ];
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [], validatingadmissionpolicybindings: [],
    constrainttemplates: [], namespaces: [], endpointslices: [],
    deployments, statefulsets: [], daemonsets: [], poddisruptionbudgets: pdbs
  });

  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.pdbCoverage.totalWorkloads, 2);
  assert.equal(out.pdbCoverage.coveredWorkloads, 1);
  assert.equal(out.pdbCoverage.coveragePercent, 50);
  assert.deepEqual(out.pdbCoverage.selectorUnmatched.map(p => p.name), ['stray-pdb']);
  // CANARY: without the observedGeneration gate, stale-pdb would also appear here.
  assert.deepEqual(out.pdbCoverage.drainBlockers.map(p => p.name), ['covered-pdb']);
});

test('collect: coveragePercent is null whenever this collector\'s own reads are partial', async () => {
  const deployments = [workload('Deployment', 'a', 'app', { app: 'a' })];
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [], validatingadmissionpolicybindings: [],
    constrainttemplates: [], namespaces: [], endpointslices: [],
    deployments, statefulsets: [], daemonsets: [], poddisruptionbudgets: forbidden()
  });
  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.pdbCoverage.coveragePercent, null);
  assert.ok(out.pdbCoverage.unavailable.includes('poddisruptionbudgets'));

  // CANARY: same fixture but the PDB read succeeds -> coveragePercent becomes a real number,
  // proving the null above is caused by the failed read and not some other default.
  const listFnOk = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [], validatingadmissionpolicybindings: [],
    constrainttemplates: [], namespaces: [], endpointslices: [],
    deployments, statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const outOk = await collect({ cluster, token: 't', listFn: listFnOk });
  assert.equal(outOk.pdbCoverage.coveragePercent, 0);
});

test('collect: DaemonSets count toward the PDB coverage denominator', async () => {
  const daemonsets = [{
    metadata: { name: 'ds', namespace: 'app' },
    spec: { template: { metadata: { labels: { app: 'ds' } } } },
    status: { desiredNumberScheduled: 3 }
  }];
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [], validatingadmissionpolicybindings: [],
    constrainttemplates: [], namespaces: [], endpointslices: [],
    deployments: [], statefulsets: [], daemonsets, poddisruptionbudgets: []
  });
  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.pdbCoverage.totalWorkloads, 1);
});

// ------------------------------------------------------------------ webhook count honesty

test('failClosedWebhookCount counts only effective-Fail webhooks; webhookCount counts them all', async () => {
  const webhookConfigs = [{
    metadata: { name: 'mixed' },
    webhooks: [
      { name: 'a.example.com', failurePolicy: 'Fail', clientConfig: { service: { name: 's', namespace: 'n' } }, rules: [] },
      { name: 'b.example.com', failurePolicy: 'Ignore', clientConfig: { service: { name: 's', namespace: 'n' } }, rules: [] },
      // absent failurePolicy is the API default, Fail
      { name: 'c.example.com', clientConfig: { service: { name: 's', namespace: 'n' } }, rules: [] }
    ]
  }];
  const listFn = fakeList({
    validatingwebhookconfigurations: webhookConfigs, mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [], validatingadmissionpolicybindings: [], constrainttemplates: [],
    namespaces: [], endpointslices: [], deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const out = await collect({ cluster, token: 't', listFn });
  // CANARY: the old code reported `failClosedWebhooks.length` here, which is 3.
  assert.equal(out.summary.failClosedWebhookCount, 2);
  assert.equal(out.summary.webhookCount, 3);
  assert.equal(out.failClosedWebhooks.length, 3);
});

// ------------------------------------------------------------------ C1b: native ValidatingAdmissionPolicies

test('nativePolicies: joins bindings, ranks Deny over Warn/Audit, flags unbound and orphan bindings, never ships CEL', async () => {
  const vap = (name, extra = {}) => ({
    metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'kyma', 'kyma-project.io/module': 'btp-operator' } },
    spec: {
      matchConstraints: { resourceRules: [{ apiGroups: [''], resources: ['namespaces'], operations: ['CREATE', 'UPDATE'] }] },
      validations: [{ expression: 'object.metadata.name != "SECRET_CEL"', message: 'no bad names' }],
      ...extra
    },
    status: { typeChecking: { expressionWarnings: extra.warn ? [{ fieldRef: 'x', warning: 'y' }] : [] } }
  });
  const bind = (name, policyName, actions, nsSel) => ({
    metadata: { name },
    spec: { policyName, validationActions: actions, matchResources: { namespaceSelector: nsSel || {} } }
  });
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [vap('deny-one'), vap('audit-only'), vap('lonely', { failurePolicy: 'Ignore', warn: true })],
    validatingadmissionpolicybindings: [
      bind('deny-one-b1', 'deny-one', ['Audit']),
      bind('deny-one-b2', 'deny-one', ['Warn', 'Deny'], { matchLabels: { env: 'prod' } }),
      bind('audit-b', 'audit-only', ['Audit']),
      bind('ghost-b', 'no-such-policy', ['Deny'])
    ],
    constrainttemplates: [],
    namespaces: [
      { metadata: { name: 'prod-a', labels: { env: 'prod' } } },
      { metadata: { name: 'dev-a', labels: { env: 'dev' } } }
    ],
    endpointslices: [], deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const out = await collect({ cluster, token: 't', listFn });
  const byName = Object.fromEntries(out.nativePolicies.policies.map(p => [p.name, p]));

  assert.equal(byName['deny-one'].effectiveStatus, 'enforcing');
  assert.equal(byName['deny-one'].strongestAction, 'Deny');
  assert.equal(byName['deny-one'].bindings.length, 2);
  // An empty selector {} selects everything and is reported as cluster-wide, not as "a selector".
  assert.equal(byName['deny-one'].bindings[0].namespaceScope.scope, 'cluster-wide');
  assert.equal(byName['deny-one'].bindings[1].namespaceScope.matchedNamespaceCount, 1);
  assert.equal(byName['audit-only'].effectiveStatus, 'audit-only');
  assert.equal(byName.lonely.effectiveStatus, 'unbound');
  assert.equal(byName.lonely.failurePolicy, 'Ignore');
  assert.equal(byName.lonely.typeCheckWarningCount, 1);
  assert.equal(byName['deny-one'].failurePolicy, 'Fail', 'absent failurePolicy is the API default');
  assert.equal(byName['deny-one'].owner, 'kyma');
  assert.equal(byName['deny-one'].module, 'btp-operator');
  assert.deepEqual(byName['deny-one'].messages, ['no bad names']);
  assert.deepEqual(out.nativePolicies.orphanBindings.map(b => b.name), ['ghost-b']);
  assert.equal(out.summary.validatingAdmissionPolicyEnforcingCount, 1);
  assert.equal(out.summary.validatingAdmissionPolicyUnboundCount, 1);
  assert.equal(JSON.stringify(out.nativePolicies).includes('SECRET_CEL'), false, 'CEL expressions stay on the cluster');
});

test('nativePolicies: a refused VAP read yields no rows, and the read is reported unavailable', async () => {
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: forbidden(), validatingadmissionpolicybindings: [],
    constrainttemplates: [], namespaces: [], endpointslices: [],
    deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const out = await collect({ cluster, token: 't', listFn });
  assert.deepEqual(out.nativePolicies.policies, []);
  assert.ok(out.summary.unavailable.includes('validatingadmissionpolicies'));
});

test('nativePolicies: a refused VAP read reports no orphan bindings — every binding would look orphaned', async () => {
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: forbidden(),
    validatingadmissionpolicybindings: [{ metadata: { name: 'b1' }, spec: { policyName: 'p1', validationActions: ['Deny'] } }],
    constrainttemplates: [], namespaces: [], endpointslices: [],
    deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const out = await collect({ cluster, token: 't', listFn });
  assert.deepEqual(out.nativePolicies.orphanBindings, []);
});

test('nativePolicies: a refused binding read makes every policy unknown, never unbound', async () => {
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [{ metadata: { name: 'p1' }, spec: { validations: [] } }],
    validatingadmissionpolicybindings: forbidden(),
    constrainttemplates: [], namespaces: [], endpointslices: [],
    deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.nativePolicies.policies[0].effectiveStatus, 'unknown');
  assert.equal(out.summary.validatingAdmissionPolicyUnboundCount, 0);
  assert.ok(out.summary.unavailable.includes('validatingadmissionpolicybindings'));
});

test('nativePolicies: a binding reaches only namespaces the policy matchConstraints also select', async () => {
  const listFn = fakeList({
    validatingwebhookconfigurations: [], mutatingwebhookconfigurations: [],
    validatingadmissionpolicies: [{
      metadata: { name: 'p1' },
      spec: { matchConstraints: { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kyma-system' } } }, validations: [] }
    }],
    validatingadmissionpolicybindings: [{ metadata: { name: 'b1' }, spec: { policyName: 'p1', validationActions: ['Deny'] } }],
    constrainttemplates: [],
    namespaces: ['kyma-system', 'default', 'istio-system'].map(n => ({ metadata: { name: n, labels: { 'kubernetes.io/metadata.name': n } } })),
    endpointslices: [], deployments: [], statefulsets: [], daemonsets: [], poddisruptionbudgets: []
  });
  const out = await collect({ cluster, token: 't', listFn });
  const scope = out.nativePolicies.policies[0].bindings[0].namespaceScope;
  assert.equal(scope.scope, 'selector');
  assert.equal(scope.matchedNamespaceCount, 1);
  assert.deepEqual(scope.matchedNamespaces, ['kyma-system']);
});
