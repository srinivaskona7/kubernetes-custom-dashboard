
/**
 * Taking over an id that already exists.
 *
 * The defect these tests close: every onboarding path guarded its id with
 * `existing && registry.isBaked(id)`, so a cluster baked into the image was protected and a
 * cluster an *operator* had onboarded was not. `POST /clusters` with a matching name silently
 * repointed a live cluster at a different API server with a different token, and the console then
 * rendered that API server under the real cluster's name, healthy, with the real cluster's
 * history. Nothing in the 201 said a cluster had been replaced. With
 * `FLEET_REQUIRE_ADMIN_SCOPE=false` — how sbx runs today — every authenticated caller could do it.
 *
 * The contract now: an existing id is a 409 unless the body says `replace: true`. That is not a
 * privilege check (the privilege check is the admin scope, and it is a separate control); it is
 * the difference between an overwrite that happened and an overwrite someone asked for.
 *
 * Every assertion below is about the *stored record* as well as the status code, because the
 * failure mode was a write that succeeded while the response looked ordinary.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import _router_harness from './helpers/router-harness.js';
const { withRouter } = _router_harness;
import fixtures from './dev-fixtures.js';

const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIByDCCAW6gAwIBAgIUZm9vYmFy\n-----END CERTIFICATE-----\n';
const SERVER = 'https://api.collision-test.invalid';
const OTHER_SERVER = 'https://api.attacker-collision-test.invalid';

function saJwt({ namespace = 'kyma-fleet', serviceAccount = 'fleet-reader', expSeconds = 24 * 3600 } = {}) {
  const b64 = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({
      sub: `system:serviceaccount:${namespace}:${serviceAccount}`,
      exp: Math.floor(Date.now() / 1000) + expSeconds,
      iat: Math.floor(Date.now() / 1000),
      'kubernetes.io': { namespace, serviceaccount: { name: serviceAccount } }
    }),
    'not-a-real-signature'
  ].join('.');
}

function disableAdminScope(t) {
  const before = process.env.FLEET_REQUIRE_ADMIN_SCOPE;
  process.env.FLEET_REQUIRE_ADMIN_SCOPE = 'false';
  t.onTestFinished(() => {
    if (before === undefined) delete process.env.FLEET_REQUIRE_ADMIN_SCOPE;
    else process.env.FLEET_REQUIRE_ADMIN_SCOPE = before;
  });
}

function memoryWriter() {
  const store = new Map();
  return {
    store,
    patch: async (id, fields) => { store.set(id, { ...(store.get(id) || {}), ...fields }); return store.get(id); },
    remove: async id => { store.delete(id); return { removed: true }; }
  };
}

/**
 * Materialises each patch in the Registry's watched directory. Required here and not optional:
 * the collision gate asks `registry.get(id)`, so a writer that only fills a Map would report no
 * collision and every test below would pass for the wrong reason.
 */
function fileBackedClusterWriter() {
  const store = new Map();
  const writer = {
    store,
    dir: null,
    patch: async (id, fields) => {
      const record = { ...(store.get(id) || {}), ...fields };
      store.set(id, record);
      if (writer.dir) fs.writeFileSync(path.join(writer.dir, id), JSON.stringify(record));
      return record;
    },
    remove: async id => {
      store.delete(id);
      if (writer.dir) fs.rmSync(path.join(writer.dir, id), { force: true });
      return { removed: true };
    }
  };
  return writer;
}

const postJson = (get, path_, body) => get(path_, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

const kubeconfigWithToken = (server, token) => `
apiVersion: v1
kind: Config
current-context: primary
clusters:
  - name: c1
    cluster:
      server: ${server}
      certificate-authority-data: ${Buffer.from(CA_PEM, 'utf8').toString('base64')}
contexts:
  - name: primary
    context:
      cluster: c1
      user: u1
users:
  - name: u1
    user:
      token: ${token}
`;

test('a second POST /clusters for an id that already exists is refused, and the live cluster ' +
  'keeps its own API server', async t => {
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;

    const first = await postJson(get, '/clusters', {
      name: 'Prod Cluster', apiUrl: SERVER, caData: CA_PEM, token: saJwt()
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(clusterWriter.store.get('prod-cluster').apiUrl, SERVER);

    const second = await postJson(get, '/clusters', {
      name: 'Prod Cluster', apiUrl: OTHER_SERVER, caData: CA_PEM, token: saJwt()
    });
    assert.equal(second.status, 409, `an existing id must be refused, got ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(second.body.code, 'CLUSTER_EXISTS');
    assert.equal(
      clusterWriter.store.get('prod-cluster').apiUrl, SERVER,
      'the refused request still rewrote the stored apiUrl — this is the hijack the 409 exists to stop'
    );
  });
});

test('replace: true is the one way through, and it really does replace', async t => {
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;

    await postJson(get, '/clusters', { name: 'Repoint Me', apiUrl: SERVER, caData: CA_PEM, token: saJwt() });
    const again = await postJson(get, '/clusters', {
      name: 'Repoint Me', apiUrl: OTHER_SERVER, caData: CA_PEM, token: saJwt(), replace: true
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(clusterWriter.store.get('repoint-me').apiUrl, OTHER_SERVER);
  });
});

test('a truthy-but-not-true replace does not open the gate', async t => {
  // `replace: "true"` or `replace: 1` is what a hand-rolled client sends by accident, and the
  // check is strict `=== true` precisely so that an accident is not a confirmation.
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;
    await postJson(get, '/clusters', { name: 'Strict', apiUrl: SERVER, caData: CA_PEM, token: saJwt() });
    for (const value of ['true', 1, {}, 'yes']) {
      const res = await postJson(get, '/clusters', {
        name: 'Strict', apiUrl: OTHER_SERVER, caData: CA_PEM, token: saJwt(), replace: value
      });
      assert.equal(res.status, 409, `replace: ${JSON.stringify(value)} was accepted as a confirmation`);
    }
    assert.equal(clusterWriter.store.get('strict').apiUrl, SERVER);
  });
});

test('the kubeconfig-only path is gated by the same check, not a second copy of it', async t => {
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;

    const first = await postJson(get, '/clusters/bootstrap-oidc', {
      name: 'File Cluster', kubeconfig: kubeconfigWithToken(SERVER, saJwt())
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await postJson(get, '/clusters/bootstrap-oidc', {
      name: 'File Cluster', kubeconfig: kubeconfigWithToken(OTHER_SERVER, saJwt())
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.code, 'CLUSTER_EXISTS');
    assert.equal(clusterWriter.store.get('file-cluster').apiUrl, SERVER);
  });
});

test('a fresh id is never blocked — the gate protects what exists, it does not gate onboarding', async t => {
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const res = await postJson(get, '/clusters', { name, apiUrl: SERVER, caData: CA_PEM, token: saJwt() });
      assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(clusterWriter.store.size, 3);
  });
});
