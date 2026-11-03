/**
 * Onboarding a cluster from a pasted service-account token.
 *
 * The operator has already run, against the target cluster:
 *
 *   kubectl apply -f fleet-dashboard-rbac.yaml
 *   kubectl create token fleet-reader -n fleet-dashboard --duration=24h
 *
 * ...and pastes what the second command printed. No admin credential ever reaches this
 * application, which is the whole reason this path exists alongside the kubeconfig upload.
 *
 * "Process it from there" means four things, in order, each of which turns something the
 * operator would otherwise have to type into something read off the token itself:
 *
 *   1. decode   — the namespace, the service-account name and the real expiry come out of
 *                 the token's own claims. Asking for them again would be asking the
 *                 operator to re-type facts we already hold, and to be believed when they
 *                 get one wrong.
 *   2. verify   — the token is used once, against the target cluster, to prove it
 *                 authenticates and can read. A token that cannot list namespaces fails
 *                 here, while the operator is still looking at the dialog.
 *   3. selfmint — we immediately mint the *successor* and keep that instead. This proves
 *                 the renewal chain turns before the cluster is registered, rather than
 *                 twelve hours later at 3am. If it fails the cluster is still onboarded,
 *                 with a loud warning, because read-only monitoring of a cluster whose
 *                 chain needs fixing is more useful than no monitoring.
 *   4. describe — the Kubernetes version, so the UI has something true to show at once.
 *
 * The decoder deliberately does NOT verify the token's signature. It cannot: the signing
 * key belongs to the target cluster's API server. Nothing here trusts a claim — step 2 is
 * what establishes that the token is real, and the claims are only used to fill in fields
 * the operator would otherwise supply by hand. A forged token with flattering claims still
 * fails step 2.
 */
import k8sModule from './k8s.js';
const { call } = k8sModule;
import errorsModule from './errors.js';
const { ClusterError } = errorsModule;
import onboardModule from './onboard.js';
const { FLEET_NAMESPACE, FLEET_SA, FIRST_TOKEN_SECONDS } = onboardModule;

/**
 * A pasted token that is not usable, for a reason the operator can fix in the dialog.
 *
 * Mirrors KubeconfigError: a 400 with a message written for whoever is holding the
 * clipboard, never a stack trace and never the token itself.
 */
class SaTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SaTokenError';
    this.code = 'BAD_SA_TOKEN';
    this.status = 400;
  }
}

/** A pasted token longer than this is not a token. */
const MAX_TOKEN_BYTES = 8192;
/** The `sub` claim of a projected service-account token. */
const SUBJECT_PATTERN = /^system:serviceaccount:([a-z0-9][a-z0-9-]{0,62}):([a-z0-9][a-z0-9.-]{0,252})$/;

/**
 * Read what a service-account token says about itself.
 *
 * Structural checks only — three dot-separated segments, decodable middle, the claims a
 * Kubernetes SA token always carries. Anything that fails is rejected with a message about
 * what was pasted rather than about JWTs, because the mistake this catches most often is
 * pasting a kubeconfig, a URL, or the whole `kubectl` command line.
 *
 * @param {string} raw
 * @returns {{namespace: string, serviceAccount: string, expiresAt: string|null,
 *            issuedAt: string|null, issuer: string|null, audiences: string[]}}
 */
function decode(raw) {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) throw new SaTokenError('a service-account token is required');
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw new SaTokenError(`that is ${Buffer.byteLength(token, 'utf8')} bytes; a service-account token is under ${MAX_TOKEN_BYTES}`);
  }
  // Checked before the whitespace complaint, because a kubeconfig is full of whitespace
  // and "paste only the token" is unhelpful advice for someone who pasted the wrong file
  // into the wrong tab. Name what they pasted and where it goes instead.
  if (/^\s*(apiVersion|kind|clusters|contexts|current-context)\s*:/m.test(token)) {
    throw new SaTokenError('that is a kubeconfig, not a token — use the kubeconfig tab, or paste the output of `kubectl create token`');
  }
  if (/\s/.test(token)) {
    throw new SaTokenError('the token contains whitespace — paste only the token, not the command that printed it');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new SaTokenError(`expected a JWT with three segments, got ${parts.length} — is this a kubeconfig rather than a token?`);
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (err) {
    throw new SaTokenError(`the token's claims are not readable: ${err.message}`);
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  const match = SUBJECT_PATTERN.exec(subject);
  if (!match) {
    throw new SaTokenError(`this token belongs to ${subject ? JSON.stringify(subject) : 'no service account'}; a fleet token must be a service-account token (system:serviceaccount:<namespace>:<name>)`);
  }

  // A token with no `exp` is a legacy, non-expiring one. Those exist, and accepting one
  // silently would put a permanent credential in the Secret under the pretence of a
  // 24-hour chain. Refuse it and say which command produces the right thing.
  if (claims.exp === undefined || claims.exp === null) {
    throw new SaTokenError(`this token never expires, which is not something the fleet will store — mint a bounded one: kubectl create token ${match[2]} -n ${match[1]} --duration=24h`);
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new SaTokenError('the token has an unreadable expiry');
  }

  return {
    namespace: match[1],
    serviceAccount: match[2],
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    issuedAt: typeof claims.iat === 'number' ? new Date(claims.iat * 1000).toISOString() : null,
    issuer: typeof claims.iss === 'string' ? claims.iss : null,
    // Kept for the warning below rather than for any decision. A token minted with a
    // custom audience is rejected as a bearer, which is a 401 that looks like a typo.
    audiences: Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === 'string' ? [claims.aud] : []
  };
}

/**
 * Take a pasted token and produce the token the fleet will actually store.
 *
 * @param {object} args
 * @param {import('./registry').Cluster} args.cluster  candidate record; apiUrl and caData set
 * @param {string} args.token          the pasted token
 * @param {object} args.claims         the output of decode()
 * @param {(step: object) => void} [args.onStep]
 * @param {typeof call} [args.callFn]  injection seam
 * @returns {Promise<{token: string, expiresAt: string, renewable: boolean,
 *                    steps: object[], kubernetesVersion: string|null}>}
 */
async function adopt({ cluster, token, claims, onStep, callFn = call }) {
  const steps = [];
  const record = (id, detail, level = 'ok') => {
    const step = { id, detail, level };
    steps.push(step);
    if (onStep) onStep(step);
  };

  record('decode', `token belongs to ${claims.namespace}/${claims.serviceAccount}, expires ${claims.expiresAt}`);
  if (claims.audiences.length > 0) {
    record(
      'audience',
      `the token carries audiences [${claims.audiences.join(', ')}]; a token minted with a custom audience is rejected as a bearer`,
      'warn'
    );
  }

  // 2. Prove it. This is the only check that establishes anything — everything above is
  //    the token describing itself.
  await callFn({ cluster, token, path: '/api/v1/namespaces?limit=1' });
  record('verify', 'the token authenticates and can list namespaces');

  const version = await callFn({ cluster, token, path: '/version', timeoutMs: 10000 });
  record('version', `Kubernetes ${version.gitVersion || 'unknown'}`);

  // 3. Mint the successor now, and store that rather than what was pasted. Two reasons:
  //    the pasted token stops being the one in use, and a chain that cannot turn is
  //    discovered here instead of at the first renewal.
  let stored = { token, expiresAt: claims.expiresAt };
  let renewable = false;
  try {
    const minted = await callFn({
      cluster, token,
      path: `/api/v1/namespaces/${claims.namespace}/serviceaccounts/${claims.serviceAccount}/token`,
      method: 'POST',
      body: {
        apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
        // No `audiences`. See mint.js.
        spec: { expirationSeconds: FIRST_TOKEN_SECONDS }
      }
    });
    const t = minted && minted.status && minted.status.token;
    const e = minted && minted.status && minted.status.expirationTimestamp;
    if (!t || !e) throw new Error('TokenRequest succeeded but returned no token');
    stored = { token: t, expiresAt: e };
    renewable = true;
    record('selfmint', `renewal chain verified — minted a successor expiring ${e}, and stored that instead of what you pasted`);
  } catch (err) {
    const how = err instanceof ClusterError && err.status === 403 ? 'forbidden' : err.message;
    record(
      'selfmint',
      `this token cannot mint its successor (${how}) — the cluster will be monitored until ${claims.expiresAt} and then go dark. ` +
      `Fix by applying fleet-dashboard-rbac.yaml to grant ${claims.serviceAccount} create on serviceaccounts/token`,
      'warn'
    );
  }

  return { ...stored, renewable, steps, kubernetesVersion: version.gitVersion || null };
}

export default { decode, adopt, SaTokenError, MAX_TOKEN_BYTES, FLEET_NAMESPACE, FLEET_SA };
