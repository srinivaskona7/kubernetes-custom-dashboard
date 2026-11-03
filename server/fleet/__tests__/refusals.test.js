/**
 * srv/fleet/collectors/refusals.js: every request a proxy refused, with the policy that decided it.
 * Rows in fixtures/sbx-refusals.json are platformsbx's own ingressgateway access logs, recorded
 * 2026-09-28 with:
 *   kubectl --context platformsbx -n istio-system logs <pod> --tail=3000
 * for each of the three istio-ingressgateway pods, then filtered to lines `isRefusal` accepts and
 * redacted (every IPv4/IPv6 address replaced with 192.0.2.10; no user_agent or client field is
 * carried by these log fields, so none was present to drop).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import SBX from './fixtures/sbx-refusals.json';
import _refusals from '../collectors/refusals.js';
const { refusalsOf, isRefusal } = _refusals;

const GW = { namespace: 'istio-system', pod: 'istio-ingressgateway-1' };
const SRV = { namespace: 'applecare', pod: 'srv-1' };
const rec = over => ({ proxy: GW, method: 'GET', authority: 'x.example.com', path: '/', code: 403, responseCodeDetails: 'rbac_access_denied_matched_policy[none]', responseFlags: null, upstreamHost: null, startTime: '2026-09-28T10:00:00.000Z', downstreamRemote: '203.0.113.9:5000', ...over });
const ap = (namespace, name, spec) => ({ metadata: { namespace, name }, spec });
const ACL = ap('istio-system', 'apple-acl', { selector: { matchLabels: { istio: 'ingressgateway' } }, action: 'ALLOW', rules: [{ from: [{ source: { remoteIpBlocks: ['17.0.0.0/8', '10.0.0.0/8'] } }], to: [{ operation: { hosts: ['*.btp.sap.apple.com'], paths: ['/api/*'], methods: ['GET'] } }] }] });
const labels = new Map([['istio-system/istio-ingressgateway-1', { istio: 'ingressgateway' }], ['applecare/srv-1', { app: 'srv' }]]);
const ctx = (aps = [ACL], over = {}) => ({ gatewayKeys: new Set(['istio-system/istio-ingressgateway-1']), podLabels: labels, authorizationPolicies: { items: aps, unavailable: false }, classOf: () => 'direct-ip', ...over });

test('an ALLOW miss with exactly one selecting ALLOW policy is decided by elimination, not inferred', () => {
  const { rows } = refusalsOf([rec()], ctx());
  assert.equal(rows.length, 1);
  const [d] = rows[0].decidedBy;
  assert.deepEqual(
    { ns: d.namespace, name: d.name, inferred: d.policyInferred, decidedBy: d.decidedBy },
    { ns: 'istio-system', name: 'apple-acl', inferred: false, decidedBy: 'elimination' }
  );
  assert.deepEqual(d.rules, [{ paths: ['/api/*'], methods: ['GET'], hosts: ['*.btp.sap.apple.com'], principals: [], ipBlocks: 2 }]);
  assert.doesNotMatch(JSON.stringify(rows), /17\.0\.0\.0|203\.0\.113\.9/, 'no CIDR and no client address on the wire');
});

test('two ALLOW policies selecting the gateway stay inferred, neither is elimination', () => {
  const other = ap('istio-system', 'partner-acl', { selector: { matchLabels: { istio: 'ingressgateway' } }, rules: [{}] });
  const { rows } = refusalsOf([rec()], ctx([ACL, other]));
  assert.deepEqual(rows[0].decidedBy.map(p => p.name).sort(), ['apple-acl', 'partner-acl']);
  assert.ok(rows[0].decidedBy.every(p => p.policyInferred));
  assert.ok(rows[0].decidedBy.every(p => p.decidedBy === 'inferred'));
});

test('a DENY names its matched_policy exactly, not inferred', () => {
  const deny = ap('applecare', 'deny-admin', { selector: { matchLabels: { app: 'srv' } }, action: 'DENY', rules: [{ to: [{ operation: { paths: ['/admin*'] } }] }] });
  const r = rec({ proxy: SRV, path: '/admin', responseCodeDetails: 'rbac_access_denied_matched_policy[ns[applecare]-policy[deny-admin]-rule[0]]' });
  const { rows } = refusalsOf([r], ctx([ACL, deny]));
  assert.equal(rows[0].tier, 'sidecar');
  assert.deepEqual(rows[0].decidedBy.map(p => [p.name, p.policyInferred, p.decidedBy]), [['deny-admin', false, 'named']]);
});

test('a TLS refusal before HTTP says so and has no method or path', () => {
  const r = rec({ method: null, path: null, authority: null, code: 0, responseCodeDetails: null, responseFlags: 'NR', terminationDetails: null, requestedServerName: null });
  r.responseCodeDetails = 'filter_chain_not_found';
  const { rows } = refusalsOf([r], ctx());
  assert.equal(rows[0].tlsBeforeHttp, true);
  assert.equal(rows[0].reason, 'TLS refused before HTTP: the client offered no server name this gateway serves');
  assert.equal(rows[0].method, null);
});

test('query is redacted: a path arrives redacted and stays so', () => {
  const { rows } = refusalsOf([rec({ path: '/callback?code=REDACTED&state=x' })], ctx());
  assert.equal(rows[0].path, '/callback?code=REDACTED&state=x');
});

test('rows group by host + path + code + decision, count requests and distinct clients', () => {
  const lines = [rec(), rec({ startTime: '2026-09-28T10:05:00.000Z' }), rec({ downstreamRemote: '203.0.113.10:1' }), rec({ path: '/robots.txt' })];
  const { rows, requests } = refusalsOf(lines, ctx());
  assert.equal(requests, 4);
  const root = rows.find(r => r.path === '/');
  assert.deepEqual([root.count, root.clients, root.firstSeen, root.lastSeen], [3, 2, '2026-09-28T10:00:00.000Z', '2026-09-28T10:05:00.000Z']);
});

test('policies unread: rows stay, decidedBy is null, never an empty list', () => {
  const { rows, policiesUnavailable } = refusalsOf([rec()], ctx([], { authorizationPolicies: { items: [], unavailable: true } }));
  assert.equal(policiesUnavailable, true);
  assert.equal(rows[0].decidedBy, null);
});

test('a request that reached an upstream is not a refusal; a 404 NR answered by the proxy is', () => {
  const served = rec({ code: 500, upstreamHost: '10.0.0.30:8080', responseCodeDetails: 'via_upstream' });
  const nr = rec({ code: 404, responseFlags: 'NR', responseCodeDetails: 'route_not_found' });
  const { rows } = refusalsOf([served, nr], ctx());
  assert.deepEqual(rows.map(r => r.code), [404]);
  assert.equal(rows[0].decidedBy.length, 0, 'no policy decided a missing route');
});

test('a proxy-originated 5xx with no upstream and no via_upstream is a refusal (cluster_not_found reachable)', () => {
  assert.equal(isRefusal({ upstreamHost: null, code: 503, responseCodeDetails: 'cluster_not_found' }), true);
  assert.equal(isRefusal({ upstreamHost: '10.0.0.30:8080', code: 503, responseCodeDetails: 'via_upstream' }), false);
  const r = rec({ code: 503, upstreamHost: null, responseCodeDetails: 'cluster_not_found', responseFlags: 'NC' });
  const { rows } = refusalsOf([r], ctx());
  assert.equal(rows[0].reason, 'The route names a backend that does not exist');
});

test('upstreamHost of "-" is treated as absent', () => {
  assert.equal(isRefusal({ upstreamHost: '-', code: 403 }), true);
  const r = rec({ code: 403, upstreamHost: '-' });
  const { rows } = refusalsOf([r], ctx());
  assert.equal(rows.length, 1);
});

test('policiesUnavailable agrees with decidedBy: null even when items is a non-empty stale list', () => {
  const { rows, policiesUnavailable } = refusalsOf([rec()], ctx([ACL], { authorizationPolicies: { items: [ACL], unavailable: true } }));
  assert.equal(policiesUnavailable, true);
  assert.equal(rows[0].decidedBy, null);
});

test('the recorded sbx refusals all produce a row with a plain-words reason, and apple-acl decides the ALLOW misses', () => {
  const lines = SBX.map(e => rec({ method: e.method, authority: e.authority, path: e.path, code: e.code, responseCodeDetails: (e.responseCodeDetails || [])[0] || null, responseFlags: (e.responseFlags || []).join(',') || null }));
  const { rows } = refusalsOf(lines, ctx());
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.reason && !/undefined|null/.test(r.reason), r.reason);
  const allowMiss = rows.filter(r => r.responseCodeDetails.some(d => d.startsWith('rbac_access_denied_matched_policy[none]')));
  assert.ok(allowMiss.length > 0, 'the fixture has at least one ALLOW-miss row');
  for (const r of allowMiss) {
    assert.ok(r.decidedBy.some(p => p.name === 'apple-acl'), 'apple-acl should be listed for an ALLOW miss on the gateway');
    assert.ok(r.decidedBy.every(p => p.decidedBy === 'elimination' && p.policyInferred === false), 'apple-acl is the only ALLOW policy, so elimination decides it, not inference');
  }
});
