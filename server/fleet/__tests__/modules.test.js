/**
 * modules.js: Kyma module inventory and version-currency joins.
 *
 * Canaries stated per test — each one names the exact assertion that would go red if the
 * fix under test were reverted.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import modules from '../collectors/modules.js';
import _errors from '../errors.js';
const { ClusterError } = _errors;

const cluster = { id: 'test-cluster', displayName: 'Test', env: 'dev' };

function kyma(overrides = {}) {
  return {
    metadata: { name: 'default', namespace: 'kyma-system' },
    spec: { channel: 'regular', modules: [{ name: 'istio', channel: 'regular' }] },
    status: {
      state: 'Ready',
      modules: [{ name: 'istio', channel: 'regular', version: '1.9.11', state: 'Ready' }]
    },
    ...overrides
  };
}

function mrm(module, entries) {
  return { spec: { module, channels: entries.map(([channel, version]) => ({ channel, version })) } };
}

function forbidden() {
  return new ClusterError('FORBIDDEN', 'forbidden', { status: 403 });
}
function notFound() {
  return new ClusterError('UPSTREAM', 'not found', { status: 404 });
}

function makeListFn(byPath) {
  return async ({ path }) => {
    for (const [match, outcome] of byPath) {
      if (path.includes(match)) {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
    }
    throw new Error(`unexpected path ${path}`);
  };
}

/** A discovery-probe double: GET /apis/<group> resolves to a served-versions body. */
function discoveryCallFn(servedGroups) {
  return async ({ path }) => {
    const group = path.replace('/apis/', '');
    if (!(group in servedGroups)) throw new ClusterError('UPSTREAM', 'not found', { status: 404 });
    return { versions: servedGroups[group].map(v => ({ version: v })) };
  };
}

test('compareVersions compares segment-wise, not lexicographically', () => {
  // Canary: a naive string compare says '1.9.11' > '1.10.0' because '9' > '1' as characters.
  // Fix: numeric segment compare says the opposite, correctly.
  assert.equal(modules.compareVersions('1.9.11', '1.10.0'), -1);
  assert.equal(modules.compareVersions('1.10.0', '1.9.11'), 1);
  assert.equal(modules.compareVersions('2.0.0', '2.0.0'), 0);
});

test('compareVersions returns null, never a guessed direction, on unparseable input', () => {
  assert.equal(modules.compareVersions('not-a-version', '1.0.0'), null);
  assert.equal(modules.currencyOf('not-a-version', '1.0.0'), null);
});

test('currencyOf: behind | current | ahead, exactly those three values', () => {
  assert.equal(modules.currencyOf('1.9.0', '1.10.0'), 'behind');
  assert.equal(modules.currencyOf('1.10.0', '1.10.0'), 'current');
  assert.equal(modules.currencyOf('1.11.0', '1.10.0'), 'ahead');
});

test('joinModules keeps a module present only in status (removed from spec, not yet GC-ed)', () => {
  const k = kyma({
    spec: { channel: 'regular', modules: [] },
    status: { modules: [{ name: 'istio', channel: 'regular', version: '1.9.0', state: 'Deleting' }] }
  });
  const joined = modules.joinModules(k);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].managed, false);
});

test('joinModules keeps a module present only in spec (requested, not yet reconciled)', () => {
  const k = kyma({
    spec: { channel: 'regular', modules: [{ name: 'keda', channel: 'fast' }] },
    status: { modules: [] }
  });
  const joined = modules.joinModules(k);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].managed, true);
  assert.equal(joined[0].version, null);
});

test('collect: an empty kymas list on a served CRD is kymaManaged:null, never "0 modules"', async () => {
  // Canary: reporting kymaManaged as anything but null here (e.g. false, or omitting the
  // field) would let a genuinely anomalous cluster render as a clean, healthy Kyma install
  // with nothing installed — indistinguishable from good news.
  const listFn = makeListFn([
    ['kymas', notFound()],
    ['modulereleasemetas', []]
  ]);
  const callFn = discoveryCallFn({ 'operator.kyma-project.io': ['v1beta2'] });
  const result = await modules.collect({ cluster, token: 't', listFn, callFn });
  assert.equal(result.summary.kymaManaged, null);
  assert.equal(result.summary.kymaCount, 0);
  assert.ok(result.summary.unreadableReason);
  assert.equal(result.summary.unreadableReason.detail, 'CRD served, no Kyma CR exists');
});

test('collect: a 404 on kymas AND on the group itself is a true zero, not an anomaly', async () => {
  // Canary: without the group-discovery probe distinguishing this from the case above, a
  // genuinely non-Kyma cluster (CRD not registered at all) would also be flagged as the
  // anomaly, which is a false positive on every ordinary non-Kyma cluster in the fleet.
  const listFn = makeListFn([
    ['kymas', notFound()],
    ['modulereleasemetas', notFound()]
  ]);
  const callFn = discoveryCallFn({}); // no groups served -> /apis/operator.kyma-project.io 404s too
  const result = await modules.collect({ cluster, token: 't', listFn, callFn });
  assert.equal(result.summary.kymaManaged, false);
  assert.equal(result.summary.unreadableReason, null);
  assert.deepEqual(result.summary.unavailable, []);
});

test('collect: a 403 on kymas is unavailable, never a fabricated count', async () => {
  // Canary: swapping the classify() branch to treat FORBIDDEN as a trueZero would make this
  // assert.equal(unavailable, []) pass and kymaManaged stay non-null, which is the bug this
  // whole repo's contract exists to prevent.
  const listFn = makeListFn([
    ['kymas', forbidden()],
    ['modulereleasemetas', []]
  ]);
  const result = await modules.collect({ cluster, token: 't', listFn });
  assert.equal(result.summary.kymaManaged, null);
  assert.deepEqual(result.summary.unavailable, ['kymas']);
  assert.equal(result.kymas.length, 0);
});

test('collect: full join produces a currency verdict per module against the channel catalog', async () => {
  const listFn = makeListFn([
    ['kymas', [kyma()]],
    ['modulereleasemetas', [mrm('istio', [['regular', '1.10.0']])]]
  ]);
  const result = await modules.collect({ cluster, token: 't', listFn });
  assert.equal(result.summary.kymaManaged, true);
  assert.equal(result.kymas.length, 1);
  const istio = result.kymas[0].modules.find(m => m.name === 'istio');
  assert.equal(istio.catalogVersion, '1.10.0');
  // Installed 1.9.11 vs catalog 1.10.0: behind. This is exactly the segment-wise case that
  // a lexicographic compare would get backwards.
  assert.equal(istio.currency, 'behind');
});

test('collect: resource projection carries only apiVersion/kind/metadata{name,namespace}', async () => {
  const listFn = makeListFn([
    ['kymas', [kyma()]],
    ['modulereleasemetas', []]
  ]);
  const result = await modules.collect({ cluster, token: 't', listFn });
  const resource = result.kymas[0].resource;
  assert.deepEqual(Object.keys(resource).sort(), ['apiVersion', 'kind', 'metadata']);
  assert.deepEqual(Object.keys(resource.metadata).sort(), ['name', 'namespace']);
  assert.equal(resource.kind, 'Kyma');
});
