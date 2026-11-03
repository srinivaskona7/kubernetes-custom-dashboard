/*
  The edge, classified (srv/fleet/collectors/edge.js) and wired into /traffic-errors.

  The shapes here are the ones platformsbx served on 2026-09-26: a healthz probe dominating the
  sample, the `apple-acl` ALLOW policy refusing with `rbac_access_denied_matched_policy[none]`,
  TLS connections dying at `filter_chain_not_found`, twelve `stats-filter-1.1x` EnvoyFilters that
  cannot match Istio 1.30, and a Gardener Certificate carrying `status.renewalDate`.
*/

import { test } from 'vitest';
import assert from 'node:assert';

import edge from '../collectors/edge.js';
import _traffic from '../collectors/traffic.js';
const { collect } = _traffic;

const ok = items => ({ items, unavailable: false, reason: null, detail: null, truncated: false });
const gone = reason => ({ items: [], unavailable: true, reason, detail: null, truncated: false });

const CTX = {
  // The shape `buildIndex` in traffic.js really hands over: rows, not strings. A string fixture hid
  // a bug where every Gateway-admitted host fell to direct-ip.
  gatewayHosts: [{ host: '*.c.example.com', name: 'kyma-gateway', namespace: 'kyma-system', port: 443 }],
  routes: [
    { host: 'shop.c.example.com', kind: 'APIRule', name: 'shop', namespace: 'shop' },
    { host: '*.c.example.com', kind: 'VirtualService', name: 'wild', namespace: 'kyma-system' },
    { host: 'grafana.c.example.com', kind: 'VirtualService', name: 'grafana', namespace: 'kyma-system' }
  ]
};

function rec(over = {}) {
  return { method: 'GET', authority: 'shop.c.example.com', code: 200, responseCodeDetails: 'via_upstream', responseFlags: null, duration: 20, upstreamMs: 15, downstreamRemote: '203.0.113.9:1', proxy: { namespace: 'istio-system', pod: 'gw-1' }, ...over };
}

// ------------------------------------------------------------------ classes

test('every record gets exactly one class, first match wins', () => {
  const c = r => edge.classifyEdgeRecord(rec(r), CTX);
  assert.strictEqual(c({ method: null, authority: null, code: 0, responseCodeDetails: 'filter_chain_not_found' }), 'tls-rejected');
  assert.strictEqual(c({ authority: '98.83.101.14' }), 'direct-ip');
  assert.strictEqual(c({ authority: '127.0.0.1:443' }), 'direct-ip');
  assert.strictEqual(c({ authority: null, code: 400 }), 'direct-ip');
  assert.strictEqual(c({ authority: 'shop.other.org' }), 'direct-ip', 'admitted by no Gateway and no route');
  assert.strictEqual(c({ code: 403, responseCodeDetails: 'rbac_access_denied_matched_policy[none]' }), 'policy-blocked');
  assert.strictEqual(c({ authority: 'healthz.c.example.com' }), 'probe');
  assert.strictEqual(c({ authority: 'cp.c.example.com' }), 'platform');
  assert.strictEqual(c({ authority: 'grafana.c.example.com' }), 'platform', 'routed to a system namespace');
  // The wildcard system route must not swallow an app host that has its own route.
  assert.strictEqual(c({}), 'app');
});

test('the app headline counts app traffic only, and withholds p95 under the sample floor', () => {
  const records = [
    ...Array.from({ length: 50 }, () => rec({ authority: 'healthz.c.example.com', duration: 1, upstreamMs: 1 })),
    ...Array.from({ length: 30 }, () => rec({ code: 403, responseCodeDetails: 'rbac_access_denied_matched_policy[none]' })),
    rec({ code: 503, upstreamMs: 900 }),
    rec({ code: 404 }),
    rec()
  ];
  const { app, classes } = edge.edgeClasses(records, CTX);
  assert.strictEqual(app.requests, 3);
  assert.strictEqual(app.errors, 2);
  assert.strictEqual(app.server, 1);
  assert.strictEqual(app.notFound, 1);
  assert.strictEqual(app.p95Ms, null, '3 samples is below minSamples');
  assert.strictEqual(app.p50Ms, 15);
  assert.strictEqual(classes.total, records.length);
  assert.strictEqual(classes.rows.find(r => r.key === 'probe').records, 50);
  assert.strictEqual(app.hosts[0].server, 1);
  // Canary: over every record the share would be the scanner's, 31 of 83.
  assert.notStrictEqual(app.errors, records.filter(r => r.code >= 400).length);

  const many = Array.from({ length: edge.MIN_P95_SAMPLES }, (_, i) => rec({ upstreamMs: i + 1 }));
  assert.strictEqual(edge.edgeClasses(many, CTX).app.p95Ms, 19);
});

// ------------------------------------------------------------------ certificates

const NOW = Date.parse('2026-09-26T00:00:00Z');
function cert(name, { expires, renewal, state = 'Ready', secret = name } = {}) {
  return {
    metadata: { name, namespace: 'istio-system' },
    spec: { commonName: `${name}.example.com`, secretRef: { name: secret, namespace: 'istio-system' } },
    status: { expirationDate: expires, renewalDate: renewal, state, issuerRef: { name: 'garden' } }
  };
}

test('certificates join Gateway servers by Secret name and warn only on a missed renewal', () => {
  const gatewayRows = [{ key: 'kyma-system/kyma-gateway#https', namespace: 'kyma-system', name: 'kyma-gateway', port: 443, tlsMode: 'SIMPLE', credentialName: 'kyma-tls', hosts: ['*.c.example.com'] }];
  const certs = edge.certificateRows(ok([
    cert('kyma-tls', { expires: '2026-11-04T00:00:00Z', renewal: '2026-10-05T00:00:00Z' }),
    cert('late', { expires: '2026-10-20T00:00:00Z', renewal: '2026-09-20T00:00:00Z' }),
    cert('soon', { expires: '2026-09-30T00:00:00Z', renewal: '2026-08-31T00:00:00Z' }),
    cert('broken', { expires: '2026-12-01T00:00:00Z', renewal: '2026-11-01T00:00:00Z', state: 'Error' })
  ]), gatewayRows, NOW);
  const byName = Object.fromEntries(certs.items.map(c => [c.name, c]));
  assert.deepEqual(byName['kyma-tls'].usedBy, ['kyma-system/kyma-gateway#https']);
  assert.strictEqual(byName['kyma-tls'].daysLeft, 39);
  assert.strictEqual(byName['kyma-tls'].renewalOverdue, false);

  const att = edge.attentionOf({ certificates: certs, app: { hosts: [] }, hosts: [], routes: [], access: { peerAuthentications: [] }, envoyFilters: { dead: 0 }, gatewayRows });
  const kinds = att.map(a => `${a.severity}:${a.ref}`);
  assert.ok(!kinds.some(k => k.endsWith('kyma-tls')), '39 days before a pending renewal is steady state');
  assert.ok(kinds.includes('warning:istio-system/late'));
  assert.ok(kinds.includes('critical:istio-system/soon'));
  assert.ok(kinds.includes('critical:istio-system/broken'));
  assert.strictEqual(att[0].severity, 'critical');

  const chain = edge.hostChain('shop.c.example.com', { gatewayRows, certificates: certs, dnsEntries: { items: [], unavailable: true } });
  assert.strictEqual(chain.dns, undefined, 'an unread DNSEntry list is unknown, not absent');
  assert.strictEqual(chain.servers[0].certificate.name, 'kyma-tls');
});

test('an unreadable Certificate list says so instead of reading as none', () => {
  const certs = edge.certificateRows(gone('FORBIDDEN'), [], NOW);
  assert.deepEqual(certs, { items: [], unavailable: true, reason: 'FORBIDDEN' });
});

// ------------------------------------------------------------------ EnvoyFilters and access

test('an EnvoyFilter whose proxyVersion cannot match the running Istio is dead', () => {
  const pods = ok([{ metadata: { labels: { app: 'istiod' } }, spec: { containers: [{ image: 'europe-docker.pkg.dev/kyma-project/prod/external/istio/pilot:1.30.4-distroless' }] } }]);
  const version = edge.istioVersionOf(pods);
  assert.strictEqual(version, '1.30.4');
  const rows = edge.envoyFilterRows(ok([
    { metadata: { name: 'stats-filter-1.16', namespace: 'istio-system' }, spec: { configPatches: [{ match: { proxy: { proxyVersion: '^1\\.16.*' } } }] } },
    { metadata: { name: 'proxy-protocol', namespace: 'istio-system' }, spec: { workloadSelector: { labels: { istio: 'ingressgateway' } }, configPatches: [{ patch: { value: { name: 'envoy.filters.listener.proxy_protocol' } } }] } },
    { metadata: { name: 'evil', namespace: 'x' }, spec: { configPatches: [{ match: { proxy: { proxyVersion: '(' } } }] } }
  ]), version);
  const by = Object.fromEntries(rows.items.map(r => [r.name, r]));
  assert.strictEqual(by['stats-filter-1.16'].applies, false);
  assert.strictEqual(by['proxy-protocol'].applies, true);
  assert.strictEqual(by['proxy-protocol'].proxyProtocol, true);
  assert.strictEqual(by.evil.applies, false, 'an invalid regex never matches and never throws');
  assert.strictEqual(rows.dead, 2);
  assert.strictEqual(edge.envoyFilterRows(ok([by['stats-filter-1.16']].map(() => ({ metadata: { name: 'a', namespace: 'b' }, spec: { configPatches: [{ match: { proxy: { proxyVersion: '^1' } } }] } }))), null).items[0].applies, null, 'unknown Istio version is unknown');
});

test('access control counts peers and never lists one', () => {
  const records = [
    rec({ downstreamRemote: '203.0.113.1:1' }),
    rec({ downstreamRemote: '203.0.113.2:1', code: 403, responseCodeDetails: 'rbac_access_denied_matched_policy[none]' }),
    rec({ downstreamRemote: '203.0.113.3:1', method: null, authority: null, code: 0, responseCodeDetails: 'filter_chain_not_found' })
  ];
  const { classOf } = edge.edgeClasses(records, CTX);
  const out = edge.accessControl({
    records,
    classOf,
    resolvePeer: r => ({ ip: r.downstreamRemote.split(':')[0], kind: 'external' }),
    gatewayLabels: { istio: 'ingressgateway' },
    gatewayNamespace: 'istio-system',
    authorizationPolicies: ok([{ metadata: { name: 'apple-acl', namespace: 'istio-system' }, spec: { action: 'ALLOW', selector: { matchLabels: { istio: 'ingressgateway' } }, rules: [{ from: [{ source: { remoteIpBlocks: ['198.51.100.0/24', '192.0.2.0/24'] } }] }] } }]),
    peerAuthentications: ok([{ metadata: { name: 'x', namespace: 'kyma-system' }, spec: { mtls: { mode: 'PERMISSIVE' } } }]),
    envoyFilters: { unavailable: false, items: [{ proxyProtocol: true, workloadSelector: { istio: 'ingressgateway' } }] }
  });
  assert.deepEqual(out.peers, { distinct: 3, internal: 0, external: 3, externalAllowed: 1, externalBlockedOnly: 1, externalTlsOnly: 1 });
  assert.strictEqual(out.policies[0].denied, 1, 'the one ALLOW policy owns the [none] denials');
  assert.strictEqual(out.policies[0].remoteIpBlocks, 2);
  assert.strictEqual(out.proxyProtocol, true);
  const json = JSON.stringify(out);
  for (const ip of ['203.0.113.1', '198.51.100.0']) assert.ok(!json.includes(ip), `${ip} leaked`);
});

test('error groups get a bucket: refused, unrouted and failed are told apart', () => {
  assert.strictEqual(edge.errorBucket({ code: 403, responseCodeDetails: ['rbac_access_denied_matched_policy[none]'] }), 'policy-blocked');
  assert.strictEqual(edge.errorBucket({ code: 0, responseCodeDetails: ['filter_chain_not_found'] }), 'tls-rejected');
  assert.strictEqual(edge.errorBucket({ code: 404, responseCodeDetails: ['route_not_found'], responseFlags: ['NR'] }), 'not-routed');
  assert.strictEqual(edge.errorBucket({ code: 503, responseCodeDetails: ['upstream_reset'], responseFlags: ['UF'] }), 'app-failed');
});

// ------------------------------------------------------------------ network path

test('shoot-info gives the provider, CIDRs and NAT addresses; unread is unavailable', () => {
  const info = edge.shootInfoOf(ok([{ data: { provider: 'aws', region: 'us-east-1', nodeNetwork: '10.250.0.0/16', podNetwork: '100.96.0.0/11', serviceNetwork: '100.64.0.0/13', egressCIDRs: '34.200.180.67/32,54.209.206.118/32', domain: 'c.example.com' } }]));
  assert.deepEqual(info.natIps, ['34.200.180.67', '54.209.206.118']);
  assert.strictEqual(info.podCidr, '100.96.0.0/11');
  assert.strictEqual(edge.shootInfoOf(gone('FORBIDDEN')).unavailable, true);
  assert.strictEqual(edge.shootInfoOf(ok([])).reason, 'NOT_FOUND');
});

test('the mesh outbound policy is read, defaulting to ALLOW_ANY only when the mesh was read', () => {
  const mesh = text => ok([{ data: { mesh: text } }]);
  assert.strictEqual(edge.outboundPolicyOf(mesh('outboundTrafficPolicy:\n  mode: REGISTRY_ONLY\n')), 'REGISTRY_ONLY');
  assert.strictEqual(edge.outboundPolicyOf(mesh('accessLogFile: /dev/stdout\n')), 'ALLOW_ANY');
  assert.strictEqual(edge.outboundPolicyOf(gone('FORBIDDEN')), null);
});

// ------------------------------------------------------------------ the wire, end to end

const CLIENT_IPS = ['17.65.195.108', '203.0.113.77', '198.51.100.23'];

function line(over) {
  return JSON.stringify({
    authority: 'shop.c.example.com', downstream_local_address: '10.250.0.5:8443', downstream_remote_address: '17.65.195.108:5000',
    duration: 12, method: 'GET', path: '/', protocol: 'HTTP/1.1', request_id: 'r', response_code: 503,
    response_code_details: 'via_upstream', response_flags: 'UF', start_time: '2026-09-26T10:00:00.000Z',
    upstream_cluster: 'outbound|8080||srv.shop.svc.cluster.local', upstream_host: '100.96.0.180:8080', ...over
  });
}

function fakeCluster() {
  const gw = { metadata: { name: 'istio-ingressgateway-1', namespace: 'istio-system', labels: { app: 'istio-ingressgateway', istio: 'ingressgateway' } }, spec: { containers: [{ name: 'istio-proxy' }], nodeName: 'n1' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  const app = { metadata: { name: 'shop-1', namespace: 'shop', labels: {} }, spec: { containers: [{ name: 'app' }, { name: 'istio-proxy' }], nodeName: 'n1' }, status: { phase: 'Running' } };
  const map = {
    '/api/v1/pods': [gw, app],
    '/api/v1/nodes': [{ metadata: { name: 'n1', labels: { 'topology.kubernetes.io/zone': 'us-east-1a' } }, status: { addresses: [] } }],
    '/api/v1/services': [{ metadata: { name: 'istio-ingressgateway', namespace: 'istio-system', annotations: { 'service.beta.kubernetes.io/aws-load-balancer-proxy-protocol': '*' } }, spec: { type: 'LoadBalancer', selector: { istio: 'ingressgateway' }, externalTrafficPolicy: 'Local', ports: [{ name: 'https', port: 443, targetPort: 8443, nodePort: 31430, protocol: 'TCP' }] }, status: { loadBalancer: { ingress: [{ ip: '192.0.2.10' }] } } }],
    '/gateways': [{ metadata: { name: 'kyma-gateway', namespace: 'kyma-system' }, spec: { selector: { istio: 'ingressgateway' }, servers: [{ port: { number: 443, protocol: 'HTTPS', name: 'https' }, tls: { mode: 'SIMPLE', credentialName: 'kyma-tls' }, hosts: ['*.c.example.com'] }] } }],
    '/apirules': [{ metadata: { name: 'shop', namespace: 'shop' }, spec: { hosts: ['shop.c.example.com'] } }],
    'shoot-info': [{ data: { provider: 'aws', region: 'us-east-1', egressCIDRs: '34.200.180.67/32', podNetwork: '100.96.0.0/11' } }],
    '/networkpolicies': [{ metadata: { name: 'egress', namespace: 'shop', annotations: { 'xsuaa-service-instances-us10': '18.213.242.208/32' } } }],
    '/certificates': [cert('kyma-tls', { expires: '2099-01-01T00:00:00Z', renewal: '2098-12-01T00:00:00Z' })],
    '/authorizationpolicies': [{ metadata: { name: 'apple-acl', namespace: 'istio-system' }, spec: { action: 'ALLOW', selector: { matchLabels: { istio: 'ingressgateway' } }, rules: [{ from: [{ source: { remoteIpBlocks: ['17.0.0.0/8'] } }] }] } }]
  };
  return async ({ path }) => {
    for (const key of Object.keys(map)) if (path.includes(key)) return map[key];
    return [];
  };
}

async function readWire() {
  const textFn = async ({ path }) => path.includes('istio-ingressgateway-1')
    ? [
        line({}),
        line({ downstream_remote_address: '203.0.113.77:1', response_code: 403, response_code_details: 'rbac_access_denied_matched_policy[none]', response_flags: '-', upstream_host: null }),
        line({ downstream_remote_address: '198.51.100.23:1', authority: '192.0.2.10', response_code: 404, response_flags: 'NR', response_code_details: 'route_not_found', upstream_host: null })
      ].join('\n')
    : line({ downstream_remote_address: '100.96.0.9:1', upstream_host: '18.213.242.208:443', response_code: 200, response_flags: '-' });
  return collect({ cluster: { id: 'c1' }, token: 't', listFn: fakeCluster(), textFn });
}

test('no external client address reaches the /traffic-errors wire', async () => {
  const out = await readWire();
  const json = JSON.stringify(out);
  for (const ip of CLIENT_IPS) assert.ok(!json.includes(ip), `client address ${ip} is on the wire`);
  // What the screen needs is still there, as counts.
  assert.strictEqual(out.ingress.access.peers.external, 3);
  assert.strictEqual(out.ingress.clients.find(c => c.key === 'external').distinct, 3);
  assert.ok(out.errors.every(g => g.sources.every(s => s.ip === null || !CLIENT_IPS.includes(s.ip))));
  assert.ok(out.errors.every(g => typeof g.bucket === 'string'));
});

test('the wire guard detects a leak (canary)', async () => {
  const out = await readWire();
  // Put one address back the way aggregateClients used to publish it.
  out.ingress.clients.push({ key: CLIENT_IPS[0], ip: CLIENT_IPS[0] });
  const json = JSON.stringify(out);
  assert.ok(CLIENT_IPS.some(ip => json.includes(ip)), 'the guard above would have caught this');
});

test('the wire carries the classes, the path and named destinations', async () => {
  const out = await readWire();
  const ing = out.ingress;
  assert.strictEqual(ing.classes.rows.find(r => r.key === 'app').requests, 1);
  assert.strictEqual(ing.classes.rows.find(r => r.key === 'policy-blocked').requests, 1);
  assert.strictEqual(ing.classes.rows.find(r => r.key === 'direct-ip').requests, 1);
  assert.strictEqual(ing.app.server, 1);
  const lb = ing.path.ingress.loadBalancers[0];
  assert.strictEqual(lb.proxyProtocol, true);
  assert.strictEqual(lb.externalTrafficPolicy, 'Local');
  assert.deepEqual(ing.path.egress.natIps, ['34.200.180.67']);
  assert.strictEqual(ing.path.egress.egressGateway, false);
  assert.strictEqual(ing.path.egress.observed[0].display, 'SAP Authorization and Trust (XSUAA) · us10');
  assert.ok(ing.path.egress.destinations.some(d => d.label === 'xsuaa-service-instances-us10'));
  const bare = ing.hosts.find(h => h.host === '192.0.2.10');
  assert.strictEqual(bare.edgeClass, 'direct-ip');
  assert.strictEqual(bare.destination.source, 'ingress-lb');
  assert.strictEqual(ing.hosts.find(h => h.host === 'shop.c.example.com').chain.servers[0].certificate.name, 'kyma-tls');
});

test('traffic-errors carries ingress.refused with counts, never addresses', async () => {
  const out = await readWire();
  assert.ok(Array.isArray(out.ingress.refused.rows));
  assert.ok(out.ingress.refused.rows.length >= 1, 'the gateway lines above are refusals');
  const denied = out.ingress.refused.rows.find(r => r.code === 403);
  assert.ok(denied, 'the ALLOW-miss line produced a row');
  assert.equal(denied.decidedBy[0].name, 'apple-acl');
  for (const r of out.ingress.refused.rows) {
    assert.equal('peers' in r, false);
    assert.equal(typeof r.clients, 'number');
  }
});

test('refused edge reads land in summary.unavailable', async () => {
  const base = fakeCluster();
  const listFn = async args => {
    if (/certificates|dnsentries|authorizationpolicies|envoyfilters|shoot-info/.test(args.path)) throw Object.assign(new Error('forbidden'), { status: 403 });
    return base(args);
  };
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn: async () => line({}) });
  for (const label of ['certificates', 'dnsentries', 'authorizationpolicies', 'envoyfilters', 'shoot-info']) {
    assert.ok(out.summary.unavailable.includes(label), `${label} missing from unavailable`);
  }
  assert.strictEqual(out.ingress.certificates.unavailable, true);
  assert.strictEqual(out.ingress.path.egress.natIps, null, 'unread NAT addresses are unknown, not none');
  assert.strictEqual(out.ingress.path.ingress.policies, null);
});

test('a gateway failure group whose Host nothing admits is direct-ip, never App failed or Not routed', async () => {
  const out = await readWire();
  const scanner = out.errors.find(g => g.authority === '192.0.2.10');
  assert.strictEqual(scanner.edgeClass, 'direct-ip');
  assert.strictEqual(scanner.bucket, 'direct-ip');
  assert.equal(edge.errorBucket({ code: 400, responseCodeDetails: ['missing_host_header'], responseFlags: ['DPE'] }, 'direct-ip'), 'direct-ip');
  assert.equal(edge.errorBucket({ code: 503, responseCodeDetails: [], responseFlags: ['UF'] }, 'app'), 'app-failed');
});

test('with Gateways and routes both unread the app headline is unknown, not 0', async () => {
  const base = fakeCluster();
  const listFn = async args => {
    if (/gateways|virtualservices|apirules/.test(args.path)) throw Object.assign(new Error('forbidden'), { status: 403 });
    return base(args);
  };
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn: async () => line({}) });
  assert.strictEqual(out.ingress.app, null);
  const partial = await collect({ cluster: { id: 'c1' }, token: 't', listFn: async args => (/virtualservices|apirules/.test(args.path) ? Promise.reject(Object.assign(new Error('x'), { status: 403 })) : base(args)), textFn: async () => line({}) });
  assert.notStrictEqual(partial.ingress.app, null, 'Gateways alone still admit hosts');
});

test('a host a Gateway admits but no route names is app traffic, not direct-ip (real index shape)', () => {
  const r = rec({ authority: 'kyma-demo-1-approuter.c.example.com' });
  assert.equal(edge.classifyEdgeRecord(r, { gatewayHosts: CTX.gatewayHosts, routes: [] }), 'app');
  assert.equal(edge.classifyEdgeRecord({ ...r, responseCodeDetails: 'rbac_access_denied_matched_policy[none]' }, { gatewayHosts: CTX.gatewayHosts, routes: [] }), 'policy-blocked');
  // Strings still work, for callers that pass patterns.
  assert.equal(edge.classifyEdgeRecord(r, { gatewayHosts: ['*.c.example.com'], routes: [] }), 'app');
});

test('a NAT range is a CIDR, never shown as one address', () => {
  const info = edge.shootInfoOf(ok([{ metadata: { namespace: 'kube-system', name: 'shoot-info' }, data: { egressCIDRs: '34.200.180.67/32,1.2.3.0/28,5.6.7.8' } }]));
  assert.deepEqual(info.natIps, ['34.200.180.67', '5.6.7.8']);
  assert.deepEqual(info.natCidrs, ['1.2.3.0/28']);
});

test('a failed Certificate or Gateway read leaves the chain unknown, not a gap', () => {
  const gatewayRows = [{ namespace: 'kyma-system', name: 'kyma-gateway', key: 'k', port: 443, tlsMode: 'SIMPLE', credentialName: 'kyma-gateway-certs', hosts: ['*.c.example.com'] }];
  const dnsEntries = { items: [], unavailable: false };
  const noCerts = edge.hostChain('shop.c.example.com', { gatewayRows, certificates: { items: [], unavailable: true }, dnsEntries });
  assert.equal(noCerts.servers[0].certificate, undefined);
  const missing = edge.hostChain('shop.c.example.com', { gatewayRows, certificates: { items: [], unavailable: false }, dnsEntries });
  assert.equal(missing.servers[0].certificate, null);
  const noGw = edge.hostChain('shop.c.example.com', { gatewayRows: [], certificates: { items: [], unavailable: false }, dnsEntries, gatewaysUnavailable: true });
  assert.equal(noGw.servers, undefined);
});

test('network path: unread Gateways or routes are null, never 0; naming sources travel along', () => {
  const base = { shootInfo: ok([]), services: ok([]), pods: ok([]), nodes: ok([]), dnsEntries: { items: [], unavailable: false }, envoyFilters: { istioVersion: null }, access: { proxyProtocol: null, policies: [], unavailable: {} }, gatewayRows: [], routes: [], meshConfig: null, serviceEntries: ok([]) };
  const p = edge.networkPath({ ...base, gatewaysUnavailable: true, routesUnavailable: true, destinationSources: { networkPolicies: 'unavailable' } });
  assert.equal(p.ingress.servers, null);
  assert.equal(p.ingress.tlsServers, null);
  assert.equal(p.ingress.routes, null);
  assert.equal(p.egress.destinationSources.networkPolicies, 'unavailable');
  const q = edge.networkPath(base);
  assert.equal(q.ingress.servers, 0);
  assert.equal(q.ingress.routes, 0);
});

test('a code-0 TCP connection with no flag and no detail is no failure bucket, never app-failed', () => {
  assert.equal(edge.errorBucket({ code: 0, responseFlags: [], responseCodeDetails: [] }), null);
  assert.equal(edge.errorBucket({ code: 0, responseFlags: ['UF'], responseCodeDetails: [] }), 'app-failed');
  assert.equal(edge.errorBucket({ code: 503, responseFlags: [], responseCodeDetails: ['via_upstream'] }), 'app-failed');
});
