
/**
 * The JSON boundary for the fleet API mount.
 *
 * Everything under `/api/fleet` must answer JSON, matched route or not. Express's default
 * 404 page and its default error handler both send `text/html`, and to this API's own
 * browser client an HTML body at HTTP 200 is indistinguishable from the proxy's SSO
 * login page — a lapsed SSO session returns that login page at 200, not 401, so
 * `app/fleet-ui/src/api.ts` has to classify on body shape. It now gates that on the status
 * too (HTML is treated as the login bootstrap only at 200 or 3xx), which is what stops an
 * HTML 413 or 404 from reading as "your session lapsed" and triggering a reload the operator
 * cannot escape. That client-side gate and this server-side handler are belt and braces:
 * this one stops srv emitting HTML at all, that one stops the client trusting it never will.
 * Neither alone is sufficient — the proxy tier and any future middleware can still emit
 * HTML on paths this mount does not own.
 *
 * These two handlers live here rather than inline in server/index.js because
 * server/fleet/dev-server.js is a second, independent entry point that mounts the same router.
 * When the two diverged, `npm run fleet:dev` served HTML 404s while production served JSON —
 * so the harness used to verify the fix did not reproduce the thing being fixed. One
 * implementation, mounted by both, is the only way that stays true.
 *
 * Mount order matters: `notFound` after the router, `errors` after that, both scoped to the
 * mount path so the the proxy's real HTML on other paths is untouched.
 */
import { getLogger } from '../logger.js';

/**
 * Answers any unmatched path under the mount with a typed JSON 404.
 *
 * The router falls through with a plain `next()` when nothing matches, exactly as any
 * Express Router does; without this the request reaches Express's finalhandler.
 */
function notFound(_mountPath) {
  return (req, res) => {
    res.status(404).json({
      code: 'NOT_FOUND',
      message: `no such fleet route: ${req.method} ${req.originalUrl || req.path}`
    });
  };
}

/**
 * A JSON backstop for anything reaching `next(err)` without the router's own error handler
 * seeing it — chiefly `express.json()` rejecting an oversized or malformed body, which
 * happens *before* the router is entered because the body parser is mounted as its sibling.
 *
 * Follows the router's own convention: log the stack server-side, send only the message, so
 * an internal path never reaches the browser.
 */
function errors(mountPath) {
  return (err, req, res, _next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({
        code: 'TOO_LARGE',
        message: `request body exceeds the ${err.limit}-byte limit for ${mountPath}`
      });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ code: 'BAD_JSON', message: 'request body is not valid JSON' });
    }
    const status = (err && err.status) || 500;
    getLogger().error(
      `[fleet-error] [${req.method} ${req.originalUrl || req.path}] status=${status}: ${(err && err.stack) || err}`
    );
    res.status(status).json({
      code: (err && err.code) || 'INTERNAL',
      message: (err && err.message) || 'internal error'
    });
  };
}

/**
 * Mount both, in the one correct order, on an app that has already mounted the fleet router.
 */
function mountJsonBoundary(app, mountPath) {
  app.use(mountPath, notFound(mountPath));
  app.use(mountPath, errors(mountPath));
}

export default { notFound, errors, mountJsonBoundary };
