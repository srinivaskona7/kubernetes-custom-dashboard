/**
 * The Bound capacity column has to sort as a quantity, not as text.
 *
 * `512Mi` sorts above `5Gi` as a string and below it as a size, and for one release the new column
 * sorted the raw Kubernetes quantity — the exact bug the Requested column next to it documents and
 * avoids. The collector now publishes `capacityBytes` beside the string, and the table sorts on it.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import storage from '../collectors/storage.js';

const __dirname = import.meta.dirname;

const cluster = { id: 'c1', displayName: 'C1', env: 'sbx', apiUrl: 'https://api.example' };

function pvc(name, requested, capacity) {
  return {
    metadata: { name, namespace: 'prod' },
    spec: { storageClassName: 'premium', resources: { requests: { storage: requested } } },
    status: capacity ? { phase: 'Bound', capacity: { storage: capacity } } : { phase: 'Pending' }
  };
}

async function collect(items) {
  const listFn = async ({ path: p }) => (p.includes('persistentvolumeclaims') ? items : []);
  const result = await storage.collect({ cluster, token: 't', listFn });
  return result.pvcs;
}

test('storage.collect: a bound capacity carries its size in bytes for sorting', async () => {
  const rows = await collect([pvc('small', '512Mi', '512Mi'), pvc('big', '4Gi', '4Gi')]);
  const small = rows.find(r => r.name === 'small');
  const big = rows.find(r => r.name === 'big');
  assert.equal(small.capacity, '512Mi');
  assert.equal(big.capacity, '4Gi');
  assert.equal(small.capacityBytes, 512 * 1024 * 1024);
  assert.equal(big.capacityBytes, 4 * 1024 * 1024 * 1024);
  assert.ok(small.capacityBytes < big.capacityBytes, '512Mi must rank below 4Gi');
  assert.ok(small.capacity > big.capacity, 'the string form ranks 512Mi above 4Gi — hence the field');
});

test('storage.collect: an unbound claim has no capacityBytes, not a zero', async () => {
  const [row] = await collect([pvc('pending', '10Gi', null)]);
  assert.equal(row.capacity, null);
  assert.equal(row.capacityBytes, null);
});

