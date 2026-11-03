/**
 * btp.js: ServiceInstance/ServiceBinding inventory, reconciliation, idle-module evidence,
 * and binding-in-use cross-reference.
 *
 * Canaries stated per test.
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import btp from '../collectors/btp.js';
import _errors from '../errors.js';
const { ClusterError } = _errors;
import _signals2 from '../signals.js';
const { signalsOf } = _signals2;

const cluster = { id: 'test-cluster', displayName: 'Test', env: 'dev' };

function notFound() {
  return new ClusterError('UPSTREAM', 'not found', { status: 404 });
}
function forbidden() {
  return new ClusterError('FORBIDDEN', 'forbidden', { status: 403 });
}

function instance(overrides = {}) {
  return {
    metadata: { name: 'my-hana', namespace: 'prod', creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      serviceOfferingName: 'hana-cloud',
      servicePlanName: 'hana',
      userInfo: { username: 'jenkins-deployer' },
      parameters: { adminPassword: 'super-secret' },
      parametersFrom: [{ secretKeyRef: { name: 'params', key: 'blob' } }]
    },
    status: { instanceID: 'abc-123', conditions: [{ type: 'Ready', status: 'True' }] },
    ...overrides
  };
}

function binding(overrides = {}) {
  return {
    metadata: { name: 'my-hana-binding', namespace: 'prod', creationTimestamp: '2026-01-02T00:00:00Z' },
    spec: { secretName: 'my-hana-secret', serviceInstanceName: 'my-hana' },
    status: { instanceID: 'abc-123', conditions: [{ type: 'Ready', status: 'True' }] },
    ...overrides
  };
}

/** A discovery-probe double: GET /apis/<group> resolves to a served-versions body. */
function discoveryCallFn(servedGroups) {
  return async ({ path }) => {
    const group = path.replace('/apis/', '');
    if (!(group in servedGroups)) {
      const err = new ClusterError('UPSTREAM', 'not found', { status: 404 });
      throw err;
    }
    return { versions: servedGroups[group].map(v => ({ version: v })) };
  };
}

function makeListFn(byPath) {
  return async ({ path }) => {
    for (const [match, outcome] of byPath) {
      if (path.includes(match)) {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
    }
    throw new Error(`unexpected path ${path}`);
  };
}

/** Three Ready instances with their own instanceIDs: a readable, empty bindings list binds none. */
function threeInstances() {
  return ['a', 'b', 'c'].map(name => instance({
    metadata: { name, namespace: 'prod' },
    status: { instanceID: `id-${name}`, conditions: [{ type: 'Ready', status: 'True' }] }
  }));
}

/**
 * btp.js as production loads it. The router calls `collect(ctx)` with no transport, so every read
 * goes through the `list` and `call` btp.js destructured from '../k8s' when it was required: the
 * stubs are mocked in for a fresh import, and the module registry is reset after.
 */
async function btpOverK8s(stubs) {
  vi.resetModules();
  vi.doMock('../k8s.js', async () => {
    const real = (await vi.importActual('../k8s.js')).default;
    return { default: { ...real, ...stubs } };
  });
  try {
    return (await import('../collectors/btp.js')).default;
  } finally {
    vi.doUnmock('../k8s.js');
    vi.resetModules();
  }
}

test('projectInstance never leaks userInfo, parameters or parametersFrom', () => {
  const projected = btp.projectInstance(instance());
  const serialized = JSON.stringify(projected);
  // Canary: removing the allowlist and spreading spec/status directly would put
  // "adminPassword" (inside spec.parameters) straight into this string.
  assert.ok(!serialized.includes('userInfo'));
  assert.ok(!serialized.includes('parameters'));
  assert.ok(!serialized.includes('parametersFrom'));
  assert.ok(!serialized.includes('super-secret'));
});

test('collect: the whole payload never contains userInfo/parameters/parametersFrom keys', async () => {
  const listFn = makeListFn([
    ['serviceinstances', [instance()]],
    ['servicebindings', [binding()]],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('"userInfo"'));
  assert.ok(!serialized.includes('"parameters"'));
  assert.ok(!serialized.includes('"parametersFrom"'));
});

test('reconcileInstancesToBindings joins primarily on status.instanceID', () => {
  const inst = instance();
  const bnd = binding();
  const joined = btp.reconcileInstancesToBindings([inst], [bnd]);
  assert.equal(joined[0].boundBindingCount, 1);
  assert.deepEqual(joined[0].boundBindingIds, ['prod/my-hana-binding']);
});

test('reconcileInstancesToBindings falls back to (namespace,name) only when instanceID is absent', () => {
  // Canary: matching by (namespace,name) unconditionally, even when a real instanceID exists
  // on both sides, would let a binding with a stale/wrong serviceInstanceName spec field
  // silently match an unrelated instance that merely shares its name coincidentally.
  const inst = instance({ status: { instanceID: 'abc-123', conditions: [] } });
  const bnd = binding({ status: { conditions: [] } }); // no instanceID
  const joined = btp.reconcileInstancesToBindings([inst], [bnd]);
  assert.equal(joined[0].boundBindingCount, 1);
});

test('reconcileInstancesToBindings: an unbound instance gets boundBindingCount 0', () => {
  const inst = instance({ metadata: { name: 'orphan', namespace: 'prod' }, status: { instanceID: 'zzz-999', conditions: [] } });
  const joined = btp.reconcileInstancesToBindings([inst], []);
  assert.equal(joined[0].boundBindingCount, 0);
});

test('collect: instancesWithNoBindingInThisCluster names the unbound instance, not a cost claim', async () => {
  const orphanInstance = instance({
    metadata: { name: 'orphan', namespace: 'prod' },
    status: { instanceID: 'zzz-999', conditions: [] }
  });
  const listFn = makeListFn([
    ['serviceinstances', [orphanInstance]],
    ['servicebindings', []],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  assert.deepEqual(result.instancesWithNoBindingInThisCluster, ['prod/orphan']);
  assert.equal(JSON.stringify(result).toLowerCase().includes('cost'), false);
  assert.equal(JSON.stringify(result).toLowerCase().includes('saving'), false);
});

test('projectBinding: rotationEnabled and neverRotated read directly, no duration parsing', () => {
  const bnd = binding({
    spec: { secretName: 'x', serviceInstanceName: 'my-hana', credentialsRotationPolicy: { enabled: true } },
    status: { instanceID: 'abc-123', conditions: [], lastCredentialsRotationTime: null }
  });
  const projected = btp.projectBinding(bnd);
  assert.equal(projected.rotationEnabled, true);
  assert.equal(projected.neverRotated, true);
});

test('evidenceFor: crd-absent, measured-zero and unavailable never collapse to the same shape', () => {
  // Canary: dropping the `absent === true` branch and falling through to the length-0 check
  // would report a genuinely-uninstalled CRD as "measured-zero" — indistinguishable from a
  // cluster that has the CRD and simply has no Functions yet.
  assert.equal(btp.evidenceFor({ unavailable: false, absent: true, items: [] }).evidence, 'crd-absent');
  assert.equal(btp.evidenceFor({ unavailable: false, absent: false, items: [] }).evidence, 'measured-zero');
  assert.equal(btp.evidenceFor({ unavailable: true, reason: 'FORBIDDEN', detail: 'x', items: [] }).evidence, 'unavailable');
  assert.equal(btp.evidenceFor({ unavailable: false, absent: false, items: [{}] }).evidence, 'measured');
});

test('functionEventEvidence: noEventSubscribers is a fact about subscribers, never "idle"', () => {
  const fn = { metadata: { name: 'my-fn', namespace: 'prod' } };
  const subs = new Map();
  const { noEventSubscribers, evidence } = btp.functionEventEvidence(fn, subs, { evidence: 'measured-zero' });
  assert.equal(noEventSubscribers, true);
  assert.equal(evidence, 'measured-zero');
});

test('functionEventEvidence: a subscription whose sink names the Function counts as subscribed', () => {
  const fn = { metadata: { name: 'my-fn', namespace: 'prod' } };
  const subs = new Map([['prod', [{ spec: { sink: 'http://my-fn.prod.svc.cluster.local' } }]]]);
  const { noEventSubscribers } = btp.functionEventEvidence(fn, subs, { evidence: 'measured' });
  assert.equal(noEventSubscribers, false);
});

test('functionEventEvidence: unavailable subscriptions propagate as null, never false', () => {
  // Canary: defaulting to `false` here (no subscribers found because we can't see any) would
  // report an unreadable cluster's every Function as confidently "has subscribers", which is
  // exactly the "failed read looks like good news" defect class this repo forbids.
  const fn = { metadata: { name: 'my-fn', namespace: 'prod' } };
  const { noEventSubscribers, evidence } = btp.functionEventEvidence(fn, new Map(), { evidence: 'unavailable' });
  assert.equal(noEventSubscribers, null);
  assert.equal(evidence, 'unavailable');
});

test('bindingUsage: envFrom match is a positive finding', () => {
  const pod = {
    metadata: { name: 'app-1', namespace: 'prod' },
    spec: { containers: [{ envFrom: [{ secretRef: { name: 'my-hana-secret' } }] }] }
  };
  const consumers = btp.bindingUsage('my-hana-secret', [pod]);
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].via.envFrom, true);
});

test('bindingUsage: volume match is a positive finding', () => {
  const pod = {
    metadata: { name: 'app-2', namespace: 'prod' },
    spec: { volumes: [{ secret: { secretName: 'my-hana-secret' } }] }
  };
  const consumers = btp.bindingUsage('my-hana-secret', [pod]);
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].via.volume, true);
});

test('bindingUsage: a pod with no imagePullSecrets reports null for that sub-check, not false', () => {
  // Canary: `Boolean(undefined-array.some(...))` on a missing imagePullSecrets would read as
  // `false`, which is indistinguishable from "checked and confirmed no pull secret" — the
  // task explicitly requires null there instead.
  const pod = {
    metadata: { name: 'app-3', namespace: 'prod' },
    spec: { containers: [{ envFrom: [{ secretRef: { name: 'my-hana-secret' } }] }] } // no imagePullSecrets
  };
  const consumers = btp.bindingUsage('my-hana-secret', [pod]);
  assert.equal(consumers[0].via.imagePullSecret, null);
});

test('bindingUsage: no match yields no consumers, never a negative "unused" claim', () => {
  const pod = { metadata: { name: 'app-4', namespace: 'prod' }, spec: { containers: [{}] } };
  const consumers = btp.bindingUsage('my-hana-secret', [pod]);
  assert.deepEqual(consumers, []);
});

test('collect: a 403 on serviceinstances is unavailable, never a fabricated empty list', async () => {
  const listFn = makeListFn([
    ['serviceinstances', forbidden()],
    ['servicebindings', []],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  assert.deepEqual(result.summary.unavailable, ['serviceinstances']);
  assert.equal(result.summary.instanceCount, 0);
});

test('collect: functions CRD confirmed absent via group discovery reports crd-absent, not measured-zero', async () => {
  const listFn = makeListFn([
    ['serviceinstances', []],
    ['servicebindings', []],
    ['functions', notFound()],
    ['subscriptions', []],
    ['pods', []]
  ]);
  // discoveryCallFn with no groups served -> /apis/serverless.kyma-project.io 404s too.
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  assert.equal(result.summary.functionsEvidence.evidence, 'crd-absent');
});

test('collect: full happy path wires instances, bindings, functions and usage together', async () => {
  const listFn = makeListFn([
    ['serviceinstances', [instance()]],
    ['servicebindings', [binding()]],
    ['functions', [{ metadata: { name: 'my-fn', namespace: 'prod' } }]],
    ['subscriptions', []],
    ['pods', [{
      metadata: { name: 'app', namespace: 'prod' },
      spec: { containers: [{ envFrom: [{ secretRef: { name: 'my-hana-secret' } }] }] }
    }]]
  ]);
  const result = await btp.collect({
    cluster, token: 't', listFn,
    callFn: discoveryCallFn({ 'serverless.kyma-project.io': ['v1alpha2'], 'eventing.kyma-project.io': ['v1alpha2'] })
  });
  assert.equal(result.summary.instanceCount, 1);
  assert.equal(result.summary.bindingCount, 1);
  assert.equal(result.summary.instancesWithNoBindingInThisClusterCount, 0);
  assert.equal(result.functions[0].noEventSubscribers, true);
  assert.equal(result.bindingUsage[0].consumers.length, 1);
});

test('collect: a BTP version the group does not serve is unavailable, never 0 (canary: v1beta2 read 0 of 8)', async () => {
  const listFn = makeListFn([
    ['serviceinstances', notFound()],
    ['servicebindings', notFound()],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({ 'services.cloud.sap.com': ['v1alpha1'] }) });
  assert.deepEqual(result.summary.unavailable, ['serviceinstances', 'servicebindings']);
});

test('collect: a function list 404 under a served group that lacks the version is unavailable, not measured-zero', async () => {
  const listFn = makeListFn([
    ['serviceinstances', []],
    ['servicebindings', []],
    ['functions', notFound()],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({ 'serverless.kyma-project.io': ['v1alpha1'] }) });
  assert.equal(result.summary.functionsEvidence.evidence, 'unavailable');
  assert.deepEqual(result.summary.unavailable, ['functions']);
});

test('collect: the BTP operator group is unregistered, so its zero is true', async () => {
  const listFn = makeListFn([
    ['serviceinstances', notFound()],
    ['servicebindings', notFound()],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  assert.deepEqual(result.summary.unavailable, []);
  assert.equal(result.summary.instanceCount, 0);
});

test('collect reads the version the SAP BTP service operator serves', async () => {
  const paths = [];
  const listFn = async ({ path }) => {
    paths.push(path);
    return [];
  };
  await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  assert.ok(paths.includes('/apis/services.cloud.sap.com/v1/serviceinstances'), paths.join(', '));
  assert.ok(paths.includes('/apis/services.cloud.sap.com/v1/servicebindings'), paths.join(', '));
});

test('collect with no transport, as the router calls it, probes discovery through k8s.call', async () => {
  // Canary: deleting the `callFn = call` default keeps every other test here green (each passes
  // callFn) while production skips the probe and reads an unserved version as 0 instances.
  const probed = [];
  const served = discoveryCallFn({ 'services.cloud.sap.com': ['v1alpha1'] });
  const { collect } = await btpOverK8s({
    list: makeListFn([
      ['serviceinstances', notFound()],
      ['servicebindings', notFound()],
      ['functions', []],
      ['subscriptions', []],
      ['pods', []]
    ]),
    call: async args => {
      probed.push(args.path);
      return served(args);
    }
  });
  const result = await collect({ cluster, token: 't' });
  assert.ok(probed.includes('/apis/services.cloud.sap.com'), `probed: ${probed.join(', ') || 'nothing'}`);
  assert.deepEqual(result.summary.unavailable, ['serviceinstances', 'servicebindings']);
});

test('collect: a refused bindings read leaves every binding-derived count unread, never "3 with no binding here"', async () => {
  // Canary: joining the instances to the refused, so empty, bindings list names all three as
  // unbound, and the rail's status dot warned about every one of them.
  const listFn = makeListFn([
    ['serviceinstances', threeInstances()],
    ['servicebindings', forbidden()],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  assert.deepEqual(result.summary.unavailable, ['servicebindings']);
  assert.equal(result.summary.instanceCount, 3);
  // The raw count follows the read, as instanceCount does; `unavailable` above marks it unread.
  assert.equal(result.summary.bindingCount, 0);
  assert.equal(result.summary.instancesWithNoBindingInThisClusterCount, null);
  assert.equal(result.instancesWithNoBindingInThisCluster, null);
  assert.deepEqual(signalsOf('btpServices', [{ cluster: { id: cluster.id }, ok: true, data: result }]), []);
});

test('collect: a servicebindings 404 under a served v1 is a failed read too, so the join stays unread', async () => {
  // Canary: the same invented finding by a second road. Discovery says v1 is served, so the 404 is
  // a contradiction rather than an absence, and the bindings list is just as empty.
  const listFn = makeListFn([
    ['serviceinstances', threeInstances()],
    ['servicebindings', notFound()],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({ 'services.cloud.sap.com': ['v1', 'v1alpha1'] }) });
  assert.deepEqual(result.summary.unavailable, ['servicebindings']);
  assert.equal(result.summary.bindingCount, 0);
  assert.equal(result.summary.instancesWithNoBindingInThisClusterCount, null);
});

test('collect: a refused serviceinstances read leaves the no-binding count unread, not a trusted 0', async () => {
  // Canary: the join has two sides. Counting it over the refused, so empty, instances list says
  // "no instance lacks a binding", which is good news nobody read.
  const listFn = makeListFn([
    ['serviceinstances', forbidden()],
    ['servicebindings', [binding()]],
    ['functions', []],
    ['subscriptions', []],
    ['pods', []]
  ]);
  const result = await btp.collect({ cluster, token: 't', listFn, callFn: discoveryCallFn({}) });
  assert.deepEqual(result.summary.unavailable, ['serviceinstances']);
  assert.equal(result.summary.bindingCount, 1);
  assert.equal(result.summary.instancesWithNoBindingInThisClusterCount, null);
  assert.equal(result.instancesWithNoBindingInThisCluster, null);
});

test('collect: a refused discovery probe keeps FORBIDDEN, so the copy says permission rather than upstream', async () => {
  // Canary: a hard-coded UPSTREAM turns a 403 on /apis/<group> into "the cluster answered, but not
  // in a usable form", and sends the operator to the API server instead of the fleet-reader role.
  const listFn = makeListFn([
    ['serviceinstances', []],
    ['servicebindings', []],
    ['functions', notFound()],
    ['subscriptions', notFound()],
    ['pods', []]
  ]);
  const served = discoveryCallFn({ 'eventing.kyma-project.io': ['v1alpha1'] });
  const callFn = async args => {
    if (args.path === '/apis/serverless.kyma-project.io') throw forbidden();
    return served(args);
  };
  const result = await btp.collect({ cluster, token: 't', listFn, callFn });
  assert.equal(result.summary.functionsEvidence.reason, 'FORBIDDEN');
  // A probe that answered still means UPSTREAM: the group is registered, the version is not served.
  assert.equal(result.summary.subscriptionsEvidence.reason, 'UPSTREAM');
  assert.deepEqual(result.summary.unavailable, ['functions', 'subscriptions']);
});
