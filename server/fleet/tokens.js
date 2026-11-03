/**
 * The token store: reads the projected Secret mount, never writes it.
 *
 * The CronJob is the only writer. This process only ever reads, which is what makes a
 * projected volume the right transport — kubelet refreshes a mounted Secret within about
 * a minute of the CronJob patching it, so a renewed token arrives with no restart, no
 * watch, and no API call from this pod.
 *
 * Layout of the mount (one file per cluster id, each holding one JSON object):
 *
 *   /etc/fleet-tokens/platformsbx   {"token":"eyJ...","expiresAt":"2026-09-01T16:33:34Z",
 *                                    "renewedAt":"2026-08-31T16:33:34Z","lastError":null}
 *
 * One file per cluster rather than one combined file is deliberate: a partial renewal
 * (three clusters succeed, two fail) then touches only the keys that changed, and a
 * malformed write can never take down every cluster at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import redisStoreModule from './redis-store.js';
const { memTokens } = redisStoreModule;

const DEFAULT_MOUNT = '/etc/fleet-tokens';
/** Treat a token as due for renewal once it is inside this window of expiring. */
const RENEW_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Warn in the UI once a token has less than this long to live. */
const WARN_WINDOW_MS = 6 * 60 * 60 * 1000;

class TokenStore {
  /**
   * @param {{mountPath?: string, now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    this.mountPath = opts.mountPath || process.env.FLEET_TOKENS_PATH || DEFAULT_MOUNT;
    this.now = opts.now || Date.now;
    /** @type {Map<string, {mtimeMs: number, entry: object}>} */
    this._cache = new Map();
  }

  _fileFor(clusterId) {
    // clusterId comes from our own ConfigMap, but it ends up in a filesystem path, so it
    // is validated at the registry boundary. Re-checking here keeps this module safe to
    // call directly from a test or a future code path that skips the registry.
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clusterId)) {
      throw new Error(`invalid cluster id: ${JSON.stringify(clusterId)}`);
    }
    return path.join(this.mountPath, clusterId);
  }

  /**
   * Read one cluster's token record, re-parsing only when the file has actually changed.
   * @returns {{token: string|null, expiresAt: string|null, renewedAt: string|null,
   *            lastError: string|null}|null} null when the cluster was never seeded
   */
  read(clusterId) {
    const file = this._fileFor(clusterId);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      // Check Redis / Memory store
      const mem = memTokens.get(clusterId);
      if (mem) return mem;
      return null;
    }
    const cached = this._cache.get(clusterId);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entry;

    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // A half-written or corrupt file must not crash the request. Surface it as a
      // readable error on that one cluster and leave the rest of the fleet alone.
      entry = { token: null, expiresAt: null, renewedAt: null, lastError: `unreadable token file: ${err.message}` };
    }
    this._cache.set(clusterId, { mtimeMs: stat.mtimeMs, entry });
    return entry;
  }

  /** Just the bearer string, or null. */
  tokenFor(clusterId) {
    const entry = this.read(clusterId);
    return entry && entry.token ? entry.token : null;
  }

  /**
   * Health of one cluster's token, for the Token Health screen.
   * Never returns the token itself — only facts about it.
   * @returns {{status: string, expiresAt: string|null, expiresInMs: number|null,
   *            renewedAt: string|null, lastError: string|null, dueForRenewal: boolean}}
   */
  health(clusterId) {
    const entry = this.read(clusterId);
    if (!entry) {
      return {
        status: 'unseeded', expiresAt: null, expiresInMs: null,
        renewedAt: null, lastError: null, dueForRenewal: true
      };
    }
    const expiresAt = entry.expiresAt;
    const expiresInMs = expiresAt ? Date.parse(expiresAt) - this.now() : null;

    let status;
    if (!entry.token) status = 'unseeded';
    else if (expiresInMs === null || Number.isNaN(expiresInMs)) status = 'unknown';
    else if (expiresInMs <= 0) status = 'expired';
    else if (expiresInMs < WARN_WINDOW_MS) status = 'expiring';
    else status = 'valid';

    return {
      status,
      expiresAt: expiresAt || null,
      expiresInMs: Number.isNaN(expiresInMs) ? null : expiresInMs,
      renewedAt: entry.renewedAt || null,
      lastError: entry.lastError || null,
      dueForRenewal: expiresInMs === null || Number.isNaN(expiresInMs) || expiresInMs < RENEW_WINDOW_MS
    };
  }
}

export default { TokenStore, RENEW_WINDOW_MS, WARN_WINDOW_MS, DEFAULT_MOUNT };
