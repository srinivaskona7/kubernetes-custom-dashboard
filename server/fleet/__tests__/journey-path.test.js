/**
 * srv/fleet/collectors/journey-path.js: the path a journey took, edge to BTP. The approuter does
 * not forward x-request-id, so its call to srv is a separate journey joined by time (inferred).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _journey_path from '../collectors/journey-path.js';
const { linkJourneys, pathOf, buildPaths } = _journey_path;

const GW = { namespace: 'istio-system', pod: 'istio-ingressgateway-1' };
const AR = { namespace: 'applecare', pod: 'approuter-1' };
const AR2 = { namespace: 'applecare', pod: 'approuter-2' };
const SRV = { namespace: 'applecare', pod: 'srv-1' };
const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const at = ms => new Date(T0 + ms).toISOString();
const hop = (seq, observedBy, role, startMs, durationMs, to, over = {}) => ({ seq, observedBy, role, startTime: at(startMs), offsetMs: startMs, durationMs, upstreamMs: durationMs - 2, proxyOverheadMs: 2, transitMs: null, code: 200, codeClass: 'ok', method: 'GET', path: '/catalog', flagDetails: [], to, ...over });
const svc = (name, direction) => ({ kind: 'Service', name, namespace: 'applecare', direction });

/** Journey A: gateway -> approuter (request id 1). Journey B: approuter out -> srv in (request id 2). */
function window({ approuterPod = AR, bStart = 5 } = {}) {
  const A = { traceId: 'A', hops: [hop(1, GW, 'ingress', 0, 42, svc('approuter', 'outbound'), { transitMs: 1 }), hop(2, approuterPod, 'sidecar', 0, 40, svc('approuter', 'inbound'))], outbound: [] };
  const B = { traceId: 'B', hops: [hop(1, approuterPod, 'sidecar', bStart, 35, svc('srv', 'outbound'), { transitMs: 1 }), hop(2, SRV, 'sidecar', bStart, 34, svc('srv', 'inbound'))], outbound: [{ to: { id: 'x', kind: 'external', name: '3.214.110.153:443', destination: { display: 'SAP Authorization and Trust (XSUAA) · us10' } }, offsetMs: 4, durationMs: 1200, protocol: 'tcp', failed: false, bytesSent: 10, bytesReceived: 20, candidates: 1 }] };
  return [A, B];
}

test('an approuter outbound journey links to the request its pod was serving, inferred with candidates', () => {
  const links = linkJourneys(window());
  assert.deepEqual(links.get('B'), { parentTraceId: 'A', parentSeq: 2, candidates: 1 });
});

test('innermost in-flight wins, and every candidate is counted', () => {
  const [A, B] = window();
  const A2 = { traceId: 'A2', hops: [hop(1, AR, 'sidecar', 3, 30, svc('approuter', 'inbound'))], outbound: [] };
  const links = linkJourneys([A, A2, B]);
  assert.deepEqual(links.get('B'), { parentTraceId: 'A2', parentSeq: 1, candidates: 2 });
});

test('zero candidates gives no link', () => {
  const links = linkJourneys(window({ bStart: 500 }));
  assert.equal(links.has('B'), false);
});

test("another pod's request is never a candidate", () => {
  const [A] = window();
  const [, B] = window({ approuterPod: AR2 });
  assert.equal(linkJourneys([A, B]).has('B'), false);
});

test('path: edge, gateway, approuter, srv, XSUAA; the inferred edge is labelled, externals carry no latency', () => {
  const traces = window();
  const paths = buildPaths(traces, { proxiesRead: new Set(['istio-system/istio-ingressgateway-1', 'applecare/approuter-1', 'applecare/srv-1']), declared: new Map() });
  const p = paths.get('A');
  assert.deepEqual(p.path.nodes.map(n => n.kind), ['edge', 'gateway', 'workload', 'workload', 'external']);
  assert.deepEqual(p.path.nodes.map(n => n.label), ['Load balancer', 'istio-ingressgateway-1', 'approuter-1', 'srv-1', 'SAP Authorization and Trust (XSUAA) · us10']);
  const inferred = p.path.edges.find(e => e.link === 'inferred' && p.path.nodes.find(n => n.id === e.to).label === 'srv-1');
  assert.deepEqual([inferred.candidates, inferred.transitMs], [1, null]);
  const ext = p.path.nodes[4];
  assert.equal('durationMs' in ext, false, 'an external node has no durationMs');
  assert.deepEqual([ext.openedAtMs, ext.openForMs, ext.seen], [9, 1200, true]);
});

test('the edge node carries the LB and Gateway facts already collected, never a client address', () => {
  const traces = window();
  const edge = {
    lb: { type: 'LoadBalancer', hostname: 'my-elb-123.elb.amazonaws.com', addressOnly: false, externalTrafficPolicy: 'Local', sourceRangesCount: 0 },
    gateways: [{ namespace: 'istio-system', name: 'kyma-gateway', servers: [{ hosts: ['*.c.example.com'], tlsMode: 'SIMPLE', credentialName: 'kyma-tls' }] }]
  };
  const paths = buildPaths(traces, { proxiesRead: new Set(['istio-system/istio-ingressgateway-1']), declared: new Map(), edge });
  const node = paths.get('A').path.nodes[0];
  assert.equal(node.kind, 'edge');
  assert.deepEqual(node.edge, edge);
  assert.doesNotMatch(JSON.stringify(node), /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, 'never an IP in the edge facts');
});

test('with no edge facts passed the edge node carries no `edge` key (older call sites, no shape change)', () => {
  const traces = window();
  const paths = buildPaths(traces, { proxiesRead: new Set(), declared: new Map() });
  const node = paths.get('A').path.nodes[0];
  assert.equal('edge' in node, false);
});

test('every edge names two nodes of its path, and every inferred edge carries a candidates count', () => {
  const p = buildPaths(window(), { proxiesRead: new Set(), declared: new Map() }).get('A').path;
  const ids = new Set(p.nodes.map(n => n.id));
  assert.equal(ids.size, p.nodes.length, 'node ids are unique');
  for (const e of p.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from} -> ${e.to} dangles`);
    if (e.link === 'inferred') assert.equal(typeof e.candidates, 'number');
  }
});

test('exact edges inside one journey carry the hop transit', () => {
  const paths = buildPaths(window(), { proxiesRead: new Set(), declared: new Map() });
  const e = paths.get('A').path.edges.find(x => x.link === 'exact' && x.transitMs !== null);
  assert.equal(e.transitMs, 1);
});

test('a callee whose proxy was not read is a notRead node, not a missing hop', () => {
  const A = { traceId: 'A', hops: [hop(1, GW, 'ingress', 0, 42, { kind: 'Service', name: 'orders', namespace: 'shop', direction: 'outbound' })], outbound: [] };
  const p = buildPaths([A], { proxiesRead: new Set(['istio-system/istio-ingressgateway-1']), declared: new Map() }).get('A');
  const last = p.path.nodes[p.path.nodes.length - 1];
  assert.deepEqual([last.kind, last.label, last.reason], ['notRead', 'orders', 'no proxy in shop was read']);
});

test('a declared BTP destination with no line is "connection reused", seen false, never 0 ms', () => {
  const declared = new Map([['applecare', [{ display: 'SAP HANA Cloud · us10', namespace: 'applecare', policyName: 'egress-allow-btp-traffic' }]]]);
  const p = buildPaths(window(), { proxiesRead: new Set(), declared }).get('A');
  const hana = p.path.nodes.find(n => n.label === 'SAP HANA Cloud · us10');
  assert.deepEqual([hana.kind, hana.seen, hana.openForMs], ['external', false, null]);
});

test('no client IP in any path', () => {
  // A client address on the hop, as a caller that did not strip it would leave it: the path copies none of it.
  const [A, B] = window();
  A.hops[0].from = { kind: 'external', ip: '203.0.113.7', name: '203.0.113.7' };
  A.hops[0].downstreamRemote = '203.0.113.7:51234';
  const p = buildPaths([A, B], { proxiesRead: new Set(), declared: new Map() }).get('A');
  assert.doesNotMatch(JSON.stringify(p), /203\.0\.113|downstreamRemote/);
});

test('a journey with no hops has path null and a reason', () => {
  const p = buildPaths([{ traceId: 'E', hops: [], outbound: [] }], { proxiesRead: new Set(), declared: new Map() }).get('E');
  assert.equal(p.path, null);
  assert.equal(p.pathReason, 'no hop of this journey was in the window');
});

test('pathOf is exported for one journey', () => {
  assert.equal(typeof pathOf, 'function');
});

test('two journeys joined to each other are drawn once each, never looped', () => {
  const P = { namespace: 'applecare', pod: 'p-1' };
  const Q = { namespace: 'applecare', pod: 'q-1' };
  const T1 = { traceId: 'T1', hops: [hop(1, P, 'sidecar', 5, 20, svc('q', 'outbound')), hop(2, Q, 'sidecar', 0, 100, svc('q', 'inbound'))], outbound: [] };
  const T2 = { traceId: 'T2', hops: [hop(1, Q, 'sidecar', 5, 20, svc('p', 'outbound')), hop(2, P, 'sidecar', 0, 100, svc('p', 'inbound'))], outbound: [] };
  const p = buildPaths([T1, T2], { proxiesRead: new Set(), declared: new Map() }).get('T1').path;
  const ids = p.nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate node ids: ${ids.join(', ')}`);
});
