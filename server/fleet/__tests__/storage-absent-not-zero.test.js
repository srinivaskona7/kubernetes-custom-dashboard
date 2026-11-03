/**
 * Storage: absent is not zero, and a request is not a capacity.
 *
 * Four substitutions used to happen inside `storage.js`, each replacing a fact the collector did
 * not have with a plausible-looking one. Every test here pins one of them, and the last block is a
 * source-reading guard over `StorageTab.tsx` — the UI is JSX and this project's fleet-ui vitest
 * runs `environment: 'node'`, so the rendering rules that cannot be unit-tested are pinned as text.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import storage from '../collectors/storage.js';

const __dirname = import.meta.dirname;

const cluster = { id: 'c1', displayName: 'C1', env: 'sbx', apiUrl: 'https://api.example' };

function listFor(map) {
  return async ({ path: p }) => {
    for (const [needle, items] of Object.entries(map)) if (p.includes(needle)) return items;
    return [];
  };
}

test('storage.collect: an unreported bound capacity is null, never a copy of the request', async () => {
  const listFn = listFor({
    persistentvolumeclaims: [
      {
        metadata: { name: 'unbound', namespace: 'prod' },
        spec: { storageClassName: 'premium', resources: { requests: { storage: '10Gi' } } },
        status: { phase: 'Pending' }
      },
      {
        metadata: { name: 'rounded-up', namespace: 'prod' },
        spec: { storageClassName: 'premium', resources: { requests: { storage: '10Gi' } } },
        status: { phase: 'Bound', capacity: { storage: '20Gi' } }
      }
    ]
  });
  const result = await storage.collect({ cluster, token: 't', listFn });
  const [pending, bound] = result.pvcs;
  assert.strictEqual(pending.capacity, null, 'a claim with no status.capacity must not echo its request back');
  assert.strictEqual(pending.requested, '10Gi');
  assert.strictEqual(bound.capacity, '20Gi');
});

test('storage.collect: an absent storageClassName is null, not the literal "default"', async () => {
  const listFn = listFor({
    persistentvolumeclaims: [
      {
        metadata: { name: 'no-class', namespace: 'prod' },
        spec: { resources: { requests: { storage: '1Gi' } } },
        status: { phase: 'Pending' }
      },
      {
        metadata: { name: 'really-default', namespace: 'prod' },
        spec: { storageClassName: 'default', resources: { requests: { storage: '1Gi' } } },
        status: { phase: 'Bound', capacity: { storage: '1Gi' } }
      },
      {
        metadata: { name: 'explicitly-empty', namespace: 'prod' },
        spec: { storageClassName: '', resources: { requests: { storage: '1Gi' } } },
        status: { phase: 'Pending' }
      }
    ]
  });
  const result = await storage.collect({ cluster, token: 't', listFn });
  assert.strictEqual(result.pvcs[0].storageClass, null);
  // The collision the old literal caused: a StorageClass genuinely named `default` was
  // indistinguishable from a claim that named none.
  assert.strictEqual(result.pvcs[1].storageClass, 'default');
  assert.strictEqual(result.pvcs[2].storageClass, '');
});

test('storage.collect: an unreconciled quota dimension reports null usage, not 0', async () => {
  const listFn = listFor({
    resourcequotas: [
      {
        metadata: { name: 'fresh', namespace: 'prod' },
        spec: { hard: { 'requests.cpu': '4', 'requests.memory': '8Gi' } },
        status: {}
      }
    ]
  });
  const result = await storage.collect({ cluster, token: 't', listFn });
  const q = result.quotas[0];
  assert.strictEqual(q.usedReported, false);
  assert.deepStrictEqual(
    q.dimensions.map(d => [d.dimension, d.used]),
    [
      ['requests.cpu', null],
      ['requests.memory', null]
    ]
  );
  assert.ok(!q.dimensions.some(d => d.used === '0'), 'a dimension with no reported usage must not read 0');
});

test('storage.collect: a dimension the quota does not mention has hard null, not "unlimited"', async () => {
  const listFn = listFor({
    resourcequotas: [
      {
        metadata: { name: 'partial', namespace: 'prod' },
        spec: {},
        status: { hard: { 'requests.cpu': '4' }, used: { 'requests.cpu': '1', pods: '7' } }
      }
    ]
  });
  const result = await storage.collect({ cluster, token: 't', listFn });
  const pods = result.quotas[0].dimensions.find(d => d.dimension === 'pods');
  assert.strictEqual(pods.hard, null);
  assert.strictEqual(pods.used, '7');
  assert.ok(
    !JSON.stringify(result.quotas).includes('unlimited'),
    '"unlimited" claims an enforced absence of a limit; not mentioning a resource is not that claim'
  );
});

test('storage.collect: hardSource separates an enforced quota from a merely configured one', async () => {
  const enforced = await storage.collect({
    cluster,
    token: 't',
    listFn: listFor({
      resourcequotas: [
        { metadata: { name: 'live', namespace: 'p' }, spec: { hard: { pods: '10' } }, status: { hard: { pods: '10' }, used: { pods: '1' } } }
      ]
    })
  });
  assert.strictEqual(enforced.quotas[0].hardSource, 'enforced');

  const configured = await storage.collect({
    cluster,
    token: 't',
    listFn: listFor({ resourcequotas: [{ metadata: { name: 'asked', namespace: 'p' }, spec: { hard: { pods: '10' } }, status: {} }] })
  });
  assert.strictEqual(configured.quotas[0].hardSource, 'configured');
  assert.strictEqual(configured.quotas[0].dimensions[0].hard, '10');

  const neither = await storage.collect({
    cluster,
    token: 't',
    listFn: listFor({ resourcequotas: [{ metadata: { name: 'empty', namespace: 'p' }, spec: {}, status: {} }] })
  });
  assert.strictEqual(neither.quotas[0].hardSource, null);
});

// ------------------------------------------------------------------ the rendering, read as source

const TAB = path.join(__dirname, '..', '..', 'app', 'fleet-ui', 'src', 'pages', 'cluster-tabs', 'StorageTab.tsx');

