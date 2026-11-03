/**
 * Traces → Outbound (srv/fleet/collectors/outbound.js): grouping every call a workload's sidecar
 * logged on the way out, and the two kinds of link to a request — exact by header, inferred by time.
 * Lines are shaped like the ones Envoy logged on platformsbx (srv → 3.214.110.153:443, a TLS
 * passthrough with no request id, opened during a websocket).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _traffic from '../collectors/traffic.js';
const { buildIndex } = _traffic;
import _service_map2 from '../collectors/service-map.js';
const { workloadIndex } = _service_map2;
import _outbound3 from '../collectors/outbound.js';
const { outboundOf, inFlightAt, MAX_OUTBOUND_PER_TRACE } = _outbound3;

const EMPTY = { items: [], unavailable: false };
const pod = (namespace, name, ip, rs, hash, labels = {}) => ({
  metadata: { namespace, name, labels: { ...labels, 'pod-template-hash': hash }, ownerReferences: [{ kind: 'ReplicaSet', name: rs, controller: true }] },
  status: { podIP: ip }
});
const PODS = [
  pod('istio-system', 'istio-ingressgateway-54648cbc45-aaaaa', '10.0.0.10', 'istio-ingressgateway-54648cbc45', '54648cbc45', { app: 'istio-ingressgateway' }),
  pod('shop', 'srv-7944fff5bd-4kq8l', '10.0.0.30', 'srv-7944fff5bd', '7944fff5bd'),
  pod('other', 'batch-5d4f-x1', '10.0.0.50', 'batch-5d4f', '5d4f')
];
const SERVICES = [{ metadata: { name: 'db', namespace: 'shop' }, spec: { clusterIP: '10.1.0.40' } }];
const index = buildIndex({ pods: { items: PODS }, services: { items: SERVICES }, endpointslices: EMPTY, nodes: EMPTY, gateways: EMPTY });
const workloads = workloadIndex(PODS);
const SRV = { pod: 'srv-7944fff5bd-4kq8l', namespace: 'shop' };
const GW = { pod: 'istio-ingressgateway-54648cbc45-aaaaa', namespace: 'istio-system' };

const tcp = over => ({
  proxy: SRV,
  method: null,
  code: 0,
  path: null,
  duration: 33,
  upstreamCluster: 'PassthroughCluster',
  upstreamHost: '3.214.110.153:443',
  bytesSent: 7752,
  bytesReceived: 819,
  responseFlags: '-',
  requestId: null,
  startTime: '2026-09-25T13:42:08.629Z',
  ...over
});
/** A journey whose srv sidecar served an inbound request over [start, start + ms]. */
const journey = (traceId, start, ms, path = '/_stcore/stream') => ({
  traceId,
  method: 'GET',
  path,
  startTime: start,
  hops: [{ role: 'sidecar', observedBy: SRV, startTime: start, durationMs: ms, to: { direction: 'inbound' } }]
});
const correlated = r => !!r.requestId;
const run = (records, traces, extra = {}) => outboundOf(records, { index, workloads, traces, kept: new Set(traces.map(t => t.traceId)), correlated, ...extra });

test('a headerless connection is linked by time to the request its pod was serving, marked inferred', () => {
  const { outbound, perTrace } = run([tcp()], [journey('ws', '2026-09-25T13:42:07.729Z', 144655)]);
  assert.equal(outbound.rows.length, 1);
  const r = outbound.rows[0];
  assert.equal(r.from.name, 'srv');
  assert.equal(r.to.name, '3.214.110.153:443');
  assert.equal(r.protocol, 'tcp');
  assert.deepEqual([r.exact, r.inferred, r.unlinked, r.crowded], [0, 1, 0, 0]);
  assert.equal(r.sample.traceId, 'ws');
  const item = perTrace.get('ws').items[0];
  assert.equal(item.link, 'inferred');
  assert.equal(item.offsetMs, 900);
  assert.equal(item.candidates, 1);
});

test('with several requests in flight, the innermost is named and the link is counted crowded', () => {
  const { outbound } = run([tcp()], [journey('ws', '2026-09-25T13:42:07.729Z', 144655), journey('inner', '2026-09-25T13:42:08.600Z', 50, '/api/answer')]);
  const r = outbound.rows[0];
  assert.equal(r.sample.traceId, 'inner');
  assert.equal(r.sample.candidates, 2);
  assert.equal(r.crowded, 1);
  assert.deepEqual(inFlightAt([], 1), []);
});

test('a line with a correlator is an exact link, never re-inferred; one with no request in flight is unlinked', () => {
  const { outbound, perTrace } = run(
    [tcp({ requestId: 'r1' }), tcp({ startTime: '2026-09-25T14:00:00.000Z' })],
    [journey('ws', '2026-09-25T13:42:07.729Z', 144655)]
  );
  const r = outbound.rows[0];
  assert.deepEqual([r.exact, r.inferred, r.unlinked], [1, 0, 1]);
  assert.equal(perTrace.size, 0);
});

test('inbound lines, gateways and callers outside the scope are not outbound calls', () => {
  const { outbound } = run(
    [
      tcp({ upstreamCluster: 'inbound|8080||', upstreamHost: '10.0.0.30:8080' }),
      tcp({ upstreamCluster: 'InboundPassthroughClusterIpv4', upstreamHost: '10.0.0.30:9090' }),
      tcp({ proxy: GW, upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local', upstreamHost: '10.0.0.30:8080' }),
      tcp({ proxy: { pod: 'batch-5d4f-x1', namespace: 'other' } })
    ],
    [],
    { namespaces: ['shop'] }
  );
  assert.equal(outbound.rowsFound, 0);
});

test('an unknown byte count stays unknown, and an unrouted attempt is counted, not grouped', () => {
  const { outbound } = run([tcp({ bytesSent: null, bytesReceived: null }), tcp({ upstreamCluster: null, upstreamHost: null })], []);
  assert.equal(outbound.rows[0].bytesSent, null);
  assert.equal(outbound.rows[0].bytesUnknown, 1);
  assert.equal(outbound.unrouted, 1);
});

test('a journey carries at most MAX_OUTBOUND_PER_TRACE linked connections and counts the rest', () => {
  const lines = Array.from({ length: MAX_OUTBOUND_PER_TRACE + 3 }, (_, i) => tcp({ startTime: `2026-09-25T13:42:08.${String(100 + i).padStart(3, '0')}Z` }));
  const { perTrace } = run(lines, [journey('ws', '2026-09-25T13:42:07.729Z', 144655)]);
  assert.equal(perTrace.get('ws').items.length, MAX_OUTBOUND_PER_TRACE);
  assert.equal(perTrace.get('ws').dropped, 3);
});

test('a link names only a journey the console can open', () => {
  const { outbound, perTrace } = outboundOf([tcp()], { index, workloads, traces: [journey('ws', '2026-09-25T13:42:07.729Z', 144655)], kept: new Set(), correlated });
  assert.equal(outbound.rows[0].inferred, 1);
  assert.equal(outbound.rows[0].sample, null);
  assert.equal(perTrace.size, 0);
});

test('an outbound bar is placed on the same zero as the hops, the earliest hop start', () => {
  // The gateway's clock reads 5ms behind the sidecar's: the sidecar hop is the earliest start.
  const t = journey('t1', '2026-09-25T13:42:08.605Z', 50);
  t.startTime = '2026-09-25T13:42:08.610Z';
  const { perTrace } = run([tcp({ startTime: '2026-09-25T13:42:08.607Z' })], [t]);
  assert.equal(perTrace.get('t1').items[0].offsetMs, 2);
});

test('an exact line names its journey, and outranks an inferred link as the row sample', () => {
  const t = journey('t1', '2026-09-25T13:42:08.600Z', 50);
  const hdr = tcp({ method: 'GET', code: 200, requestId: 't1', startTime: '2026-09-25T13:42:08.610Z' });
  const late = tcp({ startTime: '2026-09-25T13:42:08.640Z' });
  const { outbound } = run([hdr, late], [t], { correlated: r => (r.requestId ? [r.requestId] : false) });
  assert.equal(outbound.rows[0].sample.link, 'exact');
  assert.equal(outbound.rows[0].sample.traceId, 't1');
});
