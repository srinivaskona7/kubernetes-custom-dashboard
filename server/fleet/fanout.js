/**
 * Fan-out across the fleet, and the cache in front of it.
 *
 * Two rules govern everything here:
 *
 *  1. One cluster's failure never fails the response. A fleet dashboard that goes blank
 *     because the least important cluster timed out is worse than no dashboard — the
 *     whole point is to see which cluster is broken.
 *  2. Nothing is called without a token. An unseeded or expired cluster is reported as
 *     such from local state, without a doomed network round trip.
 */
import errorsModule from './errors.js';
const { ClusterError, UNSEEDED, EXPIRED } = errorsModule;

/** How long a collected result stays fresh. A full sweep is dozens of API calls. */
const DEFAULT_TTL_MS = 30_000;

/**
 * How long past expiry an entry may still be *served* while its replacement is collected
 * behind it.
 *
 * ## Why this exists — the measurement, not a preference
 *
 * The sidebar polls `GET /summary` every 30 s and `GET /clusters` every 30 s, and the TTL
 * above is also 30 s. Those two numbers being equal is the whole defect: every poll landed
 * on a key that had expired a moment earlier, so **every poll was a miss by construction**
 * and paid the full cluster cost. Measured in the browser against a real cluster, one
 * poll cycle: `/summary` 4.8s / 5.5s / 5.2s / 5.4s, `/clusters` 1.4s / 1.9s / 3.9s / 2.9s.
 * The cache never once returned a hit to the thing that reads it most.
 *
 * That is also why *every other* tab felt slow. A five-second sweep holds the per-cluster
 * gate; a tab clicked inside that window queues behind it rather than reading. The console
 * was, in effect, never idle.
 *
 * Serving the stale entry and refreshing behind it takes that five seconds off the request
 * path entirely. The operator's read is a map lookup; the collection still happens, just not
 * while anyone waits for it.
 *
 * ## What it costs, stated plainly
 *
 * Data may be up to `ttlMs + staleMs` old instead of `ttlMs`. That is a real cost and it is
 * paid honestly rather than hidden: `wrap` reports the entry's **true** collection time
 * through `onServed`, and the router stamps `collectedAt` from that instead of from
 * `Date.now()`. So the Freshness column and "collected 40s ago" now describe the read that
 * actually produced the numbers. Before this change that timestamp was generated at response
 * time over an up-to-30s-old body — it was already optimistic, and by up to a full TTL.
 *
 * ## The one thing that must not happen
 *
 * A stale entry must never outlive a cluster going wrong. If the background refresh
 * *fails*, the entry is evicted rather than kept — the next read is a true cold read that
 * surfaces the real error. Stale data is only ever served while the cluster is still
 * answering; the moment it stops, this stops.
 */
const DEFAULT_STALE_MS = 60_000;

/**
 * A long-lived pod fields requests for many cluster/namespace combinations, and the key
 * space (`wl:${cluster}:${ns}`, `net:${cluster}:${ns}`, ...) is unbounded in practice.
 * Without a cap the map only grows. 500 is generous for a fleet of the size this
 * dashboard targets, while still being a hard ceiling instead of "whatever memory allows."
 */
const DEFAULT_MAX_ENTRIES = 500;

class Cache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]   how long an entry is fresh
   * @param {number} [opts.staleMs] how long past that it may be served while refreshing.
   *        `0` restores strict expiry — every read past the TTL blocks on a collection.
   * @param {Function} [opts.now]
   * @param {number} [opts.maxEntries]
   * @param {(fn: Function) => any} [opts.backgroundScope] runs a background refresh inside a
   *        caller-supplied scope. The router passes `withLowPriority` so a refresh triggered
   *        by one operator's click cannot outrank another read at the per-cluster gate —
   *        nobody is waiting on it, so it has no claim on a slot. Identity by default, which
   *        keeps this module free of a dependency on the transport.
   */
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    staleMs = DEFAULT_STALE_MS,
    now = Date.now,
    maxEntries = DEFAULT_MAX_ENTRIES,
    backgroundScope = fn => fn()
  } = {}) {
    this.ttlMs = ttlMs;
    this.staleMs = staleMs;
    this.now = now;
    this.maxEntries = maxEntries;
    this.backgroundScope = backgroundScope;
    this._entries = new Map();
    /** In-flight promises, so ten browsers refreshing at once cause one sweep, not ten. */
    this._inflight = new Map();
  }

  /** This entry's own TTL if it asked for one, otherwise the cache's. */
  _ttlOf(hit) {
    return hit.ttlMs === undefined ? this.ttlMs : hit.ttlMs;
  }

  /**
   * How long an entry may be served after its TTL runs out.
   *
   * An entry that asked for a short TTL gets a stale window no longer than that TTL. The
   * caller that says "this answer is only good for 15 seconds" — `/traffic-errors`, a moving
   * window over Envoy access logs — must not have it served for 75. Scaling the window to
   * the entry's own declared shelf life is the only reading of `ttlMs` that honours it.
   */
  _staleOf(hit) {
    // An entry that declared its own stale window keeps it: `/traffic-errors` and `/traces` ask
    // for 15s fresh plus a longer serve-while-refreshing tail, because a cold read of either is
    // longer than the fresh window itself (8-33s, measured 2026-09-26).
    if (hit.staleMs !== undefined) return hit.staleMs;
    return Math.min(this.staleMs, this._ttlOf(hit));
  }

  /**
   * @param {string} key
   * @param {() => Promise<any>} fn
   * @param {{ttlMs?: number, staleMs?: number, collectedAtOf?: (value: any) => number|null,
   *   onServed?: (collectedAtMs: number) => void}} [opts]
   *        `ttlMs` gives a shorter (or longer) life to THIS entry only. Used by
   *        `/traffic-errors`, whose answer is a moving window over Envoy access logs and so
   *        goes stale far faster than a resource listing does.
   *
   *        `staleMs` gives THIS entry its own stale window instead of `min(staleMs, ttlMs)`.
   *
   *        `collectedAtOf` dates the entry by its oldest ingredient rather than by when `fn`
   *        returned. A collection that reused a shared pod-log read is only as fresh as that
   *        read, and dating it `now` would restart its TTL over older data.
   *
   *        `fn` receives `{ revalidating: true }` when it runs as a background refresh, so a
   *        caller can refuse to reuse shared ingredients there: a refresh that re-serves the
   *        data it is replacing refreshes nothing.
   *
   *        `onServed` receives the wall-clock time the returned value was actually
   *        collected — which, when a stale entry is served, is not now. Every `collectedAt`
   *        the router emits comes from this, so a timestamp can never claim a body is
   *        fresher than the read behind it.
   */
  async wrap(key, fn, opts = {}) {
    // Expired entries are freed here rather than left for a read that may never come —
    // a namespace nobody asks about again would otherwise sit in memory until the pod
    // restarts. This runs on every call, not just this key's, so cold keys still get
    // swept out on the back of whatever traffic the fleet is getting.
    this._purgeExpired();

    const hit = this._entries.get(key);
    if (hit) {
      // Touch: re-inserting moves the key to the end of the Map's iteration order, which
      // is what makes "oldest" (the front) mean "least recently used" rather than just
      // "first ever fetched."
      this._entries.delete(key);
      this._entries.set(key, hit);
      // Past its TTL but inside the stale window: answer from it now, replace it behind the
      // answer. `_revalidate` is deliberately not awaited — awaiting it here would reinstate
      // the very five seconds this exists to remove.
      if (this.now() - hit.at >= this._ttlOf(hit)) this._revalidate(key, fn, opts);
      if (opts.onServed) opts.onServed(hit.at);
      return hit.value;
    }

    const pending = this._inflight.get(key);
    if (pending) {
      const value = await pending.promise;
      // The in-flight collection has landed by now, so the entry it wrote carries the real
      // time. Falling back to `now` covers the case where it failed and wrote nothing.
      if (opts.onServed) opts.onServed(this._entries.get(key)?.at ?? this.now());
      return value;
    }

    const at = this.now();
    const value = await this._collect(key, fn, opts);
    // The entry's own stamp, not `at`: `_insert` records when the collection *finished*, and
    // that is the time the numbers describe. Falling back to `at` covers an invalidation
    // that retired this collection before it could write.
    if (opts.onServed) opts.onServed(this._entries.get(key)?.at ?? at);
    return value;
  }

  /** The uncached path, shared by a cold read and a background refresh. */
  _collect(key, fn, opts) {
    // Identity, not the promise itself, so `invalidate` can retire an in-flight collection
    // by simply dropping it from the map.
    const token = {};
    const promise = (async () => {
      try {
        const value = await fn();
        // Only write if this collection is still the one the key is waiting on. An
        // `invalidate` between start and finish retires it, and a retired collection writing
        // its pre-invalidation answer is the exact stale read the invalidation asked to
        // avoid — `/traffic-errors` with `cache-control: no-cache` invalidates and re-reads,
        // and without this it would get the answer it just threw away.
        if (this._inflight.get(key) === token) {
          const now = this.now();
          const declared = opts.collectedAtOf ? opts.collectedAtOf(value) : null;
          // Never later than now, and never a non-number: a bad stamp falls back to "just now".
          const at = Number.isFinite(declared) ? Math.min(declared, now) : now;
          this._insert(key, { at, value, ttlMs: opts.ttlMs, staleMs: opts.staleMs });
        }
        return value;
      } finally {
        if (this._inflight.get(key) === token) this._inflight.delete(key);
      }
    })();

    token.promise = promise;
    this._inflight.set(key, token);
    return promise;
  }

  /**
   * Replace a stale entry, off the request path.
   *
   * Two properties carry the safety of the whole stale-while-revalidate scheme:
   *
   *  1. **A failed refresh evicts.** If the cluster has stopped answering, the stale entry
   *     goes rather than being served for another minute. The next read is cold, does the
   *     real call, and gets the real error — which is what the completeness contract
   *     requires: an unreachable cluster is never rendered as its last good numbers.
   *  2. **Nothing awaits this.** So the rejection is swallowed here on purpose (the error
   *     has already done its job by evicting) — an unhandled rejection would take the
   *     process down for a read nobody asked for.
   */
  _revalidate(key, fn, opts) {
    if (this._inflight.has(key)) return;
    this.backgroundScope(() =>
      this._collect(key, () => fn({ revalidating: true }), opts).catch(() => {
        this._entries.delete(key);
      })
    );
  }

  _purgeExpired() {
    const now = this.now();
    for (const [key, hit] of this._entries) {
      // `hit.ttlMs` is per-entry and usually undefined, in which case the cache's own TTL
      // applies. A `wrap` that asked for a shorter life must keep it even though the sweep
      // that evicts it is driven by everybody else's traffic.
      if (now - hit.at >= this._ttlOf(hit) + this._staleOf(hit)) this._entries.delete(key);
    }
  }

  /** Insert, then evict the least-recently-used entry if that pushed the map past bound.
   *  A single insert can only ever put the map one over, so one eviction is always enough. */
  _insert(key, entry) {
    this._entries.set(key, entry);
    if (this._entries.size > this.maxEntries) {
      const oldestKey = this._entries.keys().next().value;
      this._entries.delete(oldestKey);
    }
  }

  invalidate(prefix) {
    for (const key of [...this._entries.keys()]) {
      if (!prefix || key.startsWith(prefix)) this._entries.delete(key);
    }
    // Retire any collection already in flight for these keys. It was started before the
    // invalidation, so its answer predates whatever the caller is trying to see; dropping it
    // from the map both discards its write (see `_collect`) and stops the next `wrap` from
    // joining it instead of starting a fresh read.
    for (const key of [...this._inflight.keys()]) {
      if (!prefix || key.startsWith(prefix)) this._inflight.delete(key);
    }
  }
}

/**
 * Reported instead of silence when an OIDC cluster ran on the fleet service account's
 * token rather than the caller's own. Not a failure — the call may well succeed — so it
 * never appears under `error`; it rides alongside `ok: true` (or an unrelated failure)
 * so the UI can explain a permission difference instead of showing a bare 403.
 */
const OIDC_FALLBACK_TO_SA = 'OIDC_FALLBACK_TO_SA';

function fallbackInfo(cluster) {
  return {
    code: OIDC_FALLBACK_TO_SA,
    message: `${cluster.id} is OIDC / AppleConnect SSO; no user session token arrived with this ` +
      `request, so it ran as the fleet service account instead of you — permissions may differ from your own`,
    cluster: cluster.id,
    needsReseed: false
  };
}

/**
 * Run a collector against every active cluster, concurrently, tolerating failure.
 *
 * @param {object} args
 * @param {import('./registry').Registry} args.registry
 * @param {import('./tokens').TokenStore} args.tokens
 * @param {(ctx: {cluster: object, token: string}) => Promise<any>} args.collect
 * @param {string[]} [args.only] restrict to these cluster ids
 * @param {string} [args.userToken] forwarded user Bearer token for OIDC clusters
 * @returns {Promise<Array<{cluster: object, ok: boolean, data?: any, error?: object, authFallback?: object}>>}
 */
async function fanOut({ registry, tokens, collect, only, userToken }) {
  const clusters = registry.active().filter(c => !only || only.includes(c.id));

  return Promise.all(clusters.map(async cluster => {
    const isOidc = cluster.authMode === 'oidc' || cluster.onboardedVia === 'oidc';
    const saToken = tokens.tokenFor(cluster.id);
    const token = isOidc ? (userToken || saToken) : saToken;
    const health = isOidc
      ? { cluster: cluster.id, status: userToken ? 'valid' : 'unseeded', hoursRemaining: 24, expiresAt: null, lastRenewedAt: null, lastError: null }
      : tokens.health(cluster.id);
    // True only when an OIDC cluster actually fell back — i.e. there was no user session
    // token but the fleet's own service-account token stood in for it. When neither exists
    // the `!token` branch below reports UNSEEDED instead; there is no fallback to flag.
    const authFallback = isOidc && !userToken && Boolean(saToken) ? fallbackInfo(cluster) : undefined;

    if (!isOidc) {
      if (health.status === 'unseeded') {
        return failed(cluster, new ClusterError(UNSEEDED,
          `${cluster.id} has no token yet — seed one with: kubectl create token ${cluster.serviceAccount} -n ${cluster.namespace} --duration=24h`,
          { cluster: cluster.id }), health);
      }
      if (health.status === 'expired') {
        return failed(cluster, new ClusterError(EXPIRED,
          `${cluster.id}'s token expired at ${health.expiresAt}; the renewal chain is broken and must be re-seeded by hand`,
          { cluster: cluster.id }), health);
      }
    } else if (!token) {
      return failed(cluster, new ClusterError(UNSEEDED,
        `${cluster.id} is configured for OIDC / AppleConnect SSO but no user session token was received`,
        { cluster: cluster.id }), health);
    }

    try {
      const data = await collect({ cluster, token });
      return {
        cluster: publicCluster(cluster), ok: true, data, token: health,
        ...(authFallback ? { authFallback } : {})
      };
    } catch (err) {
      return failed(cluster, err, health, authFallback);
    }
  }));
}

function failed(cluster, err, tokenHealth, authFallback) {
  const error = err instanceof ClusterError
    ? err.toJSON()
    : { code: 'UPSTREAM', message: err.message, cluster: cluster.id, needsReseed: false };
  return {
    cluster: publicCluster(cluster), ok: false, error, token: tokenHealth,
    ...(authFallback ? { authFallback } : {})
  };
}

/** The cluster fields safe to send to a browser. There is no secret here, but be exact. */
function publicCluster(c) {
  return {
    id: c.id,
    displayName: c.displayName,
    env: c.env,
    apiUrl: c.apiUrl,
    namespace: c.namespace,
    serviceAccount: c.serviceAccount,
    enabled: c.enabled,
    authMode: c.authMode || (c.onboardedVia === 'oidc' ? 'oidc' : 'token'),
    // How the cluster got here, and whether its token can mint a successor. Absent on baked
    // clusters and on anything onboarded before this field existed — both of which do renew,
    // so the default is true. Only a pasted token whose self-mint was refused is false, and
    // the UI shows that as a warning because the cluster will go dark when the token lapses.
    onboardedVia: c.onboardedVia || 'baked',
    renewable: c.renewable !== false
  };
}

export default { fanOut, Cache, publicCluster, DEFAULT_TTL_MS, DEFAULT_STALE_MS, DEFAULT_MAX_ENTRIES, OIDC_FALLBACK_TO_SA };
