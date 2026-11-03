/** request-class.js: one class per record, the spec's table row by row. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _request_class from '../collectors/request-class.js';
const { classify, classifyJourney, NOISE_CLASSES } = _request_class;
import _destination_names2 from '../destination-names.js';
const { buildNameIndex } = _destination_names2;

const ok = items => ({ items, unavailable: false });
const registry = buildNameIndex({ networkPolicies: ok([{ metadata: { namespace: 'shop', name: 'allow-api', annotations: {} }, spec: { egress: [{ to: [{ ipBlock: { cidr: '52.1.2.3/32' } }] }] } }]) });
const refused = buildNameIndex({ networkPolicies: { items: [], unavailable: true } });
const CTX = {
  registry,
  gatewayHosts: [{ host: '*.c.example.com' }],
  routes: [
    { host: 'shop.c.example.com', namespace: 'shop' },
    { host: 'grafana.c.example.com', namespace: 'kyma-system' }
  ]
};
const rec = over => ({ method: 'GET', authority: 'shop.c.example.com', path: '/', code: 200, responseCodeDetails: 'via_upstream', responseFlags: null, ...over });
const edge = (over, ctx = CTX) => classify(rec(over), { ...ctx, direction: 'edge' });
const out = (ip, ctx = CTX) => classify(rec({ authority: null }), { ...ctx, direction: 'outbound', upstream: { kind: 'external', ip } });

test('the spec table, row by row', () => {
  assert.equal(edge({ responseCodeDetails: 'filter_chain_not_found', authority: null, code: 0 }), 'direct-or-tls');
  assert.equal(edge({ authority: '98.83.101.14' }), 'direct-or-tls');
  assert.equal(edge({ authority: null, code: 400 }), 'direct-or-tls');
  assert.equal(edge({ authority: 'shop.other.org' }), 'direct-or-tls', 'admitted by no Gateway and no route');
  assert.equal(edge({ code: 403, responseCodeDetails: 'rbac_access_denied_matched_policy[none]' }), 'security-refused');
  assert.equal(edge({ authority: 'healthz.c.example.com' }), 'probe');
  assert.equal(classify(rec({ path: '/healthz' }), { ...CTX, direction: 'inbound' }), 'probe');
  assert.equal(edge({ authority: 'cp.c.example.com' }), 'platform');
  assert.equal(edge({ authority: 'grafana.c.example.com' }), 'platform');
  assert.equal(out('52.1.2.3'), 'egress-declared');
  assert.equal(out('8.8.8.8'), 'egress-undeclared');
  assert.equal(edge({}), 'app');
});

test('an unreadable NetworkPolicy list never makes an address undeclared', () => {
  assert.equal(out('8.8.8.8', { ...CTX, registry: refused }), 'egress-unverified');
  assert.equal(out('8.8.8.8', { ...CTX, registry: null }), 'egress-unverified');
});

test('a sidecar inbound call to an internal host is app, not direct-IP: the Gateway rule is the edge only', () => {
  assert.equal(classify(rec({ authority: 'srv.shop.svc.cluster.local:4004' }), { ...CTX, direction: 'inbound' }), 'app');
  assert.equal(classify(rec({}), { ...CTX, direction: 'outbound', upstream: { kind: 'Service', ip: '100.64.1.1' } }), 'app');
});

test('polls:false keeps the edge rule healthz-host only, so Ingress numbers do not move', () => {
  assert.equal(edge({ path: '/healthz' }, { ...CTX, polls: false }), 'app');
});

test('a failed liveness poll is not probe noise: it is what the operator came to see', () => {
  assert.equal(classify(rec({ path: '/healthz', code: 503 }), { ...CTX, direction: 'inbound' }), 'app');
  assert.equal(classify(rec({ path: '/healthz', code: 0, responseFlags: 'UF' }), { ...CTX, direction: 'inbound' }), 'app');
  // A 4xx is not an `APP_FAILURE_FLAGS`/5xx upstream failure, but it is still the health check
  // refusing or erroring, not answering "alive" — hiding it in the probe bucket buries a real
  // failure among noise the Endpoints table drops by default.
  assert.equal(classify(rec({ path: '/healthz', code: 404 }), { ...CTX, direction: 'inbound' }), 'app');
});

const hop = over => ({ role: 'sidecar', authority: 'shop.c.example.com', path: '/', code: 200, codeClass: 'ok', responseCodeDetails: 'via_upstream', responseFlags: null, observedBy: { namespace: 'shop', pod: 'srv-1' }, to: { kind: 'Pod', direction: 'inbound' }, ...over });

test('a journey takes its class from the ingress hop, else the first hop', () => {
  const t = { hops: [hop({ code: 503, codeClass: 'server' }), hop({ role: 'ingress', code: 403, responseCodeDetails: 'rbac_access_denied_matched_policy[none]' })] };
  assert.deepEqual(classifyJourney(t, CTX), { class: 'security-refused', appError: false });
});

test('an app error is app with a 5xx or an upstream-failure flag on any hop; a refused 4xx never is', () => {
  assert.equal(classifyJourney({ hops: [hop({ role: 'ingress' }), hop({ code: 503, codeClass: 'server' })] }, CTX).appError, true);
  assert.equal(classifyJourney({ hops: [hop({ role: 'ingress', code: 0, codeClass: 'no-response', responseFlags: 'UF,URX' })] }, CTX).appError, true);
  assert.equal(classifyJourney({ hops: [hop({ role: 'ingress', code: 404, codeClass: 'client' })] }, CTX).appError, false);
  assert.equal(classifyJourney({ hops: [hop({ role: 'ingress', authority: '1.2.3.4', code: 503, codeClass: 'server' })] }, CTX).appError, false);
});

test('an outbound first hop to a registry-named address is declared egress', () => {
  const t = { hops: [hop({ authority: null, to: { kind: 'external', ip: '52.1.2.3', direction: null } })] };
  assert.equal(classifyJourney(t, CTX).class, 'egress-declared');
  assert.ok(NOISE_CLASSES.has('probe') && NOISE_CLASSES.has('security-refused') && NOISE_CLASSES.has('direct-or-tls'));
  assert.equal(classifyJourney({ hops: [] }, CTX).class, 'app');
});

test('with the Gateways and every route unread, a named host is not called direct-IP: nothing says it is', () => {
  const blind = { registry, gatewayHosts: [], routes: [], hostsUnknown: true };
  assert.equal(edge({}, blind), 'app');
  assert.equal(edge({ authority: '98.83.101.14' }, blind), 'direct-or-tls', 'a bare address needs no Gateway to judge');
  const j = classifyJourney({ hops: [{ role: 'ingress', authority: 'shop.c.example.com', path: '/api/orders', code: 503, responseCodeDetails: 'via_upstream' }] }, blind);
  assert.deepEqual(j, { class: 'app', appError: true });
  assert.equal(edge({}, { ...blind, hostsUnknown: false }), 'direct-or-tls', 'read and empty still means admitted by nothing');
});
