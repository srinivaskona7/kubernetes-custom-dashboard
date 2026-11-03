/**
 * Two workload-collector lies, pinned.
 *
 *   1. a Deployment's `state` used to be the crashing *container's* waiting reason, so the cell
 *      reserved for Ready/Progressing/Unavailable read `CrashLoopBackOff` — a string no
 *      Deployment ever reports, naming neither the pod nor the container it came from.
 *   2. `events` was a bare array read through raw `list`, so a 403 on events threw inside
 *      /overview's Promise.all and failed health, compliance and workloads with it — and the
 *      UI's `unavailableEntries` could never fire on an array.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import _workloads from '../collectors/workloads.js';
const { collect, events } = _workloads;

const __dirname = import.meta.dirname;

const CLUSTER = { id: 'c1', apiUrl: 'https://example.invalid' };

function deployment(namespace, name, { replicas = 2, readyReplicas = 0 } = {}) {
  return {
    metadata: { namespace, name, creationTimestamp: '2026-01-01T00:00:00Z', generation: 1 },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: 'main', image: `reg/${name}:1` }] } }
    },
    status: { readyReplicas, availableReplicas: readyReplicas, observedGeneration: 1 }
  };
}

function crashingPod(namespace, name, app, container = 'main') {
  return {
    metadata: { namespace, name, labels: { app } },
    spec: { nodeName: 'node-a', containers: [{ name: container, image: `reg/${app}:1` }] },
    status: {
      phase: 'Running',
      containerStatuses: [{
        name: container,
        ready: false,
        restartCount: 7,
        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } }
      }]
    }
  };
}

function listDouble({ deployments = [], pods = [] }) {
  return async ({ path: p }) => {
    if (p.includes('metrics.k8s.io')) return [];
    if (p.includes('/deployments')) return deployments;
    if (p.includes('/pods')) return pods;
    return [];
  };
}

test('a Deployment state is a Deployment state; the container reason is attributed in podIssues', async () => {
  const listFn = listDouble({
    deployments: [deployment('alpha', 'api', { replicas: 2, readyReplicas: 1 })],
    pods: [crashingPod('alpha', 'api-1', 'api'), crashingPod('alpha', 'api-2', 'api', 'sidecar')]
  });
  const out = await collect({ cluster: CLUSTER, token: 't', namespace: 'alpha', listFn });
  const row = out.items.find(w => w.name === 'api');

  assert.equal(row.state, 'Progressing');
  assert.ok(!/CrashLoopBackOff/.test(row.state), 'the controller state slot must never hold a container reason');

  // The diagnosis is not lost: it is reported with the pods and containers that carry it, which
  // is what lets the row render "Progressing — 2 pods CrashLoopBackOff (ns/pod, container)".
  assert.deepEqual(row.podIssues, [{
    reason: 'CrashLoopBackOff',
    pods: 2,
    containers: [
      { namespace: 'alpha', pod: 'api-1', container: 'main' },
      { namespace: 'alpha', pod: 'api-2', container: 'sidecar' }
    ]
  }]);
});

test('a healthy workload reports an empty podIssues, which is not itself a verdict', async () => {
  const healthyPod = {
    metadata: { namespace: 'alpha', name: 'api-1', labels: { app: 'api' } },
    spec: { nodeName: 'node-a', containers: [{ name: 'main', image: 'reg/api:1' }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'main', ready: true, restartCount: 0, state: { running: {} } }] }
  };
  const listFn = listDouble({
    deployments: [deployment('alpha', 'api', { replicas: 1, readyReplicas: 1 })],
    pods: [healthyPod]
  });
  const out = await collect({ cluster: CLUSTER, token: 't', namespace: 'alpha', listFn });
  const row = out.items.find(w => w.name === 'api');
  assert.equal(row.state, 'Ready');
  assert.deepEqual(row.podIssues, []);
});

test('workloads.js never substitutes a container reason for a controller state again', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'collectors', 'workloads.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.equal(/state\s*=\s*[^;\n]*crashing\.reason/.test(code), false);
});

// -------------------------------------------------------------------------- events envelope

const eventObj = (reason, count) => ({
  metadata: { namespace: 'alpha', name: `${reason}-1` },
  reason,
  message: 'something went wrong',
  count,
  involvedObject: { kind: 'Pod', name: 'api-1' },
  lastTimestamp: '2026-01-01T00:00:00Z'
});

test('events() returns an envelope: items, an object count and an occurrence count', async () => {
  const listFn = async () => [eventObj('BackOff', 200), eventObj('Unhealthy', 212)];
  const out = await events({ cluster: CLUSTER, token: 't', limit: 25, listFn });
  assert.equal(out.items.length, 2);
  assert.equal(out.count, 2);
  assert.equal(out.occurrences, 412); // two rows at x200 and x212 are not "2"
  assert.equal(out.atLimit, false);
  assert.deepEqual(out.unavailable, []);
  assert.deepEqual(out.truncated, []);
});

test('events(): a 403 degrades to unavailable instead of throwing and failing the whole overview', async () => {
  const listFn = async () => {
    const err = new Error('events is forbidden: User cannot list resource "events"');
    err.status = 403;
    throw err;
  };
  const out = await events({ cluster: CLUSTER, token: 't', limit: 25, listFn });
  assert.deepEqual(out.unavailable, ['events']);
  assert.deepEqual(out.items, []);
  assert.equal(out.count, 0); // 0 objects, and `unavailable` is what stops that reading as "no warnings"
});

test('events(): a full page is a floor, reported as truncated', async () => {
  const listFn = async () => [eventObj('BackOff', 1), eventObj('Unhealthy', 1)];
  const out = await events({ cluster: CLUSTER, token: 't', limit: 2, listFn });
  assert.equal(out.atLimit, true);
  assert.deepEqual(out.truncated, ['events']);
  assert.deepEqual(out.unavailable, []);
});
