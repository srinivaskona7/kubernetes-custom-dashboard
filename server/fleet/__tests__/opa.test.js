/**
 * OPA Gatekeeper collector — the eleven behaviours the OPA dashboard depends on being true.
 *
 * Every read is an injected double; no test opens a socket. The tests that matter most here are
 * the ones asserting what the collector must NOT say: that a zero violation count is compliance,
 * that an audit violation is a denied request, that a missing CRD is the same as a refused read.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import opa from '../collectors/opa.js';
const {
  collect, decisions, manifest,
  enforcementActionOf, ineffectiveReasons, namespaceScopeOf, categoryOf, describe: describePolicy,
  auditFreshnessOf, normaliseViolation, installationState, gatekeeperWebhookState, policyStatus,
  MAX_VIOLATION_MESSAGE
} = opa;
import _errors from '../errors.js';
const { ClusterError } = _errors;

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };
const token = 'test-token';

const notFound = () => new ClusterError('UPSTREAM', '404 Not Found', { status: 404 });
const forbidden = () => new ClusterError('FORBIDDEN', 'forbidden: no RBAC rule', { status: 403 });

/** Route by path substring — the convention every collector test in this repo uses. */
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

function fakeCall(byPath = {}) {
  return async ({ path }) => {
    const key = Object.keys(byPath).find(k => path.includes(k));
    if (key) {
      const value = byPath[key];
      if (value instanceof Error) throw value;
      return value;
    }
    throw notFound();
  };
}

const template = (name, extra = {}) => ({
  metadata: { name, ...(extra.metadata || {}) },
  spec: { crd: { spec: { names: { kind: extra.kind || 'K8sRequiredLabels' } } } },
  ...(extra.status ? { status: extra.status } : {})
});

const constraint = (name, spec = {}, status = {}) => ({
  metadata: { name },
  kind: 'K8sRequiredLabels',
  spec,
  status: { byPod: [{ id: 'gatekeeper-audit-1', enforced: true }], ...status }
});

/** A registered Gatekeeper webhook with a ready backend, for the tests that need enforcement live. */
const READY_WEBHOOK = [{
  metadata: { name: 'gatekeeper-validating-webhook-configuration' },
  webhooks: [{
    name: 'validation.gatekeeper.sh',
    failurePolicy: 'Ignore',
    timeoutSeconds: 3,
    rules: [{ operations: ['CREATE', 'UPDATE'] }],
    clientConfig: { service: { name: 'gatekeeper-webhook-service', namespace: 'gatekeeper-system', port: 443 } }
  }]
}];

const READY_ENDPOINTSLICE = [{
  metadata: {
    name: 'gatekeeper-webhook-service-abc',
    namespace: 'gatekeeper-system',
    labels: { 'kubernetes.io/service-name': 'gatekeeper-webhook-service' }
  },
  endpoints: [{ conditions: { ready: true } }]
}];

// ------------------------------------------------------------------ 1. enforcement action

test('enforcementActionOf: an absent action is deny, matching Gatekeeper\'s own default', () => {
  assert.equal(enforcementActionOf(constraint('c', {})), 'deny');
});

test('enforcementActionOf: warn and dryrun are carried through, an unrecognised value is unknown not deny', () => {
  assert.equal(enforcementActionOf(constraint('c', { enforcementAction: 'warn' })), 'warn');
  assert.equal(enforcementActionOf(constraint('c', { enforcementAction: 'dryrun' })), 'dryrun');
  // CANARY: defaulting an unknown string to 'deny' would report a policy as blocking requests
  // when nobody knows what it does. It must degrade to 'unknown'.
  assert.equal(enforcementActionOf(constraint('c', { enforcementAction: 'quarantine' })), 'unknown');
});

test('enforcementActionOf: scoped resolves through scopedEnforcementActions and is unknown when none names the webhook', () => {
  const scoped = constraint('c', {
    enforcementAction: 'scoped',
    scopedEnforcementActions: [{ action: 'warn', enforcementPoints: [{ name: 'validation.gatekeeper.sh' }] }]
  });
  assert.equal(enforcementActionOf(scoped), 'warn');

  const auditOnly = constraint('c', {
    enforcementAction: 'scoped',
    scopedEnforcementActions: [{ action: 'deny', enforcementPoints: [{ name: 'audit.gatekeeper.sh' }] }]
  });
  assert.equal(enforcementActionOf(auditOnly), 'unknown');
});

// ------------------------------------------------------------------ 2. template ↔ constraint association

test('a Constraint is associated with its template through the template name, and both appear on the row', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'constraints.gatekeeper.sh/v1beta1/k8srequiredlabels': [constraint('all-must-have-owner')],
      namespaces: [{ metadata: { name: 'default' } }]
    }),
    callFn: fakeCall()
  });

  assert.equal(data.policies.length, 1);
  const [p] = data.policies;
  assert.equal(p.templateName, 'k8srequiredlabels');
  assert.equal(p.constraintName, 'all-must-have-owner');
  assert.equal(p.id, 'k8srequiredlabels/all-must-have-owner');
  assert.equal(p.constraintKind, 'K8sRequiredLabels');
  assert.deepEqual(
    p.sourceReferences.map(r => r.kind).sort(),
    ['ConstraintTemplate', 'GatekeeperConstraint']
  );
});

test('a template with no Constraint still produces a row, because that IS a policy state', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({ constrainttemplates: [template('k8sallowedrepos')], namespaces: [] }),
    callFn: fakeCall()
  });

  assert.equal(data.policies.length, 1);
  const [p] = data.policies;
  assert.equal(p.constraintName, null);
  assert.equal(p.status, 'inactive');
  assert.equal(p.enforcementAction, 'unknown');
  assert.ok(p.ineffectiveReasons.some(r => r.code === 'NO_CONSTRAINT_INSTANCES'));
});

// ------------------------------------------------------------------ 3. the four statuses

test('policyStatus: the four states, and that a zero violation count is not one of the inputs', () => {
  assert.equal(policyStatus({ constraint: constraint('c'), reasons: [] }), 'active');
  assert.equal(policyStatus({ constraint: constraint('c'), reasons: [{ code: 'DRY_RUN' }] }), 'warning');
  assert.equal(policyStatus({ constraint: constraint('c'), reasons: [{ code: 'NO_TARGET_KINDS' }] }), 'inactive');
  assert.equal(policyStatus({ constraint: null, reasons: [] }), 'inactive');
  assert.equal(policyStatus({ constraint: constraint('c'), reasons: [{ code: 'CONSTRAINTS_UNREADABLE' }] }), 'unknown');

  // CANARY: `policyStatus` takes no violation count at all, by design. If a future change threads
  // one in, this test is where the "0 violations means broken" bug gets caught.
  assert.equal(policyStatus.length, 1);
});

// ------------------------------------------------------------------ 4. declared but not enforcing

test('ineffectiveReasons never fires on a zero violation count alone', () => {
  const reasons = ineffectiveReasons({
    constraint: constraint('c', { enforcementAction: 'deny', match: { kinds: [{ kinds: ['Pod'] }] } }),
    template: template('t'),
    enforcementAction: 'deny',
    targetKinds: [{ apiGroups: [''], kinds: ['Pod'] }],
    namespaceScope: { evaluable: true, matchedNamespaceCount: 3, scope: 'cluster-wide' },
    webhookActive: true,
    auditFreshness: { state: 'fresh', at: '2026-09-16T10:00:00Z', ageSeconds: 30 },
    constraintsUnavailable: false
  });
  assert.deepEqual(reasons, []);
});

test('ineffectiveReasons names the exact detected reason for each distinct cause', () => {
  const base = {
    template: template('t'),
    targetKinds: [{ apiGroups: [''], kinds: ['Pod'] }],
    namespaceScope: { evaluable: true, matchedNamespaceCount: 2, scope: 'selector' },
    webhookActive: true,
    auditFreshness: { state: 'fresh', at: 'x', ageSeconds: 5 },
    constraintsUnavailable: false
  };
  const codes = args => ineffectiveReasons({ ...base, ...args }).map(r => r.code);

  assert.ok(codes({ constraint: constraint('c'), enforcementAction: 'dryrun' }).includes('DRY_RUN'));
  assert.ok(codes({ constraint: constraint('c'), enforcementAction: 'unknown' }).includes('UNSUPPORTED_ACTION'));
  assert.ok(codes({ constraint: constraint('c', {}, { byPod: [] }), enforcementAction: 'deny' }).includes('NOT_RECONCILED'));
  assert.ok(codes({
    constraint: constraint('c', {}, { byPod: [{ id: 'p', enforced: false }] }), enforcementAction: 'deny'
  }).includes('NOT_ENFORCED_BY_PODS'));
  assert.ok(codes({ constraint: constraint('c'), enforcementAction: 'deny', targetKinds: [] }).includes('NO_TARGET_KINDS'));
  assert.ok(codes({
    constraint: constraint('c'), enforcementAction: 'deny',
    namespaceScope: { evaluable: true, matchedNamespaceCount: 0, scope: 'selector' }
  }).includes('EMPTY_NAMESPACE_SCOPE'));
  assert.ok(codes({ constraint: constraint('c'), enforcementAction: 'deny', webhookActive: false }).includes('WEBHOOK_INACTIVE'));
  assert.ok(codes({
    constraint: constraint('c'), enforcementAction: 'deny',
    auditFreshness: { state: 'never', at: null, ageSeconds: null }
  }).includes('AUDIT_NEVER_RAN'));
  assert.ok(codes({
    constraint: constraint('c'), enforcementAction: 'deny',
    template: template('t', { status: { byPod: [{ errors: [{ message: 'rego parse error' }] }] } })
  }).includes('TEMPLATE_ERROR'));
  assert.ok(codes({ constraint: constraint('c'), enforcementAction: 'deny', constraintsUnavailable: true })
    .includes('CONSTRAINTS_UNREADABLE'));
});

test('an unevaluable namespace scope never yields EMPTY_NAMESPACE_SCOPE — unknown reach is not empty reach', () => {
  const codes = ineffectiveReasons({
    constraint: constraint('c'), template: template('t'), enforcementAction: 'deny',
    targetKinds: [{ apiGroups: [''], kinds: ['Pod'] }],
    namespaceScope: { evaluable: false, matchedNamespaceCount: null, scope: 'unknown' },
    webhookActive: true, auditFreshness: { state: 'fresh', at: 'x', ageSeconds: 1 },
    constraintsUnavailable: false
  }).map(r => r.code);
  assert.ok(!codes.includes('EMPTY_NAMESPACE_SCOPE'));
});

// ------------------------------------------------------------------ 5. audit violation normalisation

test('normaliseViolation carries the message verbatim up to the cap and marks its source as audit', () => {
  const v = normaliseViolation({
    raw: { message: 'you must provide labels: {"owner"}', kind: 'Namespace', name: 'kyma-system', group: '', version: 'v1' },
    policyId: 'k8srequiredlabels/all-must-have-owner',
    enforcementAction: 'deny',
    category: 'Labels and ownership',
    auditAt: '2026-09-16T10:00:00Z',
    index: 0
  });
  assert.equal(v.message, 'you must provide labels: {"owner"}');
  assert.equal(v.source, 'gatekeeper-audit');
  assert.equal(v.namespace, null);
  assert.equal(v.name, 'kyma-system');
  assert.equal(v.lastSeen, '2026-09-16T10:00:00Z');
  // Gatekeeper does not record a first-seen time, and inventing one would date a violation wrongly.
  assert.equal(v.firstSeen, null);
  assert.equal(v.id, 'k8srequiredlabels/all-must-have-owner|Namespace/-/kyma-system|0');
});

test('a very long violation message is truncated rather than shipped whole', () => {
  const v = normaliseViolation({
    raw: { message: 'x'.repeat(5000), kind: 'Pod', name: 'p', namespace: 'default' },
    policyId: 'p/c', enforcementAction: 'deny', category: 'Other', auditAt: null, index: 3
  });
  assert.ok(v.message.length <= MAX_VIOLATION_MESSAGE + 1);
});

test('totalViolations is the count and status.violations[] is the itemised sample — the gap is reported, not hidden', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'constraints.gatekeeper.sh/v1beta1/k8srequiredlabels': [
        constraint('all-must-have-owner', {}, {
          totalViolations: 143,
          auditTimestamp: new Date().toISOString(),
          violations: Array.from({ length: 20 }, (_, i) => ({ kind: 'Pod', name: `p${i}`, namespace: 'default', message: 'no owner' }))
        })
      ],
      namespaces: [{ metadata: { name: 'default' } }]
    }),
    callFn: fakeCall()
  });

  const [p] = data.policies;
  assert.equal(p.violationCount, 143);
  assert.equal(p.violationsShown, 20);
  assert.equal(p.violationsTruncated, true);
  assert.equal(data.violations.length, 20);
});

test('a constraint with no status yields violationCount null — unread, never zero', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'constraints.gatekeeper.sh/v1beta1/k8srequiredlabels': [{ metadata: { name: 'c' }, spec: {} }],
      namespaces: []
    }),
    callFn: fakeCall()
  });
  assert.equal(data.policies[0].violationCount, null);
  assert.equal(data.summary.policiesWithUnknownViolationCount, 1);
  // CANARY: a null count folded into the total as 0 would make the fleet total read as compliance.
  assert.equal(data.summary.auditViolationTotal, 0);
  assert.equal(data.summary.auditViolationCountPartial, true);
});

test('auditFreshnessOf distinguishes never, stale and fresh', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  assert.equal(auditFreshnessOf(undefined, now).state, 'never');
  assert.equal(auditFreshnessOf('2026-09-16T11:59:00Z', now).state, 'fresh');
  assert.equal(auditFreshnessOf('2026-09-16T10:00:00Z', now).state, 'stale');
  assert.equal(auditFreshnessOf('not a date', now).state, 'unknown');
});

// ------------------------------------------------------------------ 6. Gatekeeper not installed

test('missing CRDs report absent, with the group probe as evidence — distinct from a refused read', async () => {
  const data = await collect({
    cluster, token,
    // The list 404s AND the group discovery probe 404s: Gatekeeper is genuinely not here.
    listFn: fakeList({ constrainttemplates: notFound(), namespaces: [] }),
    callFn: fakeCall()
  });
  assert.equal(data.gatekeeper.state, 'absent');
  assert.equal(data.gatekeeper.installed, false);
  assert.deepEqual(data.policies, []);
});

test('a 403 on the ConstraintTemplate read is forbidden, NOT absent', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({ constrainttemplates: forbidden(), namespaces: [] }),
    callFn: fakeCall()
  });
  // CANARY: collapsing this into "not installed" sends an operator to install Gatekeeper on a
  // cluster that already runs it, when the actual fix is an RBAC rule.
  assert.equal(data.gatekeeper.state, 'forbidden');
  assert.equal(data.gatekeeper.installed, null);
  assert.equal(data.summary.unavailable.length > 0, true);
});

test('installationState separates an installed engine with no templates from an absent engine', () => {
  assert.equal(installationState({ unavailable: false, items: [], absent: true, absentEvidence: 'group missing' }).state, 'absent');
  assert.equal(installationState({ unavailable: false, items: [], absent: false }).state, 'no-templates');
  assert.equal(installationState({ unavailable: false, items: [template('t')] }).state, 'installed');
  assert.equal(installationState({ unavailable: true, reason: 'FORBIDDEN', detail: 'x' }).state, 'forbidden');
  assert.equal(installationState({ unavailable: true, reason: 'TIMEOUT', detail: 'x' }).state, 'unreadable');
});

// ------------------------------------------------------------------ 7. partial failure

test('one failed Constraint read leaves the other policies intact and marks only its own row unknown', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels'), template('k8sallowedrepos', { kind: 'K8sAllowedRepos' })],
      'v1beta1/k8srequiredlabels': [constraint(
        'labels-everywhere',
        { match: { kinds: [{ apiGroups: [''], kinds: ['Namespace'] }] } },
        { auditTimestamp: new Date().toISOString(), totalViolations: 0 }
      )],
      'v1beta1/k8sallowedrepos': forbidden(),
      namespaces: [{ metadata: { name: 'default' } }],
      validatingwebhookconfigurations: READY_WEBHOOK,
      endpointslices: READY_ENDPOINTSLICE
    }),
    callFn: fakeCall()
  });

  const ok = data.policies.find(p => p.templateName === 'k8srequiredlabels');
  const bad = data.policies.find(p => p.templateName === 'k8sallowedrepos');
  assert.equal(ok.status, 'active');
  assert.deepEqual(ok.ineffectiveReasons, []);
  assert.equal(bad.status, 'unknown');
  assert.ok(bad.ineffectiveReasons.some(r => r.code === 'CONSTRAINTS_UNREADABLE'));
});

test('a failed namespace read leaves reach unevaluable rather than reporting a reach of zero', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'v1beta1/k8srequiredlabels': [constraint('c', { match: { namespaces: ['kyma-system'] } })],
      '/api/v1/namespaces': forbidden()
    }),
    callFn: fakeCall()
  });
  const scope = data.policies[0].namespaceScope;
  assert.equal(scope.evaluable, false);
  assert.equal(scope.matchedNamespaceCount, null);
  assert.equal(scope.totalNamespaces, null);
});

test('namespaceScopeOf honours an allowlist, an exclusion, and a trailing-* prefix', () => {
  const namespaces = {
    unavailable: false,
    items: [{ metadata: { name: 'default' } }, { metadata: { name: 'kyma-system' } }, { metadata: { name: 'kyma-integration' } }]
  };
  assert.equal(namespaceScopeOf({ namespaces: ['kyma-system'] }, namespaces).matchedNamespaceCount, 1);
  assert.equal(namespaceScopeOf({ namespaces: ['kyma-*'] }, namespaces).matchedNamespaceCount, 2);
  assert.equal(namespaceScopeOf({ excludedNamespaces: ['kyma-system'] }, namespaces).matchedNamespaceCount, 2);
  assert.equal(namespaceScopeOf(null, namespaces).scope, 'cluster-wide');
});

// ------------------------------------------------------------------ 8. categories and descriptions

test('a category is never inferred from a display name, and mixed target kinds fall back to Other', () => {
  // The live case that caught this: a policy over four RBAC kinds plus NetworkPolicy was filed
  // under Networking because a first-match loop hit NetworkPolicy.
  const mixed = categoryOf('restrictjenkinsdeployer', [
    { apiGroups: ['rbac.authorization.k8s.io'], kinds: ['Role', 'RoleBinding', 'ClusterRole'] },
    { apiGroups: ['networking.k8s.io'], kinds: ['NetworkPolicy'] }
  ]);
  assert.equal(mixed.category, 'Other');
  assert.equal(mixed.categorySource, 'fallback');

  // A known upstream template name is authoritative regardless of its kinds.
  assert.equal(categoryOf('k8spspallowprivilegeescalationcontainer', []).categorySource, 'mapping');
});

test('describe prefers an annotation over the maintained mapping, and never invents from the name alone', () => {
  const annotated = describePolicy({
    constraint: { metadata: { annotations: { description: 'Every namespace needs an owner label.' } } },
    template: template('k8srequiredlabels'),
    targetKinds: []
  });
  assert.equal(annotated.source, 'annotation');
  assert.equal(annotated.text, 'Every namespace needs an owner label.');

  const fromTemplate = describePolicy({
    constraint: { metadata: {} },
    template: template('somethingcustom', { metadata: { annotations: { description: 'Template says so.' } } }),
    targetKinds: []
  });
  assert.equal(fromTemplate.source, 'template-annotation');

  // A name nobody has described: the fallback states only the template and kinds, and says so
  // through `source: 'identity'` so the UI can label it as asserting nothing.
  const unknown = describePolicy({
    constraint: { metadata: {} },
    template: template('acmeforbidfridaydeploys', { kind: 'AcmeForbidFridayDeploys' }),
    targetKinds: [{ apiGroups: ['apps'], kinds: ['Deployment'] }]
  });
  assert.equal(unknown.source, 'identity');
  assert.ok(unknown.text.includes('AcmeForbidFridayDeploys'));
  assert.ok(unknown.text.includes('Deployment'));
});

// ------------------------------------------------------------------ 9. webhook state

test('gatekeeperWebhookState: ready, not-ready and unjoinable are three different answers', () => {
  const webhookCfg = name => ({
    unavailable: false,
    items: [{
      metadata: { name: 'gatekeeper-validating-webhook-configuration' },
      webhooks: [{
        name,
        failurePolicy: 'Ignore',
        timeoutSeconds: 3,
        rules: [{ operations: ['CREATE', 'UPDATE'] }],
        clientConfig: { service: { name: 'gatekeeper-webhook-service', namespace: 'gatekeeper-system', port: 443 } }
      }]
    }]
  });
  const slice = ready => ({
    unavailable: false,
    items: [{
      metadata: { name: 's', namespace: 'gatekeeper-system', labels: { 'kubernetes.io/service-name': 'gatekeeper-webhook-service' } },
      endpoints: [{ conditions: { ready } }]
    }]
  });

  assert.equal(gatekeeperWebhookState(webhookCfg('validation.gatekeeper.sh'), slice(true)).active, true);
  assert.equal(gatekeeperWebhookState(webhookCfg('validation.gatekeeper.sh'), slice(false)).active, false);
  // CANARY: no matching EndpointSlice means the join could not be made. Reporting `false` there
  // would put a fabricated outage on a security screen.
  assert.equal(gatekeeperWebhookState(webhookCfg('validation.gatekeeper.sh'), { unavailable: false, items: [] }).active, null);
  assert.equal(gatekeeperWebhookState(webhookCfg('some.other.webhook'), slice(true)).present, false);
  assert.equal(gatekeeperWebhookState({ unavailable: true, reason: 'FORBIDDEN' }, slice(true)).present, null);

  const state = gatekeeperWebhookState(webhookCfg('validation.gatekeeper.sh'), slice(true));
  assert.equal(state.failurePolicy, 'Ignore');
  assert.equal(state.timeoutSeconds, 3);
  assert.deepEqual(state.operations, ['CREATE', 'UPDATE']);
});

// ------------------------------------------------------------------ 10. decision activity

test('decisions reports no runtime source rather than repurposing audit violations', async () => {
  const data = await decisions({
    cluster, token,
    listFn: fakeList({
      deployments: [{
        metadata: { name: 'gatekeeper-controller-manager' },
        spec: { template: { spec: { containers: [{ args: ['--log-denies=false', '--operation=webhook'] }] } } }
      }, {
        metadata: { name: 'gatekeeper-audit' },
        spec: { template: { spec: { containers: [{ args: ['--audit-interval=60', '--constraint-violations-limit=20'] }] } } }
      }]
    })
  });

  assert.equal(data.available, false);
  assert.deepEqual(data.entries, []);
  const ids = data.sources.map(s => s.id).sort();
  assert.deepEqual(ids, ['admission-metric', 'decision-log']);
  // Each unavailable source must name the knob that would change it — "unavailable" on its own is
  // not actionable.
  for (const s of data.sources) {
    assert.equal(s.available, false);
    assert.ok(s.detail.length > 20, `source ${s.id} has no explanation`);
  }
  assert.equal(data.audit.present, true);
  assert.equal(data.audit.intervalSeconds, 60);
  assert.equal(data.audit.violationsLimit, 20);
});

test('decisions reports the decision log as available when --log-denies is on', async () => {
  const data = await decisions({
    cluster, token,
    listFn: fakeList({
      deployments: [{
        metadata: { name: 'gatekeeper-controller-manager' },
        spec: { template: { spec: { containers: [{ args: ['--log-denies=true'] }] } } }
      }]
    })
  });
  assert.equal(data.sources.find(s => s.id === 'decision-log').available, true);
  assert.equal(data.available, true);
});

/**
 * The metrics source must report the reason MEASURED on the cluster in front of it, because the
 * reason is the operator's next action and the two possible reasons point at different files.
 * It used to return one fixed sentence blaming our own RBAC; on the first real cluster checked
 * (platformsbx, 2026-09-16) that was wrong — no Service exposed the metrics port at all, so a
 * proxy grant would have added privilege and reached nothing.
 */
const ctrl = (extraArgs = []) => ({
  metadata: { name: 'gatekeeper-controller-manager' },
  spec: { template: { spec: { containers: [{ args: ['--log-denies=false', '--prometheus-port=8888', ...extraArgs] }] } } }
});
const metricSource = data => data.sources.find(s => s.id === 'admission-metric');

test('no Service exposes the metrics port: the reason is the missing Service, not our RBAC', async () => {
  const data = await decisions({
    cluster, token,
    listFn: fakeList({
      deployments: [ctrl()],
      services: [{ metadata: { name: 'gatekeeper-webhook-service' }, spec: { ports: [{ port: 443, targetPort: 'webhook-server' }] } }]
    })
  });
  const src = metricSource(data);
  assert.equal(src.available, false);
  assert.match(src.detail, /No Service in gatekeeper-system exposes that port/);
  assert.match(src.detail, /gatekeeper-webhook-service/, 'names what it did find');
  assert.match(src.detail, /a proxy permission would not change that/);
  assert.ok(!/needs get on services\/proxy/.test(src.detail),
    'must not send the operator to edit a role that is not the blocker');
});

test('a Service does expose the metrics port: the grant is named as the blocker', async () => {
  for (const ports of [
    [{ port: 8888, targetPort: 8888 }],            // matched by number
    [{ port: 9090, targetPort: 'metrics' }]        // matched by the container port's name
  ]) {
    const data = await decisions({
      cluster, token,
      listFn: fakeList({ deployments: [ctrl()], services: [{ metadata: { name: 'gk-metrics' }, spec: { ports } }] })
    });
    const src = metricSource(data);
    assert.equal(src.available, false);
    assert.match(src.detail, /gk-metrics exposes it/);
    assert.match(src.detail, /needs get on services\/proxy in gatekeeper-system/);
    // Naming the blocker is not the same as recommending it be removed.
    assert.match(src.detail, /deliberately\s+not in the fleet-reader role/);
  }
});

test('a refused Service list is a third state, not a guess between the other two', async () => {
  const data = await decisions({
    cluster, token,
    listFn: fakeList({ deployments: [ctrl()], services: forbidden() })
  });
  const src = metricSource(data);
  assert.match(src.detail, /could not be determined/);
  assert.match(src.detail, /FORBIDDEN/);
  assert.ok(!/No Service in/.test(src.detail), 'a refused read is never reported as an absence');
  assert.ok(!/exposes it, but/.test(src.detail), 'nor as a presence');
});

test('the metrics port comes from the flag, not from a hardcoded 8888', async () => {
  const data = await decisions({
    cluster, token,
    listFn: fakeList({
      deployments: [{
        metadata: { name: 'gatekeeper-controller-manager' },
        spec: { template: { spec: { containers: [{ args: ['--prometheus-port=9999'] }] } } }
      }],
      services: [{ metadata: { name: 'gk-metrics' }, spec: { ports: [{ port: 9999, targetPort: 9999 }] } }]
    })
  });
  assert.match(metricSource(data).detail, /--prometheus-port=9999/);
  assert.match(metricSource(data).detail, /gk-metrics exposes it/);
});

// ------------------------------------------------------------------ 11. the YAML route

test('manifest returns the live objects labelled as live, and rejects a name that is not a resource name', async () => {
  const calls = [];
  const data = await manifest({
    cluster, token, template: 'k8srequiredlabels', constraint: 'all-must-have-owner',
    callFn: async ({ path }) => {
      calls.push(path);
      if (path.includes('constrainttemplates')) return template('k8srequiredlabels');
      return constraint('all-must-have-owner', { parameters: { labels: ['owner'] } });
    }
  });

  assert.deepEqual(data.documents.map(d => d.label), ['LIVE CONSTRAINTTEMPLATE', 'LIVE GATEKEEPER CONSTRAINT']);
  assert.ok(data.documents[0].yaml.includes('k8srequiredlabels'));
  // Both Kinds are constants in the collector; only the names are parameters. So the paths this
  // route can produce are bounded, and it can never be aimed at a Secret.
  assert.ok(calls.every(p => p.includes('constrainttemplates') || p.includes('constraints.gatekeeper.sh')));

  await assert.rejects(
    () => manifest({ cluster, token, template: '../../../api/v1/secrets', callFn: async () => ({}) }),
    /resource name/
  );
});

test('manifest strips managedFields and the last-applied annotation', async () => {
  const data = await manifest({
    cluster, token, template: 'k8srequiredlabels', constraint: null,
    callFn: async () => ({
      metadata: {
        name: 'k8srequiredlabels',
        managedFields: [{ manager: 'gatekeeper' }],
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"huge":true}', keep: 'yes' }
      },
      spec: { crd: { spec: { names: { kind: 'K8sRequiredLabels' } } } }
    })
  });
  const yaml = data.documents[0].yaml;
  assert.ok(!yaml.includes('managedFields'));
  assert.ok(!yaml.includes('last-applied-configuration'));
  assert.ok(yaml.includes('keep'));
});

// ------------------------------------------------------------------ read-only and secret safety

test('no Secret value can reach the OPA payload: constraint parameters are masked on the way out', async () => {
  const data = await manifest({
    cluster, token, template: 'k8srequiredlabels', constraint: null,
    callFn: async () => ({
      metadata: { name: 'k8srequiredlabels' },
      spec: { crd: { spec: { names: { kind: 'K8sRequiredLabels' } } } },
      // A ConstraintTemplate has no `data` block; this asserts the masking is applied regardless,
      // as defence in depth against a future object shape that does.
      data: { password: 'hunter2' }
    })
  });
  assert.ok(!data.documents[0].yaml.includes('hunter2'));
});

test('the collector issues only GETs and LISTs — every path it touches is a read', async () => {
  const paths = [];
  await collect({
    cluster, token,
    listFn: async ({ path }) => { paths.push(path); return []; },
    callFn: async ({ path }) => { paths.push(path); throw notFound(); }
  });
  assert.ok(paths.length > 0);
  // A collector that mutated would need a body or a verb; `list`/`call` in this repo take neither
  // for a write. The guard test over srv/fleet greps for the verbs; this asserts the read set.
  for (const p of paths) {
    assert.ok(p.startsWith('/api'), `unexpected path shape ${p}`);
  }
});

// ------------------------------------------------------------------ capability, per feature

test('a refused Constraint read is forbidden, never an empty policy inventory', async () => {
  // The one rule the capability layer exists for. A 403 here used to reach the screen as a row
  // with an "unknown" status inside an otherwise confident page; the feature verdict now says
  // which of the two the operator is looking at, and names the missing read.
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'k8srequiredlabels': forbidden(),
      namespaces: [{ metadata: { name: 'default' } }]
    }),
    callFn: fakeCall()
  });

  assert.equal(data.capabilities.policies.state, 'forbidden');
  assert.equal(data.capabilities.policies.trusted, false);
  assert.match(data.capabilities.policies.sentence, /^OPA policy inventory is unavailable because the read-only service account cannot access /);
  assert.ok(data.capabilities.policies.missing.includes('constraints:k8srequiredlabels'));
});

test('a missing ConstraintTemplate CRD is not-installed, with a true zero beside it', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({ constrainttemplates: notFound() }),
    // The discovery probe 404s too, which is what turns "absent" from a guess into evidence.
    callFn: async () => { throw notFound(); }
  });

  assert.equal(data.capabilities.policies.state, 'not-installed');
  assert.equal(data.capabilities.policies.trusted, true, 'a confirmed absence makes 0 an honest count');
  assert.match(data.capabilities.policies.sentence, /ConstraintTemplate CRD is not registered/);
});

test('an audit controller scaled to zero makes violation counts not-configured, not available', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'k8srequiredlabels': [constraint('owner-labels', {}, { totalViolations: 0, auditTimestamp: new Date().toISOString() })],
      'gatekeeper-system/deployments': [
        { metadata: { name: 'gatekeeper-controller-manager' }, spec: { replicas: 1, template: { spec: { containers: [{ args: [] }] } } }, status: { readyReplicas: 1 } },
        { metadata: { name: 'gatekeeper-audit' }, spec: { replicas: 0, template: { spec: { containers: [{ args: [] }] } } }, status: { readyReplicas: 0 } }
      ],
      validatingwebhookconfigurations: READY_WEBHOOK,
      endpointslices: READY_ENDPOINTSLICE
    }),
    callFn: fakeCall()
  });

  assert.equal(data.capabilities.violations.state, 'not-configured');
  assert.match(data.capabilities.violations.sentence, /runs no Gatekeeper audit controller/);
  assert.equal(data.capabilities.violations.trusted, false, '0 violations from a dead audit is not a fact');
});

test('a stale constraint audit makes violation counts stale, and names the oldest one', async () => {
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'k8srequiredlabels': [constraint('owner-labels', {}, { totalViolations: 4, auditTimestamp: old })],
      'gatekeeper-system/deployments': [
        { metadata: { name: 'gatekeeper-controller-manager' }, spec: { replicas: 1, template: { spec: { containers: [{ args: [] }] } } }, status: { readyReplicas: 1 } },
        { metadata: { name: 'gatekeeper-audit' }, spec: { replicas: 1, template: { spec: { containers: [{ args: ['--audit-interval=60'] }] } } }, status: { readyReplicas: 1 } }
      ],
      validatingwebhookconfigurations: READY_WEBHOOK,
      endpointslices: READY_ENDPOINTSLICE
    }),
    callFn: fakeCall()
  });

  assert.equal(data.capabilities.violations.state, 'stale');
  assert.equal(data.capabilities.violations.trusted, true, 'a stale number is still a real number');
  assert.match(data.capabilities.violations.sentence, /past the \d+s staleness threshold/);
});

test('coverage is always partial by construction, and says why', async () => {
  const data = await collect({
    cluster, token,
    listFn: fakeList({
      constrainttemplates: [template('k8srequiredlabels')],
      'k8srequiredlabels': [constraint('owner-labels')],
      namespaces: [{ metadata: { name: 'default' } }],
      validatingwebhookconfigurations: READY_WEBHOOK,
      endpointslices: READY_ENDPOINTSLICE
    }),
    callFn: fakeCall()
  });

  assert.equal(data.capabilities.coverage.state, 'partial');
  assert.match(data.capabilities.coverage.cause, /not from an enumeration of every object/);
});

test('Decision Activity with no source is not-configured, with the exact required sentence', async () => {
  const data = await decisions({
    cluster, token,
    listFn: fakeList({
      'gatekeeper-system/deployments': [
        { metadata: { name: 'gatekeeper-controller-manager' }, spec: { template: { spec: { containers: [{ args: [] }] } } } }
      ]
    })
  });

  assert.equal(data.available, false);
  assert.equal(data.capability.state, 'not-configured');
  assert.equal(
    data.capability.sentence,
    'OPA Decision Activity is unavailable because admission decision telemetry is not configured.'
  );
});

test('Decision Activity behind a refused Deployment read is forbidden, not unconfigured', async () => {
  // The two must not collapse: one is fixed with a role binding, the other with a controller flag.
  const data = await decisions({
    cluster, token,
    listFn: fakeList({ 'gatekeeper-system/deployments': forbidden() })
  });

  assert.equal(data.capability.state, 'forbidden');
  assert.notEqual(data.capability.state, 'not-configured');
});

test('library counts stay exact over the template ceiling — only the Constraint reads are skipped', async () => {
  const many = Array.from({ length: opa.MAX_CONSTRAINT_TEMPLATES + 1 }, (_, i) => template(`custom${i}`));
  const data = await collect({ cluster, token, listFn: fakeList({ constrainttemplates: many, namespaces: [] }), callFn: fakeCall() });
  assert.equal(data.summary.templateLimitExceeded, true);
  assert.equal(data.summary.library.custom, many.length);
});
