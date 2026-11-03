#!/usr/bin/env node
/**
 * Sweep a **running** fleet API and write the reference for every route it mounts: the command
 * that calls it and the Kubernetes reads behind it, the structure of what comes back, and where
 * the console uses it. Value-free, and verified live on every run.
 *
 *   npm run fleet:digest                                    # against http://localhost:8099
 *   FLEET_TRACE_K8S=1 npm run fleet:dev > dev.log 2>&1      # a traced server, then:
 *   npm run fleet:digest -- --trace-log dev.log --json-out /tmp/fields.json --out docs/research/FLEET_API_DIGEST.md
 *
 * ## Where each part of an entry comes from
 *
 *   - **The route and what it means**: `ROUTES` in api-digest-catalogue.js, one entry per mounted
 *     route. server/fleet/__tests__/api-digest-catalogue.test.js fails when the router and the catalogue
 *     disagree in either direction, so a new route cannot be missing here.
 *   - **Verified**: every GET route is called once against the running API. A route whose path
 *     needs a workload, pod, release, template or trace id gets one discovered from an earlier
 *     answer, preferring platform (`*-system`) namespaces, so the probe reads a real object.
 *   - **Response**: a JSON skeleton of the answer (api-digest-shape.js): key names and types.
 *   - **Kubernetes reads**: with `--trace-log`, the lines the dev server's `FLEET_TRACE_K8S=1`
 *     trace appended while the route was answered (api-digest-trace.js), templated so only what
 *     the collector chose survives.
 *   - **Console**: the `api.ts` function that requests the route, the files that call it and the
 *     tab or page that reaches them (api-digest-console.js), read from app/fleet-ui/src each run.
 *
 * ## Why this exists, next to `api-inventory.js`
 *
 * `api-inventory.js` answers *what is in the cluster*. This answers what a dashboard author asks:
 * *what has this console already extracted, on which route, under which field, from which
 * Kubernetes reads, and which screen shows it*. A field that appears here is one a panel can
 * render today with no backend work; a Kind that appears only in the inventory needs a collector.
 *
 * ## What it will not do
 *
 * **No values, ever.** Responses are folded to skeletons, and traced paths are templated against
 * the collectors' own string literals. Before writing, `privacyGate` checks the document, and the
 * `--json-out` field paths, for every identifier-like string the sweep received that no source
 * file spells, and for IPv4 addresses, email addresses, JWTs and workstation paths. It refuses to
 * write when one is present.
 *
 * **GET only.** Write routes are documented from the catalogue (request body, effect) and never
 * called. `/clusters/:id/logs` returns raw application output, the one verbatim surface in this
 * backend (collectors/logs.js). It is called for its structure only: each line folds into
 * `"string"` like every other value, so no line reaches the page.
 *
 * **It is cluster-agnostic.** Pass `--cluster` or it takes the first id `/clusters` reports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import apiDigestShapeModule from './api-digest-shape.js';
const { OPAQUE, shapeOfValue, renderShape, captureOf, shapeAt, fieldsOf } = apiDigestShapeModule;
import apiDigestTraceModule from './api-digest-trace.js';
const { literalsOf, readTraceSince, summariseReads } = apiDigestTraceModule;
import apiDigestSourceModule from './api-digest-source.js';
const { scanSource, unescapeLiteral } = apiDigestSourceModule;
import apiDigestConsoleModule from './api-digest-console.js';
const { consoleUsage } = apiDigestConsoleModule;
import apiDigestCatalogueModule from './api-digest-catalogue.js';
const { ROUTES } = apiDigestCatalogueModule;
import capabilityModule from '../capability.js';
const { STATES } = capabilityModule;
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = path.resolve(__dirname, '../../..');
const SRV_FLEET = path.join(REPO, 'server/fleet');
const UI_SRC = path.join(REPO, 'app/fleet-ui/src');

/* ------------------------------------------------------------------------------ arguments */

function parseArgs(argv) {
  const out = { base: 'http://localhost:8099', cluster: null, out: null, timeoutMs: 60_000, traceLog: null, jsonOut: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--cluster') out.cluster = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]);
    else if (a === '--trace-log') out.traceLog = argv[++i];
    else if (a === '--json-out') out.jsonOut = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/* -------------------------------------------------------------------------- the sweep plan */

const isClusterPath = p => p === '/clusters/:id' || p.startsWith('/clusters/:id/');

/**
 * The order routes are called in. Each group depends only on the ones before it:
 *
 *   1. `/clusters`, which names the cluster.
 *   2. Per-cluster routes, each reading for itself (their cache keys carry the cluster id).
 *   3. Routes whose path needs a discovered object, fed by the answers of step 2.
 *   4. Fleet routes.
 *   5. Routes that reuse other routes' cached answers (`reuses`), last, so what they reuse is
 *      named rather than silently timed as their own cost.
 *
 * @param {object[]} routes the catalogue
 * @returns {object[]} GET routes in call order; write routes are documented, never called
 */
function sweepPlan(routes) {
  const gets = routes.filter(r => r.method === 'GET');
  const composite = r => Array.isArray(r.reuses) && r.reuses.length > 0;
  const needs = r => Boolean(r.probe?.needs);
  return [
    ...gets.filter(r => r.path === '/clusters'),
    ...gets.filter(r => isClusterPath(r.path) && !needs(r) && !composite(r)),
    ...gets.filter(r => needs(r) && !composite(r)),
    ...gets.filter(r => !isClusterPath(r.path) && r.path !== '/clusters' && !needs(r) && !composite(r)),
    ...gets.filter(composite)
  ];
}

/* ------------------------------------------------------------------------------ discovery */

const platformFirst = (list, nsOf) => {
  const sys = list.filter(x => /-system$/.test(nsOf(x) || ''));
  return sys.length ? sys : list;
};

/**
 * A real object for a route whose path names one, taken from an earlier answer in this sweep.
 * Returns null when the cluster has none, and the route is then reported as not probed, with why.
 *
 * @param {'workload'|'object'|'pod'|'template'|'release'|'trace'} kind
 * @param {Map<string, {body: any}>} answers route path -> probe result
 */
function discover(kind, answers) {
  const data = p => answers.get(p)?.body?.data ?? null;
  if (kind === 'workload' || kind === 'object') {
    const items = (data('/clusters/:id/workloads')?.items ?? []).filter(w => w?.namespace && w?.name && w?.kind);
    const deployments = items.filter(w => w.kind === 'Deployment');
    const pick = platformFirst(deployments.length ? deployments : items, w => w.namespace)[0];
    return pick ? { namespace: pick.namespace, kind: pick.kind, name: pick.name } : null;
  }
  if (kind === 'pod') {
    const items = (data('/clusters/:id/pods')?.items ?? []).filter(p => p?.name && p?.namespace && p?.containers?.length);
    const running = items.filter(p => p.phase === 'Running');
    const pick = platformFirst(running.length ? running : items, p => p.namespace)[0];
    return pick ? { namespace: pick.namespace, pod: pick.name, container: pick.containers[0].name } : null;
  }
  if (kind === 'template') {
    const p = (data('/clusters/:id/opa')?.policies ?? []).find(x => x?.templateName);
    return p ? { template: p.templateName } : null;
  }
  if (kind === 'release') {
    const rel = (data('/clusters/:id/helm/releases')?.releases ?? []).filter(r => r?.namespace && r?.name);
    const pick = platformFirst(rel, r => r.namespace)[0];
    return pick ? { namespace: pick.namespace, name: pick.name } : null;
  }
  if (kind === 'trace') {
    const t = (data('/clusters/:id/traces')?.traces ?? []).find(x => x?.traceId);
    return t ? { traceId: t.traceId } : null;
  }
  return null;
}

/** The query a route is probed with: what its discovered object supplies, then fixed values. */
function probeQuery(route, found) {
  const q = new URLSearchParams();
  const needs = route.probe?.needs;
  if (needs === 'pod' && found) {
    q.set('namespace', found.namespace);
    q.set('pod', found.pod);
    q.set('container', found.container);
  }
  if (needs === 'object' && found) {
    q.set('kind', found.kind);
    q.set('name', found.name);
    q.set('namespace', found.namespace);
  }
  // A workload route whose path has no `:kind` (rollout) takes it as a query, defaulting to
  // Deployment server-side; send the discovered one so a StatefulSet is not read as a Deployment.
  if (needs === 'workload' && found && !route.path.includes(':kind')) q.set('kind', found.kind);
  for (const [k, v] of Object.entries(route.probe?.query ?? {})) q.set(k, String(v));
  return q;
}

/** The URL actually requested: path parameters filled, query appended. */
function probeUrl(route, clusterId, found) {
  const values = { id: clusterId, ...(found ?? {}) };
  const p = route.path
    .split('/')
    .map(seg => (seg.startsWith(':') ? encodeURIComponent(String(values[seg.slice(1)] ?? '')) : seg))
    .join('/');
  const q = probeQuery(route, found).toString();
  return q ? `${p}?${q}` : p;
}

/** Shell variables a reader substitutes, one per path parameter. */
const VARS = { id: '$CLUSTER', namespace: '$NAMESPACE', kind: '$KIND', name: '$NAME', template: '$TEMPLATE', traceId: '$TRACE_ID' };

/** The same URL as `probeUrl`, written for a reader: every discovered value is a variable. */
function commandUrl(route) {
  const p = route.path
    .split('/')
    .map(seg => (seg.startsWith(':') ? VARS[seg.slice(1)] ?? `$${seg.slice(1).toUpperCase()}` : seg))
    .join('/');
  const q = [];
  const needs = route.probe?.needs;
  if (needs === 'pod') q.push('namespace=$NAMESPACE', 'pod=$POD', 'container=$CONTAINER');
  if (needs === 'object') q.push('kind=$KIND', 'name=$NAME', 'namespace=$NAMESPACE');
  if (needs === 'workload' && !route.path.includes(':kind')) q.push('kind=$KIND');
  for (const [k, v] of Object.entries(route.probe?.query ?? {})) q.push(`${k}=${v}`);
  return `$FLEET/api/fleet${p}${q.length ? `?${q.join('&')}` : ''}`;
}

/* -------------------------------------------------------------------------------- probing */

/**
 * One GET, timed. Never throws: a route that fails is a row in the document, because the whole
 * point of the completeness model is that a failed read is reported, not dropped.
 */
async function probe(base, step, timeoutMs) {
  const url = `${base.replace(/\/$/, '')}/api/fleet${step.url}`;
  const headers = { accept: 'application/json' };
  // traffic-errors and traces answer from a log window they may reuse; `no-cache` makes each read
  // for itself, so its own Kubernetes reads land in its own trace window.
  if (step.noCache) headers['cache-control'] = 'no-cache';
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers });
    const text = await res.text();
    const ms = Date.now() - started;
    let body = null;
    let parseError = null;
    try {
      body = JSON.parse(text);
    } catch {
      parseError = 'not JSON';
    }
    const contentType = res.headers.get('content-type') || '';
    const attachment = /^\s*attachment/i.test(res.headers.get('content-disposition') || '');
    // A text answer keeps its body only until `sweep` has read its outline from it.
    const kept = parseError && /^text\//.test(contentType) ? { text } : {};
    return { status: res.status, ms, bytes: Buffer.byteLength(text), contentType, attachment, body, parseError, ...kept };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, bytes: 0, body: null, error: err.name === 'AbortError' ? 'timed out' : 'transport error' };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const sizeOf = file => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * The trace lines a route caused: everything appended since `offset`, read once the log has been
 * quiet for `quietMs`. The wait catches a stale-while-revalidate refresh the route set off after
 * answering, which is still that route's cost.
 */
async function traceWindow(file, offset, { quietMs = 1000, maxMs = 8000, pollMs = 200 } = {}) {
  const started = Date.now();
  let last = sizeOf(file);
  let changedAt = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(pollMs);
    const now = sizeOf(file);
    if (now !== last) {
      last = now;
      changedAt = Date.now();
    } else if (Date.now() - changedAt >= quietMs) {
      break;
    }
  }
  return readTraceSince(file, offset);
}

/**
 * A text answer's headings, the only structure a Markdown document has, each with the number of
 * non-blank lines under it. A word the code does not spell prints as `{value}`, the rule a traced
 * path follows, so a heading that carried a cluster's name would not print it.
 *
 * @param {string} text
 * @param {Set<string>} literals from `collectorLiterals`
 * @returns {{ heading: string, lines: number }[]}
 */
function outlineOf(text, literals) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (/^#{1,6} \S/.test(line)) {
      const words = line.trim().split(/\s+/);
      const heading = words.map((w, i) => (i === 0 || literals.has(w) || /^\W+$/.test(w) ? w : '{value}')).join(' ');
      out.push({ heading, lines: 0 });
    } else if (line.trim() && out.length) {
      out[out.length - 1].lines += 1;
    }
  }
  return out;
}

/* --------------------------------------------------------------------------- envelope read */

/**
 * The completeness verdict for one response, read from the envelope the backend already
 * publishes, never derived from whether the data looks plausible.
 *
 * Every place the backend records a scope is read, because each envelope shape puts them
 * somewhere else and a reader that missed one would grade a refused read as complete:
 *
 *   - a payload's own `unavailable[]` / `truncated[]` and its `summary`'s, the two places
 *     `completenessOf` in router.js reads (`/events` and `/clusters/:id` use the first), and
 *     those of each section beside them, where one route answers for several collectors
 *     (`/clusters/:id/overview` carries health, compliance, workloads and `eventsSummary`);
 *   - the root `summary` of the fleet routes;
 *   - each cluster slot: `clusters[]`, the failed ones `/security` lists apart in `unreachable[]`,
 *     and `/drift`'s `clusterParity[]`, read as the console reads them (`unavailableScope`). A slot
 *     with `notRead` (`unreadSlot` in router.js: `pending`, or `disabled`) was not read, which is
 *     not the same as unreachable;
 *   - each of `groups` on the two summary routes. Its `state` is the backend's own verdict
 *     (`groupState` in router.js): `error` when no cluster answered the group's reads, which
 *     carries no label at all, and `degraded` when some read failed;
 *   - the `capability` a payload, or a section of it, carries, and each of Helm's `capabilities`
 *     (server/fleet/capability.js): the backend's grade of a feature's data source, `not-configured`
 *     when the reads worked and there was nothing to read the feature from.
 */
function completeness(body) {
  const scopes = { unavailable: new Set(), truncated: new Set() };
  const capabilities = [];

  const add = (set, list) => {
    if (!Array.isArray(list)) return;
    for (const e of list) set.add(typeof e === 'string' ? e : (e?.scope ?? JSON.stringify(e)));
  };
  const isRecord = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const collect = holder => {
    if (!holder || typeof holder !== 'object') return;
    add(scopes.unavailable, holder.unavailable);
    add(scopes.truncated, holder.truncated);
    // One feature's grade, or Helm's per-feature map of them (`capabilities.values`, …).
    const caps = [holder.capability, ...(isRecord(holder.capabilities) ? Object.values(holder.capabilities) : [])];
    for (const cap of caps) if (isRecord(cap) && typeof cap.state === 'string' && STATES[cap.state]) capabilities.push(cap.state);
  };
  // A payload and each section in it, `summary` among them, with that section's own summary.
  const payload = data => {
    if (!isRecord(data)) return;
    collect(data);
    for (const section of Object.values(data)) {
      if (!isRecord(section)) continue;
      collect(section);
      collect(section.summary);
    }
  };

  if (!isRecord(body)) return { unavailable: [], truncated: [], clusters: null, groups: null, capabilities: [] };

  collect(body);
  collect(body.summary);
  payload(body.data);

  let clusters = null;
  const slots = [body.clusters, body.clusterParity].filter(Array.isArray).flat();
  const unreachable = Array.isArray(body.unreachable) ? body.unreachable : [];
  if (Array.isArray(body.clusters) || Array.isArray(body.clusterParity) || unreachable.length) {
    clusters = { total: slots.length + unreachable.length, ok: 0, failed: unreachable.length, pending: 0 };
    for (const c of slots) {
      // `ok` is three-state on the roster: `null` means registered but not read yet, which is
      // not the same as unreachable, and neither is a slot its operator disabled (`notRead`).
      // The inline shape carries no `ok` at all.
      if (c && typeof c === 'object' && 'notRead' in c) clusters.pending += 1;
      else if (c?.ok === true || (c && !('ok' in c))) clusters.ok += 1;
      else if (c?.ok === false) clusters.failed += 1;
      else clusters.pending += 1;
      collect(c);
      collect(c?.summary);
      payload(c?.data);
    }
    for (const c of unreachable) collect(c);
  }

  let groups = null;
  if (isRecord(body.groups)) {
    groups = { total: 0, error: [], degraded: [] };
    for (const [key, g] of Object.entries(body.groups)) {
      if (!isRecord(g)) continue;
      collect(g);
      if (typeof g.state !== 'string') continue;
      groups.total += 1;
      if (g.state === 'error') groups.error.push(key);
      else if (g.state === 'degraded') groups.degraded.push(key);
    }
  }
  return { unavailable: [...scopes.unavailable].sort(), truncated: [...scopes.truncated].sort(), clusters, groups, capabilities: capabilities.sort() };
}

/** A grade whose numbers are no fact and that names no partial read: the feature read nothing. */
const readNothing = state => STATES[state]?.trusted === false && state !== 'partial';

/** The grades short of a trusted read, once each: `not-configured`, `forbidden`, `partial`, … */
const untrusted = comp => [...new Set((comp.capabilities ?? []).filter(s => STATES[s]?.trusted === false))];

/**
 * What an envelope reports as not read beyond its scope labels: clusters that did not answer or
 * were not read, groups whose `state` is short of `ok`, and data sources graded short of a
 * trusted read. A failed cluster or an `error` group carries no label, so without this a route
 * could say it was complete over a read that never happened.
 */
function notReadOf(comp) {
  const parts = [];
  if (comp.clusters?.failed) parts.push(`${comp.clusters.failed} of ${comp.clusters.total} cluster(s) unreachable`);
  if (comp.clusters?.pending) parts.push(`${comp.clusters.pending} of ${comp.clusters.total} cluster(s) registered but not read`);
  for (const state of ['error', 'degraded']) {
    const keys = comp.groups?.[state] ?? [];
    if (keys.length) parts.push(`group(s) ${keys.map(tick).join(', ')} in state \`${state}\``);
  }
  const graded = untrusted(comp);
  if (graded.length) parts.push(`data source graded ${graded.map(tick).join(', ')} (\`capability.state\`)`);
  return parts;
}

/**
 * The flat field list for a response, rooted where its payload lives:
 *
 *   - **wrapper** `{ cluster, ok, data }`: every `/clusters/:id/…` route. Digested at `data`.
 *   - **roster** `{ summary, clusters[{ cluster, ok, data }] }`: `/clusters`. At `clusters[].data`.
 *   - **flattened** `{ summary, clusters[{ id, ok, error }], items[] }`, or named lists in place of
 *     `items[]` (`/storage`: `pvcs[]`, `quotas[]`): rows at the **root**, and `clusters[]` is status
 *     only.
 *   - **inline** `{ summary, clusters[{ clusterId, …payload }] }`: the payload is on the cluster
 *     entry itself, with no `data` wrapper.
 *
 * Rooting at the payload matters because `data` is opaque everywhere else (a Secret's `data` keys
 * are user-authored), so a root digest of a wrapper would record `data  map` and stop. The paths
 * come from the response structure (`fieldsOf` in api-digest-shape.js), so they fold what it folds:
 * no key under an `OPAQUE` key, and a map keyed by data as `<key>`, so the `--json-out` field paths
 * carry no key the document would not print.
 *
 * @param {{ shape?: object, vocabulary?: Set<string>, dataKeys?: Set<string> }} [opts] the shape
 *        `analyse` already folded, or what to fold one with
 */
function digestOf(body, { shape, ...vo } = {}) {
  if (!body || typeof body !== 'object') return { prefix: '', fields: [] };
  const at = { wrapper: 'data', roster: 'clusters[].data' }[shapeOf(body)] ?? '';
  const whole = shape ?? shapeOfValue(body, vo);
  return { prefix: at ? `${at}.` : '', fields: fieldsOf(at ? shapeAt(whole, at, vo) : whole) };
}

/** Keys a status-only cluster row carries: which cluster, and how its read went. */
const STATUS_KEYS = new Set(['id', 'clusterId', 'cluster', 'displayName', 'env', 'ok', 'error', 'code', 'unavailable', 'truncated', 'notRead']);

const statusOnly = c => Boolean(c) && typeof c === 'object' && Object.keys(c).every(k => STATUS_KEYS.has(k));

/** The lists at the root of an answer, beside its cluster slots: a flattened answer's rows. */
const rootLists = body => Object.keys(body).filter(k => Array.isArray(body[k]) && !['clusters', 'unreachable', 'unavailable', 'truncated'].includes(k));

/**
 * Which envelope shape a response uses, by name: one of the four in `digestOf`, or `plain` for a
 * bare object and `non-object` for a body that is not JSON. Status-only cluster rows beside root
 * lists are the flattened shape whatever the lists are called, so a route whose rows are `pvcs[]`
 * is not read off its status rows.
 */
function shapeOf(body) {
  if (!body || typeof body !== 'object') return 'non-object';
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.clusters)) return 'wrapper';
  if (Array.isArray(body.clusters)) {
    if (body.clusters.some(c => c?.data && typeof c.data === 'object')) return 'roster';
    if (Array.isArray(body.items)) return 'flattened';
    if (body.clusters.every(statusOnly) && rootLists(body).length) return 'flattened';
    return 'inline';
  }
  if (Array.isArray(body.items)) return 'flattened';
  return 'plain';
}

/** Where each shape's payload is read, as a skeleton path and as the jq a reader pipes into. */
const PAYLOAD = {
  wrapper: { at: 'data', jq: '.data' },
  roster: { at: 'clusters[].data', jq: '.clusters[].data' },
  flattened: { at: '', jq: '.items', skipTop: ['clusters', 'summary'] },
  inline: { at: 'clusters[]', jq: '.clusters[]' },
  plain: { at: '', jq: '.' },
  'non-object': { at: '', jq: '.' }
};

/**
 * The jq that prints one answer's payload: its shape's, except on a flattened answer, whose rows
 * are whichever root lists it has (`.items`, `.pvcs`, `{pvcs, quotas}`).
 */
function payloadJq(envelope, body) {
  if (envelope !== 'flattened') return PAYLOAD[envelope]?.jq ?? '.';
  const lists = rootLists(body);
  if (!lists.length) return '.';
  return lists.length === 1 ? `.${lists[0]}` : `{${lists.join(', ')}}`;
}

const codeOf = body => (body && typeof body.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(body.code) ? body.code : null);

/**
 * Did the route capture data? Read in this order, so a failure is never counted as an empty
 * cluster and an empty cluster is never counted as a failure:
 *
 *   no       the request failed, the cluster read failed, no cluster or group was read, or the
 *            backend grades every data source it names as one that read nothing (`not-configured`,
 *            `forbidden`, `unknown`, `unsupported-backend`; server/fleet/capability.js)
 *   partial  it answered, and the envelope names scopes it could not read or had to cap, a
 *            cluster that did not answer or was not read, a group short of `ok`, or a data source
 *            graded short of a trusted read
 *   empty    it answered completely, and every list it returns was empty on this read
 *   yes      it answered completely with data
 */
function verdictOf(r, comp, capture, route = r.route) {
  if (r.error) return { word: 'no', detail: r.error };
  if (r.status !== 200) {
    const code = codeOf(r.body);
    // `status`, not `HTTP`: a detail word must be one the code spells, or a response value equal to
    // it (a gateway's protocol) refuses the document.
    return { word: 'no', detail: `status ${r.status}${code ? ` \`${code}\`` : ''}` };
  }
  if (r.parseError && r.outline?.length) {
    const filled = r.outline.filter(h => h.lines).length;
    const type = tick(r.contentType.split(';')[0]);
    if (!filled) return { word: 'empty', detail: `a ${type} document whose ${r.outline.length} headings have nothing under them` };
    return { word: 'yes', detail: `a ${type} document, not JSON: ${filled}/${r.outline.length} sections with content` };
  }
  if (r.parseError) return { word: 'no', detail: 'the answer is not JSON' };
  if (r.body && r.body.ok === false) {
    const code = codeOf(r.body);
    return { word: 'no', detail: `the cluster read failed${code ? ` \`${code}\`` : ''}` };
  }
  const { clusters, groups } = comp;
  const caps = comp.capabilities ?? [];
  const graded = untrusted(comp);
  // Every slot unreachable or not read yet: what came back is the envelope, not a cluster's data.
  if (clusters?.total && !clusters.ok && (clusters.failed || clusters.pending)) {
    const why = [
      clusters.failed ? `${clusters.failed} of ${clusters.total} cluster(s) unreachable` : null,
      clusters.pending ? `${clusters.pending} of ${clusters.total} cluster(s) registered but not read` : null
    ].filter(Boolean);
    return { word: 'no', detail: `${why.join(', ')}, none read` };
  }
  if (groups?.total && groups.error.length === groups.total) return { word: 'no', detail: `all ${groups.total} groups failed to read` };
  if (caps.length && caps.every(readNothing)) return { word: 'no', detail: `the backend grades the data source ${graded.map(tick).join(', ')}` };
  if (clusters?.failed) return { word: 'partial', detail: `${clusters.failed} cluster(s) unreachable` };
  if (clusters?.pending) return { word: 'partial', detail: `${clusters.pending} cluster(s) registered but not read` };
  if (groups?.error.length) return { word: 'partial', detail: `${groups.error.length} of ${groups.total} groups failed to read: ${groups.error.join(', ')}` };
  if (comp.unavailable.length) return { word: 'partial', detail: `${comp.unavailable.length} scope(s) unavailable` };
  if (comp.truncated.length) return { word: 'partial', detail: `${comp.truncated.length} scope(s) truncated; counts are floors` };
  // A group degrades without a label when one of several clusters failed its reads.
  if (groups?.degraded.length) return { word: 'partial', detail: `${groups.degraded.length} of ${groups.total} groups degraded` };
  if (graded.length) return { word: 'partial', detail: `a data source graded ${graded.map(tick).join(', ')}` };
  if (!capture) return { word: 'empty', detail: 'no payload' };
  // A record (one caller, one object) has data in its fields; an empty list in it is one fact among them.
  const record = Boolean(route?.probe?.record);
  if (capture.lists && !capture.populated && !record) return { word: 'empty', detail: `all ${capture.lists} lists empty on this read` };
  if (!capture.lists && !capture.withValue) return { word: 'empty', detail: 'no field held a value' };
  const lists = capture.lists ? `${capture.populated}/${capture.lists} lists populated, ` : '';
  return { word: 'yes', detail: `${lists}${capture.withValue}/${capture.leaves} fields with a value` };
}

/**
 * Everything the document says about one probed route.
 *
 * @param {{ vocabulary?: Set<string>, dataKeys?: Set<string> }} [opts] identifiers the source
 *        spells (`identifiersOf`): an object whose keys are all among them is a record of fixed
 *        fields, never a map; and the registered cluster ids, which key a map wherever they stand
 */
function analyse(route, r, { vocabulary, dataKeys } = {}) {
  const vo = { ...(vocabulary ? { vocabulary } : {}), ...(dataKeys?.size ? { dataKeys } : {}) };
  const hasBody = r.body !== null && r.body !== undefined;
  const shape = hasBody ? shapeOfValue(r.body, vo) : null;
  const envelope = shapeOf(r.body);
  const where = PAYLOAD[envelope];
  let capture = null;
  if (shape) {
    const sub = where.at ? shapeAt(shape, where.at, vo) : shape;
    capture = sub ? captureOf(sub, { prefix: where.at, skipTop: where.skipTop ?? [], ...vo }) : null;
  }
  const comp = completeness(r.body);
  return {
    ...r,
    route,
    shape,
    envelope,
    jq: payloadJq(envelope, r.body),
    lists: envelope === 'flattened' ? rootLists(r.body) : [],
    capture,
    completeness: comp,
    verdict: verdictOf(r, comp, capture, route),
    digest: digestOf(r.body, { shape, ...vo })
  };
}

/* ------------------------------------------------------------------------------ the sweep */

/** A request URL's path as the router saw it: no query, percent-escapes decoded where they decode. */
const requestPath = url => {
  const p = String(url).split('?')[0];
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

/**
 * Split the requests a trace window holds into the digest's own and everyone else's. Reads are
 * attributed to a route by timing alone, so another caller's requests in the same window put
 * their reads under this route.
 */
function requestsIn(requests, base, url) {
  const own = requestPath(new URL(`${base.replace(/\/$/, '')}/api/fleet${url}`).pathname);
  const mine = requests.filter(q => q.method === 'GET' && requestPath(q.url) === own);
  return { seen: mine.length > 0, others: requests.length - mine.length };
}

/**
 * Call every GET route once, in `sweepPlan` order.
 *
 * With `--trace-log`, the log must be the traced output of the server at `--base`: a path that
 * does not exist, a log in which the server never answers the sweep's requests, or one with no
 * Kubernetes reads at all would leave every route's reads blank, and the document would say the
 * routes read nothing.
 *
 * @param {{ vocabulary?: Set<string>, window?: object }} [opts] `vocabulary` is passed to
 *        `analyse`; `window` times each trace window (`traceWindow`), shortened by the tests
 * @returns {Promise<{ results: object[], clusterId: string, bodies: any[] }>}
 */
async function sweep(args, log = () => {}, { vocabulary, window } = {}) {
  if (args.traceLog && !fs.existsSync(args.traceLog)) {
    throw new Error(`--trace-log ${args.traceLog} does not exist: start the dev server with FLEET_TRACE_K8S=1 and its output redirected there`);
  }
  const literals = collectorLiterals();
  let offset = args.traceLog ? sizeOf(args.traceLog) : 0;
  const answers = new Map();
  const results = [];
  const bodies = [];
  let clusterId = args.cluster;
  let dataKeys = null;
  let answered = 0;
  let reads = 0;

  for (const route of sweepPlan(ROUTES)) {
    let found = null;
    if (route.probe?.needs) {
      found = discover(route.probe.needs, answers);
      if (!found) {
        results.push({ route, skipped: `this cluster had no ${route.probe.needs} to call it with` });
        log(`skip  ${route.path} (no ${route.probe.needs})`);
        continue;
      }
    }
    if (isClusterPath(route.path) && !clusterId) throw new Error('no cluster id: pass --cluster, or onboard one');

    const url = probeUrl(route, clusterId, found);
    const r = await probe(args.base, { url, noCache: Boolean(route.probe?.noCache) }, args.timeoutMs);
    if (r.text !== undefined) {
      r.outline = outlineOf(r.text, literals);
      delete r.text;
    }
    if (route.path === '/clusters') {
      if (!clusterId) {
        clusterId = r.body?.clusters?.[0]?.cluster?.id ?? null;
        if (!clusterId) throw new Error('no clusters registered: onboard one before running the digest');
        log(`no --cluster given; using the first registered cluster: ${clusterId}`);
      }
      // Registered cluster ids key the summaries' `perCluster` maps; a dash-free id is otherwise
      // indistinguishable from a field name.
      dataKeys = new Set([clusterId, ...(r.body?.clusters ?? []).map(c => c?.cluster?.id)].filter(id => typeof id === 'string' && id));
    }
    if (args.traceLog) {
      const w = await traceWindow(args.traceLog, offset, window);
      offset = w.offset;
      r.reads = summariseReads(w.lines, clusterId, literals);
      reads += r.reads.calls;
      const q = requestsIn(w.requests ?? [], args.base, url);
      r.requestSeen = q.seen;
      r.otherRequests = q.others;
      if (r.status) {
        answered += 1;
        if (answered === 1 && !q.seen) {
          throw new Error(`--trace-log ${args.traceLog} recorded none of this sweep's requests: it is not the log of the server at ${args.base}`);
        }
      }
      if (q.others) log(`note  ${route.path}: the server answered ${q.others} other request(s) in the same window`);
    }
    answers.set(route.path, r);
    if (r.body !== null && r.body !== undefined) bodies.push(r.body);
    const a = analyse(route, r, { vocabulary, dataKeys });
    results.push(a);
    log(`${String(r.status || 'ERR').padEnd(3)} ${String(r.ms).padStart(6)}ms ${a.verdict.word.padEnd(7)} ${route.path}`);
  }
  if (args.traceLog && answered && !reads) {
    throw new Error(`--trace-log ${args.traceLog} holds no Kubernetes reads: start the server with FLEET_TRACE_K8S=1`);
  }
  return { results, clusterId, bodies };
}

/* -------------------------------------------------------------------------------- literals */

/**
 * The collectors' source: `server/fleet` without its `tools/` scripts, whose prose and catalogue
 * text are not choices a collector made.
 */
function collectorFiles(root = SRV_FLEET) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '__tests__' && !(dir === root && e.name === 'tools')) walk(p);
      } else if (e.name.endsWith('.js')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/** The console's non-test TypeScript: tab labels and UI vocabulary. */
function uiFiles(root = UI_SRC) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

const collectorLiterals = () => literalsOf(collectorFiles());
const uiLiterals = () => literalsOf(uiFiles());

/** This tool's own modules, whose prose and topic titles the document prints. */
const toolFiles = () => fs.readdirSync(path.join(SRV_FLEET, 'tools'))
  .filter(f => /^api-digest[\w-]*\.js$/.test(f))
  .map(f => path.join(SRV_FLEET, 'tools', f));

/**
 * Every literal with whitespace that the collectors, the console or this tool spells: the text
 * whose words `privacyGate` reads as the code's where it prints whole. The tool's own literals
 * join only here, never the allow set, so they vouch for no value on their own. Each is read as it
 * prints (`unescapeLiteral`): the source spells `One cluster\'s`, the document `One cluster's`.
 */
const documentSentences = () => [...collectorLiterals(), ...uiLiterals(), ...literalsOf(toolFiles())].map(unescapeLiteral).filter(s => /\s/.test(s));

/* ---------------------------------------------------------------------------- privacy gate */

const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/**
 * A value shaped like a Kubernetes object's name that is also a plain word: a DNS-1123 name with
 * no dash or dot (`payments`, `nginx`, `mtls`). Only such a value can be vouched for by an
 * identifier the code spells.
 */
const NAME_LIKE = /^[a-z][a-z0-9]{3,}$/;

/**
 * A key that can print as itself: four characters or more of letters, digits, `_` and `-`, one of
 * them a letter, in any case. The document's structure folds an object whose keys are not
 * identifiers to `"<key>"` (api-digest-shape.js), but the `--json-out` field paths fold nothing,
 * and an identifier can be the cluster's as well as the code's: a map keyed by namespace prints
 * `payments` or `acme-payments`, and a chart's or an operator's keys are as often `acmeTeam`,
 * `AcmeTeam` or `ACME_TEAM`. A key that is a number or a date (`8080`, `2026-10-01`) names
 * nothing, and the document prints numbers and dates of its own.
 */
const PRINTABLE_KEY = /^(?=[\w$-]*[A-Za-z])[\w$-]{4,}$/;

/** Every identifier in a set of source files, comments removed: the schema keys the code spells. */
function identifiersOf(files) {
  const out = new Set();
  for (const f of files) {
    for (const m of scanSource(fs.readFileSync(f, 'utf8')).code.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
  }
  return out;
}

/** What a reader sees between two words: the gate's tokens are what lies between these. */
const TOKEN_SPLIT = /[\s`'"|,;()[\]{}<>*=&?/#]+/;

/**
 * Every string the sweep received that could identify something in the cluster, mapped to the key
 * path it was first seen under, for the refusal message. The path is printed as the structure
 * prints it: a key the code does not spell is `<key>`, and it stops at an opaque key, so a refusal
 * does not print the keys the document keeps out:
 *
 *   - a **value** that is identifier-like (four characters or more, no whitespace, not purely
 *     numeric, not a timestamp) and that no source file spells as a literal. One holding a split
 *     character (`TOKEN_SPLIT`) is read whole, and is the code's only when every piece of it is:
 *     `apps/v1` is the API's two words, while `deployments[ns=acme-payments]` carries a namespace
 *     and `1234567890/9876543210` two ids;
 *   - a **key** that can print as itself (`PRINTABLE_KEY`) and that no source file spells at all,
 *     outside an opaque key, whose keys never print.
 *
 * A name-like value the code spells as an identifier is vocabulary too: the document prints that
 * word as a schema key wherever the code uses it (a gateway port named `mtls` beside the mesh's
 * `mtls` key), so refusing it would refuse the code's own words.
 *
 * @param {any[]} bodies every JSON answer of the sweep
 * @param {Set<string>} allow strings the code itself spells, plus the cluster id
 * @param {Set<string>} [idents] identifiers the code spells; they vouch for keys and name-like values
 * @returns {Map<string, string>}
 */
function forbiddenValues(bodies, allow, idents = new Set()) {
  const out = new Map();
  const vocabulary = s => allow.has(s) || (NAME_LIKE.test(s) && idents.has(s));
  const identifying = s => s.length >= 4 && s.length <= 256 && !/\s/.test(s) && !/^\d+$/.test(s) && !ISO_TIME.test(s) && !vocabulary(s);
  // `at` is the body's path, which says where a payload's `data` is; `shown` is the one printed.
  const walk = (v, at, shown, depth, underOpaque) => {
    if (depth > 40 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      const named = !TOKEN_SPLIT.test(v) || v.split(TOKEN_SPLIT).map(p => p.replace(/[.:]+$/, '')).some(p => p && !vocabulary(p));
      if (identifying(v) && named && !out.has(v)) out.set(v, shown || '(root)');
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, `${at}[]`, underOpaque ? shown : `${shown}[]`, depth + 1, underOpaque);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const spelled = allow.has(k) || idents.has(k);
        // Keys inside an opaque map are never rendered (api-digest-shape.js); values are still
        // checked everywhere, because the gate errs towards refusing.
        if (!underOpaque && PRINTABLE_KEY.test(k) && !spelled && !out.has(k)) out.set(k, `${shown || '(root)'} (a key)`);
        const payload = k === 'data' && (at === '' || at === 'clusters[]');
        const piece = spelled ? k : '<key>';
        const next = underOpaque ? shown : shown ? `${shown}.${piece}` : piece;
        walk(x, at ? `${at}.${k}` : k, next, depth + 1, underOpaque || (OPAQUE.has(k) && !payload));
      }
    }
  };
  for (const b of bodies) walk(b, '', '', 0, false);
  return out;
}

const PATTERNS = [
  ['IPv4 address', /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/],
  ['email address', /[\w.+-]+@[\w-]+\.[\w.-]*[A-Za-z]/],
  ['JWT', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/],
  ['workstation path', /(?:\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|[A-Z]:\\Users\\)/]
];

/**
 * Refuse a document that carries a value. Tokens are split the way a reader would see them, so a
 * name inside a path or a table cell is found, and a value holding a split character
 * (`deployments[ns=<namespace>]`) is looked for whole, since no token can equal it. A dotted token is read piece by piece as well,
 * because a response structure's path (`data.<key>.hosts[]`) is keys and one of them can be the
 * cluster's; a dotted word the code spells whole (`cert-manager.io`) is the code's, and is read
 * whole only, so a namespace that shares its first label does not refuse it. Each hit is reported
 * masked, with where the value came from and where in the document it landed: the heading above
 * it, the line, and the line's text with every value on it masked. A heading is masked the same
 * way, since every hit below it names it. A value is never reported in full.
 *
 * A sentence the code spells (a tab label, this tool's own prose) vouches for its words where it
 * prints whole, and nowhere else: `Helm` inside `Cluster → Helm Releases` is the console's label,
 * while `Helm` alone in a path is a webhook owner the cluster sent. Patterns still read the whole line.
 *
 * @param {string} doc
 * @param {Map<string, string>} forbidden what `forbiddenValues` found
 * @param {Set<string>} [allow] strings the code itself spells
 * @param {Iterable<string>} [sentences] literals with whitespace the code or this tool spells
 * @returns {{ ok: boolean, hits: { kind: string, masked: string, from: string, at: string, context: string }[] }}
 */
function privacyGate(doc, forbidden, allow = new Set(), sentences = []) {
  const hits = [];
  const mask = s => `${s.slice(0, 2)}…(${s.length})`;
  const seen = new Set();
  // Longest first, so a sentence is never left half-read by a shorter one inside it.
  const whole = [...new Set(sentences)].filter(s => /\S\s+\S/.test(s) && doc.includes(s)).sort((a, b) => b.length - a.length);
  // A value holding a character the tokens are split on is never one token, so it is looked for whole.
  const spanning = [...forbidden.keys()].filter(v => TOKEN_SPLIT.test(v) && doc.includes(v));
  let heading = '(top)';
  doc.split('\n').forEach((line, i) => {
    const found = [];
    for (const [kind, re] of PATTERNS) {
      const m = line.match(re);
      if (m) found.push({ kind, value: m[0], from: 'pattern' });
    }
    let words = line;
    for (const s of whole) if (words.includes(s)) words = words.split(s).join(' ');
    for (const value of spanning) if (words.includes(value)) found.push({ kind: 'response value', value, from: forbidden.get(value) });
    for (const raw of words.split(TOKEN_SPLIT)) {
      const tok = raw.replace(/[.:]+$/, '');
      const pieces = tok.includes('.') && !allow.has(tok) ? tok.split('.') : [];
      // As it prints, too: a value can end in a dot or a colon of its own (`api.acme.example.com.`).
      for (const value of new Set([raw, tok, ...pieces])) {
        if (value && forbidden.has(value)) found.push({ kind: 'response value', value, from: forbidden.get(value) });
      }
    }
    // Mask every value on the line, including one already reported further up.
    let context = line;
    for (const f of found) context = context.split(f.value).join(mask(f.value));
    if (/^#{1,4} /.test(line)) heading = context.replace(/^#+ /, '');
    if (!found.length) return;
    for (const f of found) {
      if (seen.has(f.value)) continue;
      seen.add(f.value);
      hits.push({ kind: f.kind, masked: mask(f.value), from: f.from, at: `${heading}, line ${i + 1}`, context: context.trim().slice(0, 200) });
    }
  });
  return { ok: hits.length === 0, hits };
}

/* -------------------------------------------------------------------------------- output */

const kb = n => (n / 1024).toFixed(1);
const esc = s => String(s).replace(/\|/g, '\\|');
const tick = s => `\`${s}\``;

/**
 * The scanned console usage of one route: the entries on its path that request its method. The
 * scan keys by path, and `/clusters` is both the roster read and the onboarding write. An entry
 * with no `method` is a GET, as a direct URL always is.
 */
const usageFor = (usage, route) => (usage.get(route.path) ?? []).filter(e => (e.method ?? 'GET') === route.method);

/** The console column, from the scanned usage and the catalogue's note. */
function consoleOf(route, usage, { short = false } = {}) {
  const entries = usageFor(usage, route);
  const parts = [];
  if (route.console) parts.push(route.console);
  for (const { fn, callers } of entries) {
    const name = fn === 'direct URL' ? 'a direct URL' : tick(`api.${fn}`);
    if (!callers.length) {
      parts.push(`${name}: no console caller`);
      continue;
    }
    const views = [...new Set(callers.flatMap(c => c.views))];
    const orphans = callers.filter(c => !c.views.length).map(c => c.file);
    if (short) {
      parts.push(views.length ? `${views.slice(0, 2).join(', ')}${views.length > 2 ? ` +${views.length - 2}` : ''}` : 'caller no view reaches');
      continue;
    }
    let text = views.length
      ? `${name}: ${views.slice(0, 8).join(', ')}${views.length > 8 ? `, and ${views.length - 8} more` : ''}`
      : `${name}: called only from files no tab or page reaches`;
    if (orphans.length) text += ` (unreached caller: ${orphans.map(tick).join(', ')})`;
    parts.push(text);
  }
  if (!parts.length) return short ? 'none' : 'not requested by the console';
  return short ? [...new Set(parts)].join('; ') : parts.join('; ');
}

function readsSummary(reads) {
  if (!reads) return null;
  const cached = reads.cachedCalls ? `, ${reads.cachedCalls} answered by the 8 s list cache` : '';
  return `${reads.calls} call${reads.calls === 1 ? '' : 's'}${cached}; ${kb(reads.bytes)} KB in the answers`;
}

/** Reads are attributed by timing alone (api-digest-trace.js), so a shared window is named. */
const sharedNote = a =>
  `While ${tick(`GET ${a.route.path}`)} answered, the server answered ${a.otherRequests} other request(s) too, so these reads may include theirs.`;

function readsBlock(reads, max = 40) {
  const lines = reads.reads.slice(0, max).map(e => {
    const notes = [];
    if (e.calls > 1) notes.push(`x${e.calls}`);
    if (e.live === 0) notes.push('list cache');
    return `kubectl get --raw '${e.path}'${notes.length ? `   # ${notes.join(', ')}` : ''}`;
  });
  if (reads.reads.length > max) lines.push(`# … and ${reads.reads.length - max} more paths`);
  return ['```bash', ...lines, '```'];
}

function verifiedCell(a, when) {
  if (a.skipped) return `not called: ${a.skipped}`;
  if (a.route.method !== 'GET') return `not called: ${a.route.probe?.skip ?? 'it writes'}`;
  if (a.status === undefined) return 'not called on this run';
  return `${a.status || 'ERR'} · ${a.ms} ms · ${kb(a.bytes)} KB · ${a.envelope} · ${when}`;
}

function capturesCell(a) {
  if (a.skipped || !a.verdict) return '—';
  return `**${a.verdict.word}**, ${a.verdict.detail}`;
}

function queryCell(route) {
  if (!route.query?.length) return 'none';
  return route.query.map(q => `${tick(q.name)}${q.repeatable ? ' (repeatable)' : ''}`).join(', ');
}

/** One entry of §6: every route of a topic, siblings side by side. */
function topicEntry(topic, routes, byPath, usage, meta) {
  const L = [];
  const primary = routes.find(r => isClusterPath(r.path) && r.method === 'GET') ?? routes[0];
  L.push(`### ${primary.title}`, '');
  L.push(routes.map(r => tick(`${r.method} ${r.path}`)).join(' · '), '');

  const purposes = [...new Set(routes.map(r => r.purpose))];
  if (purposes.length === 1) L.push(purposes[0], '');
  else for (const r of routes) L.push(`- ${tick(r.path)}: ${r.purpose}`);
  if (purposes.length > 1) L.push('');

  const cols = routes.map(r => byPath.get(`${r.method} ${r.path}`) ?? { route: r });
  L.push(`| | ${routes.map(r => tick(`${r.method} ${r.path}`)).join(' | ')} |`);
  L.push(`|---|${routes.map(() => '---').join('|')}|`);
  L.push(`| Verified | ${cols.map(a => esc(verifiedCell(a, meta.date))).join(' | ')} |`);
  L.push(`| Captures | ${cols.map(a => esc(capturesCell(a))).join(' | ')} |`);
  L.push(`| Query | ${routes.map(r => esc(queryCell(r))).join(' | ')} |`);
  L.push(`| Console | ${routes.map(r => esc(consoleOf(r, usage))).join(' | ')} |`);
  L.push('');

  const params = new Map();
  for (const r of routes) for (const q of r.query ?? []) if (!params.has(q.name)) params.set(q.name, q);
  if (params.size) {
    L.push('| Query parameter | Meaning |', '|---|---|');
    for (const q of params.values()) L.push(`| ${tick(q.name)}${q.repeatable ? ' (repeatable)' : ''} | ${esc(q.doc)} |`);
    L.push('');
  }

  const reuses = [...new Set(routes.flatMap(r => r.reuses ?? []))];
  if (reuses.length) {
    L.push(
      `Reuses the cached answers of ${reuses.map(p => tick(`GET ${p}`)).join(', ')}, so the reads`,
      'listed below are only the ones it made itself on this sweep; the rest are listed under those routes.',
      ''
    );
  }

  // 1. Command.
  L.push('**Command**', '', '```bash');
  for (const r of routes) {
    const a = byPath.get(`${r.method} ${r.path}`);
    if (r.method === 'GET') {
      const jq = a?.jq ?? PAYLOAD[a?.envelope ?? 'plain']?.jq ?? '.';
      const h = r.probe?.noCache ? " -H 'cache-control: no-cache'" : '';
      if (a?.outline) {
        const type = a.contentType.split(';')[0];
        L.push(a.attachment
          ? `curl -s${h} -OJ "${commandUrl(r)}"   # a ${type} attachment, saved under the name the server gives it`
          : `curl -s${h} "${commandUrl(r)}"   # ${type}, not JSON`);
      } else {
        L.push(`curl -s${h} "${commandUrl(r)}" | jq '${jq}'`);
      }
    } else {
      const body = r.body ? " -H 'content-type: application/json' -d @request.json" : '';
      L.push(`curl -s -X ${r.method} "${commandUrl(r)}"${body}`);
    }
  }
  L.push('```', '');

  const traced = cols.filter(a => a.reads && a.reads.calls);
  if (meta.traced) {
    if (!traced.length) {
      const called = cols.filter(a => a.status);
      if (called.length) L.push('**Kubernetes reads**: none observed. It answered from the fleet\'s own state or from a route cache filled earlier in the sweep.', '');
    } else {
      const main = traced.find(a => isClusterPath(a.route.path)) ?? traced[0];
      L.push(`**Kubernetes reads**, observed while ${tick(`GET ${main.route.path}`)} answered: ${readsSummary(main.reads)}.`, '');
      L.push(...readsBlock(main.reads), '');
      if (main.otherRequests) L.push(sharedNote(main), '');
      const mainPaths = new Set(main.reads.reads.map(e => e.path));
      for (const a of traced) {
        if (a === main) continue;
        const extra = a.reads.reads.filter(e => !mainPaths.has(e.path));
        if (!extra.length) L.push(`${tick(`GET ${a.route.path}`)}: ${readsSummary(a.reads)}, over the same paths.`, '');
        else {
          L.push(`${tick(`GET ${a.route.path}`)}: ${readsSummary(a.reads)}. Paths beyond the ones above:`, '');
          L.push(...readsBlock({ reads: extra }), '');
        }
        if (a.otherRequests) L.push(sharedNote(a), '');
      }
    }
  }

  // 2. Response.
  for (const a of cols) {
    const r = a.route;
    if (r.method !== 'GET') {
      L.push(`**${r.method} ${r.path}** is not called by the digest: ${r.probe?.skip ?? 'it writes'}.`, '');
      if (r.responds) L.push('Response, from the handler (not called):', '', '```jsonc', r.responds.trim(), '```', '');
      if (r.effect) L.push(`Effect: ${r.effect}`, '');
      if (r.body) L.push('Request body:', '', '```jsonc', r.body.trim(), '```', '');
      continue;
    }
    // A GET the sweep cannot drive to success (the SSO callback needs a live sign-in) documents
    // that answer in the catalogue; the live call below shows what it answered instead.
    if (r.responds) {
      L.push(`**Success response** of ${tick(`GET ${r.path}`)}, from the handler (a live call cannot reach it):`, '', '```jsonc', r.responds.trim(), '```', '');
    }
    if (a.skipped) {
      L.push(`**Response** of ${tick(r.path)}: not recorded, ${a.skipped}.`, '');
      continue;
    }
    if (!a.shape && a.outline?.length) {
      const n = x => `${x} line${x === 1 ? '' : 's'}`;
      L.push(
        `**Response** of ${tick(`GET ${r.path}`)}: a ${tick(a.contentType.split(';')[0])} document, not JSON. Its headings, with the lines under each:`,
        '', '```text', ...a.outline.map(h => `${h.heading}   (${n(h.lines)})`), '```', ''
      );
      continue;
    }
    if (!a.shape) {
      L.push(`**Response** of ${tick(r.path)}: ${a.error ?? a.parseError ?? 'no body'} (content type ${tick(a.contentType || 'none')}).`, '');
      continue;
    }
    const fleetSibling = !isClusterPath(r.path) && routes.some(x => isClusterPath(x.path) && x.method === 'GET');
    const vo = meta.vocabulary ? { vocabulary: meta.vocabulary } : {};
    const { text, folded } = renderShape(a.shape, { maxLines: fleetSibling ? 60 : 140, ...vo });
    const where = PAYLOAD[a.envelope];
    const lists = a.lists?.length ? `payload at the root: ${a.lists.map(l => tick(`${l}[]`)).join(', ')}` : null;
    const note = [`${a.envelope} envelope`, where.at ? `payload at ${tick(where.at)}` : lists, folded ? 'deepest objects folded' : null]
      .filter(Boolean)
      .join(', ');
    L.push(`**Response** of ${tick(`GET ${r.path}`)} (${note}):`, '', '```jsonc', text, '```', '');
    const empty = a.capture?.emptyLists ?? [];
    if (empty.length) {
      L.push(`Empty on this read: ${empty.slice(0, 12).map(tick).join(', ')}${empty.length > 12 ? `, and ${empty.length - 12} more` : ''}.`, '');
    }
    const c = a.completeness;
    if (c.unavailable.length) L.push(`Unavailable on this read: ${c.unavailable.map(tick).join(', ')}.`, '');
    if (c.truncated.length) L.push(`Truncated on this read: ${c.truncated.map(tick).join(', ')}.`, '');
    const notRead = notReadOf(c);
    if (notRead.length) L.push(`Not fully read on this read: ${notRead.join('; ')}.`, '');
  }
  return L;
}

/**
 * The base URL as a reader types it. A loopback address prints as `localhost`: the privacy gate
 * reads `127.0.0.1` as an address, and it names the reader's own machine, nothing in a cluster.
 */
const displayBase = b => String(b).replace(/^(https?:\/\/)127\.0\.0\.1(?=[:/]|$)/, '$1localhost');

function markdown(results, meta) {
  const L = [];
  const push = (...s) => L.push(...s);
  const byPath = new Map(results.map(a => [`${a.route.method} ${a.route.path}`, a]));
  const all = ROUTES.map(r => byPath.get(`${r.method} ${r.path}`) ?? { route: r });
  const called = results.filter(a => a.status !== undefined && !a.skipped);
  const usage = meta.usage;

  push('# Fleet API digest: every route, its command, response and console use', '');
  push(
    'Generated by `npm run fleet:digest` (server/fleet/tools/api-digest.js) against a running fleet API,',
    `${provenanceText(meta.provenance)}. Regenerate it rather than editing it.`,
    'Every GET route was called live; response structures are value-free: each value is replaced by its JSON type.',
    ''
  );
  push('| | |', '|---|---|');
  push(`| Generated | ${meta.generatedAt} |`);
  push(`| Base URL | ${tick(displayBase(meta.base))} |`);
  push(`| Cluster probed | ${tick(meta.cluster)} |`);
  push(`| Routes mounted | ${ROUTES.length}: ${ROUTES.filter(r => r.method === 'GET').length} GET, ${ROUTES.filter(r => r.method !== 'GET').length} write (\`listRoutes\` in server/fleet/__tests__/helpers/router-harness.js) |`);
  push(`| GET routes called | ${called.length}, of which ${called.filter(a => a.status === 200).length} answered 200 |`);
  const words = ['yes', 'partial', 'empty', 'no'].map(w => `${called.filter(a => a.verdict?.word === w).length} ${w}`).join(', ');
  push(`| Captures data | ${words} |`);
  const shared = called.filter(a => a.otherRequests).length;
  const sharedText = shared ? `; ${shared} route(s) shared the server with other requests, marked under each` : '';
  push(`| Kubernetes reads | ${meta.traced ? `traced from the dev server (\`FLEET_TRACE_K8S=1\`)${sharedText}` : 'not traced on this run (pass `--trace-log`)'} |`);
  push('');

  push('## 1. Route summary', '');
  push('| Route | Status | ms | KB | Shape | Captures | Console |');
  push('|---|---|---|---|---|---|---|');
  for (const a of all) {
    const r = a.route;
    const label = tick(`${r.method} ${r.path}`);
    if (r.method !== 'GET') {
      push(`| ${label} | not called | — | — | — | write route | ${esc(consoleOf(r, usage, { short: true }))} |`);
    } else if (a.skipped || a.status === undefined) {
      push(`| ${label} | not called | — | — | — | — | ${esc(consoleOf(r, usage, { short: true }))} |`);
    } else {
      push(`| ${label} | ${a.status || 'ERR'} | ${a.ms} | ${kb(a.bytes)} | ${a.envelope} | ${a.verdict.word} | ${esc(consoleOf(r, usage, { short: true }))} |`);
    }
  }
  push('');

  push('## 2. Envelope shapes', '');
  push(
    'There is no single fleet envelope, and a panel author who assumes one finds the rows',
    'missing rather than wrong. Four envelopes wrap a payload: `wrapper`, `roster`, `inline` and',
    '`flattened`. The other rows are routes that answer a bare object (`plain`) or a body that is',
    'not JSON (`non-object`). Where to read the payload, per shape:',
    ''
  );
  push('| Shape | Envelope | Payload lives at | Used by |', '|---|---|---|---|');
  const byShape = new Map();
  for (const a of called) {
    if (!byShape.has(a.envelope)) byShape.set(a.envelope, []);
    byShape.get(a.envelope).push(a.route.path);
  }
  const SHAPE_DOC = {
    wrapper: ['`{ cluster, ok, data, token? }`', '`data`'],
    roster: ['`{ summary, clusters[{ cluster, ok, data }] }`', '`clusters[].data`'],
    flattened: ['`{ summary, clusters[{ id, ok, error }], items[] }`, or named lists in place of `items[]`', 'the root lists (`items[]`, `pvcs[]`, …); `clusters[]` is status only'],
    inline: ['`{ summary, clusters[{ clusterId, …payload }] }`', 'the cluster entry itself'],
    plain: ['a bare object', 'the root'],
    'non-object': ['—', '—']
  };
  for (const [shape, paths] of [...byShape].sort((x, y) => y[1].length - x[1].length)) {
    const [env, at] = SHAPE_DOC[shape] ?? ['—', '—'];
    const sample = paths.slice(0, 4).map(tick).join(', ');
    push(`| ${shape} | ${env} | ${at} | ${paths.length} route(s): ${sample}${paths.length > 4 ? ' …' : ''} |`);
  }
  push('');
  push(
    'On the `roster` and `wrapper` shapes, `ok` is **three-state**: `true` read, `false`',
    'unreachable, and `null`/absent registered-but-not-read-yet. Counting `null` as unreachable',
    'is the classic bug here.',
    ''
  );

  push('## 3. Write routes and the structure-only route', '');
  push(
    'The digest is GET-only. Write routes are documented from the catalogue in §6 (request body and',
    'effect) and never called. `GET /clusters/:id/logs` returns raw application output, passed',
    'through verbatim by design (server/fleet/collectors/logs.js); it is called for its structure only,',
    'and each line folds into `"string"` before anything is written.',
    ''
  );
  push('| Route | Why it is not called |', '|---|---|');
  for (const r of ROUTES.filter(x => x.method !== 'GET')) push(`| ${tick(`${r.method} ${r.path}`)} | ${esc(r.probe?.skip ?? 'writes')} |`);
  push('');

  push('## 4. Slowest routes', '');
  push(
    'Each route was called once, in dependency order: `/clusters`, the per-cluster routes, the routes',
    'that need a discovered object, the fleet routes, and last the routes that reuse other routes\'',
    'cached answers. Read these as **first-visit cost in that order**, not as a benchmark. Answers',
    'are cached for 30 s per route and Kubernetes list reads for 8 s, so a fleet route called after',
    'its per-cluster sibling can find its lists warm. `traffic-errors` and `traces` were called with',
    '`cache-control: no-cache`, which makes them read their log window afresh.',
    ''
  );
  push('| Route | ms | KB |', '|---|---|---|');
  for (const a of [...called].sort((x, y) => y.ms - x.ms).slice(0, 12)) push(`| ${tick(a.route.path)} | ${a.ms} | ${kb(a.bytes)} |`);
  push('');

  push('## 5. Completeness, as the backend reported it', '');
  push('Read from each envelope, never inferred from whether the numbers look plausible.', '');
  const incomplete = called.filter(a => a.completeness.unavailable.length || a.completeness.truncated.length || notReadOf(a.completeness).length);
  if (!incomplete.length) {
    push('Every called route reported a complete envelope: no `unavailable` or `truncated` scope, no cluster unreachable or not read, no group short of `ok` and no data source graded short of a trusted read.', '');
  } else {
    push('| Route | Unavailable scopes | Truncated scopes | Clusters, groups or data sources not fully read |', '|---|---|---|---|');
    for (const a of incomplete) {
      const c = a.completeness;
      push(`| ${tick(a.route.path)} | ${c.unavailable.map(tick).join(', ') || '—'} | ${c.truncated.map(tick).join(', ') || '—'} | ${esc(notReadOf(c).join('; ')) || '—'} |`);
    }
    push('');
  }

  push('## 6. Route reference', '');
  push(
    'One entry per topic; a fleet route and its per-cluster sibling sit side by side. Each entry has',
    'the three parts: the **command** (the curl, and the Kubernetes reads behind it), the',
    '**response** structure, and the **console** views that use it.',
    '',
    '| In an entry | Meaning |',
    '|---|---|',
    '| `$FLEET` | the fleet API origin: `http://localhost:8099` under `npm run fleet:dev`. The deployed console is SSO-fronted, and curl there receives the login page at HTTP 200 |',
    '| `$CLUSTER`, `$NAMESPACE`, `$NAME`, … | a registered cluster id and a real object; the digest called each route with one it discovered, and prints the variable, never the value |',
    '| Verified | status, latency, size and envelope of the live call on the date shown |',
    '| Captures | **yes** data came back; **partial** the envelope names scopes it could not read or had to cap, a cluster that did not answer or was not read, a group short of `ok`, or a data source graded short of a trusted read (`capability.state`); **empty** every list was empty on this read (the collector works, the cluster has none); **no** the request or the cluster read failed, no cluster or group was read, or every data source is graded `forbidden`, `not-configured`, `unknown` or `unsupported-backend`. A text document counts its headings with lines under them |',
    '| Kubernetes reads | each upstream call the route made, templated: a name the collector did not choose prints as `{name}`, `{namespace}`, `{group}`, `{resource}` or `{value}`. Each line runs as-is with a reader\'s credentials. A route answered from a stale cache entry answers at once and refreshes the entry behind the answer, so a fast route can list the reads of that refresh |',
    '| Response | the answer\'s skeleton: key names and JSON types. `"string \\| null"` is a field seen both ways; `optional` is a key some rows lack; `"<key>"` is a map keyed by data |',
    '| Console | the `api.ts` function, and the tab or page that reaches its callers |',
    ''
  );
  const topics = [];
  for (const r of ROUTES) if (!topics.includes(r.topic)) topics.push(r.topic);
  for (const t of topics) push(...topicEntry(t, ROUTES.filter(r => r.topic === t), byPath, usage, meta));

  if (meta.traced) {
    push('## 7. Kubernetes reads by path', '');
    push('Every upstream path this sweep read, and the routes that read it. `HIT` counts are calls the 8 s list cache answered.', '');
    const byRead = new Map();
    for (const a of called) {
      for (const e of a.reads?.reads ?? []) {
        const x = byRead.get(e.path) ?? { routes: new Set(), calls: 0, live: 0 };
        x.routes.add(a.route.path);
        x.calls += e.calls;
        x.live += e.live;
        byRead.set(e.path, x);
      }
    }
    push('| Kubernetes path | Calls | HIT | Read by |', '|---|---|---|---|');
    for (const [p, x] of [...byRead].sort((m, n) => m[0].localeCompare(n[0]))) {
      const routesText = [...x.routes].sort().map(tick);
      push(`| ${tick(p)} | ${x.calls} | ${x.calls - x.live} | ${routesText.slice(0, 6).join(', ')}${routesText.length > 6 ? ` +${routesText.length - 6}` : ''} |`);
    }
    push('');
  }

  push(`## ${meta.traced ? 8 : 7}. Console reach`, '');
  push('What the console requests, read from app/fleet-ui/src on this run.', '');
  const unrequested = ROUTES.filter(r => r.method === 'GET' && !usageFor(usage, r).some(e => e.callers.length) && !r.console);
  push(`**GET routes no console file requests** (${unrequested.length}): ${unrequested.map(r => tick(r.path)).join(', ') || 'none'}.`, '');
  const idle = [];
  const unreached = new Set();
  for (const [p, entries] of usage) {
    for (const e of entries) {
      if (!e.callers.length && e.fn !== 'direct URL') idle.push(`${tick(`api.${e.fn}`)} (${tick(`${e.method ?? 'GET'} ${p}`)})`);
      for (const c of e.callers) if (!c.views.length) unreached.add(c.file);
    }
  }
  push(`**\`api.ts\` functions nothing calls** (${idle.length}): ${idle.sort().join(', ') || 'none'}.`, '');
  push(`**Calling files no tab or page reaches** (${unreached.size}): ${[...unreached].sort().map(tick).join(', ') || 'none'}.`, '');

  return L.join('\n');
}

/**
 * The `--json-out` file: field paths per route, for checking a document that cites `data.<field>`
 * against what the routes actually returned. Key paths and verdicts only, like the document, and
 * gated like it, because the field digest enters a map keyed by data; never committed.
 */
function fieldPaths(results, { generatedAt, cluster }) {
  const routes = results.filter(a => a.digest).map(a => ({
    method: a.route.method,
    path: a.route.path,
    status: a.status,
    verdict: a.verdict.word,
    envelope: a.envelope,
    prefix: a.digest.prefix,
    fields: a.digest.fields.map(f => f.path)
  }));
  return JSON.stringify({ generatedAt, cluster, routes }, null, 1);
}

/* ---------------------------------------------------------------------------- provenance */

const git = args => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * The commit the document describes, and whether the code under it had uncommitted changes then:
 * a digest of a dirty tree describes routes and callers that no commit holds. Both are `null`
 * when git cannot answer (no git, or not a checkout).
 *
 * @param {(args: string[]) => string} [run] git, injectable for the tests
 * @returns {{ commit: string|null, dirty: boolean|null }}
 */
function provenance(run = git) {
  try {
    const commit = run(['rev-parse', '--short', 'HEAD']) || null;
    const dirty = run(['status', '--porcelain', '--', 'server', 'app/fleet-ui']) !== '';
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** The header's provenance clause, from `provenance`. */
function provenanceText(p) {
  if (!p?.commit) return 'commit unknown';
  return `from commit ${tick(p.commit)}${p.dirty ? ', with uncommitted changes under server/ or app/fleet-ui/' : ''}`;
}

/* ---------------------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: fleet:digest [--base URL] [--cluster ID] [--out FILE] [--timeout MS] [--trace-log FILE] [--json-out FILE]');
    return;
  }
  const log = s => console.error(`[fleet:digest] ${s}`);
  // One identifier set for every response structure and for the privacy gate: a key the source
  // spells is a field name, and only a word it never spells can be a value.
  const idents = identifiersOf([...collectorFiles(), ...uiFiles()]);
  const { results, clusterId, bodies } = await sweep(args, log, { vocabulary: idents });

  const routePaths = [...new Set(ROUTES.map(r => r.path))];
  const usage = consoleUsage(UI_SRC, routePaths);
  const now = new Date();
  const doc = markdown(results, {
    generatedAt: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    base: args.base,
    cluster: clusterId,
    traced: Boolean(args.traceLog),
    provenance: provenance(),
    vocabulary: idents,
    usage
  });

  // The route methods print in every route's row, and a response can carry the same word (an
  // APIRule's allowed methods); a verb names nothing in a cluster.
  const allow = new Set([...collectorLiterals(), ...uiLiterals(), clusterId, ...ROUTES.map(r => r.method)]);
  const forbidden = forbiddenValues(bodies, allow, idents);
  const refuseUnless = (gate, what) => {
    if (gate.ok) return;
    for (const h of gate.hits.slice(0, 40)) log(`privacy gate: ${h.kind} ${h.masked} (from ${h.from}; in "${h.at}": ${h.context})`);
    throw new Error(`privacy gate refused ${what}: ${gate.hits.length} value(s) would reach it`);
  };
  refuseUnless(privacyGate(doc, forbidden, allow, documentSentences()), 'the document');

  if (args.out) {
    const file = path.resolve(args.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc.endsWith('\n') ? doc : `${doc}\n`);
    log(`wrote ${path.relative(process.cwd(), file)} (${(doc.length / 1024).toFixed(0)} KB)`);
  } else {
    process.stdout.write(doc);
  }

  // Written after the document, which passed its own gate, so refused field paths leave it in place.
  if (args.jsonOut) {
    const json = fieldPaths(results, { generatedAt: now.toISOString(), cluster: clusterId });
    refuseUnless(privacyGate(json, forbidden, allow), 'the field paths');
    fs.writeFileSync(path.resolve(args.jsonOut), json);
    log(`wrote field paths to ${path.relative(process.cwd(), path.resolve(args.jsonOut))}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`[fleet:digest] ${err.message}`);
    process.exit(1);
  });
}

export default {
  OPAQUE, PAYLOAD, completeness, digestOf, shapeOf, payloadJq, parseArgs, sweepPlan, discover, probeUrl, commandUrl,
  verdictOf, analyse, forbiddenValues, privacyGate, markdown, consoleOf, collectorFiles, uiFiles, identifiersOf, outlineOf,
  sweep, requestsIn, displayBase, provenance, provenanceText, fieldPaths, documentSentences
};
