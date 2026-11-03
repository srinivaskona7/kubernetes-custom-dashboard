import { test } from 'vitest';
import assert from 'node:assert';

import _mesh from '../collectors/mesh.js';
const {
  collect, sidecarCoverage, mtlsVerdicts, ingressBindingIntegrity, authorizationPosture, ownerBucket
} = _mesh;

// ---------------------------------------------------------------- helpers

function pod(name, namespace, { containers = [], initContainers = [], owners = [], labels = {}, annotations = {} } = {}) {
  return {
    metadata: { name, namespace, labels, annotations, ownerReferences: owners },
    spec: { containers, initContainers }
  };
}

function fakeList(responses) {
  return async ({ path }) => {
    for (const key of Object.keys(responses)) {
      if (path === key || path.endsWith(key)) return responses[key];
    }
    return [];
  };
}

// ---------------------------------------------------------------- A1 sidecar coverage

test('a native sidecar (init container) counts as in-mesh, not just a classic container', () => {
  const p = pod('web-abc123xy-x1y2z', 'shop', {
    initContainers: [{ name: 'istio-proxy' }],
    owners: [{ kind: 'ReplicaSet', name: 'web-abc123xy', controller: true }]
  });
  const result = sidecarCoverage([p], null, null);
  assert.strictEqual(result.byDeployment[0].inMeshCount, 1);
  assert.strictEqual(result.byDeployment[0].pods[0].sidecarMode, 'native');
  // Canary: checking only `containers` (not initContainers) for istio-proxy is exactly the
  // regression this verdict exists to prevent — revert to `containers.some(...)` alone and
  // this pod would report inMesh: false / coverage 0% on a fully-meshed native-sidecar pod.
});

test('a pod with istio-proxy as a classic container is also in-mesh', () => {
  const p = pod('api-def456uv-a1b2c', 'shop', {
    containers: [{ name: 'app' }, { name: 'istio-proxy' }],
    owners: [{ kind: 'ReplicaSet', name: 'api-def456uv', controller: true }]
  });
  const result = sidecarCoverage([p], null, null);
  assert.strictEqual(result.byDeployment[0].pods[0].sidecarMode, 'classic');
  assert.strictEqual(result.byDeployment[0].inMeshCount, 1);
});

test('pods are grouped by Deployment name with the ReplicaSet hash stripped', () => {
  const p1 = pod('web-abc123xy-aaaaa', 'shop', { owners: [{ kind: 'ReplicaSet', name: 'web-abc123xy', controller: true }] });
  const p2 = pod('web-abc123xy-bbbbb', 'shop', { owners: [{ kind: 'ReplicaSet', name: 'web-abc123xy', controller: true }] });
  const result = sidecarCoverage([p1, p2], null, null);
  assert.strictEqual(result.byDeployment.length, 1);
  assert.strictEqual(result.byDeployment[0].name, 'web');
  assert.strictEqual(result.byDeployment[0].podCount, 2);
  // Canary: change GENERATED_SUFFIX/ownerBucket to return the raw RS name (no strip) and
  // these two pods (same RS) would still group fine, but a real fleet with two RS
  // generations of the same Deployment would split into two buckets instead of one —
  // confirmed by asserting `.name === 'web'` rather than `'web-abc123xy'`.
});

test('a pod with no ownerReferences lands in the unowned bucket, not dropped', () => {
  const p = pod('standalone', 'shop', {});
  const { bucket, kind } = ownerBucket(p);
  assert.strictEqual(bucket, 'unowned');
  assert.strictEqual(kind, null);
  const result = sidecarCoverage([p], null, null);
  assert.strictEqual(result.byDeployment.length, 1);
  assert.strictEqual(result.byDeployment[0].name, 'unowned');
});

test('ambient mode pods (namespace or pod label) are excluded from sidecar coverage percent', () => {
  const p = pod('ambient-app-x1y2z-aaaaa', 'mesh-ambient', {
    owners: [{ kind: 'ReplicaSet', name: 'ambient-app-x1y2z', controller: true }],
    labels: { 'istio.io/dataplane-mode': 'ambient' }
  });
  const result = sidecarCoverage([p], null, null);
  assert.strictEqual(result.byDeployment[0].ambient, true);
  assert.strictEqual(result.byDeployment[0].coveragePercent, null);
  // Canary: drop the `entry.ambient ? null : ...` guard in sidecarCoverage's coveragePercent
  // and this ambient, unsidecar'd workload would report 0% coverage — a false "unmeshed"
  // finding for a workload that is in fact meshed via ztunnel.
});

test('ztunnel DaemonSet presence is null (not false) when the DaemonSet read itself failed', () => {
  const result = sidecarCoverage([], null, null);
  assert.strictEqual(result.ztunnelPresent, null);
});

// ---------------------------------------------------------------- A2 mTLS

test('an absent top-level mode resolves upward to the next-broader scope, not to a bare UNSET', () => {
  const meshPA = { metadata: { namespace: 'istio-system', name: 'default' }, spec: { mtls: { mode: 'STRICT' } } };
  // workload-scoped PA with NO top-level mode of its own — only a selector.
  const workloadPA = { metadata: { namespace: 'shop', name: 'web-mtls' }, spec: { selector: { matchLabels: { app: 'web' } } } };
  const verdicts = mtlsVerdicts([meshPA, workloadPA], []);
  const workloadVerdict = verdicts.find(v => v.scope === 'workload');
  assert.strictEqual(workloadVerdict.mode, 'STRICT');
  assert.strictEqual(workloadVerdict.modeSource, 'mesh');
  // Canary: change resolveTopLevelMode to return 'UNSET' (or fail to fall through to meshPA)
  // when workloadPA.mode is undefined, and this assertion on `mode === 'STRICT'` goes red —
  // it would instead be 'UNSET' or the bare default, losing the mesh-wide STRICT entirely.
});

test('a port-level override changes the outcome for that port even against a contrary top-level mode', () => {
  const meshPA = {
    metadata: { namespace: 'istio-system', name: 'default' },
    spec: { mtls: { mode: 'STRICT' }, portLevelMtls: { 9090: { mode: 'DISABLE' } } }
  };
  const verdicts = mtlsVerdicts([meshPA], []);
  const meshVerdict = verdicts.find(v => v.scope === 'mesh');
  assert.strictEqual(meshVerdict.mode, 'STRICT');
  assert.strictEqual(meshVerdict.portOverrides['9090'], 'DISABLE');
  // Canary: make resolvePortModes always fall back to topLevel.mode (ignore the per-scope
  // portLevelMtls maps) and portOverrides['9090'] would read 'STRICT' instead of 'DISABLE',
  // silently hiding a plaintext port on an otherwise-STRICT mesh.
});

test('mTLS verdicts are null when either PeerAuthentications or DestinationRules is unavailable', async () => {
  const listFn = fakeList({
    'pods': [],
    '/api/v1/namespaces': [],
    'virtualservices': [],
    'istio-gateways': [],
    'destinationrules': [],
    'authorizationpolicies': []
  });
  const failingListFn = async (args) => {
    if (args.path.includes('peerauthentications')) {
      const err = new Error('rbac denial'); err.status = 403; throw err;
    }
    return listFn(args);
  };
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn: failingListFn });
  assert.strictEqual(out.mtls.verdicts, null);
  assert.ok(out.summary.unavailable.includes('peerauthentications'));
  // Canary: return `mtlsVerdicts(...)` unconditionally (ignore mtlsInputsAvailable) in
  // collect() and out.mtls.verdicts would be an array (built from an empty PA list) instead
  // of null, silently claiming a verdict was computed when the read that could have
  // contradicted it (an override) never happened.
});

// ---------------------------------------------------------------- A3 ingress binding integrity

test('a Gateway with no VirtualService referencing it is unbound', () => {
  const gw = { metadata: { namespace: 'shop', name: 'shop-gw' }, spec: { servers: [{ hosts: ['shop.example.com'] }] } };
  const result = ingressBindingIntegrity([gw], []);
  assert.deepStrictEqual(result.unboundGateways, ['shop/shop-gw']);
  // Canary: seed `referenced` with every gateway id unconditionally (e.g. `gatewayIds.forEach(id => referenced.add(id))`
  // before the VS loop) and unboundGateways would come back [] even though no VS exists.
});

test('a VirtualService referencing the literal "mesh" keyword is not unbound-gateway noise', () => {
  const vs = { metadata: { namespace: 'shop', name: 'internal-vs' }, spec: { gateways: ['mesh'], hosts: ['internal.svc'] } };
  const result = ingressBindingIntegrity([], [vs]);
  assert.deepStrictEqual(result.virtualServicesWithMissingGateway, []);
  // Canary: remove the `if (resolved === null) continue` short-circuit for the 'mesh' keyword
  // and this VS would report a missing gateway, since no Gateway object is named "mesh".
});

test('the reverse join: a VirtualService referencing a Gateway that does not exist', () => {
  const vs = { metadata: { namespace: 'shop', name: 'orphan-vs' }, spec: { gateways: ['shop/does-not-exist'], hosts: ['x.example.com'] } };
  const result = ingressBindingIntegrity([], [vs]);
  assert.deepStrictEqual(result.virtualServicesWithMissingGateway, ['shop/orphan-vs']);
});

test('the same host bound through two different Gateways is a duplicate exposure', () => {
  const gw1 = { metadata: { namespace: 'shop', name: 'gw-a' }, spec: { servers: [{ hosts: ['api.example.com'] }] } };
  const gw2 = { metadata: { namespace: 'shop', name: 'gw-b' }, spec: { servers: [{ hosts: ['api.example.com'] }] } };
  const result = ingressBindingIntegrity([gw1, gw2], []);
  assert.strictEqual(result.duplicateHostExposures.length, 1);
  assert.strictEqual(result.duplicateHostExposures[0].host, 'api.example.com');
  assert.strictEqual(result.duplicateHostExposures[0].gateways.length, 2);
  // Canary: key hostToGateways by `${host}:${gatewayId}` instead of by bare host and the
  // filter `ids.size > 1` would never trigger — every key would be unique by construction.
});

test('all three ingress joins are null (not partial) when either side is unavailable', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('gateways')) { const err = new Error('rbac'); err.status = 403; throw err; }
    return [];
  };
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn });
  assert.strictEqual(out.ingressBindingIntegrity.unboundGateways, null);
  assert.strictEqual(out.ingressBindingIntegrity.virtualServicesWithMissingGateway, null);
  assert.strictEqual(out.ingressBindingIntegrity.duplicateHostExposures, null);
  // Canary: gate only `unboundGateways` on bindingInputsAvailable and leave the other two
  // computed unconditionally — they would come back as [] (a one-sided partial answer)
  // instead of null when Gateways failed to read.
});

// ---------------------------------------------------------------- A4 authorization posture

test('DENY with an empty rules list is inert, not denyAll', () => {
  const ap = { metadata: { namespace: 'shop', name: 'deny-nothing' }, spec: { action: 'DENY', rules: [] } };
  const result = authorizationPosture([ap], new Map());
  assert.strictEqual(result.policies[0].classification, 'inert');
  // Canary: fold the `action === 'DENY' && rules.length === 0` branch into a generic
  // `action === 'DENY' -> 'deny'` and this policy would be classified 'deny' (read as
  // denyAll), the opposite of what an empty rules list on DENY actually does.
});

test('ALLOW with an empty rules list is allowAll, flagged plainly', () => {
  const ap = { metadata: { namespace: 'shop', name: 'allow-everything' }, spec: { action: 'ALLOW', rules: [] } };
  const result = authorizationPosture([ap], new Map());
  assert.strictEqual(result.policies[0].classification, 'allowAll');
});

test('a workload-scoped policy in a namespace with no sidecar coverage is unenforceable', () => {
  const ap = { metadata: { namespace: 'shop', name: 'needs-sidecar' }, spec: { action: 'DENY', rules: [{}], selector: { matchLabels: { app: 'web' } } } };
  const coverage = new Map([['shop', { inMeshCount: 0, podCount: 2, ambient: false }]]);
  const result = authorizationPosture([ap], coverage);
  assert.deepStrictEqual(result.unenforceablePolicies, [{ namespace: 'shop', name: 'needs-sidecar' }]);
  // Canary: drop the `if (!cov || cov.ambient) return false;` guard's ambient check and an
  // ambient namespace with inMeshCount 0 (correct — ambient has no sidecar by design) would
  // wrongly show up as unenforceable too.
});

test('a workload-scoped policy in an ambient namespace is NOT unenforceable', () => {
  const ap = { metadata: { namespace: 'amb', name: 'ambient-policy' }, spec: { action: 'DENY', rules: [{}], selector: { matchLabels: { app: 'web' } } } };
  const coverage = new Map([['amb', { inMeshCount: 0, podCount: 2, ambient: true }]]);
  const result = authorizationPosture([ap], coverage);
  assert.deepStrictEqual(result.unenforceablePolicies, []);
});

test('a mesh-wide AuthorizationPolicy (no selector/targetRefs) is scoped to the whole fleet, not a root namespace', () => {
  const ap = { metadata: { namespace: 'istio-system', name: 'mesh-wide-deny' }, spec: { action: 'DENY', rules: [{}] } };
  const result = authorizationPosture([ap], new Map());
  assert.strictEqual(result.policies[0].scope, 'namespace-or-mesh');
  // Canary: classify a selector-less policy as 'workload' by mistake and it would then be
  // checked against sidecar coverage in ITS OWN namespace only for unenforceability, instead
  // of being recognised as applying fleet-wide (this collector does not narrow it further).
});

test('authorization posture is null when authorizationpolicies is unavailable', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('authorizationpolicies')) { const err = new Error('rbac'); err.status = 403; throw err; }
    return [];
  };
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn });
  assert.strictEqual(out.authorizationPosture.policies, null);
  assert.strictEqual(out.authorizationPosture.unenforceablePolicies, null);
});

// ---------------------------------------------------------------- collect() wiring / summary

test('collect() reports pods and namespaces as unavailable (never a confident zero) on a 403', async () => {
  const listFn = async ({ path }) => {
    if (path.endsWith('/pods')) { const err = new Error('rbac'); err.status = 403; throw err; }
    return [];
  };
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn });
  assert.strictEqual(out.sidecarCoverage, null);
  assert.ok(out.summary.unavailable.includes('pods'));
  // Canary: swap `requiredList` for `safeList` on the pods read and a 403 would still be
  // reported as unavailable (both do that) — but a genuine 404 (impossible for pods, yet
  // worth guarding) would then be read as a confident zero cluster instead of the red flag
  // requiredList's own test suite covers; this collector must keep using requiredList here.
});

test('collect() reports summary.unavailable and summary.truncated always, even on a clean read', async () => {
  const listFn = fakeList({
    'pods': [], '/api/v1/namespaces': [], 'virtualservices': [], 'istio-gateways': [],
    'destinationrules': [], 'peerauthentications': [], 'authorizationpolicies': [], 'daemonsets': []
  });
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn });
  assert.deepStrictEqual(out.summary.unavailable, []);
  assert.deepStrictEqual(out.summary.truncated, []);
  assert.ok(Array.isArray(out.sidecarCoverage.byDeployment));
  assert.ok(Array.isArray(out.mtls.verdicts));
});
