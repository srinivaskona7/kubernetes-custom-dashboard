/**
 * Writes token and cluster records through Redis & in-memory store first,
 * and optionally syncs to Kubernetes Secrets when the pod's service-account is mounted.
 *
 * This guarantees zero runtime errors if automountServiceAccountToken is disabled,
 * and enables multi-replica real-time session/token sharing when Redis is present.
 */
import fs from 'node:fs';
import k8sModule from './k8s.js';
const { call } = k8sModule;
import redisStoreModule from './redis-store.js';
const { fleetStore } = redisStoreModule;

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

class SecretTokenWriter {
  /**
   * @param {{secretName?: string, namespace?: string, apiUrl?: string,
   *          token?: string, caFile?: string, isClusterStore?: boolean}} [opts]
   */
  constructor(opts = {}) {
    this.secretName = opts.secretName || process.env.FLEET_TOKENS_SECRET || 'fleet-dashboard-tokens';
    this.isClusterStore = Boolean(opts.isClusterStore || (opts.secretName && opts.secretName.includes('clusters')));
    this.namespace = opts.namespace
      || process.env.POD_NAMESPACE
      || readIfPresent(`${SA_DIR}/namespace`)
      || 'fleet-dashboard';
    // In-cluster address.
    this.apiUrl = opts.apiUrl || process.env.KUBERNETES_API || 'https://kubernetes.default.svc';
    this.caFile = opts.caFile || `${SA_DIR}/ca.crt`;
    this._token = opts.token || null;
  }

  hasToken() {
    if (this._token) return true;
    return Boolean(readIfPresent(`${SA_DIR}/token`));
  }

  token() {
    if (this._token) return this._token;
    const t = readIfPresent(`${SA_DIR}/token`);
    if (!t) return null;
    return t;
  }

  get _self() {
    return { id: 'hub', apiUrl: this.apiUrl, caFile: this.caFile };
  }

  get _path() {
    return `/api/v1/namespaces/${this.namespace}/secrets/${this.secretName}`;
  }

  /** Read every cluster's record out of Redis/Memory and Secret. */
  async readAll() {
    // 1. Load from Redis / Memory
    const storeRecords = this.isClusterStore
      ? await fleetStore.getAllClusters()
      : await fleetStore.getAllTokens();

    const out = {};
    if (this.isClusterStore) {
      for (const c of storeRecords) {
        if (c && c.id) out[c.id] = c;
      }
    } else if (storeRecords instanceof Map) {
      for (const [id, rec] of storeRecords) {
        out[id] = rec;
      }
    }

    // 2. Supplement from K8s Secret if SA token is available
    const tok = this.token();
    if (tok) {
      try {
        const secret = await call({ cluster: this._self, token: tok, path: this._path });
        for (const [key, b64] of Object.entries((secret && secret.data) || {})) {
          if (!out[key]) {
            try {
              out[key] = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
            } catch {
              out[key] = { token: null, expiresAt: null, renewedAt: null, lastError: 'unparseable record' };
            }
          }
        }
      } catch {
        // ignore if secret read is unpermitted or secret missing
      }
    }

    return out;
  }

  /**
   * Merge-patch one or more cluster records.
   * @param {Record<string, object>} records keyed by cluster id
   */
  async patchAll(records) {
    // 1. Always save into Redis & In-Memory Store
    for (const [id, record] of Object.entries(records)) {
      if (this.isClusterStore) {
        await fleetStore.saveCluster(id, record);
      } else {
        await fleetStore.saveToken(id, record);
      }
    }

    // 2. Best-effort sync to K8s Secret if SA token exists
    const tok = this.token();
    if (!tok) {
      return { ok: true, syncedToSecret: false };
    }

    const data = {};
    for (const [id, record] of Object.entries(records)) {
      data[id] = Buffer.from(JSON.stringify(record), 'utf8').toString('base64');
    }

    try {
      return await call({
        cluster: this._self,
        token: tok,
        path: this._path,
        method: 'PATCH',
        contentType: 'application/strategic-merge-patch+json',
        body: { data }
      });
    } catch {
      // Redis & Memory store already succeeded; do not fail the request if K8s Secret patch fails
      return { ok: true, syncedToSecret: false };
    }
  }

  /** Patch exactly one cluster. */
  async patch(clusterId, record) {
    return this.patchAll({ [clusterId]: record });
  }

  /** Delete one cluster's record. */
  async remove(clusterId) {
    if (this.isClusterStore) {
      await fleetStore.deleteCluster(clusterId);
    } else {
      await fleetStore.deleteToken(clusterId);
    }

    const tok = this.token();
    if (!tok) return { ok: true };

    try {
      return await call({
        cluster: this._self,
        token: tok,
        path: this._path,
        method: 'PATCH',
        contentType: 'application/strategic-merge-patch+json',
        body: { data: { [clusterId]: null } }
      });
    } catch {
      return { ok: true };
    }
  }
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

export default { SecretTokenWriter, SA_DIR };
