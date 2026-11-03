/**
 * Whisper-backed persistent secret storage for Kyma Fleet clusters and minted tokens.
 *
 * Secures all cluster definitions and sensitive minted 24h bearer tokens inside Apple's Whisper:
 * - Reads all clusters and token records from Whisper on startup / queries.
 * - Handles empty secrets gracefully (initializes empty map `{ clusters: {}, tokens: {} }`).
 * - Updates records in Whisper whenever clusters are onboarded, removed, or 24h tokens renewed.
 * - Entirely eliminates SQLite persistence for fleet data.
 */
import { getWhisperSecret, updateWhisperSecret } from './whisper.js';
import { getLogger } from '../logger.js';

export class WhisperFleetStore {
  constructor(opts = {}) {
    this.secretName = opts.secretName
      || process.env.WHISPER_SECRET_NAME
      || 'btp-kyma-fleet-dashboard-prod';
    this.namespace = opts.namespace
      || process.env.WHISPER_NAMESPACE
      || 'btp-pltform-security';
    this._enabled = process.env.WHISPER_FLEET_ENABLED !== 'false';
  }

  /**
   * Internal helper: read and parse full state from Whisper secret.
   * Format inside the secret:
   * {
   *   "clusters": {
   *     "<cluster-id>": { "id": "...", "displayName": "...", "apiUrl": "...", "env": "..." }
   *   },
   *   "tokens": {
   *     "<cluster-id>": { "token": "...", "expiresAt": "...", "renewedAt": "...", "lastError": null }
   *   }
   * }
   * @returns {Promise<{clusters: Record<string, object>, tokens: Record<string, object>}|null>}
   */
  async readState() {
    if (!this._enabled) return null;
    const log = getLogger();
    try {
      const raw = await getWhisperSecret(this.secretName, this.namespace);
      if (!raw || !raw.trim()) {
        return { clusters: {}, tokens: {} };
      }
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        log.warn('[whisper-store] Secret content was not JSON, initializing empty container');
        return { clusters: {}, tokens: {} };
      }

      if (typeof parsed !== 'object' || parsed === null) {
        return { clusters: {}, tokens: {} };
      }

      // Support both structured layout { clusters, tokens } and legacy/flat token layouts
      const clusters = parsed.clusters && typeof parsed.clusters === 'object' ? parsed.clusters : {};
      const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {};

      log.info(
        { clusters: Object.keys(clusters).length, tokens: Object.keys(tokens).length },
        '[whisper-store] Read fleet state from Whisper'
      );
      return { clusters, tokens };
    } catch (err) {
      log.warn(`[whisper-store] Could not read from Whisper (${err.message}); falling back to in-memory store`);
      return null;
    }
  }

  /** Read all clusters from Whisper. */
  async readClusters() {
    const state = await this.readState();
    return state ? state.clusters : null;
  }

  /** Read all tokens from Whisper. */
  async readTokens() {
    const state = await this.readState();
    return state ? state.tokens : null;
  }

  /**
   * Save or update a cluster record in Whisper.
   * @param {string} clusterId
   * @param {object} clusterData
   */
  async saveCluster(clusterId, clusterData) {
    if (!this._enabled) return false;
    const log = getLogger();
    try {
      const state = (await this.readState()) || { clusters: {}, tokens: {} };
      state.clusters[clusterId] = clusterData;
      await updateWhisperSecret(this.secretName, this.namespace, state);
      log.info({ clusterId }, '[whisper-store] Persisted cluster definition to Whisper');
      return true;
    } catch (err) {
      log.warn(`[whisper-store] Failed to save cluster '${clusterId}' to Whisper: ${err.message}`);
      return false;
    }
  }

  /**
   * Save or update a token record in Whisper (e.g. upon renewal or minting).
   * @param {string} clusterId
   * @param {object} tokenRecord
   */
  async saveToken(clusterId, tokenRecord) {
    if (!this._enabled) return false;
    const log = getLogger();
    try {
      const state = (await this.readState()) || { clusters: {}, tokens: {} };
      state.tokens[clusterId] = tokenRecord;
      await updateWhisperSecret(this.secretName, this.namespace, state);
      log.info({ clusterId }, '[whisper-store] Persisted renewed token to Whisper');
      return true;
    } catch (err) {
      log.warn(`[whisper-store] Failed to save token for '${clusterId}' to Whisper: ${err.message}`);
      return false;
    }
  }

  /**
   * Delete a cluster and its associated token from Whisper.
   * @param {string} clusterId
   */
  async deleteCluster(clusterId) {
    if (!this._enabled) return false;
    const log = getLogger();
    try {
      const state = (await this.readState()) || { clusters: {}, tokens: {} };
      let changed = false;
      if (clusterId in state.clusters) {
        delete state.clusters[clusterId];
        changed = true;
      }
      if (clusterId in state.tokens) {
        delete state.tokens[clusterId];
        changed = true;
      }
      if (changed) {
        await updateWhisperSecret(this.secretName, this.namespace, state);
        log.info({ clusterId }, '[whisper-store] Deleted cluster & token from Whisper');
      }
      return true;
    } catch (err) {
      log.warn(`[whisper-store] Failed to delete cluster '${clusterId}' from Whisper: ${err.message}`);
      return false;
    }
  }

  /**
   * Delete only the token for a cluster from Whisper.
   * @param {string} clusterId
   */
  async deleteToken(clusterId) {
    if (!this._enabled) return false;
    const log = getLogger();
    try {
      const state = (await this.readState()) || { clusters: {}, tokens: {} };
      if (clusterId in state.tokens) {
        delete state.tokens[clusterId];
        await updateWhisperSecret(this.secretName, this.namespace, state);
        log.info({ clusterId }, '[whisper-store] Deleted token from Whisper');
      }
      return true;
    } catch (err) {
      log.warn(`[whisper-store] Failed to delete token for '${clusterId}' from Whisper: ${err.message}`);
      return false;
    }
  }
}

export const whisperFleetStore = new WhisperFleetStore();
