/**
 * Networking collector: Ingress, Gateway API, Istio and Service reads, and their degradation.
 *
 * Two things are under test, and they fail in opposite directions.
 *
 * Every optional API — Istio, Gateway API — must read a 404 as "not installed": a plain
 * cluster without either is a real configuration, and its count of zero is honest.
 *
 * The degradation must not turn a denial into a zero. `catch { return [] }` made a 403 and an
 * empty cluster produce the same number, which reads as good news either way.
 *
 * Every list is an injected double; no test opens a socket.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import networking from '../collectors/networking.js';
import _errors from '../errors.js';
const { ClusterError } = _errors;

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

const ingress = {
  metadata: { name: 'shop', namespace: 'prod', creationTimestamp: '2026-09-01T00:00:00Z' },
  spec: {
    ingressClassName: 'nginx',
    rules: [{ host: 'shop.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'shop-srv', port: { number: 80 } } } }] } }],
    tls: [{ hosts: ['shop.example.com'], secretName: 'shop-tls' }]
  }
};

const gateway = {
  metadata: { name: 'public', namespace: 'infra' },
  spec: {
    gatewayClassName: 'envoy',
    listeners: [
      { name: 'https', protocol: 'HTTPS', port: 443, hostname: '*.example.com', tls: { certificateRefs: [{ name: 'wild-tls' }] } }
    ]
  },
  status: { conditions: [{ type: 'Programmed', status: 'True' }] }
};

const httproute = {
  metadata: { name: 'api', namespace: 'prod' },
  spec: {
    parentRefs: [{ name: 'public', namespace: 'infra' }],
    hostnames: ['api.example.com'],
    rules: [
      {
        matches: [{ path: { type: 'PathPrefix', value: '/v1' } }],
        backendRefs: [{ name: 'api-srv', port: 8080, weight: 90 }, { name: 'api-canary', port: 8080, weight: 10 }]
      }
    ]
  }
};

/** A list double that answers each path by the resource it ends in. */
function lister(byResource) {
  return async ({ path }) => {
    const resource = path.split('?')[0].split('/').pop();
    return byResource[resource] || [];
  };
}

const notFound = () => new ClusterError('UPSTREAM', '404 Not Found: the server could not find the requested resource', {
  cluster: cluster.id, status: 404
});

test('reads standard and optional networking APIs, and nothing vendor-specific', async () => {
  const paths = [];
  const listFn = async ({ path }) => { paths.push(path); return []; };

  await networking.collect({ cluster, token: 't', listFn });

  assert.deepEqual([...paths].sort(), [
    '/api/v1/services',
    '/apis/gateway.networking.k8s.io/v1/gateways',
    '/apis/gateway.networking.k8s.io/v1/httproutes',
    '/apis/networking.istio.io/v1/gateways',
    '/apis/networking.istio.io/v1/virtualservices',
    '/apis/networking.k8s.io/v1/ingresses'
  ]);
  assert.equal(paths.some(p => p.includes('kyma')), false);
});

test('parses Ingresses, Gateway API Gateways and HTTPRoutes', async () => {
  const result = await networking.collect({
    cluster, token: 't', listFn: lister({ ingresses: [ingress], gateways: [gateway], httproutes: [httproute] })
  });

  assert.equal(result.ingresses.length, 1);
  assert.equal(result.ingresses[0].id, 'prod/shop');
  assert.equal(result.ingresses[0].ingressClassName, 'nginx');
  assert.deepEqual(result.ingresses[0].rules[0], {
    host: 'shop.example.com',
    paths: [{ path: '/', pathType: 'Prefix', backendService: 'shop-srv' }]
  });

  const gw = result.gateways.find(g => g.id === 'infra/public');
  assert.equal(gw.gatewayClassName, 'envoy');
  assert.deepEqual(gw.listeners, [{ name: 'https', protocol: 'HTTPS', port: 443, hostname: '*.example.com', tls: true }]);
  assert.equal(gw.programmed, true);

  assert.equal(result.httproutes.length, 1);
  const route = result.httproutes[0];
  assert.equal(route.id, 'prod/api');
  assert.deepEqual(route.hostnames, ['api.example.com']);
  assert.deepEqual(route.parents, ['infra/public']);
  assert.deepEqual(route.backends, [
    { name: 'api-srv', namespace: 'prod', port: 8080, weight: 90 },
    { name: 'api-canary', namespace: 'prod', port: 8080, weight: 10 }
  ]);
});

test('the summary counts Ingresses, Gateway API Gateways and HTTPRoutes side by side', async () => {
  const result = await networking.collect({
    cluster, token: 't', listFn: lister({ ingresses: [ingress], gateways: [gateway], httproutes: [httproute, httproute] })
  });

  assert.equal(result.summary.ingressesCount, 1);
  assert.equal(result.summary.httproutesCount, 2);
  // Both Gateway kinds answer the `gateways` double here; the Gateway API count is its own.
  assert.equal(result.summary.gatewaysCount, 1);
  assert.equal(result.summary.istioGatewaysCount, 1);
  for (const key of Object.keys(result.summary)) {
    assert.equal(/apirule/i.test(key), false, `no APIRule field survives: ${key}`);
  }
  assert.equal('apirules' in result, false);
});

test('Gateway API and Istio not installed (404) is a true zero, not unavailable', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('gateway.networking.k8s.io') || path.includes('networking.istio.io')) throw notFound();
    return [];
  };

  const result = await networking.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.summary.unavailable, []);
  assert.equal(result.summary.gatewaysCount, 0);
  assert.equal(result.summary.httproutesCount, 0);
  assert.equal(result.summary.virtualServicesCount, 0);
});

test('a 403 on httproutes is unavailable, not a zero', async () => {
  const forbidden = new ClusterError('FORBIDDEN', 'httproutes is forbidden: no RBAC rule', {
    cluster: cluster.id, status: 403
  });
  const listFn = async ({ path }) => {
    if (path.includes('httproutes')) throw forbidden;
    return [];
  };

  const result = await networking.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.summary.unavailable, ['httproutes']);
  assert.equal(result.summary.httproutesCount, 0);
  assert.equal(result.summary.servicesCount, 0);
});

test('other reads degrade under their own labels', async () => {
  const timeout = new ClusterError('UNREACHABLE', 'test-cluster: socket timed out', {
    cluster: cluster.id
  });
  const listFn = async ({ path }) => {
    if (path.includes('virtualservices') || path.includes('istio.io/v1/gateways')) throw timeout;
    return [];
  };

  const result = await networking.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.summary.unavailable, ['virtualservices', 'istio-gateways']);
});

test('summary.unavailable is always a string array', async () => {
  const result = await networking.collect({ cluster, token: 't', listFn: async () => [] });
  assert.ok(Array.isArray(result.summary.unavailable));
  assert.deepEqual(result.summary.unavailable, []);
});

// --- namespace scope: the path the collector asks for is the path it was given ---------
//
// `?namespace=` reaches this collector as raw request input and is interpolated into a URL
// carrying the fleet service account's bearer token. Unencoded, `../` segments are folded
// away by `new URL()` in k8s.js and re-point the read at any list resource the account can
// reach. These assert the exact path handed to the transport, before and after that
// normalisation — that a call did not throw proves nothing.

/** The path the apiserver actually receives, i.e. after `new URL()` collapses the segments. */
const asRequested = path => new URL(`https://apiserver.invalid${path}`).pathname;

test('a namespace full of traversal cannot change the API path that is requested', async () => {
  const paths = [];
  const listFn = async ({ path }) => { paths.push(path); return []; };

  await networking.collect({
    cluster,
    token: 't',
    namespace: '../../../apis/rbac.authorization.k8s.io/v1/clusterroles?x=',
    listFn
  });

  assert.equal(paths.length, 6, 'the six networking reads, and nothing extra');
  for (const path of paths) {
    const requested = asRequested(path);
    assert.ok(
      requested.includes('/namespaces/'),
      `the namespace scope must survive: ${requested}`
    );
    assert.equal(
      requested.includes('rbac.authorization.k8s.io/v1/clusterroles'),
      false,
      `the traversal must not reach the apiserver as path structure: ${requested}`
    );
  }

  const ingressPath = paths.find(p => p.includes('ingresses'));
  assert.equal(
    ingressPath,
    '/apis/networking.k8s.io/v1/namespaces/' +
      '..%2F..%2F..%2Fapis%2Frbac.authorization.k8s.io%2Fv1%2Fclusterroles%3Fx%3D/ingresses'
  );
  // %2F is not a path separator, so the segment count is the same as for a plain namespace.
  assert.equal(asRequested(ingressPath).split('/').length, asRequested(
    '/apis/networking.k8s.io/v1/namespaces/prod/ingresses'
  ).split('/').length);
});

test('a dot-only namespace is refused rather than silently widening to cluster-wide', async () => {
  // `.` and `..` are unreserved, so encoding leaves them intact and `new URL()` then folds
  // `namespaces/../ingresses` down to the cluster-wide `/ingresses`. Encoding alone is not
  // enough; this is the half that catches it.
  for (const namespace of ['..', '.', '...']) {
    await assert.rejects(
      () => networking.collect({ cluster, token: 't', namespace, listFn: async () => [] }),
      /invalid namespace/,
      `namespace ${JSON.stringify(namespace)} must not reach the transport`
    );
  }
});

test('an ordinary namespace is still scoped normally', async () => {
  const paths = [];
  const listFn = async ({ path }) => { paths.push(path); return []; };

  await networking.collect({ cluster, token: 't', namespace: 'istio-system', listFn });

  assert.equal(
    paths.find(p => p.includes('httproutes')),
    '/apis/gateway.networking.k8s.io/v1/namespaces/istio-system/httproutes'
  );
  assert.equal(paths.find(p => p.includes('/services')), '/api/v1/namespaces/istio-system/services');
});

// --- truncation: the read answered, but the list stopped short -------------------------
//
// A truncated read is not an unavailable one, and it rides in its own list. The items behind
// it are real, so the exposure this page describes is understated rather than fabricated —
// which is the opposite direction of error from `unavailable`, and the reason the two must
// not share a channel. A host absent from a truncated list may still be routing.

/** `k8s.list`'s mark for a list that hit the paging ceiling: non-enumerable, read by name. */
function truncatedArray(items) {
  return Object.defineProperty([...items], 'truncated', { value: true });
}

test('a truncated services read is flagged, and the services that arrived still count', async () => {
  // `services` is a substring of `virtualservices`, so the path is matched exactly: matching
  // loosely here would flag both reads and prove nothing about which one stopped short.
  const listFn = async ({ path }) =>
    (path === '/api/v1/services' ? truncatedArray([{ metadata: { name: 'srv', namespace: 'prod' }, spec: {} }]) : []);

  const result = await networking.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.summary.truncated, ['services']);
  assert.deepEqual(result.summary.unavailable, [], 'short is not the same as unreadable');
  assert.equal(result.summary.servicesCount, 1, 'the items that did arrive are real and are counted');
});

test('a truncated httproutes read is flagged and still counted', async () => {
  const listFn = async ({ path }) => (path.endsWith('/httproutes') ? truncatedArray([httproute]) : []);

  const result = await networking.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.summary.truncated, ['httproutes']);
  assert.deepEqual(result.summary.unavailable, []);
  assert.equal(result.summary.httproutesCount, 1);
});

test('reads that ran to the end report truncated: []', async () => {
  const result = await networking.collect({ cluster, token: 't', listFn: lister({ ingresses: [ingress] }) });

  assert.ok(Array.isArray(result.summary.truncated));
  assert.deepEqual(result.summary.truncated, []);
  assert.deepEqual(result.summary.unavailable, []);
});
