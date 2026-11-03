/**
 * Minting a service-account token, shared by the CronJob and the "Renew now" button.
 *
 * There is exactly one implementation of the renewal step, and both callers use it. If
 * the button and the job could drift apart, the button would be a lie — it would report
 * success against a code path the scheduled renewal never takes.
 *
 * Verified against platformsbx on 2026-08-31: a 24h TokenRequest is granted in full
 * (Gardener clamps maxTokenExpiration to [30d,90d], so 24h can never be truncated), and
 * a token minted with a custom `audiences` value is rejected with 401 when used as a
 * bearer. Hence: never send `audiences`.
 */
import k8sModule from './k8s.js';
const { call } = k8sModule;

const TWENTY_FOUR_HOURS_S = 24 * 60 * 60;

/**
 * Mint a fresh token for a cluster's fleet-reader service account, authenticating with
 * that cluster's current token.
 *
 * @param {object} args
 * @param {import('./registry').Cluster} args.cluster
 * @param {string} args.currentToken  the token being replaced; it authenticates the call
 * @param {number} [args.expirationSeconds]
 * @returns {Promise<{token: string, expiresAt: string}>}
 */
async function mint({ cluster, currentToken, expirationSeconds = TWENTY_FOUR_HOURS_S }) {
  const path =
    `/api/v1/namespaces/${cluster.namespace}` +
    `/serviceaccounts/${cluster.serviceAccount}/token`;

  const body = await call({
    cluster,
    token: currentToken,
    path,
    method: 'POST',
    body: {
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenRequest',
      // No `audiences`. Setting one produces a token the API server will not accept as a
      // bearer — a confusing 401 on a token that was minted successfully.
      spec: { expirationSeconds }
    }
  });

  const token = body && body.status && body.status.token;
  const expiresAt = body && body.status && body.status.expirationTimestamp;
  if (!token || !expiresAt) {
    throw new Error(`${cluster.id}: TokenRequest succeeded but returned no token`);
  }

  // Trust the server's expiry, never the requested duration. Costs nothing, and makes a
  // differently-configured cluster visible instead of silently fatal twelve hours later.
  return { token, expiresAt };
}

export default { mint, TWENTY_FOUR_HOURS_S };
