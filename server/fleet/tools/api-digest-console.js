/**
 * Where the console uses each route: the `api.ts` function that requests it, the files that call
 * that function, and the tab or page each file is reached from.
 *
 * Read from app/fleet-ui/src on every run rather than kept as a list, because tabs keep being
 * split and regrouped and a hand-kept "used by" column is the first thing to go stale:
 *
 *   1. `api.ts`'s `api` object maps a function name to the path it requests and the method it sends.
 *   2. Every other source file is scanned for `api.<name>` references.
 *   3. The import graph is walked upwards from each calling file until it reaches a tab mounted
 *      in pages/ClusterDetail.tsx (`tab === '<id>' && <Component …>`) or a page routed in
 *      App.tsx. Tab labels come from `TABS` in pages/cluster-tabs/tabs.ts.
 *
 * Regex over TypeScript, deliberately: the shapes it reads are the conventions of this codebase,
 * and `server/fleet/__tests__/api-digest-modules.test.js` pins them against the real files so a convention change
 * fails a test instead of silently emptying the column.
 */

import fs from 'node:fs';
import path from 'node:path';

import apiDigestSourceModule from './api-digest-source.js';
const { stripComments } = apiDigestSourceModule;

const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];


/** Every non-test TypeScript source under `root`, as paths relative to it. */
function listSources(root) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(path.relative(root, p).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** `/clusters/${id}/helm/releases/${encodeURIComponent(namespace)}` -> `/clusters/:id/helm/releases/:namespace`. */
function normaliseTemplate(t) {
  return t
    .replace(/\$\{qs\([\s\S]*$/, '')
    .split('?')[0]
    .replace(/\$\{encodeURIComponent\((\w+)\)\}/g, ':$1')
    .replace(/\$\{(\w+)\}/g, ':$1')
    .replace(/\/+$/, '');
}

/**
 * The `api` object's functions, each with the route template it requests and the method it sends.
 *
 * Every function requests through `get(path, init)`, and a write names its verb in the `method`
 * field of `init`; a function that names none is a GET. The method matters because one path can
 * carry two routes: `GET /clusters` lists the fleet, `POST /clusters` onboards.
 *
 * @param {string} apiSrc contents of api.ts
 * @returns {Map<string, { method: string, path: string }>} function name -> uppercase method and normalised path template
 */
function apiFunctions(apiSrc) {
  const src = stripComments(apiSrc);
  const helpers = new Map();
  for (const m of src.matchAll(/export const (\w+) = \([^)]*\)[^=]*=>\s*`([^`]*)`/g)) helpers.set(m[1], m[2]);

  const start = src.indexOf('export const api = {');
  if (start === -1) return new Map();
  const end = src.indexOf('\n};', start);
  const body = src.slice(start, end === -1 ? undefined : end);
  const props = [...body.matchAll(/^ {2}(\w+):/gm)];
  const out = new Map();
  props.forEach((m, i) => {
    const text = body.slice(m.index, i + 1 < props.length ? props[i + 1].index : body.length);
    const lit = text.match(/[`'](\/[^`']*)[`']/);
    let t = lit ? lit[1] : null;
    if (!t) {
      const call = text.match(/\b(\w+Path)\(/);
      if (call && helpers.has(call[1])) t = helpers.get(call[1]);
    }
    const verb = text.match(/\bmethod:\s*[`'"]([A-Za-z]+)[`'"]/);
    if (t) out.set(m[1], { method: verb ? verb[1].toUpperCase() : 'GET', path: normaliseTemplate(t) });
  });
  return out;
}

/** Match a console template against the router's Express paths, segment by segment. */
function matchRoute(template, routePaths) {
  const a = template.split('/');
  for (const r of routePaths) {
    const b = r.split('/');
    if (a.length !== b.length) continue;
    if (b.every((seg, i) => (seg.startsWith(':') ? a[i].startsWith(':') : seg === a[i]))) return r;
  }
  return null;
}

function resolveImport(fromFile, spec, known) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (known.has(base)) return base;
  for (const ext of EXTS) if (known.has(base + ext)) return base + ext;
  return null;
}

/** file -> set of files it imports (static, re-export and dynamic `import()`). */
function importGraph(root, files) {
  const known = new Set(files);
  const graph = new Map();
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
    const deps = new Set();
    for (const m of src.matchAll(/(?:import|export)\s[^'";]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const r = resolveImport(f, m[1] ?? m[2], known);
      if (r) deps.add(r);
    }
    graph.set(f, deps);
  }
  return graph;
}

/** Which local file a component name in `file` comes from: named, default or `lazy(() => import())`. */
function componentFiles(root, file, known) {
  const src = stripComments(fs.readFileSync(path.join(root, file), 'utf8'));
  const map = new Map();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const r = resolveImport(file, m[2], known);
    if (!r) continue;
    for (const name of m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) map.set(name, r);
  }
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const r = resolveImport(file, m[2], known);
    if (r) map.set(m[1], r);
  }
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"](\.[^'"]+)['"]/g)) {
    const r = resolveImport(file, m[2], known);
    if (r) map.set(m[1], r);
  }
  return { src, map };
}

/**
 * The views a user reaches: every tab ClusterDetail mounts and every page App routes.
 *
 * @returns {Map<string, string[]>} file -> labels ("Cluster → Networking", "page /drift")
 */
function viewEntries(root, files) {
  const known = new Set(files);
  const entries = new Map();
  const add = (f, label) => {
    if (!f) return;
    const l = entries.get(f) ?? [];
    if (!l.includes(label)) l.push(label);
    entries.set(f, l);
  };

  const labels = new Map();
  const tabsFile = path.join(root, 'pages/cluster-tabs/tabs.ts');
  if (fs.existsSync(tabsFile)) {
    const tabs = fs.readFileSync(tabsFile, 'utf8');
    const block = tabs.slice(tabs.indexOf('export const TABS'), tabs.indexOf('];', tabs.indexOf('export const TABS')));
    for (const m of block.matchAll(/id:\s*'([a-z-]+)'[^}]*?label:\s*'([^']+)'/g)) labels.set(m[1], m[2]);
  }

  if (known.has('pages/ClusterDetail.tsx')) {
    const { src, map } = componentFiles(root, 'pages/ClusterDetail.tsx', known);
    for (const m of src.matchAll(/tab === '([a-z-]+)'\s*&&/g)) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 600);
      const comp = after.match(/<([A-Z]\w*)/);
      if (comp) add(map.get(comp[1]), `Cluster → ${labels.get(m[1]) ?? m[1]}`);
    }
    add('pages/ClusterDetail.tsx', 'Cluster page (every tab)');
  }

  if (known.has('App.tsx')) {
    const { src, map } = componentFiles(root, 'App.tsx', known);
    for (const m of src.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)/g)) add(map.get(m[2]), `page ${m[1]}`);
    for (const m of src.matchAll(/<Route\s+path="([^"]+)"[\s\S]{0,200}?element=\{\s*<(\w+)/g)) add(map.get(m[2]), `page ${m[1]}`);
    add('App.tsx', 'App shell (every page)');
  }
  return entries;
}

/**
 * One label where one says it all: a file the app shell imports is on every page, and one the
 * cluster page imports is on every tab, so the individual tab labels under it add nothing.
 */
function collapseViews(views) {
  if (views.includes('App shell (every page)')) return ['App shell (every page)'];
  if (views.includes('Cluster page (every tab)')) return views.filter(v => !v.startsWith('Cluster → '));
  return views;
}

/** Walk importers upwards from `file` to the views that reach it. */
function viewsFor(file, reverse, entries) {
  const out = new Set();
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    const f = queue.shift();
    if (entries.has(f)) {
      for (const l of entries.get(f)) out.add(l);
      if (f !== file || entries.get(f).length) continue;
    }
    for (const up of reverse.get(f) ?? []) {
      if (!seen.has(up)) {
        seen.add(up);
        queue.push(up);
      }
    }
  }
  return collapseViews([...out].sort());
}

/**
 * Route -> console usage.
 *
 * Keyed by path, so a path's entries cover every method on it; each entry says which method it
 * sends, and the caller keeps the ones matching the route it is describing.
 *
 * @param {string} root app/fleet-ui/src
 * @param {string[]} routePaths Express paths from the router
 * @returns {Map<string, { fn: string, method: string, callers: { file: string, views: string[] }[] }[]>}
 */
function consoleUsage(root, routePaths) {
  const files = listSources(root);
  const fns = apiFunctions(fs.readFileSync(path.join(root, 'api.ts'), 'utf8'));
  const graph = importGraph(root, files);
  const reverse = new Map();
  for (const [f, deps] of graph) {
    for (const d of deps) {
      if (!reverse.has(d)) reverse.set(d, new Set());
      reverse.get(d).add(f);
    }
  }
  const entries = viewEntries(root, files);

  const callersOf = new Map();
  for (const f of files) {
    if (f === 'api.ts') continue;
    const src = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
    // `\s*` either side of the dot: a chained call is often split, `void api\n  .clusterTrace(…)`.
    for (const m of src.matchAll(/\bapi\s*\.\s*(\w+)\b/g)) {
      if (!callersOf.has(m[1])) callersOf.set(m[1], new Set());
      callersOf.get(m[1]).add(f);
    }
  }

  const usage = new Map();
  for (const [fn, { method, path: template }] of fns) {
    const route = matchRoute(template, routePaths);
    if (!route) continue;
    const callers = [...(callersOf.get(fn) ?? [])].sort().map(file => ({ file, views: viewsFor(file, reverse, entries) }));
    if (!usage.has(route)) usage.set(route, []);
    usage.get(route).push({ fn, method, callers });
  }

  // A few requests bypass `api.ts` and name the URL directly, as a link or `window.open`
  // (the Drift page's report download). They are callers too, and GETs: a browser follows a link
  // with one.
  const direct = new Map();
  for (const f of files) {
    if (f === 'api.ts') continue;
    const src = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
    for (const m of src.matchAll(/[`'"]\/api\/fleet(\/[^`'"?#]*)/g)) {
      const route = matchRoute(normaliseTemplate(m[1]), routePaths);
      if (!route) continue;
      if (!direct.has(route)) direct.set(route, new Set());
      direct.get(route).add(f);
    }
  }
  for (const [route, set] of direct) {
    const callers = [...set].sort().map(file => ({ file, views: viewsFor(file, reverse, entries) }));
    if (!usage.has(route)) usage.set(route, []);
    usage.get(route).push({ fn: 'direct URL', method: 'GET', callers });
  }
  return usage;
}

export default { consoleUsage, apiFunctions, normaliseTemplate, matchRoute, viewEntries, collapseViews, listSources, stripComments };
