
/**
 * Pod counts on the namespace audit.
 *
 * The audit itself is covered elsewhere; this file covers only the fifth read that was added to
 * it, and the two ways its answer can be wrong in a way that still looks like a number:
 *
 *  1. A namespace with no pods and a namespace we could not read are different answers. The first
 *     is 0, the second is null, and they must never converge.
 *  2. A truncated pod list is the dangerous one — the pods are real, the list is short, and there
 *     is no way to know which namespace lost rows. Every count goes null, not just some.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import compliance from '../collectors/compliance.js';
const { podCounts } = compliance;

const ok = (items, truncated = false) => ({ label: 'pods', items, unavailable: false, truncated });
const pod = namespace => ({ metadata: { name: `p-${Math.abs(namespace.length)}`, namespace } });

test('counts pods per namespace from a successful read', () => {
  const { counts, reason } = podCounts(ok([pod('a'), pod('a'), pod('b')]));
  assert.equal(reason, null);
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.get('b'), 1);
});

test('a namespace with no pods is absent from the map, which the caller reads as a true zero', () => {
  const { counts } = podCounts(ok([pod('a')]));
  assert.equal(counts.has('empty'), false);
  assert.equal(counts.get('empty') || 0, 0);
});

test('a refused pod list yields no counts at all, never zeros', () => {
  const { counts, reason } = podCounts({ label: 'pods', items: [], unavailable: true, truncated: false });
  assert.equal(counts, null, 'a refused read must not produce a count map — every namespace would read 0');
  assert.equal(reason, 'unavailable');
});

test('a truncated pod list yields no counts, because the shortfall cannot be attributed', () => {
  const { counts, reason } = podCounts(ok([pod('a'), pod('a')], true));
  assert.equal(
    counts,
    null,
    'the pods that did arrive are real, so the temptation is to count them. They are an ' +
      'undercount of an unknown namespace, and printed as a number they are indistinguishable ' +
      'from the truth.'
  );
  assert.equal(reason, 'truncated');
});

test('a pod with no namespace on its metadata is skipped rather than counted under undefined', () => {
  const { counts } = podCounts(ok([{ metadata: {} }, {}, null, pod('a')]));
  assert.equal(counts.size, 1);
  assert.equal(counts.get('a'), 1);
});

test('collect puts a pod count on every row and reads pods metadata-only', async () => {
  const seen = [];
  const listFn = async ({ path, accept }) => {
    seen.push({ path, accept: accept || null });
    if (path === '/api/v1/namespaces') {
      return [{ metadata: { name: 'app', labels: {} } }, { metadata: { name: 'kube-system', labels: {} } }];
    }
    if (path === '/api/v1/pods') return [pod('app'), pod('app'), pod('kube-system')];
    return [];
  };

  const out = await compliance.collect({ cluster: { id: 'c1' }, token: 't', listFn });
  const byName = Object.fromEntries(out.namespaces.map(r => [r.namespace, r]));
  assert.equal(byName.app.pods, 2);
  assert.equal(byName['kube-system'].pods, 1, 'system namespaces are marked, not excluded from the count');
  assert.equal(out.summary.podCountReason, null);

  const podRead = seen.find(s => s.path === '/api/v1/pods');
  assert.ok(podRead, 'collect no longer reads the pod list, so no row can carry a count');
  assert.match(
    podRead.accept || '',
    /PartialObjectMetadataList/,
    'the cluster-wide pod list is the largest read in this console and a count needs only the ' +
      'namespace field. Without the metadata-only Accept header this made the namespace audit ' +
      'the most expensive route on the server.'
  );
});

test('collect reports null counts and a reason when the pod list is refused', async () => {
  const listFn = async ({ path }) => {
    if (path === '/api/v1/namespaces') return [{ metadata: { name: 'app', labels: {} } }];
    if (path === '/api/v1/pods') throw Object.assign(new Error('forbidden'), { status: 403 });
    return [];
  };

  const out = await compliance.collect({ cluster: { id: 'c1' }, token: 't', listFn });
  assert.equal(out.namespaces[0].pods, null);
  assert.equal(out.summary.podCountReason, 'unavailable');
  assert.deepEqual(
    out.summary.unavailable,
    [],
    'a refused pod list must not be reported as an incomplete bootstrap audit — the audit read ' +
      'everything it needs, and folding this in would turn every compliance verdict amber.'
  );
});
