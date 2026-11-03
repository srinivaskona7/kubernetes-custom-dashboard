/**
 * The live-object YAML route, and the five redactions that make it safe to ship.
 *
 * Every assertion here was canaried against the real cluster before being written: with
 * `redact()` short-circuited to a no-op, `GET /clusters/platform-sbx/resource-yaml?kind=Secret`
 * returned a base64 XSUAA client secret and the full `managedFields` block. That is what these
 * tests stop coming back.
 *
 * The rule each one enforces is not invented here — it is the rule some existing collector
 * already applies to the same data. A YAML view that showed more than the tab beside it would be
 * a widening of exposure wearing a convenience's clothes, so the tests are written against the
 * existing contract rather than against this file's own idea of one.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import YAML from 'yaml';

import _resource_yaml from '../collectors/resource-yaml.js';
const { read, redact, pathsFor, READABLE_KINDS, LAST_APPLIED } = _resource_yaml;
import _helm_related2 from '../collectors/helm-related.js';
const { LIVE_KINDS } = _helm_related2;

const cluster = { id: 'c1', apiUrl: 'https://api.example.invalid' };

/** A `callFn` that answers one object, and records the path it was asked for. */
function fakeCall(object, seen = []) {
  return async ({ path }) => {
    seen.push(path);
    if (object instanceof Error) throw object;
    return object;
  };
}

// ------------------------------------------------------------------ redaction

test('a Secret keeps its key names and loses every value', () => {
  const { object, redactions } = redact({
    kind: 'Secret',
    metadata: { name: 's' },
    type: 'Opaque',
    data: { password: 'c3VwZXItc2VjcmV0', 'client-secret': 'YWJj' },
    stringData: { plain: 'also-secret' }
  });

  assert.deepStrictEqual(Object.keys(object.data).sort(), ['client-secret', 'password']);
  for (const v of Object.values(object.data)) assert.strictEqual(v, null, 'no Secret value may survive');
  for (const v of Object.values(object.stringData)) assert.strictEqual(v, null, 'stringData is a value too');
  assert.ok(redactions.some(r => /Secret data values \(2 keys kept\)/.test(r)));
  assert.ok(redactions.some(r => /Secret stringData/.test(r)));
});

test('a ConfigMap keeps its key names and loses every value', () => {
  // Matches `helm-related.js` factsFor, which reports `{ keys: [...] }` for a ConfigMap and never
  // its values. A ConfigMap is not a credential store by contract, but plenty hold one anyway,
  // and this console is reachable by any authenticated user wherever the admin scope is off.
  const { object, redactions } = redact({
    kind: 'ConfigMap',
    metadata: { name: 'cm' },
    data: { 'db.url': 'postgres://user:pw@host/db' },
    binaryData: { blob: 'AAAA' }
  });

  assert.deepStrictEqual(Object.keys(object.data), ['db.url']);
  assert.strictEqual(object.data['db.url'], null);
  assert.strictEqual(object.binaryData.blob, null);
  assert.ok(redactions.some(r => /ConfigMap data values/.test(r)));
});

test('container env keeps names and valueFrom, and loses inline values', () => {
  // `workloads.js` publishes `envKeys: c.env.map(e => e.name)` at two call sites — names, never
  // values. `valueFrom` survives on purpose: it names a Secret key rather than carrying one, and
  // it is what an operator asking "where does this variable come from" needs.
  const { object, redactions } = redact({
    kind: 'Deployment',
    spec: {
      template: {
        spec: {
          initContainers: [{ name: 'init', env: [{ name: 'TOKEN', value: 'leaked' }] }],
          containers: [{
            name: 'app',
            env: [
              { name: 'PLAIN', value: 'super-secret' },
              { name: 'FROM_SECRET', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } }
            ]
          }]
        }
      }
    }
  });

  const env = object.spec.template.spec.containers[0].env;
  assert.deepStrictEqual(env[0], { name: 'PLAIN' }, 'the name stays, the value goes');
  assert.deepStrictEqual(env[1].valueFrom, { secretKeyRef: { name: 's', key: 'k' } }, 'a reference is not a value');
  assert.deepStrictEqual(object.spec.template.spec.initContainers[0].env[0], { name: 'TOKEN' });
  assert.ok(redactions.some(r => /container env values/.test(r)));
});

test('a CronJob\'s doubly-nested pod spec is reached too', () => {
  // spec.jobTemplate.spec.template.spec — the one Kind where a pod spec is two levels down. Miss
  // it and every CronJob's env leaks while every Deployment's is clean, which is the kind of gap
  // that survives a casual review.
  const { object } = redact({
    kind: 'CronJob',
    spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'c', env: [{ name: 'K', value: 'v' }] }] } } } } }
  });
  assert.deepStrictEqual(object.spec.jobTemplate.spec.template.spec.containers[0].env[0], { name: 'K' });
});

test('the last-applied-configuration annotation is removed', () => {
  // The load-bearing one. It is a complete JSON copy of the object as applied, sitting in an
  // annotation, and it carries the Secret values, ConfigMap values and env values every other
  // rule just removed. Redact the object and leave this, and the redaction has done nothing.
  const applied = JSON.stringify({ kind: 'Secret', data: { password: 'c3VwZXItc2VjcmV0' } });
  const { object, redactions } = redact({
    kind: 'Secret',
    metadata: { name: 's', annotations: { [LAST_APPLIED]: applied, keep: 'me' } },
    data: { password: 'c3VwZXItc2VjcmV0' }
  });

  assert.ok(!(LAST_APPLIED in object.metadata.annotations), 'the annotation must be gone');
  assert.strictEqual(object.metadata.annotations.keep, 'me', 'other annotations are untouched');
  assert.ok(!JSON.stringify(object).includes('c3VwZXItc2VjcmV0'), 'no copy of the value may survive anywhere');
  assert.ok(redactions.some(r => r.includes(LAST_APPLIED)));
});

test('managedFields is dropped', () => {
  const { object, redactions } = redact({ kind: 'Service', metadata: { name: 's', managedFields: [{ manager: 'kubectl' }] } });
  assert.ok(!('managedFields' in object.metadata));
  assert.ok(redactions.includes('metadata.managedFields'));
});

test('redact never mutates the object it was given', () => {
  // The caller is `read`, which holds the object the transport returned. Mutating it in place
  // would mean an unredacted copy and a redacted copy sharing structure — and whichever one a
  // future caller reached for would be a coin toss.
  const original = { kind: 'Secret', metadata: { name: 's' }, data: { k: 'dmFsdWU=' } };
  redact(original);
  assert.strictEqual(original.data.k, 'dmFsdWU=', 'the input is the caller\'s, not ours');
});

test('an object with nothing to redact reports no redactions', () => {
  // So the drawer's "what was removed" note stays honest: it must not claim a redaction on an
  // object that had none, or the reader learns to ignore it.
  const { redactions } = redact({ kind: 'Service', metadata: { name: 's' }, spec: { ports: [{ port: 80 }] } });
  assert.deepStrictEqual(redactions, []);
});

// ------------------------------------------------------------------ the read

test('only the Kinds the graph draws are readable', () => {
  // The allowlist is shared with `helm-related.js` so the two cannot drift: a Kind the
  // Architecture graph can draw is a Kind its drawer can open, and nothing else is reachable.
  assert.deepStrictEqual(READABLE_KINDS, [...new Set(LIVE_KINDS.map(k => k.kind))].sort());
  assert.ok(READABLE_KINDS.includes('Deployment'));
  assert.ok(!READABLE_KINDS.includes('Node'), 'a Kind outside the release graph is not reachable here');
});

test('an unsupported kind is refused before any cluster call', async () => {
  let called = false;
  await assert.rejects(
    read({ cluster, token: 't', kind: 'ClusterRole', name: 'x', callFn: async () => { called = true; } }),
    /not a Kind this console reads/
  );
  assert.strictEqual(called, false, 'an unknown Kind must cost no cluster traffic at all');
});

test('a namespaced read targets the namespaced path and a cluster-scoped read does not', () => {
  assert.deepStrictEqual(pathsFor('Deployment', 'foo'), ['/apis/apps/v1/namespaces/foo/deployments']);
  assert.deepStrictEqual(pathsFor('Deployment', null), ['/apis/apps/v1/deployments']);
});

test('AuthorizationPolicy is readable, GET only, from security.istio.io/v1', () => {
  assert.ok(READABLE_KINDS.includes('AuthorizationPolicy'));
  // `pathsFor` returns collection URLs (namespace, no name) — `read()` appends the name.
  const [p] = pathsFor('AuthorizationPolicy', 'istio-system');
  assert.equal(p, '/apis/security.istio.io/v1/namespaces/istio-system/authorizationpolicies');
});

test('a collection query string is not carried onto a single-object read', () => {
  // `LIVE_KINDS` builds *collection* URLs and Pod's carries `?limit=2000`, which is meaningless
  // for one object and would make the path wrong.
  assert.deepStrictEqual(pathsFor('Pod', 'foo'), ['/api/v1/namespaces/foo/pods']);
});

test('a Certificate is tried against both CRDs, and the first that answers wins', async () => {
  const seen = [];
  const notFound = Object.assign(new Error('nope'), { status: 404 });
  const result = await read({
    cluster, token: 't', kind: 'Certificate', namespace: 'foo', name: 'c',
    callFn: async ({ path }) => {
      seen.push(path);
      if (path.includes('cert.gardener.cloud')) throw notFound;
      return { kind: 'Certificate', apiVersion: 'cert-manager.io/v1', metadata: { name: 'c' } };
    }
  });
  assert.strictEqual(seen.length, 2, 'the absent CRD is tried first, then the present one');
  assert.strictEqual(result.apiVersion, 'cert-manager.io/v1');
});

test('a 403 is not retried against the other CRD', async () => {
  // Asking a second API for the same object after a refusal would turn one honest permission
  // error into a misleading "not found" — the exact conversion the completeness contract forbids.
  const seen = [];
  const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
  await assert.rejects(read({
    cluster, token: 't', kind: 'Certificate', namespace: 'foo', name: 'c',
    callFn: async ({ path }) => { seen.push(path); throw forbidden; }
  }), /forbidden/);
  assert.strictEqual(seen.length, 1, 'a refusal stops the walk');
});

test('the read returns parseable YAML of the redacted object', async () => {
  const seen = [];
  const result = await read({
    cluster, token: 't', kind: 'Secret', namespace: 'foo', name: 's',
    callFn: fakeCall({
      kind: 'Secret', apiVersion: 'v1',
      metadata: { name: 's', namespace: 'foo', resourceVersion: '42', managedFields: [{}] },
      data: { password: 'c3VwZXItc2VjcmV0' }
    }, seen)
  });

  assert.deepStrictEqual(seen, ['/api/v1/namespaces/foo/secrets/s']);
  assert.strictEqual(result.resourceVersion, '42');
  const parsed = YAML.parse(result.yaml);
  assert.strictEqual(parsed.data.password, null, 'the value must be gone from the YAML, not just from the object');
  assert.ok(!result.yaml.includes('c3VwZXItc2VjcmV0'));
  assert.ok(!result.yaml.includes('managedFields'));
});

test('a name with a slash cannot escape the resource path', async () => {
  const seen = [];
  await read({
    cluster, token: 't', kind: 'ConfigMap', namespace: 'foo', name: '../../secrets/admin',
    callFn: fakeCall({ kind: 'ConfigMap', metadata: {} }, seen)
  });
  assert.strictEqual(seen[0], '/api/v1/namespaces/foo/configmaps/..%2F..%2Fsecrets%2Fadmin');
});

test('a namespace with a slash cannot escape either', async () => {
  const seen = [];
  await read({
    cluster, token: 't', kind: 'ConfigMap', namespace: '../../../api/v1/secrets', name: 'x',
    callFn: fakeCall({ kind: 'ConfigMap', metadata: {} }, seen)
  });
  assert.ok(
    seen[0].startsWith('/api/v1/namespaces/..%2F'),
    `the namespace must be encoded, got ${seen[0]}`
  );
});
