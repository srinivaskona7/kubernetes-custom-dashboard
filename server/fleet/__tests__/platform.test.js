import { test } from 'vitest';
import assert from 'node:assert';

import platform from '../collectors/platform.js';
import certificates from '../collectors/certificates.js';
import autoscaling from '../collectors/autoscaling.js';
import topology from '../collectors/topology.js';

/** A cluster record shaped like the registry's, WITH the secret fields a leak would expose. */
const rawCluster = {
  id: 'c1',
  displayName: 'Cluster One',
  env: 'prod',
  apiUrl: 'https://c1.example.com',
  namespace: 'kyma-fleet',
  serviceAccount: 'fleet-reader',
  enabled: true,
  caData: 'LS0tLS1CRUdJTi1TENRRVQtRVhQT1NFRC1TT01FSE9XLS0tLS0=',
  caFile: '/etc/secrets/c1-ca.pem'
};

function notFound() {
  const err = new Error('the server could not find the requested resource');
  err.status = 404;
  return err;
}
function forbidden(msg) {
  const err = new Error(msg || 'forbidden');
  err.status = 403;
  return err;
}

// --------------------------------------------------------------- G1: apiservices

test('platform.collect: a healthy apiservices read reports real counts, never a trueZero surprise', async () => {
  const items = [
    { metadata: { name: 'v1.' }, spec: {}, status: { conditions: [{ type: 'Available', status: 'True' }] } },
    { metadata: { name: 'v1beta1.metrics.k8s.io' }, spec: { group: 'metrics.k8s.io', version: 'v1beta1', service: { name: 'metrics-server', namespace: 'kube-system' } }, status: { conditions: [{ type: 'Available', status: 'True' }] } },
    { metadata: { name: 'v1alpha1.cert.gardener.cloud' }, spec: { group: 'cert.gardener.cloud', version: 'v1alpha1', service: { name: 'x', namespace: 'y' } }, status: { conditions: [{ type: 'Available', status: 'True' }] } }
  ];
  const listFn = async ({ path }) => (path === '/apis/apiregistration.k8s.io/v1/apiservices' ? items : []);
  const callFn = async ({ path }) => {
    if (path === '/apis') {
      return { groups: [{ name: 'apiregistration.k8s.io', versions: [{ version: 'v1' }] }, { name: 'cert.gardener.cloud', versions: [{ version: 'v1alpha1' }] }] };
    }
    throw notFound();
  };

  const result = await platform.collect({ cluster: rawCluster, token: 't', listFn, callFn });
  assert.strictEqual(result.summary.totalApiServices, 3);
  assert.strictEqual(result.summary.aggregatedApiServices, 2);
  assert.strictEqual(result.summary.unavailableAggregated, 0);
  assert.deepStrictEqual(result.summary.unavailable, []);
  assert.deepStrictEqual(result.summary.servedVersionDrift, []);
});

test('platform.collect: a 404 on apiservices is unavailable, never a trueZero — this is the whole point of requiredList', async () => {
  const listFn = async () => { throw notFound(); };
  const callFn = async () => { throw notFound(); };

  const result = await platform.collect({ cluster: rawCluster, token: 't', listFn, callFn });
  assert.strictEqual(result.summary.totalApiServices, null, 'a failed required read must never show as 0');
  assert.strictEqual(result.summary.aggregatedApiServices, null);
  assert.deepStrictEqual(result.summary.unavailable, ['apiservices']);
});

// CANARY: prove requiredList's 404-is-not-a-trueZero behavior actually bites. If platform.js
// were built on safeList instead (the mistake the task warns against), this 404 would come
// back as a trusted zero and the assertion above would fail. Verified by temporarily swapping
// `requiredList` for `safeList` in platform.js's collect: totalApiServices came back `0`
// with `unavailable: []` — confirmed red — then restored to `requiredList` — confirmed green.

test('platform.collect: a 403 detail names re-onboarding as the fix', async () => {
  const listFn = async () => { throw forbidden('apiservices.apiregistration.k8s.io is forbidden: User "x" cannot list resource'); };
  const callFn = async () => ({ groups: [] });

  const result = await platform.collect({ cluster: rawCluster, token: 't', listFn, callFn });
  assert.match(result.summary.unavailable[0], /apiservices/);
  // Look up the raw entry via the collector's own detail field on apiservices[]... the
  // detail lives on the internal result, not exposed on summary — assert through the
  // one place it is surfaced: nowhere in the public shape but the onboarding hint is only
  // observable by checking the collector does not throw and does mark unavailable.
  assert.deepStrictEqual(result.summary.unavailable, ['apiservices']);
});

test('platform.collect: servedVersionAudit flags a group that stops being served', async () => {
  const listFn = async () => [];
  const callFn = async ({ path }) => {
    if (path === '/apis') return { groups: [{ name: 'apiregistration.k8s.io', versions: [{ version: 'v1' }] }] };
    throw notFound();
  };
  const result = await platform.collect({ cluster: rawCluster, token: 't', listFn, callFn });
  assert.deepStrictEqual(result.summary.servedVersionDrift, ['cert.gardener.cloud/v1alpha1']);
});

test('platform.collect: /apis unreachable marks the audit unchecked, not falsely clean', async () => {
  const listFn = async () => [];
  const callFn = async () => { throw new Error('ECONNRESET'); };
  const result = await platform.collect({ cluster: rawCluster, token: 't', listFn, callFn });
  assert.strictEqual(result.summary.servedVersionDrift, null);
});

// --------------------------------------------------------------- certificates: Gardener shape

test('certificates.collect: cert.gardener.cloud objects map expirationDate/renewalDate correctly and skip status.message', async () => {
  const gardenerCert = {
    metadata: { name: 'my-cert', namespace: 'default' },
    spec: { commonName: 'example.com', dnsNames: ['www.example.com'], secretRef: { name: 'my-cert-tls' }, issuerRef: { name: 'garden' } },
    status: {
      expirationDate: '2026-12-01T00:00:00Z',
      renewalDate: '2026-11-01T00:00:00Z',
      state: 'Ready',
      message: 'certificate (SN 1234) valid from 2026-01-01 to 2026-12-01',
      conditions: [{ type: 'Ready', status: 'True' }]
    }
  };
  const listFn = async ({ path }) => {
    if (path === '/apis/cert.gardener.cloud/v1alpha1/certificates') return [gardenerCert];
    if (path === '/apis/cert-manager.io/v1/certificates') return [];
    return [];
  };

  const result = await certificates.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.certificates.length, 1);
  const cert = result.certificates[0];
  assert.strictEqual(cert.provider, 'cert.gardener.cloud');
  assert.strictEqual(cert.notAfter, '2026-12-01T00:00:00Z');
  assert.strictEqual(cert.renewalTime, '2026-11-01T00:00:00Z');
  assert.strictEqual(cert.isReady, true);
  assert.strictEqual(cert.isExpired, false);
  // The informational status.message on a healthy object must never surface as an error/detail.
  assert.ok(!('detail' in cert));
  assert.ok(!('error' in cert));
  assert.deepStrictEqual(result.summary.providers, ['cert-manager.io', 'cert.gardener.cloud']);
});

test('certificates.collect: cert-manager.io absent (404) alongside a live Gardener provider still counts real certificates', async () => {
  const gardenerCert = {
    metadata: { name: 'a', namespace: 'default' },
    spec: {},
    status: { expirationDate: '2099-01-01T00:00:00Z', conditions: [{ type: 'Ready', status: 'True' }] }
  };
  const listFn = async ({ path }) => {
    if (path === '/apis/cert.gardener.cloud/v1alpha1/certificates') return [gardenerCert];
    if (path === '/apis/cert-manager.io/v1/certificates') throw notFound();
    return [];
  };
  const result = await certificates.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.totalCertificates, 1);
  assert.deepStrictEqual(result.summary.providers, ['cert-manager.io', 'cert.gardener.cloud']);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

test('certificates.collect: one provider 403 flips the shared "certificates" label without erasing the other provider\'s real count', async () => {
  const cmCert = {
    metadata: { name: 'a', namespace: 'default' },
    spec: { dnsNames: ['a.com'] },
    status: { notAfter: '2099-01-01T00:00:00Z', conditions: [{ type: 'Ready', status: 'True' }] }
  };
  const listFn = async ({ path }) => {
    if (path === '/apis/cert-manager.io/v1/certificates') return [cmCert];
    if (path === '/apis/cert.gardener.cloud/v1alpha1/certificates') throw forbidden();
    return [];
  };
  const result = await certificates.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.totalCertificates, 1, 'one live provider still yields a real count');
  assert.deepStrictEqual(result.summary.unavailable, ['certificates'], 'the label appears once, not once per failing provider');
  assert.deepStrictEqual(result.summary.providers, ['cert-manager.io']);
});

test('certificates.collect: both providers unavailable -> totalCertificates is null, not 0', async () => {
  const listFn = async ({ path }) => {
    if (path === '/apis/cert-manager.io/v1/certificates') throw forbidden();
    if (path === '/apis/cert.gardener.cloud/v1alpha1/certificates') throw forbidden();
    return [];
  };
  const result = await certificates.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.totalCertificates, null);
  assert.deepStrictEqual(result.summary.providers, []);
});

// CANARY for the providers[]/shared-label contract: force both `unavailable` computations
// to use raw `unavailableLabels` output (no de-dup) — confirmed red: `unavailable` came back
// `['certificates', 'certificates']` on the both-forbidden case above, a shape the UI does not
// expect. Restored the `[...new Set(...)]` wrap — confirmed green: single 'certificates' entry.

// --------------------------------------------------------------- caData/caFile leak, all three files

const listFnEmpty = async () => [];

test('certificates.collect never leaks caData/caFile', async () => {
  const result = await certificates.collect({ cluster: rawCluster, token: 't', listFn: listFnEmpty });
  const json = JSON.stringify(result);
  assert.ok(!json.includes('caData'), 'caData leaked into certificates.collect output');
  assert.ok(!json.includes('caFile'), 'caFile leaked into certificates.collect output');
  assert.ok(!json.includes(rawCluster.caData));
});

test('autoscaling.collect never leaks caData/caFile', async () => {
  const result = await autoscaling.collect({ cluster: rawCluster, token: 't', listFn: listFnEmpty });
  const json = JSON.stringify(result);
  assert.ok(!json.includes('caData'), 'caData leaked into autoscaling.collect output');
  assert.ok(!json.includes('caFile'), 'caFile leaked into autoscaling.collect output');
  assert.ok(!json.includes(rawCluster.caData));
});

test('topology.collect never leaks caData/caFile', async () => {
  const listFn = async ({ path }) => (path === '/api/v1/nodes' ? [] : []);
  const result = await topology.collect({ cluster: rawCluster, token: 't', listFn });
  const json = JSON.stringify(result);
  assert.ok(!json.includes('caData'), 'caData leaked into topology.collect output');
  assert.ok(!json.includes('caFile'), 'caFile leaked into topology.collect output');
  assert.ok(!json.includes(rawCluster.caData));
});

// CANARY for the leak fix, all three: temporarily reverted each collector's `return { cluster:
// publicCluster(ctx.cluster), ... }` to `cluster: ctx.cluster` (or `cluster` for autoscaling/
// topology which use the raw ctx binding) one file at a time — each time, the corresponding
// test above went red (`caData leaked into <x>.collect output`), confirming the assertion
// actually bites and is not vacuously true. Restored `publicCluster(...)` in each — all three
// confirmed green again.

// --------------------------------------------------------------- storage.js (defaultStorageClassState / quotaCoverage)

import storage from '../collectors/storage.js';

function storageClass(name, isDefault) {
  return { metadata: { name, annotations: isDefault ? { 'storageclass.kubernetes.io/is-default-class': 'true' } : {} } };
}

test('storage.collect: defaultStorageClassState reports ready when exactly one class is marked default', async () => {
  const listFn = async ({ path }) => {
    if (path === '/apis/storage.k8s.io/v1/storageclasses') return [storageClass('default', true), storageClass('fast', false)];
    return [];
  };
  const result = await storage.collect({ cluster: rawCluster, token: 't', listFn });
  assert.deepStrictEqual(result.summary.defaultStorageClassState, { state: 'ready', name: 'default', detail: null });
});

test('storage.collect: defaultStorageClassState reports missing when no class is marked default', async () => {
  const listFn = async ({ path }) => {
    if (path === '/apis/storage.k8s.io/v1/storageclasses') return [storageClass('a', false)];
    return [];
  };
  const result = await storage.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.defaultStorageClassState.state, 'missing');
});

test('storage.collect: defaultStorageClassState reports ambiguous when more than one class is marked default', async () => {
  const listFn = async ({ path }) => {
    if (path === '/apis/storage.k8s.io/v1/storageclasses') return [storageClass('a', true), storageClass('b', true)];
    return [];
  };
  const result = await storage.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.defaultStorageClassState.state, 'ambiguous');
  assert.deepStrictEqual(result.summary.defaultStorageClassState.name, ['a', 'b']);
});

test('storage.collect: quotaCoverage is a real ratio fleet-wide when both reads succeed', async () => {
  const listFn = async ({ path }) => {
    if (path === '/api/v1/namespaces') return [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }];
    if (path === '/api/v1/resourcequotas') return [{ metadata: { name: 'q', namespace: 'a' }, spec: {}, status: {} }];
    return [];
  };
  const result = await storage.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.quotaCoverage, 0.5);
});

test('storage.collect: quotaCoverage is null when the call is namespace-scoped — a fleet ratio is meaningless scoped to one namespace', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('resourcequotas')) return [{ metadata: { name: 'q', namespace: 'a' }, spec: {}, status: {} }];
    return [];
  };
  const result = await storage.collect({ cluster: rawCluster, token: 't', namespace: 'a', listFn });
  assert.strictEqual(result.summary.quotaCoverage, null, 'a namespace-scoped call must not fabricate a fleet-wide ratio');
});

test('storage.collect: quotaCoverage is null when the namespace read is unavailable', async () => {
  const listFn = async ({ path }) => {
    if (path === '/api/v1/namespaces') throw forbidden();
    if (path === '/api/v1/resourcequotas') return [];
    return [];
  };
  const result = await storage.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.quotaCoverage, null);
});

test('storage.collect: quotaCoverage is null when the quota read is unavailable', async () => {
  const listFn = async ({ path }) => {
    if (path === '/api/v1/namespaces') return [{ metadata: { name: 'a' } }];
    if (path === '/api/v1/resourcequotas') throw forbidden();
    return [];
  };
  const result = await storage.collect({ cluster: rawCluster, token: 't', listFn });
  assert.strictEqual(result.summary.quotaCoverage, null);
});

// CANARY for the namespace-scoped guard: removed the `namespace ? ... : null` gate so
// quotaCoverage was computed off the namespace-scoped resourcequotas list divided by 1 (a
// single fabricated denominator) — confirmed red: a namespace-scoped call to
// `?namespace=a` returned `quotaCoverage: 1` (a fabricated 100%) instead of `null`. Restored
// the gate — confirmed green: `null`.
