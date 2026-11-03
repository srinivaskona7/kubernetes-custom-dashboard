import { test } from 'vitest';
import assert from 'node:assert';

import networking from '../collectors/networking.js';
import storage from '../collectors/storage.js';
import security from '../collectors/security.js';

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

test('networking collector handles APIRules and VirtualServices gracefully', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('apirules')) {
      return [
        {
          metadata: { name: 'bookshop-api', namespace: 'prod', creationTimestamp: '2026-09-01T00:00:00Z' },
          spec: {
            host: 'bookshop.example.com',
            gateway: 'kyma-system/kyma-gateway',
            service: { name: 'bookshop-srv', port: 8080 },
            rules: [{ path: '/.*', methods: ['GET', 'POST'], accessStrategies: [{ handler: 'jwt' }] }]
          },
          status: { APIRuleStatus: { code: 'OK' } }
        }
      ];
    }
    if (path.includes('virtualservices')) {
      return [
        {
          metadata: { name: 'bookshop-vs', namespace: 'prod' },
          spec: { hosts: ['bookshop.example.com'], gateways: ['mesh'], http: [{ route: [{ destination: { host: 'bookshop-srv', port: { number: 8080 } } }] }] }
        }
      ];
    }
    return [];
  };

  const result = await networking.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.apirulesCount, 1);
  assert.strictEqual(result.summary.virtualServicesCount, 1);
  assert.strictEqual(result.apirules[0].host, 'bookshop.example.com');
  assert.strictEqual(result.apirules[0].state, 'OK');
});

test('storage collector parses PVCs and ResourceQuotas', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('persistentvolumeclaims')) {
      return [
        {
          metadata: { name: 'hana-data', namespace: 'prod' },
          spec: { storageClassName: 'premium', resources: { requests: { storage: '10Gi' } }, accessModes: ['ReadWriteOnce'] },
          status: { phase: 'Bound', capacity: { storage: '10Gi' } }
        }
      ];
    }
    if (path.includes('resourcequotas')) {
      return [
        {
          metadata: { name: 'compute-quota', namespace: 'prod' },
          status: { hard: { 'requests.cpu': '4', 'requests.memory': '8Gi' }, used: { 'requests.cpu': '1', 'requests.memory': '2Gi' } }
        }
      ];
    }
    return [];
  };

  const result = await storage.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.totalPvcs, 1);
  assert.strictEqual(result.summary.boundPvcs, 1);
  assert.strictEqual(result.pvcs[0].storageClass, 'premium');
  assert.strictEqual(result.summary.quotasCount, 1);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

test('storage collector: a 403 on one resource degrades only that resource, never blanks the collector', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('persistentvolumeclaims')) {
      const err = new Error('persistentvolumeclaims is forbidden: User cannot list resource');
      err.status = 403;
      throw err;
    }
    if (path.includes('resourcequotas')) {
      return [
        {
          metadata: { name: 'compute-quota', namespace: 'prod' },
          status: { hard: { 'requests.cpu': '4' }, used: { 'requests.cpu': '1' } }
        }
      ];
    }
    return []; // limitranges: true zero
  };

  const result = await storage.collect({ cluster, token: 'fake', listFn: fakeList });
  // The 403'd resource reports zero and is flagged unavailable...
  assert.strictEqual(result.summary.totalPvcs, 0);
  assert.deepStrictEqual(result.summary.unavailable, ['pvc']);
  // ...but the call does not throw, and every other resource in the same collector still comes through.
  assert.strictEqual(result.summary.quotasCount, 1);
  assert.strictEqual(result.summary.limitRangesCount, 0);
});

// --- storage: the namespace scope is a scope, not a suggestion ------------------------
//
// `?namespace=` reaches this collector as raw request input and is interpolated into a URL
// carrying the fleet service account's bearer token. Unencoded, `../` segments are folded
// away by `new URL()` in k8s.js and re-point the read at any list resource the account can
// reach on any registered cluster. Assert the exact path handed to the transport: that a
// call did not throw proves nothing.

/** The path the apiserver actually receives, i.e. after `new URL()` collapses the segments. */
const asRequested = path => new URL(`https://apiserver.invalid${path}`).pathname;

test('storage collector: a traversal namespace cannot change the API path that is requested', async () => {
  const paths = [];
  const listFn = async ({ path }) => { paths.push(path); return []; };

  await storage.collect({
    cluster,
    token: 'fake',
    namespace: '../../../apis/rbac.authorization.k8s.io/v1/clusterroles?x=',
    listFn
  });

  // storageclasses is cluster-scoped (storage.k8s.io is unaffected by ?namespace=) — the
  // other three reads are namespace-scoped and must survive the traversal unfolded.
  assert.strictEqual(paths.length, 4, 'the three namespaced storage reads plus storageclasses');
  const namespaced = paths.filter(p => !p.includes('storageclasses'));
  assert.strictEqual(namespaced.length, 3);
  for (const path of namespaced) {
    const requested = asRequested(path);
    assert.ok(requested.startsWith('/api/v1/namespaces/'), `namespace scope must survive: ${requested}`);
    assert.strictEqual(
      requested.includes('rbac.authorization.k8s.io/v1/clusterroles'),
      false,
      `the traversal must not reach the apiserver as path structure: ${requested}`
    );
  }

  assert.strictEqual(
    paths.find(p => p.includes('persistentvolumeclaims')),
    '/api/v1/namespaces/' +
      '..%2F..%2F..%2Fapis%2Frbac.authorization.k8s.io%2Fv1%2Fclusterroles%3Fx%3D/persistentvolumeclaims'
  );
});

test('storage collector: a dot-only namespace is refused, not silently widened to cluster-wide', async () => {
  // `.` and `..` are unreserved, so encoding leaves them intact and `new URL()` then folds
  // `namespaces/../persistentvolumeclaims` down to the cluster-wide list. Encoding alone is
  // not enough; this is the half that catches it.
  for (const namespace of ['..', '.', '...']) {
    await assert.rejects(
      () => storage.collect({ cluster, token: 'fake', namespace, listFn: async () => [] }),
      /invalid namespace/,
      `namespace ${JSON.stringify(namespace)} must not reach the transport`
    );
  }
});

test('storage collector: an ordinary namespace is still scoped normally', async () => {
  const paths = [];
  const listFn = async ({ path }) => { paths.push(path); return []; };

  await storage.collect({ cluster, token: 'fake', namespace: 'kyma-system', listFn });

  assert.deepStrictEqual(paths.sort(), [
    '/api/v1/namespaces/kyma-system/limitranges',
    '/api/v1/namespaces/kyma-system/persistentvolumeclaims',
    '/api/v1/namespaces/kyma-system/resourcequotas',
    '/apis/storage.k8s.io/v1/storageclasses'
  ]);
});

test('security collector audits NetworkPolicies, container posture, and secret metadata safely', async () => {  const fakeList = async ({ path }) => {
    if (path.includes('/api/v1/namespaces')) {
      return [{ metadata: { name: 'app-ns' } }, { metadata: { name: 'kube-system' } }];
    }
    if (path.includes('networkpolicies')) {
      return [{ metadata: { name: 'default-deny', namespace: 'app-ns' } }];
    }
    if (path.includes('pods')) {
      return [
        {
          spec: {
            securityContext: { runAsNonRoot: true },
            containers: [{ name: 'app', securityContext: { privileged: false } }]
          }
        }
      ];
    }
    if (path.includes('secrets')) {
      return [
        { metadata: { name: 'sec-1' }, type: 'Opaque' },
        { metadata: { name: 'sec-2' }, type: 'kubernetes.io/tls' }
      ];
    }
    if (path.includes('serviceaccounts')) {
      return [{ metadata: { name: 'app-sa' } }];
    }
    return [];
  };

  const result = await security.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.appNamespacesAudited, 1);
  assert.strictEqual(result.summary.networkPolicyIsolationScore, 100);
  assert.strictEqual(result.summary.totalSecretsCount, 2);
  assert.strictEqual(result.summary.nonRootContainers, 1);
  assert.strictEqual(result.summary.privilegedContainers, 0);
  assert.deepStrictEqual(result.summary.unavailable, []);
  // Guarantee zero secret data is in the output
  assert.strictEqual(JSON.stringify(result).includes('data'), false);
});

test('security collector: a 403 on secrets degrades only secrets, never blanks the collector', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('/api/v1/namespaces')) {
      return [{ metadata: { name: 'app-ns' } }];
    }
    if (path.includes('networkpolicies')) {
      return [{ metadata: { name: 'default-deny', namespace: 'app-ns' } }];
    }
    if (path.includes('pods')) {
      return [{ spec: { containers: [{ name: 'app', securityContext: { privileged: false } }] } }];
    }
    if (path.includes('secrets')) {
      const err = new Error('secrets is forbidden: User cannot list resource');
      err.status = 403;
      throw err;
    }
    if (path.includes('serviceaccounts')) {
      return [{ metadata: { name: 'app-sa' } }];
    }
    return [];
  };

  const result = await security.collect({ cluster, token: 'fake', listFn: fakeList });
  // secrets is unavailable, not a false zero...
  assert.strictEqual(result.summary.totalSecretsCount, 0);
  assert.deepStrictEqual(result.summary.unavailable, ['secrets']);
  // ...but the rest of the collector still reports real data instead of being blanked.
  assert.strictEqual(result.summary.appNamespacesAudited, 1);
  assert.strictEqual(result.summary.totalServiceAccounts, 1);
  assert.strictEqual(result.summary.networkPolicyIsolationScore, 100);
});

test('security collector: pods listing still fails loudly (core health is never softened to unavailable)', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('pods')) {
      const err = new Error('pods is forbidden: User cannot list resource');
      err.status = 403;
      throw err;
    }
    return [];
  };

  await assert.rejects(
    () => security.collect({ cluster, token: 'fake', listFn: fakeList }),
    /forbidden/
  );
});

// --- truncation: the read answered, but the list stopped short ------------------------
//
// The items behind a truncated list are real, so every count derived from it is a FLOOR.
// It rides beside `unavailable` rather than in it: folding the two together would trade a
// true lower bound for an em-dash, while reporting neither presents the floor as a total.

/** `k8s.list`'s mark for a list that hit the paging ceiling: non-enumerable, read by name. */
function truncatedArray(items) {
  return Object.defineProperty([...items], 'truncated', { value: true });
}

/** Every read a security collection makes, answered from `answers` and otherwise empty. */
function securityLister(answers) {
  return async ({ path }) => {
    for (const [match, value] of Object.entries(answers)) {
      if (path.includes(match)) return value;
    }
    return [];
  };
}

const APP_NS = { metadata: { name: 'app-ns' } };
const POD = { spec: { containers: [{ name: 'app', securityContext: { privileged: false } }] } };

test('security collector: a truncated secrets read is flagged, and its secrets still count', async () => {
  const fakeList = securityLister({
    '/api/v1/namespaces': [APP_NS],
    pods: [POD],
    secrets: truncatedArray([{ type: 'Opaque' }, { type: 'kubernetes.io/tls' }])
  });

  const result = await security.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, ['secrets']);
  assert.deepStrictEqual(result.summary.unavailable, [], 'short is not the same as unreadable');
  assert.strictEqual(result.summary.totalSecretsCount, 2, 'the secrets that did arrive are real');
});

test('security collector: a truncated pod audit is flagged too, even though that read bypasses safeList', async () => {
  const fakeList = securityLister({
    '/api/v1/namespaces': [APP_NS],
    pods: truncatedArray([POD, POD])
  });

  const result = await security.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, ['pods']);
  assert.deepStrictEqual(result.summary.unavailable, []);
  // privilegedContainers: 0 over a truncated audit is the reassuring number that must not be
  // read as a total — the privileged container may be one of the pods past the cut.
  assert.strictEqual(result.summary.totalContainers, 2);
  assert.strictEqual(result.summary.privilegedContainers, 0);
});

test('security collector: reads that ran to the end report truncated: []', async () => {
  const fakeList = securityLister({
    '/api/v1/namespaces': [APP_NS],
    pods: [POD],
    secrets: [{ type: 'Opaque' }],
    serviceaccounts: [{ metadata: { name: 'app-sa' } }]
  });

  const result = await security.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, []);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

const PVC = {
  metadata: { name: 'hana-data', namespace: 'prod' },
  spec: { storageClassName: 'premium', resources: { requests: { storage: '10Gi' } } },
  status: { phase: 'Bound' }
};

test('storage collector: a truncated PVC read is flagged, and the PVCs that arrived still count', async () => {
  const fakeList = async ({ path }) =>
    (path.includes('persistentvolumeclaims') ? truncatedArray([PVC, PVC]) : []);

  const result = await storage.collect({ cluster, token: 'fake', listFn: fakeList });
  // Only the read that stopped short; quotas and limitranges finished and stay out of it.
  assert.deepStrictEqual(result.summary.truncated, ['pvc']);
  assert.deepStrictEqual(result.summary.unavailable, [], 'short is not the same as unreadable');
  assert.strictEqual(result.summary.totalPvcs, 2, 'the items that did arrive are real and are counted');
  assert.strictEqual(result.summary.totalRequestedBytes, 2 * 10 * 1024 ** 3, 'a partial sum, and flagged as one');
});

test('storage collector: reads that ran to the end report truncated: []', async () => {
  const fakeList = async ({ path }) => (path.includes('persistentvolumeclaims') ? [PVC] : []);

  const result = await storage.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, []);
  assert.deepStrictEqual(result.summary.unavailable, []);
});
