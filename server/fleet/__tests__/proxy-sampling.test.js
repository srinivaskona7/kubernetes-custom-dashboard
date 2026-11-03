/** selectProxies: ingress, then route backends, then the rest; one pod per workload before a second. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _traffic from '../collectors/traffic.js';
const { selectProxies, buildRouteIndex, routeBackendSelectors } = _traffic;
import _pod_owner2 from '../collectors/pod-owner.js';
const { ownerOf } = _pod_owner2;

const ok = items => ({ items, unavailable: false });
function pod(ns, name, { labels = {}, owner = null, hash = null, restarts = 0 } = {}) {
  return {
    metadata: { namespace: ns, name, labels: { ...labels, ...(hash ? { 'pod-template-hash': hash } : {}) }, ownerReferences: owner ? [{ kind: 'ReplicaSet', name: owner, controller: true }] : [] },
    spec: { containers: [{ name: 'app' }, { name: 'istio-proxy' }] },
    status: { phase: 'Running', containerStatuses: [{ restartCount: restarts }] }
  };
}
const gw = n => pod('istio-system', `istio-ingressgateway-${n}`, { labels: { istio: 'ingressgateway' } });
const rs = (ns, wl, i, extra = {}) => pod(ns, `${wl}-7d9f-${i}`, { owner: `${wl}-7d9f`, hash: '7d9f', labels: { app: wl }, ...extra });

test('ownerOf strips the ReplicaSet hash to the Deployment', () => {
  assert.deepEqual(ownerOf(rs('shop', 'srv', 'a')), { kind: 'Deployment', name: 'srv' });
  assert.deepEqual(ownerOf(pod('shop', 'bare')), { kind: 'Pod', name: 'bare' });
});

test('route backends: VirtualService destinations and APIRule v2 services', () => {
  const routes = buildRouteIndex({
    virtualservices: ok([{ metadata: { namespace: 'shop', name: 'vs' }, spec: { hosts: ['shop.c.example.com'], http: [{ route: [{ destination: { host: 'approuter' } }, { destination: { host: 'srv.shop.svc.cluster.local' } }] }] } }]),
    apirules: ok([{ metadata: { namespace: 'shop', name: 'ar' }, spec: { hosts: ['api'], service: { name: 'api' }, rules: [{ service: { name: 'other', namespace: 'b' } }] } }])
  });
  assert.deepEqual(routes.find(r => r.kind === 'VirtualService').backends, [{ name: 'approuter', namespace: 'shop' }, { name: 'srv', namespace: 'shop' }]);
  assert.deepEqual(routes.find(r => r.kind === 'APIRule').backends, [{ name: 'api', namespace: 'shop' }, { name: 'other', namespace: 'b' }]);
  const services = ok([{ metadata: { namespace: 'shop', name: 'approuter' }, spec: { selector: { app: 'approuter' } } }, { metadata: { namespace: 'shop', name: 'srv' }, spec: {} }]);
  assert.deepEqual(routeBackendSelectors(routes, services), [{ namespace: 'shop', selector: { app: 'approuter' } }], 'a selectorless Service backs no pod');
  assert.deepEqual(routeBackendSelectors(routes, { unavailable: true }), []);
});

test('tiers: ingress, then route backends, then the rest; one pod per workload first', () => {
  const pods = [
    ...['a', 'b', 'c', 'd'].map(i => rs('noisy', 'chatty', i, { restarts: 9 })),
    rs('shop', 'approuter', 'a'),
    rs('shop', 'srv', 'a'),
    rs('shop', 'srv', 'b'),
    gw('1')
  ];
  const backends = [{ namespace: 'shop', selector: { app: 'approuter' } }, { namespace: 'shop', selector: { app: 'srv' } }];
  const names = selectProxies(pods, { maxPods: 5, backends }).selected.map(p => p.metadata.name);
  assert.deepEqual(names, ['istio-ingressgateway-1', 'approuter-7d9f-a', 'srv-7d9f-a', 'srv-7d9f-b', 'chatty-7d9f-a']);
});

test('without backends, one pod per workload still comes before a second', () => {
  const pods = [rs('a', 'x', '1', { restarts: 5 }), rs('a', 'x', '2', { restarts: 5 }), rs('b', 'y', '1')];
  assert.deepEqual(selectProxies(pods, { maxPods: 2 }).selected.map(p => p.metadata.name), ['x-7d9f-1', 'y-7d9f-1']);
  assert.deepEqual(selectProxies(pods, { maxPods: 2, backends: null }).selected.map(p => p.metadata.name), ['x-7d9f-1', 'y-7d9f-1']);
});
