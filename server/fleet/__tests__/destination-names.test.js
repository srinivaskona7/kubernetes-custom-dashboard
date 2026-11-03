/**
 * srv/fleet/destination-names.js: naming external addresses from the cluster's own objects.
 * Annotation values are copied verbatim from platformsbx (2026-09-26), so a format the live
 * cluster uses and this parser misses fails here, not on the map.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _destination_names from '../destination-names.js';
import _destination_namesModule from '../destination-names.js';
const {
  buildNameIndex,
  nameOf,
  nameServiceMap,
  nameNodeRefs,
  nameHopEndpoints,
  parseAnnotation,
  displayOf,
  resolveLbHostnames,
  parseCidr,
  namedDestinations,
  NAME_READS,
  _lbCache
} = _destination_names;

const ok = items => ({ items, unavailable: false });
const np = (namespace, name, annotations) => ({ metadata: { namespace, name, annotations } });

const BTP_ANNOTATIONS = {
  'destination-us10': '54.243.28.3, 35.173.121.86, 52.71.181.35',
  'hana-us10': 'hana-ips:3.83.199.182,3.89.174.145',
  'helm.sh/resource-policy': 'keep',
  'meta.helm.sh/release-name': 'applecare',
  'xsuaa-service-instances-us10': '3.214.110.153, 34.205.56.51, 18.213.242.208',
  'xsuaa-service-instances-us11': '34.211.82.149, 35.95.238.236, 100.20.19.69'
};
const GATEKEEPER = {
  'policy.kyma/block-1': 'Internal infra — Node: 10.250.0.0/16, Pod: 100.96.0.0/11, Service: 100.64.0.0/13',
  'policy.kyma/block-2': 'Internal API endpoint — kubernetes Service backend IP: 240.243.250.40',
  'policy.kyma/block-3': 'External API — AWS NLB IPs of api.c-9d0a141.kyma.ondemand.com: 44.193.105.26, 54.235.211.148, 23.20.180.97'
};
const APISERVERS = {
  'apiserver-apppfkymaut': '44.193.105.26, 54.235.211.148, 23.20.180.97',
  'apiserver-platformsbx': '44.193.105.26, 23.20.180.97, 54.235.211.148, 100.64.0.1',
  'cluster-domain': 'c-9d0a141.kyma.ondemand.com'
};
const NPS = ok([
  np('applecare', 'egress-allow-btp-traffic', BTP_ANNOTATIONS),
  np('test-1', 'egress-allow-btp-traffic', BTP_ANNOTATIONS),
  np('gatekeeper-system', 'egress-allow-gatekeeper', GATEKEEPER),
  np('btp-platform-foundation', 'custom-egress-allow-apiservers', APISERVERS),
  np('x', 'with-applied-spec', {
    'kubectl.kubernetes.io/last-applied-configuration': '{"spec":{"egress":[{"to":[{"ipBlock":{"cidr":"9.9.9.9/32"}}]}]}}'
  })
]);

const LB_SERVICE = ok([
  {
    metadata: { namespace: 'istio-system', name: 'istio-ingressgateway' },
    spec: { type: 'LoadBalancer', selector: { istio: 'ingressgateway' } },
    status: { loadBalancer: { ingress: [{ hostname: 'a959ef867d94d47519ebbf8264d92d6b-211749035.us-east-1.elb.amazonaws.com' }] } }
  }
]);

const pipeline = (kind, name) => ({
  kind,
  metadata: { name },
  spec: { output: { otlp: { protocol: 'grpc', endpoint: { valueFrom: { secretKeyRef: { key: 'ingest-otlp-endpoint', name: 'cls-kyma-binding', namespace: 'cls' } } } } } }
});
const PIPELINES = [
  ok([pipeline('LogPipeline', 'cls-kyma-access-logs'), pipeline('LogPipeline', 'cls-kyma-application-logs')]),
  ok([pipeline('TracePipeline', 'cls-kyma-trace-pipeline')]),
  ok([pipeline('MetricPipeline', 'cls-kyma-metric-pipeline')])
];
const BINDINGS = ok([{ metadata: { namespace: 'cls', name: 'cls-kyma-binding' }, spec: { secretName: 'cls-kyma-binding', serviceInstanceName: 'cls-instance-reference' } }]);
const INSTANCES = ok([{ metadata: { namespace: 'cls', name: 'cls-instance-reference' }, spec: { serviceOfferingName: 'cloud-logging', servicePlanName: 'reference-instance' } }]);

const LB_DNS = [
  { hostname: 'a959ef867d94d47519ebbf8264d92d6b-211749035.us-east-1.elb.amazonaws.com', ips: ['32.197.162.126', '98.83.101.14', '98.87.43.3'], resolvedAt: '2026-09-26T06:00:00.000Z', error: null }
];

const INDEX = buildNameIndex({
  networkPolicies: NPS,
  pipelines: PIPELINES,
  serviceBindings: BINDINGS,
  serviceInstances: INSTANCES,
  services: LB_SERVICE,
  lbDns: LB_DNS
});

test('the three live annotation formats all parse: comma+space, name: prefix, prose', () => {
  assert.deepEqual(parseAnnotation('xsuaa-service-instances-us10', BTP_ANNOTATIONS['xsuaa-service-instances-us10']).ips, [
    '3.214.110.153',
    '34.205.56.51',
    '18.213.242.208'
  ]);
  const hana = parseAnnotation('hana-us10', BTP_ANNOTATIONS['hana-us10']);
  assert.deepEqual(hana.ips, ['3.83.199.182', '3.89.174.145']);
  assert.equal(hana.label, 'hana-us10', 'a bare token before the IPs qualifies, the key stays the label');
  assert.equal(hana.qualifier, 'hana-ips');
  const prose = parseAnnotation('policy.kyma/block-3', GATEKEEPER['policy.kyma/block-3']);
  assert.equal(prose.form, 'prose');
  assert.equal(prose.label, 'External API — AWS NLB IPs of api.c-9d0a141.kyma.ondemand.com');
  assert.deepEqual(prose.ips, ['44.193.105.26', '54.235.211.148', '23.20.180.97']);
});

test('ranges name no host, and the applied-spec annotation is not a naming source', () => {
  assert.equal(parseAnnotation('policy.kyma/block-1', GATEKEEPER['policy.kyma/block-1']), null);
  assert.equal(INDEX.byIp.has('9.9.9.9'), false);
  assert.equal(parseAnnotation('cluster-domain', 'c-9d0a141.kyma.ondemand.com'), null);
  assert.equal(parseAnnotation('x', '999.1.1.1'), null, 'an out-of-range octet is not an address');
});

test('the live map external nodes resolve: XSUAA by annotation, carrying every object that says so', () => {
  const n = nameOf(INDEX, '18.213.242.208');
  assert.equal(n.source, 'networkpolicy');
  assert.equal(n.key, 'xsuaa-service-instances-us10');
  assert.equal(n.display, 'SAP Authorization and Trust (XSUAA) · us10');
  assert.deepEqual(n.objects, ['NetworkPolicy applecare/egress-allow-btp-traffic', 'NetworkPolicy test-1/egress-allow-btp-traffic']);
  assert.equal(nameOf(INDEX, '3.83.199.182').display, 'SAP HANA Cloud · us10');
});

test('one address with several names keeps them all; a keyed annotation outranks prose', () => {
  const n = nameOf(INDEX, '44.193.105.26');
  assert.equal(n.source, 'networkpolicy');
  assert.equal(n.others.length, 1, 'the two apiserver keys share the display; the gatekeeper prose is the other name');
  assert.ok(n.others.includes('External API — AWS NLB IPs of api.c-9d0a141.kyma.ondemand.com'));
});

test('two policies of equal standing naming one address are both named, never an alphabetical guess', () => {
  const n = nameOf(INDEX, '44.193.105.26');
  assert.equal(n.ambiguous, true);
  assert.match(n.display, / or /);
  assert.ok(n.display.includes('Kubernetes API server (apppfkymaut)') && n.display.includes('Kubernetes API server (platformsbx)'), n.display);
  assert.ok(!n.display.includes('External API'), 'prose ranks below keyed and is not a tie');
  assert.equal(nameOf(INDEX, '18.213.242.208').ambiguous, undefined, 'one name is not ambiguous');
});

test('the ingress LB is named from the Service status hostname, by DNS, with the time', () => {
  const n = nameOf(INDEX, '98.87.43.3');
  assert.equal(n.source, 'ingress-lb');
  assert.equal(n.display, "This cluster's ingress load balancer");
  assert.match(n.qualifier, /elb\.amazonaws\.com by DNS at 2026-09-26T06:00:00\.000Z/);
  assert.deepEqual(n.objects, ['Service istio-system/istio-ingressgateway']);
});

test('telemetry export is named by pipeline → Secret → ServiceBinding → ServiceInstance offering', () => {
  const caller = { kind: 'workload', namespace: 'kyma-system', name: 'telemetry-otlp-gateway' };
  const n = nameOf(INDEX, '3.225.140.11', { caller });
  assert.equal(n.source, 'telemetry');
  assert.equal(n.label, 'SAP Cloud Logging');
  assert.equal(n.objects.length, 4);
  assert.equal(nameOf(INDEX, '3.225.140.11'), null, 'without the exporter as caller the IP stays unnamed');
  assert.equal(nameOf(INDEX, '3.225.140.11', { caller: { namespace: 'applecare', name: 'telemetry-otlp-gateway' } }), null);
});

test('with the binding unreadable the export is named by its Secret reference, never guessed', () => {
  const idx = buildNameIndex({ pipelines: PIPELINES, serviceBindings: { items: [], unavailable: true }, serviceInstances: INSTANCES });
  assert.equal(idx.telemetry.label, 'cls/cls-kyma-binding');
  const none = buildNameIndex({ pipelines: PIPELINES.map(() => ({ items: [], unavailable: true })) });
  assert.equal(none.telemetry, null);
});

test('a load balancer that publishes only an IP carries it on lb.ips', () => {
  const idx = buildNameIndex({ services: { items: [{ metadata: { name: 'istio-ingressgateway', namespace: 'istio-system' }, spec: { type: 'LoadBalancer' }, status: { loadBalancer: { ingress: [{ ip: '20.1.2.3' }] } } }] } });
  assert.deepEqual(idx.lb.ips, ['20.1.2.3']);
  assert.deepEqual(idx.lb.hostnames, []);
});

test('one unread pipeline kind names no export: another kind could export elsewhere', () => {
  const partial = buildNameIndex({ pipelines: PIPELINES.map((p, i) => (i === 0 ? p : { items: [], unavailable: true })), serviceBindings: { items: [] }, serviceInstances: INSTANCES });
  assert.equal(partial.telemetry, null);
  assert.equal(partial.sources.pipelines, 'partial');
  const absent = buildNameIndex({ pipelines: PIPELINES.map((p, i) => (i === 0 ? p : { items: [] })), serviceBindings: { items: [] }, serviceInstances: INSTANCES });
  assert.notEqual(absent.telemetry, null, 'a 404 (no pipelines of that kind) is a true zero');
  assert.equal(absent.sources.pipelines, 'ok');
});

test('a same-rank conflict is ambiguous whatever the object counts', () => {
  const np = (ns, name, key) => ({ metadata: { namespace: ns, name, annotations: { [key]: '203.0.113.50' } } });
  const idx = buildNameIndex({ networkPolicies: { items: [np('a', 'p1', 'apiserver-apppfkymaut'), np('b', 'p2', 'apiserver-platformsbx'), np('c', 'p3', 'apiserver-platformsbx')] } });
  const n = nameOf(idx, '203.0.113.50');
  assert.equal(n.ambiguous, true);
  assert.ok(n.display.includes('apppfkymaut') && n.display.includes('platformsbx'), n.display);
  assert.deepEqual(n.others, [], 'tied names are in display, not repeated as others');
  assert.equal(n.objects.length, 3, 'every claimant cites its policy');
});

test('an address no source names stays bare, and unreadable policies name nothing', () => {
  assert.equal(nameOf(INDEX, '1.2.3.4'), null);
  const idx = buildNameIndex({ networkPolicies: { items: [], unavailable: true } });
  assert.equal(idx.byIp.size, 0);
  assert.equal(idx.sources.networkPolicies, 'unavailable');
});

test('nameServiceMap names the five live external nodes; nameNodeRefs names Outbound rows', () => {
  const map = {
    nodes: [
      { id: 'wl:kyma-system/DaemonSet/telemetry-otlp-gateway', kind: 'workload', name: 'telemetry-otlp-gateway', namespace: 'kyma-system' },
      { id: 'wl:applecare/Deployment/applecare-responder-srv', kind: 'workload', name: 'applecare-responder-srv', namespace: 'applecare' },
      { id: 'ext:3.225.140.11:443', kind: 'external', name: '3.225.140.11:443', namespace: null },
      { id: 'ext:3.214.110.153:443', kind: 'external', name: '3.214.110.153:443', namespace: null },
      { id: 'ext:1.2.3.4:443', kind: 'external', name: '1.2.3.4:443', namespace: null }
    ],
    edges: [
      { from: 'wl:kyma-system/DaemonSet/telemetry-otlp-gateway', to: 'ext:3.225.140.11:443' },
      { from: 'wl:applecare/Deployment/applecare-responder-srv', to: 'ext:3.214.110.153:443' },
      { from: 'wl:applecare/Deployment/applecare-responder-srv', to: 'ext:1.2.3.4:443' }
    ]
  };
  nameServiceMap(map, INDEX);
  assert.equal(map.nodes[2].destination.label, 'SAP Cloud Logging');
  assert.equal(map.nodes[3].destination.key, 'xsuaa-service-instances-us10');
  assert.equal(map.nodes[4].destination, undefined);
  const rows = [{ from: map.nodes[1], to: { id: 'ext:3.214.110.153:443', kind: 'external', name: '3.214.110.153:443', namespace: null } }];
  nameNodeRefs(rows, INDEX);
  assert.equal(rows[0].to.destination.source, 'networkpolicy');
});

test('display names: family plus region, apiserver keeps its cluster, unknown keys stay verbatim', () => {
  assert.equal(displayOf('xsuaa-service-instances-us11'), 'SAP Authorization and Trust (XSUAA) · us11');
  assert.equal(displayOf('apiserver-platformsbx'), 'Kubernetes API server (platformsbx)');
  assert.equal(displayOf('cloud-logging'), 'SAP Cloud Logging');
  assert.equal(displayOf('my-partner-api'), 'my-partner-api');
});

test('LB DNS: cached per hostname, failures cached, invalid names never queried', async () => {
  _lbCache.clear();
  let calls = 0;
  let clock = 1_000;
  const now = () => clock;
  const resolve4 = async h => { calls += 1; if (h.startsWith('bad')) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); return ['98.83.101.14']; };
  const [a] = await resolveLbHostnames(['lb.us-east-1.elb.amazonaws.com', 'not a host', ''], { resolve4, now });
  assert.deepEqual(a.ips, ['98.83.101.14']);
  assert.equal(calls, 1);
  await resolveLbHostnames(['lb.us-east-1.elb.amazonaws.com'], { resolve4, now });
  assert.equal(calls, 1, 'second read within the TTL is a cache hit');
  clock += 6 * 60_000;
  await resolveLbHostnames(['lb.us-east-1.elb.amazonaws.com'], { resolve4, now });
  assert.equal(calls, 2, 'after the TTL it resolves again');
  const [b] = await resolveLbHostnames(['bad.us-east-1.elb.amazonaws.com'], { resolve4, now });
  assert.equal(b.error, 'ENOTFOUND');
  assert.deepEqual(b.ips, []);
  await resolveLbHostnames(['bad.us-east-1.elb.amazonaws.com'], { resolve4, now });
  assert.equal(calls, 3, 'a failure is cached too');
  const [slow] = await resolveLbHostnames(['slow.us-east-1.elb.amazonaws.com'], { resolve4: () => new Promise(() => {}), now, timeoutMs: 20 });
  assert.equal(slow.error, 'DNS timeout');
  _lbCache.clear();
});

test('LB DNS resolves only a provider load-balancer name, never an internal one', async () => {
  const d = _destination_namesModule;
  d._lbCache.clear();
  const asked = [];
  const resolve4 = async h => { asked.push(h); return ['203.0.113.7']; };
  const out = await d.resolveLbHostnames(['a1-2.us-east-1.elb.amazonaws.com', 'kubernetes.default.svc.cluster.local', 'metadata.google.internal', 'x.corp.example.com'], { resolve4 });
  assert.deepEqual(asked, ['a1-2.us-east-1.elb.amazonaws.com']);
  assert.deepEqual(out.filter(o => o.error === 'NOT_A_PROVIDER_LB').map(o => o.hostname), ['kubernetes.default.svc.cluster.local', 'metadata.google.internal', 'x.corp.example.com']);
  assert.ok(out.every(o => o.error !== 'NOT_A_PROVIDER_LB' || o.ips.length === 0));
});

test('failure groups and Traces endpoints get the same names as the map', () => {
  const d = _destination_namesModule;
  const index = { byIp: new Map([['18.213.242.208', [{ display: 'XSUAA · us10', label: 'XSUAA', source: 'networkpolicy', key: 'k', qualifier: null, objects: ['NetworkPolicy a/b'] }]], ['32.197.162.126', [{ display: "This cluster's ingress load balancer", label: 'LB', source: 'ingress-lb', key: null, qualifier: null, objects: ['Service istio-system/istio-ingressgateway'] }]]]), telemetry: { display: 'SAP Cloud Logging (telemetry export)', label: 'SAP Cloud Logging', source: 'telemetry', objects: ['LogPipeline x'] }, lb: null, sources: {} };
  const groups = d.nameFailureGroups([
    { destination: { kind: 'external', ip: '18.213.242.208', name: '18.213.242.208' }, proxies: [{ namespace: 'app', pod: 'srv-1' }] },
    { destination: { kind: 'external', ip: '3.225.140.11', name: '3.225.140.11' }, proxies: [{ namespace: 'kyma-system', pod: 'telemetry-otlp-gateway-b2wtg' }] },
    { destination: { kind: 'external', ip: '9.9.9.9', name: '9.9.9.9' }, proxies: [{ namespace: 'app', pod: 'srv-1' }] }
  ], index);
  assert.equal(groups[0].destination.destination.label, 'XSUAA');
  assert.equal(groups[1].destination.destination && groups[1].destination.destination.source, 'telemetry');
  assert.equal(groups[2].destination.destination, undefined);
  const eps = d.nameEndpointHosts([{ host: '32.197.162.126' }, { host: 'shop.example.com' }], index);
  assert.equal(eps[0].destination.source, 'ingress-lb');
  assert.equal(eps[1].destination, undefined);
});

const npSpec = (namespace, name, egress, annotations = {}) => ({ metadata: { namespace, name, annotations }, spec: { egress } });
const to = (...blocks) => ({ to: blocks.map(b => ({ ipBlock: b })) });

test('ipBlock: a /32 names that address exactly, with the policy and cidr', () => {
  const idx = buildNameIndex({ networkPolicies: ok([npSpec('shop', 'allow-api', [to({ cidr: '52.1.2.3/32' })])]) });
  const n = nameOf(idx, '52.1.2.3');
  assert.equal(n.display, 'Egress allowed by shop/allow-api');
  assert.equal(n.source, 'networkpolicy-ipblock');
  assert.deepEqual([n.namespace, n.policyName, n.cidr], ['shop', 'allow-api', '52.1.2.3/32']);
  assert.equal(nameOf(idx, '52.1.2.4'), null);
});

test('ipBlock: the annotation name wins for the same address, the ipBlock stays as provenance', () => {
  const idx = buildNameIndex({ networkPolicies: ok([npSpec('shop', 'allow-xsuaa', [to({ cidr: '3.214.110.153/32' })], { 'xsuaa-service-instances-us10': '3.214.110.153' })]) });
  const n = nameOf(idx, '3.214.110.153');
  assert.equal(n.source, 'networkpolicy');
  assert.equal(n.display, 'SAP Authorization and Trust (XSUAA) · us10');
  assert.deepEqual(n.others, [], 'the ipBlock entry carries the same display, so it is not another name');
  assert.equal(idx.byIp.get('3.214.110.153').find(e => e.source === 'networkpolicy-ipblock').display, n.display);
});

test('ipBlock: two policies allowing one /32 are one name with both objects, never ambiguous', () => {
  const idx = buildNameIndex({ networkPolicies: ok([npSpec('b', 'p2', [to({ cidr: '52.1.2.3/32' })]), npSpec('a', 'p1', [to({ cidr: '52.1.2.3/32' })])]) });
  const n = nameOf(idx, '52.1.2.3');
  assert.equal(n.ambiguous, undefined);
  assert.equal(n.display, 'Egress allowed by a/p1', 'sorted by namespace/name, so the choice is deterministic');
  assert.deepEqual(n.objects, ['NetworkPolicy a/p1', 'NetworkPolicy b/p2']);
});

test('ipBlock ranges: longest prefix wins, except is honoured, 0.0.0.0/0 and ::/0 name nothing', () => {
  const idx = buildNameIndex({
    networkPolicies: ok([
      npSpec('shop', 'wide', [to({ cidr: '52.0.0.0/8' })]),
      npSpec('shop', 'narrow', [to({ cidr: '52.1.0.0/16', except: ['52.1.9.0/24'] })]),
      npSpec('shop', 'any', [to({ cidr: '0.0.0.0/0' }, { cidr: '::/0' })])
    ])
  });
  assert.equal(nameOf(idx, '52.1.2.3').policyName, 'narrow');
  assert.equal(nameOf(idx, '52.1.2.3').cidr, '52.1.0.0/16');
  assert.equal(nameOf(idx, '52.1.9.9').policyName, 'wide', 'excepted from narrow, still inside wide');
  assert.equal(nameOf(idx, '8.8.8.8'), null, 'allow-all declares no destination');
  assert.equal(idx.ranges.some(r => r.cidr === '0.0.0.0/0'), false);
});

test('ipBlock ranges apply to egress lookups only; a Host lookup passes ranges:false', () => {
  const idx = buildNameIndex({ networkPolicies: ok([npSpec('shop', 'wide', [to({ cidr: '52.0.0.0/8' })])]) });
  assert.equal(nameOf(idx, '52.1.2.3', { ranges: false }), null);
});

test('ipBlock: malformed cidrs, IPv6 and a missing spec are skipped, never thrown', () => {
  const idx = buildNameIndex({
    networkPolicies: ok([
      npSpec('shop', 'bad', [to({ cidr: '999.1.1.1/32' }, { cidr: '52.1.1.1/40' }, { cidr: 'nonsense' }, { cidr: '2001:db8::/32' }), { to: [{ podSelector: {} }] }, {}]),
      { metadata: { namespace: 'shop', name: 'nospec' } }
    ])
  });
  assert.equal(idx.byIp.size, 0);
  assert.equal(idx.ranges.length, 0);
  assert.equal(parseCidr('10.0.0.0/8').size, 16777216);
  assert.equal(parseCidr('10.1.2.3/8').base, parseCidr('10.0.0.0/8').base, 'host bits are masked');
});

test('annotation names carry their policy; ipBlock ranks between annotation and prose', () => {
  const idx = buildNameIndex({
    networkPolicies: ok([
      npSpec('gk', 'prose', [], { 'policy.kyma/x': 'External API — NLB IPs of api.example: 52.9.9.9' }),
      npSpec('shop', 'blk', [to({ cidr: '52.9.9.9/32' })])
    ])
  });
  const n = nameOf(idx, '52.9.9.9');
  assert.equal(n.source, 'networkpolicy-ipblock');
  assert.equal(n.display, 'External API — NLB IPs of api.example', 'takes the prose name for the same address');
  assert.deepEqual(n.others, []);
  const ann = buildNameIndex({ networkPolicies: ok([np('shop', 'p', { 'hana-us10': '3.83.199.182' })]) });
  const a = nameOf(ann, '3.83.199.182');
  assert.deepEqual([a.namespace, a.policyName, a.cidr], ['shop', 'p', null]);
});

test('the NetworkPolicy read is a full list: spec.egress is not in PartialObjectMetadata', () => {
  assert.equal(NAME_READS.networkPolicies.metadataOnly, undefined);
});

test('namedDestinations lists an ipBlock range with its cidr', () => {
  const idx = buildNameIndex({ networkPolicies: ok([npSpec('shop', 'wide', [to({ cidr: '52.0.0.0/8' })])]) });
  const row = namedDestinations(idx).find(r => r.source === 'networkpolicy-ipblock');
  assert.deepEqual(row.ips, ['52.0.0.0/8']);
  assert.equal(row.display, 'Egress allowed by shop/wide');
});

test('ipBlock: any /0 is allow-all, whatever base address it is written with', () => {
  const idx = buildNameIndex({ networkPolicies: ok([npSpec('s', 'w', [to({ cidr: '10.0.0.0/0' })])]) });
  assert.equal(nameOf(idx, '8.8.8.8'), null);
});

test('ipBlock: in a tie, a name already in the joined display is not listed again under others', () => {
  const idx = buildNameIndex({
    networkPolicies: ok([
      npSpec('shop', 'p-b', [to({ cidr: '52.1.2.3/32' })], { 'apiserver-platformsbx': '52.1.2.3' }),
      npSpec('shop', 'p-a', [], { 'apiserver-apppfkymaut': '52.1.2.3' })
    ])
  });
  const n = nameOf(idx, '52.1.2.3');
  assert.equal(n.ambiguous, true);
  assert.deepEqual(n.others, []);
});

// --- nameHopEndpoints: Traces journey hops ----------------------------------------------------

const hopTo = (ip, observedBy = { namespace: 'applecare', pod: 'srv-1' }) => ({
  observedBy,
  to: { kind: 'external', name: `${ip}:443`, ip, port: 443 },
  from: { kind: 'Pod', name: 'srv-1', ip: '10.0.0.30' }
});

test('nameHopEndpoints: an external hop is named from the NetworkPolicy annotation', () => {
  const index = buildNameIndex({ networkPolicies: NPS });
  const t = { hops: [hopTo('3.214.110.153')] };
  nameHopEndpoints([t], index);
  assert.equal(t.hops[0].to.destination.display, 'SAP Authorization and Trust (XSUAA) · us10');
  assert.equal(t.hops[0].to.undeclared, undefined);
});

test('nameHopEndpoints: an address nobody declares keeps its IP and is marked undeclared', () => {
  const index = buildNameIndex({ networkPolicies: NPS });
  const t = { hops: [hopTo('198.51.100.7')] };
  nameHopEndpoints([t], index);
  assert.equal(t.hops[0].to.ip, '198.51.100.7');
  assert.equal(t.hops[0].to.destination, undefined);
  assert.equal(t.hops[0].to.undeclared, true);
});

test('nameHopEndpoints: two policies naming one address give "A or B"', () => {
  const index = buildNameIndex({ networkPolicies: NPS });
  const t = { hops: [hopTo('44.193.105.26')] };
  nameHopEndpoints([t], index);
  assert.match(t.hops[0].to.destination.display, / or /);
  assert.equal(t.hops[0].to.destination.ambiguous, true);
});

test('nameHopEndpoints: an in-cluster hop and a hop with no upstream are left alone', () => {
  const index = buildNameIndex({ networkPolicies: NPS });
  const inCluster = { observedBy: {}, to: { kind: 'Service', name: 'srv', ip: '10.1.0.4' } };
  const refused = { observedBy: {}, to: null };
  nameHopEndpoints([{ hops: [inCluster, refused] }], index);
  assert.equal(inCluster.to.destination, undefined);
  assert.equal(inCluster.to.undeclared, undefined);
  assert.equal(refused.to, null);
});
