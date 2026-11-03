
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _traces from '../collectors/traces.js';
import _trafficModule from '../collectors/traffic.js';
const {
  collect,
  pickTrace,
  parseTraceparent,
  correlatorsOf,
  correlationCoverage,
  stitch,
  pollOf,
  namespacesOf
} = _traces;

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** One Envoy `stdout-json` access-log line, with only the fields these tests turn on. */
function line({
  code = 200,
  method = 'GET',
  path = '/api/orders',
  authority = 'shop.example.com',
  start = '2026-09-21T10:00:00.000Z',
  duration = 120,
  upstreamServiceTime = '100',
  flags,
  traceparent,
  b3Trace,
  b3Span,
  requestId = 'req-1',
  downstream = '10.42.0.9:38210',
  upstreamHost = '10.42.0.21:8080',
  upstreamCluster = 'outbound|8080||orders.shop.svc.cluster.local'
} = {}) {
  const d = {
    response_code: code,
    method,
    path,
    authority,
    protocol: 'HTTP/1.1',
    start_time: start,
    duration,
    upstream_service_time: upstreamServiceTime,
    response_flags: flags || '-',
    request_id: requestId,
    downstream_remote_address: downstream,
    downstream_local_address: '10.42.0.21:8080',
    upstream_host: upstreamHost,
    upstream_cluster: upstreamCluster
  };
  if (traceparent) d.traceparent = traceparent;
  if (b3Trace) d.x_b3_traceid = b3Trace;
  if (b3Span) d.x_b3_spanid = b3Span;
  return JSON.stringify(d);
}

function tp(spanId, sampled = true) {
  return `00-${TRACE_ID}-${spanId}-0${sampled ? '1' : '0'}`;
}

function pod({ name, namespace = 'shop', ip, ingress = false }) {
  return {
    metadata: {
      name,
      namespace,
      labels: ingress ? { app: 'istio-ingressgateway' } : {}
    },
    spec: { containers: [{ name: 'app' }, { name: 'istio-proxy' }] },
    status: { phase: 'Running', podIP: ip }
  };
}

function service({ name, namespace = 'shop' }) {
  return { metadata: { name, namespace }, spec: { clusterIP: '10.43.0.10' } };
}

const EMPTY = { unavailable: false, truncated: false, items: [] };

function indexFrom({ pods = [], services = [] } = {}) {
  const { buildIndex } = _trafficModule;
  return buildIndex({
    pods: { ...EMPTY, items: pods },
    services: { ...EMPTY, items: services },
    endpointslices: EMPTY,
    nodes: EMPTY,
    gateways: EMPTY
  });
}

/** `readProxyLogs` calls `textFn` once per pod; this answers each by pod name. */
function fakeTextFn(byPod) {
  return async ({ path }) => {
    for (const [name, body] of Object.entries(byPod)) {
      if (path.includes(`/pods/${name}/log`)) return body;
    }
    throw Object.assign(new Error(`no log stub for ${path}`), { status: 404 });
  };
}

function fakeListFn(byPath) {
  return async ({ path }) => {
    for (const [match, result] of byPath) {
      if (path.startsWith(match)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw Object.assign(new Error(`unexpected path: ${path}`), { status: 404 });
  };
}

// --- the correlator, which is the whole feature ----------------------------------------------

test('parseTraceparent reads a W3C header and refuses everything that is not one', () => {
  const ok = parseTraceparent(tp('00f067aa0ba902b7'));
  assert.equal(ok.traceId, TRACE_ID);
  assert.equal(ok.spanId, '00f067aa0ba902b7');
  assert.equal(ok.sampled, true);
  assert.equal(parseTraceparent(tp('00f067aa0ba902b7', false)).sampled, false, 'the low flag bit is `sampled`');

  assert.equal(parseTraceparent(undefined), null);
  assert.equal(parseTraceparent('-'), null, 'Envoy writes a bare dash for an unset header');
  assert.equal(parseTraceparent('00-tooshort-00f067aa0ba902b7-01'), null);
  assert.equal(parseTraceparent(`${TRACE_ID}`), null, 'a bare id is not a traceparent');
  assert.equal(
    parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    null,
    'an all-zero trace id means "no trace" — grouping on it would stitch unrelated journeys'
  );
});

test('correlatorsOf offers traceparent, b3 and request-id, and rejects a malformed b3 id', () => {
  const { parseAccessLine } = _trafficModule;
  const all = correlatorsOf(parseAccessLine(line({ traceparent: tp('aaaaaaaaaaaaaaaa'), b3Trace: TRACE_ID, b3Span: 'bbbbbbbbbbbbbbbb' })));
  assert.equal(all.traceparent.spanId, 'aaaaaaaaaaaaaaaa');
  assert.equal(all.b3.traceId, TRACE_ID);
  assert.equal(all.requestId.traceId, 'req-1');

  const bad = correlatorsOf(parseAccessLine(line({ b3Trace: 'not-hex' })));
  assert.equal(bad.b3, null);
  assert.equal(bad.traceparent, null);
  assert.equal(bad.requestId.traceId, 'req-1', 'x-request-id still correlates it');
});

test('a log format carrying no traceparent is a CONFIGURATION finding, not an empty result', () => {
  const { parseAccessLine } = _trafficModule;
  const records = [line(), line({ requestId: 'req-2' })].map(parseAccessLine);
  const c = correlationCoverage(records);

  assert.equal(c.source, 'request-id');
  assert.equal(c.traceparentLines, 0);
  assert.equal(c.requestIdLines, 2);
  assert.equal(c.traceparentAbsent, true, 'Kyma stock stdout-json does not log traceparent — the tab must say so');
  assert.equal(c.nestingInferred, true, 'without a span id, hop nesting is inferred from duration');

  // And the opposite: a mesh that does log it must not be told it does not.
  const traced = [line({ traceparent: tp('aaaaaaaaaaaaaaaa') }), line({ traceparent: tp('bbbbbbbbbbbbbbbb') })].map(parseAccessLine);
  const t = correlationCoverage(traced);
  assert.equal(t.source, 'traceparent');
  assert.equal(t.traceparentAbsent, false);
  assert.equal(t.nestingInferred, false);
});

test('one client sending its own traceparent does not switch a window off request-id', () => {
  const { parseAccessLine } = _trafficModule;
  const records = [
    line({ traceparent: tp('aaaaaaaaaaaaaaaa') }),
    line({ requestId: 'req-2' }),
    line({ requestId: 'req-3' }),
    line({ requestId: 'req-4' })
  ].map(parseAccessLine);
  const c = correlationCoverage(records);
  assert.equal(c.traceparentLines, 1);
  assert.equal(c.source, 'request-id', 'a majority rule, not mere presence');
});

// --- stitching -------------------------------------------------------------------------------

/** Ingress → approuter → backend, as three proxies would log one journey. */
function threeHopWindow({ correlator = 'request-id', backendCode = 200, backendFlags } = {}) {
  const useTp = correlator === 'traceparent';
  const common = { requestId: 'req-abc' };
  return [
    {
      ...common,
      start: '2026-09-21T10:00:00.000Z',
      duration: 300,
      upstreamServiceTime: '280',
      downstream: '203.0.113.7:51000',
      upstreamHost: '10.42.0.11:8080',
      upstreamCluster: 'outbound|8080||approuter.shop.svc.cluster.local',
      path: '/api/orders',
      ...(useTp ? { traceparent: tp('1111111111111111') } : {})
    },
    {
      ...common,
      start: '2026-09-21T10:00:00.010Z',
      duration: 260,
      upstreamServiceTime: '240',
      downstream: '10.42.0.5:44000',
      upstreamHost: '10.42.0.12:8080',
      upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local',
      path: '/api/orders',
      ...(useTp ? { traceparent: tp('2222222222222222') } : {})
    },
    {
      ...common,
      start: '2026-09-21T10:00:00.020Z',
      duration: 200,
      upstreamServiceTime: '190',
      downstream: '10.42.0.11:44100',
      upstreamHost: '10.42.0.30:5432',
      upstreamCluster: 'outbound|5432||db.shop.svc.cluster.local',
      path: '/api/orders',
      code: backendCode,
      flags: backendFlags,
      ...(useTp ? { traceparent: tp('3333333333333333') } : {})
    }
  ].map(o => line(o));
}

function stitchWindow(lines, { source = 'request-id', ingress = [] } = {}) {
  const { parseAccessLine } = _trafficModule;
  const proxies = ['istio-ingressgateway-1', 'approuter-1', 'srv-1'];
  const records = lines.map((l, i) => ({
    ...parseAccessLine(l),
    proxy: { pod: proxies[i] || `p${i}`, namespace: i === 0 ? 'istio-system' : 'shop', container: 'istio-proxy' }
  }));
  const index = indexFrom({
    pods: [
      pod({ name: 'approuter-1', ip: '10.42.0.11' }),
      pod({ name: 'srv-1', ip: '10.42.0.12' }),
      pod({ name: 'istio-ingressgateway-1', namespace: 'istio-system', ip: '10.42.0.5', ingress: true })
    ],
    services: [service({ name: 'orders' })]
  });
  return stitch(records, index, { ingressKeys: new Set(ingress), source });
}

test('three hops on one request id become one ordered trace', () => {
  const { traces } = stitchWindow(threeHopWindow(), { ingress: ['istio-system/istio-ingressgateway-1'] });
  assert.equal(traces.length, 1);
  const t = traces[0];

  assert.equal(t.hopCount, 3);
  assert.equal(t.correlatedBy, 'request-id');
  assert.equal(t.requestId, 'req-abc');
  assert.equal(t.traceId, 'req-abc', 'with no traceparent the request id IS the trace id');
  assert.deepEqual(t.hops.map(h => h.seq), [1, 2, 3]);
  assert.deepEqual(t.hops.map(h => h.durationMs), [300, 260, 200], 'outermost caller first');
  assert.deepEqual(t.hops.map(h => h.offsetMs), [0, 10, 20], 'offsets are relative to the trace start');

  // The client-visible status comes from the ingress hop, and the entry hop is identified as such.
  assert.equal(t.entryRole, 'ingress');
  assert.equal(t.finalStatus, 200);
  assert.equal(t.hasError, false);
  assert.equal(t.errorHop, null);
  assert.equal(t.totalDurationMs, 300);
});

test('transit time is the nesting gap, and the hops name real workloads', () => {
  const { traces } = stitchWindow(threeHopWindow(), { ingress: ['istio-system/istio-ingressgateway-1'] });
  const [first, second, third] = traces[0].hops;

  // 300 - 260 and 260 - 200: the time that went into the network and the proxies, not the app.
  assert.equal(first.transitMs, 40);
  assert.equal(second.transitMs, 60);
  assert.equal(third.transitMs, null, 'the last hop has no callee to subtract');

  // duration - upstream_service_time, per hop.
  assert.equal(first.proxyOverheadMs, 20);
  assert.equal(third.proxyOverheadMs, 10);

  assert.equal(first.from.kind, 'external', 'a public client IP on the gateway is expected, not unresolved');
  assert.equal(first.to.name, 'approuter-1');
  assert.equal(first.to.kind, 'Pod');
  assert.equal(second.to.name, 'srv-1');
  assert.equal(third.to.kind, 'unresolved', 'the database has no Pod or Service in this read');
  assert.equal(third.to.fqdn, 'db.shop.svc.cluster.local', 'and Envoy still named where it went');
});

test('a failing hop is named, with its Envoy flag decoded, and the client status stays separate', () => {
  const { traces } = stitchWindow(threeHopWindow({ backendCode: 504, backendFlags: 'UT' }), {
    ingress: ['istio-system/istio-ingressgateway-1']
  });
  const t = traces[0];

  assert.equal(t.hasError, true);
  assert.equal(t.errorHop, 3, 'the third hop is where it went wrong');
  assert.equal(t.worstStatus, 504);
  assert.equal(t.finalStatus, 200, 'what the client saw is a different fact from the worst hop');
  assert.deepEqual(t.flags, ['UT']);

  const failing = t.hops[2];
  assert.equal(failing.codeClass, 'server');
  assert.equal(failing.flagDetails[0].flag, 'UT');
  assert.equal(failing.flagDetails[0].name, 'UpstreamRequestTimeout');
  assert.match(failing.flagDetails[0].meaning, /did not answer in time/);
});

test('a callee reporting a longer duration than its caller yields null transit, never a negative', () => {
  const lines = [
    line({ requestId: 'skew', start: '2026-09-21T10:00:00.000Z', duration: 100 }),
    line({ requestId: 'skew', start: '2026-09-21T10:00:00.005Z', duration: 400 })
  ];
  const { traces } = stitchWindow(lines);
  const t = traces[0];
  assert.equal(t.nestingAnomaly, true, 'clock skew between nodes, or two requests sharing an id');
  assert.equal(t.hops[0].transitMs, null, 'a negative remainder is an artefact, not a measurement');
});

test('hops sharing a start millisecond are ordered by duration, longest first', () => {
  const lines = [
    line({ requestId: 'tie', start: '2026-09-21T10:00:00.000Z', duration: 90 }),
    line({ requestId: 'tie', start: '2026-09-21T10:00:00.000Z', duration: 250 })
  ];
  const { traces } = stitchWindow(lines);
  assert.deepEqual(traces[0].hops.map(h => h.durationMs), [250, 90], 'of two hops in one ms, the longer contains the other');
  assert.equal(traces[0].hops[0].transitMs, 160);
});

test('the client-visible status comes from the INGRESS hop even when it is not the first one', () => {
  /*
    Under clock skew between nodes the gateway's line can sort after the sidecar's. Taking hops[0]
    as the entry then reports an internal hop's status as the one the client received — a 200 from a
    sidecar standing in for the 502 the browser actually got, which is the single most misleading
    thing this tab could say.
  */
  const lines = [
    line({ requestId: 'skewed', start: '2026-09-21T10:00:00.000Z', duration: 100, code: 200 }),
    line({ requestId: 'skewed', start: '2026-09-21T10:00:00.005Z', duration: 400, code: 502, flags: 'UF' })
  ];
  const { parseAccessLine } = _trafficModule;
  // The SECOND record is the gateway's, so ordering by start time puts the sidecar first.
  const records = [
    { ...parseAccessLine(lines[0]), proxy: { pod: 'srv-1', namespace: 'shop', container: 'istio-proxy' } },
    { ...parseAccessLine(lines[1]), proxy: { pod: 'istio-ingressgateway-1', namespace: 'istio-system', container: 'istio-proxy' } }
  ];
  const out = stitch(records, indexFrom(), {
    ingressKeys: new Set(['istio-system/istio-ingressgateway-1']),
    source: 'request-id'
  });
  const t = out.traces[0];

  assert.equal(t.hops[0].role, 'sidecar', 'the sidecar sorted first');
  assert.equal(t.entryRole, 'ingress');
  assert.equal(t.finalStatus, 502, 'what the client saw, from the edge — not hops[0].code');
  assert.equal(t.totalDurationMs, 400, 'and the end-to-end duration is the edge hop\u2019s');
});

test('traceparent stitching keeps the span ids and says it was not inferred', () => {
  const { traces } = stitchWindow(threeHopWindow({ correlator: 'traceparent' }), {
    source: 'traceparent',
    ingress: ['istio-system/istio-ingressgateway-1']
  });
  const t = traces[0];
  assert.equal(t.traceId, TRACE_ID);
  assert.equal(t.correlatedBy, 'traceparent');
  assert.deepEqual(t.hops.map(h => h.spanId), ['1111111111111111', '2222222222222222', '3333333333333333']);
});

test('two unrelated requests stay two traces', () => {
  const { traces, tracesFound } = stitchWindow([
    line({ requestId: 'a', path: '/one' }),
    line({ requestId: 'b', path: '/two' })
  ]);
  assert.equal(tracesFound, 2);
  assert.deepEqual(traces.map(t => t.traceId).sort(), ['a', 'b']);
  assert.deepEqual(traces.map(t => t.hopCount), [1, 1]);
});

test('a line with no correlator at all is counted, not silently dropped', () => {
  const { parseAccessLine } = _trafficModule;
  const raw = JSON.parse(line());
  delete raw.request_id;
  const records = [{ ...parseAccessLine(JSON.stringify(raw)), proxy: { pod: 'p', namespace: 'n', container: 'istio-proxy' } }];
  const out = stitch(records, indexFrom(), { ingressKeys: new Set(), source: 'request-id' });
  assert.equal(out.traces.length, 0);
  assert.equal(out.uncorrelated, 1, 'a dropped line must show up somewhere an operator can see it');
});

test('a proxy answering nothing routable still produces a hop that says "not routed"', () => {
  const l = JSON.parse(line({ code: 404, flags: 'NR' }));
  delete l.upstream_host;
  delete l.upstream_cluster;
  const { traces } = stitchWindow([JSON.stringify(l)]);
  const hop = traces[0].hops[0];
  assert.equal(hop.to, null, 'no upstream is a finding — a 403 or NR never reached a workload');
  assert.equal(hop.flagDetails[0].name, 'NoRouteFound');
});

// --- the query redaction the path shares with the Traffic tab --------------------------------

test('a token in the query string never reaches a trace', () => {
  const { traces } = stitchWindow([line({ path: '/reset?token=abc123&page=2', requestId: 'secret' })]);
  const t = traces[0];
  assert.ok(!JSON.stringify(t).includes('abc123'), 'redactUrl runs on the way in, for traces as for errors');
  assert.match(t.path, /page=2/, 'and the non-secret parameters survive');
});

// --- collect(), end to end ------------------------------------------------------------------

function collectStubs({ podLogs, pods }) {
  return {
    listFn: fakeListFn([
      ['/apis/telemetry.istio.io', []],
      ['/api/v1/pods', pods],
      ['/api/v1/services', [service({ name: 'orders' })]],
      ['/apis/discovery.k8s.io', []],
      ['/api/v1/nodes', []],
      ['/apis/networking.istio.io', []],
      ['/api/v1/namespaces/istio-system/configmaps', []]
    ]),
    textFn: fakeTextFn(podLogs)
  };
}

const THREE_PODS = [
  pod({ name: 'istio-ingressgateway-1', namespace: 'istio-system', ip: '10.42.0.5', ingress: true }),
  pod({ name: 'approuter-1', ip: '10.42.0.11' }),
  pod({ name: 'srv-1', ip: '10.42.0.12' })
];

test('collect(): one journey logged by three proxies arrives as one trace with three hops', async () => {
  const [gw, ap, srv] = threeHopWindow();
  const { listFn, textFn } = collectStubs({
    pods: THREE_PODS,
    podLogs: { 'istio-ingressgateway-1': gw, 'approuter-1': ap, 'srv-1': srv }
  });

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  assert.equal(out.summary.traces, 1);
  assert.equal(out.summary.multiHop, 1);
  assert.equal(out.summary.hops, 3);
  assert.equal(out.window.proxiesRead, 3);
  assert.equal(out.window.requestsParsed, 3);
  assert.equal(out.correlation.source, 'request-id');
  assert.equal(out.correlation.traceparentAbsent, true);

  const t = out.traces[0];
  assert.equal(t.hopCount, 3);
  assert.equal(t.entryRole, 'ingress', 'the gateway pod was recognised as the edge');
  assert.deepEqual(
    t.hops.map(h => `${h.observedBy.namespace}/${h.observedBy.pod}`),
    ['istio-system/istio-ingressgateway-1', 'shop/approuter-1', 'shop/srv-1'],
    'every hop names the proxy that reported it'
  );
  assert.deepEqual(t.hops.map(h => h.role), ['ingress', 'sidecar', 'sidecar']);
});

test('collect(): summary.readAt is a parseable timestamp taken just now', async () => {
  const [gw, ap, srv] = threeHopWindow();
  const { listFn, textFn } = collectStubs({
    pods: THREE_PODS,
    podLogs: { 'istio-ingressgateway-1': gw, 'approuter-1': ap, 'srv-1': srv }
  });

  const before = Date.now();
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });
  const after = Date.now();

  const readAtMs = Date.parse(out.summary.readAt);
  assert.ok(Number.isFinite(readAtMs), `readAt must parse as a timestamp, got ${out.summary.readAt}`);
  assert.ok(readAtMs >= before - 1000 && readAtMs <= after + 1000, 'readAt should be within a few seconds of now');
});

test('collect(): every map edge lists the journeys that crossed it', async () => {
  const { listFn, textFn } = collectStubs({
    pods: [THREE_PODS[0]],
    podLogs: { 'istio-ingressgateway-1': line() }
  });
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });
  const edge = out.serviceMap.edges.find(e => out.serviceMap.nodes.find(n => n.id === e.to).name === 'orders');
  assert.ok(edge, 'the gateway → orders edge was built');
  assert.deepEqual(edge.traceIds, [out.traces[0].traceId]);
  assert.equal(edge.traceIdsFound, 1);
});

/**
 * The approuter does not forward x-request-id: the gateway and the approuter's inbound line share
 * r1, the approuter's call to srv and srv's inbound line share r2, 5 ms later.
 */
function joinedWindow() {
  const at = ms => new Date(Date.parse('2026-09-21T10:00:00.000Z') + ms).toISOString();
  const gw = line({ requestId: 'r1', start: at(0), duration: 300, upstreamServiceTime: '280', downstream: '203.0.113.7:51000', upstreamHost: '10.42.0.11:8080', upstreamCluster: 'outbound|8080||approuter.shop.svc.cluster.local' });
  const apIn = line({ requestId: 'r1', start: at(2), duration: 290, upstreamServiceTime: '285', downstream: '10.42.0.5:44000', upstreamHost: '127.0.0.6:8080', upstreamCluster: 'inbound|8080||' });
  const apOut = line({ requestId: 'r2', start: at(5), duration: 200, upstreamServiceTime: '190', downstream: '10.42.0.11:45000', upstreamHost: '10.42.0.12:8080', upstreamCluster: 'outbound|8080||srv.shop.svc.cluster.local' });
  const srvIn = line({ requestId: 'r2', start: at(6), duration: 190, upstreamServiceTime: '185', downstream: '10.42.0.11:45000', upstreamHost: '127.0.0.6:8080', upstreamCluster: 'inbound|8080||' });
  return { 'istio-ingressgateway-1': gw, 'approuter-1': [apIn, apOut].join('\n'), 'srv-1': srvIn };
}

test('collect(): the gateway journey carries its path, the approuter -> srv call joined by time', async () => {
  const { listFn, textFn } = collectStubs({ pods: THREE_PODS, podLogs: joinedWindow() });
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  const t = out.traces.find(x => x.hops[0] && x.hops[0].role === 'ingress');
  assert.ok(t, 'the gateway journey was kept');
  // `path` stays the request's URL path; the journey's path rides beside it as `journeyPath`.
  assert.equal(t.path, '/api/orders');
  assert.deepEqual(t.journeyPath.nodes.map(n => n.kind).slice(0, 4), ['edge', 'gateway', 'workload', 'workload']);
  assert.deepEqual(t.journeyPath.nodes.slice(1, 4).map(n => n.pod), ['istio-ingressgateway-1', 'approuter-1', 'srv-1']);
  const inferred = t.journeyPath.edges.filter(e => e.link === 'inferred');
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].candidates, 1);
  assert.equal(t.pathReason, null);
  for (const x of out.traces) assert.ok('journeyPath' in x && 'pathReason' in x, `${x.traceId} carries journeyPath and pathReason`);
  assert.doesNotMatch(JSON.stringify(out.traces.map(x => x.journeyPath)), /203\.0\.113/, 'no client address in any path');
});

test('collect(): the window names which proxies contributed, so hopCount can be read honestly', async () => {
  const [gw, ap] = threeHopWindow();
  const { listFn } = collectStubs({ pods: THREE_PODS, podLogs: {} });
  // The backend sidecar refuses the log read: its hop is missing and the tab must be able to say why.
  const textFn = async ({ path }) => {
    if (path.includes('/pods/istio-ingressgateway-1/log')) return gw;
    if (path.includes('/pods/approuter-1/log')) return ap;
    throw Object.assign(new Error('forbidden'), { status: 403 });
  };

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  assert.equal(out.window.proxiesRead, 2);
  assert.deepEqual(out.window.proxiesFailed.map(p => [p.pod, p.reason]), [['srv-1', 'FORBIDDEN']]);
  assert.equal(out.traces[0].hopCount, 2, 'two hops seen');
  assert.equal(out.summary.traces, 1);
  assert.deepEqual(
    out.window.proxies.map(p => p.role),
    ['ingress', 'sidecar'],
    'the contributing proxies are listed, not just counted'
  );
});

test('collect(): a mesh whose access logs go elsewhere reads nothing and says so', async () => {
  const telemetry = [
    {
      metadata: { name: 'mesh-default', namespace: 'istio-system' },
      spec: { accessLogging: [{ providers: [{ name: 'kyma-logs' }] }] }
    }
  ];
  const listFn = fakeListFn([
    ['/apis/telemetry.istio.io', telemetry],
    ['/api/v1/pods', THREE_PODS],
    ['/api/v1/services', []],
    ['/apis/discovery.k8s.io', []],
    ['/api/v1/nodes', []],
    ['/apis/networking.istio.io', []],
    [
      '/api/v1/namespaces/istio-system/configmaps',
      [
        {
          metadata: { name: 'istio', namespace: 'istio-system' },
          data: {
            mesh: 'extensionProviders:\n  - name: kyma-logs\n    envoyOtelAls:\n      service: telemetry-otlp-logs.kyma-system.svc.cluster.local\n      port: 4317\n'
          }
        }
      ]
    ]
  ]);
  let logReads = 0;
  const textFn = async () => {
    logReads += 1;
    return '';
  };

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  assert.equal(logReads, 0, 'reading twelve proxies whose logs go to OTLP would produce a confident empty window');
  assert.equal(out.window.readsSkipped, true);
  assert.equal(out.summary.traces, 0);
  assert.equal(out.correlation.traceparentAbsent, false, 'nothing was read, so nothing is claimed about the format');
});

test('pickTrace serves one trace out of the shared window, and names a trace that has aged out', async () => {
  const [gw, ap, srv] = threeHopWindow();
  const { listFn, textFn } = collectStubs({
    pods: THREE_PODS,
    podLogs: { 'istio-ingressgateway-1': gw, 'approuter-1': ap, 'srv-1': srv }
  });
  const data = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  const hit = pickTrace(data, 'req-abc');
  assert.equal(hit.trace.traceId, 'req-abc');
  assert.equal(hit.traces.length, 1);
  assert.equal(hit.notFoundReason, null);
  assert.equal(hit.window.proxiesRead, 3, 'the detail view keeps the window the row came from');

  const miss = pickTrace(data, 'long-gone');
  assert.equal(miss.trace, null);
  assert.equal(miss.notFoundReason, 'NOT_IN_WINDOW', 'a moving log tail is not an error');
  assert.equal(miss.requestedTraceId, 'long-gone');
});

test('collect(): slow and error counts use the thresholds it publishes', async () => {
  const slow = line({ requestId: 'slow-1', duration: 900 });
  const fast = line({ requestId: 'fast-1', duration: 40 });
  const broken = line({ requestId: 'bad-1', code: 502, flags: 'UF', duration: 30 });
  const { listFn, textFn } = collectStubs({
    pods: [THREE_PODS[0]],
    podLogs: { 'istio-ingressgateway-1': [slow, fast, broken].join('\n') }
  });

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  assert.equal(out.summary.traces, 3);
  assert.equal(out.summary.slowThresholdMs, 500);
  assert.equal(out.summary.slowTraces, 1);
  assert.equal(out.summary.errorTraces, 1);
  assert.equal(out.summary.multiHop, 0, 'three separate requests, not one three-hop journey');
});

// --- polls and namespace scope ----------------------------------------------------------------

test('pollOf names liveness paths and leaves the Streamlit session socket and real routes alone', () => {
  assert.equal(pollOf('/_stcore/health'), 'Streamlit health');
  assert.equal(pollOf('/_stcore/host-config'), 'Streamlit health');
  assert.equal(pollOf('/HEALTHZ?probe=1'), 'Health check', 'case and query string do not matter');
  assert.equal(pollOf('/actuator/health/liveness'), 'Spring Actuator');
  assert.equal(pollOf('/_stcore/stream'), null, 'the session socket is user traffic; its 401s are the finding');
  assert.equal(pollOf('/api/health-report'), null, 'a route merely containing "health" is not a poll');
  assert.equal(pollOf(null), null);
});

test('namespacesOf keeps only valid DNS labels, de-duplicated and sorted', () => {
  assert.deepEqual(namespacesOf('shop, bad_ns,,kyma-system,shop'), ['kyma-system', 'shop']);
  assert.equal(namespacesOf(''), null);
  assert.equal(namespacesOf('Not/A/Label'), null);
});

test('collect(): successful polls are left out BEFORE the cap, failing ones stay, and polls=show brings them back', async () => {
  const polls = Array.from({ length: 5 }, (_, i) =>
    line({ requestId: `poll-${i}`, path: '/_stcore/health', start: `2026-09-21T10:00:0${i}.000Z` })
  );
  const failingPoll = line({ requestId: 'poll-bad', path: '/healthz', code: 503, start: '2026-09-21T09:59:58.000Z' });
  const work = line({ requestId: 'work-1', path: '/api/orders', start: '2026-09-21T09:59:00.000Z' });
  const { listFn, textFn } = collectStubs({
    pods: [THREE_PODS[0]],
    podLogs: { 'istio-ingressgateway-1': [...polls, failingPoll, work].join('\n') }
  });

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });
  assert.deepEqual(out.traces.map(t => t.requestId).sort(), ['poll-bad', 'work-1']);
  assert.equal(out.summary.pollsHidden, 5);
  assert.deepEqual(out.summary.pollsHiddenBy, [{ kind: 'Streamlit health', count: 5 }]);
  assert.equal(out.summary.journeysSeen, 7);
  assert.equal(out.summary.tracesFound, 2, 'the cap counts what the filters left');
  assert.equal(out.traces.find(t => t.requestId === 'poll-bad').poll, 'Health check', 'a failing poll stays, labelled');

  const shown = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn, polls: 'show' });
  assert.equal(shown.summary.traces, 7);
  assert.equal(shown.summary.pollsHidden, 0);
  assert.equal(shown.summary.pollsShown, true);
});

test('collect(): a namespace scope reads that namespace plus the ingress gateways, and keeps only journeys touching it', async () => {
  const pods = [
    THREE_PODS[0],
    pod({ name: 'approuter-1', namespace: 'shop', ip: '10.42.0.11' }),
    pod({ name: 'other-1', namespace: 'billing', ip: '10.42.0.30' })
  ];
  const toShop = line({ requestId: 'to-shop', upstreamCluster: 'outbound|8080||orders.shop.svc.cluster.local' });
  const toElsewhere = line({
    requestId: 'to-billing',
    authority: 'billing.example.com',
    upstreamHost: '10.42.0.30:8080',
    upstreamCluster: 'outbound|8080||invoices.billing.svc.cluster.local'
  });
  const { listFn, textFn } = collectStubs({
    pods,
    podLogs: { 'istio-ingressgateway-1': [toShop, toElsewhere].join('\n'), 'approuter-1': '', 'other-1': toElsewhere }
  });

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn, namespace: 'shop' });
  assert.deepEqual(
    out.window.proxies.map(p => `${p.namespace}/${p.pod}`).sort(),
    ['istio-system/istio-ingressgateway-1', 'shop/approuter-1'],
    'billing is not read; the gateway is'
  );
  assert.deepEqual(out.traces.map(t => t.requestId), ['to-shop']);
  assert.equal(out.summary.outsideNamespace, 1);
  assert.deepEqual(out.window.namespaces, ['shop']);
  assert.deepEqual(
    out.window.meshNamespaces,
    [
      { namespace: 'billing', proxies: 1 },
      { namespace: 'shop', proxies: 1 }
    ],
    'the scope options list every sidecar namespace, read or not, without the gateway'
  );
});

// --- destination names (srv/fleet/destination-names.js), through collect() ------------------

/** srv opening a TLS passthrough to an XSUAA address, as Envoy logged it on platformsbx. */
const EGRESS = JSON.stringify({
  response_code: 0,
  method: null,
  path: null,
  authority: null,
  start_time: '2026-09-21T10:00:00.000Z',
  duration: 33,
  response_flags: '-',
  request_id: null,
  downstream_remote_address: '10.42.0.12:41000',
  upstream_host: '3.214.110.153:443',
  upstream_cluster: 'PassthroughCluster',
  bytes_sent: 7752,
  bytes_received: 819
});

const EGRESS_POLICY = {
  metadata: {
    name: 'egress-allow-btp-traffic',
    namespace: 'applecare',
    annotations: { 'xsuaa-service-instances-us10': '3.214.110.153, 18.213.242.208' }
  }
};

function namingStubs(networkPolicies) {
  const seen = [];
  const listFn = fakeListFn([
    ['/apis/networking.k8s.io/v1/networkpolicies', networkPolicies],
    ['/apis/telemetry.istio.io', []],
    ['/api/v1/pods', THREE_PODS],
    ['/api/v1/services', [service({ name: 'orders' })]],
    ['/apis/discovery.k8s.io', []],
    ['/api/v1/nodes', []],
    ['/apis/networking.istio.io', []],
    ['/api/v1/namespaces/istio-system/configmaps', []]
  ]);
  return {
    seen,
    listFn: async ctx => {
      seen.push(ctx);
      return listFn(ctx);
    },
    textFn: fakeTextFn({ 'srv-1': EGRESS })
  };
}

const externalNode = out => out.serviceMap.nodes.find(n => n.kind === 'external' && n.name === '3.214.110.153:443');

test('collect(): an external node is named from an annotated NetworkPolicy, on the map and on Outbound', async () => {
  const { listFn, textFn, seen } = namingStubs([EGRESS_POLICY]);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  const node = externalNode(out);
  assert.ok(node, 'the egress line drew an external node');
  assert.equal(node.destination.display, 'SAP Authorization and Trust (XSUAA) · us10');
  assert.equal(node.destination.source, 'networkpolicy');
  assert.equal(node.destination.key, 'xsuaa-service-instances-us10');
  assert.deepEqual(node.destination.objects, ['NetworkPolicy applecare/egress-allow-btp-traffic']);

  const row = out.outbound.rows.find(r => r.to.name === '3.214.110.153:443');
  assert.ok(row, 'the egress line is an Outbound row');
  assert.equal(row.to.destination.display, 'SAP Authorization and Trust (XSUAA) · us10');

  const np = seen.find(c => c.path.startsWith('/apis/networking.k8s.io/v1/networkpolicies'));
  assert.ok(np && !np.accept, 'the NetworkPolicy list is a full read: ipBlocks live in spec.egress');
  assert.deepEqual(out.summary.unavailable, []);
});

test('collect(): a 403 on NetworkPolicies leaves the node bare, says so, and the route still answers', async () => {
  const forbidden = Object.assign(new Error('networkpolicies is forbidden'), { status: 403 });
  const { listFn, textFn } = namingStubs(forbidden);
  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });

  const node = externalNode(out);
  assert.ok(node);
  assert.equal(node.destination, undefined, 'an unread source names nothing');
  assert.equal(out.outbound.rows[0].to.destination, undefined);
  assert.ok(
    out.summary.unavailable.some(u => (u.label || u) === 'networkpolicies'),
    'the failed name read is listed with the other unavailable reads'
  );
});

// --- request classes (srv/fleet/collectors/request-class.js), through collect() ---------------

test('collect(): journeys carry a class; endpoints leave refusals and direct-IP dials out by default', async () => {
  const withDetails = (l, details) => JSON.stringify({ ...JSON.parse(l), response_code_details: details });
  const lines = [
    line({ requestId: 'r1', path: '/api', code: 503 }),
    line({ requestId: 'r2', path: '/', authority: '98.83.101.14', code: 400 }),
    withDetails(line({ requestId: 'r3', path: '/admin', code: 403 }), 'rbac_access_denied_matched_policy[none]')
  ];
  const { listFn: base, textFn } = collectStubs({ pods: THREE_PODS, podLogs: { 'istio-ingressgateway-1': lines.join('\n') } });
  const gateway = { metadata: { namespace: 'kyma-system', name: 'kyma-gateway' }, spec: { servers: [{ hosts: ['*.example.com'] }] } };
  const listFn = async ctx => (ctx.path.startsWith('/apis/networking.istio.io/v1/gateways') ? [gateway] : base(ctx));

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });
  const byPath = Object.fromEntries(out.traces.map(t => [t.path, t]));
  assert.equal(byPath['/api'].class, 'app');
  assert.equal(byPath['/api'].appError, true);
  assert.equal(byPath['/'].class, 'direct-or-tls');
  assert.equal(byPath['/'].appError, false, 'a scanner 400 is never an app error');
  assert.equal(byPath['/admin'].class, 'security-refused');
  assert.equal(out.summary.appErrorTraces, 1);
  assert.deepEqual(out.summary.classCounts, { app: 1, 'direct-or-tls': 1, 'security-refused': 1 });
  assert.deepEqual(out.endpoints.endpoints.map(e => e.path), ['/api']);
  assert.equal(out.endpointsAll.endpoints.length, 3);
  assert.deepEqual(out.endpointsFiltered, {
    journeys: 2,
    byClass: [
      { class: 'direct-or-tls', count: 1 },
      { class: 'security-refused', count: 1 }
    ]
  });
});

test('collect(): with Gateways, VirtualServices and APIRules all refused, a named host stays an app journey', async () => {
  const { listFn: base, textFn } = collectStubs({ pods: THREE_PODS, podLogs: { 'istio-ingressgateway-1': line({ requestId: 'r1', path: '/api', code: 503 }) } });
  const forbidden = () => Promise.reject(Object.assign(new Error('forbidden'), { status: 403 }));
  const refusedPath = p => /\/(gateways|virtualservices|apirules)(\?|$)/.test(p);
  const listFn = async ctx => (refusedPath(ctx.path) ? forbidden() : base(ctx));

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });
  assert.equal(out.traces[0].class, 'app', 'unread routes are not an empty route table');
  assert.equal(out.summary.appErrorTraces, 1, 'never a confident 0 over journeys that were never judged');
  assert.deepEqual(out.endpoints.endpoints.map(e => e.path), ['/api']);
});

test('collect(): Gateways and VirtualServices refused with APIRules read is still an unread route table, as Traffic rules it', async () => {
  const { listFn: base, textFn } = collectStubs({ pods: THREE_PODS, podLogs: { 'istio-ingressgateway-1': line({ requestId: 'r1', path: '/api', code: 503 }) } });
  const forbidden = () => Promise.reject(Object.assign(new Error('forbidden'), { status: 403 }));
  const listFn = async ctx => (/\/(gateways|virtualservices)(\?|$)/.test(ctx.path) ? forbidden() : base(ctx));

  const out = await collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });
  assert.equal(out.traces[0].class, 'app');
  assert.equal(out.summary.appErrorTraces, 1);
});
