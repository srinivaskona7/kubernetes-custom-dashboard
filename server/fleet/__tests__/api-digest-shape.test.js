/**
 * api-digest-shape.js decides, object by object, whether a response's keys are a schema or data. A
 * map keyed by data folds into one `"<key>"` entry, so no namespace, host or pod name reaches the
 * page; a record prints every field. A key count cannot tell the two apart: a trace row, a node row
 * and the cost summary each carry more fields than DICT_MIN_KEYS, and every one is a name the
 * collector chose. So with a vocabulary, the identifiers the fleet's own source spells, a wide
 * object folds only when one of its keys is a word the code never spells.
 *
 *   - The synthetic cases pin the rule: a wide record the vocabulary covers prints every field; the
 *     same record without a vocabulary folds, as it always did; a wide map keyed by data, or a record
 *     with one data key, folds with a vocabulary; a non-identifier key folds whatever the vocabulary
 *     holds; an object of DICT_MIN_KEYS keys or fewer renders the same either way.
 *   - The sentinel case is the privacy proof for the new road onto the page: an unfolded record
 *     prints its key names and never a value.
 *   - The author-written cases hold the other road shut: a key under an OPAQUE key, a Helm
 *     release's `overrides`, `values` and `defaults` included, reaches neither the rendering, nor a
 *     path the capture lists as empty, nor the shape itself, whether a record or a map keyed by
 *     data holds it and whichever row came first. Every name in them is invented.
 *   - The real-collector cases fold what the router answers, with the vocabulary api-digest.js
 *     builds, so a builder that starts emitting a key the code does not spell fails here instead of
 *     quietly folding its payload in the digest again.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';

const { OPAQUE, DICT_MIN_KEYS, shapeOfValue, renderShape, captureOf, shapeAt, fieldsOf } =
  _api_digest_shapeModule;
import _api_digest from '../tools/api-digest.js';
const { identifiersOf, collectorFiles, uiFiles } = _api_digest;
import _router_harness2 from './helpers/router-harness.js';
import _api_digest_shapeModule from '../tools/api-digest-shape.js';
const { withRouter } = _router_harness2;

const NUMBER = 424242;

/** Thirty names a collector spells, more than DICT_MIN_KEYS: `field0` … `field29`. */
const FIELDS = Array.from({ length: 30 }, (_, i) => `field${i}`);

/** Thirty names only the data spells, the way namespaces or hosts key a map. */
const DATA_KEYS = Array.from({ length: 30 }, (_, i) => `POISONKEY${i}`);

/** An object over `keys` whose every value is a sentinel: strings `POISON-n`, numbers 424242. */
const sentinels = keys => Object.fromEntries(keys.map((k, i) => [k, i % 2 ? NUMBER : `POISON-${i}`]));

/** What a source spelling the fixtures' schema keys would give: every name in FIELDS, no data key. */
const VOCABULARY = new Set(['cluster', 'id', 'ok', 'data', 'summary', 'rows', 'byNamespace', 'byHost', 'mixed', ...FIELDS]);

/** Every sentinel, value or data key, that `text` carries. */
const leaksIn = text => ['POISON', String(NUMBER)].filter(x => text.includes(x));

/** The rendered line that declares `key`, e.g. `    "field1": "number",`. */
const lineOf = (text, key) => text.split('\n').find(l => l.trimStart().startsWith(`${JSON.stringify(key)}:`));

/* ------------------------------------------------------------------------------ the rule */

test('a wide record whose every key the vocabulary spells prints all its fields, and no "<key>"', () => {
  assert.ok(FIELDS.length > DICT_MIN_KEYS, 'the fixture must be wider than DICT_MIN_KEYS');
  const shape = shapeOfValue({ data: { summary: sentinels(FIELDS) } }, { vocabulary: VOCABULARY });
  const { text } = renderShape(shape, { maxLines: 1000 });

  for (const k of FIELDS) assert.ok(lineOf(text, k), `"${k}" is not rendered:\n${text}`);
  assert.ok(!text.includes('<key>'), text);
  assert.equal(lineOf(text, 'field0').trim(), '"field0": "string",');
  assert.equal(lineOf(text, 'field1').trim(), '"field1": "number",');

  // A record to every reader of the shape: its fields are reachable and each one is counted.
  const summary = shapeAt(shape, 'data.summary');
  assert.equal(summary.obj.dict, false);
  assert.ok(shapeAt(shape, 'data.summary.field29'));
  const capture = captureOf(summary);
  assert.deepEqual([capture.leaves, capture.withValue], [30, 30]);
});

test('without a vocabulary the same record folds, as it always did', () => {
  const body = { data: { summary: sentinels(FIELDS) } };
  const { text } = renderShape(shapeOfValue(body), { maxLines: 1000 });
  assert.ok(text.includes('"<key>": "number | string"  // map keyed by data'), text);
  for (const k of FIELDS) assert.ok(!text.includes(`"${k}"`), `"${k}" printed from a folded map`);

  assert.equal(shapeAt(shapeOfValue(body), 'data.summary').obj.dict, true);
  // An empty vocabulary spells nothing, so every wide object is a map to it.
  assert.equal(shapeAt(shapeOfValue(body, { vocabulary: new Set() }), 'data.summary').obj.dict, true);
});

test('a wide map keyed by data folds with a vocabulary, and so does a record with one data key', () => {
  const body = {
    data: {
      byNamespace: sentinels(DATA_KEYS),
      // Twenty-nine keys the source spells and one it never does: not a record.
      mixed: sentinels([...FIELDS.slice(0, 29), 'POISONKEY'])
    }
  };
  const shape = shapeOfValue(body, { vocabulary: VOCABULARY });
  for (const p of ['data.byNamespace', 'data.mixed']) assert.equal(shapeAt(shape, p).obj.dict, true, `${p} is a map`);

  const { text } = renderShape(shape, { maxLines: 1000 });
  assert.ok(!text.includes('"field0"'), text);
  assert.deepEqual(leaksIn(text), []);
});

test('a key that is not an identifier folds whatever the vocabulary holds', () => {
  const hosts = { 'POISON.host.example': { requests: 1 }, 'POISON-gw:443': { requests: 2 } };
  // Even a vocabulary that names the keys outright: no identifier is spelled like a host.
  const vocabulary = new Set([...VOCABULARY, ...Object.keys(hosts), 'requests', 'POISON-ns/pod']);

  const small = shapeOfValue({ byHost: hosts }, { vocabulary });
  assert.equal(shapeAt(small, 'byHost').obj.dict, true);
  // A wide record the vocabulary spells, plus one key no identifier could be.
  const wide = shapeOfValue({ summary: { ...sentinels(FIELDS), 'POISON-ns/pod': 1 } }, { vocabulary });
  assert.equal(shapeAt(wide, 'summary').obj.dict, true);

  for (const s of [small, wide]) assert.deepEqual(leaksIn(renderShape(s, { maxLines: 1000 }).text), []);
});

test('an object of DICT_MIN_KEYS keys or fewer renders the same with a vocabulary as without', () => {
  // Keys no vocabulary here spells: at this width they print either way, as they always have.
  const keys = Array.from({ length: DICT_MIN_KEYS }, (_, i) => `node${i}`);
  const body = { rows: [sentinels(keys), sentinels(keys.slice(0, 3))], byIp: { '10.0.0.1': { pods: 1 } } };

  const plain = renderShape(shapeOfValue(body), { maxLines: 1000 }).text;
  for (const vocabulary of [VOCABULARY, new Set(), new Set(keys)]) {
    assert.equal(renderShape(shapeOfValue(body, { vocabulary }), { maxLines: 1000 }).text, plain);
  }
  assert.ok(lineOf(plain, `node${DICT_MIN_KEYS - 1}`), plain);
  assert.ok(plain.includes('"<key>": {  // map keyed by data'), plain);
});

/* --------------------------------------------------------------------- what a fold said */

test('a value that is a list on some rows and a scalar on others says both', () => {
  const { text } = renderShape(shapeOfValue({ rows: [{ v: [] }, { v: 3 }, { v: null }, { v: 'x' }] }));
  assert.equal(lineOf(text, 'v').trim(), '"v": []  // empty on this read; or null; or number | string');
});

test('a wide summary that carries its completeness lists is not "empty on this read"', () => {
  // The cost summary: 37 fields and the two completeness lists, empty because the read was whole.
  // Folded, it rendered as one `"<key>": []` "empty on this read", and the capture listed
  // `data.summary.<key>[]` as an empty list, because inside a map the key names are gone.
  const summary = { ...sentinels(FIELDS), unavailable: [], truncated: [] };
  const vocabulary = new Set([...VOCABULARY, 'unavailable', 'truncated']);

  const shape = shapeOfValue({ data: { summary } }, { vocabulary });
  const capture = captureOf(shapeAt(shape, 'data'), { prefix: 'data' });
  assert.deepEqual(capture.emptyLists, [], 'an empty unavailable[] is the good case, not an empty panel');
  assert.equal(capture.leaves, 30);
  assert.equal(lineOf(renderShape(shape).text, 'field1').trim(), '"field1": "number",');

  // Without a vocabulary it still folds, and the fold names every type it merged.
  const folded = renderShape(shapeOfValue({ data: { summary } })).text;
  assert.ok(folded.includes('"<key>": []  // map keyed by data; empty on this read; or string | number'), folded);
});

/* -------------------------------------------------------------------------------- values */

/** A wrapper whose every string is a sentinel, carrying each kind of wide object the rule meets. */
function poisoned() {
  return {
    cluster: { id: 'POISON-cluster' },
    ok: true,
    data: {
      summary: sentinels(FIELDS),
      rows: [sentinels(FIELDS), sentinels(FIELDS.slice(0, 26)), sentinels(FIELDS.slice(0, 3))],
      byNamespace: sentinels(DATA_KEYS),
      mixed: sentinels([...FIELDS.slice(0, 29), 'POISONKEY']),
      byHost: { 'POISON.host.example': sentinels(FIELDS) }
    }
  };
}

test('no value, and no key of a folded map, reaches the rendering or the capture (sentinel proof)', () => {
  const body = poisoned();
  // The fixture really carries both sentinels, so "none found" below is not true by accident.
  assert.deepEqual(leaksIn(JSON.stringify(body)), ['POISON', String(NUMBER)]);

  const shape = shapeOfValue(body, { vocabulary: VOCABULARY });
  const { text, folded } = renderShape(shape, { maxLines: 1000 });
  assert.equal(folded, false, 'a fold would hide part of the payload from this proof');
  assert.deepEqual(leaksIn(text), [], 'the rendering carries a value');
  assert.deepEqual(leaksIn(JSON.stringify(captureOf(shape))), [], 'the capture carries a value');

  // The proof covers records the vocabulary unfolded, not only maps that folded.
  assert.equal(shapeAt(shape, 'data.summary').obj.dict, false);
  assert.equal(shapeAt(shape, 'data.rows[]').obj.dict, false);
  assert.ok(lineOf(text, 'field29'), text);
  assert.ok(text.includes('"<key>"'), text);
});

test('the sentinel check sees a leak when there is one (canary)', () => {
  const { text } = renderShape(shapeOfValue(poisoned(), { vocabulary: VOCABULARY }), { maxLines: 1000 });
  assert.deepEqual(leaksIn(`${text} "POISON-3"`), ['POISON']);
  assert.deepEqual(leaksIn(`${text} "POISONKEY0": {}`), ['POISON']);
  assert.deepEqual(leaksIn(`${text} ${NUMBER}`), [String(NUMBER)]);
});

test('a Helm release\'s overrides, values and defaults are recorded, never entered', () => {
  // A chart's operator chose these keys: a team or customer name can sit in one, in any case, and
  // with fewer keys than DICT_MIN_KEYS nothing else would fold them.
  const chartKeys = () => ({ POISONTeamGroup: { POISONmember: [] }, POISONlower: true, POISON_UPPER: 1 });
  const body = { data: { releases: [{ name: 'POISON-r', overrides: chartKeys(), values: chartKeys(), defaults: chartKeys() }] } };
  const vocabulary = new Set([...VOCABULARY, 'releases', 'name', 'overrides', 'values', 'defaults']);
  const shape = shapeOfValue(body, { vocabulary });
  const { text } = renderShape(shape, { maxLines: 1000 });
  assert.deepEqual(leaksIn(text), [], text);
  assert.deepEqual(leaksIn(JSON.stringify(captureOf(shape))), [], 'the capture names a key inside one');
  for (const k of ['overrides', 'values', 'defaults']) assert.ok(lineOf(text, k), `${k} is not recorded:\n${text}`);
});

/* ------------------------------------------------------------------ author-written maps */

/** The invented names below: a chart author's or an operator's, never a word the source spells. */
const ACME = /acme/i;

/** A map whose author chose its keys. Plain identifiers, so only OPAQUE keeps them off the page. */
const authored = () => ({ AcmeTeamGroup: { members: [], owner: null }, acmeRegion: 'POISON-eu', ACME_FLAG: NUMBER });

/** Every key name a shape holds, at any depth: whatever a reader of the shape could print. */
function keysHeld(s, out = new Set()) {
  if (!s) return out;
  if (s.obj) {
    for (const [k, child] of s.obj.keys) keysHeld(child, out.add(k));
    keysHeld(s.obj.value, out);
  }
  if (s.arr) keysHeld(s.arr.elem, out);
  return out;
}

/** Where an invented name, or any value, surfaced from `body`: each place is one entry. */
function surfaced(body, opts) {
  const shape = shapeOfValue(body, opts);
  const { text } = renderShape(shape, { maxLines: 1000 });
  const capture = captureOf(shape);
  return [
    ACME.test(text) && 'rendering',
    [...capture.emptyLists, ...capture.nullLeaves].some(p => ACME.test(p)) && 'path list',
    // `--json-out` prints these, with no line budget to fold anything.
    fieldsOf(shape).some(f => ACME.test(f.path)) && 'field paths',
    [...keysHeld(shape)].some(k => ACME.test(k)) && 'shape',
    leaksIn(text + JSON.stringify(capture)).length > 0 && 'value'
  ].filter(Boolean);
}

test('no key under an OPAQUE key reaches the rendering, a path list or the shape, even in a map', () => {
  // Read from OPAQUE and named too, so a key dropped from the set fails here rather than passing.
  const keys = new Set([...OPAQUE, 'overrides', 'values', 'defaults', 'parameters']);
  const leaks = [];
  for (const key of keys) {
    const nested = { data: { row: { [key]: authored() } } };
    // Row one records the key. Row two is wide and keyed by data, so the row path turns into a
    // map after the key was recorded, and row two's copy of the key merges into that map's value.
    const turned = { data: { items: [{ name: 'POISON-a', [key]: authored() }, { ...sentinels(DATA_KEYS), [key]: authored() }] } };
    // A map keyed by data from its first row: a key that is not an identifier folds the object at
    // any width, and a record row merged into a map already made carries its key into the map.
    const mapped = { data: { row: { 'POISON-ns': NUMBER, [key]: authored() } } };
    const mapFirst = { data: { items: [sentinels(DATA_KEYS), { name: 'POISON-a', [key]: authored() }] } };
    for (const [label, body] of Object.entries({ nested, turned, mapped, mapFirst })) {
      for (const where of surfaced(body, { vocabulary: VOCABULARY })) leaks.push(`${key} ${label}: ${where}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test('a Gatekeeper constraint\'s parameters are recorded, never entered, in the structure and the field paths', () => {
  // A policy's author chose these keys (allowed registries, required probes): lowercase
  // identifiers, fewer than DICT_MIN_KEYS, so nothing but OPAQUE folds them.
  const body = { data: { policies: [
    { name: 'POISON-p', parameters: { acmeAllowedRepos: ['POISON-r'], acmeRequiredProbes: NUMBER } },
    { name: 'POISON-q', parameters: null }
  ] } };
  const shape = shapeOfValue(body, { vocabulary: new Set([...VOCABULARY, 'policies', 'name', 'parameters']) });
  const { text } = renderShape(shape, { maxLines: 1000 });
  const fields = fieldsOf(shape);
  assert.deepEqual(fields.filter(f => ACME.test(f.path) || leaksIn(f.path).length), [], JSON.stringify(fields));
  assert.ok(!ACME.test(text) && leaksIn(text).length === 0, text);
  assert.equal(lineOf(text, 'parameters').trim(), `"parameters": { "<key>": "…" }  // or null; written by the object's author; not entered`);
  assert.deepEqual(fields.find(f => f.path === 'data.policies[].parameters'), { path: 'data.policies[].parameters', type: 'map' });
});

test('the author-written checks see a name when one surfaces (canary)', () => {
  // The same map under a key that is not OPAQUE is entered, and each check reports it.
  assert.deepEqual(surfaced({ data: { row: { settings: authored() } } }), ['rendering', 'path list', 'field paths', 'shape']);
  // keysHeld walks list elements and a map's merged value, where the turned case hides its keys.
  // `authored()` mixes cases, so it is a record there: an object of capitalised keys alone folds.
  assert.ok(keysHeld(shapeOfValue({ a: [{ b: authored() }] })).has('AcmeTeamGroup'));
  assert.ok(keysHeld(shapeOfValue({ m: { 'x-y': authored() } })).has('AcmeTeamGroup'));
});

/* ---------------------------------------------- maps keyed by data the vocabulary cannot see */

test('an object whose every key opens with a capital is a map keyed by data: a phase, a QoS class, a Kind', () => {
  // `/clusters/:id` counts pods by phase and `/clusters/:id/capacity` by QoS class; both keep the
  // value Kubernetes wrote as the key, and a Kind map adds whatever CRD a cluster installed.
  const body = {
    phases: { Running: 3, Succeeded: 1 },
    qos: { Burstable: 2, BestEffort: 1 },
    kinds: { Deployment: 4, POISONWidget: 2 },
    // One lowercase key and it is a record again, as a chart's mixed-case keys are.
    mixed: { Running: 1, total: 1 }
  };
  const shape = shapeOfValue(body, { vocabulary: new Set(['phases', 'qos', 'kinds', 'mixed', 'total']) });
  const { text } = renderShape(shape, { maxLines: 100 });
  for (const k of ['Succeeded', 'Burstable', 'BestEffort', 'Deployment', 'POISONWidget']) assert.ok(!text.includes(k), `${k} printed:\n${text}`);
  for (const k of ['phases', 'qos', 'kinds']) assert.equal(shape.obj.keys.get(k).obj.dict, true, `${k} is not a map`);
  assert.equal(shape.obj.keys.get('mixed').obj.dict, false);
  assert.ok(lineOf(text, 'total'), text);
});

test('a key that is a registered cluster id folds its object, though the id is a plain word', () => {
  // `/summary` keys `perCluster` by cluster id. Two dash-free ids are identifiers, fewer than
  // DICT_MIN_KEYS, and a vocabulary built from source cannot know them.
  const body = { perCluster: { poisonalpha: { health: 'ok' }, poisonbeta: { health: 'ok' } } };
  const vocabulary = new Set(['perCluster', 'health']);
  const blind = renderShape(shapeOfValue(body, { vocabulary })).text;
  assert.ok(blind.includes('poisonbeta'), 'canary: without the ids the map reads as a record');
  const { text } = renderShape(shapeOfValue(body, { vocabulary, dataKeys: new Set(['poisonalpha', 'poisonbeta']) }));
  assert.deepEqual(leaksIn(text), [], text);
  assert.ok(lineOf(text, '<key>'), text);
});

test('an author-written map that some rows leave null says so', () => {
  // `nodeSelector` is null on most pods, and the structure is all a reader has to go on.
  const { text } = renderShape(shapeOfValue({ pods: [{ nodeSelector: { 'POISON-a': 'b' } }, { nodeSelector: null }] }));
  assert.equal(lineOf(text, 'nodeSelector').trim(), `"nodeSelector": { "<key>": "…" }  // or null; written by the object's author; not entered`);
  assert.deepEqual(leaksIn(text), [], text);
});

test('fieldsOf lists the paths the structure prints: a map as "<key>", an author-written map as one entry', () => {
  const shape = shapeOfValue({
    items: [{ name: 'a', ports: [80], labels: { 'POISON-l': 'v' }, owner: { kind: 'x' } }],
    byNamespace: { 'POISON-ns': { pods: 1 } },
    events: []
  });
  assert.deepEqual(fieldsOf(shape), [
    { path: 'byNamespace', type: 'map' },
    { path: 'byNamespace.<key>', type: 'object' },
    { path: 'byNamespace.<key>.pods', type: 'number' },
    { path: 'events[]', type: 'array(empty)' },
    { path: 'items[]', type: 'array(object)' },
    { path: 'items[].labels', type: 'map' },
    { path: 'items[].name', type: 'string' },
    { path: 'items[].owner', type: 'object' },
    { path: 'items[].owner.kind', type: 'string' },
    { path: 'items[].ports[]', type: 'array(number)' }
  ]);
});

/* ------------------------------------------------------------------ the real collectors */

let fromSource;
/** The vocabulary api-digest.js passes: every identifier srv/fleet and app/fleet-ui/src spell. */
const sourceVocabulary = () => (fromSource ??= identifiersOf([...collectorFiles(), ...uiFiles()]));

/**
 * Fold `body` both ways and hold each path to the rule. With the source's vocabulary the path is a
 * record wider than DICT_MIN_KEYS, so the count alone folds it; without one it sits in a map, at
 * the path itself or at an ancestor that folded first (`shapeAt` answers null inside a map).
 */
function assertRecords(label, body, paths) {
  const without = shapeOfValue(body);
  const withVocabulary = shapeOfValue(body, { vocabulary: sourceVocabulary() });
  for (const p of paths) {
    const record = shapeAt(withVocabulary, p);
    assert.equal(record?.obj?.dict, false, `${label} ${p}: a key the source does not spell folded it`);
    assert.ok(record.obj.keys.size > DICT_MIN_KEYS, `${label} ${p}: only ${record.obj.keys.size} keys`);
    const folded = shapeAt(without, p);
    assert.ok(!folded || folded.obj?.dict, `${label} ${p}: a record without a vocabulary`);
  }
}

test('node, workload, ingress and cost records print every field with the source\'s vocabulary', async () => {
  assert.ok(sourceVocabulary().size > 1000, `the vocabulary holds only ${sourceVocabulary().size} identifiers`);
  await withRouter({}, async ({ get }) => {
    const answers = {
      // Node rows (collectors/health.js): the cluster route, the roster and the overview bundle.
      '/clusters/platformsbx': ['data.nodes.items[]'],
      '/clusters': ['clusters[].data.nodes.items[]'],
      '/clusters/platformsbx/overview': ['data.health.nodes.items[]', 'data.workloads.items[]'],
      // Workload rows (collectors/workloads.js), per cluster and flattened fleet-wide.
      '/clusters/platformsbx/workloads': ['data.items[]'],
      '/workloads': ['items[]'],
      // The ingress block and its summary (collectors/traffic.js).
      '/clusters/platformsbx/traffic-errors': ['data.ingress', 'data.ingress.summary'],
      // The cost summary (collectors/cost.js), per cluster and on the roster.
      '/clusters/platformsbx/cost': ['data.summary'],
      '/cost': ['clusters[].data.summary']
    };
    for (const [url, paths] of Object.entries(answers)) {
      const res = await get(url);
      assert.equal(res.status, 200, url);
      assertRecords(url, res.body, paths);
    }

    // A map keyed by data in the same answers stays one: Secret types are not identifiers.
    const security = await get('/clusters/platformsbx/security');
    const shape = shapeOfValue(security.body, { vocabulary: sourceVocabulary() });
    assert.equal(shapeAt(shape, 'data.secretTypeDistribution').obj.dict, true);
  });
});

test('trace rows, their hops and one trace print every field with the source\'s vocabulary', async () => {
  // dev-fixtures.js serves application log lines, not Envoy access-log records, so its window
  // stitches no journey. One request logged by two proxies, the gateway and the workload it routed
  // to, is the least that stitches one.
  const at = ms => new Date(Date.now() - 60_000 + ms).toISOString();
  const line = fields => JSON.stringify({
    response_code: 200, method: 'GET', path: '/api/orders', authority: 'shop.example.com', protocol: 'HTTP/1.1',
    start_time: at(0), duration: 150, upstream_service_time: '100', response_flags: '-', request_id: 'req-1',
    downstream_remote_address: '10.42.0.9:38210', downstream_local_address: '10.42.0.21:8080',
    upstream_host: '10.42.0.21:8080', upstream_cluster: 'outbound|8080||orders.shop.svc.cluster.local',
    ...fields
  });
  const pod = (name, namespace, ip, labels = {}) => ({
    metadata: { name, namespace, labels },
    spec: { containers: [{ name: 'app' }, { name: 'istio-proxy' }] },
    status: { phase: 'Running', podIP: ip }
  });
  const pods = [
    pod('istio-ingressgateway-1', 'istio-system', '10.42.0.5', { app: 'istio-ingressgateway' }),
    pod('orders-1', 'shop', '10.42.0.21')
  ];
  const listFn = async ({ path }) => {
    if (path.startsWith('/api/v1/pods')) return pods;
    if (path.startsWith('/api/v1/services')) return [{ metadata: { name: 'orders', namespace: 'shop' }, spec: { clusterIP: '10.43.0.10' } }];
    return [];
  };
  const textFn = async ({ path }) => {
    if (path.includes('/pods/istio-ingressgateway-1/log')) return `${line({})}\n`;
    if (path.includes('/pods/orders-1/log')) return `${line({ start_time: at(10), duration: 120, downstream_remote_address: '10.42.0.5:40000' })}\n`;
    throw Object.assign(new Error(`no log stub for ${path}`), { status: 404 });
  };

  await withRouter({ listFn, textFn }, async ({ get }) => {
    const list = await get('/clusters/platformsbx/traces');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.traces.length, 1, 'the stub window must stitch one journey');
    assertRecords('/traces', list.body, ['data.traces[]', 'data.traces[].hops[]']);

    const one = await get(`/clusters/platformsbx/traces/${encodeURIComponent(list.body.data.traces[0].traceId)}`);
    assert.equal(one.status, 200);
    assertRecords('/traces/:traceId', one.body, ['data.trace', 'data.trace.hops[]']);
  });
});
