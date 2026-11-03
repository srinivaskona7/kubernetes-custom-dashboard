/**
 * The API digest's pure modules, each held to the property it exists for.
 *
 *   - api-digest-shape.js folds a response into a skeleton that holds no value. The sentinel test
 *     is the privacy proof: every string in the payload is `POISON-n` and every number 424242, and
 *     neither may reach the rendering or the capture counts.
 *   - api-digest-source.js tells strings, templates, regular expressions and comments apart, and
 *     the other two read source through it. A `/*` inside a string must not hide the code after
 *     it, and a comment must never pass for code.
 *   - api-digest-trace.js turns the dev server's trace lines into runnable path templates. A segment
 *     survives only when srv/fleet quotes it, so a pod or a customer namespace comes out as `{name}`
 *     or `{namespace}`.
 *   - api-digest-console.js reads app/fleet-ui/src with regexes. The hermetic tree pins its rules;
 *     the real-tree tests pin the conventions it depends on, so a refactor it cannot read fails
 *     here instead of quietly emptying the digest's "used by" column.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { OPAQUE, SKIP, ENVELOPE_KEYS, DICT_MIN_KEYS, shapeOfValue, renderShape, captureOf, shapeAt } =
  _api_digest_shapeModule;
import _api_digest_source from '../tools/api-digest-source.js';
const { scanSource, unescapeLiteral } = _api_digest_source;
const { codeLiterals, literalsOf, templatePath, readTraceSince, summariseReads } =
  _api_digest_traceModule;
const { consoleUsage, apiFunctions, normaliseTemplate, matchRoute, collapseViews, listSources, stripComments } =
  _api_digest_consoleModule;
import _api_digest2 from '../tools/api-digest.js';
const { collectorFiles } = _api_digest2;
import _router_harness3 from './helpers/router-harness.js';
import _api_digest_shapeModule from '../tools/api-digest-shape.js';
import _api_digest_traceModule from '../tools/api-digest-trace.js';
import _api_digest_consoleModule from '../tools/api-digest-console.js';
const { withRouter, listRoutes } = _router_harness3;

const __dirname = import.meta.dirname;

const UI = path.join(__dirname, '../..', 'app/fleet-ui/src');
const FLEET = path.join(__dirname, '..');

/** A disposable directory holding `files` (relative path -> text), removed once `fn` returns. */
function withTree(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-digest-modules-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The rendered line that declares `key`, e.g. `      "restarts": "number | null",`. */
const lineOf = (text, key) => text.split('\n').find(l => l.trimStart().startsWith(`${JSON.stringify(key)}:`));

/* ------------------------------------------------------------------------------ shape */

const NUMBER = 424242;

/** Key names the data's author chose. Each must stay off the page like any value. */
const SENTINEL_KEYS = [
  '10.0.0.1', 'node-a.b.c', 'POISON-LABEL', 'POISONLABEL', 'POISONANNOTATION', 'POISONSELECTOR',
  'POISONSECRET', 'POISON.tls.key', 'POISONFIELD', ...Array.from({ length: 30 }, (_, i) => `POISONKEY${i}`)
];

/**
 * A wrapper envelope whose every string is a sentinel and every number 424242, carrying each road a
 * value could take onto the page: rows with optional keys, a map keyed by non-identifier keys, one
 * with more than DICT_MIN_KEYS identifier keys, and the author-keyed maps (labels, annotations, a
 * selector, a nested Secret `data`, managedFields) whose key names are sentinels too.
 */
function poisoned() {
  const s = n => `POISON-${n}`;
  const byWorkload = {};
  for (let i = 0; i < 30; i += 1) byWorkload[`POISONKEY${i}`] = { pods: NUMBER, owner: s(100 + i) };
  return {
    cluster: { id: s(1), displayName: s(2) },
    ok: true,
    collectedAt: s(3),
    data: {
      summary: { total: NUMBER, window: s(4), unavailable: [{ scope: s(5) }], truncated: [] },
      items: [
        { name: s(10), namespace: s(11), restarts: NUMBER, ready: true, image: s(12) },
        { name: s(13), namespace: s(14), restarts: NUMBER, ready: false, node: s(15) },
        { name: s(16), namespace: s(17), restarts: null, ready: true, image: null }
      ],
      byNode: { '10.0.0.1': { pods: NUMBER, zone: s(20) }, 'node-a.b.c': { pods: NUMBER, zone: s(21) } },
      byWorkload,
      secrets: [
        {
          name: s(30),
          metadata: {
            labels: { 'POISON-LABEL': s(31), POISONLABEL: s(32) },
            annotations: { POISONANNOTATION: s(33) },
            managedFields: [{ manager: s(34), fieldsV1: { POISONFIELD: {} } }]
          },
          selector: { POISONSELECTOR: s(35) },
          data: { POISONSECRET: s(36), 'POISON.tls.key': s(37) }
        }
      ]
    }
  };
}

/** Every sentinel, value or key, that `text` carries. */
const leaksIn = text => ['POISON', String(NUMBER), ...SENTINEL_KEYS].filter(x => text.includes(x));

test('no value from a response reaches the rendering or the capture (sentinel proof)', () => {
  const bodies = {
    wrapper: poisoned(),
    roster: { summary: { clusters: NUMBER, unavailable: [], truncated: [] }, clusters: [poisoned(), poisoned()] }
  };
  for (const [name, body] of Object.entries(bodies)) {
    // The fixture really carries every sentinel, so "none found" below is not true by accident.
    assert.equal(leaksIn(JSON.stringify(body)).length, 2 + SENTINEL_KEYS.length);

    const shape = shapeOfValue(body);
    const { text, folded } = renderShape(shape, { maxLines: 1000 });
    assert.equal(folded, false, 'a fold would hide part of the payload from this proof');
    assert.deepEqual(leaksIn(text), [], `${name}: the rendering carries a value`);
    assert.deepEqual(leaksIn(JSON.stringify(captureOf(shape))), [], `${name}: the capture carries a value`);

    // The payload was entered, so the proof covers its rows and maps, not an unread envelope.
    for (const key of ['items', 'image', 'byNode', 'byWorkload', 'secrets', 'labels', 'selector', '<key>']) {
      assert.ok(text.includes(`"${key}"`), `${name}: "${key}" should be rendered`);
    }
    for (const key of SKIP) assert.ok(!text.includes(key), `${name}: ${key} is dropped, not rendered`);
  }
});

test('the sentinel check sees a leak when there is one (canary)', () => {
  const { text } = renderShape(shapeOfValue(poisoned()), { maxLines: 1000 });
  assert.deepEqual(leaksIn(`${text} "POISON-3"`), ['POISON']);
  assert.deepEqual(leaksIn(`${text} ${NUMBER}`), [String(NUMBER)]);
  assert.deepEqual(leaksIn(`${text} "node-a.b.c": {}`), ['node-a.b.c']);
});

test('a map keyed by data prints one "<key>" entry, whichever rule found it', () => {
  // Any key that is not a plain identifier: node addresses, dotted names.
  const byIp = { byIp: { '10.0.0.1': { pods: 1 }, 'node-a.b.c': { pods: 2 } } };
  assert.equal(renderShape(shapeOfValue(byIp)).text, [
    '{',
    '  "byIp": {',
    '    "<key>": {  // map keyed by data',
    '      "pods": "number"',
    '    }',
    '  }',
    '}'
  ].join('\n'));

  // More than DICT_MIN_KEYS identifier keys is a map too; exactly DICT_MIN_KEYS is still a record.
  const keys = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`node${i}`, i]));
  assert.equal(
    renderShape(shapeOfValue({ wide: keys(DICT_MIN_KEYS + 1) })).text,
    ['{', '  "wide": {', '    "<key>": "number"  // map keyed by data', '  }', '}'].join('\n')
  );
  const record = renderShape(shapeOfValue({ wide: keys(DICT_MIN_KEYS) })).text;
  assert.ok(!record.includes('<key>'), record);
  assert.ok(record.includes(`"node${DICT_MIN_KEYS - 1}": "number"`), record);

  // Once a path is a map it stays one, and drops the keys an earlier row printed.
  const rows = { rows: [{ m: { ready: 1 } }, { m: { 'node-a.b.c': 2 } }, { m: { ready: 3 } }] };
  const text = renderShape(shapeOfValue(rows)).text;
  assert.ok(!text.includes('"ready"'), text);
  assert.ok(text.includes('"<key>": "number"  // map keyed by data'), text);
});

test('author-keyed maps are recorded and never entered; only the envelope data is the payload', () => {
  for (const key of OPAQUE) {
    const shape = shapeOfValue({ data: { row: { [key]: { inner: 1 } } } });
    const at = shapeAt(shape, `data.row.${key}`);
    assert.ok(at?.opaque, `${key} is recorded as opaque`);
    assert.equal(at.obj, null, `${key} is not entered`);
    const { text } = renderShape(shape);
    assert.ok(text.includes(`"${key}": { "<key>": "…" }  // written by the object's author; not entered`), text);
    assert.ok(!text.includes('inner'), `${key}: a key inside it reached the page`);
  }

  // The envelope's own `data` is the payload: at the root of a wrapper, and on a roster entry.
  const wrapper = shapeOfValue({ cluster: { id: 'c1' }, ok: true, data: { items: [{ name: 'a' }] } });
  assert.equal(shapeAt(wrapper, 'data').opaque, false);
  assert.ok(shapeAt(wrapper, 'data.items[].name'), 'the wrapper payload is entered');
  const roster = shapeOfValue({ summary: {}, clusters: [{ cluster: { id: 'c1' }, ok: true, data: { nodes: { total: 3 } } }] });
  assert.ok(shapeAt(roster, 'clusters[].data.nodes.total'), 'a roster entry payload is entered');

  // Anywhere deeper, `data` is a Secret's or a ConfigMap's again, under a nested clusters[] too.
  const nested = shapeOfValue({ data: { clusters: [{ data: { apiKey: 'x' } }], items: [{ data: { apiKey: 'x' } }] } });
  for (const p of ['data.clusters[].data', 'data.items[].data']) {
    assert.ok(shapeAt(nested, p)?.opaque, `${p} is opaque`);
    assert.equal(shapeAt(nested, p).obj, null, `${p} is not entered`);
  }
});

test('the comments say what a type alone cannot: optional, or null, empty on this read', () => {
  const { text } = renderShape(shapeOfValue({
    rows: [
      { name: 'a', owner: { kind: 'x' }, tags: ['t'], events: [], note: 'n' },
      { name: 'b', owner: null, tags: null, events: [], note: null, extra: 1 }
    ]
  }));
  assert.equal(lineOf(text, 'name').trim(), '"name": "string",');
  assert.equal(lineOf(text, 'owner').trim(), '"owner": {  // or null');
  assert.equal(lineOf(text, 'tags').trim(), '"tags": [ "string" ],  // or null');
  assert.equal(lineOf(text, 'events').trim(), '"events": [],  // empty on this read');
  // A scalar that is sometimes null says so in its type; the note is for objects and lists.
  assert.equal(lineOf(text, 'note').trim(), '"note": "string | null",');
  assert.equal(lineOf(text, 'extra').trim(), '"extra": "number"  // optional');
});

test('a rendering longer than maxLines folds its deepest objects and says what it hid', () => {
  const leaf = { a: 1, b: 2, c: 3 };
  const mid = { f0: leaf, f1: leaf, f2: leaf, f3: leaf, f4: leaf };
  const shape = shapeOfValue({ data: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, mid])) });

  const full = renderShape(shape, { maxLines: 10_000 });
  assert.equal(full.folded, false);
  assert.ok(!full.text.includes('…'));
  assert.ok(full.text.split('\n').length > 40, 'the fixture must need folding at 40 lines');

  const short = renderShape(shape, { maxLines: 40 });
  assert.equal(short.folded, true);
  assert.ok(short.text.split('\n').length <= 40, short.text);
  assert.ok(short.text.includes('"k0": { "…": "5 fields" },'), short.text);
});

test('captureOf counts the payload and leaves the envelope out', () => {
  const shape = shapeOfValue({
    cluster: { id: 'c1' },
    ok: true,
    collectedAt: 't',
    summary: { total: 3, unavailable: [{ scope: 's' }], truncated: [] },
    items: [
      { name: 'a', ok: true, owner: null, tags: ['x'], events: [] },
      { name: 'b', ok: false, owner: null, tags: [], events: [] }
    ],
    labels: { app: 'x' },
    nothing: null
  });
  // Leaves: summary.total, items[].name, items[].ok (an envelope key below the top is payload),
  // items[].owner, items[].tags[], labels (opaque, so one leaf) and nothing. Owner and nothing
  // never held a value. Lists: items, tags, events; events never had a row. The completeness
  // arrays under summary are skipped at any depth, or they would add a list and an empty one.
  assert.deepEqual(captureOf(shape), {
    leaves: 7,
    withValue: 5,
    lists: 3,
    populated: 2,
    emptyLists: ['items[].events[]'],
    nullLeaves: ['items[].owner', 'nothing']
  });

  const skipped = captureOf(shape, { skipTop: ['summary', 'labels'] });
  assert.deepEqual([skipped.leaves, skipped.withValue], [5, 3]);
  const nested = shapeOfValue({ summary: { n: 1 }, rows: [{ summary: { n: 2 } }] });
  assert.equal(captureOf(nested, { skipTop: ['summary'] }).leaves, 1, 'skipTop names top-level keys only');

  const envelope = Object.fromEntries([...ENVELOPE_KEYS].map(k => [k, 'x']));
  assert.equal(captureOf(shapeOfValue(envelope)).leaves, 0, 'no envelope key at the top is payload');
  assert.equal(
    captureOf(shapeOfValue({ rows: [envelope] })).leaves,
    ENVELOPE_KEYS.size - 2,
    'below the top they are payload, all but unavailable and truncated'
  );
});

test('shapeAt returns the sub-shape at a dotted path, and null where there is none', () => {
  const shape = shapeOfValue({
    summary: { clusters: 2 },
    clusters: [
      { cluster: { id: 'c1' }, ok: null, data: null },
      { cluster: { id: 'c2' }, ok: true, data: { nodes: { total: 3 }, events: [] } }
    ]
  });
  const payload = shapeAt(shape, 'clusters[].data');
  assert.deepEqual([...payload.obj.keys.keys()], ['nodes', 'events']);
  assert.ok(payload.types.has('null'), 'the unread entry is part of the same sub-shape');
  assert.equal(renderShape(payload).text.split('\n')[0], '{  // or null');
  assert.deepEqual(captureOf(payload, { prefix: 'clusters[].data' }).emptyLists, ['clusters[].data.events[]']);
  assert.ok(shapeAt(shape, 'clusters[].data.nodes.total').types.has('number'));

  for (const absent of ['clusters[].missing', 'summary.clusters.deeper', 'summary[]', 'nope']) {
    assert.equal(shapeAt(shape, absent), null, absent);
  }
});

/* ----------------------------------------------------------------------------- source */

test('scanSource: a "/*" inside a string is a string, and the code after it keeps its literals', () => {
  const lines = [
    "const rule = { path: input.path || '/*', methods: ['GET'] };",
    String.raw`const note = 'can\'t /* open'; const accept = '*/*'; const next = 'after-glob';`,
    '/* a block comment: "block-only" */',
    "const last = 'after-block'; // a trailing note: 'trailing-only'",
    // An empty string closes itself; its second quote does not open the next string.
    "const has = (name || '').includes('after-empty');",
    ''
  ];
  const { code, literals } = scanSource(lines.join('\n'));
  assert.deepEqual(literals, ['/*', 'GET', String.raw`can\'t /* open`, '*/*', 'after-glob', 'after-block', '', 'after-empty']);
  for (const kept of [lines[0], lines[1], "const last = 'after-block';", lines[4]]) {
    assert.ok(code.includes(kept), `${kept} is code`);
  }
  for (const prose of ['a block comment', 'block-only', 'a trailing note', 'trailing-only']) {
    assert.ok(!code.includes(prose), `${prose} is comment`);
  }
});

test('scanSource: a regular expression holding "/*", "//" or a quote is neither a string nor a comment', () => {
  const lines = [
    String.raw`const glob = /[/*'"]+/g; const afterClass = 'after-class';`,
    String.raw`const escaped = /^\/*api\/'/; const afterEscape = 'after-escape';`,
    "const slashes = /[//]+/g; const afterSlashes = 'after-slashes';",
    // After a keyword a slash starts a regular expression; after a name it divides.
    "const quoted = s => { return /\"/.test(s) ? 'has-quote' : 'no-quote'; };",
    "const ratio = total / 2; const afterDivision = 'after/division';",
    // After an operator it looks like a regular expression, but one that never closes on its line
    // was a division.
    "const half = i++ / 2; const afterPostfix = 'after-postfix';",
    "/* the one comment: 'comment-only' */",
    ''
  ];
  const { code, literals } = scanSource(lines.join('\n'));
  assert.deepEqual(literals,
    ['after-class', 'after-escape', 'after-slashes', 'has-quote', 'no-quote', 'after/division', 'after-postfix']);
  for (const kept of [String.raw`/[/*'"]+/g`, String.raw`/^\/*api\/'/`, '/[//]+/g', '/"/.test(s)', 'total / 2', 'i++ / 2']) {
    assert.ok(code.includes(kept), `${kept} is code`);
  }
  assert.ok(!code.includes('comment-only'), code);
});

test('scanSource: each static part of a nested template is its own literal', () => {
  const lines = [
    "const url = `/apis/${group}/namespaces/${ns ? `${ns}/pods` : 'all'}/x`;",
    'const tail = `/logs${qs({ limit: 500, pod })}/tail`;',
    "const issuer = `${String(base).replace(/\\/+$/, '')}/.well-known/openid-configuration`;",
    "const tick = `\\`${name}\\` is a backtick`;",
    "const after = 'after-templates';",
    ''
  ];
  const src = lines.join('\n');
  const { code, literals } = scanSource(src);
  assert.deepEqual(literals, [
    // A template inside a `${}`, and a string beside it.
    '/apis/', '/namespaces/', '/pods', 'all', '/x',
    // An object's braces inside a `${}` do not close it.
    '/logs', '/tail',
    // Nor does a regular expression or an empty string inside one.
    '', '/.well-known/openid-configuration',
    // An escaped backtick does not close the template.
    '\\`', '\\` is a backtick',
    'after-templates'
  ]);
  assert.equal(code, src, 'a source without comments comes back whole');
});

test('scanSource: a JSX closing tag is not a regular expression', () => {
  const lines = [
    `export const Cell = ({ label }) => <td className="cell">{label}</td>; const after = '/after-jsx';`,
    `export const Row = () => <><Cell label="x" /></>; const next = 'after-fragment';`,
    ''
  ];
  const src = lines.join('\n');
  const { code, literals } = scanSource(src);
  assert.deepEqual(literals, ['cell', '/after-jsx', 'x', 'after-fragment']);
  assert.equal(code, src, 'a source without comments comes back whole');
});

/* ------------------------------------------------------------------------------ trace */

test('codeLiterals keeps what the code quotes and nothing that prose mentions', () => {
  const lits = withTree({
    'collector.js': [
      "'use strict';",
      "// prose may name 'comment-only-ns' without vouching for it",
      '/* nor may a block comment: "block-only-ns" */',
      "const NS = 'quoted-ns';",
      'const logs = (ns, pod) => `/api/v1/namespaces/${ns}/pods/${pod}/log?container=static-container`;',
      "const SHOOT_INFO = '/api/v1/namespaces/kube-system/configmaps/shoot-info';",
      'module.exports = { NS, logs, SHOOT_INFO };',
      ''
    ].join('\n'),
    'collectors/nested.js': 'module.exports = "nested-literal";\n',
    'node_modules/dep/index.js': "module.exports = 'vendored-literal';\n",
    'README.md': "'markdown-literal'\n"
  }, codeLiterals);

  const kept = [
    'quoted-ns', 'nested-literal',
    // a template literal's static parts, and each piece of a path
    '/api/v1/namespaces/', '/log?container=static-container', 'static-container', 'kube-system', 'shoot-info'
  ];
  for (const lit of kept) assert.ok(lits.has(lit), `${lit} is quoted in code`);
  for (const lit of ['comment-only-ns', 'block-only-ns', 'vendored-literal', 'markdown-literal', 'ns', 'pod']) {
    assert.ok(!lits.has(lit), `${lit} is not a literal of the scanned code`);
  }
});

test('codeLiterals over srv/fleet reads the literals a regex reader lost', () => {
  // healthz and readyz follow a '/api/*' string in onboard.js, which a regex took for the start of a
  // block comment. ztunnel follows `|| ''` in collectors/mesh.js, whose closing quote a regex paired
  // with the next opening one. openid-configuration ends a template in router.js that holds a
  // regular expression inside its `${}`.
  const lits = codeLiterals(FLEET);
  for (const lit of ['ztunnel', 'healthz', 'readyz', 'openid-configuration']) assert.ok(lits.has(lit), `${lit} is quoted in srv/fleet`);
  // collectors/networking.js defaults an APIRule's path to '/*', and the rule's other fields follow it.
  const networking = literalsOf([path.join(FLEET, 'collectors/networking.js')]);
  for (const lit of ['/*', 'GET', 'noop']) assert.ok(networking.has(lit), `${lit} is quoted in collectors/networking.js`);
  // The digest outlines /report by its headings, written in router.js, one word at a time.
  for (const word of ['Kyma', 'Fleet', 'Audit', 'Health', 'Report', 'Summary', 'Completeness']) {
    assert.ok(lits.has(word), `${word} is a word of a /report heading`);
  }
});

test('literalsOf: a sentence vouches only for itself; a path, query or selector for each of its pieces', () => {
  const lits = withTree({
    'collector.js': [
      "'use strict';",
      "const FAILED = 'failed to read the backend database cache';",
      "const ISTIO = '/apis/networking.istio.io/v1';",
      "const ISTIOD = 'app=istiod';",
      'const logs = (ns, pod) => `/api/v1/namespaces/${ns}/pods/${pod}/log?container=discovery`;',
      'module.exports = { FAILED, ISTIO, ISTIOD, logs };',
      ''
    ].join('\n')
  }, dir => literalsOf([path.join(dir, 'collector.js')]));

  assert.ok(lits.has('failed to read the backend database cache'), 'a sentence is a literal, whole');
  for (const word of ['failed', 'backend', 'database', 'cache']) assert.ok(!lits.has(word), `${word} is only a word of a sentence`);
  for (const piece of ['apis', 'networking.istio.io', 'v1', 'app', 'istiod', 'log', 'container', 'discovery']) {
    assert.ok(lits.has(piece), `${piece} is a piece of a path, query or selector`);
  }

  // A namespace a message happens to name is still the cluster's.
  assert.equal(templatePath('/api/v1/namespaces/backend/pods?limit=500', lits).path, '/api/v1/namespaces/{namespace}/pods?limit=500');
  assert.equal(
    templatePath(`/apis/networking.istio.io/v1/namespaces/cache/gateways?labelSelector=${encodeURIComponent('app=istiod')}`, lits).path,
    '/apis/networking.istio.io/v1/namespaces/{namespace}/{resource}?labelSelector=app=istiod'
  );
});

test('literalsOf: a Markdown heading vouches for its capitalised words, which no namespace or pod name has', () => {
  const lits = withTree({
    'report.js': [
      "'use strict';",
      "const lines = () => ['# Fleet Health Report', `\\n## Cluster backend Summary`];",
      'module.exports = { lines };',
      ''
    ].join('\n')
  }, dir => literalsOf([path.join(dir, 'report.js')]));

  for (const word of ['Fleet', 'Health', 'Report', 'Cluster', 'Summary']) assert.ok(lits.has(word), `${word} is a heading word`);
  assert.ok(!lits.has('backend'), 'a lowercase word could be a name, heading or not');
});

/** `literalsOf` over one collector file holding `src`. */
const literalsFrom = src => withTree({ 'collector.js': src }, dir => literalsOf([path.join(dir, 'collector.js')]));

const SLOTS_SRC = [
  "'use strict';",
  "const LOG = '/dev/stdout';",
  "const SHOOT_INFO = '/api/v1/namespaces/kube-system/configmaps/shoot-info';",
  'const logs = (ns, pod) => `/api/v1/namespaces/${ns}/pods/${pod}/log?container=discovery`;',
  'const releases = name => `owner=helm,name=${name}`;',
  'module.exports = { LOG, SHOOT_INFO, logs, releases };',
  ''
].join('\n');

test('templatePath: `dev` or `api` as a namespace is the cluster\'s, unless a literal spells it whole or puts it after namespaces/', () => {
  const lits = literalsFrom(SLOTS_SRC);
  // Both are still pieces, so the privacy gate's vocabulary keeps them.
  for (const piece of ['dev', 'api', 'kube-system']) assert.ok(lits.has(piece), `${piece} is a piece of a literal path`);

  // '/dev/stdout' and '/api/v1/…' put `dev` and `api` first in a path, never after `namespaces/`.
  assert.equal(templatePath('/api/v1/namespaces/dev/pods?limit=500', lits).path, '/api/v1/namespaces/{namespace}/pods?limit=500');
  assert.equal(templatePath('/api/v1/namespaces/api/pods?limit=500', lits).path, '/api/v1/namespaces/{namespace}/pods?limit=500');
  assert.equal(templatePath('/api/v1/namespaces/kube-system/pods?limit=500', lits).path, '/api/v1/namespaces/kube-system/pods?limit=500');

  const spelled = literalsFrom("const NS = 'dev';\nconst LOG = '/dev/stdout';\nmodule.exports = { NS, LOG };\n");
  assert.equal(templatePath('/api/v1/namespaces/dev/pods?limit=500', spelled).path, '/api/v1/namespaces/dev/pods?limit=500');
});

test('templatePath: a piece keeps a name or a query value only where a literal puts it', () => {
  const lits = literalsFrom(SLOTS_SRC);
  const t = raw => templatePath(raw, lits).path;

  // `stdout` and `dev` are pieces of '/dev/stdout', a path segment: no name and no value.
  assert.equal(
    t('/api/v1/namespaces/kube-system/pods/stdout/log?container=stdout'),
    '/api/v1/namespaces/kube-system/pods/{name}/log?container={value}'
  );
  assert.equal(
    t(`/api/v1/namespaces/kube-system/secrets?labelSelector=${encodeURIComponent('owner=helm,name=dev')}`),
    '/api/v1/namespaces/kube-system/secrets?labelSelector=owner=helm,name={value}'
  );
  // A literal path names `shoot-info` where a name stands, and a literal query `discovery` where a value does.
  assert.equal(t('/api/v1/namespaces/kube-system/configmaps/shoot-info'), '/api/v1/namespaces/kube-system/configmaps/shoot-info');
  assert.equal(
    t('/api/v1/namespaces/kube-system/pods/istiod-7c9-x1/log?container=discovery'),
    '/api/v1/namespaces/kube-system/pods/{name}/log?container=discovery'
  );
});

test("the sweep's literals: `dev` and `api` are pieces of collector paths, and vouch for no namespace", () => {
  // traffic.js writes '/dev/stdout' and the collectors write '/api/v1/…'; none spells either word whole.
  const files = collectorFiles();
  assert.ok(files.length > 20, `collectorFiles found only ${files.length} files`);
  const lits = literalsOf(files);
  const whole = new Set(files.flatMap(f => scanSource(fs.readFileSync(f, 'utf8')).literals));
  for (const word of ['dev', 'api']) {
    assert.ok(lits.has(word) && !whole.has(word), `${word} is a piece of a collector literal, and no collector spells it whole`);
    assert.equal(templatePath(`/api/v1/namespaces/${word}/pods?limit=500`, lits).path, '/api/v1/namespaces/{namespace}/pods?limit=500');
  }
});

test('templatePath keeps what the code chose and replaces what the cluster supplied', () => {
  // Selector keys are in the set as well, so the selector cases turn on the values alone.
  const literals = new Set([
    'istio-system', 'discovery', 'app', 'istiod', 'tier', 'istio', 'ingressgateway', 'spec.nodeName',
    'apps', 'deployments', 'constraints.gatekeeper.sh'
  ]);
  const t = raw => templatePath(raw, literals);

  assert.deepEqual(
    t('/api/v1/namespaces/istio-system/pods/istiod-7c9-x1/log?container=discovery&tailLines=20'),
    { path: '/api/v1/namespaces/istio-system/pods/{name}/log?container=discovery&tailLines=20', cached: false }
  );
  assert.equal(t('/api/v1/namespaces/customer-payments/pods?limit=500').path, '/api/v1/namespaces/{namespace}/pods?limit=500');
  assert.equal(
    t('/api/v1/namespaces/istio-system/pods/gw-1:15000/proxy/stats').path,
    '/api/v1/namespaces/istio-system/pods/{name}:15000/proxy/stats'
  );
  const selector = encodeURIComponent('app=istiod,tier!=canary,istio in (ingressgateway,customer-gw)');
  assert.equal(
    t(`/api/v1/pods?labelSelector=${selector}`).path,
    '/api/v1/pods?labelSelector=app=istiod,tier!={value},istio in (ingressgateway,{value})'
  );
  assert.equal(
    t(`/api/v1/pods?fieldSelector=${encodeURIComponent('spec.nodeName=shoot-worker-1')}`).path,
    '/api/v1/pods?fieldSelector=spec.nodeName={value}'
  );
  assert.equal(t('/api/v1/pods?container=customer-app').path, '/api/v1/pods?container={value}');
  assert.deepEqual(
    t('HIT /api/v1/namespaces/istio-system/pods?limit=500'),
    { path: '/api/v1/namespaces/istio-system/pods?limit=500', cached: true }
  );
  assert.deepEqual(t('/apis/apps/v1/deployments?limit=500'), { path: '/apis/apps/v1/deployments?limit=500', cached: false });
  // A constraint's plural is the name an operator gave its template; a CRD's group is its installer's.
  assert.equal(
    t('/apis/constraints.gatekeeper.sh/v1beta1/deny-payments-egress?resourceVersion=0').path,
    '/apis/constraints.gatekeeper.sh/v1beta1/{resource}?resourceVersion=0'
  );
  assert.equal(t('/apis/billing.acme.example/v1alpha2/invoices').path, '/apis/{group}/v1alpha2/{resource}');
  assert.equal(t('/apis/apps/payments-v2/deployments').path, '/apis/apps/{version}/deployments');
  // A core plural is the apiserver's own word, spelled in the code or not.
  assert.equal(t('/api/v1/namespaces/istio-system/configmaps').path, '/api/v1/namespaces/istio-system/configmaps');
});

test('readTraceSince returns whole trace lines only and resumes where it stopped', () => {
  const a = { k8s: 'c1', path: '/api/v1/nodes', wait: 0, ms: 12, bytes: 3400, t: 1 };
  const b = { k8s: 'c1', path: 'HIT /api/v1/pods?limit=500', wait: 0, ms: 0, bytes: 0, t: 2 };
  const c = { k8s: 'c1', path: '/apis/apps/v1/deployments?limit=500', wait: 3, ms: 40, bytes: 9100, t: 3 };
  // The JSON log line and a line that only looks like the router's audit line are the dev
  // server's other output; neither parses. Its '→' and '…' make bytes differ from characters, so
  // an offset counted in characters would land inside the next line.
  const whole = `${JSON.stringify(a)}\n[fleet-audit] GET /clusters/c1/traffic → c1 … 200\n` +
    `{"level":"info","msg":"cache warm"}\n${JSON.stringify(b)}\n` +
    // The router's own audit lines: a request it finished, and a refusal, which is not one.
    '[fleet-audit] GET /api/fleet/clusters/c1/traffic?ns=a -> 200 (12ms) user=anonymous\n' +
    '[fleet-audit] DENIED GET /api/fleet/clusters: user=anonymous lacks kyma-fleet-admin\n';
  assert.notEqual(Buffer.byteLength(whole), whole.length);
  const pending = JSON.stringify(c);

  withTree({ 'trace.log': whole + pending.slice(0, 25) }, dir => {
    const file = path.join(dir, 'trace.log');
    const first = readTraceSince(file, 0);
    assert.deepEqual(first.lines, [a, b]);
    assert.deepEqual(first.requests, [{ method: 'GET', url: '/api/fleet/clusters/c1/traffic?ns=a' }], 'the identity after the URL is never read');
    assert.equal(first.offset, Buffer.byteLength(whole), 'the line still being written is left for the next read');

    fs.appendFileSync(file, `${pending.slice(25)}\n`);
    const second = readTraceSince(file, first.offset);
    assert.deepEqual(second.lines, [c]);
    assert.deepEqual(second.requests, []);
    assert.equal(second.offset, fs.statSync(file).size);

    assert.deepEqual(readTraceSince(file, second.offset), { lines: [], requests: [], offset: second.offset });
    assert.deepEqual(readTraceSince(path.join(dir, 'absent.log'), 7), { lines: [], requests: [], offset: 7 });
  });
});

test('unescapeLiteral reads a literal as it prints, and leaves an escape no string holds as written', () => {
  const bs = '\\';
  assert.equal(unescapeLiteral(`One cluster${bs}'s`), "One cluster's");
  assert.equal(unescapeLiteral(`a${bs}nb${bs}tc`), 'a\nb\tc');
  assert.equal(unescapeLiteral(`${bs}x41${bs}u0042${bs}u{43}`), 'ABC');
  assert.equal(unescapeLiteral(`${bs}${bs}n`), `${bs}n`, 'an escaped backslash is one backslash');
  assert.equal(unescapeLiteral(`one ${bs}\ntwo`), 'one two', 'a line continuation prints nothing');
  assert.equal(unescapeLiteral(`${bs}u{110000}`), `${bs}u{110000}`, 'past the last code point');
  // scanSource keeps what the source wrote, and the two compose to what the program prints.
  const { literals } = scanSource("const s = 'It\\'s the cluster\\'s';");
  assert.deepEqual(literals.map(unescapeLiteral), ["It's the cluster's"]);
});

test('summariseReads counts the reads of one cluster, deduplicated by template', () => {
  const lines = [
    { k8s: 'c1', path: '/api/v1/namespaces/team-a/pods?limit=500', bytes: 100 },
    { k8s: 'c1', path: '/api/v1/namespaces/team-b/pods?limit=500', bytes: 200 },
    // k8s.js traces a cache hit with bytes 0: nothing crossed the wire.
    { k8s: 'c1', path: 'HIT /api/v1/namespaces/team-a/pods?limit=500', bytes: 0 },
    { k8s: 'c1', path: '/api/v1/namespaces/x/serviceaccounts/y/token', bytes: 50 },
    { k8s: 'c1', path: '/api/v1/nodes', bytes: 300 },
    { k8s: 'c2', path: '/api/v1/nodes', bytes: 999 },
    { k8s: 'c2', path: '/api/v1/namespaces/x/serviceaccounts/y/token', bytes: 50 }
  ];
  assert.deepEqual(summariseReads(lines, 'c1', literalsOf([])), {
    reads: [
      // Two namespaces and a cache hit are one read: two calls reached the cluster, one did not.
      { path: '/api/v1/namespaces/{namespace}/pods?limit=500', calls: 3, live: 2 },
      { path: '/api/v1/nodes', calls: 1, live: 1 }
    ],
    calls: 4,
    cachedCalls: 1,
    bytes: 600,
    // Token minting is the renewer's, not the route's, and c2's lines are not c1's.
    bookkeeping: 1
  });
});

test('summariseReads refuses a Set that does not say where its pieces stood (canary)', () => {
  // A copy keeps the members and drops `whole` and `at`, and then every piece vouches for every
  // slot again: '/dev/stdout' would keep a namespace called `dev`.
  const lines = [{ k8s: 'c1', path: '/api/v1/namespaces/dev/pods?limit=500', bytes: 1 }];
  const lits = literalsFrom(SLOTS_SRC);
  assert.equal(summariseReads(lines, 'c1', lits).reads[0].path, '/api/v1/namespaces/{namespace}/pods?limit=500');
  for (const bare of [new Set(lits), new Set()]) {
    assert.throws(() => summariseReads(lines, 'c1', bare), /literalsOf/);
  }
});

/* ---------------------------------------------------------------------------- console */

test('normaliseTemplate turns an api.ts template into an Express path', () => {
  assert.equal(
    normaliseTemplate('/clusters/${id}/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/manifest'),
    '/clusters/:id/helm/releases/:namespace/:name/manifest'
  );
  assert.equal(normaliseTemplate('/clusters/${id}/logs${qs({ namespace, pod, container })}'), '/clusters/:id/logs');
  assert.equal(normaliseTemplate('/clusters/${id}/traffic-errors?sinceSeconds=${seconds}'), '/clusters/:id/traffic-errors');
  assert.equal(normaliseTemplate('/clusters/${id}/'), '/clusters/:id');
});

test('matchRoute pairs segment by segment, and a param only with a param', () => {
  const routes = ['/clusters', '/clusters/:id/describe', '/clusters/kubeconfig/describe', '/clusters/:id/pods'];
  assert.equal(matchRoute('/clusters/:id/pods', routes), '/clusters/:id/pods');
  assert.equal(matchRoute('/clusters/:clusterId/pods', routes), '/clusters/:id/pods', 'param names need not agree');
  // A literal segment never fills a param, so the param route listed first does not take it.
  assert.equal(matchRoute('/clusters/kubeconfig/describe', routes), '/clusters/kubeconfig/describe');
  assert.equal(matchRoute('/clusters/:id/describe', ['/clusters/kubeconfig/describe']), null);
  assert.equal(matchRoute('/clusters/:id', routes), null, 'no route has three segments');
  assert.equal(matchRoute('/clusters/:id/pods/extra', routes), null);
  assert.equal(matchRoute('/clusters/:id/nodes', routes), null);
});

test('consoleUsage follows a function to its caller and the caller to its view', () => {
  const usage = withTree({
    'api.ts': [
      'export const api = {', '  foo: () => get(`/foo`),', "  bar: () => get('/bar'),", "  baz: () => get('/baz'),", '};', ''
    ].join('\n'),
    'App.tsx': ["import { X } from './X';", 'export const App = () => <Route path="/x" element={<X />} />;', ''].join('\n'),
    // The call after a '/*' string is still code; the block comment below closes nothing it opened.
    'X.tsx': [
      "import { api } from './api';", "const GLOB = '/*';", 'export const X = () => { api.foo(); return null; };',
      '/* the one comment */', ''
    ].join('\n'),
    // A chained call split across lines is still a call.
    'Z.tsx': ["import { api } from './api';", 'export const z = () => void api', '  .baz();', ''].join('\n'),
    // Prose that names a function is not a call; a URL literal in code is.
    'Y.tsx': ['// api.bar()', "export const openBaz = () => window.open('/api/fleet/baz');", ''].join('\n')
  }, root => consoleUsage(root, ['/foo', '/bar', '/baz']));

  assert.deepEqual(Object.fromEntries(usage), {
    '/foo': [{ fn: 'foo', method: 'GET', callers: [{ file: 'X.tsx', views: ['page /x'] }] }],
    '/bar': [{ fn: 'bar', method: 'GET', callers: [] }],
    // Nothing imports Y.tsx or Z.tsx, so no view reaches them.
    '/baz': [
      { fn: 'baz', method: 'GET', callers: [{ file: 'Z.tsx', views: [] }] },
      { fn: 'direct URL', method: 'GET', callers: [{ file: 'Y.tsx', views: [] }] }
    ]
  });
});

test('consoleUsage keeps the methods on one path apart: each entry says which it sends', () => {
  const usage = withTree({
    'api.ts': [
      'export const api = {',
      "  items: () => get<Item[]>('/items'),",
      "  addItem: (body: Item) => get<Item>('/items', { method: 'POST', body: JSON.stringify(body) }),",
      // A member spread over lines still sends its verb, spelled however fetch accepts it.
      '  dropItem: (id: string) =>',
      '    get<void>(`/items/${encodeURIComponent(id)}`, {',
      "      method: 'delete'",
      '    }),',
      '};',
      ''
    ].join('\n'),
    'App.tsx': [
      "import { List } from './List';",
      "import { Add } from './Add';",
      'export const App = () => <><Route path="/list" element={<List />} /><Route path="/add" element={<Add />} /></>;',
      ''
    ].join('\n'),
    'List.tsx': ["import { api } from './api';", 'export const List = () => { api.items(); return null; };', ''].join('\n'),
    'Add.tsx': ["import { api } from './api';", 'export const Add = () => { api.addItem({}); return null; };', ''].join('\n'),
    // A link is followed with a GET, whatever else the path answers.
    'Export.tsx': ['export const Export = () => <a href="/api/fleet/items">export</a>;', ''].join('\n')
  }, root => consoleUsage(root, ['/items', '/items/:id']));

  assert.deepEqual(Object.fromEntries(usage), {
    '/items': [
      { fn: 'items', method: 'GET', callers: [{ file: 'List.tsx', views: ['page /list'] }] },
      { fn: 'addItem', method: 'POST', callers: [{ file: 'Add.tsx', views: ['page /add'] }] },
      { fn: 'direct URL', method: 'GET', callers: [{ file: 'Export.tsx', views: [] }] }
    ],
    '/items/:id': [{ fn: 'dropItem', method: 'DELETE', callers: [] }]
  });
});

test('apiFunctions reads past a "/*" in a string, and never takes a path or a method from a comment', () => {
  const apiSrc = [
    'export const bazPath = (id: string) => `/clusters/${id}/baz`;',
    'export const api = {',
    // A trailing comment goes, and its newline stays, so the next member still starts a line.
    "  foo: () => get('/foo', { accept: '*/*' }), // not bar: () => get('/in-a-comment')",
    "  bar: () => get('/bar'),",
    "  /* qux: () => get('/qux') */",
    // A path or a verb left in a comment is not what the function sends.
    "  baz: (id: string) => get(bazPath(id)), // was '/old-baz', { method: 'DELETE' }",
    "  renewBaz: (id: string) => get(bazPath(id), { method: 'POST' }),",
    '};',
    ''
  ].join('\n');
  assert.deepEqual(Object.fromEntries(apiFunctions(apiSrc)), {
    foo: { method: 'GET', path: '/foo' },
    bar: { method: 'GET', path: '/bar' },
    baz: { method: 'GET', path: '/clusters/:id/baz' },
    renewBaz: { method: 'POST', path: '/clusters/:id/baz' }
  });
});

let mounted;
/** Every route the real router answers, as `{ method, path }`: api.ts posts to some of them. */
function mountedRoutes() {
  mounted ??= (async () => {
    let routes = [];
    await withRouter({}, async ({ router }) => {
      routes = listRoutes(router);
    });
    return routes;
  })();
  return mounted;
}
const mountedPaths = async () => [...new Set((await mountedRoutes()).map(r => r.path))];

test('collapseViews keeps one label where one says it all', () => {
  assert.deepEqual(collapseViews(['Cluster → Networking', 'App shell (every page)', 'page /drift']), ['App shell (every page)']);
  assert.deepEqual(
    collapseViews(['Cluster page (every tab)', 'Cluster → Networking', 'Cluster → Workloads', 'page /drift']),
    ['Cluster page (every tab)', 'page /drift']
  );
  assert.deepEqual(collapseViews(['Cluster → Networking', 'page /drift']), ['Cluster → Networking', 'page /drift']);
  assert.deepEqual(collapseViews([]), []);
});
