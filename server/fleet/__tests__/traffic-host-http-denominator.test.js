/**
 * A host row's response families and ERROR SHARE are HTTP statements, so only HTTP records may
 * reach them.
 *
 * Envoy logs a raw TCP connection with no `:method` and a response code of `0`, and `httpFamily(0)`
 * is `noResponse`. Counting the whole scoped window into the family buckets therefore filed every
 * healthy TCP connection under the host's no-response column and pushed it into `errorShare` — a
 * figure claiming more failure than the data supports. These tests pin the split: `requests` stays
 * a record count, `httpRequests` is the denominator behind every family, and a host with no HTTP
 * record has no share at all (`null`, never 0, which would read as "no errors").
 */
import { test } from 'vitest';
import assert from 'node:assert';

import _traffic from '../collectors/traffic.js';
const { aggregateHosts, buildIndex } = _traffic;

const ok = items => ({ items, unavailable: false, reason: null, detail: null, truncated: false });

const EMPTY_INDEX = buildIndex({
  pods: ok([]),
  services: ok([]),
  endpointslices: ok([]),
  nodes: ok([]),
  gateways: ok([])
});

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

/** A raw TCP connection: no request line, so no method, no path and code 0. */
function tcp(over = {}) {
  return rec({ method: null, path: null, protocol: null, code: 0, ...over });
}

test('a healthy TCP connection is not a no-response HTTP request on a host row', () => {
  const rows = aggregateHosts(
    [
      rec({ code: 200 }),
      rec({ code: 503 }),
      tcp(), tcp(), tcp(), tcp(), tcp(), tcp(), tcp(), tcp()
    ],
    EMPTY_INDEX
  ).rows;

  const shop = rows.find(r => r.host === 'shop.example.com');
  assert.strictEqual(shop.requests, 10, 'requests stays a record count');
  assert.strictEqual(shop.httpRequests, 2, 'the HTTP subset is published beside it');
  assert.strictEqual(shop.connections, 8, 'and the connections that make up the difference');
  assert.strictEqual(shop.noResponse, 0, 'a connection carries no status code, so it is in no family');
  assert.strictEqual(shop.ok, 1);
  assert.strictEqual(shop.server, 1);
  assert.strictEqual(shop.errorShare, 0.5, 'the share divides by the HTTP records, not by all records');
});

test('a host whose whole window is TCP has no error share to state', () => {
  const row = aggregateHosts([tcp(), tcp(), tcp()], EMPTY_INDEX).rows[0];
  assert.strictEqual(row.requests, 3);
  assert.strictEqual(row.httpRequests, 0);
  assert.strictEqual(row.connections, 3);
  assert.strictEqual(row.noResponse, 0);
  assert.strictEqual(row.errorShare, null, 'null, not 0 — there is nothing HTTP to take a share of');
});

test('a real HTTP request Envoy could not get a response for is still no-response', () => {
  const row = aggregateHosts([rec({ code: 0, responseFlags: 'UF' })], EMPTY_INDEX).rows[0];
  assert.strictEqual(row.httpRequests, 1);
  assert.strictEqual(row.connections, 0);
  assert.strictEqual(row.noResponse, 1, 'it carried a request line, so the failure is real');
  assert.strictEqual(row.errorShare, 1);
});
