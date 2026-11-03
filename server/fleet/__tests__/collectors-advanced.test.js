import { test } from 'vitest';
import assert from 'node:assert';

import autoscaling from '../collectors/autoscaling.js';
import certificates from '../collectors/certificates.js';
import topology from '../collectors/topology.js';
import _errors from '../errors.js';
const { ClusterError } = _errors;

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

test('autoscaling collector parses HPAs and CronJobs correctly', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('horizontalpodautoscalers')) {
      return [
        {
          metadata: { name: 'bookshop-hpa', namespace: 'prod', creationTimestamp: '2026-09-01T00:00:00Z' },
          spec: {
            scaleTargetRef: { kind: 'Deployment', name: 'bookshop-srv' },
            minReplicas: 2,
            maxReplicas: 10,
            metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: 80 } } }]
          },
          status: {
            currentReplicas: 3,
            desiredReplicas: 4,
            currentMetrics: [{ resource: { name: 'cpu', current: { averageUtilization: 75 } } }],
            conditions: [{ type: 'ScalingActive', status: 'True' }]
          }
        }
      ];
    }
    if (path.includes('cronjobs')) {
      return [
        {
          metadata: { name: 'nightly-sync', namespace: 'prod' },
          spec: { schedule: '0 2 * * *', suspend: false, concurrencyPolicy: 'Forbid' },
          status: { active: [], lastScheduleTime: '2026-09-01T02:00:00Z', lastSuccessfulTime: '2026-09-01T02:05:00Z' }
        }
      ];
    }
    return [];
  };

  const result = await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.totalHpas, 1);
  assert.strictEqual(result.summary.scalingActive, 1);
  assert.strictEqual(result.hpas[0].desiredReplicas, 4);
  assert.strictEqual(result.summary.totalCronJobs, 1);
  assert.strictEqual(result.cronjobs[0].schedule, '0 2 * * *');
  assert.deepStrictEqual(result.summary.unavailable, []);
});

test('autoscaling: an unreconciled HPA reports no replica counts, not zeros', async () => {
  // `status: {}` is what an HPA looks like between being accepted and being reconciled. The
  // collector used to publish `currentReplicas: 0, desiredReplicas: 0` for it, which is the wire
  // form of a workload deliberately scaled to zero — the opposite reading.
  const fakeList = async ({ path }) =>
    path.includes('horizontalpodautoscalers')
      ? [{ metadata: { name: 'fresh', namespace: 'prod' }, spec: { maxReplicas: 10 }, status: {} }]
      : [];

  const [hpa] = (await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList })).hpas;
  assert.strictEqual(hpa.currentReplicas, null);
  assert.strictEqual(hpa.desiredReplicas, null);
  assert.strictEqual(hpa.minReplicas, null, 'an unset minReplicas is unset, not the API default of 1');
  assert.strictEqual(hpa.maxReplicas, 10);
});

test('autoscaling: a scaled-to-zero HPA keeps its zeros', async () => {
  const fakeList = async ({ path }) =>
    path.includes('horizontalpodautoscalers')
      ? [
          {
            metadata: { name: 'keda-consumer', namespace: 'prod' },
            spec: { minReplicas: 0, maxReplicas: 30 },
            status: { currentReplicas: 0, desiredReplicas: 0 }
          }
        ]
      : [];

  const [hpa] = (await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList })).hpas;
  assert.strictEqual(hpa.minReplicas, 0, 'HPAScaleToZero makes an explicit 0 minimum real');
  assert.strictEqual(hpa.currentReplicas, 0);
  assert.strictEqual(hpa.desiredReplicas, 0);
});

test('autoscaling: every HPA metric type is unpacked, not only Resource', async () => {
  /*
   * The five `spec.metrics` types of autoscaling/v2. Only `Resource` was ever read, so a Pods,
   * Object or External metric published as `{ type: 'External', target: '—', current: '—' }` — and
   * an External metric is what every KEDA scaler writes, so on a KEDA cluster that was every row.
   */
  const fakeList = async ({ path }) =>
    path.includes('horizontalpodautoscalers')
      ? [
          {
            metadata: { name: 'mixed', namespace: 'prod' },
            spec: {
              minReplicas: 1,
              maxReplicas: 20,
              metrics: [
                { type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: 80 } } },
                {
                  type: 'ContainerResource',
                  containerResource: { name: 'memory', container: 'istio-proxy', target: { averageValue: '200Mi' } }
                },
                { type: 'Pods', pods: { metric: { name: 'http_requests' }, target: { averageValue: '10' } } },
                {
                  type: 'Object',
                  object: {
                    describedObject: { kind: 'Ingress', name: 'bookshop' },
                    metric: { name: 'requests_per_second' },
                    target: { value: '100' }
                  }
                },
                { type: 'External', external: { metric: { name: 'queue-length' }, target: { averageValue: '50' } } }
              ]
            },
            status: {
              currentReplicas: 4,
              desiredReplicas: 4,
              currentMetrics: [
                // Deliberately out of spec order, and with a second resource metric ahead of cpu:
                // matching by index or by type alone reports memory's reading against cpu's target.
                { type: 'Resource', resource: { name: 'memory', current: { averageValue: '900Mi' } } },
                { type: 'External', external: { metric: { name: 'queue-length' }, current: { averageValue: '412' } } },
                { type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 4 } } }
              ]
            }
          }
        ]
      : [];

  const [hpa] = (await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList })).hpas;
  const byKind = Object.fromEntries(hpa.metrics.map(m => [m.kind, m]));

  assert.deepStrictEqual(
    hpa.metrics.map(m => m.kind),
    ['Resource', 'ContainerResource', 'Pods', 'Object', 'External']
  );
  assert.strictEqual(byKind.Resource.name, 'cpu');
  assert.strictEqual(byKind.Resource.targetValue, '80%');
  assert.strictEqual(byKind.Resource.currentValue, '4%', 'cpu reads cpu, not the memory entry listed before it');
  assert.strictEqual(byKind.ContainerResource.container, 'istio-proxy');
  assert.strictEqual(byKind.ContainerResource.targetValue, '200Mi');
  assert.strictEqual(byKind.Pods.name, 'http_requests');
  assert.strictEqual(byKind.Pods.targetValue, '10');
  assert.deepStrictEqual(byKind.Object.describedObject, { kind: 'Ingress', name: 'bookshop' });
  assert.strictEqual(byKind.Object.targetValue, '100');
  assert.strictEqual(byKind.External.name, 'queue-length');
  assert.strictEqual(byKind.External.currentValue, '412');
  // The display string the resource drawer joins on is unchanged for Resource metrics.
  assert.strictEqual(byKind.Resource.type, 'Resource (cpu)');
});

test('autoscaling: a metric with no reading yet says so, and never as a zero', async () => {
  const fakeList = async ({ path }) =>
    path.includes('horizontalpodautoscalers')
      ? [
          {
            metadata: { name: 'fresh', namespace: 'prod' },
            spec: {
              maxReplicas: 5,
              metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: 70 } } }]
            },
            status: {}
          }
        ]
      : [];

  const [metric] = (await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList })).hpas[0].metrics;
  assert.strictEqual(metric.currentValue, null);
  assert.strictEqual(metric.current, '—');
  assert.strictEqual(metric.targetValue, '70%');
});

test('autoscaling: a 0% utilisation reading survives, where `||` used to drop it', async () => {
  const fakeList = async ({ path }) =>
    path.includes('horizontalpodautoscalers')
      ? [
          {
            metadata: { name: 'idle', namespace: 'prod' },
            spec: {
              maxReplicas: 5,
              metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: 0 } } }]
            },
            status: { currentMetrics: [{ resource: { name: 'cpu', current: { averageUtilization: 0 } } }] }
          }
        ]
      : [];

  const [metric] = (await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList })).hpas[0].metrics;
  assert.strictEqual(metric.targetValue, '0%', 'the old `target.averageUtilization ? … : …` read 0 as absent');
  assert.strictEqual(metric.currentValue, '0%');
});

test('autoscaling collector reports unavailable (not a silent zero) when RBAC forbids HPAs', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('horizontalpodautoscalers')) {
      throw new ClusterError('FORBIDDEN', 'hpas.autoscaling is forbidden', { status: 403 });
    }
    if (path.includes('cronjobs')) {
      return [
        { metadata: { name: 'nightly-sync', namespace: 'prod' }, spec: { schedule: '0 2 * * *' }, status: {} }
      ];
    }
    return [];
  };

  const result = await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.totalHpas, 0);
  assert.strictEqual(result.hpas.length, 0);
  assert.deepStrictEqual(result.summary.unavailable, ['hpa']);
  // CronJobs succeeded independently and must not be swept into the same failure.
  assert.strictEqual(result.summary.totalCronJobs, 1);
});

test('certificates collector calculates expiry countdown and identifies expiring certs', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const in5Days = new Date(now + 5 * DAY_MS).toISOString();
  const in90Days = new Date(now + 90 * DAY_MS).toISOString();

  // Only the cert-manager.io path answers; cert.gardener.cloud also matches a bare
  // 'certificates' substring, so this must be the specific provider path, not both.
  const fakeList = async ({ path }) => {
    if (path.includes('cert-manager.io/v1/certificates')) {
      return [
        {
          metadata: { name: 'soon-expiring-cert', namespace: 'prod' },
          spec: { dnsNames: ['bookshop.example.com'], issuerRef: { kind: 'ClusterIssuer', name: 'letsencrypt' } },
          status: { notAfter: in5Days, conditions: [{ type: 'Ready', status: 'True' }] }
        },
        {
          metadata: { name: 'healthy-cert', namespace: 'prod' },
          spec: { dnsNames: ['api.example.com'], issuerRef: { kind: 'ClusterIssuer', name: 'letsencrypt' } },
          status: { notAfter: in90Days, conditions: [{ type: 'Ready', status: 'True' }] }
        }
      ];
    }
    return [];
  };

  const result = await certificates.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.totalCertificates, 2);
  assert.strictEqual(result.summary.expiringSoon, 1);
  assert.strictEqual(result.certificates[0].isExpiringSoon, true);
  assert.strictEqual(result.certificates[1].isExpiringSoon, false);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

test('certificates collector reports unavailable (not a silent zero) when RBAC forbids Certificates', async () => {
  // Only cert-manager.io 403s here; cert.gardener.cloud answers with a real empty list, so
  // this exercises "one provider forbidden, the other genuinely absent" — not both down.
  const fakeList = async ({ path }) => {
    if (path.includes('cert-manager.io/v1/certificates')) {
      throw new ClusterError('FORBIDDEN', 'certificates.cert-manager.io is forbidden', { status: 403 });
    }
    return [];
  };

  const result = await certificates.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.totalCertificates, 0);
  assert.strictEqual(result.certificates.length, 0);
  assert.deepStrictEqual(result.summary.unavailable, ['certificates']);
});

test('certificates collector treats a missing Cert-Manager CRD (404) as a true zero, not unavailable', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('cert-manager.io/v1/certificates')) {
      throw new ClusterError('UPSTREAM', 'the server could not find the requested resource', { status: 404 });
    }
    return [];
  };

  const result = await certificates.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.totalCertificates, 0);
  // A missing CRD is a real zero, not an outage — it must not appear in `unavailable`.
  assert.deepStrictEqual(result.summary.unavailable, []);
});

test('topology collector groups nodes by multi-zone availability', async () => {
  const fakeList = async ({ path }) => {
    if (path.includes('/api/v1/nodes')) {
      return [
        {
          metadata: { name: 'node-1', labels: { 'topology.kubernetes.io/zone': 'us-east-1a', 'node.kubernetes.io/instance-type': 'm5.xlarge' } },
          status: { conditions: [{ type: 'Ready', status: 'True' }], capacity: { cpu: '4', memory: '16Gi', pods: '110' }, nodeInfo: { kubeletVersion: 'v1.30.2' } }
        },
        {
          metadata: { name: 'node-2', labels: { 'topology.kubernetes.io/zone': 'us-east-1b', 'node.kubernetes.io/instance-type': 'm5.xlarge' } },
          status: { conditions: [{ type: 'Ready', status: 'True' }], capacity: { cpu: '4', memory: '16Gi', pods: '110' }, nodeInfo: { kubeletVersion: 'v1.30.2' } }
        }
      ];
    }
    if (path.includes('/api/v1/pods')) {
      return [
        { spec: { nodeName: 'node-1' } },
        { spec: { nodeName: 'node-2' } }
      ];
    }
    return [];
  };

  const result = await topology.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.strictEqual(result.summary.totalNodes, 2);
  assert.strictEqual(result.summary.readyNodes, 2);
  assert.strictEqual(result.summary.distinctZones, 2);
  assert.strictEqual(result.summary.isMultiZone, true);
  assert.strictEqual(result.summary.totalPodsScheduled, 2);
  assert.strictEqual(result.zones.length, 2);
  assert.strictEqual(result.nodeGroups.length >= 1, true);
  assert.strictEqual(result.nodes[0].podsScheduled, 1);
  assert.strictEqual(result.nodes[1].podsScheduled, 1);
  assert.deepStrictEqual(result.summary.unavailable, [], 'both reads answered, so every figure is measured');
  assert.deepStrictEqual(result.summary.truncated, []);
});

// --- topology degradation ------------------------------------------------------------------

/**
 * Nodes are this collector's whole subject, so a refused node list is a broken cluster and
 * not a partial one — it fails loudly, the way security.js's pod audit does. Pods are one
 * signal among several here, so a refused pod list degrades with a named gap.
 *
 * The invariant underneath both: `isMultiZone: false` is a resilience FINDING. It must
 * never be emitted for a cluster whose nodes we could not read, because an operator acts
 * on it.
 */

/** A listFn that fails one path with `err` and answers the rest from `answers`. */
function listWhere(answers) {
  return async ({ path }) => {
    for (const [match, value] of Object.entries(answers)) {
      if (path.includes(match)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return [];
  };
}

const READY_NODE = {
  metadata: { name: 'node-1', labels: { 'topology.kubernetes.io/zone': 'us-east-1a' } },
  status: { conditions: [{ type: 'Ready', status: 'True' }], capacity: { cpu: '4', memory: '16Gi', pods: '110' } }
};

test('a refused node list fails loudly instead of reporting a single-zone cluster', async () => {
  const forbidden = new ClusterError('FORBIDDEN', 'nodes is forbidden: cannot list resource "nodes"', { cluster: cluster.id, status: 403 });
  const fakeList = listWhere({ '/api/v1/nodes': forbidden, '/api/v1/pods': [] });

  await assert.rejects(
    () => topology.collect({ cluster, token: 'fake', listFn: fakeList }),
    err => {
      // The original error reaches fanOut untouched, so the cluster slot carries the real
      // code and message rather than a zero with a footnote.
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.match(err.message, /forbidden/);
      return true;
    },
    'a 403 on nodes must not resolve to a summary at all'
  );
});

test('no failure mode of the node read can emit isMultiZone: false as a finding', async () => {
  const failures = [
    new ClusterError('FORBIDDEN', 'forbidden', { cluster: cluster.id, status: 403 }),
    new ClusterError('UNAUTHENTICATED', 'token expired', { cluster: cluster.id, status: 401 }),
    Object.assign(new Error('timed out after 8000ms'), { name: 'TimeoutError' }),
    Object.assign(new Error('internal server error'), { status: 500 }),
    // Even a 404 — which safe-list.js would call a true zero for an optional CRD — is loud
    // here. /api/v1/nodes is core and always registered; an API server that does not serve
    // it is broken, and "0 nodes, single zone" would be a fabricated finding.
    Object.assign(new Error('the server could not find the requested resource'), { status: 404 })
  ];

  for (const err of failures) {
    const fakeList = listWhere({ '/api/v1/nodes': err, '/api/v1/pods': [] });
    await assert.rejects(
      () => topology.collect({ cluster, token: 'fake', listFn: fakeList }),
      `${err.message} silently produced a topology summary`
    );
  }
});

test('a refused pod list degrades: the node picture survives and the gap is named', async () => {
  const forbidden = new ClusterError('FORBIDDEN', 'pods is forbidden: cannot list resource "pods"', { cluster: cluster.id, status: 403 });
  const fakeList = listWhere({ '/api/v1/nodes': [READY_NODE], '/api/v1/pods': forbidden });

  const result = await topology.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.unavailable, ['pods']);
  assert.strictEqual(result.summary.totalNodes, 1, 'the node inventory is still true');
  assert.strictEqual(result.summary.readyNodes, 1);
  assert.strictEqual(result.summary.distinctZones, 1);
  assert.strictEqual(result.summary.isMultiZone, false, 'and this one is a measured finding, because nodes were read');
  assert.strictEqual(result.summary.totalPodsAudited, 0);
  assert.strictEqual(result.nodes.length, 1);
});

test('a 404 on pods is a true zero, not an outage', async () => {
  const notFound = Object.assign(new Error('the server could not find the requested resource'), { status: 404 });
  const fakeList = listWhere({ '/api/v1/nodes': [READY_NODE], '/api/v1/pods': notFound });

  const result = await topology.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.unavailable, [], 'a missing resource type is an honest zero');
  assert.strictEqual(result.summary.totalPodsAudited, 0);
  assert.strictEqual(result.summary.totalNodes, 1);
});

test('a pod list cut short at the paging ceiling is flagged, and its pods still count', async () => {
  const pods = Object.defineProperty(
    [{ spec: { nodeName: 'node-1' } }, { spec: { nodeName: 'node-1' } }],
    'truncated', { value: true }
  );
  const fakeList = listWhere({ '/api/v1/nodes': [READY_NODE], '/api/v1/pods': pods });

  const result = await topology.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, ['pods']);
  assert.deepStrictEqual(result.summary.unavailable, [], 'short is not the same as unreadable');
  assert.strictEqual(result.summary.totalPodsAudited, 2, 'the items that did arrive are real and are counted');
  assert.strictEqual(result.nodes[0].podsScheduled, 2);
});

test('a node list cut short is flagged too, even though that read bypasses safeList', async () => {
  const nodes = Object.defineProperty([READY_NODE], 'truncated', { value: true });
  const fakeList = listWhere({ '/api/v1/nodes': nodes, '/api/v1/pods': [] });

  const result = await topology.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, ['nodes']);
  assert.deepStrictEqual(result.summary.unavailable, []);
  assert.strictEqual(result.summary.totalNodes, 1);
});

// --- truncation elsewhere: the read answered, but the list stopped short ---------------------
//
// The items behind a truncated list are real, so every count derived from it is a FLOOR.
// Folding it into `unavailable` would trade a true lower bound for an em-dash; omitting it
// altogether — which is what these collectors did — presents the floor as a total, which is
// the same false affirmative `unavailable` exists to kill.

/** `k8s.list`'s mark for a list that hit the paging ceiling: non-enumerable, read by name. */
function truncatedArray(items) {
  return Object.defineProperty([...items], 'truncated', { value: true });
}

const HPA = { metadata: { name: 'bookshop-hpa', namespace: 'prod' }, spec: { maxReplicas: 4 }, status: {} };
const CRONJOB = { metadata: { name: 'nightly-sync', namespace: 'prod' }, spec: { schedule: '0 2 * * *' }, status: {} };

test('autoscaling: an HPA list cut short is flagged, and the HPAs that did arrive still count', async () => {
  const fakeList = listWhere({ horizontalpodautoscalers: truncatedArray([HPA, HPA]), cronjobs: [CRONJOB] });

  const result = await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, ['hpa']);
  assert.deepStrictEqual(result.summary.unavailable, [], 'short is not the same as unreadable');
  assert.strictEqual(result.summary.totalHpas, 2, 'the items that did arrive are real and are counted');
  assert.strictEqual(result.summary.totalCronJobs, 1, 'the read that finished is not tarred with it');
});

test('autoscaling: reads that ran to the end report truncated: []', async () => {
  const fakeList = listWhere({ horizontalpodautoscalers: [HPA], cronjobs: [CRONJOB] });

  const result = await autoscaling.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, []);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

const EXPIRING_CERT = {
  metadata: { name: 'soon-expiring-cert', namespace: 'prod' },
  spec: { dnsNames: ['bookshop.example.com'], issuerRef: { kind: 'ClusterIssuer', name: 'letsencrypt' } },
  status: { notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() }
};

test('certificates: a certificate list cut short is flagged, so the expiry alarm reads as a floor', async () => {
  // Match the specific cert-manager.io path — a bare 'certificates' substring also matches
  // cert.gardener.cloud's path now that both providers are read side by side.
  const fakeList = listWhere({ 'cert-manager.io/v1/certificates': truncatedArray([EXPIRING_CERT]) });

  const result = await certificates.collect({ cluster, token: 'fake', listFn: fakeList });
  // Only the read that stopped short; the ingress read finished and stays out of the list.
  assert.deepStrictEqual(result.summary.truncated, ['certificates']);
  assert.deepStrictEqual(result.summary.unavailable, [], 'short is not the same as unreadable');
  assert.strictEqual(result.summary.totalCertificates, 1);
  assert.strictEqual(result.summary.expiringSoon, 1, 'a floor on an alarm is not a clean bill of health');
});

test('certificates: reads that ran to the end report truncated: []', async () => {
  const fakeList = listWhere({ 'cert-manager.io/v1/certificates': [EXPIRING_CERT] });

  const result = await certificates.collect({ cluster, token: 'fake', listFn: fakeList });
  assert.deepStrictEqual(result.summary.truncated, []);
  assert.deepStrictEqual(result.summary.unavailable, []);
});

