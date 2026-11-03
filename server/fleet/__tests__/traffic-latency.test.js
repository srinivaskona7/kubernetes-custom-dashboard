/**
 * Latency aggregation over the access-log window.
 *
 * The distinction these pin is the one the whole feature rests on: `aggregate` is handed only
 * the failing requests, so it can never see a service whose *successful* requests take four
 * seconds. `aggregateLatency` is handed all of them. The durations were already being parsed and
 * then dropped, so this costs no extra read.
 *
 * Everything here is a window over the lines that were read. Not a rate, not a total.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import traffic from '../collectors/traffic.js';

/** A resolver index in which one Service exists, so upstream attribution can be real. */
const index = traffic.buildIndex({
  pods: { items: [] },
  services: {
    items: [
      { metadata: { name: 'quotes-api', namespace: 'shop' }, spec: { clusterIP: '10.0.0.9' } }
    ]
  },
  endpointslices: { items: [] },
  nodes: { items: [] },
  gateways: { items: [] }
});

const UPSTREAM = 'outbound|80||quotes-api.shop.svc.cluster.local';

const req = (over = {}) => ({
  code: 200,
  method: 'GET',
  path: '/v1/quotes',
  authority: 'quotes-api',
  protocol: 'HTTP/1.1',
  duration: 10,
  startTime: '2026-09-18T03:00:00.000Z',
  upstreamCluster: UPSTREAM,
  upstreamHost: null,
  downstreamRemote: null,
  requestId: null,
  responseFlags: null,
  responseCodeDetails: null,
  transportFailure: null,
  proxy: { pod: 'p', namespace: 'ns', container: 'istio-proxy' },
  ...over
});

/* --------------------------------------------------------------------- percentile */

test('nearest-rank percentiles only ever return a duration some request actually took', () => {
  const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const l = traffic.latencyOf(durations);
  for (const v of [l.p50Ms, l.p95Ms, l.p99Ms, l.maxMs]) {
    assert.ok(durations.includes(v), `${v} is not an observed duration`);
  }
});

test('the percentiles land on the ranks nearest-rank defines', () => {
  const l = traffic.latencyOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(l.p50Ms, 5);   // ceil(0.5*10) = 5th value
  assert.equal(l.p95Ms, 10);  // ceil(0.95*10) = 10th
  assert.equal(l.p99Ms, 10);
  assert.equal(l.maxMs, 10);
  assert.equal(l.samples, 10);
});

test('a single observation is its own p50, p95 and p99, and says so via samples', () => {
  const l = traffic.latencyOf([61]);
  assert.deepEqual(
    { samples: l.samples, p50Ms: l.p50Ms, p95Ms: l.p95Ms, p99Ms: l.p99Ms },
    { samples: 1, p50Ms: 61, p95Ms: 61, p99Ms: 61 }
  );
});

test('no observations produce null percentiles, never zero', () => {
  const l = traffic.latencyOf([]);
  assert.deepEqual(l, { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
});

test('percentile is order-independent of how the caller happened to collect the durations', () => {
  const a = traffic.latencyOf([9, 1, 5, 3, 7]);
  const b = traffic.latencyOf([1, 3, 5, 7, 9]);
  assert.deepEqual(a, b);
});

test('percentiles are not averaged across proxies', () => {
  // Two proxies: one fast, one slow. Averaging their p95s would give 55; the true p95 of the
  // pooled window is 100. The pooled answer is the only correct one.
  const fast = Array.from({ length: 50 }, () => 10);
  const slow = Array.from({ length: 50 }, () => 100);
  const l = traffic.latencyOf([...fast, ...slow]);
  assert.equal(l.p95Ms, 100);
  assert.notEqual(l.p95Ms, 55);
});

/* --------------------------------------------------------------- aggregateLatency */

test('successful requests are counted, which is the whole reason this is not aggregate()', () => {
  const out = traffic.aggregateLatency([req({ code: 200, duration: 4000 })], index);
  assert.equal(out.services.length, 1);
  assert.equal(out.services[0].requests, 1);
  assert.equal(out.services[0].errors, 0);
  assert.equal(out.services[0].p95Ms, 4000);
});

test('a service is resolved from the upstream FQDN, not from a name that looks similar', () => {
  const out = traffic.aggregateLatency([req()], index);
  assert.equal(out.services[0].service.name, 'quotes-api');
  assert.equal(out.services[0].service.namespace, 'shop');
});

test('an unresolvable upstream is bucketed and counted, never dropped or guessed', () => {
  const out = traffic.aggregateLatency(
    [req(), req({ upstreamCluster: 'outbound|443||api.example.com' })],
    index
  );
  assert.equal(out.unresolvedRequests, 1);
  const unresolved = out.services.find(s => s.service === null);
  assert.ok(unresolved, 'expected a bucket for the unattributable request');
  assert.equal(unresolved.requests, 1);
});

test('error share is a share of the window and is never called a rate', () => {
  const out = traffic.aggregateLatency(
    [req({ code: 200 }), req({ code: 200 }), req({ code: 503 }), req({ code: 403 })],
    index
  );
  const s = out.services[0];
  assert.equal(s.requests, 4);
  assert.equal(s.errors, 2);
  assert.equal(s.server, 1);
  assert.equal(s.client, 1);
  assert.equal(s.errorShare, 0.5);
  assert.ok(!('errorRate' in s), 'a share must not be spelled as a rate');
});

test('a no-response request is its own class, not a client error', () => {
  const out = traffic.aggregateLatency([req({ code: 0 })], index);
  assert.equal(out.services[0].noResponse, 1);
  assert.equal(out.services[0].client, 0);
  assert.equal(out.services[0].server, 0);
});

test('routes split on method, authority and path; services do not', () => {
  const out = traffic.aggregateLatency(
    [
      req({ path: '/a' }),
      req({ path: '/b' }),
      req({ path: '/b', method: 'POST' })
    ],
    index
  );
  assert.equal(out.services.length, 1, 'one destination service');
  assert.equal(out.services[0].requests, 3);
  assert.equal(out.routes.length, 3, 'GET /a, GET /b, POST /b');
});

test('the same route reached through two different authorities stays two rows', () => {
  // A Service can be addressed under several names, and which name a client used is part of the
  // question "why is this route slow" — merging them hides a misrouted hostname.
  const out = traffic.aggregateLatency(
    [req({ authority: 'quotes-api' }), req({ authority: 'quotes-api.shop.svc.cluster.local' })],
    index
  );
  assert.equal(out.routes.length, 2);
});

test('slowest first on p95, and a bucket with no duration data sorts last rather than as zero', () => {
  const out = traffic.aggregateLatency(
    [
      req({ path: '/slow', duration: 900 }),
      req({ path: '/mid', duration: 100 }),
      req({ path: '/unknown', duration: null })
    ],
    index
  );
  assert.deepEqual(out.routes.map(r => r.path), ['/slow', '/mid', '/unknown']);
  assert.equal(out.routes[2].p95Ms, null);
  assert.equal(out.routes[2].samples, 0);
  assert.equal(out.routes[2].requests, 1, 'the request still counts even with no duration');
});

test('lastSeen is the newest observation in the bucket, not the first one read', () => {
  const out = traffic.aggregateLatency(
    [
      req({ startTime: '2026-09-18T03:00:00.000Z' }),
      req({ startTime: '2026-09-18T01:00:00.000Z' }),
      req({ startTime: '2026-09-18T05:00:00.000Z' })
    ],
    index
  );
  assert.equal(out.services[0].lastSeen, '2026-09-18T05:00:00.000Z');
});

test('an empty window produces empty buckets and no unresolved count', () => {
  assert.deepEqual(traffic.aggregateLatency([], index), {
    services: [],
    routes: [],
    connections: [],
    unresolvedRequests: 0,
    httpRequests: 0,
    connectionRecords: 0
  });
});

/* ------------------------------------------------------- HTTP vs TCP, the live finding */

test('a record with no method is a TCP connection, not an HTTP request', () => {
  assert.equal(traffic.isHttpRecord(req({ method: 'GET' })), true);
  assert.equal(traffic.isHttpRecord(req({ method: null })), false);
  assert.equal(traffic.isHttpRecord(req({ method: undefined })), false);
});

test('TCP connection lifetimes never enter the HTTP latency percentiles', () => {
  // The measured case: 919 of 1731 records in one platform-sbx window were TCP, and pooling them
  // produced a p95 of 120 s and a p99 of 210 s for connections that were behaving perfectly.
  const http = Array.from({ length: 10 }, () => req({ code: 200, duration: 8 }));
  const tcp = Array.from({ length: 10 }, () =>
    req({ method: null, authority: null, path: null, code: 0, duration: 420_020 })
  );
  const out = traffic.aggregateLatency([...http, ...tcp], index);

  assert.equal(out.httpRequests, 10);
  assert.equal(out.connectionRecords, 10);
  assert.equal(out.services[0].requests, 10, 'the service bucket counts HTTP only');
  assert.equal(out.services[0].p95Ms, 8, 'a 420-second connection must not become the p95');
  assert.equal(out.services[0].maxMs, 8);
});

test('connections are reported, not discarded — a seven-minute stream is a finding', () => {
  const out = traffic.aggregateLatency(
    [req({ method: null, authority: null, path: null, code: 0, duration: 420_020 })],
    index
  );
  assert.equal(out.connections.length, 1);
  assert.equal(out.connections[0].requests, 1);
  assert.equal(out.connections[0].p50Ms, 420_020);
  assert.equal(out.connections[0].service.name, 'quotes-api');
});

test('a healthy database connection is not counted as a failure', () => {
  // 152 records to polls-postgres at a p50 of 2 ms were being classed `no-response` because a TCP
  // line has code 0. That classification is about HTTP and does not apply.
  const out = traffic.aggregateLatency(
    Array.from({ length: 152 }, () => req({ method: null, authority: null, path: null, code: 0, duration: 2 })),
    index
  );
  assert.equal(out.connections[0].errors, 0);
  assert.equal(out.connections[0].noResponse, 0);
  assert.equal(out.connections[0].errorShare, 0);
  assert.equal(out.services.length, 0, 'no HTTP service row for a purely TCP window');
});

test('a TCP record never lands in the routes table, which has no route to name', () => {
  const out = traffic.aggregateLatency(
    [req({ method: null, authority: null, path: null, code: 0, duration: 60_007 })],
    index
  );
  assert.equal(out.routes.length, 0);
});

test('an unattributed TCP connection does not inflate the unresolved HTTP count', () => {
  const out = traffic.aggregateLatency(
    [req({ method: null, path: null, authority: null, code: 0, upstreamCluster: 'outbound|5432||db.example.com' })],
    index
  );
  assert.equal(out.unresolvedRequests, 0, 'unresolvedRequests counts HTTP requests');
  assert.equal(out.connectionRecords, 1);
});

test('the bucket key for an unattributed record carries no control character', () => {
  // A NUL byte was used as a sort sentinel here once. It is legal JS, every test passed, and
  // `file`, `grep` and `diff` all went blind on the source from that byte onward. Asserted with a
  // code-point walk rather than a character class, so this file stays printable too.
  const out = traffic.aggregateLatency([req({ upstreamCluster: 'outbound|443||api.example.com' })], index);
  const key = String(out.services[0].key);
  for (const ch of key) {
    const cp = ch.codePointAt(0);
    assert.ok(cp >= 0x20 && cp !== 0x7f, `control code point ${cp} in key ${JSON.stringify(key)}`);
  }
  assert.equal(key, '(unresolved)');
});

test('the raw duration list is not leaked to the caller', () => {
  // `durations` is an implementation detail and would be the largest field in the payload.
  const out = traffic.aggregateLatency([req(), req()], index);
  assert.ok(!('durations' in out.services[0]));
  assert.ok(!('durations' in out.routes[0]));
});
