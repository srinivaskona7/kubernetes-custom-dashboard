
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _workloads from '../collectors/workloads.js';
const { readiness, collect } = _workloads;
import _k8s2 from '../k8s.js';
const { normaliseNamespaces, MAX_NAMESPACE_SELECTION } = _k8s2;

test('readiness() reads DaemonSet health from desiredNumberScheduled/numberReady, not spec.replicas', () => {
  // Real shape from platformsbx: a DaemonSet has neither spec.replicas nor
  // status.readyReplicas at all.
  const healthy = {
    spec: {},
    status: { desiredNumberScheduled: 3, numberReady: 3 }
  };
  assert.deepEqual(readiness(healthy, 'DaemonSet'), {
    kind: 'DaemonSet', desired: 3, ready: 3, state: 'Ready'
  });

  const degraded = {
    spec: {},
    status: { desiredNumberScheduled: 3, numberReady: 1 }
  };
  assert.equal(readiness(degraded, 'DaemonSet').state, 'Progressing');

  const none = {
    spec: {},
    status: { desiredNumberScheduled: 0, numberReady: 0 }
  };
  assert.equal(readiness(none, 'DaemonSet').state, 'Scaled to zero');
});

test('readiness() still reads Deployment/StatefulSet health from spec.replicas/status.readyReplicas', () => {
  const deployment = { spec: { replicas: 2 }, status: { readyReplicas: 2 } };
  assert.deepEqual(readiness(deployment, 'Deployment'), {
    kind: 'Deployment', desired: 2, ready: 2, state: 'Ready'
  });

  // spec.replicas omitted defaults to 1, per Kubernetes' own default — unrelated to the
  // DaemonSet fix and must not regress.
  const implicitOne = { spec: {}, status: { readyReplicas: 1 } };
  assert.equal(readiness(implicitOne, 'StatefulSet').desired, 1);
});

// ------------------------------------------------- namespace sets: normalisation and OR reads

const CLUSTER = { id: 'c1', apiUrl: 'https://example.invalid' };

function template(name) {
  return { metadata: { labels: { app: name } }, spec: { containers: [{ name: 'main', image: `reg/${name}:1` }] } };
}

function deployment(namespace, name) {
  return {
    metadata: { namespace, name, creationTimestamp: '2026-01-01T00:00:00Z', generation: 1 },
    spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: template(name) },
    status: { readyReplicas: 1, availableReplicas: 1, observedGeneration: 1 }
  };
}

function daemonset(namespace, name) {
  return {
    metadata: { namespace, name, creationTimestamp: '2026-01-01T00:00:00Z', generation: 1 },
    spec: { selector: { matchLabels: { app: name } }, template: template(name) },
    status: { desiredNumberScheduled: 1, numberReady: 1, observedGeneration: 1 }
  };
}

function pod(namespace, name, app) {
  return {
    metadata: { namespace, name, labels: { app } },
    spec: { nodeName: 'node-a', containers: [{ name: 'main', image: `reg/${app}:1` }] },
    status: {
      phase: 'Running',
      containerStatuses: [{ name: 'main', ready: true, restartCount: 0, state: { running: {} } }]
    }
  };
}

/**
 * A `listFn` standing in for the apiserver, answering from a per-namespace fixture and
 * recording every path it was asked for. The recorded paths are the assertion that matters
 * most here: they are the only evidence that the collector filtered at the SOURCE rather than
 * reading the cluster and discarding rows.
 *
 * `fail` names `{namespace, resource}` reads that throw a 403-shaped error instead — the shape
 * `safeList` must classify as FORBIDDEN rather than as a true zero. `truncate` names reads that
 * succeed but come back marked at the paging ceiling, which `k8s.list` signals with a
 * non-enumerable `truncated` and which must never be folded into `unavailable`.
 */
function listDouble(byNamespace, { fail = [], truncate = [] } = {}) {
  const paths = [];
  const failed = new Set(fail.map(f => `${f.namespace}/${f.resource}`));
  const short = new Set(truncate.map(f => `${f.namespace}/${f.resource}`));

  const listFn = async ({ path }) => {
    paths.push(path);
    if (path.includes('metrics.k8s.io')) return [];

    const scope = /\/namespaces\/([^/]+)\//.exec(path);
    const namespace = scope ? decodeURIComponent(scope[1]) : null;
    const resource = path.split('?')[0].split('/').pop();
    const key = `${namespace}/${resource}`;

    if (failed.has(key)) {
      const err = new Error(`${resource} is forbidden: User cannot list ${resource} in namespace ${namespace}`);
      err.status = 403;
      throw err;
    }

    const items = namespace === null
      ? Object.values(byNamespace).flatMap(b => b[resource] || [])
      : (byNamespace[namespace] || {})[resource] || [];
    const out = items.slice();
    if (short.has(key)) Object.defineProperty(out, 'truncated', { value: true });
    return out;
  };

  return { listFn, paths };
}

test('normaliseNamespaces() dedupes and sorts, so one set is one cache key however it was sent', () => {
  assert.deepEqual(normaliseNamespaces(undefined), []);
  assert.deepEqual(normaliseNamespaces(''), []);
  assert.deepEqual(normaliseNamespaces('kyma-system'), ['kyma-system']);

  // Repeated ?namespace= keys (what Express hands a handler) and a comma-separated value are
  // the same question, and the order the browser chose must not reach the cache key.
  assert.deepEqual(normaliseNamespaces(['b', 'a']), ['a', 'b']);
  assert.deepEqual(normaliseNamespaces('b,a'), ['a', 'b']);
  assert.deepEqual(normaliseNamespaces(['b', 'a,b', ' a ']), ['a', 'b']);
  assert.equal(
    normaliseNamespaces(['b', 'a']).join(','),
    normaliseNamespaces(['a', 'b']).join(',')
  );
});

test('normaliseNamespaces() refuses anything that is not a namespace name, before it reaches a URL', () => {
  for (const bad of [
    '../../../apis/rbac.authorization.k8s.io/v1/clusterroles',
    '..',
    'Kyma-System',            // uppercase is not a DNS-1123 label, so no cluster can answer it
    'kyma system',
    'kyma-system?watch=true', // would ride into the query string of a request we wrote
    'a'.repeat(64),
    '-leading',
    'trailing-'
  ]) {
    assert.throws(
      () => normaliseNamespaces(bad),
      err => err.status === 400,
      `expected "${bad}" to be refused with a 400`
    );
  }

  // The cap bounds the fan-out; a selection exactly at it is still served.
  const atCap = Array.from({ length: MAX_NAMESPACE_SELECTION }, (_, i) => `ns-${i}`);
  assert.equal(normaliseNamespaces(atCap).length, MAX_NAMESPACE_SELECTION);
  assert.throws(() => normaliseNamespaces([...atCap, 'one-too-many']), err => err.status === 400);
});

test('collect() over two namespaces reads each one at the source and ORs the rows', async () => {
  const { listFn, paths } = listDouble({
    alpha: { deployments: [deployment('alpha', 'a-api')], pods: [pod('alpha', 'a-api-1', 'a-api')] },
    beta: { daemonsets: [daemonset('beta', 'b-agent')], pods: [pod('beta', 'b-agent-1', 'b-agent')] },
    gamma: { deployments: [deployment('gamma', 'g-never')], pods: [pod('gamma', 'g-never-1', 'g-never')] }
  });

  const out = await collect({ cluster: CLUSTER, token: 't', namespace: ['beta', 'alpha'], listFn });

  assert.deepEqual([...new Set(out.items.map(i => i.namespace))].sort(), ['alpha', 'beta']);
  assert.deepEqual(out.items.map(i => i.name).sort(), ['a-api', 'b-agent']);
  assert.equal(out.summary.total, 2);
  assert.equal(out.summary.pods, 2);
  assert.deepEqual(out.summary.unavailable, []);
  assert.deepEqual(out.summary.truncated, []);

  // gamma was never selected, so it was never read. This is the difference between filtering
  // at the source and reading the cluster to throw most of it away.
  assert.ok(!paths.some(p => p.includes('/namespaces/gamma/')), paths.join('\n'));
  assert.deepEqual(
    paths.filter(p => !p.includes('metrics.k8s.io') && !p.includes('/namespaces/')),
    [],
    'a namespace set must not issue a cluster-wide list for any of the four object types'
  );
});

test('collect() reports a namespace whose read failed as unavailable, never as fewer rows', async () => {
  const fixture = {
    alpha: { deployments: [deployment('alpha', 'a-api')], pods: [pod('alpha', 'a-api-1', 'a-api')] },
    beta: { deployments: [deployment('beta', 'b-api')], pods: [pod('beta', 'b-api-1', 'b-api')] }
  };

  const complete = await collect({
    cluster: CLUSTER, token: 't', namespace: ['alpha', 'beta'], listFn: listDouble(fixture).listFn
  });
  assert.equal(complete.summary.total, 2);
  assert.deepEqual(complete.summary.unavailable, []);

  const { listFn } = listDouble(fixture, { fail: [{ namespace: 'beta', resource: 'deployments' }] });
  const degraded = await collect({ cluster: CLUSTER, token: 't', namespace: ['alpha', 'beta'], listFn });

  // A row count of 1 is indistinguishable from "beta holds no workloads", which is the exact
  // lie safe-list exists to prevent — arriving one level up, from the fan-out rather than from
  // a single read. The label is the only thing that says otherwise, and it has to name the
  // namespace for an operator to be able to act on it.
  assert.equal(degraded.summary.total, 1);
  assert.deepEqual(degraded.summary.unavailable, ['deployments[ns=beta]']);
  assert.deepEqual(degraded.summary.truncated, []);
  // alpha still answers: one namespace's denial must not fail the whole selection.
  assert.deepEqual(degraded.items.map(i => i.namespace), ['alpha']);
});

test('collect() keeps a truncated namespace read out of unavailable and in truncated', async () => {
  const fixture = {
    alpha: { deployments: [deployment('alpha', 'a-api')], pods: [pod('alpha', 'a-api-1', 'a-api')] },
    beta: { deployments: [deployment('beta', 'b-api')], pods: [pod('beta', 'b-api-1', 'b-api')] }
  };
  const { listFn } = listDouble(fixture, { truncate: [{ namespace: 'beta', resource: 'pods' }] });
  const out = await collect({ cluster: CLUSTER, token: 't', namespace: ['alpha', 'beta'], listFn });

  // The read happened and its rows are real, so the counts are a floor rather than an em-dash.
  assert.deepEqual(out.summary.truncated, ['pods[ns=beta]']);
  assert.deepEqual(out.summary.unavailable, []);
  assert.equal(out.summary.total, 2);
});

test('collect() for one namespace, or none, keeps the unsuffixed labels and the scope it was given', async () => {
  const fixture = { alpha: { deployments: [deployment('alpha', 'a-api')], pods: [] } };

  const one = listDouble(fixture, { fail: [{ namespace: 'alpha', resource: 'pods' }] });
  const scoped = await collect({ cluster: CLUSTER, token: 't', namespace: 'alpha', listFn: one.listFn });
  // Unsuffixed, because every existing consumer of `unavailable` matches on this vocabulary and
  // a single-namespace payload must stay byte-identical to what it was before namespace sets.
  assert.deepEqual(scoped.summary.unavailable, ['pods']);
  assert.ok(one.paths.every(p => p.includes('/namespaces/alpha/')), one.paths.join('\n'));
  // One metrics read, scoped to the single namespace, exactly as before.
  assert.deepEqual(
    one.paths.filter(p => p.includes('metrics.k8s.io')),
    ['/apis/metrics.k8s.io/v1beta1/namespaces/alpha/pods']
  );

  const all = listDouble(fixture, { fail: [{ namespace: null, resource: 'pods' }] });
  const wide = await collect({ cluster: CLUSTER, token: 't', listFn: all.listFn });
  assert.deepEqual(wide.summary.unavailable, ['pods']);
  assert.ok(all.paths.every(p => !p.includes('/namespaces/')), all.paths.join('\n'));
});

test('collect() makes exactly one metrics read for a namespace set, not one per namespace', async () => {
  const fixture = {
    alpha: { deployments: [deployment('alpha', 'a-api')], pods: [] },
    beta: { deployments: [deployment('beta', 'b-api')], pods: [] }
  };
  const { listFn, paths } = listDouble(fixture);
  await collect({ cluster: CLUSTER, token: 't', namespace: ['alpha', 'beta'], listFn });

  // `podUsage` answers with a single {available, reason} verdict, and N per-namespace verdicts
  // have no honest merge — see the note at the call site.
  assert.deepEqual(
    paths.filter(p => p.includes('metrics.k8s.io')),
    ['/apis/metrics.k8s.io/v1beta1/pods']
  );
});
