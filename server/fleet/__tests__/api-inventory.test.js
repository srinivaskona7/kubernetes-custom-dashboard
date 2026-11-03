/**
 * Tests for the API inventory's judgements.
 *
 * Everything here runs without a cluster, because everything here is a rule that decides
 * what a committed document says: whether a refused read prints as `0`, whether a Kind's
 * field digest can carry a value out of an object, and whether an operator nobody
 * anticipated lands in a coherent dashboard section.
 *
 * The two security-shaped tests — no values escape, Secrets are never sampled — are
 * written as *canaries*: they assert against a fixture stuffed with recognisable secret
 * strings, so a change that starts emitting values fails on the value, not on a shape.
 */
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import _api_inventory_model from '../tools/api-inventory-model.js';
const {
  fromAggregated, fromLegacy, countFromPage, fieldDigest, domainOf, byDomain, summarise,
  NEVER_SAMPLE
} = _api_inventory_model;

/* ------------------------------------------------------------------------ discovery */

const AGGREGATED = {
  kind: 'APIGroupDiscoveryList',
  apiVersion: 'apidiscovery.k8s.io/v2',
  items: [
    {
      metadata: { name: 'apps' },
      versions: [{
        version: 'v1',
        resources: [{
          resource: 'deployments',
          responseKind: { kind: 'Deployment' },
          scope: 'Namespaced',
          singularResource: 'deployment',
          verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
          shortNames: ['deploy'],
          categories: ['all'],
          subresources: [{ subresource: 'scale', responseKind: { kind: 'Scale' }, verbs: ['get', 'patch', 'update'] },
            { subresource: 'status', responseKind: { kind: 'Deployment' }, verbs: ['get', 'patch', 'update'] }]
        }]
      }]
    },
    {
      metadata: { name: 'operator.kyma-project.io' },
      versions: [
        { version: 'v1beta2', resources: [{ resource: 'kymas', responseKind: { kind: 'Kyma' }, scope: 'Namespaced', verbs: ['get', 'list'] }] },
        { version: 'v1alpha1', resources: [{ resource: 'kymas', responseKind: { kind: 'Kyma' }, scope: 'Namespaced', verbs: ['get', 'list'] }] }
      ]
    }
  ]
};

test('aggregated discovery yields one entry per group/version/resource with paths and commands', () => {
  const entries = fromAggregated(AGGREGATED);
  assert.equal(entries.length, 3);

  const deploy = entries.find(e => e.resource === 'deployments');
  assert.equal(deploy.kind, 'Deployment');
  assert.equal(deploy.apiVersion, 'apps/v1');
  assert.equal(deploy.scope, 'Namespaced');
  assert.equal(deploy.listable, true);
  assert.equal(deploy.listPath, '/apis/apps/v1/deployments');
  assert.equal(deploy.namespacedListPath, '/apis/apps/v1/namespaces/{namespace}/deployments');
  assert.equal(deploy.kubectl, 'kubectl get deployments.apps -A');
  assert.deepEqual(deploy.subresources.map(s => s.name), ['scale', 'status']);
  assert.equal(deploy.preferred, true);
});

test('only the first version of a group is marked preferred', () => {
  const kymas = fromAggregated(AGGREGATED).filter(e => e.resource === 'kymas');
  assert.deepEqual(kymas.map(k => [k.version, k.preferred]), [['v1beta2', true], ['v1alpha1', false]]);
});

test('a cluster-scoped resource gets no namespaced path and an un-suffixed kubectl line', () => {
  const [node] = fromAggregated({
    items: [{
      metadata: { name: '' },
      versions: [{ version: 'v1', resources: [{ resource: 'nodes', responseKind: { kind: 'Node' }, scope: 'Cluster', verbs: ['get', 'list'] }] }]
    }]
  });
  assert.equal(node.apiVersion, 'v1');
  assert.equal(node.listPath, '/api/v1/nodes');
  assert.equal(node.namespacedListPath, null);
  assert.equal(node.kubectl, 'kubectl get nodes');
});

test('legacy discovery folds slash-named subresources into their parent', () => {
  const entries = fromLegacy({
    kind: 'APIResourceList',
    resources: [
      { name: 'pods', kind: 'Pod', namespaced: true, verbs: ['get', 'list'], shortNames: ['po'] },
      { name: 'pods/log', kind: 'Pod', namespaced: true, verbs: ['get'] },
      { name: 'pods/exec', kind: 'PodExecOptions', namespaced: true, verbs: ['create', 'get'] }
    ]
  }, { group: '', version: 'v1', preferred: true });

  assert.equal(entries.length, 1, 'a subresource is never a top-level entry');
  assert.deepEqual(entries[0].subresources.map(s => s.name), ['log', 'exec']);
  assert.equal(entries[0].listable, true);
});

test('a resource without list is not offered as listable', () => {
  const [review] = fromLegacy({
    resources: [{ name: 'selfsubjectaccessreviews', kind: 'SelfSubjectAccessReview', namespaced: false, verbs: ['create'] }]
  }, { group: 'authorization.k8s.io', version: 'v1', preferred: true });
  assert.equal(review.listable, false);
});

/* --------------------------------------------------------------------------- counts */

test('countFromPage adds remainingItemCount to the page', () => {
  assert.equal(countFromPage({ items: [{}], metadata: { remainingItemCount: 412 } }), 413);
});

test('a final page has no remainingItemCount at all and must not become NaN', () => {
  const n = countFromPage({ items: [{}], metadata: { resourceVersion: '9' } });
  assert.equal(n, 1);
  assert.equal(Number.isNaN(n), false);
});

test('an empty collection is a true zero', () => {
  assert.equal(countFromPage({ items: [], metadata: {} }), 0);
});

/* -------------------------------------------------------------- the field digest */

/**
 * Every leaf in here is a string nobody should ever find in a committed document. If the
 * digest starts emitting values, this fixture is what names the leak in the failure.
 */
const LEAKY = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: {
    name: 'SENTINEL-NAME',
    namespace: 'SENTINEL-NS',
    annotations: { 'SENTINEL-ANNOTATION-KEY': 'SENTINEL-ANNOTATION-VALUE' },
    labels: { 'SENTINEL-LABEL-KEY': 'SENTINEL-LABEL-VALUE' },
    managedFields: [{ manager: 'SENTINEL-MANAGER', fieldsV1: { 'f:data': { '.': {} } } }]
  },
  data: { 'db.conn': 'postgres://user:SENTINEL-PASSWORD@host/db' },
  spec: {
    replicas: 3,
    enabled: true,
    template: { spec: { containers: [{ name: 'SENTINEL-CONTAINER', image: 'SENTINEL-IMAGE', ports: [{ containerPort: 8080 }] }] } }
  },
  status: { conditions: [{ type: 'Ready', status: 'True', message: 'SENTINEL-MESSAGE' }] }
};

test('the field digest emits paths and types and never a value', () => {
  const digest = fieldDigest(LEAKY);
  const serialised = JSON.stringify(digest);
  for (const sentinel of serialised.match(/SENTINEL-[A-Z-]+/g) || []) {
    assert.fail(`the digest carried a value out of the object: ${sentinel}`);
  }
  assert.equal(serialised.includes('SENTINEL'), false);
});

test('the digest records the shape it refused to enter', () => {
  const byPath = Object.fromEntries(fieldDigest(LEAKY).map(f => [f.path, f.type]));
  assert.equal(byPath['data'], 'map', 'a ConfigMap\'s data keys are user-authored; record, do not enter');
  assert.equal(byPath['metadata.annotations'], 'map');
  assert.equal(byPath['metadata.labels'], 'map');
  assert.equal(byPath['data.db.conn'], undefined);
  assert.equal(byPath['metadata.annotations.SENTINEL-ANNOTATION-KEY'], undefined);
});

test('managedFields is dropped entirely', () => {
  const paths = fieldDigest(LEAKY).map(f => f.path);
  assert.equal(paths.some(p => p.includes('managedFields')), false);
});

test('arrays collapse to one element and keep their element type', () => {
  const byPath = Object.fromEntries(fieldDigest(LEAKY).map(f => [f.path, f.type]));
  assert.equal(byPath['spec.template.spec.containers[]'], 'array(object)');
  assert.equal(byPath['spec.template.spec.containers[].image'], 'string');
  assert.equal(byPath['status.conditions[].type'], 'string');
});

test('scalar types are reported as JSON types', () => {
  const byPath = Object.fromEntries(fieldDigest(LEAKY).map(f => [f.path, f.type]));
  assert.equal(byPath['spec.replicas'], 'number');
  assert.equal(byPath['spec.enabled'], 'boolean');
  assert.equal(byPath['spec'], 'object');
});

test('the digest is bounded, so one pathological object cannot dominate the document', () => {
  const wide = { spec: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`field${i}`, i])) };
  assert.ok(fieldDigest(wide, { maxPaths: 50 }).length <= 50);
});

test('the digest stops at maxDepth rather than recursing without limit', () => {
  let deep = { leaf: 1 };
  for (let i = 0; i < 20; i++) deep = { nest: deep };
  const paths = fieldDigest(deep, { maxDepth: 3 }).map(p => p.path);
  assert.ok(paths.every(p => p.split('.').length <= 4), paths.join(','));
});

test('Secret is on the never-sampled list', () => {
  assert.equal(NEVER_SAMPLE.has('Secret'), true);
  assert.equal(NEVER_SAMPLE.has('ConfigMap'), false, 'a ConfigMap is sampled; its data keys are what is withheld');
});

/* ------------------------------------------------------------------------- grouping */

test('core Kubernetes groups land in their named domains', () => {
  assert.equal(domainOf(''), 'Workloads');
  assert.equal(domainOf('apps'), 'Workloads');
  assert.equal(domainOf('networking.k8s.io'), 'Networking');
  assert.equal(domainOf('rbac.authorization.k8s.io'), 'Identity & access');
  assert.equal(domainOf('admissionregistration.k8s.io'), 'Policy & admission');
  assert.equal(domainOf('constraints.gatekeeper.sh'), 'Policy & admission');
  assert.equal(domainOf('networking.istio.io'), 'Service mesh');
  assert.equal(domainOf('telemetry.kyma-project.io'), 'Observability');
  assert.equal(domainOf('operator.kyma-project.io'), 'Platform (Kyma)');
});

test('a sub-group of a known group inherits its domain', () => {
  // These three were bucketed as "Extensions: k8s.io" on the first real run, which is the
  // fallback doing its job on rules that were too narrow rather than the fallback being wrong.
  assert.equal(domainOf('policy.networking.k8s.io'), 'Networking');
  assert.equal(domainOf('autoscaling.k8s.io'), 'Workloads');
  assert.equal(domainOf('resource.k8s.io'), 'Cluster & scheduling');
});

test('PodDisruptionBudget is a workload control, not an admission policy', () => {
  assert.equal(domainOf('policy'), 'Workloads');
});

test('a group nobody anticipated is bucketed by its registrable domain, not dumped in Other', () => {
  assert.equal(domainOf('widgets.acme.example.com'), 'Extensions: example.com');
  assert.equal(domainOf('gadgets.acme.example.com'), 'Extensions: example.com',
    'two operators from one vendor share a section');
  assert.notEqual(domainOf('widgets.acme.example.com'), domainOf('things.other.test'));
});

test('grouping is cluster-agnostic: no rule keys off an object name', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', 'tools', 'api-inventory-model.js'), 'utf8'
  );
  for (const banned of ['platform-sbx', 'platformsbx', 'fleet-dashboard', 'c-9d0a141', 'ondemand.com']) {
    assert.equal(src.includes(banned), false, `the model hardcodes ${banned}`);
  }
});

test('byDomain orders the known domains before the unanticipated ones', () => {
  const entries = fromAggregated(AGGREGATED).concat(fromAggregated({
    items: [{ metadata: { name: 'widgets.acme.test' }, versions: [{ version: 'v1', resources: [{ resource: 'widgets', responseKind: { kind: 'Widget' }, scope: 'Cluster', verbs: ['list'] }] }] }]
  }));
  const domains = byDomain(entries).map(d => d.domain);
  assert.equal(domains[0], 'Workloads');
  assert.equal(domains[domains.length - 1], 'Extensions: acme.test');
});

/* -------------------------------------------------------------------------- summary */

test('a refused read counts as refused and contributes no objects', () => {
  const entries = [
    { group: '', scope: 'Cluster', listable: true, subresources: [], probe: { outcome: 'ok', count: 7 } },
    { group: '', scope: 'Cluster', listable: true, subresources: [], probe: { outcome: 'forbidden', count: null } },
    { group: '', scope: 'Cluster', listable: true, subresources: [], probe: { outcome: 'unreachable', count: null } }
  ];
  const s = summarise(entries);
  assert.equal(s.probed, 3);
  assert.equal(s.readable, 1);
  assert.equal(s.refused, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.objects, 7, 'a null count must not be added as a zero or a NaN');
  assert.equal(Number.isNaN(s.objects), false);
});

test('a readable empty collection is readable but not non-empty', () => {
  const s = summarise([{ group: '', scope: 'Cluster', listable: true, subresources: [], probe: { outcome: 'ok', count: 0 } }]);
  assert.equal(s.readable, 1);
  assert.equal(s.nonEmpty, 0);
});
