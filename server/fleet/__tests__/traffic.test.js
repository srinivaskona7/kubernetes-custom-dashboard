import { test } from 'vitest';
import assert from 'node:assert';

import _traffic from '../collectors/traffic.js';
const {
  collect,
  accessLogVerdict,
  meshProviders,
  parseAccessLine,
  parseUpstreamCluster,
  buildIndex,
  resolveAddress,
  matchGateway,
  selectProxies,
  aggregate,
  redactUrl,
  clean,
  classOf,
  isPrivate,
  MAX_PODS,
  MAX_TAIL_LINES
} = _traffic;

// ---------------------------------------------------------------- helpers

const ok = items => ({ items, unavailable: false, reason: null, detail: null, truncated: false });
const gone = reason => ({ items: [], unavailable: true, reason, detail: null, truncated: false });

function proxyPod(name, namespace, { phase = 'Running', proxy = true, restarts = 0 } = {}) {
  return {
    metadata: { name, namespace },
    spec: { containers: proxy ? [{ name: 'app' }, { name: 'istio-proxy' }] : [{ name: 'app' }], nodeName: 'node-a' },
    status: { phase, podIP: null, containerStatuses: [{ name: 'app', restartCount: restarts }] }
  };
}

/** A real line, trimmed to the fields this collector reads. */
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

const EMPTY_INDEX = buildIndex({
  pods: ok([]), services: ok([]), endpointslices: ok([]), nodes: ok([]), gateways: ok([])
});

// ------------------------------------------------- access-log verdict

test('no Telemetry CR enabling access logging reports "off", not an empty error list', () => {
  const v = accessLogVerdict(ok([]));
  assert.strictEqual(v.state, 'off');
  assert.match(v.why, /reads Envoy’s access log/);
  // Canary: if this returned `on`, the tab would render "no traffic errors" on a cluster that
  // writes no request lines at all — the exact "403 rendered as healthy" failure the console
  // is not allowed to make.
});

test('an accessLogging CR in istio-system is mesh-wide and names its provider', () => {
  const v = accessLogVerdict(
    ok([
      {
        metadata: { name: 'telemetry-config', namespace: 'istio-system' },
        spec: { accessLogging: [{ providers: [{ name: 'stdout-json' }] }] }
      }
    ])
  );
  assert.strictEqual(v.state, 'on');
  assert.strictEqual(v.scope, 'mesh');
  assert.deepStrictEqual(v.providers, ['stdout-json']);
  assert.strictEqual(v.decidedBy[0].name, 'telemetry-config');
});

test('a selector-scoped CR is "on" but only partially, so a missing workload is explained', () => {
  const v = accessLogVerdict(
    ok([
      {
        metadata: { name: 'partial', namespace: 'istio-system' },
        spec: { accessLogging: [{ providers: [{ name: 'stdout-json' }] }], selector: { matchLabels: { app: 'srv' } } }
      }
    ])
  );
  assert.strictEqual(v.scope, 'partial');
  assert.match(v.why, /some workloads only/);
});

test('accessLogging with disabled:true does not count as enabling', () => {
  const v = accessLogVerdict(
    ok([
      {
        metadata: { name: 'off', namespace: 'istio-system' },
        spec: { accessLogging: [{ providers: [{ name: 'stdout-json' }], disabled: true }] }
      }
    ])
  );
  assert.strictEqual(v.state, 'off');
  assert.strictEqual(v.decidedBy.length, 1);
});

test('unreadable Telemetry CRs report "unknown", never "off"', () => {
  const v = accessLogVerdict(gone('FORBIDDEN'));
  assert.strictEqual(v.state, 'unknown');
  assert.strictEqual(v.reason, 'FORBIDDEN');
});

// ------------------------------------- mesh providers: stdout-json vs otel-logs

/**
 * The four `extensionProviders` a managed Istio mesh declares, copied from the `istio` ConfigMap on
 * a live cluster. Two of them are access-log providers and they behave oppositely:
 * `stdout-json` writes to the stream `pods/log` returns, `otel-logs` streams to the OTLP gateway
 * and writes nothing. Trimmed to the keys this module reads; the shape is verbatim.
 */
const MESH_YAML = `
extensionProviders:
- name: otel-traces
  opentelemetry:
    port: 4317
    service: otel-traces.observability.svc.cluster.local
- name: envoy
  envoyFileAccessLog:
    logFormat:
      labels: {}
    path: /dev/stdout
- name: stdout-json
  envoyFileAccessLog:
    logFormat:
      labels:
        authority: "%REQ(:AUTHORITY)%"
        method: "%REQ(:METHOD)%"
        path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
        response_code: "%RESPONSE_CODE%"
    path: /dev/stdout
- name: otel-logs
  envoyOtelAls:
    logFormat:
      labels:
        http.request.method: "%CEL(request.method)%"
        http.response.status_code: "%CEL(response.code)%"
        mesh.module: istio
        url.path: "%CEL(request.url_path)%"
    logName: otel-logs
    port: 4317
    service: otel-logs.observability.svc.cluster.local
`;

const meshConfigMap = (mesh = MESH_YAML) => ok([{ metadata: { name: 'istio', namespace: 'istio-system' }, data: { mesh } }]);

/** A Telemetry CR enabling access logging through the named providers. */
const telemetryUsing = (...names) => ok([
  {
    metadata: { name: 'telemetry-config', namespace: 'istio-system' },
    spec: { accessLogging: [{ providers: names.map(name => ({ name })) }] }
  }
]);

test('the mesh config tells a stdout provider apart from an OTLP one', () => {
  const mesh = meshProviders(meshConfigMap());

  assert.deepStrictEqual(mesh.byName['stdout-json'], {
    name: 'stdout-json',
    kind: 'file',
    implementation: 'envoyFileAccessLog',
    readable: true,
    destination: '/dev/stdout',
    fields: 'envoy'
  });
  assert.deepStrictEqual(mesh.byName['otel-logs'], {
    name: 'otel-logs',
    kind: 'otlp',
    implementation: 'envoyOtelAls',
    readable: false,
    destination: 'otel-logs.observability.svc.cluster.local:4317',
    fields: 'otel'
  });
  // A tracing provider is not an access-log provider, and saying "unreadable" about it for the
  // right reason matters: it is not a log that went somewhere else, it is not a log at all.
  assert.strictEqual(mesh.byName['otel-traces'].kind, 'not-access-log');
  // An empty label map is still a file provider on stdout — Envoy's own default line format.
  assert.strictEqual(mesh.byName.envoy.readable, true);
  assert.strictEqual(mesh.byName.envoy.fields, null);
});

test('an unrecognised provider is "unknown", never assumed readable or unreadable', () => {
  const mesh = meshProviders(meshConfigMap('extensionProviders:\n- name: future-sink\n  someNewAls:\n    service: x\n'));
  assert.strictEqual(mesh.byName['future-sink'].kind, 'unknown');
  assert.strictEqual(mesh.byName['future-sink'].readable, null);
  // Canary: `false` here would skip the log read on a provider that might well write to stdout,
  // and the tab would report zero errors without reading a line.
});

test('a file provider writing to a container path is not readable through pods/log', () => {
  const mesh = meshProviders(meshConfigMap('extensionProviders:\n- name: to-disk\n  envoyFileAccessLog:\n    path: /var/log/envoy/access.log\n'));
  assert.strictEqual(mesh.byName['to-disk'].readable, false);
  assert.strictEqual(mesh.byName['to-disk'].destination, '/var/log/envoy/access.log');
});

test('an unreadable or keyless mesh ConfigMap resolves nothing rather than guessing', () => {
  assert.strictEqual(meshProviders(gone('FORBIDDEN')).unavailable, true);
  // `Object.keys`, not `deepStrictEqual({})`: `byName` is deliberately null-prototype so that a
  // provider named `constructor` cannot resolve to an Object.prototype member, and
  // `deepStrictEqual` compares prototypes.
  assert.deepStrictEqual(Object.keys(meshProviders(gone('FORBIDDEN')).byName), []);
  // Read fine, but no `mesh` key: a true zero, and still nothing resolved.
  const noKey = meshProviders(ok([{ metadata: { name: 'istio' }, data: {} }]));
  assert.strictEqual(noKey.unavailable, false);
  assert.strictEqual(noKey.absent, true);
  // Malformed YAML is an outage, not an empty mesh.
  assert.strictEqual(meshProviders(meshConfigMap('extensionProviders:\n  - : :\n   bad')).unavailable, true);
});

test('access logging through otel-logs alone is "on" but NOT readable here', () => {
  const v = accessLogVerdict(telemetryUsing('otel-logs'), meshProviders(meshConfigMap()));

  assert.strictEqual(v.state, 'on');
  assert.strictEqual(v.readable, false);
  assert.match(v.why, /cannot see these requests/);
  assert.match(v.why, /otel-logs\.observability\.svc\.cluster\.local:4317/);
  // The whole point: a zero on this tab must not read as "nothing is failing".
  assert.match(v.why, /not a statement that nothing is failing/);
});

test('otel-logs alongside stdout-json is still readable, because one of them writes to stdout', () => {
  const v = accessLogVerdict(telemetryUsing('stdout-json', 'otel-logs'), meshProviders(meshConfigMap()));
  assert.strictEqual(v.readable, true);
  // The mid-migration state, and the one a wrong `every`/`some` would break: adding otel-logs
  // before removing stdout-json must not blank the tab.
  assert.deepStrictEqual(v.providerDetail.map(p => p.readable), [true, false]);
});

test('a provider the mesh config does not declare leaves readability unknown, not false', () => {
  const v = accessLogVerdict(telemetryUsing('house-sink'), meshProviders(meshConfigMap()));
  assert.strictEqual(v.readable, null);
  assert.deepStrictEqual(v.unresolvedProviders, ['house-sink']);
});

test('the readability caveat is added to the scope sentence, never substituted for it', () => {
  // Two independent facts: WHICH workloads log, and WHETHER their log lands here. An earlier
  // draft switched on readability and dropped the scope clause on every cluster whose mesh
  // ConfigMap could not be read, hiding a real coverage gap behind a caveat about a different
  // one.
  const scoped = ok([
    {
      metadata: { name: 'ns-only', namespace: 'shop' },
      spec: { accessLogging: [{ providers: [{ name: 'otel-logs' }] }], selector: { matchLabels: { app: 'srv' } } }
    }
  ]);
  const v = accessLogVerdict(scoped, meshProviders(meshConfigMap()));
  assert.match(v.why, /some workloads only/);
  assert.match(v.why, /cannot see these requests/);
});

// ------------------------------------------------- line parsing

test('a JSON access line parses into a request', () => {
  const r = parseAccessLine(accessLine());
  assert.strictEqual(r.code, 503);
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.responseFlags, 'UF');
});

test('Envoy’s positional text format is refused rather than guessed at', () => {
  const r = parseAccessLine('[2026-09-16T14:26:11.264Z] "GET /checkout HTTP/1.1" 503 UF 0 0 12 - "-" "-"');
  assert.strictEqual(r, null);
  // Canary: regexing this into fields produces confident wrong attribution. Counting it as
  // `unparsed` is the honest answer, and the UI says so.
});

test('non-request proxy chatter and malformed JSON are not requests', () => {
  assert.strictEqual(parseAccessLine('2026-09-16 warn envoy config update rejected'), null);
  assert.strictEqual(parseAccessLine('{"response_code":'), null);
  assert.strictEqual(parseAccessLine('{"level":"warn","msg":"xds"}'), null);
});

/**
 * A line labelled the `otel-logs` way: OpenTelemetry semantic conventions, not Envoy's names.
 * Taken from that provider's `logFormat.labels` on a live cluster.
 */
function otelAccessLine(over = {}) {
  return JSON.stringify({
    'client.address': '17.65.195.108',
    'http.request.duration': 12,
    'http.request.header.x-request-id': 'req-otel-1',
    'http.request.method': 'GET',
    'http.response.size': 512,
    'http.response.status_code': 503,
    'mesh.module': 'istio',
    'network.protocol.name': 'HTTP/1.1',
    'server.address': 'shop.example.com',
    'url.path': '/checkout',
    ...over
  });
}

test('an OTel-labelled line parses under the same reader as an Envoy-labelled one', () => {
  const r = parseAccessLine(otelAccessLine());
  assert.strictEqual(r.code, 503);
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.path, '/checkout');
  assert.strictEqual(r.authority, 'shop.example.com');
  assert.strictEqual(r.protocol, 'HTTP/1.1');
  assert.strictEqual(r.duration, 12);
  assert.strictEqual(r.requestId, 'req-otel-1');
  assert.strictEqual(r.downstreamRemote, '17.65.195.108');
  assert.strictEqual(r.bytesSent, 512);
  // Canary: before the dual vocabulary this returned null, every line of a otel-logs-formatted
  // window counted as `linesUnparsed`, and the tab reported zero errors out of a full read.
});

test('OTel splits path and query, and the query is rejoined BEFORE redaction', () => {
  const r = parseAccessLine(otelAccessLine({ 'url.path': '/reset', 'url.query': 'token=abc123&page=2' }));
  // A token in `url.query` must not escape just because it arrived in a different field than
  // `redactUrl` was written for.
  assert.strictEqual(r.path, '/reset?token=REDACTED&page=2');
});

test('an OTel line invents no upstream, because the vocabulary has no equivalent', () => {
  const r = parseAccessLine(otelAccessLine());
  // `response_flags`, `response_code_details` and `upstream_cluster` have no OTel counterpart
  // here. Null renders as "not routed", which is true; reconstructing them from something that
  // merely looks similar would print a real workload's name against the wrong request.
  assert.strictEqual(r.upstreamCluster, undefined);
  assert.strictEqual(r.responseFlags, null);
  assert.strictEqual(r.responseCodeDetails, null);
});

test('Envoy names win over OTel names when a line somehow carries both', () => {
  const r = parseAccessLine(JSON.stringify({ response_code: 500, 'http.response.status_code': 200, method: 'POST', 'http.request.method': 'GET' }));
  assert.strictEqual(r.code, 500);
  assert.strictEqual(r.method, 'POST');
});

test('response_flags of "-" is absent, not the string "-"', () => {
  assert.strictEqual(parseAccessLine(accessLine({ response_flags: '-' })).responseFlags, null);
});

test('user_agent and x_forwarded_for are never carried out of the log line', () => {
  const r = parseAccessLine(accessLine({ user_agent: 'Mozilla/5.0 (iPhone)', x_forwarded_for: '17.65.195.108' }));
  assert.ok(!('userAgent' in r));
  assert.ok(!JSON.stringify(r).includes('iPhone'));
  // These identify a person and their network path, and no question on this tab needs them.
});

// ------------------------------------------------- classification

test('response_code 0 is "no response", not an HTTP error class', () => {
  assert.strictEqual(classOf(0), 'no-response');
  assert.strictEqual(classOf(404), 'client');
  assert.strictEqual(classOf(503), 'server');
  assert.strictEqual(classOf(200), 'ok');
  assert.strictEqual(classOf(304), 'ok');
  // Canary: folding 0 into 5xx inflated the error count by 109 of 400 lines in the live
  // sample that motivated this collector — a connection Envoy never answered is a real
  // finding, but it is not a server error and must not be reported as one.
});

// ------------------------------------------------- redaction

test('a credential-shaped query value is redacted and its key is kept', () => {
  assert.strictEqual(
    redactUrl('/oauth/callback?code=4%2F0AX4abc&state=xyz'),
    '/oauth/callback?code=REDACTED&state=xyz'
  );
  assert.strictEqual(redactUrl('/api?access_token=eyJhbG.abc&page=2'), '/api?access_token=REDACTED&page=2');
  // The key survives because "an OAuth callback failed" is most of why this tab is open.
});

test('a path with no query is untouched, because the route is the finding', () => {
  assert.strictEqual(redactUrl('/v1/orders/8891'), '/v1/orders/8891');
});

test('control characters and terminal escapes are stripped before display', () => {
  const esc = String.fromCharCode(0x1b);
  assert.strictEqual(clean(`/a${esc}[31mb`), '/a[31mb');
  assert.strictEqual(clean(`/a${String.fromCharCode(0x0d)}b`), '/ab');
  assert.strictEqual(clean(`/a${String.fromCodePoint(0x2028)}b`), '/ab');
  assert.strictEqual(clean(`/a${String.fromCodePoint(0x200e)}b`), '/ab');
  // A `path` is attacker-supplied; a raw escape rendered into an operator's terminal is an
  // injection surface, not a cosmetic problem.
});

test('an absurdly long field is capped rather than echoed whole', () => {
  const out = clean('/x'.repeat(5000));
  assert.ok(out.length <= 301, out.length);
});

// ------------------------------------------------- address resolution

test('an IP resolves to the Pod that reports it as its podIP, with the field as evidence', () => {
  const index = buildIndex({
    pods: ok([{ metadata: { name: 'srv-1', namespace: 'shop' }, spec: { nodeName: 'node-a' }, status: { podIP: '100.96.0.180' } }]),
    services: ok([]), endpointslices: ok([]), nodes: ok([]), gateways: ok([])
  });
  const r = resolveAddress(index, '100.96.0.180:8080');
  assert.strictEqual(r.kind, 'Pod');
  assert.strictEqual(r.name, 'srv-1');
  assert.strictEqual(r.port, 8080);
  assert.strictEqual(r.evidence, 'status.podIP');
});

test('an EndpointSlice resolves an address no visible Pod reports', () => {
  const index = buildIndex({
    pods: ok([]),
    services: ok([]),
    endpointslices: ok([
      {
        metadata: { name: 'srv-abc', namespace: 'shop', labels: { 'kubernetes.io/service-name': 'srv' } },
        endpoints: [{ addresses: ['100.96.0.9'], targetRef: { kind: 'Pod', name: 'srv-old', namespace: 'shop' } }]
      }
    ]),
    nodes: ok([]), gateways: ok([])
  });
  const r = resolveAddress(index, '100.96.0.9:8080');
  assert.strictEqual(r.name, 'srv-old');
  assert.strictEqual(r.service, 'srv');
});

test('a headless Service’s clusterIP of "None" is not indexed as an address', () => {
  const index = buildIndex({
    pods: ok([]),
    services: ok([{ metadata: { name: 'h', namespace: 'shop' }, spec: { clusterIP: 'None' } }]),
    endpointslices: ok([]), nodes: ok([]), gateways: ok([])
  });
  assert.strictEqual(index.byIp.has('None'), false);
});

test('a public client IP is "external"; an unmatched cluster IP is "unresolved"', () => {
  assert.strictEqual(resolveAddress(EMPTY_INDEX, '17.65.195.108:0').kind, 'external');
  assert.strictEqual(resolveAddress(EMPTY_INDEX, '100.96.0.7:8080').kind, 'unresolved');
  // Two different answers because they mean different things: a public IP on an ingress
  // gateway is expected, while an in-cluster address matching nothing means the reader is
  // missing a namespace or the Pod is already gone.
});

test('the Gardener pod CIDR counts as private', () => {
  assert.strictEqual(isPrivate('100.96.0.180'), true);
  assert.strictEqual(isPrivate('100.200.0.1'), false);
  assert.strictEqual(isPrivate('10.250.163.33'), true);
  assert.strictEqual(isPrivate('17.65.195.108'), false);
});

test('an IPv6 upstream host splits on the bracketed form', () => {
  const r = resolveAddress(EMPTY_INDEX, '[fd00::1]:8080');
  assert.strictEqual(r.ip, 'fd00::1');
  assert.strictEqual(r.port, 8080);
});

// ------------------------------------------------- upstream cluster

test('upstream_cluster parses to direction, port and FQDN, and matches a Service by FQDN', () => {
  const index = buildIndex({
    pods: ok([]),
    services: ok([{ metadata: { name: 'srv', namespace: 'shop' }, spec: { clusterIP: '10.0.0.5' } }]),
    endpointslices: ok([]), nodes: ok([]), gateways: ok([])
  });
  const u = parseUpstreamCluster('outbound|8080||srv.shop.svc.cluster.local;', index);
  assert.strictEqual(u.direction, 'outbound');
  assert.strictEqual(u.port, 8080);
  assert.strictEqual(u.service.name, 'srv');
  assert.strictEqual(u.service.namespace, 'shop');
});

test('a Service is never matched on a bare name — only on the full FQDN Envoy emitted', () => {
  const index = buildIndex({
    pods: ok([]),
    services: ok([{ metadata: { name: 'srv', namespace: 'other' }, spec: {} }]),
    endpointslices: ok([]), nodes: ok([]), gateways: ok([])
  });
  const u = parseUpstreamCluster('outbound|8080||srv.shop.svc.cluster.local;', index);
  assert.strictEqual(u.service, null);
  // Canary: matching on `srv` alone would attribute shop's failure to other's Service. An
  // edge is never created because names match.
});

test('a non-standard upstream_cluster keeps its raw value instead of inventing fields', () => {
  const u = parseUpstreamCluster('BlackHoleCluster', EMPTY_INDEX);
  assert.strictEqual(u.raw, 'BlackHoleCluster');
  assert.strictEqual(u.fqdn, null);
});

// ------------------------------------------------- gateway matching

test('an authority matches the Gateway whose server host admits it, longest wildcard winning', () => {
  const index = buildIndex({
    pods: ok([]), services: ok([]), endpointslices: ok([]), nodes: ok([]),
    gateways: ok([
      { metadata: { name: 'broad', namespace: 'istio-system' }, spec: { servers: [{ hosts: ['*'], port: { number: 443 } }] } },
      { metadata: { name: 'public-gateway', namespace: 'istio-system' }, spec: { servers: [{ hosts: ['*.example.com'], port: { number: 443 } }] } }
    ])
  });
  assert.strictEqual(matchGateway(index, 'shop.example.com').name, 'public-gateway');
  assert.strictEqual(matchGateway(index, 'other.test').name, 'broad');
  assert.strictEqual(matchGateway(index, ''), null);
});

test('a namespace-qualified host ("./shop.example.com") still matches on the host part', () => {
  const index = buildIndex({
    pods: ok([]), services: ok([]), endpointslices: ok([]), nodes: ok([]),
    gateways: ok([{ metadata: { name: 'g', namespace: 'shop' }, spec: { servers: [{ hosts: ['./shop.example.com'] }] } }])
  });
  assert.strictEqual(matchGateway(index, 'shop.example.com:443').name, 'g');
});

// ------------------------------------------------- proxy selection

test('ingress gateways are read first, and pods without istio-proxy are never read', () => {
  const pods = [
    proxyPod('srv-1', 'shop'),
    proxyPod('istio-ingressgateway-1', 'istio-system'),
    proxyPod('plain-1', 'shop', { proxy: false })
  ];
  const { selected, candidates } = selectProxies(pods, { maxPods: 10 });
  assert.strictEqual(candidates, 2);
  assert.strictEqual(selected[0].metadata.name, 'istio-ingressgateway-1');
  // The gateway is the only proxy that sees north-south traffic, so the 502 a user reported
  // is there and nowhere else.
});

test('a native sidecar (istio-proxy as an init container) is a readable proxy', () => {
  const pod = {
    metadata: { name: 'srv-1', namespace: 'shop' },
    spec: { containers: [{ name: 'app' }], initContainers: [{ name: 'istio-proxy', restartPolicy: 'Always' }] },
    status: { phase: 'Running', containerStatuses: [] }
  };
  assert.strictEqual(selectProxies([pod], { maxPods: 10 }).candidates, 1);
  // Canary: checking `spec.containers` alone found 3 proxies on a live cluster, which runs 38 —
  // 35 pods are native-sidecar and every one was invisible to this tab.
});

test('a non-Running pod has no readable log and is not asked for one', () => {
  const { candidates } = selectProxies([proxyPod('p', 'shop', { phase: 'Pending' })], { maxPods: 10 });
  assert.strictEqual(candidates, 0);
});

test('over the pod budget, the excess is counted rather than silently dropped', () => {
  const pods = Array.from({ length: 7 }, (_, i) => proxyPod(`srv-${i}`, 'shop'));
  const { selected, skipped } = selectProxies(pods, { maxPods: 3 });
  assert.strictEqual(selected.length, 3);
  assert.strictEqual(skipped, 4);
});

test('selection is deterministic, so two reads of the same cluster sample the same proxies', () => {
  const pods = [proxyPod('b', 'shop'), proxyPod('a', 'shop'), proxyPod('c', 'app')];
  const first = selectProxies(pods, { maxPods: 2 }).selected.map(p => p.metadata.name);
  const second = selectProxies([...pods].reverse(), { maxPods: 2 }).selected.map(p => p.metadata.name);
  assert.deepStrictEqual(first, second);
});

test('a namespace filter restricts which proxies are read', () => {
  const pods = [proxyPod('a', 'shop'), proxyPod('b', 'app')];
  const { candidates } = selectProxies(pods, { namespace: 'app', maxPods: 10 });
  assert.strictEqual(candidates, 1);
});

// ------------------------------------------------- aggregation

test('identical failures collapse into one counted group with its proxies and sources', () => {
  const reqs = [
    { ...parseAccessLine(accessLine()), proxy: { pod: 'gw-1', namespace: 'istio-system' } },
    { ...parseAccessLine(accessLine({ request_id: 'req-2', duration: 30 })), proxy: { pod: 'gw-2', namespace: 'istio-system' } }
  ];
  const [g] = aggregate(reqs, EMPTY_INDEX);
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.proxies.length, 2);
  assert.strictEqual(g.p50Ms, 21);
  assert.deepStrictEqual(g.samples, ['req-1', 'req-2']);
});

test('a different path is a different group, so one 500 is not hidden inside another', () => {
  const reqs = [accessLine(), accessLine({ path: '/cart' })].map(l => ({
    ...parseAccessLine(l),
    proxy: { pod: 'gw', namespace: 'istio-system' }
  }));
  assert.strictEqual(aggregate(reqs, EMPTY_INDEX).length, 2);
});

test('server errors sort above client errors above no-response, whatever the volume', () => {
  const reqs = [
    ...Array.from({ length: 50 }, (_, i) => accessLine({ response_code: 404, path: `/scan${i % 2}`, request_id: `c${i}` })),
    accessLine({ response_code: 500, path: '/pay' }),
    ...Array.from({ length: 20 }, (_, i) => accessLine({ response_code: 0, path: '/x', request_id: `z${i}` }))
  ].map(l => ({ ...parseAccessLine(l), proxy: { pod: 'gw', namespace: 'istio-system' } }));
  const groups = aggregate(reqs, EMPTY_INDEX);
  assert.strictEqual(groups[0].code, 500);
  assert.strictEqual(groups[groups.length - 1].class, 'no-response');
  // A single 503 on the payment route is a bigger finding than fifty 404s from a scanner;
  // sorting purely by count buries it.
});

test('a group carries at most a handful of request ids, not every one', () => {
  const reqs = Array.from({ length: 40 }, (_, i) =>
    ({ ...parseAccessLine(accessLine({ request_id: `r${i}` })), proxy: { pod: 'gw', namespace: 'x' } }));
  assert.strictEqual(aggregate(reqs, EMPTY_INDEX)[0].samples.length, 3);
});

// ------------------------------------------------- collect

function fakeList(map) {
  return async ({ path }) => {
    for (const key of Object.keys(map)) if (path.includes(key)) return map[key];
    return [];
  };
}

const CLUSTER = { id: 'c1', displayName: 'C One', env: 'sbx' };

test('collect reports errors, the window it read, and the access-log verdict', async () => {
  const listFn = fakeList({
    telemetries: [
      {
        metadata: { name: 'telemetry-config', namespace: 'istio-system' },
        spec: { accessLogging: [{ providers: [{ name: 'stdout-json' }] }] }
      }
    ],
    '/api/v1/pods': [proxyPod('istio-ingressgateway-1', 'istio-system')],
    '/api/v1/services': [{ metadata: { name: 'srv', namespace: 'shop' }, spec: { clusterIP: '10.0.0.5' } }]
  });
  const textFn = async () => [accessLine(), accessLine({ response_code: 200, request_id: 'r-ok' }), 'envoy warn noise'].join('\n');

  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });

  assert.strictEqual(out.accessLog.state, 'on');
  assert.strictEqual(out.summary.requests, 2);
  assert.strictEqual(out.summary.errors, 1);
  assert.strictEqual(out.summary.server, 1);
  assert.strictEqual(out.window.linesUnparsed, 1);
  assert.strictEqual(out.window.proxiesRead, 1);
  assert.strictEqual(out.errors[0].upstream.service.name, 'srv');
  assert.ok(out.collectedAt);
});

test('a forbidden pod log names the proxy it could not read, and is not counted as zero errors', async () => {
  const listFn = fakeList({ '/api/v1/pods': [proxyPod('gw-1', 'istio-system')] });
  const err = Object.assign(new Error('forbidden'), { status: 403 });
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn: async () => { throw err; } });

  assert.strictEqual(out.window.proxiesRead, 0);
  assert.deepStrictEqual(out.window.proxiesFailed.map(p => p.reason), ['FORBIDDEN']);
  // Canary: swallowing this would render "no traffic errors" from a read that never happened.
});

test('one unreadable proxy does not lose the others', async () => {
  const listFn = fakeList({ '/api/v1/pods': [proxyPod('gw-1', 'istio-system'), proxyPod('gw-2', 'istio-system')] });
  let call = 0;
  const textFn = async () => {
    call += 1;
    if (call === 1) throw new Error('boom');
    return accessLine({ response_code: 502 });
  };
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });
  assert.strictEqual(out.window.proxiesRead, 1);
  assert.strictEqual(out.window.proxiesFailed.length, 1);
  assert.strictEqual(out.summary.errors, 1);
});

test('a full tail is reported as truncated, so the window is not read as complete', async () => {
  const listFn = fakeList({ '/api/v1/pods': [proxyPod('gw-1', 'istio-system')] });
  const textFn = async () => Array.from({ length: 5 }, (_, i) => accessLine({ request_id: `r${i}` })).join('\n');
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn, tailLines: 5 });
  assert.strictEqual(out.window.truncatedProxies, 1);
  assert.strictEqual(out.window.tailLines, 5);
});

/*
  The canary for the whole otel-logs change, at the level an operator actually experiences it.

  Before this, a mesh switched to `otel-logs` produced: accessLog.state "on", ten proxies read,
  three thousand lines, zero requests parsed, and a page reporting "0 server errors" with "No
  4xx, 5xx or unanswered connection in the window that was read". Every number true, the
  conclusion false. The tab must instead refuse to read, say so in `window`, and explain why.
*/
test('a mesh logging only to otel-logs reads no proxy and says so, instead of reporting zero errors', async () => {
  const listFn = fakeList({
    telemetries: telemetryUsing('otel-logs').items,
    '/configmaps': meshConfigMap().items,
    '/api/v1/pods': Array.from({ length: 12 }, (_, i) => proxyPod(`srv-${i}`, 'shop'))
  });
  let reads = 0;
  const textFn = async () => { reads += 1; return ''; };

  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });

  assert.strictEqual(reads, 0, 'no pod log should be read when nothing writes to stdout');
  assert.strictEqual(out.window.readsSkipped, true);
  assert.strictEqual(out.window.proxiesRead, 0);
  assert.strictEqual(out.window.linesRead, 0);
  assert.strictEqual(out.accessLog.readable, false);
  // The candidates are still counted, so the UI can say how many proxies exist but went unread.
  assert.ok(out.window.proxyCandidates >= 12);
  assert.match(out.accessLog.why, /not a statement that nothing is failing/);
});

test('an unreadable mesh config never skips the read — an unknown is not a proof', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('/configmaps')) throw Object.assign(new Error('nope'), { status: 403 });
    if (path.includes('telemetries')) return telemetryUsing('otel-logs').items;
    if (path.includes('/api/v1/pods')) return [proxyPod('gw-1', 'istio-system')];
    return [];
  };
  let reads = 0;
  const textFn = async () => { reads += 1; return accessLine(); };

  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });

  assert.strictEqual(reads, 1, 'a 403 on the mesh config must not be read as "nothing to read"');
  assert.strictEqual(out.window.readsSkipped, false);
  assert.strictEqual(out.accessLog.readable, null);
  assert.strictEqual(out.accessLog.meshUnavailable, true);
  assert.ok(out.summary.unavailable.includes('istio-mesh-config'));
});

test('access logging "off" still reads, because meshConfig.accessLogFile needs no Telemetry CR', async () => {
  const listFn = fakeList({ '/api/v1/pods': [proxyPod('gw-1', 'istio-system')] });
  let reads = 0;
  const textFn = async () => { reads += 1; return accessLine(); };

  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });

  // "No Telemetry CR enables it" is evidence about the CRs, not about the proxies. Skipping here
  // would hide every request on a mesh configured the older, CR-less way.
  assert.strictEqual(out.accessLog.state, 'off');
  assert.strictEqual(reads, 1);
  assert.strictEqual(out.window.readsSkipped, false);
  assert.strictEqual(out.summary.errors, 1);
});

test('the pod and line budgets are clamped, so no query string can widen the read', async () => {
  const listFn = fakeList({
    '/api/v1/pods': Array.from({ length: 40 }, (_, i) => proxyPod(`srv-${i}`, 'shop'))
  });
  let reads = 0;
  const textFn = async ({ path }) => {
    reads += 1;
    assert.ok(path.includes(`tailLines=${MAX_TAIL_LINES}`), path);
    assert.ok(path.includes('limitBytes='), path);
    assert.ok(path.includes('container=istio-proxy'), path);
    return '';
  };
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn, maxPods: 999, tailLines: 99999 });
  assert.strictEqual(reads, MAX_PODS);
  assert.strictEqual(out.window.proxiesSkipped, 40 - MAX_PODS);
  // Canary: an unclamped ?maxPods would let one page view open forty log streams.
});

test('access logging off still reports the verdict rather than an empty success', async () => {
  const listFn = fakeList({ '/api/v1/pods': [proxyPod('gw-1', 'istio-system')] });
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn: async () => '' });
  assert.strictEqual(out.accessLog.state, 'off');
  assert.strictEqual(out.summary.errors, 0);
});

test('unreadable side reads land in summary.unavailable instead of degrading silently', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('endpointslices')) throw Object.assign(new Error('nope'), { status: 403 });
    if (path.includes('/api/v1/pods')) return [proxyPod('gw-1', 'istio-system')];
    return [];
  };
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn: async () => '' });
  assert.ok(out.summary.unavailable.includes('endpointslices'), JSON.stringify(out.summary.unavailable));
});

test('no raw log line ever reaches the response', async () => {
  const listFn = fakeList({ '/api/v1/pods': [proxyPod('gw-1', 'istio-system')] });
  const textFn = async () =>
    accessLine({ user_agent: 'SECRET-AGENT', path: '/cb?token=SECRET-TOKEN', x_forwarded_for: '9.9.9.9' });
  const out = await collect({ cluster: CLUSTER, token: 't', listFn, textFn });
  const body = JSON.stringify(out);
  assert.ok(!body.includes('SECRET-AGENT'));
  assert.ok(!body.includes('SECRET-TOKEN'));
  assert.ok(!body.includes('9.9.9.9'));
  assert.ok(body.includes('token=REDACTED'));
});

// ------------------------------------------- defects found by review, pinned

test('an empty OTel field is not minted into a fabricated response_code 0', () => {
  // `pick` guarded only the Envoy name and returned the OTel fallback unchecked, so
  // `Number('')` === 0 === the `no-response` class. Junk became a "connection Envoy never
  // answered" finding, in the exact class an operator opens this tab to triage — while the
  // identical line spelled `response_code: ""` was correctly discarded. Two vocabularies must
  // never disagree about the same input.
  for (const bad of ['', null]) {
    assert.strictEqual(
      parseAccessLine(JSON.stringify({ 'http.response.status_code': bad, 'url.path': '/a' })),
      null,
      `an OTel status of ${JSON.stringify(bad)} must not parse`
    );
    assert.strictEqual(parseAccessLine(JSON.stringify({ response_code: bad })), null);
  }
  // A genuine 0 still parses — it is the no-response class, and the whole point of the guard is
  // that it must not be manufactured, not that it must be rejected.
  assert.strictEqual(parseAccessLine(otelAccessLine({ 'http.response.status_code': 0 })).code, 0);
});

test('an empty OTel duration or size does not become a measured zero', () => {
  const r = parseAccessLine(
    JSON.stringify({ 'http.response.status_code': 503, 'url.path': '/a', 'http.request.duration': '', 'http.response.size': '' })
  );
  assert.strictEqual(r.duration, null);
  assert.strictEqual(r.bytesSent, null);
});

test('a non-array extensionProviders degrades instead of throwing the whole tab away', () => {
  // `for...of` over a truthy non-iterable raised a TypeError from outside the parse try, so it
  // escaped meshProviders -> collect -> the route, losing the pod and service reads that had
  // already succeeded. Every other failure in this module degrades; this one aborted.
  for (const shape of ['extensionProviders: {}', 'extensionProviders: 7', 'extensionProviders: a string']) {
    const mesh = meshProviders(meshConfigMap(shape));
    assert.deepStrictEqual(Object.keys(mesh.byName), [], shape);
    assert.strictEqual(mesh.unavailable, false, `${shape} is malformed data, not an outage`);
  }
});

test('a provider named after an Object prototype member does not resolve to one', () => {
  const mesh = meshProviders(meshConfigMap());
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(mesh.byName[key], undefined, `${key} must not resolve`);
  }
  // And the verdict treats it as unresolved rather than as a resolved entry with no readability.
  const v = accessLogVerdict(telemetryUsing('constructor'), mesh);
  assert.deepStrictEqual(v.unresolvedProviders, ['constructor']);
  assert.strictEqual(v.readable, null);
});

test('an unreadable mesh config is not reported as the provider being undeclared', () => {
  // Every provider lands in `unresolvedProviders` when the ConfigMap could not be read, so the
  // old wording claimed "otel-logs is not declared in the mesh config" — a statement about a
  // file nobody opened, printed directly above the UI's own "could not be read" note.
  const v = accessLogVerdict(telemetryUsing('otel-logs'), meshProviders(gone('FORBIDDEN')));
  assert.strictEqual(v.readable, null);
  assert.match(v.why, /could not be read/);
  assert.doesNotMatch(v.why, /not declared in the mesh config/);
  // The honest cause is still reachable when the config WAS read and genuinely lacks the entry.
  const declared = accessLogVerdict(telemetryUsing('ghost'), meshProviders(meshConfigMap()));
  assert.match(declared.why, /not declared in the mesh config/);
});

test('a tracing provider named under accessLogging records nothing, and is not said to record elsewhere', () => {
  // `otel-traces` classifies as `not-access-log` with a null destination, so the verdict was
  // `readable: false` and the UI told the operator their requests were being recorded and
  // pointed them at an em-dash. Nothing is recorded here or anywhere else.
  const v = accessLogVerdict(telemetryUsing('otel-traces'), meshProviders(meshConfigMap()));
  assert.strictEqual(v.readable, false);
  assert.strictEqual(v.recordedElsewhere, false);
  assert.match(v.why, /not for access logging/);
  assert.doesNotMatch(v.why, /Query the destination/);

  // A real off-pod sink still is recorded elsewhere, and still says so.
  const otlp = accessLogVerdict(telemetryUsing('otel-logs'), meshProviders(meshConfigMap()));
  assert.strictEqual(otlp.recordedElsewhere, true);
  assert.match(otlp.why, /Query the destination/);
});

test('recordedElsewhere is false whenever nothing was written at all', () => {
  assert.strictEqual(accessLogVerdict(ok([])).recordedElsewhere, false);
  assert.strictEqual(accessLogVerdict(gone('FORBIDDEN')).recordedElsewhere, false);
});
