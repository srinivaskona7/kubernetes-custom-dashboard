/**
 * Metrics.
 *
 * metrics.k8s.io is an optional add-on, so the contract this suite defends is that its
 * absence degrades one panel and never fails a page. Every failure mode — not installed,
 * not yet answering, not permitted — must come back as `available: false` with a reason
 * an operator can act on, not as a thrown error that takes the cluster overview with it.
 *
 * The quantity parsers get their own tests because the units are the kind of thing that
 * looks right and is off by a thousand: nanocores are what metrics-server actually
 * reports, and reading them as millicores makes a busy cluster look idle.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import metrics from '../collectors/metrics.js';
import _errors from '../errors.js';
const { ClusterError } = _errors;

const CLUSTER = { id: 'platformsbx', apiUrl: 'https://api.example.com' };

// ------------------------------------------------------------------- quantities

test('CPU quantities parse into cores across every unit the API server uses', () => {
  assert.equal(metrics.parseCpu('1'), 1);
  assert.equal(metrics.parseCpu('2500m'), 2.5);
  assert.equal(metrics.parseCpu('1500u'), 0.0015);
  // Nanocores are what metrics-server reports for pods. Getting this wrong by 10^6 is the
  // difference between a cluster that looks idle and one that is saturated.
  assert.equal(metrics.parseCpu('250000000n'), 0.25);
  assert.equal(metrics.parseCpu(undefined), 0);
  assert.equal(metrics.parseCpu(null), 0);
});

test('memory quantities parse into bytes for both binary and decimal suffixes', () => {
  assert.equal(metrics.parseMemory('1Ki'), 1024);
  assert.equal(metrics.parseMemory('512Mi'), 512 * 1024 ** 2);
  assert.equal(metrics.parseMemory('2Gi'), 2 * 1024 ** 3);
  assert.equal(metrics.parseMemory('1M'), 1e6);
  assert.equal(metrics.parseMemory('1024'), 1024);
  assert.equal(metrics.parseMemory(undefined), 0);
});

// ---------------------------------------------------------------------- podUsage

const POD_METRIC = {
  metadata: { name: 'api-0', namespace: 'shop' },
  timestamp: '2026-08-31T10:00:00Z',
  containers: [
    { name: 'srv', usage: { cpu: '250000000n', memory: '256Mi' } },
    { name: 'istio-proxy', usage: { cpu: '10m', memory: '64Mi' } }
  ]
};

test('pod usage sums its containers and keeps the per-container breakdown', async () => {
  const out = await metrics.podUsage({ cluster: CLUSTER, token: 't', listFn: async () => [POD_METRIC] });
  assert.equal(out.available, true);
  const pod = out.pods['shop/api-0'];
  assert.ok(Math.abs(pod.cpu - 0.26) < 1e-9);
  assert.equal(pod.memory, 320 * 1024 ** 2);
  assert.equal(pod.containers.length, 2);
  assert.equal(pod.containers[0].name, 'srv');
});

test('a namespace scopes the request rather than being filtered client-side', async () => {
  let seen = null;
  await metrics.podUsage({
    cluster: CLUSTER, token: 't', namespace: 'shop',
    listFn: async args => { seen = args.path; return []; }
  });
  assert.equal(seen, '/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods');
});

test('a cluster without metrics-server degrades, it does not throw', async () => {
  const listFn = async () => {
    throw new ClusterError('UPSTREAM', 'the server could not find the requested resource', { cluster: CLUSTER.id, status: 404 });
  };
  const out = await metrics.podUsage({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.available, false);
  assert.match(out.reason, /not installed/);
  assert.deepEqual(out.pods, {});
});

test('metrics-server still warming up is reported as such, not as missing', async () => {
  const listFn = async () => {
    throw new ClusterError('UPSTREAM', 'service unavailable', { cluster: CLUSTER.id, status: 503 });
  };
  const out = await metrics.podUsage({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.available, false);
  assert.match(out.reason, /not answering yet/);
});

test('a missing RBAC rule names the role that needs it', async () => {
  const listFn = async () => {
    throw new ClusterError('FORBIDDEN', 'forbidden', { cluster: CLUSTER.id, status: 403 });
  };
  const out = await metrics.podUsage({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.available, false);
  assert.match(out.reason, /fleet-reader/);
});

test('an unrecognised failure still yields a reason rather than "undefined"', async () => {
  const listFn = async () => { throw new Error('socket hang up'); };
  const out = await metrics.podUsage({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.available, false);
  assert.equal(out.reason, 'socket hang up');
});

// --------------------------------------------------------------------- nodeUsage

test('node usage is keyed by node name', async () => {
  const listFn = async () => [
    { metadata: { name: 'node-a' }, usage: { cpu: '1500m', memory: '4Gi' }, timestamp: '2026-08-31T10:00:00Z' }
  ];
  const out = await metrics.nodeUsage({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.available, true);
  assert.equal(out.nodes['node-a'].cpu, 1.5);
  assert.equal(out.nodes['node-a'].memory, 4 * 1024 ** 3);
});

test('node usage degrades the same way pod usage does', async () => {
  const listFn = async () => {
    throw new ClusterError('UPSTREAM', 'not found', { cluster: CLUSTER.id, status: 404 });
  };
  const out = await metrics.nodeUsage({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.available, false);
  assert.deepEqual(out.nodes, {});
});

test('a metric entry with no usage block contributes zero rather than NaN', async () => {
  const listFn = async () => [{ metadata: { name: 'node-a' } }];
  const out = await metrics.nodeUsage({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.nodes['node-a'].cpu, 0);
  assert.equal(out.nodes['node-a'].memory, 0);
});
