/**
 * Kubeconfig parsing, for the "Add cluster" upload.
 *
 * Only what onboarding needs is extracted: the API server address, the CA that verifies
 * it, and one credential usable as a bearer token. Everything else in a kubeconfig is
 * ignored.
 *
 * Three refusals are deliberate and worth stating, because each one is a class of silent
 * failure we would otherwise inherit:
 *
 *   - `insecure-skip-tls-verify: true` is rejected. A dashboard that reads five clusters
 *     over unverified TLS is a credential-harvesting target wearing a monitoring costume.
 *     Supply the CA.
 *   - exec / auth-provider credentials are rejected. They mean "run this binary to get a
 *     token" — there is no binary in this image, and pretending otherwise would fail at
 *     the first API call with an unrecognisable error.
 *   - client-certificate auth is rejected. It works, but it is a long-lived credential
 *     that cannot be rotated by the TokenRequest chain, which is the entire mechanism
 *     this dashboard is built on.
 */
import YAML from 'yaml';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

class KubeconfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KubeconfigError';
    this.code = 'BAD_KUBECONFIG';
    this.status = 400;
  }
}

function decodeB64(value, what) {
  try {
    const pem = Buffer.from(String(value), 'base64').toString('utf8');
    if (!/-----BEGIN CERTIFICATE-----/.test(pem)) {
      throw new Error('decoded value is not a PEM certificate');
    }
    return pem;
  } catch (err) {
    throw new KubeconfigError(`${what} could not be decoded: ${err.message}`);
  }
}

function byName(list, name, what) {
  const entry = (list || []).find(e => e && e.name === name);
  if (!entry) throw new KubeconfigError(`kubeconfig names ${what} "${name}" but does not define it`);
  return entry;
}

/**
 * Shared YAML-parse + current-context resolution, used by both parseKubeconfig and
 * extractExecOidcParams. Returns the raw doc pieces; each caller applies its own
 * validation/refusal rules on top (they differ, so this stops at resolution).
 *
 * @param {string} text the uploaded YAML
 * @param {{contextName?: string}} [opts]
 * @returns {{doc: object, contextName: string, context: object, cluster: object, user: object}}
 */
function resolveContext(text, opts = {}) {
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new KubeconfigError(`not valid YAML: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new KubeconfigError('file is empty or not a mapping');
  if (doc.kind && doc.kind !== 'Config') {
    throw new KubeconfigError(`expected a kubeconfig (kind: Config), got kind: ${doc.kind}`);
  }

  const contextName = opts.contextName || doc['current-context'];
  if (!contextName) {
    const available = (doc.contexts || []).map(c => c.name).join(', ') || 'none';
    throw new KubeconfigError(`kubeconfig has no current-context; available contexts: ${available}`);
  }
  const context = byName(doc.contexts, contextName, 'context').context || {};

  const cluster = byName(doc.clusters, context.cluster, 'cluster').cluster || {};
  const user = byName(doc.users, context.user, 'user').user || {};

  return { doc, contextName, context, cluster, user };
}

/**
 * @param {string} text the uploaded YAML
 * @param {{contextName?: string}} [opts]
 * @returns {{apiUrl: string, caData: string|null, token: string, contextName: string,
 *            defaultNamespace: string|null}}
 */
function parseKubeconfig(text, opts = {}) {
  const { contextName, context, cluster, user } = resolveContext(text, opts);

  const apiUrl = String(cluster.server || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiUrl)) {
    throw new KubeconfigError(`cluster server must be an https URL (got ${JSON.stringify(cluster.server)})`);
  }

  if (cluster['insecure-skip-tls-verify']) {
    throw new KubeconfigError(
      'this kubeconfig sets insecure-skip-tls-verify; the dashboard will not talk to an unverified API server. ' +
      'Supply certificate-authority-data instead.'
    );
  }

  const caData = cluster['certificate-authority-data']
    ? decodeB64(cluster['certificate-authority-data'], 'certificate-authority-data')
    : null;
  if (cluster['certificate-authority'] && !caData) {
    throw new KubeconfigError(
      'this kubeconfig points at a CA file on disk (certificate-authority); that path does not exist in the ' +
      'dashboard pod. Re-export with certificate-authority-data inlined.'
    );
  }

  if (user.exec || user['auth-provider']) {
    const how = user.exec ? `exec (${(user.exec.command) || 'unknown command'})` : `auth-provider (${(user['auth-provider'].name) || 'unknown'})`;
    throw new KubeconfigError(
      `this kubeconfig authenticates via ${how}, which needs a helper binary the dashboard pod does not have. ` +
      'Upload a kubeconfig with a static token: kubectl create token <admin-sa> --duration=1h'
    );
  }
  if (user['client-certificate-data'] || user['client-certificate']) {
    throw new KubeconfigError(
      'this kubeconfig authenticates with a client certificate. That credential cannot be rotated by the ' +
      'TokenRequest chain the dashboard relies on. Upload a kubeconfig with a static token instead.'
    );
  }

  const token = user.token || (user['token-file'] ? null : null);
  if (!token) {
    throw new KubeconfigError('no token found for this context; the user entry must carry a `token:` value');
  }

  return {
    apiUrl,
    caData,
    token: String(token).trim(),
    contextName,
    defaultNamespace: context.namespace || null
  };
}

/**
 * Extracts the OIDC exec-plugin parameters from a kubeconfig's current-context user entry,
 * for Wave 2's server-side Authorization Code + PKCE flow. Deliberately separate from
 * parseKubeconfig: that function's refusal of exec/auth-provider users is still correct for
 * the plain-token path (no helper binary in this image) and must not change. This function
 * is the alternative path for the one exec shape we do understand — an OIDC login helper —
 * and it extracts structure only; it does not attempt auth, and it does not enforce the
 * issuer allowlist (that happens downstream in router.js, which has the actual policy).
 *
 * @param {string} text the uploaded YAML
 * @param {{contextName?: string}} [opts]
 * @returns {{execOidc: null} | {execOidc: {issuer: string, clientId: string,
 *            extraScopes: string[], apiUrl: string, caData: string|null, contextName: string}}}
 */
function extractExecOidcParams(text, opts = {}) {
  const { contextName, cluster, user } = resolveContext(text, opts);

  if (!user.exec) return { execOidc: null };

  const args = Array.isArray(user.exec.args) ? user.exec.args : [];
  let issuer = null;
  let clientId = null;
  const extraScopes = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = inlineValue !== undefined ? inlineValue : args[i + 1];
    if (flag === '--oidc-issuer-url') issuer = value;
    else if (flag === '--oidc-client-id') clientId = value;
    else if (flag === '--oidc-extra-scope') extraScopes.push(value);
  }

  // Not a recognisable OIDC login helper: don't guess, fall back to the token-paste path.
  if (!issuer || !clientId) return { execOidc: null };

  let parsedIssuer;
  try {
    parsedIssuer = new URL(String(issuer));
  } catch {
    throw new KubeconfigError(`exec plugin's --oidc-issuer-url is not a valid URL (got ${JSON.stringify(issuer)})`);
  }
  if (parsedIssuer.protocol !== 'https:') {
    throw new KubeconfigError(`exec plugin's --oidc-issuer-url must be https:// (got ${JSON.stringify(issuer)})`);
  }

  const apiUrl = String(cluster.server || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiUrl)) {
    throw new KubeconfigError(`cluster server must be an https URL (got ${JSON.stringify(cluster.server)})`);
  }
  if (cluster['insecure-skip-tls-verify']) {
    throw new KubeconfigError(
      'this kubeconfig sets insecure-skip-tls-verify; the dashboard will not talk to an unverified API server. ' +
      'Supply certificate-authority-data instead.'
    );
  }
  const caData = cluster['certificate-authority-data']
    ? decodeB64(cluster['certificate-authority-data'], 'certificate-authority-data')
    : null;
  if (cluster['certificate-authority'] && !caData) {
    throw new KubeconfigError(
      'this kubeconfig points at a CA file on disk (certificate-authority); that path does not exist in the ' +
      'dashboard pod. Re-export with certificate-authority-data inlined.'
    );
  }

  return {
    execOidc: {
      issuer: String(issuer),
      clientId: String(clientId),
      extraScopes,
      apiUrl,
      caData,
      contextName
    }
  };
}

/**
 * Read the *endpoint* facts out of a kubeconfig and name the credential it carries,
 * without judging that credential.
 *
 * This is the third reader of the same file and the only one that does not refuse. The
 * reason it exists: an operator holding an SSO/exec kubeconfig and a separately minted
 * service-account token has everything the dashboard needs — the file supplies the API
 * server and its CA, the pasted token supplies the credential — but neither existing
 * function will say so. `parseKubeconfig` rejects the whole file on sight of `exec`, and
 * `extractExecOidcParams` answers only for the one exec shape it recognises. Both
 * refusals are still correct for their own paths and are untouched.
 *
 * What it still refuses is anything that makes the *endpoint* unusable — a non-https
 * server, `insecure-skip-tls-verify`, a CA path that does not exist in this pod. Those
 * are not credential opinions; they are the difference between a cluster that can be
 * reached safely and one that cannot.
 *
 * **No credential is returned.** `hasStaticToken` says whether one is in the file;
 * the value stays here. This function's output is shaped to be safe to hand to a browser
 * as a preview, and a token echoed back into a page is a token in a screenshot.
 *
 * @param {string} text the uploaded YAML
 * @param {{contextName?: string}} [opts]
 * @returns {{apiUrl: string, caData: string|null, contextName: string, contexts: string[],
 *            defaultNamespace: string|null, credential: string, hasStaticToken: boolean,
 *            execOidc: {issuer: string, clientId: string}|null}}
 */
function describeKubeconfig(text, opts = {}) {
  const { doc, contextName, context, cluster, user } = resolveContext(text, opts);

  const apiUrl = String(cluster.server || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiUrl)) {
    throw new KubeconfigError(`cluster server must be an https URL (got ${JSON.stringify(cluster.server)})`);
  }
  if (cluster['insecure-skip-tls-verify']) {
    throw new KubeconfigError(
      'this kubeconfig sets insecure-skip-tls-verify; the dashboard will not talk to an unverified API server. ' +
      'Supply certificate-authority-data instead.'
    );
  }
  const caData = cluster['certificate-authority-data']
    ? decodeB64(cluster['certificate-authority-data'], 'certificate-authority-data')
    : null;
  if (cluster['certificate-authority'] && !caData) {
    throw new KubeconfigError(
      'this kubeconfig points at a CA file on disk (certificate-authority); that path does not exist in the ' +
      'dashboard pod. Re-export with certificate-authority-data inlined.'
    );
  }

  // Which credential the file carries, named rather than rejected, so the page can tell the
  // operator what to do about it. `exec-oidc` is split out from plain `exec` because it is
  // the one the bootstrap flow can drive on its own.
  const oidc = user.exec ? extractExecOidcParams(text, opts).execOidc : null;
  const hasStaticToken = typeof user.token === 'string' && user.token.trim().length > 0;
  let credential = 'none';
  if (hasStaticToken) credential = 'token';
  else if (oidc) credential = 'exec-oidc';
  else if (user.exec) credential = 'exec';
  else if (user['auth-provider']) credential = 'auth-provider';
  else if (user['client-certificate-data'] || user['client-certificate']) credential = 'client-certificate';

  return {
    apiUrl,
    caData,
    contextName,
    contexts: (doc.contexts || []).map(c => c && c.name).filter(Boolean),
    defaultNamespace: context.namespace || null,
    credential,
    hasStaticToken,
    execOidc: oidc ? { issuer: oidc.issuer, clientId: oidc.clientId } : null
  };
}

/** Cluster ids become filenames and URL segments, so they are constrained, not free text. */
function toClusterId(name) {
  const id = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!ID_PATTERN.test(id)) {
    throw new KubeconfigError(
      `"${name}" does not reduce to a usable cluster id. Use letters, digits and hyphens, e.g. "platform-dev".`
    );
  }
  return id;
}

export default { parseKubeconfig, describeKubeconfig, extractExecOidcParams, toClusterId, KubeconfigError };
