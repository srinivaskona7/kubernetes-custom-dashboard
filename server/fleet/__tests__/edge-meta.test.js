/**
 * srv/fleet/collectors/edge.js edgeMetaOf(): the non-timing facts already collected about the
 * ingress LB Service and the Gateways that front it, for the Traces journey's Edge node.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _edge from '../collectors/edge.js';
import _edgeModule from '../collectors/edge.js';
const { edgeMetaOf } = _edge;

const LABELS = { istio: 'ingressgateway' };
const NS = 'istio-system';

const svc = over => ({
  metadata: { namespace: NS, name: 'istio-ingressgateway' },
  spec: { type: 'LoadBalancer', selector: LABELS, loadBalancerSourceRanges: [] },
  status: { loadBalancer: { ingress: [{ hostname: 'my-lb-123.elb.amazonaws.com' }] } },
  ...over
});

const gw = over => ({
  metadata: { namespace: NS, name: 'kyma-gateway' },
  spec: { selector: LABELS, servers: [{ hosts: ['*.c.example.com'], tls: { mode: 'SIMPLE', credentialName: 'kyma-tls' } }] },
  ...over
});

test('the LB Service type, hostname, externalTrafficPolicy and source-range count are surfaced', () => {
  const out = edgeMetaOf({
    services: { items: [svc({ spec: { type: 'LoadBalancer', selector: LABELS, externalTrafficPolicy: 'Local', loadBalancerSourceRanges: ['203.0.113.0/24'] } })], unavailable: false },
    gateways: { items: [], unavailable: false },
    gatewayLabels: LABELS,
  });
  assert.deepEqual(out.lb, { type: 'LoadBalancer', hostname: 'my-lb-123.elb.amazonaws.com', addressOnly: false, externalTrafficPolicy: 'Local', sourceRangesCount: 1 });
});

test('an LB with only an IP says "address only", never publishes the address', () => {
  const out = edgeMetaOf({
    services: { items: [svc({ status: { loadBalancer: { ingress: [{ ip: '203.0.113.9' }] } } })], unavailable: false },
    gateways: { items: [], unavailable: false },
    gatewayLabels: LABELS,
  });
  assert.equal(out.lb.hostname, null);
  assert.equal(out.lb.addressOnly, true);
  assert.doesNotMatch(JSON.stringify(out), /203\.0\.113\.9/, 'no IP on the wire');
});

test('loadBalancerSourceRanges really read as empty is 0, not absent', () => {
  const out = edgeMetaOf({
    services: { items: [svc()], unavailable: false },
    gateways: { items: [], unavailable: false },
    gatewayLabels: LABELS,
  });
  assert.equal(out.lb.sourceRangesCount, 0);
});

test('a Service read successfully with no loadBalancerSourceRanges key at all is also 0, never "not read" (live platformsbx shape)', () => {
  const noKey = svc({ spec: { type: 'LoadBalancer', selector: LABELS } });
  assert.equal('loadBalancerSourceRanges' in noKey.spec, false);
  const out = edgeMetaOf({
    services: { items: [noKey], unavailable: false },
    gateways: { items: [], unavailable: false },
    gatewayLabels: LABELS,
  });
  assert.equal(out.lb.sourceRangesCount, 0);
});

test('the Gateway hosts, TLS mode and credentialName (name only) are listed for Gateways selecting the ingress workload', () => {
  const out = edgeMetaOf({
    services: { items: [], unavailable: false },
    gateways: { items: [gw()], unavailable: false },
    gatewayLabels: LABELS,
  });
  assert.deepEqual(out.gateways, [{ namespace: NS, name: 'kyma-gateway', servers: [{ hosts: ['*.c.example.com'], tlsMode: 'SIMPLE', credentialName: 'kyma-tls' }] }]);
});

test('a Gateway that does not select the ingress workload is left out', () => {
  const other = gw({ metadata: { namespace: 'applecare', name: 'other-gw' }, spec: { selector: { app: 'other' }, servers: [] } });
  const out = edgeMetaOf({
    services: { items: [], unavailable: false },
    gateways: { items: [other], unavailable: false },
    gatewayLabels: LABELS,
  });
  assert.deepEqual(out.gateways, []);
});

test('a Gateway with no selector, or an empty one, does not vacuously match every workload', () => {
  const noSelector = gw({ metadata: { namespace: 'applecare', name: 'no-selector-gw' }, spec: { servers: [] } });
  const emptySelector = gw({ metadata: { namespace: 'applecare', name: 'empty-selector-gw' }, spec: { selector: {}, servers: [] } });
  const out = edgeMetaOf({
    services: { items: [], unavailable: false },
    gateways: { items: [noSelector, emptySelector], unavailable: false },
    gatewayLabels: LABELS,
  });
  assert.deepEqual(out.gateways, []);
});

test('a failed Service or Gateway read is null, never an empty result mistaken for "none configured"', () => {
  const out = edgeMetaOf({
    services: { items: [], unavailable: true },
    gateways: { items: [], unavailable: true },
    gatewayLabels: LABELS,
  });
  assert.equal(out.lb, null);
  assert.equal(out.gateways, null);
});

// Live platformsbx shape (2026-09-28): the LB Service and kyma-gateway select on BOTH `app` and
// `istio`, so matching them against `{istio}` alone found no LB and dropped kyma-gateway. The
// labels to match against are the ingress pod's own, read from the pods list already in hand.
test('the ingress labels come from the gateway pod, so a two-key Service and Gateway selector still match', () => {
  const { ingressLabelsOf } = _edgeModule;
  const podLabels = { app: 'istio-ingressgateway', istio: 'ingressgateway', 'pod-template-hash': 'x' };
  const pods = { items: [{ metadata: { namespace: NS, name: 'istio-ingressgateway-1', labels: podLabels } }, { metadata: { namespace: 'applecare', name: 'srv-1', labels: { app: 'srv' } } }] };
  const both = { app: 'istio-ingressgateway', istio: 'ingressgateway' };
  const out = edgeMetaOf({
    services: { items: [svc({ spec: { type: 'LoadBalancer', selector: both } })], unavailable: false },
    gateways: { items: [gw({ metadata: { namespace: 'kyma-system', name: 'kyma-gateway' }, spec: { selector: both, servers: [] } }), gw({ metadata: { namespace: 'kyma-system', name: 'connectivity-proxy-tunnel' }, spec: { selector: LABELS, servers: [] } })], unavailable: false },
    gatewayLabels: ingressLabelsOf(pods)
  });
  assert.equal(out.lb.hostname, 'my-lb-123.elb.amazonaws.com');
  assert.deepEqual(out.gateways.map(g => g.name).sort(), ['connectivity-proxy-tunnel', 'kyma-gateway']);
});

test('with no gateway pod in the read, the ingress labels fall back to both chart labels', () => {
  const { ingressLabelsOf } = _edgeModule;
  assert.deepEqual(ingressLabelsOf({ items: [] }), { app: 'istio-ingressgateway', istio: 'ingressgateway' });
  assert.deepEqual(ingressLabelsOf(null), { app: 'istio-ingressgateway', istio: 'ingressgateway' });
});
