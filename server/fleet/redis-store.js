/**
 * In-memory store for fleet clusters and tokens.
 *
 * Holds onboarded cluster definitions and minted Service Account connection tokens for the
 * life of the process (zero SQLite persistence for fleet data). Durable copies live in the hub
 * Secrets that secret-writer.js maintains, and registry.js / tokens.js re-read those on start.
 */
import { getLogger } from '../logger.js';

// In-memory cache for ultra-fast synchronous lookups by Registry and TokenStore
const memClusters = new Map();
const memTokens = new Map();
const memDeleted = new Set();

class FleetRedisStore {
  /**
   * Optional backward-compat method if caller passes db
   */
  bindDb(_db) {
    // SQLite persistence disabled for fleet data; the hub Secrets are the durable copy
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
      namespace: record.namespace ?? 'fleet-dashboard',
      serviceAccount: record.serviceAccount ?? 'fleet-reader'
    };

    memClusters.set(id, clusterData);

    getLogger().info(`[fleet-store] Saved cluster record for '${id}'`);
    return clusterData;
  }

  async deleteCluster(id) {
    memDeleted.add(id);
    memClusters.delete(id);
    memTokens.delete(id);

    getLogger().info(`[fleet-store] Deleted cluster record and token for '${id}'`);
  }

  async deleteToken(id) {
    memTokens.delete(id);

    getLogger().info(`[fleet-store] Deleted token for '${id}'`);
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

    getLogger().info(
      `[fleet-store] Saved active token for '${clusterId}' (expires: ${tokenRecord.expiresAt || 'unknown'})`
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
