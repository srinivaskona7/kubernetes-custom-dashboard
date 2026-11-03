/**
 * Authentication: map the identity shieldAuth verified onto the fleet's own user shape.
 *
 * shieldAuth (server/middleware/shieldAuth.js) is mounted app-wide: it verifies the Shield
 * OIDC JWT and checks membership of ALLOWED_GROUPS before a request reaches /api/fleet, and
 * it leaves `{ email, groups }` on `req.user`. This middleware does not verify anything a
 * second time. It turns that identity into the `{ id, email, scopes }` the router reads, and
 * it is where "who may change the fleet" is decided:
 *
 *   - every caller shieldAuth let through may read;
 *   - members of FLEET_ADMIN_GROUPS (comma-separated numeric group ids, parsed like
 *     ALLOWED_GROUPS) additionally carry the admin scope, which gates onboard, remove and
 *     renew in router.js. With FLEET_ADMIN_GROUPS unset nobody is an admin: the fail-closed
 *     direction for an API that writes cluster credentials.
 *
 * Outside production shieldAuth is bypassed, and so is this: the caller is a fixed local
 * development identity with the admin scope. FLEET_AUTH=none selects the same identity
 * explicitly, and the server refuses to start with it in production (see server/index.js).
 */
export const SCOPE = 'kyma-fleet-admin';

/** Numeric group ids from a comma-separated env value; anything non-numeric is dropped. */
export function parseGroups(raw) {
  const ids = String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(n => !Number.isNaN(n));
  return [...new Set(ids)];
}

/**
 * The caller's identity, or `null` when shieldAuth left none.
 *
 * Never a placeholder string. `router.js` widens its OIDC cache key by this value as soon as
 * the fleet holds an OIDC cluster, and a fallback like `'unknown'` would fold every caller
 * whose token lacks an identity into one shared cache slot — one of them could then be served
 * another's cached OIDC credential or result. `null` is not cacheable under, which is the
 * point: the middleware refuses instead of caching under a name that isn't one.
 *
 * @param {{email?: string} | undefined} user the `req.user` shieldAuth set
 * @returns {string | null}
 */
export function identityOf(user) {
  return (user && typeof user.email === 'string' && user.email) || null;
}

/**
 * @param {{disabled?: boolean, env?: object}} [opts]
 * @returns {import('express').RequestHandler}
 */
export function createAuth(opts = {}) {
  if (opts.disabled) {
    return (req, _res, next) => {
      req.user = { id: 'local-dev', name: 'local development', scopes: [SCOPE] };
      next();
    };
  }

  const env = opts.env || process.env;

  return (req, res, next) => {
    const id = identityOf(req.user);
    if (!id) {
      // Refuse rather than cache under a placeholder: a caller this middleware cannot pin to
      // an identity is treated as one it does not trust.
      return res.status(401).json({
        code: 'UNRESOLVED_IDENTITY',
        message: 'the token validated but carries no email or subject to identify the caller'
      });
    }

    const groups = Array.isArray(req.user.groups) ? req.user.groups : [];
    const rawAdminGroups = env.FLEET_ADMIN_GROUPS !== undefined ? env.FLEET_ADMIN_GROUPS : env.ALLOWED_GROUPS;
    const adminGroups = parseGroups(rawAdminGroups);
    const admin = groups.some(g => adminGroups.includes(g));

    req.user = { id, email: req.user.email, scopes: admin ? [SCOPE] : [] };
    next();
  };
}

export default { createAuth, SCOPE, parseGroups, identityOf };
