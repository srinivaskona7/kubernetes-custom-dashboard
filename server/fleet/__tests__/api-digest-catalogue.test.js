/**
 * The API digest's route catalogue, held to the router it documents.
 *
 * srv/fleet/tools/api-digest-catalogue.js is written by hand, because the router knows a route's
 * method and path and nothing about what its query parameters mean, which cache it shares or why a
 * write is allowed. A hand-kept list drifts, so it is checked against the live router in both
 * directions: a route mounted without an entry fails here, and so does an entry for a route that
 * is no longer mounted.
 *
 * The rest pins what the digest generator relies on: a path parameter it cannot fill has a
 * discovery kind, a write route says why it is not called and what it writes, the cache-bypass and
 * structure-only marks sit on exactly the routes that need them, a reused route exists, and every
 * documented query parameter is a name the backend's code actually reads.
 *
 * A route the digest never sees succeed, which is every write route and the SSO callback,
 * documents its answer in `responds` instead, so that text is held to the code too: it opens with
 * a status line, it is value-free by the same rule as every request body, and each such route is
 * called through its real handler with no real cluster behind it, and must answer exactly the
 * documented fields.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import _api_digest_catalogue from '../tools/api-digest-catalogue.js';
const { ROUTES } = _api_digest_catalogue;
import _api_digest_source2 from '../tools/api-digest-source.js';
const { stripComments } = _api_digest_source2;
import _api_digest3 from '../tools/api-digest.js';
const { privacyGate } = _api_digest3;
import _router_harness4 from './helpers/router-harness.js';
const { withRouter, listRoutes, fillPath } = _router_harness4;
import fixtures from './dev-fixtures.js';

const __dirname = import.meta.dirname;

const FLEET = path.join(__dirname, '..');

const key = r => `${r.method} ${r.path}`;

/** Every mounted `{method, path}`, in registration order, read once from the production router. */
let mountedOnce;
const mounted = () => {
  mountedOnce ??= (async () => {
    let routes = [];
    await withRouter(({ router }) => {
      routes = listRoutes(router);
    });
    return routes;
  })();
  return mountedOnce;
};

/** The digest generator's discovery kinds (`discover` in srv/fleet/tools/api-digest.js). */
const DISCOVERY = ['workload', 'object', 'pod', 'template', 'release', 'trace'];

/** A line-number citation: "line 12" or "router.js:1130". Prose cites a file and a symbol. */
const LINE_REF = /\bline \d+|:\d{2,}\b/;

/** Every prose field of an entry: the text that reaches the digest as written. */
const proseOf = r => [
  ['purpose', r.purpose],
  ...(r.query ?? []).map(q => [`query ${q.name}`, q.doc]),
  ...(r.effect ? [['effect', r.effect]] : []),
  ...(r.console ? [['console', r.console]] : []),
  ...(r.body ? [['body', r.body]] : []),
  ...(r.responds ? [['responds', r.responds]] : [])
];

/**
 * The backend's source: srv/fleet and its collectors, without tools/. The scripts there handle no
 * request, and this catalogue sits among them spelling every documented name, so scanning it would
 * make the check below pass for any name at all.
 */
function backendSources(dir = FLEET, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== path.join(FLEET, 'tools') && e.name !== '__tests__') backendSources(p, out);
    } else if (e.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const BACKEND = backendSources();
/**
 * The backend's code without its comments, so prose neither vouches for a name nor hides one.
 * `stripComments` is the digest's string-aware scanner: a comment opener inside a string literal
 * (the wildcard media type in k8s.js, the path globs in collectors/networking.js and onboard.js) is
 * text, not the start of a comment that swallows the code after it.
 */
const CODE = BACKEND.map(f => stripComments(fs.readFileSync(f, 'utf8'))).join('\n');

/** True when `name` is spelled as an identifier somewhere in the backend's code. */
const readByBackend = name => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(CODE);
};

/* ---------------------------------------------------------------------------- coverage */

test('every mounted route has exactly one entry, every entry is mounted, in mounted order', async () => {
  const routes = await mounted();
  assert.ok(routes.length > 0, 'the router mounted no routes: the harness is broken, not the catalogue');

  const catalogued = ROUTES.map(key);
  const dupes = [...new Set(catalogued.filter((k, i) => catalogued.indexOf(k) !== i))];
  assert.deepEqual(dupes, [], `catalogued more than once: ${dupes.join(', ')}`);

  const live = [...new Set(routes.map(key))];
  const missing = live.filter(k => !catalogued.includes(k));
  const extra = catalogued.filter(k => !live.includes(k));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `mounted without an entry: ${missing.join(', ') || 'none'}; catalogued but not mounted: ${extra.join(', ') || 'none'}`
  );

  // The digest lists topics in catalogue order, so the order is the router's, not an editor's.
  assert.deepEqual(catalogued, live, 'entries must follow the order the router mounts them in');
});

/* ------------------------------------------------------------------------------- prose */

test('every entry has a topic, a title and a purpose, and its prose cites no line number', () => {
  // Canary: the pattern catches both citation forms, so a pass below means none is present.
  assert.match('see router.js:1130', LINE_REF);
  assert.match('as noted at line 42', LINE_REF);
  assert.doesNotMatch('cached for 30 s, capped at 2000 lines', LINE_REF);

  for (const r of ROUTES) {
    for (const field of ['topic', 'title', 'purpose']) {
      assert.ok(typeof r[field] === 'string' && r[field].trim(), `${key(r)} has no ${field}`);
    }
    for (const q of r.query ?? []) {
      assert.ok(typeof q.name === 'string' && q.name, `${key(r)} documents a query parameter with no name`);
      assert.ok(typeof q.doc === 'string' && q.doc.trim(), `${key(r)}: query ${q.name} has no doc`);
    }
    for (const [field, text] of proseOf(r)) {
      assert.doesNotMatch(text, LINE_REF, `${key(r)} ${field} cites a line number; cite a file and a symbol`);
      assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `${key(r)} ${field} carries an emoji`);
    }
  }
});

/* ------------------------------------------------------------------------------ probes */

test('every GET route with a path parameter besides :id says how the digest discovers it', () => {
  const params = r => r.path.split('/').filter(s => s.startsWith(':') && s !== ':id');
  const blind = ROUTES.filter(r => r.method === 'GET' && params(r).length && !r.probe?.needs);
  assert.deepEqual(blind.map(key), [], 'the digest cannot fill these paths');

  const unknown = ROUTES.filter(r => r.probe?.needs && !DISCOVERY.includes(r.probe.needs));
  assert.deepEqual(unknown.map(r => `${key(r)} needs ${r.probe.needs}`), [], 'not a discovery kind the digest knows');
});

test('every write route says why the digest skips it and what it writes; no GET route is skipped', () => {
  const writes = ROUTES.filter(r => r.method !== 'GET');
  assert.ok(writes.length > 0, 'no write route is catalogued, yet the router mounts several');
  for (const r of writes) {
    assert.ok(typeof r.probe?.skip === 'string' && r.probe.skip.trim(), `${key(r)} has no probe.skip`);
    assert.ok(typeof r.effect === 'string' && r.effect.trim(), `${key(r)} has no effect`);
  }
  const skippedGets = ROUTES.filter(r => r.method === 'GET' && r.probe?.skip);
  assert.deepEqual(skippedGets.map(key), [], 'the digest calls every GET route');
});

test('the cache bypass and the structure-only mark sit on exactly the routes that need them', () => {
  const flagged = flag => ROUTES.filter(r => r.probe?.[flag]).map(r => r.path).sort();
  // Not the one-trace route: it must read the entry the list just filled, or the trace can be gone.
  assert.deepEqual(flagged('noCache'), ['/clusters/:id/traces', '/clusters/:id/traffic-errors']);
  assert.deepEqual(flagged('structureOnly'), ['/clusters/:id/logs']);
  assert.deepEqual(flagged('record'), ['/me']);
});

test('every reused route is a mounted GET route', async () => {
  const gets = new Set((await mounted()).filter(r => r.method === 'GET').map(r => r.path));
  assert.ok(ROUTES.some(r => r.reuses?.length), 'no entry reuses another route: the composites lost their marks');
  const bad = ROUTES.flatMap(r => (r.reuses ?? []).filter(p => !gets.has(p)).map(p => `${key(r)} reuses ${p}`));
  assert.deepEqual(bad, [], 'a reused path must be a GET route the router mounts');
});

/* ------------------------------------------------------------------------ query names */

test('every documented query parameter is a name the backend code reads (canary: an invented one fails)', () => {
  assert.ok(BACKEND.length > 0, 'the scan found no source under srv/fleet');
  assert.ok(BACKEND.includes(path.join(FLEET, 'router.js')), 'the scan must include router.js');
  assert.ok(!BACKEND.some(f => f.startsWith(path.join(FLEET, 'tools') + path.sep)), 'tools/ holds the catalogue itself');

  // Canaries: an invented name is not found, a name only prose mentions does not count, and a
  // comment opener inside a string hides no code after it.
  assert.equal(readByBackend('notAParamXyz'), false, 'the check passes names the backend never reads');
  assert.equal(stripComments('/* notAParamXyz */\n  // notAParamXyz\nconst a = 1;').includes('notAParamXyz'), false);
  assert.equal(stripComments("const glob = '/*';\nconst notAParamXyz = 1;\n// */").includes('notAParamXyz'), true,
    'a comment opener inside a string must not swallow the code after it');
  assert.equal(readByBackend('sinceSeconds'), true, 'the check must find a name router.js reads');

  const unread = ROUTES.flatMap(r => (r.query ?? []).filter(q => !readByBackend(q.name)).map(q => `${key(r)} ?${q.name}`));
  assert.deepEqual(unread, [], 'documented but read nowhere in srv/fleet');
});

/* --------------------------------------------------------------------------- responses */

/** A JSONC skeleton without its comments, parsed: the fields it documents, a type name for each value. */
const skeleton = text => JSON.parse(stripComments(text));

/**
 * The status lines of a `responds`: the first, and an `// Or` line for each other success answer.
 * The reason runs to the first comma or colon, so a reason that is not the status's own shows.
 */
const STATUS_LINE = /^\/\/ (Or )?(\d{3}) ([A-Za-z][A-Za-z -]*?)(?=[,:]|$)/;
const statusLines = text => text.split('\n').flatMap(line => {
  const m = STATUS_LINE.exec(line.trim());
  return m ? [{ or: Boolean(m[1]), status: Number(m[2]), reason: m[3], text: line.trim() }] : [];
});

test('every route the digest never sees succeed documents its answer, opening with a status line', () => {
  // Canaries: the first line and an alternative are both read, and a wrong reason is caught.
  assert.deepEqual(statusLines('// 201 Created\n{}\n// Or 302 Found, to a browser').map(({ or, status, reason }) => ({ or, status, reason })), [
    { or: false, status: 201, reason: 'Created' },
    { or: true, status: 302, reason: 'Found' }
  ]);
  assert.notEqual(statusLines('// 201 Made')[0].reason, http.STATUS_CODES[201]);

  const skipped = ROUTES.filter(r => r.probe?.skip);
  assert.ok(skipped.length > 0, 'no route is skipped, yet the digest calls no write route');
  const silent = skipped.filter(r => typeof r.responds !== 'string' || !r.responds.trim());
  assert.deepEqual(silent.map(key), [], 'the digest never calls these, so responds is all a reader learns of their answer');

  for (const r of ROUTES.filter(x => x.responds !== undefined)) {
    assert.equal(typeof r.responds, 'string', `${key(r)}: responds is not text`);
    assert.match(r.responds.split('\n')[0], /^\/\/ \d{3} /, `${key(r)}: responds opens with "// <status> <reason>"`);
    for (const { status, reason } of statusLines(r.responds)) {
      assert.equal(reason, http.STATUS_CODES[status], `${key(r)}: ${status} is ${http.STATUS_CODES[status]}`);
    }
  }
});

/* -------------------------------------------------------------------------- value-free */

/** A skeleton's leaf: a type name, or several joined by ` | `. A bare `null` is one too. */
const TYPE_NAME = /^(string|number|boolean|null)( \| (string|number|boolean|null))*$/;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
/** Three or more dotted labels ending in letters, as a host has. A file name is not one. */
const HOST_NAME = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi;
const FILE_NAME = /\.(js|ts|tsx|json|md|ya?ml)$/i;

/**
 * Why a skeleton carries a value rather than describing one. First the digest's privacy gate, the
 * rule every rendered body already meets (the sentinel test in api-digest.test.js). It knows the
 * shape of an address, a token and a workstation path, and with no live values to compare it
 * passes a cluster's name in a field, so a skeleton is held to more: every leaf a type name, every
 * list one element, every key a field name, and no URL or host name in its comments.
 */
function valueProblems(text) {
  const problems = privacyGate(text, new Map()).hits.map(h => `carries what the privacy gate refuses: ${h.kind} (${h.masked})`);
  let doc;
  try {
    doc = skeleton(text);
  } catch (err) {
    return [...problems, `is not JSON once its comments are stripped (${err.message})`];
  }
  const walk = (v, at) => {
    if (Array.isArray(v)) {
      if (v.length !== 1) problems.push(`${at || '(root)'} holds ${v.length} elements, not the one that stands for all of them`);
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) problems.push(`${at || '(root)'} has the key "${k}", which is not a field name`);
        walk(x, `${at}.${k}`);
      }
    } else if (v !== null && !(typeof v === 'string' && TYPE_NAME.test(v))) {
      problems.push(`${at || '(root)'} holds ${JSON.stringify(v)}, a value rather than a type name`);
    }
  };
  walk(doc, '');
  const url = URL_PATTERN.exec(text);
  if (url) problems.push(`carries a URL: ${url[0]}`);
  for (const [name] of text.matchAll(HOST_NAME)) {
    if (!FILE_NAME.test(name)) problems.push(`carries a host name: ${name}`);
  }
  return problems;
}

test('every request body and documented answer is value-free (canary: each kind of value fails)', () => {
  const clean = [
    '// 200 OK, as api-digest.test.js reads it',
    '{',
    '  "items": [ "string" ],  // e.g. one element stands for all of them',
    '  "next": "string | null",',
    '  "gone": null',
    '}',
    '// Or 302 Found, to a browser'
  ].join('\n');
  assert.deepEqual(valueProblems(clean), [], 'a skeleton that carries no value is refused');

  // Each canary carries one kind of value and must be refused for that reason.
  const canaries = [
    ['{ "apiUrl": "the-real-one" }', /a value rather than a type name/],
    ['{ "count": 3 }', /a value rather than a type name/],
    ['{ "removed": true }', /a value rather than a type name/],
    ['{ "demo-dev": "string" }', /not a field name/],
    ['{ "contexts": [ "string", "string" ] }', /holds 2 elements/],
    ['{ "contexts": [] }', /holds 0 elements/],
    ['{ "apiUrl": "string", }', /not JSON/],
    ['// as https://localhost:6443\n{}', /a URL/],
    ['// as api.example.invalid\n{}', /a host name/],
    ['// as someone@corp.example.invalid\n{}', /email address/],
    ['// as 192.0.2.1\n{}', /IPv4 address/],
    ['// as eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl\n{}', /JWT/]
  ];
  for (const [text, reason] of canaries) {
    assert.match(valueProblems(text).join('\n'), reason, `a value passed: ${text}`);
  }

  const texts = ROUTES.flatMap(r => [['body', r.body], ['responds', r.responds]]
    .filter(([, text]) => text !== undefined)
    .map(([field, text]) => [`${key(r)} ${field}`, text]));
  assert.ok(texts.some(([at]) => at.endsWith(' body')), 'no entry has a request body to check');
  assert.ok(texts.some(([at]) => at.endsWith(' responds')), 'no entry documents an answer to check');
  const carrying = texts.flatMap(([at, text]) => valueProblems(text).map(p => `${at} ${p}`));
  assert.deepEqual(carrying, [], 'a skeleton names a type for every value, and no value');
});

/* ---------------------------------------------------------------------------- handlers */

/** The type of a live value, in a skeleton's words. */
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v);

/**
 * Where a live answer departs from its skeleton: a documented field it lacks, a field it has that
 * is not documented, or a value whose type the skeleton does not name. Every element of a list is
 * held to the one element the skeleton shows.
 */
function departures(doc, live, at = '') {
  if (Array.isArray(doc)) {
    if (!Array.isArray(live)) return [`${at} is ${typeOf(live)}, documented as a list`];
    return live.flatMap((x, i) => departures(doc[0], x, `${at}[${i}]`));
  }
  if (doc !== null && typeof doc === 'object') {
    if (typeOf(live) !== 'object') return [`${at || '(root)'} is ${typeOf(live)}, documented as an object`];
    const documented = Object.keys(doc);
    const answered = Object.keys(live);
    return [
      ...documented.filter(k => !answered.includes(k)).map(k => `${at}.${k} is documented but not answered`),
      ...answered.filter(k => !documented.includes(k)).map(k => `${at}.${k} is answered but not documented`),
      ...documented.filter(k => answered.includes(k)).flatMap(k => departures(doc[k], live[k], `${at}.${k}`))
    ];
  }
  const types = doc === null ? ['null'] : String(doc).split(' | ');
  return types.includes(typeOf(live)) ? [] : [`${at} is ${typeOf(live)}, documented as ${doc}`];
}

test('departures finds a missing field, an extra one and a wrong type at any depth (canary)', () => {
  const doc = { a: 'string', b: { c: 'boolean | null' }, d: [{ e: 'number' }] };
  assert.deepEqual(departures(doc, { a: 'x', b: { c: null }, d: [{ e: 1 }, { e: 2 }] }), []);
  assert.deepEqual(departures(doc, { b: { c: 'yes' }, d: [{ e: 1, f: 2 }], g: 0 }), [
    '.a is documented but not answered',
    '.g is answered but not documented',
    '.b.c is string, documented as boolean | null',
    '.d[0].f is answered but not documented'
  ]);
  assert.deepEqual(departures({ d: [{ e: 'number' }] }, { d: {} }), ['.d is object, documented as a list']);
});

// Synthetic inputs only: an .invalid host never resolves, and nothing here is a credential.
const SERVER = 'https://api.example.invalid';
const ISSUER = 'https://issuer.example.invalid';
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIBfakeNotARealCertificate\n-----END CERTIFICATE-----\n';

/** A kubeconfig with one context, `only`, at SERVER, whose user entry is `user`. */
const kubeconfig = user => [
  'apiVersion: v1',
  'kind: Config',
  'current-context: only',
  'clusters:',
  '  - name: c1',
  '    cluster:',
  `      server: ${SERVER}`,
  `      certificate-authority-data: ${Buffer.from(CA_PEM).toString('base64')}`,
  'contexts:',
  '  - name: only',
  '    context:',
  '      cluster: c1',
  '      user: u1',
  '      namespace: default',
  'users:',
  '  - name: u1',
  '    user:',
  ...user
].join('\n');
const STATIC_TOKEN = ['      token: not-a-real-token'];
const OIDC_SIGN_IN = [
  '      exec:',
  '        apiVersion: client.authentication.k8s.io/v1beta1',
  '        command: kubectl-oidc_login',
  '        args:',
  '          - oidc-login',
  '          - get-token',
  `          - --oidc-issuer-url=${ISSUER}`,
  '          - --oidc-client-id=digest-test-client'
];

/** An unsigned service-account token: `decode` in sa-token.js reads only its claims. */
function saJwt() {
  const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({ sub: 'system:serviceaccount:kyma-fleet:fleet-reader', iat: now, exp: now + 3600 }),
    'not-a-real-signature'
  ].join('.');
}

/** Sets an environment variable for one test, restoring it after. */
function setEnv(t, name, value) {
  const before = process.env[name];
  process.env[name] = value;
  t.onTestFinished(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

/**
 * The identity provider of the SSO routes, behind global fetch: its discovery document and its
 * code exchange. Every other URL is the harness's own client and goes to the real fetch.
 */
function fakeIssuer(t) {
  const real = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u === `${ISSUER}/.well-known/openid-configuration`) {
      return { ok: true, json: async () => ({ authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` }) };
    }
    if (u === `${ISSUER}/token`) return { ok: true, json: async () => ({ id_token: 'not-a-real-id-token' }) };
    return real(url, init);
  };
  t.onTestFinished(() => { global.fetch = real; });
}

/** A `{patch, remove}` writer in memory, which is all onboarding and removal need to run. */
function memoryWriter() {
  const store = new Map();
  return {
    patch: async (id, fields) => { store.set(id, { ...store.get(id), ...fields }); return store.get(id); },
    remove: async id => { store.delete(id); return { removed: true }; }
  };
}

/**
 * A stand-in API server on 127.0.0.1 that grants the fleet account's TokenRequest, because `mint`
 * (mint.js) calls k8s.js itself, with no transport to inject. It is the k8s.test.js pattern: a
 * certificate for localhost, given to the cluster record as its CA. Null without openssl.
 */
async function apiServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-digest-tls-'));
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'tls.key');
  const certFile = path.join(dir, 'tls.crt');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile,
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
    ], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const ca = fs.readFileSync(certFile, 'utf8');
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert: ca }, (req, res) => {
    req.resume();
    req.on('end', () => {
      const minting = req.method === 'POST' &&
        req.url.split('?')[0] === '/api/v1/namespaces/kyma-fleet/serviceaccounts/fleet-reader/token';
      const expirationTimestamp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      res.writeHead(minting ? 201 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(minting ? { kind: 'TokenRequest', status: { token: 'not-a-real-token', expirationTimestamp } } : { kind: 'Status', code: 404 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  // The certificate names localhost, so the URL must too.
  return { url: `https://localhost:${server.address().port}`, ca };
}

/** The cluster whose token is renewed, registered at the stand-in API server. */
const RENEWED = 'digest-renew';

/** The calls the cases make, over the harness's socket. */
function client({ get, baseUrl }) {
  const c = {
    /** Calls `route` ("METHOD /path"), as a JSON client or, with `browser`, as a browser navigates. */
    send: async (route, { params = {}, body, query, browser = false } = {}) => {
      const [method, template] = route.split(' ');
      const p = fillPath(template, params) + (query ? `?${new URLSearchParams(query)}` : '');
      if (browser) {
        // text/html ranked first, as a browser asks, and the redirect not followed.
        const res = await fetch(`${baseUrl}${p}`, { method, headers: { accept: 'text/html,*/*;q=0.8' }, redirect: 'manual' });
        await res.text();
        return { status: res.status, location: res.headers.get('location') };
      }
      return get(p, body === undefined
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
    /** Starts an SSO onboarding and answers its flowId, which the issuer sends back as state. */
    signIn: async name => {
      const start = await c.send('POST /clusters/bootstrap-oidc', { body: { name, kubeconfig: kubeconfig(OIDC_SIGN_IN) } });
      assert.equal(start.status, 202, JSON.stringify(start.body));
      return start.body.flowId;
    }
  };
  return c;
}

/**
 * Each way to reach a documented answer. `request` builds the call: path parameters, a JSON body, a
 * query, or a browser's navigation. `answeredAs` names the route whose answer this one sends, and
 * `redirect` marks a browser's 302. Each case calls its own route, so none vouches for another.
 */
const CASES = [
  {
    route: 'POST /clusters/kubeconfig/describe',
    request: () => ({ body: { kubeconfig: kubeconfig(STATIC_TOKEN) } })
  },
  {
    route: 'POST /clusters',
    when: 'from a service-account token, with the API URL and CA',
    request: () => ({ body: { name: 'Digest Token', token: saJwt(), apiUrl: SERVER, caData: CA_PEM } })
  },
  {
    route: 'POST /clusters',
    when: 'from a kubeconfig with a static token',
    request: () => ({ body: { name: 'Digest Kubeconfig', kubeconfig: kubeconfig(STATIC_TOKEN) } })
  },
  {
    route: 'POST /clusters/bootstrap-oidc',
    when: 'for a kubeconfig that signs in through an OIDC exec plugin',
    request: () => ({ body: { name: 'Digest SSO', kubeconfig: kubeconfig(OIDC_SIGN_IN) } })
  },
  {
    route: 'POST /clusters/bootstrap-oidc',
    when: 'for a kubeconfig with a static token',
    answeredAs: 'POST /clusters',
    request: () => ({ body: { name: 'Digest SSO Fallback', kubeconfig: kubeconfig(STATIC_TOKEN) } })
  },
  {
    route: 'GET /clusters/bootstrap-oidc/callback',
    when: 'to a client that takes JSON',
    request: async c => ({ query: { code: 'not-a-real-code', state: await c.signIn('Digest SSO JSON') } })
  },
  {
    route: 'GET /clusters/bootstrap-oidc/callback',
    when: 'to a browser',
    redirect: true,
    request: async c => ({ query: { code: 'not-a-real-code', state: await c.signIn('Digest SSO Browser') }, browser: true })
  },
  // The harness's demo-dev, restored after each removal: `memDeleted` outlives the registry.
  { route: 'DELETE /clusters/:id', request: () => ({ params: { id: 'demo-dev' } }), restores: 'demo-dev' },
  { route: 'POST /clusters/:id/remove', request: () => ({ params: { id: 'demo-dev' } }), restores: 'demo-dev' },
  { route: 'POST /clusters/:id/delete', request: () => ({ params: { id: 'demo-dev' } }), restores: 'demo-dev' },
  { route: 'POST /tokens/:id/renew', needsApiServer: true, request: () => ({ params: { id: RENEWED } }) }
];

test('every route that documents its answer is driven through its handler, each answer by a case', () => {
  const documented = ROUTES.filter(r => r.responds !== undefined).map(key);
  assert.ok(documented.length > 0, 'no route documents its answer');
  const driven = [...new Set(CASES.map(one => one.route))];
  assert.deepEqual(driven.filter(k => !documented.includes(k)), [], 'driven, but with no responds to hold the answer to');
  assert.deepEqual(documented.filter(k => !driven.includes(k)), [], 'documented, but never driven through the handler');

  for (const r of ROUTES.filter(x => x.responds !== undefined)) {
    const cases = CASES.filter(one => one.route === key(r));
    assert.ok(cases.some(one => !one.answeredAs && !one.redirect), `${key(r)}: no case answers its first status line`);
    const alternatives = statusLines(r.responds).filter(s => s.or).length;
    assert.equal(cases.filter(one => one.answeredAs || one.redirect).length, alternatives,
      `${key(r)}: each "// Or" answer needs a case of its own`);
  }
});

test('each route that documents its answer, called with no real cluster behind it, answers exactly that', async t => {
  setEnv(t, 'FLEET_REQUIRE_ADMIN_SCOPE', 'false');
  setEnv(t, 'FLEET_OIDC_PASSTHROUGH_HOSTS', '.example.invalid');
  fakeIssuer(t);
  const api = await apiServer(t);
  const tokens = fixtures.createTokenStore();
  tokens.adopt(RENEWED, { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

  await withRouter({ tokens, clusterWriter: memoryWriter(), tokenWriter: memoryWriter() }, async ctx => {
    if (api) {
      fs.writeFileSync(path.join(ctx.registry.dir, RENEWED), JSON.stringify({ id: RENEWED, apiUrl: api.url, caData: api.ca }));
      ctx.registry.invalidate();
    }
    const c = client(ctx);
    // node:test had nested subtests; vitest does not, so each case runs in turn and a failure
    // is prefixed with the case that raised it.
    const step = async (name, { skip }, fn) => {
      if (skip) return;
      try {
        await fn();
      } catch (err) {
        err.message = `${name}: ${err.message}`;
        throw err;
      }
    };
    for (const one of CASES) {
      const skip = one.needsApiServer && !api ? 'openssl is not available to mint the stand-in API server\'s certificate' : false;
      await step(one.when ? `${one.route}, ${one.when}` : one.route, { skip }, async () => {
        const own = ROUTES.find(r => key(r) === one.route)?.responds;
        assert.equal(typeof own, 'string', `${one.route} documents no answer`);
        let res;
        try {
          res = await c.send(one.route, await one.request(c));
        } finally {
          if (one.restores) ctx.registry.unremove(one.restores);
        }

        if (one.answeredAs || one.redirect) {
          const alt = statusLines(own).find(s => s.or && s.status === res.status);
          assert.ok(alt, `answered ${res.status}, which no "// Or" line documents`);
          if (one.redirect) {
            const said = own.slice(own.indexOf(alt.text));
            const [where, query = ''] = String(res.location).split('?');
            assert.ok(said.includes(where), `the "// Or" line names where the browser is sent: ${where}`);
            // `sso` carries the outcome, a word the console reads; the other keys carry values.
            for (const [name, value] of new URLSearchParams(query)) {
              const named = name === 'sso' ? `sso=${value}` : `${name}=`;
              assert.ok(said.includes(named), `the "// Or" line names ${named}`);
            }
            return;
          }
          assert.ok(alt.text.includes(one.answeredAs), `the "// Or" line says this is what ${one.answeredAs} answers`);
        }

        const documented = one.answeredAs ? ROUTES.find(r => key(r) === one.answeredAs).responds : own;
        assert.equal(res.status, statusLines(documented)[0].status, JSON.stringify(res.body));
        const doc = skeleton(documented);
        assert.deepEqual(Object.keys(res.body).sort(), Object.keys(doc).sort(), 'its top-level fields');
        assert.deepEqual(departures(doc, res.body), [], 'where the answer departs from the skeleton');
      });
    }
  });
});
