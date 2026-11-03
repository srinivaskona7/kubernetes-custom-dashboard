/**
 * One egress registry per cluster and credential, shared by `/traces` and `/traffic-errors`: the
 * destination-name index, the route index (with each route's backend Services) and the Gateway
 * host patterns, built by `traffic.readRegistry`.
 *
 * Keyed like proxy-log-share.js: cluster id plus `tokenFingerprint`, because under OIDC
 * passthrough one operator's reads are not another operator's to be served. One instance per
 * router; nothing module-level. A rejected build is dropped, never retained.
 */
import k8sModule from '../k8s.js';
const { tokenFingerprint } = k8sModule;

const DEFAULT_RETAIN_MS = 60_000;

function createRegistryShare({ now = Date.now, retainMs = DEFAULT_RETAIN_MS } = {}) {
  const entries = new Map();
  const keyOf = ({ cluster, token }) => `${cluster && cluster.id}|${tokenFingerprint(token)}`;

  /**
   * The registry for this cluster and credential: an in-flight or settled build no older than
   * `maxAgeMs`, else a new one. `maxAgeMs: 0` always builds (a forced re-read).
   */
  function get(baseCtx, build, { maxAgeMs = retainMs } = {}) {
    const key = keyOf(baseCtx);
    const hit = entries.get(key);
    if (maxAgeMs > 0 && hit && now() - hit.at <= maxAgeMs) return hit.promise;
    const entry = { at: now(), promise: null };
    entry.promise = Promise.resolve()
      .then(build)
      .catch(err => {
        if (entries.get(key) === entry) entries.delete(key);
        throw err;
      });
    for (const [k, e] of entries) if (now() - e.at > retainMs) entries.delete(k);
    entries.set(key, entry);
    return entry.promise;
  }

  return { get, size: () => entries.size };
}

export default { createRegistryShare, DEFAULT_RETAIN_MS };
