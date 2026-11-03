// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The per-cluster envelope gate.
 *
 * Every `GET /clusters/:id/<x>` route in `router.js` answers with `res.json(result)` — one
 * fan-out result, so `{cluster, ok, data, token}` with the payload at `.data`. The fleet-wide
 * sibling answers with `{summary, clusters[]}`. The two shapes are unrelated, and three client
 * types were declared as aliases of the WRONG one:
 *
 *   export type ClusterAutoscaling  = FleetAutoscaling   // and ClusterCertificates, ClusterTopology
 *
 * Nothing caught it. TypeScript happily resolved `data.hpas` on the alias, so the page compiled,
 * shipped, and rendered a permanently empty table — reading one level too shallow with the
 * compiler's blessing. `tsc` cannot catch this class of bug by construction: the alias IS the
 * assertion it checks against. So it is checked here instead, against the router.
 *
 * Two things are asserted, both by reading the two files as text:
 *
 * 1. Every per-cluster route the client calls **exists** in the router — literally, or via
 *    `registerGroupRoutes`. A client method for a route nobody registered is how F63–F65 and
 *    F70–F73 stayed invisible: the tab fell back to the fleet-wide route, which drops those
 *    exact fields.
 * 2. Every per-cluster GET is typed as an envelope, or is listed in EXEMPT with a reason. The
 *    exemption list is deliberately short and explicit — a route that returns its own shape
 *    has to say so here, which is a decision, not an omission.
 */




const ROOT = path.join(FAKE_DIR, '..', '..');
const API_TS = fs.readFileSync(path.join(ROOT, 'src', 'api.ts'), 'utf8');
const ROUTER_JS = fs.readFileSync(path.join(ROOT, 'server', 'fleet', 'router.js'), 'utf8');

/**
 * Routes whose response is genuinely not a fan-out envelope, each with the router shape that
 * makes it so. Anything not listed here must be an envelope.
 */
const EXEMPT = {
  '': 'GET /clusters/:id returns the cluster record itself, not a collector fan-out',
  summary: 'GET /clusters/:id/summary returns {cluster, groups[]} — seventeen verdicts, not one payload',
  logs: 'GET /clusters/:id/logs returns the log tail directly; there is no per-cluster fan-out to wrap',
  remove: 'POST-style action; returns {cluster, removed, leftBehind}',
  'workloads/:p/:p/rollout': 'one workload\'s rollout status, read directly — not a fan-out over clusters'
};

/**
 * `get<T>(`/clusters/${…}/seg…`)` call sites, with T and the route path.
 *
 * The type capture excludes backticks, quotes, parens and newlines on purpose. A permissive
 * `[\s\S]*?` looks equivalent and is not: it happily spans from an *earlier* `get<` on another
 * line all the way to this template literal, so every call site reports the wrong type and the
 * whole gate turns into noise. A type annotation is single-line and contains none of those
 * characters.
 */
function clientCalls() {
  const re = /get<([^`'()\n]*?)>\(\s*`\/clusters\/([^`]*)`/g;
  const out = [];
  let m;
  while ((m = re.exec(API_TS)) !== null) {
    out.push({ type: m[1].trim(), segment: normalizePath(m[2]), index: m.index });
  }
  return out;
}

/**
 * A template path as a comparable route: `${id}` and friends become `:p`, and the query-string
 * helper disappears because it is not part of the route. `/${id}/workloads/${ns}/${n}/rollout`
 * → `workloads/:p/:p/rollout`, `/${id}/pods${qs({…})}` → `pods`.
 *
 * The interpolation pattern allows one level of nested braces: `${qs({ namespace: ns })}`
 * contains a `}` of its own, and a flat `[^}]*` stops at it and leaves `)}` glued to the route.
 */
function normalizePath(raw) {
  const withParams = raw.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, match => (match.includes('qs(') ? '' : ':p'));
  // The leading `${id}` is the cluster itself, not a route segment.
  return withParams.replace(/^:p/, '').replace(/^\//, '').replace(/\/$/, '');
}

/**
 * Follow `export type A = B;` until a concrete shape is reached. Returns the final right-hand
 * side, so `ClusterStorage` → `ClusterGroupEnvelope<StorageData>` in one hop and an accidental
 * `ClusterTopology = FleetTopology` resolves to `FleetTopology` rather than being taken on faith.
 */
function resolveAlias(typeName, hops = 6) {
  let current = typeName;
  for (let i = 0; i < hops; i++) {
    const generic = current.match(/^([A-Za-z0-9_]+)</);
    const bare = current.match(/^([A-Za-z0-9_]+)$/);
    const head = (generic && generic[1]) || (bare && bare[1]);
    if (!head) return current;
    const alias = new RegExp(`export type ${head}\\s*=\\s*([^;]+);`).exec(API_TS);
    if (!alias) return current;
    const next = alias[1].trim();
    if (next === current) return current;
    current = next;
  }
  return current;
}

const ENVELOPE_HEADS = ['Envelope', 'ClusterGroupEnvelope'];

function isEnvelope(type) {
  const resolved = resolveAlias(type);
  // `Envelope<T> & Something` and `ClusterGroupEnvelope<T>` both count; the test is that the
  // envelope is the outermost shape, so `.data` is where the payload lives.
  return ENVELOPE_HEADS.some(head => resolved.startsWith(`${head}<`));
}

/** Route segments the router registers under `/clusters/:id/`, normalized to `:p` params. */
function routerSegments() {
  const segments = new Set();
  const literal = /router\.(get|post|delete)\(\s*'\/clusters\/:id\/?([^']*)'/g;
  let m;
  while ((m = literal.exec(ROUTER_JS)) !== null) segments.add(m[2].replace(/:[A-Za-z][A-Za-z0-9]*/g, ':p'));
  // The generic pair: registerGroupRoutes('capacity', …) registers /capacity and
  // /clusters/:id/capacity from the same call, so the literal scan above cannot see them.
  const group = /registerGroupRoutes\(\s*'([^']+)'/g;
  while ((m = group.exec(ROUTER_JS)) !== null) segments.add(m[1]);
  return segments;
}

test('every per-cluster route the client calls is registered in the router', () => {
  const registered = routerSegments();
  assert.ok(registered.size > 10, `the router scan found only ${registered.size} routes — the scan is broken, not the router`);

  const calls = clientCalls();
  assert.ok(calls.length > 10, `found only ${calls.length} per-cluster client calls — the api.ts scan is broken`);

  const missing = [];
  for (const call of calls) {
    if (!registered.has(call.segment)) {
      missing.push(`/clusters/:id/${call.segment} (typed ${call.type})`);
    }
  }
  assert.deepStrictEqual(missing, [],
    `\napi.ts calls per-cluster routes the router does not register — the request 404s and the ` +
    `tab shows nothing:\n  ${missing.join('\n  ')}\n\nregistered: ${[...registered].sort().join(', ')}\n`);
});

test('every per-cluster GET is typed as the fan-out envelope, not the fleet-wide shape', () => {
  const failures = [];
  for (const call of clientCalls()) {
    const seg = call.segment;
    if (Object.prototype.hasOwnProperty.call(EXEMPT, seg)) continue;
    // Inline object literals (`{cluster: string; removed: boolean}`) are action responses, not
    // collector payloads; they cannot be aliased to the wrong fleet shape.
    if (call.type.startsWith('{')) continue;
    if (!isEnvelope(call.type)) {
      failures.push(
        `/clusters/:id/${seg} is typed ${call.type} → ${resolveAlias(call.type)}, which is not an ` +
        `envelope. The route answers res.json(result) = {cluster, ok, data}: reading the payload ` +
        `off the root gives undefined, and the page renders empty while tsc stays silent.`
      );
    }
  }
  assert.deepStrictEqual(failures, [], `\n${failures.join('\n\n')}\n`);
});

/**
 * The exemption list must not rot into a place where a real envelope route hides. Each key has
 * to correspond to a route that actually exists, so a renamed route takes its exemption with it
 * rather than silently covering a different one.
 */
test('every EXEMPT entry names a route that still exists', () => {
  const registered = routerSegments();
  for (const seg of Object.keys(EXEMPT)) {
    assert.ok(registered.has(seg),
      `EXEMPT lists /clusters/:id/${seg || ''} but the router no longer registers it — ` +
      `drop the exemption or fix the name`);
  }
});

/** The gate's own canary: prove the alias resolver sees through a wrong alias. */
test('resolveAlias sees through an alias to the fleet-wide shape', () => {
  assert.ok(isEnvelope('ClusterGroupEnvelope<StorageData>'));
  assert.ok(isEnvelope('ClusterStorage'), 'ClusterStorage aliases ClusterGroupEnvelope<StorageData>');
  assert.ok(!isEnvelope('FleetTopology'), 'the fleet-wide shape must not read as an envelope');
  assert.ok(!isEnvelope('ClustersResponse'));
});
