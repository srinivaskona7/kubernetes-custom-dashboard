/**
 * Networking collector: APIRule v2 migration and degradation behaviour.
 *
 * Two things are under test, and they fail in opposite directions.
 *
 * The v2 read must not lose an APIRule that was created as v1beta1. Kyma's conversion
 * webhook serves every APIRule as v2, but when the original rules have no v2 equivalent it
 * empties `.spec.rules` and parks the original spec in an annotation. A collector that reads
 * only `.spec` reports a live, exposed workload as having zero rules — the dashboard then
 * shows a clean row for something that is not clean.
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

const ORIGINAL_VERSION_ANNOTATION = 'gateway.kyma-project.io/original-version';
const V1BETA1_SPEC_ANNOTATION = 'gateway.kyma-project.io/v1beta1-spec';

/** An APIRule as the API server serves it under v2 after a clean, lossless conversion. */
const v2ApiRule = {
  metadata: {
    name: 'bookshop',
    namespace: 'prod',
    annotations: { [ORIGINAL_VERSION_ANNOTATION]: 'v2' },
    creationTimestamp: '2026-09-01T00:00:00Z'
  },
  spec: {
    hosts: ['bookshop.example.com'],
    gateway: 'kyma-system/kyma-gateway',
    service: { name: 'bookshop-srv', port: 4004 },
    rules: [
      {
        path: '/catalog',
        methods: ['GET', 'POST'],
        jwt: { authentications: [{ issuer: 'https://issuer.example.com' }] },
        request: { headers: { 'x-tenant': 'acme' } }
      },
      { path: '/health', methods: ['GET'], noAuth: true }
    ]
  },
  status: { state: 'Ready' }
};

/**
 * An APIRule created as v1beta1 whose `allow` / `noop` handlers cannot be expressed in v2.
 * The served spec keeps host and service but loses the rules; the gateway is dropped too,
 * because `kyma-gateway.kyma-system` is not the `namespace/name` format v2 accepts.
 */
const convertedApiRule = {
  metadata: {
    name: 'httpbin',
    namespace: 'test',
    annotations: {
      [ORIGINAL_VERSION_ANNOTATION]: 'v1beta1',
      [V1BETA1_SPEC_ANNOTATION]: JSON.stringify({
        host: 'httpbin',
        service: { name: 'httpbin', namespace: 'test', port: 8000 },
        gateway: 'kyma-gateway.kyma-system',
        rules: [
          { path: '/anything', methods: ['POST'], accessStrategies: [{ handler: 'noop' }] },
          {
            path: '/headers',
            methods: ['HEAD'],
            accessStrategies: [{ handler: 'allow' }],
            mutators: [{ handler: 'header' }]
          }
        ]
      })
    },
    creationTimestamp: '2025-06-01T00:00:00Z'
  },
  spec: {
    hosts: ['httpbin'],
    service: { name: 'httpbin', namespace: 'test', port: 8000 }
  },
  status: { state: 'Warning' }
};

/** A list double that answers apirules from `apirules` and every other path with []. */
function listerFor(apirules) {
  return async ({ path }) => (path.includes('apirules') ? apirules : []);
}

/** A list double that throws `err` for apirules and answers [] elsewhere. */
function failingApirules(err) {
  return async ({ path }) => {
    if (path.includes('apirules')) throw err;
    return [];
  };
}

test('queries APIRule v2, never the removed v1beta1', async () => {
  const paths = [];
  const listFn = async ({ path }) => {
    paths.push(path);
    return [];
  };

  await networking.collect({ cluster, token: 't', listFn });

  const apirulePath = paths.find(p => p.includes('apirules'));
  assert.equal(apirulePath, '/apis/gateway.kyma-project.io/v2/apirules');
  assert.equal(
    paths.some(p => p.includes('gateway.kyma-project.io/v1beta1')),
    false,
    'must not query the deprecated APIRule v1beta1 group'
  );
});

test('parses a v2 APIRule with populated spec.rules', async () => {
  const result = await networking.collect({ cluster, token: 't', listFn: listerFor([v2ApiRule]) });

  assert.equal(result.apirules.length, 1);
  const rule = result.apirules[0];

  assert.equal(rule.id, 'prod/bookshop');
  assert.equal(rule.host, 'bookshop.example.com', 'spec.hosts[0] becomes host');
  assert.equal(rule.gateway, 'kyma-system/kyma-gateway');
  assert.equal(rule.serviceName, 'bookshop-srv');
  assert.equal(rule.servicePort, 4004);
  assert.equal(rule.state, 'Ready');
  assert.equal(rule.specSource, 'spec');

  assert.equal(rule.paths.length, 2);
  assert.deepEqual(rule.paths[0], {
    path: '/catalog',
    methods: ['GET', 'POST'],
    accessStrategies: ['jwt'],
    mutators: ['headers']
  });
  assert.deepEqual(rule.paths[1], {
    path: '/health',
    methods: ['GET'],
    accessStrategies: ['noAuth'],
    mutators: []
  });
});

test('parses rules from the v1beta1-spec annotation when spec.rules is empty', async () => {
  const result = await networking.collect({
    cluster, token: 't', listFn: listerFor([convertedApiRule])
  });

  const rule = result.apirules[0];
  assert.equal(rule.specSource, 'v1beta1-annotation');
  assert.equal(rule.paths.length, 2, 'a converted rule must not read as zero rules');
  assert.deepEqual(rule.paths[0], {
    path: '/anything',
    methods: ['POST'],
    accessStrategies: ['noop'],
    mutators: []
  });
  assert.deepEqual(rule.paths[1], {
    path: '/headers',
    methods: ['HEAD'],
    accessStrategies: ['allow'],
    mutators: ['header']
  });

  // The same conversion drops a `gateway.namespace`-format gateway from the served spec.
  assert.equal(rule.gateway, 'kyma-gateway.kyma-system', 'gateway recovered from the annotation');
  assert.equal(rule.host, 'httpbin');
  assert.equal(rule.serviceName, 'httpbin');
});

test('reports the original version per rule and rolls it up', async () => {
  const noAnnotation = {
    metadata: { name: 'legacy', namespace: 'old' },
    spec: { hosts: ['legacy'], rules: [{ path: '/', methods: ['GET'], noAuth: true }] },
    status: { state: 'Ready' }
  };
  const v2alpha1Rule = {
    metadata: {
      name: 'alpha',
      namespace: 'staging',
      annotations: { [ORIGINAL_VERSION_ANNOTATION]: 'v2alpha1' }
    },
    spec: { hosts: ['alpha'], rules: [{ path: '/', methods: ['GET'], noAuth: true }] },
    status: { state: 'Ready' }
  };

  const result = await networking.collect({
    cluster,
    token: 't',
    listFn: listerFor([v2ApiRule, convertedApiRule, v2alpha1Rule, noAnnotation])
  });

  const byName = Object.fromEntries(result.apirules.map(a => [a.name, a]));

  assert.equal(byName.bookshop.originalVersion, 'v2');
  assert.equal(byName.httpbin.originalVersion, 'v1beta1');
  assert.equal(byName.alpha.originalVersion, 'v2alpha1');
  assert.equal(byName.legacy.originalVersion, null);

  for (const rule of result.apirules) {
    assert.equal(rule.servedVersion, 'v2', 'every rule reports the version it was read as');
  }

  // v1beta1 is the only version whose reconciliation is switched off, so it is the only
  // one that flags for migration; the raw version stays available for the finer view.
  assert.equal(byName.httpbin.needsMigration, true);
  assert.equal(byName.bookshop.needsMigration, false);
  assert.equal(byName.alpha.needsMigration, false);
  assert.equal(byName.legacy.needsMigration, false);

  assert.deepEqual(result.summary.apirulesByVersion, {
    v1beta1: 1, v2alpha1: 1, v2: 1, unknown: 1
  });
  assert.equal(result.summary.apirulesNeedingMigration, 1);
});

test('a 403 on apirules is unavailable, not a zero', async () => {
  const forbidden = new ClusterError('FORBIDDEN', 'apirules is forbidden: no RBAC rule', {
    cluster: cluster.id, status: 403
  });

  const result = await networking.collect({
    cluster, token: 't', listFn: failingApirules(forbidden)
  });

  assert.deepEqual(result.summary.unavailable, ['apirules']);
  assert.equal(result.summary.apirulesCount, 0);
  assert.deepEqual(result.apirules, []);
  // The other reads succeeded, so only apirules degrades.
  assert.equal(result.summary.servicesCount, 0);
});

test('a 404 on apirules with the group absent is a true zero, not unavailable', async () => {
  const notFound = new ClusterError('UPSTREAM', '404 Not Found: the server could not find the requested resource', {
    cluster: cluster.id, status: 404
  });
  // Group discovery 404s too: gateway.kyma-project.io is not registered at all.
  const callFn = async () => {
    throw new ClusterError('UPSTREAM', '404 page not found', { cluster: cluster.id, status: 404 });
  };

  const result = await networking.collect({
    cluster, token: 't', listFn: failingApirules(notFound), callFn
  });

  assert.deepEqual(result.summary.unavailable, [], 'API Gateway module absent is an honest 0');
  assert.equal(result.summary.apirulesCount, 0);
  assert.equal(result.summary.apirulesNeedingMigration, 0);
  assert.equal(result.summary.apirulesUnavailable, null);
});

test('other reads degrade under their own labels', async () => {
  const timeout = new ClusterError('UNREACHABLE', 'test-cluster: socket timed out', {
    cluster: cluster.id
  });
  const listFn = async ({ path }) => {
    if (path.includes('virtualservices') || path.includes('istio.io/v1beta1/gateways')) throw timeout;
    return [];
  };

  const result = await networking.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.summary.unavailable, ['virtualservices', 'istio-gateways']);
});

test('a malformed v1beta1-spec annotation does not fail collection', async () => {
  const broken = {
    metadata: {
      name: 'broken',
      namespace: 'test',
      annotations: {
        [ORIGINAL_VERSION_ANNOTATION]: 'v1beta1',
        [V1BETA1_SPEC_ANNOTATION]: '{not json'
      }
    },
    spec: { hosts: ['broken'] },
    status: { state: 'Warning' }
  };

  const result = await networking.collect({ cluster, token: 't', listFn: listerFor([broken]) });

  assert.equal(result.apirules.length, 1);
  assert.deepEqual(result.apirules[0].paths, []);
  assert.equal(result.apirules[0].specSource, 'spec');
  assert.equal(result.apirules[0].needsMigration, true, 'still flagged for migration');
});

test('summary.unavailable is always a string array', async () => {
  const result = await networking.collect({ cluster, token: 't', listFn: async () => [] });
  assert.ok(Array.isArray(result.summary.unavailable));
  assert.deepEqual(result.summary.unavailable, []);
});

// --- the other kind of 404: the module is present but too old for v2 ------------------
//
// safe-list.js classifies every 404 as a true zero, which is right for an optional CRD and
// wrong for exactly one read. A cluster whose API Gateway module predates v2 answers 404 on
// the v2 path while `kubectl get apirules` lists rules — reporting 0 there is the confident
// zero the whole degradation contract exists to prevent. Group discovery separates the two.

/** An APIGroup discovery document, as `/apis/gateway.kyma-project.io` returns it. */
function apiGroup(...versions) {
  return {
    kind: 'APIGroup',
    apiVersion: 'v1',
    name: 'gateway.kyma-project.io',
    versions: versions.map(v => ({ groupVersion: `gateway.kyma-project.io/${v}`, version: v })),
    preferredVersion: { groupVersion: `gateway.kyma-project.io/${versions[0]}`, version: versions[0] }
  };
}

const apirules404 = new ClusterError('UPSTREAM', '404 Not Found: the server could not find the requested resource', {
  cluster: cluster.id, status: 404
});

test('a 404 on apirules when the group serves only v1beta1 is unavailable, never a zero', async () => {
  const probed = [];
  const callFn = async ({ path }) => {
    probed.push(path);
    return apiGroup('v1beta1');
  };

  const result = await networking.collect({
    cluster, token: 't', listFn: failingApirules(apirules404), callFn
  });

  assert.deepEqual(probed, ['/apis/gateway.kyma-project.io'], 'group discovery, not a v1beta1 list');
  assert.deepEqual(result.summary.unavailable, ['apirules']);
  assert.equal(result.summary.apirulesCount, 0);
  assert.equal(result.summary.apirulesUnavailable.reason, 'UNSUPPORTED_VERSION');
  assert.match(
    result.summary.apirulesUnavailable.detail,
    /serves v1beta1, not v2/,
    'the reason names the version the cluster does serve'
  );
});

test('a 404 on apirules when discovery still lists v2 is unavailable, not a zero', async () => {
  const result = await networking.collect({
    cluster,
    token: 't',
    listFn: failingApirules(apirules404),
    callFn: async () => apiGroup('v2alpha1', 'v2', 'v1beta1')
  });

  assert.deepEqual(result.summary.unavailable, ['apirules']);
  assert.equal(result.summary.apirulesUnavailable.reason, 'UPSTREAM');
});

test('a 404 on apirules whose discovery probe also fails is unavailable, not a zero', async () => {
  const forbidden = new ClusterError('FORBIDDEN', 'discovery is forbidden: no RBAC rule', {
    cluster: cluster.id, status: 403
  });

  const result = await networking.collect({
    cluster,
    token: 't',
    listFn: failingApirules(apirules404),
    callFn: async () => { throw forbidden; }
  });

  // Neither branch was proven, so the count is not a verified zero.
  assert.deepEqual(result.summary.unavailable, ['apirules']);
  assert.equal(result.summary.apirulesUnavailable.reason, 'FORBIDDEN');
  assert.match(result.summary.apirulesUnavailable.detail, /could not tell whether/);
});

test('the discovery probe costs nothing on the happy path or on a 403', async () => {
  let probes = 0;
  const callFn = async () => { probes += 1; return apiGroup('v2'); };

  await networking.collect({ cluster, token: 't', listFn: listerFor([v2ApiRule]), callFn });
  assert.equal(probes, 0, 'a successful list must not trigger a second request');

  await networking.collect({ cluster, token: 't', listFn: listerFor([]), callFn });
  assert.equal(probes, 0, 'an honestly empty list must not trigger a second request');

  const forbidden = new ClusterError('FORBIDDEN', 'apirules is forbidden', { cluster: cluster.id, status: 403 });
  const denied = await networking.collect({
    cluster, token: 't', listFn: failingApirules(forbidden), callFn
  });
  assert.equal(probes, 0, 'a 403 is already unambiguous; nothing to probe');
  assert.deepEqual(denied.summary.unavailable, ['apirules']);
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

  assert.equal(paths.length, 5, 'the five networking reads, and nothing extra');
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

  const apirulePath = paths.find(p => p.includes('apirules'));
  assert.equal(
    apirulePath,
    '/apis/gateway.kyma-project.io/v2/namespaces/' +
      '..%2F..%2F..%2Fapis%2Frbac.authorization.k8s.io%2Fv1%2Fclusterroles%3Fx%3D/apirules'
  );
  // %2F is not a path separator, so the segment count is the same as for a plain namespace.
  assert.equal(asRequested(apirulePath).split('/').length, asRequested(
    '/apis/gateway.kyma-project.io/v2/namespaces/prod/apirules'
  ).split('/').length);
});

test('a dot-only namespace is refused rather than silently widening to cluster-wide', async () => {
  // `.` and `..` are unreserved, so encoding leaves them intact and `new URL()` then folds
  // `namespaces/../apirules` down to the cluster-wide `/apirules`. Encoding alone is not
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

  await networking.collect({ cluster, token: 't', namespace: 'kyma-system', listFn });

  assert.equal(
    paths.find(p => p.includes('apirules')),
    '/apis/gateway.kyma-project.io/v2/namespaces/kyma-system/apirules'
  );
  assert.equal(paths.find(p => p.includes('/services')), '/api/v1/namespaces/kyma-system/services');
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

test('a truncated apirules read survives the discovery wrapper around safeList', async () => {
  // This read is double-wrapped — safeList inside `readApiRules`'s own 404-detecting closure —
  // and the ceiling flag is non-enumerable, so it only survives because every layer passes the
  // same array through by reference. Copying it anywhere in that chain would drop the flag.
  const result = await networking.collect({
    cluster,
    token: 't',
    listFn: listerFor(truncatedArray([v2ApiRule]))
  });

  assert.deepEqual(result.summary.truncated, ['apirules']);
  assert.deepEqual(result.summary.unavailable, []);
  assert.equal(result.summary.apirulesCount, 1);
});

test('reads that ran to the end report truncated: []', async () => {
  const result = await networking.collect({ cluster, token: 't', listFn: listerFor([v2ApiRule]) });

  assert.ok(Array.isArray(result.summary.truncated));
  assert.deepEqual(result.summary.truncated, []);
  assert.deepEqual(result.summary.unavailable, []);
});

test('a hand-built unreadable apirules result is never also reported as truncated', async () => {
  // safeList guarantees the two are mutually exclusive per read, but `unreadable()` builds its
  // result by hand for the 404-plus-discovery verdicts, outside that guarantee. This is the
  // one result in the collector where the exclusion has to be written down rather than relied on.
  const result = await networking.collect({
    cluster,
    token: 't',
    listFn: failingApirules(apirules404),
    callFn: async () => apiGroup('v1beta1')
  });

  assert.equal(result.summary.apirulesUnavailable.reason, 'UNSUPPORTED_VERSION', 'the unreadable() path');
  assert.deepEqual(result.summary.unavailable, ['apirules']);
  assert.deepEqual(result.summary.truncated, []);
});
