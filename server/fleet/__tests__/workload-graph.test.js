/**
 * Workload dependency graph.
 *
 * The graph is only useful if every edge it draws is an edge that actually exists in the
 * cluster's specs. Each test here pins one edge rule, and most of them pin it against the
 * plausible-but-wrong version:
 *
 *   - a Service is matched by its selector against the POD TEMPLATE's labels, not by name
 *     prefix and not by the Deployment's own labels;
 *   - a ReplicaSet belongs to a workload by ownerReference, not by labels — a rolled-back
 *     Deployment's old ReplicaSets carry identical pod-template labels;
 *   - an Ingress/APIRule is matched through the Service it names, which is the only link
 *     the spec contains;
 *   - env VALUES never appear anywhere in the response.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import workloads from '../collectors/workloads.js';

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };
const NS = 'shop';

function deployment({ name = 'srv', labels = { app: 'srv' }, containers, volumes, replicas = 2 } = {}) {
  return {
    metadata: { name, namespace: NS, generation: 3 },
    spec: {
      replicas,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: 'srv-sa',
          volumes: volumes || [],
          containers: containers || [
            {
              name: 'srv',
              image: 'registry.example/srv:1.4.2',
              resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } },
              ports: [{ name: 'http', containerPort: 4004 }],
              readinessProbe: { httpGet: { path: '/health', port: 4004 } },
              env: [
                { name: 'PLAIN', value: 'super-secret-literal' },
                { name: 'FROM_CM', valueFrom: { configMapKeyRef: { name: 'srv-config', key: 'k' } } },
                { name: 'FROM_SECRET', valueFrom: { secretKeyRef: { name: 'srv-creds', key: 'password' } } }
              ],
              envFrom: [{ configMapRef: { name: 'shared-config' } }]
            }
          ]
        }
      }
    },
    status: { readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2, observedGeneration: 3 }
  };
}

function pod({ name = 'srv-abc-1', labels = { app: 'srv' }, digest = 'a'.repeat(64), container = 'srv' } = {}) {
  return {
    metadata: { name, namespace: NS, labels },
    spec: { nodeName: 'node-1', containers: [{ name: container, image: 'registry.example/srv:1.4.2' }] },
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: container, ready: true, restartCount: 0, state: { running: {} }, image: 'registry.example/srv:1.4.2', imageID: `registry.example/srv@sha256:${digest}` }
      ]
    }
  };
}

function replicaSet({ name, revision, replicas, owner = 'srv' }) {
  return {
    metadata: {
      name,
      namespace: NS,
      annotations: { 'deployment.kubernetes.io/revision': String(revision) },
      creationTimestamp: '2026-09-01T00:00:00Z',
      ownerReferences: [{ kind: 'Deployment', name: owner }]
    },
    spec: { replicas },
    status: { replicas, readyReplicas: replicas }
  };
}

function service({ name = 'srv', selector = { app: 'srv' }, type = 'ClusterIP' } = {}) {
  return {
    metadata: { name, namespace: NS },
    spec: { type, clusterIP: '10.0.0.1', selector, ports: [{ name: 'http', port: 80, targetPort: 4004, protocol: 'TCP' }] }
  };
}

/**
 * A listFn that answers from a table keyed by the resource word in the path, so a test only
 * has to describe the resources it cares about; anything unlisted comes back empty, which is
 * the honest shape of a cluster without Istio or without any HPA.
 */
function listing(table) {
  return async ({ path }) => {
    for (const [resource, items] of Object.entries(table)) {
      if (path.includes(`/${resource}`)) return items;
    }
    return [];
  };
}

const base = () => ({
  deployments: [deployment()],
  replicasets: [replicaSet({ name: 'srv-old', revision: 1, replicas: 0 }), replicaSet({ name: 'srv-new', revision: 2, replicas: 2 })],
  pods: [pod({ name: 'srv-new-1' }), pod({ name: 'srv-new-2' })],
  services: [service()],
  horizontalpodautoscalers: [],
  ingresses: [],
  apirules: []
});

const call = table =>
  workloads.graph({ cluster, token: 't', namespace: NS, kind: 'Deployment', name: 'srv', listFn: listing(table) });

test('the flow runs ingress -> service -> workload -> replicaset -> pods', async () => {
  const g = await call(base());
  assert.deepEqual(g.flow.map(s => s.stage), ['ingress', 'service', 'workload', 'replicaset', 'pods']);
  assert.deepEqual(g.flow.find(s => s.stage === 'pods').items.map(i => i.name), ['srv-new-1', 'srv-new-2']);
});

test('a stage with nothing in it is kept, not dropped', async () => {
  // The whole point: "no Service selects this Deployment" is a finding, and a diagram that
  // silently omits the stage hides it behind a shorter, healthy-looking chain.
  const table = { ...base(), services: [] };
  const g = await call(table);
  const stage = g.flow.find(s => s.stage === 'service');
  assert.ok(stage, 'the service stage must still be present');
  assert.deepEqual(stage.items, []);
  assert.deepEqual(g.services, []);
});

test('a Service is matched by selector against the pod template, not by name', async () => {
  const table = {
    ...base(),
    services: [
      service({ name: 'srv', selector: { app: 'srv' } }),
      // Same name prefix, different selector: a name-prefix match would wrongly claim this.
      service({ name: 'srv-metrics', selector: { app: 'other' } }),
      // Different name, matching selector: a name match would wrongly miss this.
      service({ name: 'totally-unrelated-name', selector: { app: 'srv' } }),
      // Selector-less Service (manual Endpoints) wires nothing to this workload.
      service({ name: 'external', selector: {} })
    ]
  };
  const g = await call(table);
  assert.deepEqual(g.services.map(s => s.name).sort(), ['srv', 'totally-unrelated-name']);
});

test('a Service whose selector is broader than the pod labels does not match', async () => {
  const table = { ...base(), services: [service({ selector: { app: 'srv', tier: 'backend' } })] };
  const g = await call(table);
  assert.deepEqual(g.services, [], 'every selector key must be satisfied, not just one');
});

test('ReplicaSets are claimed by ownerReference, never by labels', async () => {
  const table = {
    ...base(),
    replicasets: [
      replicaSet({ name: 'srv-new', revision: 2, replicas: 2, owner: 'srv' }),
      // Identical pod-template labels, different owner. Label matching would steal this.
      replicaSet({ name: 'other-rs', revision: 7, replicas: 5, owner: 'other-deployment' })
    ]
  };
  const g = await call(table);
  assert.deepEqual(g.replicaSets.map(r => r.name), ['srv-new']);
});

test('only the active ReplicaSet appears in the flow, while history stays in the list', async () => {
  const g = await call(base());
  assert.deepEqual(g.replicaSets.map(r => r.name), ['srv-new', 'srv-old'], 'newest revision first');
  assert.deepEqual(g.replicaSets.map(r => r.active), [true, false]);
  assert.deepEqual(g.flow.find(s => s.stage === 'replicaset').items.map(i => i.name), ['srv-new']);
});

test('an Ingress is linked through the Service it names', async () => {
  const table = {
    ...base(),
    ingresses: [
      {
        metadata: { name: 'shop-ingress', namespace: NS },
        spec: { rules: [{ host: 'shop.example', http: { paths: [{ backend: { service: { name: 'srv' } } }] } }] }
      },
      {
        metadata: { name: 'other-ingress', namespace: NS },
        spec: { rules: [{ host: 'other.example', http: { paths: [{ backend: { service: { name: 'nope' } } }] } }] }
      }
    ]
  };
  const g = await call(table);
  assert.deepEqual(g.ingress.map(i => i.name), ['shop-ingress']);
  assert.deepEqual(g.ingress[0].hosts, ['shop.example']);
});

test('an APIRule is linked through spec.service.name and carries its state', async () => {
  const table = {
    ...base(),
    apirules: [
      {
        metadata: { name: 'shop-api', namespace: NS },
        spec: { hosts: ['api.shop.example'], service: { name: 'srv', port: 80 } },
        status: { state: 'Ready' }
      }
    ]
  };
  const g = await call(table);
  assert.deepEqual(g.ingress.map(i => [i.kind, i.name, i.state]), [['APIRule', 'shop-api', 'Ready']]);
  assert.deepEqual(g.flow[0].items.map(i => i.kind), ['APIRule']);
});

test('an HPA is claimed only when its scaleTargetRef names this workload', async () => {
  const table = {
    ...base(),
    horizontalpodautoscalers: [
      { metadata: { name: 'srv-hpa', namespace: NS }, spec: { minReplicas: 2, maxReplicas: 8, scaleTargetRef: { kind: 'Deployment', name: 'srv' } }, status: { currentReplicas: 3, desiredReplicas: 3 } },
      { metadata: { name: 'wrong-kind', namespace: NS }, spec: { minReplicas: 1, maxReplicas: 2, scaleTargetRef: { kind: 'StatefulSet', name: 'srv' } }, status: {} },
      { metadata: { name: 'wrong-name', namespace: NS }, spec: { minReplicas: 1, maxReplicas: 2, scaleTargetRef: { kind: 'Deployment', name: 'other' } }, status: {} }
    ]
  };
  const g = await call(table);
  assert.deepEqual(g.hpas.map(h => h.name), ['srv-hpa']);
  assert.deepEqual(g.hpas[0], { name: 'srv-hpa', min: 2, max: 8, current: 3, desired: 3 });
});

test('configuration is gathered from env, envFrom, volumes and the service account', async () => {
  const table = {
    ...base(),
    deployments: [
      deployment({
        volumes: [
          { name: 'cfg', configMap: { name: 'volume-config' } },
          { name: 'tls', secret: { secretName: 'tls-cert' } },
          { name: 'data', persistentVolumeClaim: { claimName: 'srv-data' } },
          { name: 'proj', projected: { sources: [{ secret: { name: 'projected-secret' } }] } }
        ]
      })
    ]
  };
  const g = await call(table);
  const byName = new Map(g.config.map(c => [c.name, c]));

  assert.deepEqual(byName.get('srv-config').via, ['env']);
  assert.deepEqual(byName.get('srv-creds').via, ['env']);
  assert.deepEqual(byName.get('shared-config').via, ['envFrom']);
  assert.deepEqual(byName.get('volume-config').via, ['volume']);
  assert.deepEqual(byName.get('tls-cert').via, ['volume']);
  assert.deepEqual(byName.get('srv-data'), { kind: 'PersistentVolumeClaim', name: 'srv-data', via: ['volume'] });
  assert.deepEqual(byName.get('projected-secret').via, ['projected volume']);
  assert.deepEqual(byName.get('srv-sa').kind, 'ServiceAccount');
});

test('a ConfigMap read two ways is listed once with both routes', async () => {
  const table = {
    ...base(),
    deployments: [
      deployment({
        volumes: [{ name: 'cfg', configMap: { name: 'shared-config' } }],
        containers: [
          {
            name: 'srv',
            image: 'x:1',
            env: [{ name: 'K', valueFrom: { configMapKeyRef: { name: 'shared-config', key: 'k' } } }],
            envFrom: [{ configMapRef: { name: 'shared-config' } }]
          }
        ]
      })
    ]
  };
  const g = await call(table);
  const matches = g.config.filter(c => c.name === 'shared-config');
  assert.equal(matches.length, 1, 'one entry, not three');
  assert.deepEqual(matches[0].via, ['env', 'envFrom', 'volume']);
});

test('env variable values never appear in the response', async () => {
  // The canary for the whole design decision. `PLAIN` holds a literal in the fixture, and a
  // naive implementation returning `container.env` wholesale would ship it to the browser.
  const g = await call(base());
  const serialised = JSON.stringify(g);
  assert.ok(!serialised.includes('super-secret-literal'), 'an env value must never cross the wire');
  assert.deepEqual(g.containers[0].envKeys, ['FROM_CM', 'FROM_SECRET', 'PLAIN'], 'the keys are still reported');
});

test('container specs carry the tag, the running digests, and unbounded limits as 0', async () => {
  const g = await call(base());
  const [c] = g.containers;
  assert.equal(c.imageTag, '1.4.2');
  assert.deepEqual(c.digests, [`sha256:${'a'.repeat(64)}`], 'both replicas run the same digest, so one entry');
  assert.equal(c.cpuRequest, 0.1);
  assert.equal(c.cpuLimit, 0, 'no CPU limit is declared — reported as 0, i.e. unbounded');
  assert.equal(c.memoryLimit, 512 * 1024 * 1024);
  assert.deepEqual(c.probes, { liveness: false, readiness: true, startup: false });
});

test('replicas running different digests behind one tag are both reported', async () => {
  // A mutable tag makes drift invisible; the digest set is the only place it shows up.
  const table = {
    ...base(),
    pods: [pod({ name: 'srv-1', digest: 'a'.repeat(64) }), pod({ name: 'srv-2', digest: 'b'.repeat(64) })]
  };
  const g = await call(table);
  assert.equal(g.containers[0].digests.length, 2);
});

test('a workload that is not there is a 404, not an empty graph', async () => {
  await assert.rejects(
    () => workloads.graph({ cluster, token: 't', namespace: NS, kind: 'Deployment', name: 'ghost', listFn: listing(base()) }),
    err => err.status === 404
  );
});

test('the not-found error is typed NOT_FOUND, so the fan-out does not blame the cluster', async () => {
  // A plain Error here is flattened to code UPSTREAM by fanout.failed(), which renders a stale
  // link to a deleted Deployment as "cluster unreachable" instead of "gone".
  await assert.rejects(
    () => workloads.graph({ cluster, token: 't', namespace: NS, kind: 'Deployment', name: 'ghost', listFn: listing(base()) }),
    err => err.name === 'ClusterError' && err.code === 'NOT_FOUND' && err.cluster === cluster.id
  );
});

test('a healthy DaemonSet reports numberReady/desiredNumberScheduled, not 0/N', async () => {
  // The plausible-but-wrong implementation reads status.readyReplicas / spec.replicas, neither
  // of which a DaemonSet has, so a fully healthy DaemonSet renders "0/N ready".
  const ds = {
    metadata: { name: 'agent', namespace: NS },
    spec: { selector: { matchLabels: { app: 'agent' } }, template: { metadata: { labels: { app: 'agent' } }, spec: { containers: [{ name: 'agent', image: 'registry.example/agent:2.0' }] } } },
    status: { desiredNumberScheduled: 3, numberReady: 3 }
  };
  const listFn = listing({
    daemonsets: [ds],
    pods: [pod({ name: 'agent-1', labels: { app: 'agent' }, container: 'agent' })]
  });
  const g = await workloads.graph({ cluster, token: 't', namespace: NS, kind: 'DaemonSet', name: 'agent', listFn });
  const stage = g.flow.find(s => s.stage === 'workload');
  assert.equal(stage.items[0].detail, '3/3 ready');
});

test('imageTag ignores a registry port and a digest pin', () => {
  assert.equal(workloads.imageTag('registry.example/srv:1.4.2'), '1.4.2');
  // The last colon is in the HOST here — a naive lastIndexOf split reports "5000/agent".
  assert.equal(workloads.imageTag('myreg.local:5000/agent'), null);
  assert.equal(workloads.imageTag('myreg.local:5000/agent:2.0'), '2.0');
  // Digest-pinned: there is no tag, and the 64-hex digest is not one.
  assert.equal(workloads.imageTag(`app@sha256:${'a'.repeat(64)}`), null);
  assert.equal(workloads.imageTag('busybox'), null);
  assert.equal(workloads.imageTag(undefined), null);
});

test('an unsupported kind is rejected before any read', async () => {
  await assert.rejects(
    () => workloads.graph({ cluster, token: 't', namespace: NS, kind: 'CronJob', name: 'srv', listFn: listing(base()) }),
    err => err.status === 400
  );
});

test('a refused read is reported as unavailable rather than as an empty stage', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('/services')) {
      const err = new Error('services is forbidden');
      err.status = 403;
      throw err;
    }
    return listing(base())({ path });
  };
  const g = await workloads.graph({ cluster, token: 't', namespace: NS, kind: 'Deployment', name: 'srv', listFn });
  assert.deepEqual(g.summary.unavailable, ['services']);
  assert.deepEqual(g.services, [], 'and the list is empty, which is why the label above matters');
});

test('a StatefulSet graph has no replicaset stage', async () => {
  const sts = deployment({ name: 'db' });
  const listFn = listing({ ...base(), statefulsets: [sts] });
  const g = await workloads.graph({ cluster, token: 't', namespace: NS, kind: 'StatefulSet', name: 'db', listFn });
  assert.deepEqual(g.flow.map(s => s.stage), ['ingress', 'service', 'workload', 'pods']);
});

test('the digest helper reads both the qualified and the bare form', () => {
  const d = 'sha256:' + 'c'.repeat(64);
  assert.equal(workloads.imageDigest(`registry.example/x/y@${d}`), d);
  assert.equal(workloads.imageDigest(d), d);
  assert.equal(workloads.imageDigest('registry.example/x/y:tag'), null);
  assert.equal(workloads.imageDigest(undefined), null);
});
