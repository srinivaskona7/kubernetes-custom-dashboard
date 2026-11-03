/**
 * Typed errors for everything that can go wrong talking to a cluster API server.
 *
 * The 401/403 split is the important one, and it is not cosmetic — it was measured
 * against the platformsbx cluster on 2026-08-31:
 *
 *   token minted with a custom `audiences` value, used as a bearer  -> 401
 *   token with the default audience, but lacking RBAC for the verb  -> 403
 *
 * They demand opposite responses. A 401 means the stored token is no longer a valid
 * credential and the renewal chain is broken: a human must re-seed it. A 403 means the
 * token authenticated perfectly and the cluster's RBAC bundle is missing a rule — no
 * amount of re-seeding will help. Collapsing both into "auth error" would send whoever
 * is on call down the wrong path, so they stay distinct all the way to the UI.
 */

/** The token was rejected. The chain is broken; only a re-seed fixes this. */
const UNAUTHENTICATED = 'UNAUTHENTICATED';
/** The token is fine but RBAC denies the verb. Fix the ClusterRole, not the token. */
const FORBIDDEN = 'FORBIDDEN';
/** No token stored for this cluster yet — it has never been seeded. */
const UNSEEDED = 'UNSEEDED';
/** The stored token's expiry has passed. Distinct from UNAUTHENTICATED: we knew first. */
const EXPIRED = 'EXPIRED';
/** Network-level failure: DNS, TLS, connection refused, timeout. */
const UNREACHABLE = 'UNREACHABLE';
/** The API server answered, but not in a way we can use. */
const UPSTREAM = 'UPSTREAM';
/**
 * The cluster answered fine; the specific object asked for is not there.
 *
 * Distinct from UPSTREAM because it is not a fault: a stale bookmark to a Deployment that
 * has since been deleted must read "gone", not "cluster unreachable". Without its own code
 * `failed()` flattens it to UPSTREAM and the UI blames the cluster for a dead link.
 */
const NOT_FOUND = 'NOT_FOUND';

class ClusterError extends Error {
  /**
   * @param {string} code one of the constants above
   * @param {string} message human-readable, safe to show in the UI
   * @param {{cluster?: string, status?: number, cause?: unknown}} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ClusterError';
    this.code = code;
    this.cluster = detail.cluster;
    this.status = detail.status;
    if (detail.cause !== undefined) this.cause = detail.cause;
  }

  /** True when a human must mint a new token by hand before this cluster works again. */
  get needsReseed() {
    return this.code === UNAUTHENTICATED || this.code === EXPIRED || this.code === UNSEEDED;
  }

  /** Shape sent to the browser. Never includes a token or a stack. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      cluster: this.cluster,
      status: this.status,
      needsReseed: this.needsReseed
    };
  }
}

/** Map an HTTP status from a cluster API server onto a ClusterError code. */
function codeForStatus(status) {
  if (status === 401) return UNAUTHENTICATED;
  if (status === 403) return FORBIDDEN;
  return UPSTREAM;
}

export default {
  ClusterError,
  codeForStatus,
  UNAUTHENTICATED,
  FORBIDDEN,
  UNSEEDED,
  EXPIRED,
  UNREACHABLE,
  UPSTREAM,
  NOT_FOUND
};
