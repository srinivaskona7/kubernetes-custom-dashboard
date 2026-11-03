/*
  The ingress block of the traffic collector.

  Every assertion here is about a *grouping* decision, and grouping is exactly what a live cluster
  can confirm but never specify: platformsbx happens to serve four Gateway hosts and happens to log
  115 lines with no authority, so a read against it proves the code did not crash on that shape and
  nothing more. These tests feed hand-written lines with the shapes the live read does NOT contain
  — a corporate suffix, a port on the authority, a `null` upstream time, an ingress proxy that
  failed — because those are the ones that will arrive from the next cluster onboarded.
*/

import { test } from 'vitest';
import assert from 'node:assert';

import _traffic from '../collectors/traffic.js';
const {
  collect,
  buildIndex,
  buildRouteIndex,
  matchRoutes,
  corporateSuffixes,
  hostKeyOf,
  classifyHost,
  httpFamily,
  decodeResponseFlag,
  spanWeightedRate,
  aggregateHosts,
  aggregate,
  aggregateClients,
  aggregateFlags,
  aggregateListeners,
  ingressGatewayRows,
  ingressTier,
  aggregateIngress,
  parseAccessLine,
  isIngressProxy,
  NO_HOST_KEY,
  MIN_RATE_SPAN_SECONDS,
  MAX_INGRESS_HOSTS,
  MAX_INGRESS_CLIENTS
} = _traffic;

// ---------------------------------------------------------------- helpers

const ok = items => ({ items, unavailable: false, reason: null, detail: null, truncated: false });
const gone = reason => ({ items: [], unavailable: true, reason, detail: null, truncated: false });

const EMPTY_INDEX = buildIndex({
  pods: ok([]),
  services: ok([]),
  endpointslices: ok([]),
  nodes: ok([]),
  gateways: ok([])
});

const CLUSTER = { id: 'c1', displayName: 'C One', env: 'sbx' };

function proxyPod(name, namespace, { phase = 'Running', labels = {}, restarts = 0 } = {}) {
  return {
    metadata: { name, namespace, labels },
    spec: { containers: [{ name: 'app' }, { name: 'istio-proxy' }], nodeName: 'node-a' },
    status: { phase, podIP: null, containerStatuses: [{ name: 'app', restartCount: restarts }] }
  };
}

/**
 * A parsed record, not a log line — these tests exercise the aggregators, which take records.
 * `parseAccessLine` has its own tests; going through it here would couple a grouping assertion to
 * a parsing one.
 */
function rec(over = {}) {
  return {
    startTime: '2026-09-19T10:00:00.000Z',
    method: 'GET',
    path: '/',
    authority: 'shop.example.com',
    protocol: 'HTTP/1.1',
    code: 200,
    responseFlags: null,
    responseCodeDetails: 'via_upstream',
    duration: 20,
    upstreamMs: 15,
    terminationDetails: null,
    transportFailure: null,
    requestedServerName: null,
    routeName: null,
    upstreamCluster: null,
    upstreamHost: null,
    downstreamRemote: '203.0.113.9:44000',
    downstreamLocal: '10.250.0.1:443',
    bytesSent: 100,
    bytesReceived: 50,
    proxy: { pod: 'gw-1', namespace: 'istio-system', container: 'istio-proxy' },
    ...over
  };
}

function fakeList(map) {
  return async ({ path }) => {
    for (const key of Object.keys(map)) if (path.includes(key)) return map[key];
    return [];
  };
}

function accessLine(over = {}) {
  return JSON.stringify({
    authority: 'shop.example.com',
    downstream_local_address: '10.250.163.33:443',
    downstream_remote_address: '17.65.195.108:0',
    duration: 12,
    method: 'GET',
    path: '/checkout',
    protocol: 'HTTP/1.1',
    request_id: 'req-1',
    response_code: 503,
    response_code_details: 'via_upstream',
    response_flags: 'UF',
    start_time: '2026-09-16T14:26:11.264Z',
    upstream_cluster: 'outbound|8080||srv.shop.svc.cluster.local;',
    upstream_host: '100.96.0.180:8080',
    ...over
  });
}

// ---------------------------------------------------- host keys and grouping

test('an authority is grouped without its port, so :443 and the bare host are one host', () => {
  assert.strictEqual(hostKeyOf('Shop.Example.com:443'), 'shop.example.com');
  assert.strictEqual(hostKeyOf('shop.example.com'), 'shop.example.com');
  // A bracketed IPv6 literal keeps its brackets and loses only the port.
  assert.strictEqual(hostKeyOf('[2001:db8::1]:8443'), '[2001:db8::1]');
  // Canary: a NON-numeric trailing segment is not a port. Stripping on the last colon would turn
  // an unbracketed IPv6 authority into a truncated host that groups with nothing.
  assert.strictEqual(hostKeyOf('2001:db8::1'), '2001:db8::1');
  assert.strictEqual(hostKeyOf(null), null);
  assert.strictEqual(hostKeyOf('   '), null);
});

test('corporate suffixes come from configuration, and a dotless label is rejected', () => {
  assert.deepEqual(corporateSuffixes('*.corp.example.com, Other.Example.NET'), [
    'corp.example.com',
    'other.example.net'
  ]);
  // A single label would match a whole TLD's worth of hosts. `com` is not a corporate domain.
  assert.deepEqual(corporateSuffixes('com, localhost'), []);
  assert.deepEqual(corporateSuffixes(''), []);
  assert.deepEqual(corporateSuffixes(undefined), []);
});

test('a host is bucketed by evidence: configured suffix, declared Gateway, infra, or bare address', () => {
  const index = buildIndex({
    pods: ok([]),
    services: ok([]),
    endpointslices: ok([]),
    nodes: ok([]),
    gateways: ok([
      {
        metadata: { name: 'kyma-gateway', namespace: 'kyma-system' },
        spec: { servers: [{ port: { number: 443 }, hosts: ['*.c-abc123.kyma.ondemand.com'] }] }
      }
    ])
  });
  const opts = { gatewayHosts: index.gatewayHosts, corporate: ['corp.example.com'] };

  assert.strictEqual(classifyHost('shop.corp.example.com', opts).group, 'corporate');
  assert.strictEqual(classifyHost('shop.corp.example.com', opts).matchedSuffix, 'corp.example.com');
  assert.strictEqual(classifyHost('app.c-abc123.kyma.ondemand.com', opts).group, 'declared');
  assert.strictEqual(classifyHost('healthz.c-abc123.kyma.ondemand.com', opts).group, 'infra');
  assert.strictEqual(classifyHost('10.250.0.1', opts).group, 'address');
  assert.strictEqual(classifyHost('somewhere.else.test', opts).group, 'other');
  assert.strictEqual(classifyHost(null, opts).group, 'none');

  // The Gateway that admits the host is reported even when the bucket came from a suffix — the
  // two answers are independent, and "corporate domain served by no Gateway" is a finding.
  const declared = classifyHost('app.c-abc123.kyma.ondemand.com', opts);
  assert.strictEqual(declared.declaredBy.name, 'kyma-gateway');
  assert.strictEqual(declared.declaredBy.namespace, 'kyma-system');
});

test('a configured suffix wins over the infra list, so nobody loses a real domain to a prefix', () => {
  // `cp.` is an infra prefix. If it were checked before the configured suffixes, a company whose
  // own domain starts with one of those labels would find its traffic filed under cluster noise.
  const g = classifyHost('cp.corp.example.com', { gatewayHosts: [], corporate: ['corp.example.com'] });
  assert.strictEqual(g.group, 'corporate');
});

test('3xx is its own family, because a redirect loop is not a healthy 2xx', () => {
  assert.strictEqual(httpFamily(200), 'ok');
  assert.strictEqual(httpFamily(302), 'redirect');
  assert.strictEqual(httpFamily(404), 'client');
  assert.strictEqual(httpFamily(503), 'server');
  assert.strictEqual(httpFamily(0), 'noResponse');
});

// ------------------------------------------------------- route resolution

test('a host resolves to every object declaring it, APIRule and VirtualService both', () => {
  const routes = buildRouteIndex({
    virtualservices: ok([
      {
        metadata: { name: 'shop-vs', namespace: 'shop' },
        spec: { hosts: ['shop.example.com'] }
      }
    ]),
    apirules: ok([
      { metadata: { name: 'shop-rule', namespace: 'shop' }, spec: { hosts: ['shop.example.com'] } },
      // A v1beta1 object converted in place answers on the singular field.
      { metadata: { name: 'legacy-rule', namespace: 'shop' }, spec: { host: 'legacy.example.com' } }
    ])
  });

  const hits = matchRoutes(routes, 'shop.example.com');
  assert.deepEqual(hits.map(h => `${h.kind}/${h.name}`).sort(), ['APIRule/shop-rule', 'VirtualService/shop-vs']);
  assert.match(hits[0].evidence, /spec\.hosts|publishes/);

  assert.deepEqual(matchRoutes(routes, 'legacy.example.com').map(h => h.name), ['legacy-rule']);
  assert.deepEqual(matchRoutes(routes, 'nobody.example.com'), []);
});

test('an unreadable APIRule read declares no routes rather than throwing the index away', () => {
  const routes = buildRouteIndex({
    virtualservices: ok([{ metadata: { name: 'vs', namespace: 'n' }, spec: { hosts: ['a.example.com'] } }]),
    apirules: gone('FORBIDDEN')
  });
  assert.deepEqual(routes.map(r => r.kind), ['VirtualService']);
});

// ------------------------------------------------------- response flags

test('NR decodes to the filter-chain answer only when the code details say so', () => {
  const chain = decodeResponseFlag('NR', ['filter_chain_not_found']);
  assert.match(chain.name, /filter chain/);
  assert.match(chain.meaning, /Gateway/);

  const route = decodeResponseFlag('NR', ['route_not_found']);
  assert.ok(!/filter chain/.test(route.name));
  assert.strictEqual(route.known, true);
});

test('an unknown flag is reported as unknown rather than silently dropped', () => {
  const x = decodeResponseFlag('ZZ');
  assert.strictEqual(x.known, false);
  assert.strictEqual(x.flag, 'ZZ');
  // Canary: `RESPONSE_FLAGS` is a null-prototype object. A plain object would answer
  // `decodeResponseFlag('constructor')` with a function and crash on `.meaning`.
  const proto = decodeResponseFlag('constructor');
  assert.strictEqual(proto.known, false);
});

/*
  Envoy comma-joins multi-flag values, and the comma is not a stylistic choice — measured on
  platformsbx, `UF,URX` appeared 38 times in 7,388 access-log lines and no observed value contained
  whitespace. The original fixture for this test used `'UF URX'`, which is why a whitespace-only
  split looked correct for as long as it did: the test agreed with the code and both disagreed with
  Envoy. The comma case is the one that has to hold.
*/
test('a comma-joined flag pair contributes to both, which is the shape Envoy actually emits', () => {
  const flags = aggregateFlags([rec({ responseFlags: 'UF,URX', code: 503 })]);
  assert.deepEqual(flags.map(f => f.flag).sort(), ['UF', 'URX']);
  assert.strictEqual(flags[0].count, 1);
  // Both halves must decode. An unrecognised `UF,URX` bucket is the bug this guards: it turns a
  // hard backend-down verdict into a grey unknown row.
  assert.ok(flags.every(f => f.known), 'both halves of a comma pair must decode as known flags');
});

test('a whitespace-separated pair still splits, as a defensive guard on a format change', () => {
  const flags = aggregateFlags([rec({ responseFlags: 'UF URX', code: 503 })]);
  assert.deepEqual(flags.map(f => f.flag).sort(), ['UF', 'URX']);
  assert.strictEqual(flags[0].count, 1);
});

test('the no-verdict dash never becomes a flag bucket of its own', () => {
  // The parser maps `-` to null on the way in, so aggregateFlags must see nothing at all. If a
  // dash ever did reach it, splitting would mint a flag literally named `-` and the page would
  // report a verdict on 6,286 of 7,388 lines that carried none.
  assert.deepEqual(aggregateFlags([rec({ responseFlags: null, code: 200 })]), []);
});

// ----------------------------------------------------------------- rate

test('the rate is each proxy divided by its own span, then summed', () => {
  const t = s => new Date(Date.UTC(2026, 8, 19, 10, 0, s)).toISOString();
  const records = [
    // gw-1: 3 lines over 60s => 0.05/s
    rec({ startTime: t(0), proxy: { pod: 'gw-1', namespace: 'istio-system' } }),
    rec({ startTime: t(30), proxy: { pod: 'gw-1', namespace: 'istio-system' } }),
    rec({ startTime: t(60), proxy: { pod: 'gw-1', namespace: 'istio-system' } }),
    // gw-2: 2 lines over 40s => 0.05/s
    rec({ startTime: t(0), proxy: { pod: 'gw-2', namespace: 'istio-system' } }),
    rec({ startTime: t(40), proxy: { pod: 'gw-2', namespace: 'istio-system' } })
  ];
  const r = spanWeightedRate(records);
  assert.strictEqual(r.suppressed, false);
  assert.strictEqual(r.perSecond, 0.1);
  assert.strictEqual(r.contributors.length, 2);
  assert.strictEqual(r.shortestSpanSeconds, 40);

  // Canary: pooling would divide 5 lines by the 60s outer span and answer 0.08 — wrong, and
  // wrong in the direction that understates a busy proxy sharing a window with an idle one.
  assert.notStrictEqual(r.perSecond, Math.round((5 / 60) * 100) / 100);
});

test('a window too short to be a rate is suppressed with the reason, never rounded to a number', () => {
  const records = [
    rec({ startTime: '2026-09-19T10:00:00.000Z' }),
    rec({ startTime: '2026-09-19T10:00:02.000Z' })
  ];
  const r = spanWeightedRate(records);
  assert.strictEqual(r.perSecond, null);
  assert.strictEqual(r.suppressed, true);
  assert.ok(r.shortestSpanSeconds < MIN_RATE_SPAN_SECONDS);
  assert.match(r.why, /too short/);
});

test('lines with no timestamp are in neither the numerator nor the denominator', () => {
  const r = spanWeightedRate([rec({ startTime: null }), rec({ startTime: null })]);
  assert.strictEqual(r.perSecond, null);
  assert.strictEqual(r.suppressed, true);
  assert.match(r.why, /no span/);
  assert.strictEqual(r.contributors[0].records, 2);
  assert.strictEqual(r.contributors[0].timed, 0);
});

// ----------------------------------------------------------------- hosts

test('requests group by host, with the families kept apart', () => {
  const rows = aggregateHosts(
    [
      rec({ authority: 'shop.example.com:443', code: 200 }),
      rec({ authority: 'shop.example.com', code: 302 }),
      rec({ authority: 'shop.example.com', code: 404 }),
      rec({ authority: 'shop.example.com', code: 503 }),
      rec({ authority: 'other.example.com', code: 200 })
    ],
    EMPTY_INDEX
  ).rows;

  const shop = rows.find(r => r.host === 'shop.example.com');
  assert.strictEqual(shop.requests, 4, 'the :443 form groups with the bare host');
  assert.deepEqual([shop.ok, shop.redirect, shop.client, shop.server], [1, 1, 1, 1]);
  assert.strictEqual(shop.errorShare, 0.5);
  // Busiest first, so the table opens on the host carrying the traffic.
  assert.strictEqual(rows[0].host, 'shop.example.com');
});

test('a record with no authority is its own printable bucket, not a dropped line', () => {
  const out = aggregateHosts([rec({ authority: null, code: 0 }), rec({ authority: '', code: 0 })], EMPTY_INDEX);
  const none = out.rows.find(r => r.key === NO_HOST_KEY);
  assert.ok(none, 'the no-authority bucket must be present');
  assert.strictEqual(none.host, null);
  assert.strictEqual(none.group, 'none');
  assert.strictEqual(none.requests, 2);
  // Canary: dropping these would have hidden 115 of 400 lines on the cluster this was built
  // against — 29% of the window, and the single largest bucket.
});

test('upstream latency comes from upstream_service_time, and a null is not a measured zero', () => {
  const out = aggregateHosts(
    [
      rec({ duration: 100, upstreamMs: 90 }),
      rec({ duration: 200, upstreamMs: null }),
      rec({ duration: 300, upstreamMs: 280 }),
      rec({ duration: 400, upstreamMs: 300 })
    ],
    EMPTY_INDEX
  ).rows[0];

  assert.strictEqual(out.upstream.samples, 3, 'only the lines that carried a value are measured');
  assert.strictEqual(out.total.samples, 4);
  // Nearest-rank, like every other percentile in this collector: a reported figure is always a
  // line that was actually logged, never an interpolation between two of them.
  assert.strictEqual(out.upstream.p50Ms, 280);
  // Canary: counting the null as a 0 would make the sorted set [0, 90, 280, 300] and drag this
  // to 90 — a third of the truth, and in the direction that says the upstream is fine.
  assert.notStrictEqual(out.upstream.p50Ms, 90);
  // Overhead needs both halves. `200 − 0` would report a whole rejected request as proxy overhead.
  assert.strictEqual(out.overheadMs, 20);
});

test('a host with no measurable latency reports null, not zero', () => {
  const out = aggregateHosts([rec({ duration: null, upstreamMs: null })], EMPTY_INDEX).rows[0];
  assert.strictEqual(out.upstream.p50Ms, null);
  assert.strictEqual(out.total.p50Ms, null);
  assert.strictEqual(out.overheadMs, null);
});

test('the host cap is reported as truncation rather than applied in silence', () => {
  const many = [];
  for (let i = 0; i < MAX_INGRESS_HOSTS + 5; i += 1) many.push(rec({ authority: `h${i}.example.com` }));
  const out = aggregateHosts(many, EMPTY_INDEX);
  assert.strictEqual(out.rows.length, MAX_INGRESS_HOSTS);
  assert.strictEqual(out.total, MAX_INGRESS_HOSTS + 5);
  assert.strictEqual(out.truncated, true);
});

test('a host row names the Gateway that admits it and the objects that declare it', () => {
  const index = buildIndex({
    pods: ok([]),
    services: ok([]),
    endpointslices: ok([]),
    nodes: ok([]),
    gateways: ok([
      {
        metadata: { name: 'kyma-gateway', namespace: 'kyma-system' },
        spec: { servers: [{ port: { number: 443 }, hosts: ['*.example.com'] }] }
      }
    ])
  });
  const routes = buildRouteIndex({
    virtualservices: ok([{ metadata: { name: 'shop-vs', namespace: 'shop' }, spec: { hosts: ['shop.example.com'] } }]),
    apirules: ok([])
  });

  const row = aggregateHosts([rec()], index, { routes }).rows[0];
  assert.strictEqual(row.gateway.name, 'kyma-gateway');
  assert.strictEqual(row.gateway.port, 443);
  assert.deepEqual(row.servedBy.map(s => s.name), ['shop-vs']);
});

// ---------------------------------------------------------------- clients

test('clients group by peer address, and CONNECT probes are counted', () => {
  const out = aggregateClients(
    [
      rec({ downstreamRemote: '203.0.113.9:1000', method: 'CONNECT', authority: 'checkip.example.net:443', code: 403 }),
      rec({ downstreamRemote: '203.0.113.9:1001', method: 'CONNECT', authority: 'checkip.example.net:443', code: 403 }),
      rec({ downstreamRemote: '203.0.113.9:1002', method: 'GET', code: 200 }),
      rec({ downstreamRemote: '198.51.100.4:1003', method: 'GET', code: 200 }),
      rec({ downstreamRemote: '10.250.0.7:2000', method: 'GET', code: 200 })
    ],
    EMPTY_INDEX
  );

  // External peers share one row with no address (D1, 2026-09-26); `distinct` counts them.
  const ext = out.rows.find(r => r.key === 'external');
  assert.strictEqual(ext.ip, null);
  assert.strictEqual(ext.distinct, 2, 'the source port is not part of the identity');
  assert.strictEqual(ext.requests, 4);
  assert.strictEqual(ext.connects, 2);
  assert.strictEqual(ext.external, true);
  assert.strictEqual(ext.hosts, 2);
  assert.strictEqual(out.total, 3, 'every peer is still counted');
  assert.strictEqual(out.externalTotal, 2);
  assert.strictEqual(out.connectingTotal, 1);

  // A private address matching no cluster object is a client's too (an internal NLB, peering or
  // VPN): it folds into its own address-free row, never kept as a row keyed by the IP.
  const unresolved = out.rows.find(r => r.key === 'unresolved');
  assert.strictEqual(unresolved.ip, null);
  assert.strictEqual(unresolved.distinct, 1);
  assert.strictEqual(unresolved.external, false);
  assert.ok(!JSON.stringify(out).includes('10.250.0.7'));
});

test('failure-group sources never carry an unresolved private address', () => {
  const groups = aggregate(
    [
      rec({ downstreamRemote: '10.20.30.40:5555', code: 503 }),
      rec({ downstreamRemote: '10.20.30.41:5556', code: 503 })
    ],
    EMPTY_INDEX
  );
  const json = JSON.stringify(groups);
  assert.ok(!json.includes('10.20.30.4'), json);
  const src = groups.flatMap(g => g.sources).find(s => s.kind === 'unresolved');
  assert.strictEqual(src.ip, null);
  assert.strictEqual(src.count, 2);
});

test('a client row carries no user agent and no forwarded-for chain', () => {
  const rows = aggregateClients([rec()], EMPTY_INDEX).rows;
  const json = JSON.stringify(rows);
  assert.ok(!/user[_-]?agent/i.test(json));
  assert.ok(!/x[_-]forwarded/i.test(json));
  // Resurrecting XFF to name "the real client" would put a person's network path in a GET body,
  // and since D1 not even the peer address is published: the row stands for every external peer.
  assert.strictEqual(rows[0].ip, null);
  assert.ok(!json.includes('203.0.113.9'));
});

// -------------------------------------------------------------- listeners

test('listeners group by the port the connection was accepted on', () => {
  const out = aggregateListeners([
    rec({ downstreamLocal: '10.250.0.1:443' }),
    rec({ downstreamLocal: '10.250.0.1:443' }),
    rec({ downstreamLocal: '10.250.0.1:80', code: 301 })
  ]);
  const https = out.ports.find(p => p.port === 443);
  assert.strictEqual(https.requests, 2);
  assert.strictEqual(out.ports.find(p => p.port === 80).requests, 1);
});

test('filter_chain_not_found is grouped by the SNI offered, which is its only identity', () => {
  const out = aggregateListeners([
    rec({
      authority: null,
      code: 0,
      responseFlags: 'NR',
      responseCodeDetails: 'filter_chain_not_found',
      requestedServerName: 'wildcard.example.com',
      downstreamLocal: '10.250.0.1:443'
    }),
    rec({
      authority: null,
      code: 0,
      responseFlags: 'NR',
      responseCodeDetails: 'filter_chain_not_found',
      requestedServerName: null,
      downstreamLocal: '10.250.0.1:443'
    })
  ]);

  assert.strictEqual(out.ports.find(p => p.port === 443).rejected, 2);
  const keys = out.rejections.map(r => r.sni);
  assert.ok(keys.includes('wildcard.example.com'));
  // A connection that offered no SNI still gets a row rather than merging with the named one.
  assert.strictEqual(out.rejections.length, 2);
  assert.ok(out.rejections.some(r => r.sni === null));
});

// ------------------------------------------------------- gateways and tier

test('a Gateway row reports the TLS credential by NAME and never reads its value', () => {
  const rows = ingressGatewayRows(
    ok([
      {
        metadata: { name: 'apple-gateway-mtls', namespace: 'istio-system' },
        spec: {
          selector: { istio: 'ingressgateway' },
          servers: [
            {
              port: { number: 443, name: 'https', protocol: 'HTTPS' },
              tls: { mode: 'MUTUAL', credentialName: 'gw-tls', minProtocolVersion: 'TLSV1_2' },
              hosts: ['*.mtls.example.com']
            }
          ]
        }
      }
    ])
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].credentialName, 'gw-tls');
  assert.strictEqual(rows[0].tlsMode, 'MUTUAL');
  assert.deepEqual(rows[0].hosts, ['*.mtls.example.com']);
  // Canary: the name is the finding; a value would be a credential in a GET body.
  assert.ok(!('credential' in rows[0]));
  assert.ok(!('tlsSecret' in rows[0]));
});

test('an unreadable Gateway list declares no servers rather than throwing', () => {
  assert.deepEqual(ingressGatewayRows(gone('FORBIDDEN')), []);
  assert.deepEqual(ingressGatewayRows(null), []);
});

test('the ingress tier reports pods, Service, HPA and PDB, and a missing ceiling is not a ceiling reached', () => {
  const tier = ingressTier({
    pods: ok([
      {
        metadata: { name: 'istio-ingressgateway-abc', namespace: 'istio-system', labels: { app: 'istio-ingressgateway' } },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ name: 'istio-proxy', restartCount: 2 }]
        }
      },
      { metadata: { name: 'some-app', namespace: 'shop', labels: {} }, status: { phase: 'Running' } }
    ]),
    services: ok([
      {
        metadata: { name: 'istio-ingressgateway', namespace: 'istio-system' },
        spec: {
          type: 'LoadBalancer',
          selector: { istio: 'ingressgateway' },
          ports: [{ name: 'https', port: 443, targetPort: 8443, protocol: 'TCP' }]
        },
        status: { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }] } }
      }
    ]),
    hpas: ok([
      {
        metadata: { name: 'istio-ingressgateway', namespace: 'istio-system' },
        spec: { scaleTargetRef: { name: 'istio-ingressgateway' }, minReplicas: 1, maxReplicas: 5 },
        status: { currentReplicas: 5, desiredReplicas: 5, conditions: [] }
      }
    ]),
    pdbs: ok([
      {
        metadata: { name: 'istio-ingressgateway-pdb', namespace: 'istio-system' },
        spec: { minAvailable: 1 },
        status: { currentHealthy: 1, desiredHealthy: 1, disruptionsAllowed: 0, expectedPods: 1 }
      }
    ])
  });

  assert.strictEqual(tier.pods.total, 1, 'only the gateway pod, not every running pod');
  assert.strictEqual(tier.pods.ready, 1);
  assert.strictEqual(tier.pods.restarts, 2);
  assert.strictEqual(tier.service.type, 'LoadBalancer');
  assert.deepEqual(tier.service.endpoints, ['lb.example.com']);
  assert.strictEqual(tier.hpa.atCeiling, true);
  assert.strictEqual(tier.pdb.disruptionsAllowed, 0);
});

test('an unreadable HPA read is null, and null is never "at ceiling"', () => {
  const tier = ingressTier({ pods: ok([]), services: gone('FORBIDDEN'), hpas: gone('FORBIDDEN'), pdbs: gone('FORBIDDEN') });
  assert.strictEqual(tier.hpa, null);
  assert.strictEqual(tier.pdb, null);
  assert.strictEqual(tier.service, null);
  assert.strictEqual(tier.pods.total, 0);
});

// ---------------------------------------------------------- the whole block

test('the ingress block reads only the ingress proxies, and says so', () => {
  const records = [
    rec({ proxy: { pod: 'istio-ingressgateway-1', namespace: 'istio-system' }, authority: 'a.example.com' }),
    rec({ proxy: { pod: 'shop-app-1', namespace: 'shop' }, authority: 'b.example.com' })
  ];
  const out = aggregateIngress({
    records,
    index: EMPTY_INDEX,
    ingressKeys: new Set(['istio-system/istio-ingressgateway-1'])
  });

  assert.strictEqual(out.scope, 'ingress');
  assert.strictEqual(out.summary.requests, 1);
  assert.deepEqual(out.hosts.map(h => h.host), ['a.example.com']);
  // Canary: a sidecar's east-west request under a heading that says ingress is the same class of
  // lie as a 403 rendered as a zero.
  assert.ok(!out.hosts.some(h => h.host === 'b.example.com'));
});

test('no ingress proxy read means scope "none" — never a silent fall back to the whole mesh', () => {
  const out = aggregateIngress({
    records: [rec({ proxy: { pod: 'shop-app-1', namespace: 'shop' } })],
    index: EMPTY_INDEX,
    ingressKeys: new Set()
  });
  assert.strictEqual(out.scope, 'none');
  assert.strictEqual(out.summary.requests, 0);
  assert.strictEqual(out.summary.ingressProxies, 0);
  assert.deepEqual(out.hosts, []);
});

test('the domain tile counts named hosts only, so "no Host header" never inflates it', () => {
  const out = aggregateIngress({
    records: [rec({ authority: 'a.example.com' }), rec({ authority: null, code: 0 })],
    index: EMPTY_INDEX,
    ingressKeys: new Set(['istio-system/gw-1'])
  });
  assert.strictEqual(out.summary.hosts, 1);
  assert.strictEqual(out.summary.hostsIncludingUnnamed, 2);
});

test('a byte total nobody logged is null, not a confident zero', () => {
  // `bytes_received` is genuinely 0 on all 400 lines of a live ingress window — health probes and
  // plain GETs carry no request body — so a real 0 must survive as a 0.
  const real = aggregateHosts([rec({ bytesSent: 0, bytesReceived: 0 })], EMPTY_INDEX).rows[0];
  assert.strictEqual(real.bytesSent, 0);
  assert.strictEqual(real.bytesReceived, 0);

  // A build whose log format omits the field is a different answer and must read as one.
  const absent = aggregateHosts([rec({ bytesSent: null, bytesReceived: null })], EMPTY_INDEX).rows[0];
  assert.strictEqual(absent.bytesSent, null);
  assert.strictEqual(absent.bytesReceived, null);

  // Same at the summary level, where a bare `+=` over nulls sums to a plausible 0.
  const summary = aggregateIngress({
    records: [rec({ bytesSent: null, bytesReceived: null })],
    index: EMPTY_INDEX,
    ingressKeys: new Set(['istio-system/gw-1'])
  }).summary;
  assert.strictEqual(summary.bytesSent, null);
  assert.strictEqual(summary.bytesReceived, null);

  const client = aggregateClients([rec({ bytesSent: null, bytesReceived: null })], EMPTY_INDEX).rows[0];
  assert.strictEqual(client.bytesSent, null);
});

test('the error share is a share of what was read, and is null when nothing was read', () => {
  const empty = aggregateIngress({ records: [], index: EMPTY_INDEX, ingressKeys: new Set(['istio-system/gw-1']) });
  assert.strictEqual(empty.summary.errorShare, null);
  // Canary: `0 / 0` is NaN and JSON.stringify turns NaN into null anyway — but a 0 here would
  // render as a green "0% errors" on a cluster nothing was read from.
  assert.ok(!('errorRate' in empty.summary));
});

// ------------------------------------------------------- collect() wiring

test('collect returns an ingress block scoped to the gateway pod it read', async () => {
  const listFn = fakeList({
    '/api/v1/pods': [
      proxyPod('istio-ingressgateway-1', 'istio-system', { labels: { app: 'istio-ingressgateway' } }),
      proxyPod('shop-app-1', 'shop')
    ],
    '/virtualservices': [{ metadata: { name: 'shop-vs', namespace: 'shop' }, spec: { hosts: ['shop.example.com'] } }],
    '/apirules': [{ metadata: { name: 'shop-rule', namespace: 'shop' }, spec: { hosts: ['shop.example.com'] } }],
    '/gateways': [
      {
        metadata: { name: 'kyma-gateway', namespace: 'kyma-system' },
        spec: { servers: [{ port: { number: 443, protocol: 'HTTPS' }, hosts: ['*.example.com'] }] }
      }
    ]
  });
  const textFn = async ({ path }) =>
    path.includes('istio-ingressgateway-1') ? [accessLine({ response_code: 200 }), accessLine()].join('\n') : accessLine();

  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });

  assert.strictEqual(out.ingress.scope, 'ingress');
  assert.strictEqual(out.ingress.summary.requests, 2, 'the sidecar lines are not in the ingress block');
  assert.strictEqual(out.ingress.summary.ingressProxies, 1);
  assert.deepEqual(out.ingress.ingressProxiesUnread, []);
  const row = out.ingress.hosts[0];
  assert.strictEqual(row.host, 'shop.example.com');
  assert.strictEqual(row.gateway.name, 'kyma-gateway');
  assert.deepEqual(row.servedBy.map(s => s.kind).sort(), ['APIRule', 'VirtualService']);
  assert.deepEqual(out.ingress.routesFrom, { virtualservices: 1, apirules: 1 });
  // The overall traffic numbers still describe every proxy read — the ingress block narrows, it
  // does not replace.
  assert.strictEqual(out.summary.requests, 3);
});

test('an ingress proxy whose log was refused is named, not subtracted', async () => {
  const listFn = fakeList({
    '/api/v1/pods': [
      proxyPod('istio-ingressgateway-1', 'istio-system', { labels: { app: 'istio-ingressgateway' } }),
      proxyPod('istio-ingressgateway-2', 'istio-system', { labels: { app: 'istio-ingressgateway' } })
    ]
  });
  const textFn = async ({ path }) => {
    if (path.includes('istio-ingressgateway-2')) throw Object.assign(new Error('forbidden'), { status: 403 });
    return accessLine({ response_code: 200 });
  };

  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });
  assert.strictEqual(out.ingress.summary.ingressProxies, 1);
  assert.strictEqual(out.ingress.ingressProxiesSelected, 2);
  assert.deepEqual(out.ingress.ingressProxiesUnread, ['istio-system/istio-ingressgateway-2']);
  assert.strictEqual(out.window.proxiesFailed.length, 1);
});

test('the four new reads land in summary.unavailable when refused', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('/api/v1/pods')) return [proxyPod('gw-1', 'istio-system')];
    if (path.includes('/virtualservices') || path.includes('/apirules') ||
        path.includes('horizontalpodautoscalers') || path.includes('poddisruptionbudgets')) {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    }
    return [];
  };
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn: async () => '' });
  for (const label of ['virtualservices', 'apirules', 'ingress-hpa', 'ingress-pdb']) {
    assert.ok(
      out.summary.unavailable.includes(label),
      `${label} must be named in summary.unavailable rather than degrading to an empty list`
    );
  }
  assert.strictEqual(out.ingress.routesFrom.virtualservices, null);
});

test('no raw log line reaches the ingress block', async () => {
  const listFn = fakeList({
    '/api/v1/pods': [proxyPod('istio-ingressgateway-1', 'istio-system', { labels: { app: 'istio-ingressgateway' } })]
  });
  const marker = 'DO-NOT-ECHO-THIS-LINE';
  const textFn = async () => accessLine({ request_id: marker, 'x-forwarded-for': '17.1.2.3', user_agent: 'curl/8' });

  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });
  const json = JSON.stringify(out.ingress);
  assert.ok(!json.includes(marker), 'request_id identifies one request and is never echoed');
  assert.ok(!/user[_-]?agent/i.test(json));
  assert.ok(!/17\.1\.2\.3/.test(json));
});

test('a non-numeric sinceSeconds is dropped rather than sent as NaN', async () => {
  const asked = [];
  const listFn = fakeList({ '/api/v1/pods': [proxyPod('gw-1', 'istio-system')] });
  const textFn = async ({ path }) => {
    asked.push(path);
    return '';
  };

  const bad = await collect({ cluster: CLUSTER, token: 't', listFn, textFn, sinceSeconds: 'abc' });
  assert.strictEqual(bad.window.sinceSeconds, null);
  assert.ok(!asked.some(p => p.includes('sinceSeconds')), 'no sinceSeconds parameter at all');
  // Canary: `Math.max(1, Number('abc'))` is NaN, which the API server rejects — one bad query
  // parameter used to fail every pod log read and report it as a cluster problem.
  assert.ok(!asked.some(p => p.includes('NaN')));

  asked.length = 0;
  const good = await collect({ cluster: CLUSTER, token: 't', listFn, textFn, sinceSeconds: '900' });
  assert.strictEqual(good.window.sinceSeconds, 900);
  assert.ok(asked.every(p => p.includes('sinceSeconds=900')));
});

test('isIngressProxy recognises the label and the name, and nothing else', () => {
  assert.strictEqual(isIngressProxy({ metadata: { name: 'x', labels: { app: 'istio-ingressgateway' } } }), true);
  assert.strictEqual(isIngressProxy({ metadata: { name: 'x', labels: { istio: 'ingressgateway' } } }), true);
  assert.strictEqual(isIngressProxy({ metadata: { name: 'istio-ingressgateway-7d9' } }), true);
  assert.strictEqual(isIngressProxy({ metadata: { name: 'shop-app', labels: { app: 'shop' } } }), false);
  // An egress gateway is a gateway and is not the ingress tier.
  assert.strictEqual(isIngressProxy({ metadata: { name: 'istio-egressgateway-1', labels: {} } }), false);
  assert.strictEqual(isIngressProxy(null), false);
});

test('parseAccessLine reads upstream_service_time out of a JSON string', () => {
  // Kyma's stdout-json provider emits `duration` as a number and `upstream_service_time` as a
  // STRING. A `typeof === 'number'` guard would have dropped every upstream measurement.
  const r = parseAccessLine(accessLine({ upstream_service_time: '12', bytes_received: 340 }));
  assert.strictEqual(r.upstreamMs, 12);
  assert.strictEqual(r.bytesReceived, 340);

  const none = parseAccessLine(accessLine({ upstream_service_time: null }));
  assert.strictEqual(none.upstreamMs, null, 'absent is null, never a measured 0');

  const dash = parseAccessLine(accessLine({ requested_server_name: '-', route_name: '-' }));
  assert.strictEqual(dash.requestedServerName, null, 'Envoy writes - for absent, not an empty string');
  assert.strictEqual(dash.routeName, null);
});

test('a transport failure that merely repeats the termination detail is reported once', () => {
  // Kyma maps `upstream_transport_failure_reason` to %CONNECTION_TERMINATION_DETAILS%, so the two
  // fields carry the same text. Printing both under two different explanations told operators the
  // upstream connection had failed when the client had simply gone away.
  const same = parseAccessLine(
    accessLine({ connection_termination_details: 'closed', upstream_transport_failure_reason: 'closed' })
  );
  assert.strictEqual(same.terminationDetails, 'closed');
  assert.strictEqual(same.transportFailure, null);

  const real = parseAccessLine(
    accessLine({ connection_termination_details: null, upstream_transport_failure_reason: 'TLS_error' })
  );
  assert.strictEqual(real.transportFailure, 'TLS_error');
});

/* ------------------------------------------------------------------ the cap must not reach the tiles

   Three tiles were computed over the capped row list and printed beside uncapped siblings. Each test
   below pins the uncapped figure *and* asserts the pre-fix arithmetic is a different number, because
   a guard that both versions satisfy would have shipped with the bug it was written for. */

test('the no-Host-header tile counts records, not the one bucket they share', () => {
  const records = [rec({ authority: 'shop.example.com' })];
  for (let i = 0; i < 340; i += 1) records.push(rec({ authority: null, code: 0, method: null }));

  const out = aggregateHosts(records, EMPTY_INDEX);
  assert.strictEqual(out.unnamedRequests, 340);
  assert.strictEqual(out.namedTotal, 1);

  // Canary: the bucket difference is 1 for any number of authority-less records, because they all
  // collapse into NO_HOST_KEY. Live, that printed "1 more record carried no Host header" over 23% of
  // the window. If this ever equals unnamedRequests the fixture stopped exercising the bug.
  assert.strictEqual(out.total - out.namedTotal, 1);
  assert.notStrictEqual(out.total - out.namedTotal, out.unnamedRequests);
});

test('named hosts and the group rollup are counted over every bucket, not the listed ones', () => {
  const records = [];
  for (let i = 0; i < MAX_INGRESS_HOSTS + 50; i += 1) {
    // Descending volume, so the 50 hosts past the cap are the quiet ones the slice drops.
    for (let n = 0; n <= MAX_INGRESS_HOSTS + 50 - i; n += 1) records.push(rec({ authority: `h${i}.example.com` }));
  }

  const out = aggregateHosts(records, EMPTY_INDEX);
  assert.strictEqual(out.rows.length, MAX_INGRESS_HOSTS, 'the wire payload is still capped');
  assert.strictEqual(out.namedTotal, MAX_INGRESS_HOSTS + 50);

  // Canary: counting over the listed rows answers the cap itself, so a 250-host cluster reported 200
  // named hosts beside a total of 250 — and the caption then invented 50 records with no Host header.
  assert.notStrictEqual(out.rows.filter(r => r.host).length, out.namedTotal);

  // The group rollup shares the denominator with `records`, so a share of it cannot exceed 100%.
  const grouped = out.groups.reduce((n, g) => n + g.requests, 0);
  assert.strictEqual(grouped, records.length);
  assert.notStrictEqual(out.rows.reduce((n, r) => n + r.requests, 0), grouped);
});

test('a quiet scanner outside the row cap is still counted by the peer tiles', () => {
  const records = [];
  for (let i = 0; i < MAX_INGRESS_CLIENTS; i += 1) {
    for (let n = 0; n < 5; n += 1) records.push(rec({ downstreamRemote: `198.51.100.${i}:${1000 + n}`, code: 200 }));
  }
  // One peer, one CONNECT, answered 403 — the lowest possible volume, so the volume-sorted cap drops
  // it. This is the shape the screen exists to surface.
  records.push(rec({ downstreamRemote: '203.0.113.200:9000', method: 'CONNECT', code: 403 }));

  const out = aggregateClients(records, EMPTY_INDEX);
  // Every peer here is external, so they share one address-free row; the tiles still count peers.
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].distinct, MAX_INGRESS_CLIENTS + 1);
  assert.strictEqual(out.connectingTotal, 1);
  assert.strictEqual(out.fullyRejectedTotal, 1);
  assert.strictEqual(out.externalTotal, MAX_INGRESS_CLIENTS + 1);
  assert.strictEqual(out.total, MAX_INGRESS_CLIENTS + 1);

  // Canary: over the listed row both read wrong — the merged row is neither fully rejected nor a
  // count of peers, so tiles derived from rows would misreport the scanner.
  assert.strictEqual(out.rows.filter(c => c.requests > 0 && c.errorShare === 1).length, 0);
  assert.notStrictEqual(out.rows.filter(c => c.external).length, out.externalTotal);
});

test('internal peers keep their rows, capped by volume, beside the one external row', () => {
  const idx = { ...EMPTY_INDEX, byIp: new Map() };
  const records = [];
  for (let i = 0; i < MAX_INGRESS_CLIENTS + 3; i += 1) {
    const ip = `10.250.1.${i}`;
    idx.byIp.set(ip, { kind: 'node', name: `node-${i}`, namespace: null, evidence: 'Node address' });
    records.push(rec({ downstreamRemote: `${ip}:1`, code: 200 }));
  }
  records.push(rec({ downstreamRemote: '203.0.113.7:1', code: 200 }));
  const out = aggregateClients(records, idx);
  assert.strictEqual(out.rows.length, MAX_INGRESS_CLIENTS);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(out.total, MAX_INGRESS_CLIENTS + 4);
  assert.ok(out.rows.every(r => r.ip === null || r.ip.startsWith('10.250.1.')));
});

test('the sampled-requests rate divides requests, not records', () => {
  const t = s => new Date(Date.UTC(2026, 8, 19, 10, 0, s)).toISOString();
  const records = [];
  // 100 HTTP requests and 300 non-HTTP records over the same 50s span on one proxy.
  for (let i = 0; i < 100; i += 1) records.push(rec({ startTime: t(i % 50), method: 'GET', code: 200 }));
  for (let i = 0; i < 300; i += 1) records.push(rec({ startTime: t(i % 50), method: null, code: 0 }));

  const out = aggregateIngress({
    records,
    index: EMPTY_INDEX,
    ingressKeys: new Set(['istio-system/gw-1'])
  });

  assert.strictEqual(out.summary.requests, 100);
  assert.strictEqual(out.summary.connections, 300);
  assert.strictEqual(out.summary.rate.perSecond, spanWeightedRate(records.filter(r => r.method)).perSecond);

  // Canary: over every record the tile reads 4x the request rate it is labelled with. Live that was
  // 0.07/s published against an actual 0.054/s.
  assert.notStrictEqual(out.summary.rate.perSecond, spanWeightedRate(records).perSecond);
});
