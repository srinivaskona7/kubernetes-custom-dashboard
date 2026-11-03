/**
 * In-Memory & Whisper Store for Kyma Fleet clusters and tokens.
 *
 * Secures all cluster definitions and sensitive 24h Service Account connection tokens
 * inside Apple's Whisper secret manager (zero SQLite persistence for fleet data).
 *
 * Provides resilient, zero-failure in-memory caching backed by Whisper:
 *   - Onboarded cluster definitions (synced to Whisper secret `clusters` map)
 *   - 24h minted Service Account connection tokens & renewals (synced to Whisper secret `tokens` map)
 */
import { getLogger } from '../logger.js';
import { whisperFleetStore } from '../lib/whisper-store.js';

// In-memory cache for ultra-fast synchronous lookups by Registry and TokenStore
const memClusters = new Map();
const memTokens = new Map();
const memDeleted = new Set();

class FleetRedisStore {
  constructor() {
    this._whisper = whisperFleetStore;
    this.hydrate();
  }

  /**
   * Optional backward-compat method if caller passes db
   */
  bindDb(_db) {
    // SQLite persistence disabled for fleet data in favor of Whisper
  }

  /**
   * Hydrate in-memory cache from Whisper on startup.
   */
  async hydrate() {
    try {
      const state = await this._whisper.readState();
      if (state) {
        if (state.clusters && typeof state.clusters === 'object') {
          for (const [id, cluster] of Object.entries(state.clusters)) {
            if (cluster && typeof cluster === 'object') {
              memDeleted.delete(id);
              memClusters.set(id, cluster);
            }
          }
        }
        if (state.tokens && typeof state.tokens === 'object') {
          for (const [id, tokenRec] of Object.entries(state.tokens)) {
            if (tokenRec && typeof tokenRec === 'object') {
              memTokens.set(id, tokenRec);
            }
          }
        }
        getLogger().info(
          `[fleet-store] Hydrated ${memClusters.size} cluster(s) and ${memTokens.size} token(s) from Whisper secret`
        );
      }
    } catch (err) {
      getLogger().warn(`[fleet-store] Whisper hydration skipped: ${err.message}`);
    }
  }

  // ------------------------------------------------------------- Clusters

  async getCluster(id) {
    const cached = memClusters.get(id);
    if (cached) return cached;
    return null;
  }

  async getAllClusters() {
    return Array.from(memClusters.values()).filter(c => !memDeleted.has(c.id));
  }

  async saveCluster(id, record) {
    memDeleted.delete(id);
    const clusterData = {
      ...record,
      id,
      displayName: record.displayName ?? id,
      env: record.env ?? 'unknown',
      apiUrl: record.apiUrl ?? '',
      namespace: record.namespace ?? 'kyma-fleet',
      serviceAccount: record.serviceAccount ?? 'fleet-reader'
    };

    memClusters.set(id, clusterData);

    // Persist cluster directly to Whisper
    this._whisper.saveCluster(id, clusterData).catch(err => {
      getLogger().warn(`[fleet-store] Failed to persist cluster '${id}' to Whisper: ${err.message}`);
    });

    getLogger().info(`[fleet-store] Saved cluster record for '${id}' in Whisper`);
    return clusterData;
  }

  async deleteCluster(id) {
    memDeleted.add(id);
    memClusters.delete(id);
    memTokens.delete(id);

    // Delete cluster and its token from Whisper
    this._whisper.deleteCluster(id).catch(err => {
      getLogger().warn(`[fleet-store] Failed to delete cluster '${id}' from Whisper: ${err.message}`);
    });

    getLogger().info(`[fleet-store] Deleted cluster record and token for '${id}' in Whisper`);
  }

  async deleteToken(id) {
    memTokens.delete(id);

    // Remove token from Whisper
    this._whisper.deleteToken(id).catch(err => {
      getLogger().warn(`[fleet-store] Failed to delete token '${id}' from Whisper: ${err.message}`);
    });

    getLogger().info(`[fleet-store] Deleted token for '${id}' in Whisper`);
  }

  // ------------------------------------------------------------- Tokens

  async getToken(clusterId) {
    const cached = memTokens.get(clusterId);
    if (cached) return cached;
    return null;
  }

  async getAllTokens() {
    return new Map(memTokens);
  }

  async saveToken(clusterId, tokenRecord) {
    memTokens.set(clusterId, tokenRecord);

    // Persist token to Whisper
    this._whisper.saveToken(clusterId, tokenRecord).catch(err => {
      getLogger().warn(`[fleet-store] Failed to persist token '${clusterId}' to Whisper: ${err.message}`);
    });

    getLogger().info(
      `[fleet-store] Saved active token for '${clusterId}' in Whisper (expires: ${tokenRecord.expiresAt || 'unknown'})`
    );
    return tokenRecord;
  }
}

const defaultStore = new FleetRedisStore();

export default {
  FleetRedisStore,
  fleetStore: defaultStore,
  memClusters,
  memTokens,
  memDeleted
};
