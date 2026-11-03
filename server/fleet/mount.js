/**
 * Mounts the Kubernetes Fleet Dashboard's REST API, /api/fleet, on the template's Express app.
 *
 * What the fleet code needs from the pod, and nothing more:
 *   - the projected token mount at FLEET_TOKENS_PATH (read-only)
 *   - the projected onboarded-cluster mount at FLEET_CLUSTERS_DIR (read-only)
 *   - a service account able to `get`/`patch` those two Secrets by name
 *   - FLEET_CLUSTERS_FILE pointing at the baked cluster registry (defaults to ./clusters.json)
 *
 * A failure to configure the fleet degrades /api/fleet and nothing else: a bad cluster
 * registry must not stop the template's own routes from serving.
 */
import express from 'express';
import { getLogger } from '../logger.js';
import registryModule from './registry.js';
const { Registry } = registryModule;
import tokensModule from './tokens.js';
const { TokenStore } = tokensModule;
import secretWriterModule from './secret-writer.js';
const { SecretTokenWriter } = secretWriterModule;
import fleetRouter from './router.js';
import renewerModule from './renewer.js';
const { Renewer } = renewerModule;
import authModule from './auth.js';
const { createAuth } = authModule;
import jsonBoundary from './json-boundary.js';
import redisStoreModule from './redis-store.js';
const { fleetStore } = redisStoreModule;
import { authMode } from '../middleware/oidcAuth.js';

const FLEET_MOUNT = fleetRouter.MOUNT_PATH;
const MAX_KUBECONFIG_BYTES = fleetRouter.MAX_KUBECONFIG_BYTES;

/**
 * A misconfigured NODE_ENV must not be the only thing standing between the fleet and an
 * unauthenticated API. Throws; the caller decides whether that is fatal.
 *
 * Refused: either switch that turns authentication off in production, and an oidc mode with
 * no key set to verify against — oidcAuth would then refuse every request, which is safe but
 * is a deployment that cannot work and should say so at start rather than per request.
 */
export function assertAuthAllowed(env = process.env) {
  if (env.NODE_ENV === 'production' && env.FLEET_AUTH === 'none') {
    throw new Error('FLEET_AUTH=none is not permitted when NODE_ENV=production');
  }
  if (env.NODE_ENV === 'production' && authMode(env) === 'none') {
    throw new Error('AUTH_MODE=none is not permitted when NODE_ENV=production');
  }
  if (authMode(env) === 'oidc' && !env.OIDC_JWKS_URL) {
    throw new Error('AUTH_MODE=oidc requires OIDC_JWKS_URL');
  }
}

/**
 * Fleet auth is off exactly when oidcAuth is (AUTH_MODE=none, the default outside production),
 * or when FLEET_AUTH=none says so explicitly. assertAuthAllowed refuses both in production.
 */
export function fleetAuthDisabled(env = process.env) {
  return env.FLEET_AUTH === 'none' || authMode(env) === 'none';
}

// There is one data path and it is the real one: the collectors reach real clusters through
// the real k8s client, and no environment variable changes that. Fixtures live under
// __tests__ and nothing but a test loads them — enforced by __tests__/no-fixture-path.test.js.

export function mountFleet(app, opts = {}) {
  const log = getLogger();
  const authDisabled = fleetAuthDisabled();
  if (opts.db) {
    fleetStore.bindDb(opts.db);
  }

  /** Everything below reports through this, so a disabled fleet always says why. */
  const disable = (reason, message) => {
    log.error(`[fleet] DISABLED - ${reason}`);
    app.use(FLEET_MOUNT, (_req, res) => res.status(503).json({ code: 'FLEET_UNCONFIGURED', message }));
  };

  let registry;
  try {
    registry = new Registry();
  } catch (err) {
    return disable(`cluster registry unusable: ${err.message}`, `cluster registry unusable: ${err.message}`);
  }

  const tokens = new TokenStore();

  // Both writers are optional, and their absence degrades precisely one feature each:
  // no tokenWriter means no "Renew now", no clusterWriter means no "Add cluster". The
  // read-only dashboard works fully without either.
  let tokenWriter = null;
  let clusterWriter = null;
  if (process.env.FLEET_ALLOW_MANUAL_RENEW !== 'false') {
    try {
      tokenWriter = new SecretTokenWriter({
        secretName: process.env.FLEET_TOKENS_SECRET || 'fleet-dashboard-tokens'
      });
    } catch (err) {
      log.warn(`[fleet] manual renewal disabled: ${err.message}`);
    }
  }
  if (process.env.FLEET_ALLOW_ONBOARD !== 'false') {
    try {
      clusterWriter = new SecretTokenWriter({
        secretName: process.env.FLEET_CLUSTERS_SECRET || 'fleet-dashboard-clusters'
      });
    } catch (err) {
      log.warn(`[fleet] cluster onboarding disabled: ${err.message}`);
    }
  }

  // Identity comes from oidcAuth, mounted app-wide in server/index.js. This only maps it
  // onto the fleet's user shape and decides who may write (FLEET_ADMIN_GROUPS).
  const auth = createAuth({ disabled: authDisabled });

  // The renewal clock. It needs the token writer and nothing else, so a deployment that
  // cannot write the Secret simply has no clock - the dashboard still reads every cluster
  // until the tokens it was given run out, and says so on the Token Health page.
  let renewer = null;
  if (tokenWriter && process.env.FLEET_RENEW_IN_PROCESS !== 'false') {
    renewer = new Renewer({ registry, writer: tokenWriter }).start();
    // A pod being shut down should not start a sweep it cannot finish.
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => renewer.stop());
  } else if (!tokenWriter) {
    log.warn('[fleet] no token writer: automatic renewal is OFF; tokens will expire as given');
  }

  app.use(
    FLEET_MOUNT,
    // Scoped to this mount. Twice MAX_KUBECONFIG_BYTES (fleet/router.js), not a bare number:
    // an oversized-but-plausible kubeconfig upload should get the router's own specific
    // "that is not a kubeconfig" 413 rather than the generic one registered below, and
    // deriving this from the router's constant means the two cannot silently drift apart -
    // a smaller limit here would make the router's own check unreachable for anything
    // between the two.
    express.json({ limit: 2 * MAX_KUBECONFIG_BYTES }),
    auth,
    // No transport overrides: the collectors reach real clusters through the real k8s
    // client, and there is no switch that changes that.
    fleetRouter.createRouter({ registry, tokens, tokenWriter, clusterWriter, renewer })
  );

  // Everything under this mount answers JSON, matched route or not - an HTML 404 or an HTML
  // 413 from Express's own handlers is indistinguishable, to this API's browser client, from
  // the proxy's SSO login page. Shared with fleet/dev-server.js so the dev harness
  // reproduces production behaviour rather than diverging from it.
  jsonBoundary.mountJsonBoundary(app, FLEET_MOUNT);

  log.info(`[fleet] ${FLEET_MOUNT} mounted; auth: ${authDisabled ? 'DISABLED (development)' : 'oidc (FLEET_ADMIN_GROUPS gates writes)'}`);
  log.info(`[fleet] writers: renew=${Boolean(tokenWriter)} onboard=${Boolean(clusterWriter)} rollout=${process.env.FLEET_ALLOW_ROLLOUT !== 'false'}`);
  log.info(`[fleet] automatic renewal: ${renewer ? 'in-process' : 'OFF'}`);
  log.info(`[fleet] clusters: ${registry.all().map(c => `${c.id}${c.enabled ? '' : ' (disabled)'}`).join(', ') || 'none'}`);
  return { registry };
}

export default { mountFleet, assertAuthAllowed, fleetAuthDisabled };
