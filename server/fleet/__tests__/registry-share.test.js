/** registry-share.js: one registry per cluster and credential, never shared across fingerprints. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _registry_share from '../collectors/registry-share.js';
const { createRegistryShare } = _registry_share;
import traffic from '../collectors/traffic.js';

const ctx = (id, token) => ({ cluster: { id }, token });

test('one build per cluster and credential while fresh; in-flight callers join it', async () => {
  let t = 0;
  let builds = 0;
  const share = createRegistryShare({ now: () => t });
  const build = async () => ({ n: ++builds });
  const [a, b] = await Promise.all([share.get(ctx('c1', 'tok-a'), build), share.get(ctx('c1', 'tok-a'), build)]);
  assert.equal(a, b);
  assert.equal(builds, 1);
  t = 59_000;
  assert.equal((await share.get(ctx('c1', 'tok-a'), build)).n, 1);
  t = 61_000;
  assert.equal((await share.get(ctx('c1', 'tok-a'), build)).n, 2, 'past 60s it is rebuilt');
});

test('two fingerprints never share, nor two clusters', async () => {
  let builds = 0;
  const share = createRegistryShare();
  const build = async () => ({ n: ++builds });
  await share.get(ctx('c1', 'tok-a'), build);
  await share.get(ctx('c1', 'tok-b'), build);
  await share.get(ctx('c2', 'tok-a'), build);
  assert.equal(builds, 3);
});

test('maxAgeMs 0 always builds; a failed build is not kept', async () => {
  let builds = 0;
  const share = createRegistryShare();
  await share.get(ctx('c1', 't'), async () => ({ n: ++builds }));
  await share.get(ctx('c1', 't'), async () => ({ n: ++builds }), { maxAgeMs: 0 });
  assert.equal(builds, 2);
  await assert.rejects(share.get(ctx('c9', 't'), async () => { throw new Error('boom'); }));
  assert.equal((await share.get(ctx('c9', 't'), async () => ({ ok: 1 }))).ok, 1);
});

test('readRegistry: names, routes with backends and Gateway hosts from one set of reads; a refusal stays unavailable', async () => {
  const listFn = async ({ path }) => {
    // k8s.list resolves to the items array.
    if (path.includes('/gateways')) return [{ metadata: { namespace: 'kyma-system', name: 'kyma-gateway' }, spec: { servers: [{ hosts: ['*.c.example.com'] }] } }];
    if (path.includes('/virtualservices')) return [{ metadata: { namespace: 'shop', name: 'vs' }, spec: { hosts: ['shop.c.example.com'], http: [{ route: [{ destination: { host: 'srv' } }] }] } }];
    if (path.includes('/networkpolicies')) return [{ metadata: { namespace: 'shop', name: 'p' }, spec: { egress: [{ to: [{ ipBlock: { cidr: '52.1.2.3/32' } }] }] } }];
    if (path.includes('/apirules')) { const e = new Error('forbidden'); e.status = 403; throw e; }
    return [];
  };
  const reg = await traffic.readRegistry({ listFn, baseCtx: ctx('c1', 't') });
  assert.equal(reg.names.byIp.get('52.1.2.3')[0].policyName, 'p');
  assert.deepEqual(reg.routes.map(r => [r.host, r.backends]), [['shop.c.example.com', [{ name: 'srv', namespace: 'shop' }]]]);
  assert.deepEqual(reg.gatewayHosts.map(g => g.host), ['*.c.example.com']);
  assert.equal(reg.reads.apirules.unavailable, true);
});
