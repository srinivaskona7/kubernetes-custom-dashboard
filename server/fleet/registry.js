/**
 * The cluster registry — which clusters exist, where their API servers are, and whether
 * they are switched on.
 *
 * Two sources, merged:
 *
 *   1. A baked JSON file (FLEET_CLUSTERS_FILE). This is the bootstrap set — in practice
 *      just the hub's own cluster, reachable in-cluster with no credential to distribute.
 *      Changing it means rebuilding the image, which is the right amount of friction for
 *      the cluster the dashboard itself runs on.
 *
 *   2. A projected directory of onboarded clusters (FLEET_CLUSTERS_DIR), one JSON file
 *      per cluster, written into a Secret by the onboarding endpoint. This is what the
 *      "Add cluster" upload produces. A projected mount is used for the same reason the
 *      tokens use one: kubelet refreshes it within about a minute, so a cluster onboarded
 *      by one replica becomes visible to the others with no restart and no watch.
 *
 * A dynamic entry never overrides a baked one. If someone uploads a kubeconfig for the
 * hub's own cluster, the baked definition — the one with the in-cluster address and the
 * projected CA — wins, because it is the one that is known to work.
 */
import fs from 'node:fs';
import path from 'node:path';
import redisStoreModule from './redis-store.js';
import { getLogger } from '../logger.js';
const { memClusters, memDeleted } = redisStoreModule;
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The baked list ships beside this module, inside the image. Resolving it relative to
// __dirname rather than to an absolute mount path means it is found whatever the base
// image chose as its working directory, and means the chart needs no env var to point at
// a file that has only ever had one location.
const DEFAULT_FILE = path.join(__dirname, 'clusters.json');
const DEFAULT_DIR = '/etc/fleet-clusters';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Don't re-stat the mount on every request in a burst. */
const RELOAD_THROTTLE_MS = 5000;

// C0 controls (incl. CR/LF) + DEL + C1 controls, plus the Unicode bidi override/isolate
// characters (LRE/RLE/LRO/RLO/PDF, LRI/RLI/FSI/PDI). A free-text field carrying either can
// forge extra lines in the exported Markdown report (a CR/LF starts a new "line") or
// visually reorder its own text in the report and the console (a bidi override). Neither
// is something a legitimate cluster name, environment or namespace ever needs, so both are
// rejected outright rather than stripped — stripping would let a confused or hostile caller
// believe their input was accepted as sent.
// Written as explicit \u escapes rather than the literal characters — a literal bidi
// override pasted into source is itself invisible and unauditable at a glance.
const UNSAFE_TEXT_PATTERN = new RegExp(
  '[\\x00-\\x1F\\x7F-\\x9F\\u202A-\\u202E\\u2066-\\u2069]'
);
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_ENV_LENGTH = 100;
const MAX_NAMESPACE_LENGTH = 63; // Kubernetes' own DNS-1123 label limit
const MAX_SERVICE_ACCOUNT_LENGTH = 253; // Kubernetes' own DNS-1123 subdomain limit

/**
 * Reject (never silently rewrite) a caller-supplied free-text field before it is stored.
 * Every field this is called on can end up interpolated raw into the exported report or
 * into a copy-paste `kubectl` command in the console — `id` has its own, stricter pattern
 * above because it also becomes a filename in the token mount.
 */
function assertSafeText(value, field, where, maxLength) {
  if (typeof value !== 'string' || value === '') return; // absent — the caller's default applies
  if (value.length > maxLength) {
    throw new Error(`${where}.${field} must be at most ${maxLength} characters (got ${value.length})`);
  }
  if (UNSAFE_TEXT_PATTERN.test(value)) {
    throw new Error(
      `${where}.${field} contains a control character or Unicode bidi override, which is not allowed (got ${JSON.stringify(value)})`
    );
  }
}

/**
 * @typedef {object} Cluster
 * @property {string} id            stable key; also the token filename
 * @property {string} displayName
 * @property {string} env           sbx | dev | uat | prod
 * @property {string} apiUrl
 * @property {string} [caFile]      path to a CA bundle on disk
 * @property {string} [caData]      inline PEM, for clusters onboarded by upload
 * @property {string} [namespace]   namespace holding the fleet-reader SA
 * @property {string} [serviceAccount]
 * @property {boolean} enabled
 * @property {string} [source]      'baked' | 'onboarded'
 * @property {string} [onboardedAt]
 * @property {string} [onboardedBy]
 */

function validate(raw, index) {
  const where = typeof index === 'string' ? index : `clusters[${index}]`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where} is not an object`);
  if (!ID_PATTERN.test(raw.id || '')) {
    // The id becomes a filename in the token mount, so a bad one is a path-traversal
    // risk, not just a typo.
    throw new Error(`${where}.id must match ${ID_PATTERN} (got ${JSON.stringify(raw.id)})`);
  }
  if (!raw.apiUrl || !/^https:\/\//.test(raw.apiUrl)) {
    throw new Error(`${where}.apiUrl must be an https URL (got ${JSON.stringify(raw.apiUrl)})`);
  }
  // displayName and env are shown verbatim in the console and interpolated raw into the
  // exported Markdown report; namespace and serviceAccount are interpolated into the
  // copy-paste `kubectl create token` command shown in the console. All four are checked
  // here, at the one point every source (baked file, onboarded upload, in-memory store)
  // passes through, rather than trusting each caller to have sanitised first.
  assertSafeText(raw.displayName, 'displayName', where, MAX_DISPLAY_NAME_LENGTH);
  assertSafeText(raw.env, 'env', where, MAX_ENV_LENGTH);
  assertSafeText(raw.namespace, 'namespace', where, MAX_NAMESPACE_LENGTH);
  assertSafeText(raw.serviceAccount, 'serviceAccount', where, MAX_SERVICE_ACCOUNT_LENGTH);
  return {
    id: raw.id,
    displayName: raw.displayName || raw.id,
    env: raw.env || 'unknown',
    apiUrl: raw.apiUrl.replace(/\/+$/, ''),
    caFile: raw.caFile || null,
    caData: raw.caData || null,
    namespace: raw.namespace || 'kyma-fleet',
    serviceAccount: raw.serviceAccount || 'fleet-reader',
    enabled: raw.enabled !== false,
    source: raw.source || 'baked',
    // Which door this cluster came in through, and whether its token can mint a successor.
    // Both are written by the onboarding endpoint and must survive the round trip through
    // the mount, or a cluster whose chain cannot turn would look healthy right up until it
    // went dark. A baked cluster has neither field and is renewable by definition.
    authMode: raw.authMode || (raw.onboardedVia === 'oidc' ? 'oidc' : 'token'),
    onboardedVia: raw.onboardedVia || (raw.source === 'onboarded' ? 'kubeconfig' : 'baked'),
    renewable: raw.renewable !== false,
    onboardedAt: raw.onboardedAt || null,
    onboardedBy: raw.onboardedBy || null
  };
}

class Registry {
  /** @param {{file?: string, dir?: string, clusters?: object[], now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.file = opts.file || process.env.FLEET_CLUSTERS_FILE || DEFAULT_FILE;
    this.dir = opts.dir || process.env.FLEET_CLUSTERS_DIR || DEFAULT_DIR;
    this.now = opts.now || Date.now;
    this._deleted = new Set();

    /** Explicit clusters (tests) bypass both sources entirely. */
    this._fixed = opts.clusters ? opts.clusters.map(validate) : null;
    /** @type {Cluster[]} */
    this._baked = this._fixed || this._loadFile();
    /** @type {Cluster[]} */
    this._onboarded = [];
    this._lastScan = 0;
    if (!this._fixed) this._scanDir();
  }

  _loadFile() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      throw new Error(`cannot read cluster registry at ${this.file}: ${err.message}`, { cause: err });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`cluster registry at ${this.file} is not valid JSON: ${err.message}`, { cause: err });
    }
    const list = Array.isArray(parsed) ? parsed : parsed.clusters;
    if (!Array.isArray(list)) throw new Error(`cluster registry at ${this.file} has no clusters array`);

    const clusters = list.map((c, i) => validate({ ...c, source: 'baked' }, i));
    const ids = new Set();
    for (const c of clusters) {
      if (ids.has(c.id)) throw new Error(`duplicate cluster id: ${c.id}`);
      ids.add(c.id);
    }
    return clusters;
  }

  /**
   * Re-read the onboarded-cluster mount, throttled.
   *
   * A malformed file here must never take the fleet down — a bad upload would otherwise
   * blank the whole cluster list, including the clusters that were working. Each file is
   * parsed independently and a broken one is skipped with a log line.
   */
  _scanDir(force = false) {
    if (this._fixed) return;
    if (!force && this.now() - this._lastScan < RELOAD_THROTTLE_MS) return;
    this._lastScan = this.now();

    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      this._onboarded = []; // the mount is absent; that is normal before the first upload
      return;
    }

    const bakedIds = new Set(this._baked.map(c => c.id));
    const out = [];
    for (const name of names) {
      // Projected volumes keep their bookkeeping in ..data and ..2026_08_31_… entries.
      if (name.startsWith('.') || !ID_PATTERN.test(name)) continue;
      if (bakedIds.has(name) || memDeleted.has(name) || this._deleted.has(name)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        out.push(validate({ ...raw, id: raw.id || name, source: 'onboarded' }, name));
      } catch (err) {
        getLogger().warn(`[fleet] ignoring onboarded cluster ${name}: ${err.message}`);
      }
    }
    this._onboarded = out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Mark a cluster as removed in memory and invalidate caches. */
  remove(id) {
    this._deleted.add(id);
    memDeleted.add(id);
    this._onboarded = this._onboarded.filter(c => c.id !== id);
    this.invalidate();
  }

  /** Restore a previously removed cluster if re-onboarded. */
  unremove(id) {
    this._deleted.delete(id);
    memDeleted.delete(id);
    this.invalidate();
  }

  /** Force the next read to re-scan. Called right after an onboard or offboard. */
  invalidate() {
    this._lastScan = 0;
  }

  /** Every cluster, including the ones switched off. */
  all() {
    this._scanDir();
    const diskClusters = [...this._baked, ...this._onboarded].filter(c => !memDeleted.has(c.id) && !this._deleted.has(c.id));
    const knownIds = new Set(diskClusters.map(c => c.id));
    const storeClusters = [];

    for (const [id, raw] of memClusters) {
      if (!knownIds.has(id) && !memDeleted.has(id) && !this._deleted.has(id)) {
        try {
          storeClusters.push(validate({ ...raw, id, source: 'onboarded' }, id));
          knownIds.add(id);
        } catch {}
      }
    }

    return [...diskClusters, ...storeClusters];
  }

  /** Only the clusters we should actually call. */
  active() {
    return this.all().filter(c => c.enabled);
  }

  /** @returns {Cluster|null} */
  get(id) {
    return this.all().find(c => c.id === id) || null;
  }

  /** True when this cluster came from the baked file and so cannot be removed by the UI. */
  isBaked(id) {
    return this._baked.some(c => c.id === id);
  }
}

export default { Registry, validate, DEFAULT_FILE, DEFAULT_DIR, ID_PATTERN };
