/**
 * Traces → Endpoints and Service map: the two aggregations in srv/fleet/collectors/service-map.js,
 * each pinned on hand-written lines shaped like the ones Envoy logged on platformsbx.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _traffic from '../collectors/traffic.js';
const { buildIndex } = _traffic;
import _service_map2 from '../collectors/service-map.js';
import _tracesModule from '../collectors/traces.js';
const {
  failed,
  percentile,
  normalizePath,
  endpointsOf,
  workloadIndex,
  serviceMapOf,
  MIN_P95_SAMPLES
} = _service_map2;

const EMPTY = { items: [], unavailable: false };
const pod = (namespace, name, ip, { rs, hash, labels = {} } = {}) => ({
  metadata: {
    namespace,
    name,
    labels: { ...labels, ...(hash ? { 'pod-template-hash': hash } : {}) },
    ownerReferences: rs ? [{ kind: 'ReplicaSet', name: rs, controller: true }] : []
  },
  status: { podIP: ip }
});

const PODS = [
  pod('istio-system', 'istio-ingressgateway-54648cbc45-aaaaa', '10.0.0.10', {
    rs: 'istio-ingressgateway-54648cbc45',
    hash: '54648cbc45',
    labels: { app: 'istio-ingressgateway' }
  }),
  pod('shop', 'approuter-668bd7f585-l692n', '10.0.0.20', { rs: 'approuter-668bd7f585', hash: '668bd7f585' }),
  pod('shop', 'srv-7944fff5bd-4kq8l', '10.0.0.30', { rs: 'srv-7944fff5bd', hash: '7944fff5bd' }),
  pod('other', 'lonely', '10.0.0.40')
];
const SERVICES = [{ metadata: { name: 'srv', namespace: 'shop' }, spec: { clusterIP: '10.1.0.30' } }];
const index = buildIndex({ pods: { items: PODS }, services: { items: SERVICES }, endpointslices: EMPTY, nodes: EMPTY, gateways: EMPTY });
const workloads = workloadIndex(PODS);

const GW = { pod: 'istio-ingressgateway-54648cbc45-aaaaa', namespace: 'istio-system' };
const AR = { pod: 'approuter-668bd7f585-l692n', namespace: 'shop' };
const SRV = { pod: 'srv-7944fff5bd-4kq8l', namespace: 'shop' };

const line = over => ({
  code: 200,
  method: 'GET',
  path: '/',
  duration: 5,
  requestId: null,
  startTime: '2026-09-25T12:00:00.000Z',
  responseFlags: null,
  ...over
});

// --- small decisions ------------------------------------------------------------------------

test('a TCP line (no method, code 0) fails only on a response flag', () => {
  assert.equal(failed(line({ method: null, code: 0 })), false);
  assert.equal(failed(line({ method: null, code: 0, responseFlags: 'UF' })), true);
  assert.equal(failed(line({ code: 503 })), true);
  assert.equal(failed(line({ code: 304 })), false);
});

test('percentile is nearest-rank and ignores non-numbers', () => {
  assert.equal(percentile([1, 2, 3, 4, NaN, null], 50), 2);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([], 95), null);
});

test('normalizePath folds identifiers and keeps words', () => {
  assert.equal(normalizePath('/orders/1041?x=1'), '/orders/{id}');
  assert.equal(normalizePath('/b/3f2504e0-4f89-11d3-9a0c-0305e82c3301/items'), '/b/{id}/items');
  // A cache-busted bundle name is one endpoint however often the build renames it.
  assert.equal(normalizePath('/static/js/main.4f2a9c1b8e7d.js'), '/static/js/{id}');
  assert.equal(normalizePath('/static/js/app.js'), '/static/js/app.js');
  // Vite's 8-character content hash, measured on applecare.
  assert.equal(normalizePath('/static/css/index.C8X8rNzw.css'), '/static/css/{id}');
  assert.equal(normalizePath('/static/js/toConsumableArray.D-Dx88BQ.js'), '/static/js/{id}');
  assert.equal(normalizePath('/docs/readme.markdown.txt'), '/docs/readme.markdown.txt', 'a word between dots is not a hash');
  assert.equal(normalizePath('/_stcore/health'), '/_stcore/health');
  assert.equal(normalizePath('/x/abc123def456abc123def456'), '/x/{id}');
  assert.equal(normalizePath(null), null);
});

test('a ReplicaSet pod belongs to its Deployment by the pod-template-hash label', () => {
  assert.deepEqual(workloads.get('shop/srv-7944fff5bd-4kq8l'), { kind: 'Deployment', name: 'srv', namespace: 'shop', gateway: false });
  assert.equal(workloads.get('istio-system/istio-ingressgateway-54648cbc45-aaaaa').gateway, true);
  assert.deepEqual(workloads.get('other/lonely'), { kind: 'Pod', name: 'lonely', namespace: 'other', gateway: false });
});

// --- endpoints ------------------------------------------------------------------------------

const trace = over => ({
  traceId: 't',
  method: 'GET',
  authority: 'shop.example.com',
  path: '/orders/1',
  hasError: false,
  totalDurationMs: 10,
  finalStatus: 200,
  startTime: '2026-09-25T12:00:00.000Z',
  ...over
});

test('endpoints group by method, host and folded path, and publish p95 only from enough samples', () => {
  const traces = [
    ...Array.from({ length: MIN_P95_SAMPLES }, (_, i) => trace({ traceId: `a${i}`, path: `/orders/${i}`, totalDurationMs: i + 1 })),
    trace({ traceId: 'e1', path: '/cart', hasError: true, finalStatus: 401, startTime: '2026-09-25T12:05:00.000Z' }),
    trace({ traceId: 'e0', path: '/cart', startTime: '2026-09-25T12:01:00.000Z' })
  ];
  const { endpoints, endpointsFound } = endpointsOf(traces);
  assert.equal(endpointsFound, 2);
  const [orders, cart] = endpoints;
  assert.equal(orders.path, '/orders/{id}');
  assert.equal(orders.journeys, MIN_P95_SAMPLES);
  assert.equal(orders.p95Ms, 19);
  assert.equal(cart.p95Ms, null, 'two samples are not a distribution');
  assert.equal(cart.errorRate, 0.5);
  assert.equal(cart.sampleTraceId, 'e1', 'the sample is the newest journey');
  assert.deepEqual(cart.codes.map(c => c.code).sort(), [200, 401]);
});

// --- service map ----------------------------------------------------------------------------

const map = (records, opts = {}) => serviceMapOf(records, { index, workloads, ...opts });
const edge = (m, from, to) => m.edges.find(e => e.from === from && e.to === to);
const GW_ID = 'wl:istio-system/Deployment/istio-ingressgateway';
const AR_ID = 'wl:shop/Deployment/approuter';
const SRV_ID = 'wl:shop/Deployment/srv';

test('one call seen by both proxies is counted once, from the side that saw more', () => {
  const m = map([
    line({ proxy: AR, upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local', upstreamHost: '10.0.0.30:8080' }),
    line({ proxy: SRV, upstreamCluster: 'inbound|8080||', downstreamRemote: '10.0.0.20:5000' }),
    line({ proxy: SRV, upstreamCluster: 'inbound|8080||', downstreamRemote: '10.0.0.20:5001' })
  ]);
  const e = edge(m, AR_ID, SRV_ID);
  assert.equal(e.calls, 2);
  assert.equal(e.observedBy, 'both');
  assert.equal(m.edges.length, 1);
});

test('an inbound line naming a public client is attributed to the gateway that logged its request id', () => {
  const m = map([
    line({ proxy: GW, requestId: 'r1', upstreamCluster: 'outbound|80||approuter.shop.svc.cluster.local', upstreamHost: '10.0.0.20:80', downstreamRemote: '203.0.113.9:4000' }),
    line({ proxy: AR, requestId: 'r1', upstreamCluster: 'inbound|80||', downstreamRemote: '203.0.113.9:4000' }),
    line({ proxy: AR, requestId: 'r2', upstreamCluster: 'inbound|80||', downstreamRemote: '203.0.113.9:4000' })
  ]);
  assert.equal(edge(m, GW_ID, AR_ID).calls, 1);
  assert.equal(edge(m, GW_ID, AR_ID).observedBy, 'both');
  assert.equal(edge(m, 'clients', AR_ID).calls, 1, 'no gateway line for r2, so it stays External clients');
  assert.equal(edge(m, 'clients', GW_ID).calls, 1, 'the gateway line is also the client’s call to the gateway');
  assert.ok(!JSON.stringify(m).includes('203.0.113.9'), 'a client address never reaches the payload');
});

test('egress keeps its destination address, and a TCP line is tcp with no error', () => {
  const m = map([line({ proxy: SRV, method: null, code: 0, upstreamCluster: 'PassthroughCluster', upstreamHost: '3.214.110.153:443' })]);
  const e = edge(m, SRV_ID, 'ext:3.214.110.153:443');
  assert.equal(e.protocol, 'tcp');
  assert.equal(e.errors, 0);
});

test('the namespace scope keeps edges touching it; keep() drops lines before counting', () => {
  const records = [
    line({ proxy: AR, upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local', upstreamHost: '10.0.0.30:8080' }),
    line({ proxy: AR, path: '/healthz', upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local', upstreamHost: '10.0.0.30:8080' }),
    line({ proxy: GW, upstreamCluster: 'outbound|80||x.other.svc.cluster.local', upstreamHost: '10.0.0.40:80', downstreamRemote: '10.0.0.99:1' })
  ];
  const scoped = map(records, { namespaces: ['shop'], keep: r => r.path !== '/healthz' });
  assert.deepEqual(scoped.edges.map(e => `${e.from}>${e.to}`), [`${AR_ID}>${SRV_ID}`]);
  assert.equal(scoped.edges[0].calls, 1);
  assert.ok(scoped.nodes.every(n => scoped.edges.some(e => e.from === n.id || e.to === n.id)), 'no orphan nodes');
});

test('a line from a proxy outside the pod list is not guessed at', () => {
  const m = map([line({ proxy: { pod: 'ghost', namespace: 'shop' }, upstreamCluster: 'outbound|80||srv.shop.svc.cluster.local', upstreamHost: '10.0.0.30:80' })]);
  assert.equal(m.edges.length, 0);
});

// --- an endpoint's sample journey older than the table's cap ---------------------------------

test('the detail route finds an endpoint sample the cap dropped; the list response never carries it', () => {
  const { listView, pickTrace } = _tracesModule;
  const data = { traces: [{ traceId: 'new' }], endpointSamples: [{ traceId: 'old' }], summary: {} };
  assert.equal(pickTrace(data, 'old').trace.traceId, 'old');
  assert.equal(pickTrace(data, 'new').trace.traceId, 'new');
  assert.equal(pickTrace(data, 'gone').notFoundReason, 'NOT_IN_WINDOW');
  assert.ok(!('endpointSamples' in listView(data)));
  assert.ok(!('endpointSamples' in pickTrace(data, 'old')));
});

// --- review fixes, 2026-09-25 ----------------------------------------------------------------

test('a caller no Pod, Service or Node claims joins External clients — its address never becomes a node', () => {
  // X-Forwarded-For names the client on an inbound sidecar; a private or forged one is still personal.
  const m = map([line({ proxy: AR, upstreamCluster: 'inbound|80||', downstreamRemote: '10.44.3.21:5555' })]);
  assert.equal(edge(m, 'clients', AR_ID).calls, 1);
  assert.ok(!JSON.stringify(m).includes('10.44.3.21'));
  // A callee keeps its address: where traffic went is not the client's.
  const out = map([line({ proxy: SRV, upstreamCluster: 'outbound|80||x.y.svc.cluster.local', upstreamHost: '10.44.9.9:80' })]);
  assert.ok(out.nodes.some(n => n.id === 'unresolved:10.44.9.9'));
});

test('an inbound call over sidecar mTLS is an in-mesh caller, not an external client', () => {
  // Measured: approuter → srv arrives with SNI outbound_.8080_._.srv… and the browser's XFF address.
  const m = map([
    line({ proxy: SRV, upstreamCluster: 'inbound|8080||', downstreamRemote: '203.0.113.9:4000', requestedServerName: 'outbound_.8080_._.srv.shop.svc.cluster.local' }),
    line({ proxy: SRV, upstreamCluster: 'inbound|8080||', downstreamRemote: '203.0.113.9:4001' })
  ]);
  assert.equal(edge(m, 'mesh', SRV_ID).calls, 1);
  assert.equal(edge(m, 'clients', SRV_ID).calls, 1, 'no mesh SNI: still outside');
});

test('a line with no duration is not a 0ms sample on its edge', () => {
  const m = map([
    line({ proxy: AR, duration: null, upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local', upstreamHost: '10.0.0.30:8080' }),
    line({ proxy: AR, duration: 900, upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local', upstreamHost: '10.0.0.30:8080' })
  ]);
  const e = edge(m, AR_ID, SRV_ID);
  assert.equal(e.p50Ms, 900);
  assert.equal(e.samples, 1);
});

test('an endpoint names the workload that served its entry', () => {
  const viaGw = trace({ hops: [{ role: 'ingress', to: { kind: 'Pod', namespace: 'shop', name: AR.pod }, observedBy: GW }] });
  const direct = trace({ path: '/x', hops: [{ role: 'sidecar', to: null, observedBy: SRV }] });
  const outside = trace({ path: '/y', hops: [{ role: 'ingress', to: { kind: 'external' }, observedBy: GW }] });
  // Measured: the gateway names the Service, and the next hop is the pod's own sidecar.
  const svcThenPod = trace({
    path: '/z',
    hops: [
      { role: 'ingress', to: { kind: 'Service', namespace: 'shop', name: 'approuter' }, observedBy: GW },
      { role: 'sidecar', to: { kind: 'Pod', namespace: 'shop', name: AR.pod }, observedBy: AR }
    ]
  });
  const svcOnly = trace({ path: '/w', hops: [{ role: 'ingress', to: { kind: 'Service', namespace: 'shop', name: 'srv' }, observedBy: GW }] });
  const rows = endpointsOf([viaGw, direct, outside, svcThenPod, svcOnly], workloads).endpoints;
  const at = path => rows.find(r => r.path === path).service;
  assert.deepEqual(at('/orders/{id}'), { kind: 'Deployment', name: 'approuter', namespace: 'shop' });
  assert.deepEqual(at('/x'), { kind: 'Deployment', name: 'srv', namespace: 'shop' });
  assert.equal(at('/y'), null);
  assert.deepEqual(at('/z'), { kind: 'Deployment', name: 'approuter', namespace: 'shop' }, 'the sidecar outranks the Service the gateway named');
  assert.deepEqual(at('/w'), { kind: 'Service', name: 'srv', namespace: 'shop' });
});

test('a journey hop never carries the calling client’s address', () => {
  const { hopOf } = _tracesModule;
  const h = hopOf(line({ proxy: GW, upstreamCluster: 'outbound|80||approuter.shop.svc.cluster.local', upstreamHost: '10.0.0.20:80', downstreamRemote: '203.0.113.7:5555' }), index, new Set([`${GW.namespace}/${GW.pod}`]));
  assert.equal(h.from.kind, 'external');
  assert.ok(!JSON.stringify(h).includes('203.0.113.7'));
  const inMesh = hopOf(line({ proxy: SRV, upstreamCluster: 'inbound|8080||', downstreamRemote: '10.0.0.20:5000' }), index, new Set());
  assert.equal(inMesh.from.name, AR.pod, 'a resolved in-cluster caller keeps its identity');
});
