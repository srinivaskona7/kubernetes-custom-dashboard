
/**
 * When attribution never ran, its counters are unknown — not clean.
 *
 * The pod list is what attribution rides on. With it refused, the collector published
 * `unattributedNamespaces: 0`, which asserts "every namespace was weighed against allocatable" on
 * a path where none was. `unavailable: ['pods']` carried the truth beside a field that contradicted
 * it; the field is `null` now and the tab says the count is not reported.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';

import _cost from '../collectors/cost.js';
const { collect } = _cost;

function node() {
  return {
    metadata: { name: 'n1', labels: { 'node.kubernetes.io/instance-type': 'm5.2xlarge' } },
    spec: { providerID: 'aws:///us-east-1a/i-0abc' },
    status: {
      capacity: { cpu: '8', memory: '32Gi', pods: '110' },
      allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
      conditions: [{ type: 'Ready', status: 'True' }]
    }
  };
}

function listFn(podsFail) {
  return async ({ path: p }) => {
    if (p.startsWith('/api/v1/nodes')) return [node()];
    if (p.startsWith('/api/v1/pods')) {
      if (podsFail) {
        const err = new Error('forbidden');
        err.status = 403;
        throw err;
      }
      return [];
    }
    const err = new Error('no metrics');
    err.status = 404;
    throw err;
  };
}

test('a refused pod list leaves the unweighed-namespace count unreported, never 0', async () => {
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn: listFn(true), env: {} });
  assert.equal(out.summary.unattributedNamespaces, null);
  assert.equal(out.unallocated.sharePct, null);
  assert.equal(out.unallocated.monthlyUsd, null);
  assert.deepEqual(out.attribution, []);
  assert.ok(
    (out.summary.unavailable || []).some(u => /pod/i.test(u.label || u)),
    'and the refused read is still named'
  );
});

test('with the pod list read, a fully weighed cluster still reports 0 as the real count', async () => {
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn: listFn(false), env: {} });
  assert.equal(out.summary.unattributedNamespaces, 0);
});
