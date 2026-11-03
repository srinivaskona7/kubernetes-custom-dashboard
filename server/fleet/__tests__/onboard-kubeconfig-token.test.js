
/**
 * Adding a cluster from an SSO kubeconfig plus a separately minted token.
 *
 * This is the shape an operator actually holds on a cluster whose admins log in through an
 * identity provider: a kubeconfig that carries the API server and its CA but authenticates
 * through `kubectl-oidc_login`, and a service-account token minted by hand with kubectl.
 * Neither half alone was enough before — `POST /clusters` took a token *or* a kubeconfig,
 * and the token branch demanded an `apiUrl` and a PEM `caData` in the request body. The
 * page filled those by parsing the YAML in the browser with regexes.
 *
 * So there are two properties under test here, and they fail in different ways:
 *
 *  - **The server reads the file.** If the endpoint facts came from the request body
 *    instead, a second parser in the browser decides what "the CA" and "the context" mean,
 *    and the summary on screen stops matching what gets registered.
 *  - **The file's own credential is ignored.** The kubeconfig authenticates via exec, which
 *    this pod cannot run. If any of it leaked into the stored record the cluster would
 *    register green and then fail every read.
 *
 * Plus the one that is a security property rather than a usability one: a request that
 * sends both a kubeconfig and an `apiUrl` must be registered at the *file's* address. A
 * body field that could override it is a way to point a legitimate-looking upload at
 * somewhere else entirely.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import _router_harness from './helpers/router-harness.js';
const { withRouter } = _router_harness;
import fixtures from './dev-fixtures.js';

const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIByDCCAW6gAwIBAgIUZm9vYmFy\n-----END CERTIFICATE-----\n';
const CA_B64 = Buffer.from(CA_PEM, 'utf8').toString('base64');
const SERVER = 'https://api.onboard-combined-test.invalid';

/** A service-account JWT with real-looking claims. Unsigned — nothing here verifies one. */
function saJwt({ namespace = 'fleet-dashboard', serviceAccount = 'fleet-reader', expSeconds = 24 * 3600 } = {}) {
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

/**
 * @param {object} [o]
 * @param {string|null} [o.caData] base64 CA, or null to leave the cluster entry without one
 * @param {'exec-oidc'|'token'|'none'} [o.credential] what the file's user entry carries
 * @param {string} [o.staticToken] the token written into the file when credential === 'token'
 * @param {string[]} [o.extraContexts] additional context names, for the selector
 */
function kubeconfig({
  server = SERVER,
  caData = CA_B64,
  credential = 'exec-oidc',
  staticToken = 'file.static.token',
  issuer = 'https://issuer.onboard-combined-test.invalid',
  extraContexts = [],
  clusterExtra = {}
} = {}) {
  const user = {
    'exec-oidc': `      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubectl-oidc_login
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=${issuer}
          - --oidc-client-id=combined-test-client`,
    token: `      token: ${staticToken}`,
    none: '      username: someone'
  }[credential];

  return `
apiVersion: v1
kind: Config
current-context: primary
clusters:
  - name: c1
    cluster:
      server: ${server}
${caData ? `      certificate-authority-data: ${caData}` : ''}
${Object.entries(clusterExtra).map(([k, v]) => `      ${k}: ${v}`).join('\n')}
contexts:
  - name: primary
    context:
      cluster: c1
      user: u1
      namespace: workloads
${extraContexts.map(c => `  - name: ${c}\n    context:\n      cluster: c1\n      user: u1`).join('\n')}
users:
  - name: u1
    user:
${user}
`;
}

/** The harness identity has no scopes, which is exactly what `requireAdmin` refuses. */
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

/** Materialises each patch in the Registry's watched directory, so `registry.get` sees it. */
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

// ------------------------------------------------------------------ describe

test('describe reads an SSO kubeconfig instead of refusing it, and names what the operator ' +
  'still has to supply', async t => {
  disableAdminScope(t);
  await withRouter(async ({ get }) => {
    const res = await postJson(get, '/clusters/kubeconfig/describe', { kubeconfig: kubeconfig() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.apiUrl, SERVER);
    assert.equal(res.body.contextName, 'primary');
    assert.equal(res.body.caPresent, true);
    assert.equal(res.body.credential, 'exec-oidc');
    assert.equal(res.body.hasStaticToken, false);
    // The page renders this rather than deciding for itself from `credential`, so that one
    // file cannot produce two different instructions in two different places.
    assert.equal(res.body.needsToken, true);
    assert.equal(res.body.defaultNamespace, 'workloads');
    assert.match(res.body.oidcIssuer, /^https:\/\/issuer\./);
  });
});

test('describe never echoes a credential back to the browser', async t => {
  // The whole response is rendered on a screen an operator will screenshot. A token in it
  // is a token in a ticket attachment, and the page has no use for one it already sent.
  disableAdminScope(t);
  const SENTINEL = 'SENTINEL_TOKEN_MUST_NEVER_APPEAR_IN_A_DESCRIBE_RESPONSE';
  await withRouter(async ({ get }) => {
    const res = await postJson(get, '/clusters/kubeconfig/describe', {
      kubeconfig: kubeconfig({ credential: 'token', staticToken: SENTINEL })
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.hasStaticToken, true, 'the file does carry a token; the flag must say so');
    assert.equal(res.body.needsToken, false);

    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(SENTINEL), 'the file\'s token reached the response body');
    assert.ok(!serialized.includes('BEGIN CERTIFICATE'), 'the CA PEM reached the response body; caPresent is all the page needs');
  });
});

test('describe lists every context and honours the one the operator picked', async t => {
  disableAdminScope(t);
  await withRouter(async ({ get }) => {
    const yaml = kubeconfig({ extraContexts: ['secondary'] });
    const first = await postJson(get, '/clusters/kubeconfig/describe', { kubeconfig: yaml });
    assert.deepEqual(first.body.contexts, ['primary', 'secondary']);
    assert.equal(first.body.contextName, 'primary', 'with no choice made, current-context wins');

    const chosen = await postJson(get, '/clusters/kubeconfig/describe', { kubeconfig: yaml, contextName: 'secondary' });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.contextName, 'secondary');
  });
});

test('describe still refuses the shapes that make an endpoint unusable', async t => {
  // Describing is permissive about *credentials* only. An unverifiable API server is not a
  // credential opinion, and answering 200 here would put a green summary on screen for a
  // cluster the dashboard will refuse at connect time anyway.
  disableAdminScope(t);
  await withRouter(async ({ get }) => {
    const insecure = await postJson(get, '/clusters/kubeconfig/describe', {
      kubeconfig: kubeconfig({ caData: null, clusterExtra: { 'insecure-skip-tls-verify': 'true' } })
    });
    assert.equal(insecure.status, 400);
    assert.match(insecure.body.message, /insecure-skip-tls-verify/);

    const plain = await postJson(get, '/clusters/kubeconfig/describe', {
      kubeconfig: kubeconfig({ server: 'http://api.example.invalid' })
    });
    assert.equal(plain.status, 400);
    assert.match(plain.body.message, /https/);

    const empty = await postJson(get, '/clusters/kubeconfig/describe', {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'NO_KUBECONFIG');
  });
});

test('describe applies the same apiUrl allowlist as every other path into the registry', async t => {
  // 169.254.169.254 is the instance metadata endpoint. A kubeconfig is no more trustworthy
  // for having arrived as YAML, and a preview that blessed it would be the first half of a
  // flow whose second half is refused — which reads as a bug in the refusal.
  disableAdminScope(t);
  await withRouter(async ({ get }) => {
    const res = await postJson(get, '/clusters/kubeconfig/describe', {
      kubeconfig: kubeconfig({ server: 'https://169.254.169.254' })
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'BLOCKED_API_URL');
  });
});

// -------------------------------------------------------- kubeconfig + token

test('an SSO kubeconfig and a pasted token onboard together: the file supplies the endpoint, ' +
  'the token supplies the credential', async t => {
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  const tokenWriter = memoryWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;

    const res = await postJson(get, '/clusters', {
      name: 'Combined SSO',
      env: 'sbx',
      kubeconfig: kubeconfig(),
      token: saJwt({ namespace: 'fleet-dashboard', serviceAccount: 'fleet-reader' })
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // Endpoint from the file. Neither value was in the request body.
    assert.equal(res.body.cluster.apiUrl, SERVER);
    const stored = clusterWriter.store.get('combined-sso');
    assert.equal(stored.caData, CA_PEM, 'the CA must be the decoded PEM from the file');
    assert.equal(stored.contextName, 'primary', 'the context actually read is recorded, not null');

    // Credential from the pasted token: the record's identity is its claims, and the file's
    // exec block contributed nothing.
    assert.equal(stored.namespace, 'fleet-dashboard');
    assert.equal(stored.serviceAccount, 'fleet-reader');
    assert.equal(stored.authMode, 'token');
    assert.ok(!JSON.stringify(stored).includes('kubectl-oidc_login'), 'the exec credential leaked into the record');
    assert.ok(tokenWriter.store.get('combined-sso').token, 'no token was stored for the cluster');
  });
});

test('a kubeconfig wins over an apiUrl sent beside it', async t => {
  // Otherwise a request can show one file and register another address: the preview the
  // operator approved would describe the file, and the cluster would point somewhere else.
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;

    const res = await postJson(get, '/clusters', {
      name: 'Override Attempt',
      kubeconfig: kubeconfig(),
      apiUrl: 'https://api.attacker.invalid',
      caData: CA_PEM,
      token: saJwt()
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.cluster.apiUrl, SERVER, 'the body apiUrl overrode the file');
    assert.equal(clusterWriter.store.get('override-attempt').apiUrl, SERVER);
  });
});

test('a kubeconfig with no certificate authority is refused, and says how to re-export it', async t => {
  // The alternative is registering a cluster the dashboard will never verify, or silently
  // falling back to the system trust store — which for a private CA means every read fails
  // later with a TLS error nobody can trace back to this form.
  disableAdminScope(t);
  await withRouter({ callFn: fixtures.callFn, clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const res = await postJson(get, '/clusters', {
      name: 'No CA',
      kubeconfig: kubeconfig({ caData: null }),
      token: saJwt()
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'NO_CA');
    assert.match(res.body.message, /--flatten/, 'the message must name the command that fixes it');
  });
});

test('the token-only path is unchanged: apiUrl and caData in the body still onboard', async t => {
  // The regression guard for the branch that already existed. The combined path adds a way
  // in; it must not have taken one away.
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;
    const res = await postJson(get, '/clusters', {
      name: 'Body Only',
      apiUrl: SERVER,
      caData: CA_PEM,
      token: saJwt()
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.cluster.apiUrl, SERVER);
    assert.equal(clusterWriter.store.get('body-only').contextName, null, 'no kubeconfig was read, so there is no context to record');
  });
});

test('neither a token nor a kubeconfig is still a 400, not a half-registered cluster', async t => {
  disableAdminScope(t);
  await withRouter({ clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ({ get }) => {
    const res = await postJson(get, '/clusters', { name: 'Nothing At All' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NO_CREDENTIAL');
  });
});

// ------------------------------------------------- the 201 echoes what was registered

test('the 201 describes the cluster that was registered, not the candidate that went in', async t => {
  // `publicCluster(candidate)` was answering with the *input* record — which has no
  // `source` and no `onboardedVia` — so every freshly onboarded cluster came back as
  // `onboardedVia: 'baked'` while the top-level field beside it said 'token'. Inert today
  // because the page reads the top-level one, and exactly the kind of disagreement that
  // stops being inert the moment someone binds to the nested object.
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;
    const res = await postJson(get, '/clusters', {
      name: 'Echo Check', apiUrl: SERVER, caData: CA_PEM, token: saJwt()
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.cluster.onboardedVia, 'token');
    assert.equal(res.body.cluster.onboardedVia, res.body.onboardedVia,
      'the nested record and the top-level field must not disagree');
    assert.equal(res.body.cluster.onboardedVia, clusterWriter.store.get('echo-check').onboardedVia,
      'the response must describe the record that was actually written');
  });
});

test('a token that cannot mint its successor is reported as non-renewable in BOTH places', async t => {
  // This is the half of the bug that was not cosmetic. adopt() had already discovered the
  // self-mint was refused and set `renewable: false`, and `publicCluster(candidate)` then
  // defaulted the nested copy back to `true` — a cluster that will go dark when the pasted
  // token lapses, described in the same response as one that renews forever.
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;
    const res = await postJson(get, '/clusters', {
      name: 'No Renew', apiUrl: SERVER, caData: CA_PEM,
      token: saJwt({ serviceAccount: 'no-renew' })
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.renewable, false, 'the fixture SA is forbidden from minting; adopt() must say so');
    assert.equal(res.body.cluster.renewable, false, 'the nested record claimed the chain turns when it does not');
    assert.equal(clusterWriter.store.get('no-renew').renewable, false);

    const warned = res.body.steps.find(s => s.id === 'selfmint');
    assert.equal(warned.level, 'warn');
    assert.match(warned.detail, /go dark/);
  });
});

test('the kubeconfig-only path echoes its own onboardedVia too', async t => {
  disableAdminScope(t);
  const clusterWriter = fileBackedClusterWriter();
  await withRouter({ callFn: fixtures.callFn, clusterWriter, tokenWriter: memoryWriter() }, async ({ get, registry }) => {
    clusterWriter.dir = registry.dir;
    const res = await postJson(get, '/clusters', {
      name: 'Kubeconfig Only',
      kubeconfig: kubeconfig({ credential: 'token', staticToken: saJwt({ serviceAccount: 'admin-user' }) })
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.cluster.onboardedVia, 'kubeconfig');
    assert.equal(res.body.cluster.onboardedVia, res.body.onboardedVia);
  });
});
