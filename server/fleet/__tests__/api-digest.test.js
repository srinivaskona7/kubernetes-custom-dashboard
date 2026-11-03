/**
 * The fleet API digest tool's pure half, and its sweep over the real router.
 *
 * The interesting logic is not the HTTP — it is that this backend wraps a payload in four
 * different envelopes and records what it could not read in more places than that, and that
 * reading the wrong root, or missing one of those places, produces a document that is confidently
 * wrong. So the shape classifier, the payload rooting and the completeness reader are tested
 * against one fixture per real shape, taken from what the live routes actually return, and the
 * verdicts against the real router with its reads refused.
 *
 * The rest pins the promises the generated document makes: routes are called in an order where
 * every discovered parameter already exists, a failed read is never reported as "no data", and
 * no value from a response reaches the page. That last one is proven twice: a payload whose every
 * string is a sentinel renders without the sentinel, and the privacy gate refuses a document that
 * does carry one.
 *
 * The sweep runs here only over the router harness, to grade real envelopes; against a live
 * cluster it needs a running server, and `no-credential-leak.test.js` already covers the property
 * that matters about the responses. The shape, trace and console modules have their own tests in
 * api-digest-modules.test.js.
 */

import { test, vi } from 'vitest';
import { getLogger } from '../../logger.js';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import _api_digest from '../tools/api-digest.js';
const {
  completeness, digestOf, parseArgs, shapeOf, sweepPlan, discover, probeUrl, commandUrl, verdictOf,
  analyse, forbiddenValues, privacyGate, markdown, outlineOf, consoleOf, sweep, provenance, fieldPaths, documentSentences,
  requestsIn, payloadJq
} = _api_digest;
import _api_digest_catalogue2 from '../tools/api-digest-catalogue.js';
const { ROUTES } = _api_digest_catalogue2;
import _errors3 from '../errors.js';
const { ClusterError } = _errors3;
import _router_harness4 from './helpers/router-harness.js';
const { withRouter } = _router_harness4;
import fixtures from './dev-fixtures.js';

/* One fixture per envelope shape, keyed the way the live routes key them. */

/** `/clusters/:id/security` — `{ cluster, ok, data }`. */
const WRAPPER = {
  cluster: { id: 'c1', displayName: 'c1' },
  ok: true,
  data: { summary: { pods: 3, unavailable: [{ scope: 'security.podSecurity' }] }, items: [{ name: 'a', ready: true }] }
};

/** `/clusters` — `{ summary, clusters[{ cluster, ok, data }] }`. */
const ROSTER = {
  summary: { clusters: 2, unreachable: 0, unavailable: [], truncated: [] },
  clusters: [
    { cluster: { id: 'c1' }, ok: null, data: null },
    { cluster: { id: 'c2' }, ok: true, data: { nodes: { total: 3, ready: 3, zones: ['a'] } } }
  ]
};

/** `/workloads` — rows at the root, `clusters[]` is status only. */
const FLATTENED = {
  summary: { clusters: 1, unreachable: 0, unavailable: [], truncated: [], total: 9 },
  clusters: [{ id: 'c1', ok: true, error: null, unavailable: [{ scope: 'workloads.hpa' }], truncated: [] }],
  items: [{ name: 'api', namespace: 'ns', kind: 'Deployment', ready: 1, desired: 1, cpuRequest: 0.1 }],
  collectedAt: '2026-09-18T00:00:00.000Z'
};

/** `/storage` — status-only `clusters[]` beside rows in named lists, with no `items[]`. */
const NAMED_LISTS = {
  summary: { clusters: 1, unreachable: 0, unavailable: [], truncated: [] },
  clusters: [{ id: 'c1', ok: true, error: null, unavailable: [], truncated: [] }],
  pvcs: [],
  quotas: [],
  collectedAt: '2026-10-01T00:00:00.000Z'
};

/** `/security` at fleet scope — the payload is on the cluster entry, with no `data` wrapper. */
const INLINE = {
  summary: { clusters: 1, unavailable: [], truncated: [] },
  clusters: [
    {
      clusterId: 'c1',
      displayName: 'c1',
      unavailable: [],
      truncated: [{ scope: 'security.secrets' }],
      summary: { totalNamespaces: 31 },
      networkPolicies: [{ namespace: 'ns', policyTypes: ['Ingress'] }]
    }
  ],
  unreachable: [],
  collectedAt: '2026-09-18T00:00:00.000Z'
};

/** What `markdown` is told about a run, for a document no sweep produced. */
const META = { generatedAt: 'now', date: 'today', base: 'http://localhost:8099', cluster: 'c1', traced: false, usage: new Map() };

test('shapeOf names each of the four real envelopes', () => {
  assert.equal(shapeOf(WRAPPER), 'wrapper');
  assert.equal(shapeOf(ROSTER), 'roster');
  assert.equal(shapeOf(FLATTENED), 'flattened');
  assert.equal(shapeOf(NAMED_LISTS), 'flattened', 'rows in named lists are still rows at the root');
  assert.equal(shapeOf(INLINE), 'inline');
  assert.equal(shapeOf(null), 'non-object');
  assert.equal(shapeOf('text'), 'non-object');
  assert.equal(shapeOf({ user: 'dev', scopes: [] }), 'plain');
});

test('a roster entry that has not been read yet is not mistaken for a payload', () => {
  // `clusters[0].data` is null on a registered-but-unread cluster. Rooting at it would digest
  // nothing and report the route as having no fields.
  const d = digestOf(ROSTER);
  assert.equal(d.prefix, 'clusters[].data.');
  assert.ok(d.fields.some(f => f.path === 'nodes.total'));
});

test('digestOf roots the flattened shape at the root so the rows are found', () => {
  const d = digestOf(FLATTENED);
  assert.equal(d.prefix, '');
  const paths = d.fields.map(f => f.path);
  assert.ok(paths.includes('items[].name'), 'the rows a table renders must be in the digest');
  assert.ok(paths.includes('clusters[].ok'), 'the per-cluster status is part of the shape');
});

test('digestOf roots the inline shape at the root, where its payload lives', () => {
  const paths = digestOf(INLINE).fields.map(f => f.path);
  assert.ok(paths.includes('clusters[].summary.totalNamespaces'));
  assert.ok(paths.includes('clusters[].networkPolicies[].policyTypes[]'));
});

test('digestOf enters a wrapper at data, because data is an opaque key', () => {
  const d = digestOf(WRAPPER);
  assert.equal(d.prefix, 'data.');
  // Rooting at the envelope would have recorded `data  map` and stopped, so this is the
  // regression that matters: the fields have to be present, not the container.
  assert.ok(d.fields.some(f => f.path === 'items[].name'));
  assert.ok(!d.fields.some(f => f.path === 'data'));
});

test('a Secret data map is recorded as a map and never entered', () => {
  const body = { cluster: { id: 'c1' }, ok: true, data: { items: [{ name: 's', data: { 'tls.key': 4 } }] } };
  const fields = digestOf(body).fields;
  const entry = fields.find(f => f.path === 'items[].data');
  assert.ok(entry, 'the field must still be reported as existing');
  assert.equal(entry.type, 'map');
  assert.ok(
    !fields.some(f => f.path.includes('tls.key')),
    'key names come from whoever wrote the Secret and must not reach the document'
  );
});

test('capacity-style maps are entered, because their keys are schema and not user input', () => {
  // The inventory tool closes `requests`/`limits`/`capacity` — correct for a raw Pod, wrong
  // here, where `capacity.cpuAllocatable` is the field a capacity panel reads.
  const body = { cluster: {}, ok: true, data: { capacity: { cpuAllocatable: 24 }, requests: { cpu: 8 } } };
  const paths = digestOf(body).fields.map(f => f.path);
  assert.ok(paths.includes('capacity.cpuAllocatable'));
  assert.ok(paths.includes('requests.cpu'));
});

test('completeness reads a scope from every place a shape can put one', () => {
  assert.deepEqual(completeness(WRAPPER).unavailable, ['security.podSecurity']);
  assert.deepEqual(completeness(FLATTENED).unavailable, ['workloads.hpa'], 'hung off the cluster entry');
  assert.deepEqual(completeness(INLINE).truncated, ['security.secrets']);
  assert.deepEqual(completeness(ROSTER).unavailable, []);
});

test('completeness counts an unread cluster as pending, never as unreachable', () => {
  const c = completeness(ROSTER).clusters;
  assert.deepEqual(c, { total: 2, ok: 1, failed: 0, pending: 1 });
});

test('completeness counts a failed cluster as failed', () => {
  const body = { summary: {}, clusters: [{ cluster: { id: 'c1' }, ok: false, error: 'unreachable', data: null }] };
  assert.deepEqual(completeness(body).clusters, { total: 1, ok: 0, failed: 1, pending: 0 });
});

test('completeness never throws on a body that is not an envelope', () => {
  for (const b of [null, undefined, 'text', 42, []]) {
    assert.deepEqual(completeness(b).unavailable, []);
  }
});

test('completeness reads the scopes a payload, and each section in it, records itself', () => {
  // `/clusters/:id/events` records a refused read on its payload, the second place
  // `completenessOf` in router.js reads; a reader of the summary alone graded it "empty".
  const events = { cluster: { id: 'c1' }, ok: true, data: { items: [], count: 0, unavailable: ['events'], truncated: [] } };
  assert.deepEqual(completeness(events).unavailable, ['events']);
  // `/clusters/:id/overview` answers for four collectors, each keeping its own record.
  const overview = {
    cluster: { id: 'c1' },
    ok: true,
    data: {
      health: { nodes: {}, unavailable: ['nodes'], truncated: [] },
      compliance: { summary: { unavailable: [], truncated: ['secrets'] }, namespaces: [] },
      workloads: { summary: { unavailable: ['hpa'], truncated: [] }, items: [] },
      events: [],
      eventsSummary: { count: 0, unavailable: ['events'], truncated: [] }
    }
  };
  assert.deepEqual(completeness(overview), { unavailable: ['events', 'hpa', 'nodes'], truncated: ['secrets'], clusters: null, groups: null, capabilities: [] });
});

test('completeness reads each summary group, and counts an `error` group though it has no label', () => {
  // `/summary` and `/clusters/:id/summary` keep their scopes per group. `groupState` in router.js
  // says `error` when no cluster answered a group's reads, and leaves its lists empty.
  const body = {
    cluster: { id: 'c1' },
    groups: {
      health: { state: 'error', unavailable: [], truncated: [] },
      btpServices: { state: 'degraded', unavailable: ['servicebindings'], truncated: [] },
      capacity: { state: 'ok', unavailable: [], truncated: ['pods'] }
    },
    collectedAt: '2026-10-01T00:00:00.000Z'
  };
  assert.deepEqual(completeness(body), {
    unavailable: ['servicebindings'],
    truncated: ['pods'],
    clusters: null,
    groups: { total: 3, error: ['health'], degraded: ['btpServices'] },
    capabilities: []
  });
});

test('completeness counts the clusters `/security` and `/drift` keep outside `clusters[]`', () => {
  // `/security` lists a failed cluster only in `unreachable[]`; with every cluster failed there is
  // no `clusters` key at all, and the route graded "empty".
  const failed = id => ({ id, error: { code: 'UNREACHABLE' }, unavailable: [], truncated: [] });
  const security = { summary: { clusters: 2, unavailable: [], truncated: [] }, unreachable: [failed('c1'), failed('c2')] };
  assert.deepEqual(completeness(security).clusters, { total: 2, ok: 0, failed: 2, pending: 0 });
  assert.deepEqual(completeness({ ...INLINE, unreachable: [failed('c2')] }).clusters, { total: 2, ok: 1, failed: 1, pending: 0 });
  // `/drift` keeps its cluster slots in `clusterParity[]`, which the console reads with `unavailableScope`.
  const drift = {
    summary: { unavailable: ['pods'], truncated: [] },
    clusterParity: [{ ...failed('c1'), ok: false, unavailable: ['pods', 'kymas'] }]
  };
  assert.deepEqual(completeness(drift), {
    unavailable: ['kymas', 'pods'],
    truncated: [],
    clusters: { total: 1, ok: 0, failed: 1, pending: 0 },
    groups: null,
    capabilities: []
  });
});

test('a slot the roster did not read is pending whatever its `ok` says, so a disabled cluster is not unreachable', () => {
  // `unreadSlot` in router.js: `ok: false` on a cluster its operator disabled, `null` on one still pending.
  const unread = (id, notRead) => ({ cluster: { id }, ok: notRead === 'disabled' ? false : null, registered: false, notRead });
  const body = { summary: {}, clusters: [unread('c1', 'disabled'), unread('c2', 'pending'), { cluster: { id: 'c3' }, ok: true, data: { nodes: 1 } }] };
  assert.deepEqual(completeness(body).clusters, { total: 3, ok: 1, failed: 0, pending: 2 });
});

test('completeness reads the backend\'s grade of a data source, and Helm\'s grade of each feature', () => {
  const graded = state => ({ feature: 'OPA Decision Activity', state, sentence: 'x' });
  // `opa.decisions`: one grade on the payload. Helm: one per feature, and the storage's own.
  const decisions = { cluster: { id: 'c1' }, ok: true, data: { available: false, state: 'no-source', entries: [], capability: graded('not-configured') } };
  assert.deepEqual(completeness(decisions).capabilities, ['not-configured']);
  const helm = { cluster: { id: 'c1' }, ok: true, data: { capabilities: { releases: graded('available'), values: graded('forbidden') }, storage: { capability: graded('available') } } };
  assert.deepEqual(completeness(helm).capabilities, ['available', 'available', 'forbidden']);
  // A state capability.js does not name, `/me`'s boolean flags and a container's Linux
  // capabilities are not grades.
  const other = { data: { capability: graded('unreadable'), capabilities: { onboard: true, drop: ['ALL'] } } };
  assert.deepEqual(completeness(other).capabilities, []);
});

/* ------------------------------------------------------------------------ the sweep plan */

test('the plan calls every GET route once and no write route', () => {
  const plan = sweepPlan(ROUTES);
  const gets = ROUTES.filter(r => r.method === 'GET');
  assert.ok(gets.length > 40, 'the catalogue must not be empty or truncated');
  assert.equal(plan.length, gets.length);
  assert.equal(new Set(plan.map(r => r.path)).size, plan.length, 'no route is called twice');
  assert.ok(plan.every(r => r.method === 'GET'), 'the digest never calls a write route');
});

test('the plan names the cluster first and reads each discovered parameter before it is needed', () => {
  const plan = sweepPlan(ROUTES).map(r => r.path);
  assert.equal(plan[0], '/clusters');
  const SOURCE = {
    workload: '/clusters/:id/workloads',
    object: '/clusters/:id/workloads',
    pod: '/clusters/:id/pods',
    template: '/clusters/:id/opa',
    release: '/clusters/:id/helm/releases',
    trace: '/clusters/:id/traces'
  };
  for (const r of ROUTES.filter(x => x.probe?.needs)) {
    const src = SOURCE[r.probe.needs];
    assert.ok(src, `${r.path}: unknown discovery kind ${r.probe.needs}`);
    assert.ok(plan.indexOf(src) > -1 && plan.indexOf(src) < plan.indexOf(r.path), `${r.path} runs after ${src}`);
  }
});

test('routes that reuse other routes\' caches run after everything they reuse', () => {
  const plan = sweepPlan(ROUTES).map(r => r.path);
  const composites = ROUTES.filter(r => r.reuses?.length);
  assert.ok(composites.length > 0, 'the composites (/drift, /summary, /report) must be marked');
  for (const r of composites) {
    for (const reused of r.reuses) {
      assert.ok(plan.indexOf(reused) > -1, `${r.path} reuses ${reused}, which is not a GET route`);
      assert.ok(plan.indexOf(reused) < plan.indexOf(r.path), `${r.path} must run after ${reused}`);
    }
  }
});

test('logs is called for its structure only, and its lines never reach the page', () => {
  const logs = ROUTES.find(r => r.path === '/clusters/:id/logs');
  assert.ok(logs, 'the logs route must be catalogued');
  assert.equal(logs.probe?.structureOnly, true, 'the one verbatim surface stays marked as structure-only');
  const LINE = 'VERBATIMAPPLICATIONLINE';
  const body = { cluster: { id: 'c1' }, ok: true, data: { lines: [LINE, `${LINE}-2`], container: 'c', truncated: false } };
  const a = analyse(logs, { status: 200, ms: 1, bytes: 10, contentType: 'application/json', body });
  const doc = markdown([a], { generatedAt: 'now', date: 'today', base: 'http://localhost:8099', cluster: 'c1', traced: false, usage: new Map() });
  assert.ok(doc.includes('/clusters/:id/logs'));
  assert.ok(!doc.includes(LINE), 'a log line reached the document');
});

/* ------------------------------------------------------------------------------ discovery */

test('discovery prefers a platform namespace and a Deployment, and says null when there is none', () => {
  const answers = new Map([
    ['/clusters/:id/workloads', { body: { data: { items: [
      { namespace: 'shop', kind: 'StatefulSet', name: 'db' },
      { namespace: 'shop', kind: 'Deployment', name: 'web' },
      { namespace: 'kyma-system', kind: 'Deployment', name: 'op' }
    ] } } }],
    ['/clusters/:id/pods', { body: { data: { items: [
      { namespace: 'shop', name: 'p1', phase: 'Running', containers: [{ name: 'app' }] },
      { namespace: 'istio-system', name: 'p2', phase: 'Pending', containers: [{ name: 'discovery' }] }
    ] } } }]
  ]);
  assert.deepEqual(discover('workload', answers), { namespace: 'kyma-system', kind: 'Deployment', name: 'op' });
  // A running pod beats a platform one that is not running: its log can be read.
  assert.deepEqual(discover('pod', answers), { namespace: 'shop', pod: 'p1', container: 'app' });
  assert.equal(discover('release', answers), null);
  assert.equal(discover('trace', new Map()), null);
});

test('the probe URL carries the discovered object; the documented command carries only variables', () => {
  const graph = ROUTES.find(r => r.path.endsWith('/graph'));
  const found = { namespace: 'kyma-system', kind: 'Deployment', name: 'a b' };
  assert.equal(probeUrl(graph, 'c1', found), '/clusters/c1/workloads/kyma-system/Deployment/a%20b/graph');
  const cmd = commandUrl(graph);
  assert.equal(cmd, '$FLEET/api/fleet/clusters/$CLUSTER/workloads/$NAMESPACE/$KIND/$NAME/graph');
  const logs = ROUTES.find(r => r.path === '/clusters/:id/logs');
  const url = probeUrl(logs, 'c1', { namespace: 'n', pod: 'p', container: 'k' });
  assert.match(url, /namespace=n&pod=p&container=k/);
  assert.doesNotMatch(commandUrl(logs), /=n&|=p&|=k\b/, 'a discovered value leaked into the command');
});

/* -------------------------------------------------------------------------------- verdict */

test('the verdict never reports a failure as empty, or an empty cluster as a failure', () => {
  const cap = (lists, populated, withValue = 5) => ({ leaves: 10, withValue, lists, populated, emptyLists: [], nullLeaves: [] });
  const none = { unavailable: [], truncated: [], clusters: null };
  assert.equal(verdictOf({ status: 0, error: 'timed out' }, none, null).word, 'no');
  assert.equal(verdictOf({ status: 503, body: { code: 'FLEET_UNCONFIGURED' } }, none, null).detail, 'status 503 `FLEET_UNCONFIGURED`');
  // The detail's words are the code's own identifiers, so no response value can collide with one:
  // `HTTP` there once matched a gateway protocol the cluster sent, and the gate refused the document.
  const sent = forbiddenValues([{ data: { ingress: { gateways: [{ protocol: 'HTTP' }] } } }], new Set());
  assert.ok(sent.has('HTTP'), 'canary: a gateway protocol the code never spells is not forbidden');
  const detail = verdictOf({ status: 400, body: { code: 'OIDC_FLOW_EXPIRED' } }, none, null).detail;
  assert.ok(privacyGate(`| Captures | **no**, ${detail} |`, sent).ok, `the verdict detail collides with a response value: ${detail}`);
  assert.equal(verdictOf({ status: 200, body: { ok: false, code: 'UPSTREAM' } }, none, cap(1, 0)).word, 'no');
  assert.equal(verdictOf({ status: 200, body: {} }, { ...none, unavailable: ['x'] }, cap(1, 1)).word, 'partial');
  assert.equal(verdictOf({ status: 200, body: {} }, { ...none, truncated: ['x'] }, cap(1, 1)).word, 'partial');
  assert.equal(verdictOf({ status: 200, body: {} }, none, cap(3, 0)).word, 'empty');
  assert.equal(verdictOf({ status: 200, body: {} }, none, cap(3, 2)).word, 'yes');
  assert.equal(verdictOf({ status: 200, body: {} }, none, cap(0, 0, 0)).word, 'empty');
});

/** A capture with data in it: what a route that read something returns. */
const FULL = { leaves: 4, withValue: 4, lists: 1, populated: 1, emptyLists: [], nullLeaves: [] };
const COMPLETE = { unavailable: [], truncated: [], clusters: null, groups: null };

test('every cluster unreachable or unread is no, some is partial, and a cluster not read yet is not unreachable', () => {
  const graded = clusters => verdictOf({ status: 200, body: {} }, { ...COMPLETE, clusters }, FULL);
  // What came back is the envelope; there is no cluster's data in it to be part of.
  assert.deepEqual(graded({ total: 2, ok: 0, failed: 2, pending: 0 }), { word: 'no', detail: '2 of 2 cluster(s) unreachable, none read' });
  assert.equal(graded({ total: 2, ok: 1, failed: 1, pending: 0 }).word, 'partial');
  // `ok: null` is registered, not unreachable, and not read either.
  assert.deepEqual(graded({ total: 2, ok: 0, failed: 0, pending: 2 }), { word: 'no', detail: '2 of 2 cluster(s) registered but not read, none read' });
  assert.deepEqual(graded({ total: 3, ok: 1, failed: 0, pending: 2 }), { word: 'partial', detail: '2 cluster(s) registered but not read' });
  assert.deepEqual(graded({ total: 3, ok: 0, failed: 1, pending: 2 }), {
    word: 'no', detail: '1 of 3 cluster(s) unreachable, 2 of 3 cluster(s) registered but not read, none read'
  });
  assert.equal(graded({ total: 2, ok: 2, failed: 0, pending: 0 }).word, 'yes');
});

test('a data source graded as reading nothing is no, and one feature short of a trusted read is partial', () => {
  const graded = capabilities => verdictOf({ status: 200, body: {} }, { ...COMPLETE, capabilities }, FULL);
  assert.deepEqual(graded(['not-configured']), { word: 'no', detail: 'the backend grades the data source `not-configured`' });
  assert.equal(graded(['forbidden', 'unknown']).word, 'no');
  assert.deepEqual(graded(['available', 'forbidden']), { word: 'partial', detail: 'a data source graded `forbidden`' });
  // `partial` is the backend saying it read some of it.
  assert.deepEqual(graded(['partial']), { word: 'partial', detail: 'a data source graded `partial`' });
  // `stale` and `not-installed` carry numbers that are facts.
  for (const states of [['available'], ['stale'], ['not-installed'], []]) assert.equal(graded(states).word, 'yes', states.join());
});

test('a summary group that failed is partial, and every group failed is no', () => {
  const graded = (error, degraded = []) => verdictOf({ status: 200, body: {} }, { ...COMPLETE, groups: { total: 3, error, degraded } }, FULL);
  assert.equal(graded(['health', 'security', 'topology']).word, 'no');
  assert.deepEqual(graded(['health']), { word: 'partial', detail: '1 of 3 groups failed to read: health' });
  assert.equal(graded([], ['btpServices']).word, 'partial', 'a degraded group is short of ok even with no label');
  assert.equal(graded([]).word, 'yes');
});

test('a cluster or group not fully read is listed under completeness, and under its response', () => {
  const route = ROUTES.find(r => r.method === 'GET' && r.path === '/summary');
  const body = { groups: { health: { state: 'error', unavailable: [], truncated: [] }, mesh: { state: 'ok', unavailable: [], truncated: [] } }, perCluster: {} };
  const doc = markdown([analyse(route, { status: 200, ms: 1, bytes: 10, contentType: 'application/json', body })], META);
  assert.match(doc, /^\| `\/summary` \| — \| — \| group\(s\) `health` in state `error` \|$/m);
  assert.match(doc, /^Not fully read on this read: group\(s\) `health` in state `error`\.$/m);
});

/* ---------------------------------------------------------- refused reads, through the router */

/** Answers from the fixture cluster, except each read `refuses` matches, which throws `err`. */
const refusing = (refuses, err) => {
  const seam = real => async args => {
    if (!refuses(args.path)) return real(args);
    throw err(args.cluster.id);
  };
  return { listFn: seam(fixtures.listFn), callFn: seam(fixtures.callFn), textFn: seam(fixtures.textFn) };
};
const FORBIDDEN = id => new ClusterError('FORBIDDEN', 'forbidden', { cluster: id, status: 403 });
const UNREACHABLE = id => new ClusterError('UNREACHABLE', `${id}: connect ETIMEDOUT`, { cluster: id });

/** `sweep` over the real router, as `npm run fleet:digest` sweeps a dev server; results by path. */
async function sweepRouter(transport) {
  let results;
  await withRouter(transport, async ({ baseUrl }) => {
    ({ results } = await sweep({ base: baseUrl.replace(/\/api\/fleet$/, ''), cluster: null, timeoutMs: 10_000, traceLog: null }));
  });
  return new Map(results.map(a => [a.route.path, a]));
}

test('a refused read is partial on the routes that graded it empty or yes (router)', async () => {
  // Events and service bindings refused, everything else answered.
  const byPath = await sweepRouter(refusing(p => /\/(events|servicebindings)(\?|$)/.test(p), FORBIDDEN));
  for (const [route, scope] of [
    ['/clusters/:id/events', 'events'],
    ['/clusters/:id/overview', 'events'],
    ['/clusters/:id/summary', 'servicebindings'],
    ['/summary', 'servicebindings']
  ]) {
    const a = byPath.get(route);
    assert.equal(a.verdict.word, 'partial', `${route}: ${a.verdict.word}, ${a.verdict.detail}`);
    assert.ok(a.completeness.unavailable.includes(scope), `${route} lost the ${scope} label`);
  }
});

test('with every read refused, no JSON route is empty, and only routes that read no cluster are yes (router)', async () => {
  // The caller and the token store: the fleet's own state, which no refusal reaches. The text
  // route `/report` is out: its verdict counts headings with lines under them.
  const OWN_STATE = new Set(['/me', '/tokens']);
  for (const [name, err] of [['FORBIDDEN', FORBIDDEN], ['UNREACHABLE', UNREACHABLE]]) {
    const byPath = await sweepRouter(refusing(() => true, err));
    const graded = [...byPath.values()].filter(a => a.verdict && !a.outline);
    assert.ok(graded.length > 40, `${name}: the sweep graded only ${graded.length} routes`);
    for (const a of graded) {
      const where = `${name}: ${a.route.path} graded ${a.verdict.word} (${a.verdict.detail})`;
      assert.notEqual(a.verdict.word, 'empty', where);
      if (a.verdict.word === 'yes') assert.ok(OWN_STATE.has(a.route.path), where);
    }
    // These say it only in capability.js's words: `available: false` and a grade short of a read.
    for (const p of ['/opa/decisions', '/clusters/:id/opa/decisions']) {
      assert.equal(byPath.get(p).verdict.word, 'no', `${name}: ${p} graded ${byPath.get(p).verdict.word} (${byPath.get(p).verdict.detail})`);
    }
    for (const p of ['/clusters', '/security', '/topology', '/drift']) assert.equal(byPath.get(p).verdict.word, 'no', `${name}: ${p}`);
    for (const p of ['/summary', '/clusters/:id/summary']) {
      assert.equal(byPath.get(p).verdict.word, 'partial', `${name}: ${p}`);
      assert.ok(byPath.get(p).completeness.groups.error.length, `${name}: ${p} reported no group in state error`);
    }
  }
});

test('a trace window\'s requests split into the sweep\'s own and everyone else\'s', () => {
  const requests = [
    { method: 'GET', url: '/api/fleet/clusters/c1/pods?ns=a' },
    { method: 'POST', url: '/api/fleet/clusters/c1/pods' },
    { method: 'GET', url: '/api/fleet/me' }
  ];
  assert.deepEqual(requestsIn(requests, 'http://localhost:8099', '/clusters/c1/pods?ns=b'), { seen: true, others: 2 });
  assert.deepEqual(requestsIn(requests, 'http://localhost:8099/', '/clusters/c2/pods'), { seen: false, others: 3 });
  const encoded = [{ method: 'GET', url: '/api/fleet/clusters/c1/helm/releases/kyma%2Dsystem/x' }];
  assert.deepEqual(requestsIn(encoded, 'http://localhost:8099', '/clusters/c1/helm/releases/kyma-system/x'), { seen: true, others: 0 });
});

test('the trace log must be the swept server\'s, with its reads in it, or the sweep stops (router)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-trace-'));
  const file = path.join(dir, 'dev.log');
  const window = { quietMs: 5, pollMs: 1, maxMs: 200 };
  const logger = getLogger();
  const info = logger.info;
  // What dev-server.js writes to its log: the router's request line, then the reads it made.
  let reads = true;
  let foreign = null;
  const serverLog = (...args) => {
    const line = args.join(' ');
    if (!line.startsWith('[fleet-audit] ')) return info.apply(logger, args);
    let out = `${line}\n`;
    if (reads) out += `${JSON.stringify({ k8s: 'platformsbx', path: '/api/v1/namespaces', wait: 0, ms: 1, bytes: 10, t: Date.now() })}\n`;
    if (foreign?.test(line)) out += '[fleet-audit] GET /api/fleet/me -> 200 (1ms) user=anonymous\n';
    fs.appendFileSync(file, out);
  };
  try {
    await withRouter(async ({ baseUrl }) => {
      const args = { base: baseUrl.replace(/\/api\/fleet$/, ''), cluster: null, timeoutMs: 10_000, traceLog: file };
      await assert.rejects(sweep(args, () => {}, { window }), /does not exist/);
      fs.writeFileSync(file, '');
      await assert.rejects(sweep(args, () => {}, { window }), /recorded none of this sweep's requests/);

      logger.info = serverLog;
      foreign = /^\[fleet-audit\] GET \/api\/fleet\/clusters\/platformsbx\/pods(\?\S*)? -> /;
      const { results, clusterId } = await sweep(args, () => {}, { window });
      assert.equal(clusterId, 'platformsbx');
      const called = results.filter(a => a.status);
      assert.ok(called.length > 40, `only ${called.length} routes answered`);
      assert.deepEqual(called.filter(a => !a.requestSeen).map(a => a.route.path), [], 'a request the server answered is not in its window');
      const pods = results.find(a => a.route.path === '/clusters/:id/pods');
      assert.equal(pods.otherRequests, 1);
      assert.deepEqual(called.filter(a => a.otherRequests).map(a => a.route.path), ['/clusters/:id/pods']);
      assert.ok(pods.reads.calls >= 1);
      const doc = markdown(results, { ...META, traced: true });
      assert.ok(doc.includes('While `GET /clusters/:id/pods` answered, the server answered 1 other request(s) too, so these reads may include theirs.'));
      assert.ok(doc.includes('; 1 route(s) shared the server with other requests, marked under each |'));

      reads = false;
      foreign = null;
      await assert.rejects(sweep(args, () => {}, { window }), /holds no Kubernetes reads/);
    });
  } finally {
    logger.info = info;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------- privacy gate */

test('the privacy gate refuses a document carrying a response value, and masks what it reports (canary)', () => {
  const secretName = 'payments-db-7c9d4';
  const forbidden = forbiddenValues([{ data: { items: [{ name: secretName }] } }], new Set());
  assert.ok(forbidden.has(secretName));
  const bad = privacyGate(`| \`/clusters/:id/pods\` | ${secretName} |`, forbidden);
  assert.equal(bad.ok, false, 'the gate must refuse a document that names a pod');
  assert.ok(!JSON.stringify(bad.hits).includes(secretName), 'the refusal must not print the value it refuses');
  assert.ok(privacyGate('| `/clusters/:id/pods` | "string" |', forbidden).ok);
});

test('a refusal says where the value landed, and masks every value on that line (canary)', () => {
  const forbidden = new Map([['payments-db-7c9d4', 'data.items[].name'], ['ledger-api-5f8', 'data.items[].name']]);
  const doc = '### Pods\n\n| a | payments-db-7c9d4 |\n| b | payments-db-7c9d4 and ledger-api-5f8 |';
  const gate = privacyGate(doc, forbidden);
  assert.deepEqual(gate.hits.map(h => h.at), ['Pods, line 3', 'Pods, line 4']);
  // Line 4 repeats a value reported on line 3; its context must mask that one too.
  const text = JSON.stringify(gate.hits);
  assert.ok(!text.includes('payments-db-7c9d4') && !text.includes('ledger-api-5f8'), 'a reported context printed a value');
  assert.match(gate.hits[1].context, /pa…\(17\) and le…\(14\)/);
});

test('the privacy gate catches addresses, identities, tokens and workstation paths by pattern', () => {
  for (const leak of ['10.250.0.17', 'someone@example.com', 'eyJhbGciOiJSUzI1.eyJzdWIiOiJ4eHh4.c2lnbmF0dXJlMTIz', '/Users/someone/x']) {
    assert.equal(privacyGate(`text ${leak} text`, new Map()).ok, false, `not caught: ${leak.slice(0, 3)}`);
  }
  assert.ok(privacyGate('istio 1.30.4 on v1.33', new Map()).ok, 'a version is not an address');
});

test('forbidden values skip what the code spells, timestamps and numbers', () => {
  const body = { a: 'kube-system', b: '2026-09-30T10:00:00Z', c: '12345', d: 'has space in it', e: 'abc', f: 'custom-ns' };
  const f = forbiddenValues([body], new Set(['kube-system']));
  assert.deepEqual([...f.keys()], ['custom-ns']);
});

test('a name-like key is forbidden, a schema key and a key inside an opaque map are not', () => {
  // A small map keyed by namespace prints its keys (api-digest-shape.js collapses only non-identifier
  // keys and large maps), so a bare namespace name as a key is the residual leak the gate must see.
  const body = { data: { byNamespace: { payments: 3 }, cpuAllocatable: 4, labels: { tenant: 'x' } } };
  const f = forbiddenValues([body], new Set(), new Set(['byNamespace', 'cpuAllocatable', 'labels']));
  assert.ok(f.has('payments'));
  assert.ok(!f.has('cpuAllocatable'));
  assert.ok(!f.has('tenant'), 'label keys are never rendered');
});

test('a name-like value the code spells as an identifier is vocabulary, any other is not', () => {
  // A gateway port named after the mesh's own `mtls` key prints only as that key.
  const body = { data: { ports: [{ portName: 'mtls' }, { portName: 'payments' }, { portName: 'mtls-ledger' }] } };
  const f = forbiddenValues([body], new Set(), new Set(['data', 'ports', 'portName', 'mtls', 'ledger']));
  assert.ok(!f.has('mtls'));
  assert.ok(f.has('payments'));
  // An identifier vouches for a whole word only, never for a name that contains it.
  assert.ok(f.has('mtls-ledger'));
});

const MANIFEST = ROUTES.find(r => r.method === 'GET' && r.path === '/clusters/:id/helm/releases/:namespace/:name/manifest');
const answered = (route, body, opts) => analyse(route, { status: 200, ms: 1, bytes: 10, contentType: 'application/json', body }, opts);

test('a key the code never spells is forbidden in any case, and a document printing one is refused (canary)', () => {
  // A chart's and an operator's keys are camelCase, PascalCase or UPPER_CASE as often as lowercase.
  // Under a key that is not OPAQUE the structure enters them, as it once entered `overrides`. Each
  // sits beside a lowercase key: an object whose every key is capitalised folds as a map keyed by
  // data (api-digest-shape.test.js), and then nothing would print for the gate to refuse.
  const body = {
    cluster: { id: 'c1' },
    ok: true,
    data: { chartConfig: { POISONTeamGroup: { poisonMember: { POISON_UPPER: 3, enabled: true } }, replicas: 2 }, overrides: { POISONOtherGroup: 1 } }
  };
  const vocabulary = new Set(['cluster', 'id', 'ok', 'data', 'chartConfig', 'overrides', 'replicas', 'enabled']);
  const f = forbiddenValues([body], new Set(['c1']), vocabulary);
  for (const k of ['POISONTeamGroup', 'poisonMember', 'POISON_UPPER']) assert.ok(f.has(k), `${k} is not forbidden`);
  assert.ok(!f.has('chartConfig'), 'a key the code spells is a field name');
  assert.ok(!f.has('POISONOtherGroup'), 'a key under an opaque key never prints');

  const gate = privacyGate(markdown([answered(MANIFEST, body, { vocabulary })], { ...META, vocabulary }), f);
  assert.deepEqual(gate.hits.map(h => h.masked).sort(), ['PO…(12)', 'PO…(15)', 'po…(12)']);
});

test('a key with a dash or a leading digit is forbidden too, a number or a date is not', () => {
  // The field paths fold no map keyed by data, so a namespace there prints as itself, dashes and all.
  const body = { data: { byNamespace: { 'poison-payments': 1, '9poison': 2 }, byPort: { 8080: 3 }, byDay: { '2026-10-01': 4 } } };
  const f = forbiddenValues([body], new Set(), new Set(['data', 'byNamespace', 'byPort', 'byDay']));
  assert.deepEqual([...f.keys()], ['poison-payments', '9poison']);
});

test('a dotted path is read piece by piece, in a heading and a table cell too, unless the code spells the whole word', () => {
  // A response structure's paths are keys, and one of them can be the cluster's.
  const forbidden = new Map([['POISONTeamGroup', 'data.chartConfig (a key)'], ['acme-tools', 'data.items[].namespace']]);
  for (const line of [
    '#### `data.chartConfig.POISONTeamGroup.hosts[]`',
    '| `GET` | `data.rows[].POISONTeamGroup` | 3 |',
    'Empty on this read: `data.chartConfig.POISONTeamGroup.hosts[]`.'
  ]) {
    const gate = privacyGate(line, forbidden);
    assert.equal(gate.ok, false, line);
    // A heading names where every hit below it landed, so it is masked like the line.
    assert.ok(!JSON.stringify(gate.hits).includes('POISONTeamGroup'), `the refusal printed the key it refuses: ${line}`);
  }
  // An API group the code spells is the code's word, though a namespace shares its first label.
  const cmd = "kubectl get --raw '/apis/acme-tools.io/v1/widgets'";
  assert.ok(privacyGate(cmd, forbidden, new Set(['acme-tools.io'])).ok);
  assert.equal(privacyGate(cmd, forbidden).ok, false);
});

test('no key under a release\'s overrides, values or defaults reaches the document or the field paths', () => {
  const body = {
    cluster: { id: 'c1' },
    ok: true,
    data: {
      name: 'acme-chart',
      overrides: { AcmeTeamGroup: { acmeTeam: { ACME_TEAM_QUOTA: 3, acmeHosts: [] } } },
      values: { AcmeTeamGroup: { enabled: true } },
      defaults: { acmeTeam: { replicas: 2 } }
    }
  };
  const vocabulary = new Set(['cluster', 'id', 'ok', 'data', 'name', 'overrides', 'values', 'defaults']);
  const a = answered(MANIFEST, body, { vocabulary });
  const doc = markdown([a], { ...META, vocabulary });
  const json = fieldPaths([a], { generatedAt: 'now', cluster: 'c1' });
  for (const k of ['AcmeTeamGroup', 'acmeTeam', 'ACME_TEAM_QUOTA', 'acmeHosts']) {
    assert.ok(!doc.includes(k), `${k} reached the document`);
    assert.ok(!json.includes(k), `${k} reached the field paths`);
  }
  // Recorded, not entered: a reader still learns the release has each one.
  assert.deepEqual(a.digest.fields.filter(f => /^(overrides|values|defaults)\b/.test(f.path)), [
    { path: 'defaults', type: 'map' }, { path: 'overrides', type: 'map' }, { path: 'values', type: 'map' }
  ]);
});

test('the field paths fold a map keyed by data as the structure does, and the gate reads a path piece by piece', () => {
  // A field path is keys only; a map keyed by namespace prints as `<key>`, as in the document. So
  // does a key no rule could forbid: a host or a `namespace/pod` key fails `PRINTABLE_KEY`.
  const pods = ROUTES.find(r => r.method === 'GET' && r.path === '/clusters/:id/pods');
  const body = { cluster: { id: 'c1' }, ok: true, data: { byNamespace: { payments: { pods: 3 }, 'poison-payments': { pods: 1 } } } };
  const json = fieldPaths([answered(pods, body)], { generatedAt: '2026-10-01T00:00:00.000Z', cluster: 'c1' });
  assert.deepEqual(JSON.parse(json).routes[0].fields, ['byNamespace', 'byNamespace.<key>', 'byNamespace.<key>.pods']);
  const hosts = { cluster: { id: 'c1' }, ok: true, data: { hosts: { 'api.poison.example.com': { ready: 1 }, '*.poison.example.com': { ready: 2 } }, byPod: { 'poison-ns/poison-pod-0': { ready: 1 } } } };
  const keyed = fieldPaths([answered(pods, hosts)], { generatedAt: '2026-10-01T00:00:00.000Z', cluster: 'c1' });
  assert.deepEqual(JSON.parse(keyed).routes[0].fields, ['byPod', 'byPod.<key>', 'byPod.<key>.ready', 'hosts', 'hosts.<key>', 'hosts.<key>.ready']);
  const forbidden = forbiddenValues([body], new Set(['c1']), new Set(['cluster', 'id', 'ok', 'data', 'byNamespace', 'pods']));
  assert.ok(privacyGate(json, forbidden).ok);
  // Were a namespace to reach a path, the gate reads it there.
  const leaked = JSON.stringify({ fields: ['byNamespace.payments.pods', 'byNamespace.poison-payments.pods'] });
  assert.deepEqual(privacyGate(leaked, forbidden).hits.map(h => h.masked).sort(), ['pa…(8)', 'po…(15)'], 'a namespace in a field path passed the gate');
});

test('a map keyed by registered cluster ids folds, though each id reads like a field name', () => {
  // `/summary`'s `perCluster`: two lowercase, dash-free ids, which no other rule tells from fields.
  const summary = ROUTES.find(r => r.method === 'GET' && r.path === '/summary');
  const body = { generatedAt: '2026-10-01T00:00:00.000Z', perCluster: { poisonalpha: { pods: 3 }, poisonbeta: { pods: 1 } } };
  const vocabulary = new Set(['generatedAt', 'perCluster', 'pods']);
  const forbidden = forbiddenValues([body], new Set(), vocabulary);
  assert.deepEqual([...forbidden.keys()].sort(), ['poisonalpha', 'poisonbeta']);
  const unfolded = markdown([answered(summary, body, { vocabulary })], { ...META, vocabulary });
  assert.equal(privacyGate(unfolded, forbidden).ok, false, 'canary: without the registered ids the ids print');
  const a = answered(summary, body, { vocabulary, dataKeys: new Set(['poisonalpha', 'poisonbeta']) });
  const doc = markdown([a], { ...META, vocabulary });
  assert.ok(!doc.includes('poisonbeta'));
  assert.ok(privacyGate(doc, forbidden).ok);
  assert.deepEqual(a.digest.fields.map(f => f.path).filter(f => f.startsWith('perCluster')), ['perCluster', 'perCluster.<key>', 'perCluster.<key>.pods']);
});

test('a refusal names where a value came from as the structure prints it, never through a key the document keeps out', () => {
  // A Helm values key and a key the code does not spell, on the way to a value the gate refuses.
  const body = { data: { releases: [{ values: { POISONCustomer: { dbHost: 'poison-db-1' } } }], POISONGroup: { name: 'poison-db-2' } } };
  const forbidden = forbiddenValues([body], new Set(), new Set(['data', 'releases', 'values', 'name']));
  assert.equal(forbidden.get('poison-db-1'), 'data.releases[].values');
  assert.equal(forbidden.get('poison-db-2'), 'data.<key>.name');
  assert.equal(forbidden.get('POISONGroup'), 'data (a key)');
  const gate = privacyGate('| host | poison-db-1 | poison-db-2 |', forbidden);
  assert.equal(gate.ok, false);
  assert.ok(!JSON.stringify(gate.hits).includes('POISONCustomer'), 'the refusal printed a Helm values key');
  assert.ok(!JSON.stringify(gate.hits).includes('POISONGroup'), 'the refusal printed a key the code does not spell');
});

test('a value holding a character tokens are split on is refused whole, and masked where it lands', () => {
  // `workloads.js` labels a refused namespace read `deployments[ns=<namespace>]`.
  const forbidden = forbiddenValues([{ data: { unavailable: ['deployments[ns=poison-payments]', 'poison-team/poison-db'] } }], new Set(), new Set(['data', 'unavailable']));
  const line = 'Unavailable on this read: `deployments[ns=poison-payments]`, `poison-team/poison-db`.';
  const gate = privacyGate(line, forbidden);
  assert.equal(gate.ok, false, 'a value with a split character passed the gate');
  assert.deepEqual(gate.hits.map(h => h.masked).sort(), ['de…(31)', 'po…(21)']);
  assert.ok(!gate.hits.some(h => h.context.includes('poison')), 'the refusal printed the value it refuses');
  // The code's own words around it are not refused, and a sentence the code spells still vouches.
  assert.ok(privacyGate('Unavailable on this read: `deployments[ns={namespace}]`.', forbidden).ok);
  assert.ok(privacyGate(line, forbidden, new Set(), [line]).ok);
});

test('a value holding a split character is forbidden only for a piece the code does not spell', () => {
  // The live sweep: `apiVersion: apps/v1`, a Kyma resource's `operator.kyma-project.io/v1beta2` and
  // a Helm value `/metrics` print inside the reads' own paths, word for word the API's.
  const allow = new Set(['apis', 'apps', 'v1', 'daemonsets', 'operator.kyma-project.io', 'v1beta2', 'kymas', 'metrics.k8s.io', 'v1beta1', 'nodes']);
  const body = { data: { apiVersion: 'apps/v1', kymas: [{ resource: { apiVersion: 'operator.kyma-project.io/v1beta2' } }], releases: [{ values: { path: '/metrics' } }], unavailable: ['deployments[ns=poison-payments]'] } };
  const forbidden = forbiddenValues([body], allow, new Set(['data', 'apiVersion', 'kymas', 'resource', 'releases', 'values', 'path', 'unavailable', 'metrics']));
  assert.deepEqual([...forbidden.keys()], ['deployments[ns=poison-payments]']);
  const reads = [
    "kubectl get --raw '/apis/apps/v1/daemonsets?resourceVersion=0'",
    "kubectl get --raw '/apis/operator.kyma-project.io/v1beta2/kymas?resourceVersion=0'",
    "kubectl get --raw '/apis/metrics.k8s.io/v1beta1/nodes?resourceVersion=0'"
  ].join('\n');
  assert.ok(privacyGate(reads, forbidden, allow).ok, 'the reads\' own API paths were refused');
  assert.equal(privacyGate(`${reads}\n\`deployments[ns=poison-payments]\``, forbidden, allow).ok, false);
});

test('a split value is let through only when every piece of it is the code\'s', () => {
  // With the code's words around it, a namespace in the middle is the one piece that names, and
  // digits name too: a pair of ids or a phone number is no word the code spells.
  const allow = new Set(['deployments', 'ns', 'pods', 'log', 'apps', 'v1']);
  const values = ['deployments[ns=poison-payments]/pods/log', '1234567890/9876543210', '+49(30)1234567', 'apps/v1', '/pods/log'];
  const forbidden = forbiddenValues([{ data: { unavailable: values } }], allow, new Set(['data', 'unavailable']));
  assert.deepEqual([...forbidden.keys()], values.slice(0, 3));
  const gate = privacyGate(values.map(v => `\`${v}\``).join(', '), forbidden, allow);
  assert.deepEqual(gate.hits.map(h => h.masked).sort(), ['+4…(14)', '12…(21)', 'de…(40)']);
});

test('a value ending in a dot or a colon is refused as it prints', () => {
  // A token loses its trailing `.` and `:` before it is compared, so a value stored with one
  // (a fully qualified host, a `<namespace>:` label) was never found.
  const forbidden = forbiddenValues([{ data: { unavailable: ['api.poison.example.com.', 'poison-payments:'] } }], new Set(), new Set(['data', 'unavailable']));
  const gate = privacyGate('| scope | api.poison.example.com. | poison-payments: |', forbidden);
  assert.deepEqual(gate.hits.map(h => h.masked).sort(), ['ap…(23)', 'po…(16)']);
  assert.ok(!gate.hits.some(h => h.context.includes('poison')), 'the refusal printed the value it refuses');
});

test('a sentence written with an escape vouches for its words as it prints', () => {
  // The certificates purpose is written `One cluster\'s Certificates from cert-manager …`; read
  // with its escape, it is in no document, and an issuer named `cert-manager` refused the digest.
  const line = markdown([], META).split('\n').find(l => l.includes('Certificates from cert-manager'));
  assert.ok(line, 'the certificates purpose is not in the document');
  const forbidden = new Map([['cert-manager', 'data.issuers[].name']]);
  assert.equal(privacyGate(line, forbidden).ok, false, 'canary: without the sentences the word refuses the line');
  assert.deepEqual(privacyGate(line, forbidden, new Set(), documentSentences()).hits, []);
  assert.ok(!documentSentences().some(s => s.includes('\\\'')), 'a sentence kept its escape');
});

test('the base URL prints a loopback address as localhost, and any other address as it is', () => {
  const row = base => markdown([], { ...META, base }).split('\n').find(l => l.startsWith('| Base URL |'));
  assert.equal(row('http://127.0.0.1:8299'), '| Base URL | `http://localhost:8299` |');
  assert.ok(privacyGate(row('http://127.0.0.1:8299'), new Map()).ok);
  assert.equal(privacyGate('| Base URL | `http://127.0.0.1:8299` |', new Map()).ok, false, 'canary: the address pattern does not read a loopback address');
  assert.equal(row('http://127.0.0.10:8299'), '| Base URL | `http://127.0.0.10:8299` |');
  assert.equal(row('http://10.1.2.3:8099'), '| Base URL | `http://10.1.2.3:8099` |');
});

test('a record with an empty list still captures; an inventory with only empty lists does not', () => {
  const body = { id: 'dev', admin: false, scopes: [] };
  const me = ROUTES.find(r => r.path === '/me');
  const pods = ROUTES.find(r => r.path === '/clusters/:id/pods');
  const answer = route => analyse(route, { status: 200, ms: 1, bytes: 40, contentType: 'application/json', body });
  assert.equal(answer(me).verdict.word, 'yes');
  assert.equal(answer(pods).verdict.word, 'empty');
});

test('the jq a command pipes into is the payload of its shape, and a flattened answer\'s own lists', () => {
  assert.equal(payloadJq('flattened', FLATTENED), '.items');
  assert.equal(payloadJq('flattened', NAMED_LISTS), '{pvcs, quotas}');
  assert.equal(payloadJq('flattened', { clusters: NAMED_LISTS.clusters, pvcs: [] }), '.pvcs');
  assert.equal(payloadJq('wrapper', WRAPPER), '.data');
  assert.equal(payloadJq('roster', ROSTER), '.clusters[].data');
  assert.equal(payloadJq('inline', INLINE), '.clusters[]');
  assert.equal(payloadJq('plain', { user: 'dev' }), '.');
});

test('a flattened answer whose rows are named lists is graded on those lists, and its command prints them', () => {
  // `/storage` answers `pvcs[]` and `quotas[]` beside status-only `clusters[]`. Read as inline,
  // its payload was `clusters[]`, its jq `.clusters[]`, and two empty lists graded yes.
  const storage = ROUTES.find(r => r.method === 'GET' && r.path === '/storage');
  const a = answered(storage, NAMED_LISTS);
  assert.equal(a.envelope, 'flattened');
  assert.equal(a.jq, '{pvcs, quotas}');
  assert.deepEqual(a.lists, ['pvcs', 'quotas']);
  assert.deepEqual(a.verdict, { word: 'empty', detail: 'all 2 lists empty on this read' });
  assert.equal(answered(storage, { ...NAMED_LISTS, pvcs: [{ name: 'a', phase: 'Bound' }] }).verdict.word, 'yes');
  const doc = markdown([a], META);
  assert.ok(doc.includes(`curl -s "${'$'}FLEET/api/fleet/storage" | jq '{pvcs, quotas}'`), 'the command does not print the named lists');
  assert.ok(doc.includes('**Response** of `GET /storage` (flattened envelope, payload at the root: `pvcs[]`, `quotas[]`):'));
  // A cluster entry carrying a payload is still inline, whatever lists sit beside it.
  assert.equal(answered(storage, INLINE).envelope, 'inline');
});

test('a text answer is described by its headings, never by its lines', () => {
  const literals = new Set(['Fleet', 'Health', 'Report', 'Summary']);
  const text = '# Fleet Health Report\nGenerated at: 2026-10-01\n\n## Summary\n- **payments-prod**: HEALTHY\n\n## payments-prod\n';
  assert.deepEqual(outlineOf(text, literals), [
    { heading: '# Fleet Health Report', lines: 1 },
    { heading: '## Summary', lines: 1 },
    // A heading word the code does not spell is the cluster's.
    { heading: '## {value}', lines: 0 }
  ]);

  const route = ROUTES.find(r => r.method === 'GET' && r.path === '/report');
  const answer = outline => analyse(route, {
    status: 200, ms: 1, bytes: text.length, contentType: 'text/markdown; charset=utf-8', attachment: true,
    body: null, parseError: 'not JSON', outline
  });
  assert.equal(answer(outlineOf(text, literals)).verdict.word, 'yes');
  assert.equal(answer([{ heading: '# Fleet Health Report', lines: 0 }]).verdict.word, 'empty');

  const doc = markdown([answer(outlineOf(text, literals))], { generatedAt: 'now', date: 'today', base: 'b', cluster: 'c1', traced: false, usage: new Map() });
  assert.match(doc, /curl -s -OJ "\$FLEET\/api\/fleet\/report"/);
  assert.ok(!/report" \| jq/.test(doc), 'a Markdown answer is piped to jq');
  assert.match(doc, /## Summary {3}\(1 line\)/);
  assert.ok(!doc.includes('payments-prod'), 'a line of the document reached the digest');
});

test('a payload whose every string is a sentinel renders every route without the sentinel', () => {
  const SENT = 'SENTINELVALUEX';
  const poison = shape => {
    const leaf = { name: SENT, namespace: SENT, kind: SENT, labels: { [SENT]: SENT }, count: 1, ok: true };
    const data = { items: [leaf], summary: { total: 1, unavailable: [], truncated: [] }, nested: { rows: [leaf] } };
    if (shape === 'roster') return { summary: { unavailable: [], truncated: [] }, clusters: [{ cluster: { id: 'c1' }, ok: true, data }] };
    return { cluster: { id: 'c1' }, ok: true, data };
  };
  const results = ROUTES.filter(r => r.method === 'GET').map(r =>
    analyse(r, { status: 200, ms: 1, bytes: 10, contentType: 'application/json', body: poison(r.path === '/clusters' ? 'roster' : 'wrapper') }));
  const doc = markdown(results, { generatedAt: 'now', date: 'today', base: 'http://localhost:8099', cluster: 'c1', traced: false, usage: new Map() });
  assert.ok(doc.length > 1000);
  assert.ok(!doc.includes(SENT), 'a response value reached the document');
  const schemaKeys = new Set(['cluster', 'clusters', 'data', 'items', 'summary', 'total', 'unavailable', 'truncated', 'nested', 'rows', 'name', 'namespace', 'kind', 'count', 'labels']);
  const gate = privacyGate(doc, forbiddenValues(results.map(a => a.body), new Set(['c1']), schemaKeys));
  assert.deepEqual(gate.hits, [], 'the gate must pass a document that carries no value');
});

test('the sections other documents cite keep their titles', () => {
  // KYMA_FLEET_TABS_AND_FEATURES.md cites §2 (envelope shapes) and §4 (slowest routes) by number.
  const doc = markdown([], { generatedAt: 'now', date: 'today', base: 'b', cluster: 'c1', traced: true, usage: new Map() });
  assert.match(doc, /^## 2\. Envelope shapes$/m);
  // Four of the shapes wrap a payload; `plain` and `non-object` are bodies with no envelope.
  assert.match(doc, /Four envelopes wrap a payload: `wrapper`, `roster`, `inline` and\s+`flattened`/);
  assert.match(doc, /^## 4\. Slowest routes$/m);
  for (const r of ROUTES) assert.ok(doc.includes(`${r.method} ${r.path}`), `${r.method} ${r.path} has no entry`);
});

/* ------------------------------------------------------------------------- the document */

test('the header names the commit, and says when server/ or app/fleet-ui/ had uncommitted changes', () => {
  const asked = [];
  const git = answers => args => {
    asked.push(args.join(' '));
    return answers[args[0]];
  };
  assert.deepEqual(provenance(git({ 'rev-parse': 'abc1234', status: '' })), { commit: 'abc1234', dirty: false });
  assert.deepEqual(asked, ['rev-parse --short HEAD', 'status --porcelain -- server app/fleet-ui']);
  assert.deepEqual(provenance(git({ 'rev-parse': 'abc1234', status: ' M srv/fleet/router.js' })), { commit: 'abc1234', dirty: true });
  assert.deepEqual(provenance(() => { throw new Error('not a git repository'); }), { commit: null, dirty: null });

  // The docs rule: 1-3 lines under the title saying what the doc is, and no workstation path.
  const header = p => {
    const lines = markdown([], { ...META, provenance: p }).split('\n');
    return lines.slice(2, lines.indexOf('', 2)).join('\n');
  };
  const cases = [
    [{ commit: 'abc1234', dirty: false }, /API,\s+from commit `abc1234`\. Regenerate/],
    [{ commit: 'abc1234', dirty: true }, /from commit `abc1234`, with uncommitted changes under server\/ or app\/fleet-ui\//],
    [{ commit: null, dirty: null }, /commit unknown/],
    [undefined, /commit unknown/]
  ];
  for (const [p, says] of cases) {
    const text = header(p);
    assert.ok(text.split('\n').length <= 3, `a header of ${text.split('\n').length} lines`);
    assert.match(text, says);
    assert.ok(privacyGate(text, new Map()).ok, 'the header carries a workstation path or an address');
  }
  // The default runs git in the repo, whatever the working directory.
  const real = provenance();
  if (real.commit !== null) assert.match(real.commit, /^[0-9a-f]{7,}$/);
});

test('a write route shows the response its handler sends, right after the line saying it is not called', () => {
  const post = ROUTES.find(r => r.method === 'POST' && r.path === '/clusters');
  const had = Object.getOwnPropertyDescriptor(post, 'responds');
  try {
    post.responds = '// 201 Created\n{ "cluster": { "id": "string" } }';
    const lines = markdown([], META).split('\n');
    const at = lines.findIndex(l => l.startsWith('**POST /clusters** is not called by the digest:'));
    assert.ok(at > -1, 'the write route has no entry');
    assert.deepEqual(lines.slice(at + 1, at + 7), ['', 'Response, from the handler (not called):', '', '```jsonc', '// 201 Created', '{ "cluster": { "id": "string" } }']);
    // The block is document text, so the privacy gate reads it like every other line.
    post.responds = '// 201 Created\n{ "cluster": { "id": "payments-db-7c9d4" } }';
    assert.equal(privacyGate(markdown([], META), new Map([['payments-db-7c9d4', 'clusters[].cluster.id']])).ok, false);
  } finally {
    if (had) Object.defineProperty(post, 'responds', had);
    else delete post.responds;
  }
});

test('a GET the digest cannot drive to success shows the answer its handler sends, beside what it did answer', () => {
  // The SSO callback needs a live sign-in, so the sweep sees only its 400; the catalogue's
  // `responds` is all a reader learns of the 201 or the 302.
  const cb = ROUTES.find(r => r.method === 'GET' && r.path === '/clusters/bootstrap-oidc/callback');
  assert.ok(cb?.responds, 'the callback documents no answer in the catalogue');
  const lines = markdown([], META).split('\n');
  const at = lines.indexOf(`**Success response** of \`GET ${cb.path}\`, from the handler (a live call cannot reach it):`);
  assert.ok(at > -1, 'the callback\'s documented answer is not in the document');
  assert.deepEqual(lines.slice(at + 1, at + 4), ['', '```jsonc', cb.responds.trim().split('\n')[0]]);
  assert.ok(lines.slice(at).some(l => l.startsWith(`**Response** of \`${cb.path}\``)), 'the live answer no longer follows it');
});

test('a console call counts only for the route with its method', () => {
  // The scan keys by path, and `/clusters` is both the roster read and the onboarding write.
  const read = { fn: 'clusters', method: 'GET', callers: [{ file: 'pages/Fleet.tsx', views: ['Fleet'] }] };
  const write = { fn: 'onboard', method: 'POST', callers: [{ file: 'pages/AddCluster.tsx', views: ['Add Cluster'] }] };
  const usage = new Map([['/clusters', [read, write]], ['/me', [{ fn: 'me', callers: [{ file: 'auth.tsx', views: ['Shell'] }] }]]]);
  const route = (method, p) => ROUTES.find(r => r.method === method && r.path === p);
  assert.equal(consoleOf(route('GET', '/clusters'), usage), '`api.clusters`: Fleet');
  assert.equal(consoleOf(route('POST', '/clusters'), usage), '`api.onboard`: Add Cluster');
  assert.equal(consoleOf(route('GET', '/me'), usage), '`api.me`: Shell', 'an entry with no method is a GET');

  // A GET route whose only console call writes is one no console file requests, and a function
  // nothing calls is named with its method.
  const doc = markdown([], { ...META, usage: new Map([['/clusters', [write]], ['/tokens/:id/renew', [{ fn: 'renew', method: 'POST', callers: [] }]]]) });
  const line = label => doc.split('\n').find(l => l.startsWith(label)) ?? '';
  assert.match(line('**GET routes no console file requests**'), /`\/clusters`/);
  assert.match(line('**`api.ts` functions nothing calls**'), /`api\.renew` \(`POST \/tokens\/:id\/renew`\)/);
});

test('every shape call that renders a response structure is given the source vocabulary', async () => {
  // A wide object is a record when the source spells its keys, so a call that drops the
  // vocabulary folds a record into `"<key>"`. Spy on the shape module's exports, load a fresh
  // copy of the digest over them, and check each call's options.
  const calls = [];
  vi.resetModules();
  vi.doMock('../tools/api-digest-shape.js', async () => {
    const real = (await vi.importActual('../tools/api-digest-shape.js')).default;
    return {
      default: Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v !== 'function' ? v : (...args) => {
        calls.push({ fn: k, vocabulary: args.at(-1)?.vocabulary });
        return v(...args);
      }]))
    };
  });
  try {
    const fresh = (await import('../tools/api-digest.js')).default;
    const vocabulary = new Set(['cluster', 'data', 'items', 'name', 'ready', 'summary']);
    const pods = ROUTES.find(r => r.path === '/clusters/:id/pods');
    const a = fresh.analyse(pods, { status: 200, ms: 1, bytes: 10, contentType: 'application/json', body: WRAPPER }, { vocabulary });
    fresh.markdown([a], { ...META, vocabulary });
    for (const fn of ['shapeOfValue', 'shapeAt', 'captureOf', 'renderShape']) {
      const own = calls.filter(c => c.fn === fn);
      assert.ok(own.length, `${fn} was never called`);
      assert.ok(own.every(c => c.vocabulary === vocabulary), `${fn} was called without the vocabulary`);
    }
  } finally {
    vi.doUnmock('../tools/api-digest-shape.js');
    vi.resetModules();
  }
});

test('parseArgs defaults to the dev server and rejects an unknown flag', () => {
  assert.deepEqual(parseArgs([]), { base: 'http://localhost:8099', cluster: null, out: null, timeoutMs: 60_000, traceLog: null, jsonOut: null });
  const a = parseArgs(['--base', 'http://x:1', '--cluster', 'c9', '--out', 'f.md', '--timeout', '5', '--trace-log', 't.log']);
  assert.equal(a.base, 'http://x:1');
  assert.equal(a.cluster, 'c9');
  assert.equal(a.out, 'f.md');
  assert.equal(a.timeoutMs, 5);
  assert.equal(a.traceLog, 't.log');
  assert.throws(() => parseArgs(['--raw']), /unknown argument/);
});
