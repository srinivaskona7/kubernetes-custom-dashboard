import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhisperFleetStore } from '../lib/whisper-store.js';

vi.mock('../lib/whisper.js', () => ({
  getWhisperSecret: vi.fn(),
  updateWhisperSecret: vi.fn()
}));

import { getWhisperSecret, updateWhisperSecret } from '../lib/whisper.js';

describe('WhisperFleetStore', () => {
  let store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new WhisperFleetStore({
      secretName: 'test-secret',
      namespace: 'test-ns'
    });
  });

  it('reads empty state when secret is empty or whitespace', async () => {
    getWhisperSecret.mockResolvedValueOnce('');
    const state = await store.readState();
    expect(state).toEqual({ clusters: {}, tokens: {} });
  });

  it('reads and parses clusters and tokens from Whisper', async () => {
    const mockData = {
      clusters: {
        'kyma-prod-eu': { id: 'kyma-prod-eu', displayName: 'Kyma EU', env: 'prod' }
      },
      tokens: {
        'kyma-prod-eu': { token: 'jwt-token-24h', expiresAt: '2026-11-01T00:00:00Z', renewedAt: '2026-10-29T00:00:00Z', lastError: null }
      }
    };
    getWhisperSecret.mockResolvedValueOnce(JSON.stringify(mockData));

    const state = await store.readState();
    expect(state).toEqual(mockData);
    expect(getWhisperSecret).toHaveBeenCalledWith('test-secret', 'test-ns');
  });

  it('saves cluster definition into Whisper', async () => {
    getWhisperSecret.mockResolvedValueOnce(JSON.stringify({ clusters: {}, tokens: {} }));
    updateWhisperSecret.mockResolvedValueOnce({ ok: true });

    const clusterData = { id: 'kyma-stage', displayName: 'Kyma Stage', env: 'stage', apiUrl: 'https://api.stage:6443' };
    const success = await store.saveCluster('kyma-stage', clusterData);

    expect(success).toBe(true);
    expect(updateWhisperSecret).toHaveBeenCalledWith(
      'test-secret',
      'test-ns',
      {
        clusters: { 'kyma-stage': clusterData },
        tokens: {}
      }
    );
  });

  it('saves minted / renewed token into Whisper', async () => {
    getWhisperSecret.mockResolvedValueOnce(JSON.stringify({
      clusters: { 'kyma-prod': { id: 'kyma-prod' } },
      tokens: {}
    }));
    updateWhisperSecret.mockResolvedValueOnce({ ok: true });

    const tokenRecord = { token: 'new-minted-token', expiresAt: '2026-10-30T12:00:00Z' };
    const success = await store.saveToken('kyma-prod', tokenRecord);

    expect(success).toBe(true);
    expect(updateWhisperSecret).toHaveBeenCalledWith(
      'test-secret',
      'test-ns',
      {
        clusters: { 'kyma-prod': { id: 'kyma-prod' } },
        tokens: { 'kyma-prod': tokenRecord }
      }
    );
  });

  it('deletes cluster and token together from Whisper', async () => {
    getWhisperSecret.mockResolvedValueOnce(JSON.stringify({
      clusters: {
        'to-delete': { id: 'to-delete' },
        'to-keep': { id: 'to-keep' }
      },
      tokens: {
        'to-delete': { token: 't1' },
        'to-keep': { token: 't2' }
      }
    }));
    updateWhisperSecret.mockResolvedValueOnce({ ok: true });

    const success = await store.deleteCluster('to-delete');
    expect(success).toBe(true);
    expect(updateWhisperSecret).toHaveBeenCalledWith(
      'test-secret',
      'test-ns',
      {
        clusters: { 'to-keep': { id: 'to-keep' } },
        tokens: { 'to-keep': { token: 't2' } }
      }
    );
  });
});
