/**
 * Kubeconfig parsing.
 *
 * Most of these tests assert a *refusal*. That is the point of the module: every rejected
 * shape here is one that would otherwise fail deep inside an HTTPS call with an error an
 * operator cannot act on, or — worse, in the insecure-skip-tls-verify case — succeed
 * against an unverified API server.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import _kubeconfig from '../kubeconfig.js';
const { parseKubeconfig, extractExecOidcParams, toClusterId, KubeconfigError } = _kubeconfig;

const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIByDCCAW6gAwIBAgI=\n-----END CERTIFICATE-----\n';
const CA_B64 = Buffer.from(CA_PEM, 'utf8').toString('base64');

function kubeconfig(overrides = {}) {
  const {
    server = 'https://api.example.hana.ondemand.com',
    caData = CA_B64,
    user = { token: 'abc.def.ghi' },
    clusterExtra = {},
    currentContext = 'ctx'
  } = overrides;
  return `
apiVersion: v1
kind: Config
current-context: ${currentContext}
clusters:
  - name: c1
    cluster:
      server: ${server}
${caData ? `      certificate-authority-data: ${caData}` : ''}
${Object.entries(clusterExtra).map(([k, v]) => `      ${k}: ${v}`).join('\n')}
contexts:
  - name: ctx
    context:
      cluster: c1
      user: u1
      namespace: default
users:
  - name: u1
    user:
${Object.entries(user).map(([k, v]) => `      ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')}
`;
}

test('a well-formed kubeconfig yields exactly what onboarding needs', () => {
  const out = parseKubeconfig(kubeconfig());
  assert.equal(out.apiUrl, 'https://api.example.hana.ondemand.com');
  assert.equal(out.token, 'abc.def.ghi');
  assert.equal(out.caData, CA_PEM);
  assert.equal(out.contextName, 'ctx');
  assert.equal(out.defaultNamespace, 'default');
});

test('a trailing slash on the server is stripped, so paths never double up', () => {
  const out = parseKubeconfig(kubeconfig({ server: 'https://api.example.com/' }));
  assert.equal(out.apiUrl, 'https://api.example.com');
});

test('insecure-skip-tls-verify is refused rather than honoured', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ caData: null, clusterExtra: { 'insecure-skip-tls-verify': 'true' } })),
    err => err instanceof KubeconfigError && /insecure-skip-tls-verify/.test(err.message)
  );
});

test('an exec credential is refused, and the message says what to upload instead', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ user: { exec: { command: 'gke-gcloud-auth-plugin' } } })),
    err => err instanceof KubeconfigError && /kubectl create token/.test(err.message)
  );
});

test('an auth-provider credential is refused for the same reason', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ user: { 'auth-provider': { name: 'oidc' } } })),
    err => err instanceof KubeconfigError && /helper binary/.test(err.message)
  );
});

test('client-certificate auth is refused — it cannot be rotated by the token chain', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ user: { 'client-certificate-data': 'xxx' } })),
    err => err instanceof KubeconfigError && /client certificate/.test(err.message)
  );
});

test('a CA file path is refused because that path does not exist in the pod', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ caData: null, clusterExtra: { 'certificate-authority': '/etc/ca.crt' } })),
    err => err instanceof KubeconfigError && /certificate-authority-data/.test(err.message)
  );
});

test('an http server is refused; only https is ever contacted', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ server: 'http://api.example.com' })),
    err => err instanceof KubeconfigError && /https/.test(err.message)
  );
});

test('a kubeconfig with no token at all is refused', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ user: { username: 'admin' } })),
    err => err instanceof KubeconfigError && /token/.test(err.message)
  );
});

test('a missing current-context lists the contexts that do exist', () => {
  assert.throws(
    () => parseKubeconfig(kubeconfig({ currentContext: '' }).replace('current-context: \n', '')),
    err => err instanceof KubeconfigError && /available contexts: ctx/.test(err.message)
  );
});

test('an explicit contextName overrides current-context', () => {
  const text = kubeconfig({ currentContext: 'nope' });
  const out = parseKubeconfig(text, { contextName: 'ctx' });
  assert.equal(out.contextName, 'ctx');
});

test('a context naming a cluster that is not defined fails with that fact', () => {
  const text = kubeconfig().replace('name: c1', 'name: other');
  assert.throws(() => parseKubeconfig(text), err => /does not define it/.test(err.message));
});

test('non-YAML input fails as a 400, not a 500', () => {
  assert.throws(
    () => parseKubeconfig('\tthis: [is not: yaml'),
    err => err instanceof KubeconfigError && err.status === 400
  );
});

test('a YAML document that is not a kubeconfig is named as such', () => {
  assert.throws(
    () => parseKubeconfig('kind: Deployment\napiVersion: apps/v1\n'),
    err => /kind: Deployment/.test(err.message)
  );
});

test('certificate-authority-data that is not a certificate is rejected', () => {
  const junk = Buffer.from('not a cert', 'utf8').toString('base64');
  assert.throws(() => parseKubeconfig(kubeconfig({ caData: junk })), err => /could not be decoded/.test(err.message));
});

test('cluster ids are slugified into something safe to use as a filename', () => {
  assert.equal(toClusterId('Platform Dev'), 'platform-dev');
  assert.equal(toClusterId('  PROD/eu10  '), 'prod-eu10');
  assert.equal(toClusterId('a'.repeat(80)).length, 63);
});

test('a name that cannot become an id is rejected rather than silently mangled', () => {
  assert.throws(() => toClusterId('///'), err => err instanceof KubeconfigError);
  assert.throws(() => toClusterId(''), err => err instanceof KubeconfigError);
});

test('a name that would escape the token mount cannot survive slugification', () => {
  // The id becomes a filename; ../ must not come out the other side.
  assert.equal(toClusterId('../../etc/passwd'), 'etc-passwd');
});

/**
 * extractExecOidcParams — Approach-D groundwork. This does not authenticate anything; it
 * only extracts the exec block's OIDC parameters so Wave 2 can drive a server-side
 * Authorization Code + PKCE flow instead of the helper binary parseKubeconfig refuses.
 */

test('a token-based kubeconfig has no exec block: extractExecOidcParams returns null, ' +
  'and parseKubeconfig is completely unaffected (regression)', () => {
  const text = kubeconfig();
  assert.deepEqual(extractExecOidcParams(text), { execOidc: null });
  // Canary for this assertion: if resolveContext ever started treating a missing exec as
  // present (e.g. `user.exec !== undefined` typo'd to always-true), this would flip to a
  // non-null execOidc and the regression check below would still pass — so the null check
  // above is the one carrying the weight, not the regression re-run.
  const out = parseKubeconfig(text);
  assert.equal(out.apiUrl, 'https://api.example.hana.ondemand.com');
  assert.equal(out.token, 'abc.def.ghi');
  assert.equal(out.caData, CA_PEM);
  assert.equal(out.contextName, 'ctx');
  assert.equal(out.defaultNamespace, 'default');
});

test('a real-shaped OIDC exec block yields issuer/clientId/extraScopes, collecting every ' +
  '--oidc-extra-scope flag, not just the first', () => {
  const text = kubeconfig({
    user: {
      exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1',
        command: 'kubectl-oidc_login',
        args: [
          'oidc-login',
          'get-token',
          '--oidc-issuer-url=https://at8sphwyf.accounts.ondemand.com',
          '--oidc-client-id=1a2b3c4d-1234-5678-9abc-1234567890ab',
          '--oidc-extra-scope=email',
          '--oidc-extra-scope=openid'
        ]
      }
    }
  });
  const { execOidc } = extractExecOidcParams(text);
  assert.ok(execOidc);
  assert.equal(execOidc.issuer, 'https://at8sphwyf.accounts.ondemand.com');
  assert.equal(execOidc.clientId, '1a2b3c4d-1234-5678-9abc-1234567890ab');
  assert.deepEqual(execOidc.extraScopes, ['email', 'openid']);
  assert.equal(execOidc.apiUrl, 'https://api.example.hana.ondemand.com');
  assert.equal(execOidc.caData, CA_PEM);
  assert.equal(execOidc.contextName, 'ctx');
  // No other exec-block content leaks through (e.g. raw exec.args, exec.command).
  assert.deepEqual(
    Object.keys(execOidc).sort(),
    ['apiUrl', 'caData', 'clientId', 'contextName', 'extraScopes', 'issuer'].sort()
  );
});

test('an exec block with space-separated flag/value args is also recognised', () => {
  const text = kubeconfig({
    user: {
      exec: {
        command: 'kubectl-oidc_login',
        args: [
          'get-token',
          '--oidc-issuer-url', 'https://idp.example.com',
          '--oidc-client-id', 'client-abc'
        ]
      }
    }
  });
  const { execOidc } = extractExecOidcParams(text);
  assert.equal(execOidc.issuer, 'https://idp.example.com');
  assert.equal(execOidc.clientId, 'client-abc');
  assert.deepEqual(execOidc.extraScopes, []);
});

test('an exec block for an unrecognised command returns null rather than guessing', () => {
  const text = kubeconfig({
    user: { exec: { command: 'gke-gcloud-auth-plugin', args: ['--some-flag=x'] } }
  });
  assert.deepEqual(extractExecOidcParams(text), { execOidc: null });
});

test('an exec block with no args at all also returns null, not a throw', () => {
  const text = kubeconfig({ user: { exec: { command: 'some-plugin' } } });
  assert.deepEqual(extractExecOidcParams(text), { execOidc: null });
});

test('a malformed issuer URL throws KubeconfigError, not a downstream crash', () => {
  const text = kubeconfig({
    user: {
      exec: {
        command: 'kubectl-oidc_login',
        args: ['--oidc-issuer-url=not a url', '--oidc-client-id=abc']
      }
    }
  });
  assert.throws(
    () => extractExecOidcParams(text),
    err => err instanceof KubeconfigError && /oidc-issuer-url/.test(err.message)
  );
});

test('a non-https issuer is rejected — an attacker-controlled issuer string is exactly the ' +
  'shape of a previously-shipped exfiltration bug', () => {
  const text = kubeconfig({
    user: {
      exec: {
        command: 'kubectl-oidc_login',
        args: ['--oidc-issuer-url=http://evil.example.com', '--oidc-client-id=abc']
      }
    }
  });
  assert.throws(
    () => extractExecOidcParams(text),
    err => err instanceof KubeconfigError && /https/.test(err.message)
  );
});

test('an exec/OIDC kubeconfig is not automatically stopped by parseKubeconfig\'s own ' +
  'refusal call site: extractExecOidcParams is independent, still extracts', () => {
  const text = kubeconfig({
    user: {
      exec: {
        command: 'kubectl-oidc_login',
        args: ['--oidc-issuer-url=https://idp.example.com', '--oidc-client-id=abc']
      }
    }
  });
  // parseKubeconfig still refuses this exec kubeconfig exactly as before (unchanged contract).
  assert.throws(
    () => parseKubeconfig(text),
    err => err instanceof KubeconfigError && /kubectl create token/.test(err.message)
  );
  // extractExecOidcParams reads the same file successfully.
  const { execOidc } = extractExecOidcParams(text);
  assert.ok(execOidc);
  assert.equal(execOidc.issuer, 'https://idp.example.com');
});
