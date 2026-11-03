import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getLogger } from '../logger.js';

/**
 * App-wide authentication, selected by AUTH_MODE:
 *
 *   none  pass every request through untouched. The default outside production, and refused
 *         in production by assertAuthAllowed (server/fleet/mount.js).
 *   oidc  verify `Authorization: Bearer <jwt>` against the issuer's JWKS (OIDC_JWKS_URL,
 *         required), checking OIDC_ISSUER and OIDC_AUDIENCE when they are set, and require
 *         membership of ALLOWED_GROUPS (comma-separated group names) when that is set. The
 *         default in production.
 *
 * A verified caller leaves `{ email, groups }` on `req.user`; server/fleet/auth.js maps that
 * onto the fleet's own user shape. `/api/health` always passes so probes need no token.
 */

/** The effective mode for an environment. Anything but `none` is treated as `oidc`. */
export function authMode(env = process.env) {
  const explicit = String(env.AUTH_MODE || '').trim().toLowerCase();
  if (explicit) return explicit === 'none' ? 'none' : 'oidc';
  return env.NODE_ENV === 'production' ? 'oidc' : 'none';
}

/** Group names from a comma-separated env value, trimmed and deduplicated. */
function parseAllowed(raw) {
  return [...new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean))];
}

/**
 * @param {{env?: object, jwks?: Function}} [opts] `jwks` overrides the remote key set (tests)
 * @returns {import('express').RequestHandler}
 */
export function createOidcAuth(opts = {}) {
  const env = opts.env || process.env;
  if (authMode(env) === 'none') return (_req, _res, next) => next();

  const jwksUrl = env.OIDC_JWKS_URL;
  // Built once per middleware: jose caches the fetched keys inside the key set.
  const jwks = opts.jwks || (jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null);
  const verifyOptions = {};
  if (env.OIDC_ISSUER) verifyOptions.issuer = env.OIDC_ISSUER;
  if (env.OIDC_AUDIENCE) verifyOptions.audience = env.OIDC_AUDIENCE;
  const allowedGroups = parseAllowed(env.ALLOWED_GROUPS);

  return async function oidcAuth(req, res, next) {
    const log = getLogger();

    // Health probe must always pass
    if (req.path === '/api/health') return next();

    // assertAuthAllowed refuses to start like this; this is the second line, and it fails closed.
    if (!jwks) {
      log.error('AUTH_MODE=oidc but OIDC_JWKS_URL is not set; refusing the request');
      return res.status(503).json({ error: 'Authentication is not configured' });
    }

    const authHeader = req.headers['authorization'];
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      log.warn({ path: req.path }, 'auth token missing');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, verifyOptions));
    } catch (err) {
      log.warn({ path: req.path, error: err.message }, 'JWT verification failed');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userGroups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
    if (allowedGroups.length && !userGroups.some(g => allowedGroups.includes(g))) {
      log.warn({ path: req.path, sub: payload.sub, userGroups, allowedGroups }, 'user not in allowed groups');
      return res.status(403).json({ error: 'Forbidden' });
    }

    log.debug({ path: req.path, email: payload.email ?? payload.sub }, 'auth passed');
    req.user = { email: payload.email ?? payload.sub, groups: userGroups };
    next();
  };
}

/** The app-wide middleware, configured from process.env at import. */
export const oidcAuth = createOidcAuth();
