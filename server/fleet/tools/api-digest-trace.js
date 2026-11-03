/**
 * Which Kubernetes API calls a fleet route made, read from the dev server's own trace.
 *
 * `FLEET_TRACE_K8S=1` makes `server/fleet/k8s.js` print one JSON line per upstream call
 * (`trace()` there): `{ k8s, path, wait, ms, bytes, t }`, with `HIT ` in front of the path when
 * the short list cache answered instead of the cluster. The digest sweeps routes one at a time,
 * so the lines appended while a route was being answered are that route's reads. This module
 * slices them out and turns each path into one a reader can run with `kubectl get --raw`.
 *
 * Timing is the only attribution, so the same slice also returns the request lines the router
 * prints as each request finishes (`[fleet-audit]` in router.js): they say whether the server
 * answered the digest's request in that window, which proves the log is that server's, and
 * whether it answered anyone else's, whose reads would land in the same window.
 *
 * ## Only what the collector chose survives
 *
 * A traced path mixes two kinds of text: what the code asked for (`/apis/networking.istio.io/…`,
 * `labelSelector=istio=ingressgateway`, the `shoot-info` ConfigMap) and what the cluster supplied
 * (a pod name, a node name, a customer namespace). The first is the point of the document; the
 * second must not reach it. The rule that separates them is exact rather than a guess: a segment
 * or query value is kept when the same string is a literal somewhere in `server/fleet`'s source, and
 * becomes `{namespace}`, `{name}` or `{value}` otherwise. A piece of a literal path, query or
 * selector vouches too: for the API's own words (a group, a resource, a subresource) wherever it
 * stands, and for a namespace, a name or a query value only in the slot the literal puts it in
 * (`slotsOf`), so '/dev/stdout' vouches for no namespace called `dev`. A word inside a message
 * vouches for nothing (`piecesOf`). Numeric paging and window parameters (`limit`, `tailLines`)
 * keep their numbers.
 *
 * The API group and resource are no exception. A core plural (`/api/v1/pods`) is the apiserver's
 * own word, but under `/apis/` a CRD's group is whoever installed it, and a Gatekeeper constraint's
 * plural is the name an operator gave its template. Those print as `{group}` and `{resource}`
 * unless the code spells them.
 */

import fs from 'node:fs';
import path from 'node:path';

import apiDigestSourceModule from './api-digest-source.js';
const { scanSource } = apiDigestSourceModule;

/** Query keys whose numeric or boolean value is a bound the collector set, not cluster data. */
const NUMERIC_KEYS = new Set([
  'limit', 'tailLines', 'limitBytes', 'sinceSeconds', 'timestamps', 'previous', 'resourceVersion',
  'timeoutSeconds', 'watch', 'allowWatchBookmarks'
]);

const SELECTOR_KEYS = new Set(['labelSelector', 'fieldSelector']);

/**
 * Every string literal in the backend's source, read by `scanSource` so that prose in a comment
 * cannot vouch for a name and a `/*` inside a string cannot hide the code after it. Template
 * literals contribute their static parts.
 *
 * @param {string} root directory to scan (server/fleet)
 * @returns {Set<string>}
 */
function codeLiterals(root) {
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p);
      } else if (e.name.endsWith('.js')) {
        files.push(p);
      }
    }
  };
  walk(root);
  return literalsOf(files);
}

/**
 * The literals of an explicit file list, by the same rule as `codeLiterals`.
 *
 * The Set holds every literal and every piece, which is all the privacy gate asks: does the code
 * spell this string? `templatePath` also asks where. `whole` holds the literals themselves, and
 * `at.namespace`, `at.name` and `at.value` the pieces a literal puts in that slot (`slotsOf`).
 *
 * @returns {Set<string> & { whole: Set<string>, at: Record<'namespace' | 'name' | 'value', Set<string>> }}
 */
function literalsOf(files) {
  const out = Object.assign(new Set(), { whole: new Set(), at: { namespace: new Set(), name: new Set(), value: new Set() } });
  for (const f of files) {
    for (const lit of scanSource(fs.readFileSync(f, 'utf8')).literals) {
      if (!lit) continue;
      out.add(lit);
      out.whole.add(lit);
      for (const piece of piecesOf(lit)) out.add(piece);
      for (const [slot, piece] of slotsOf(lit)) out.at[slot].add(piece);
    }
  }
  return out;
}

/** A Markdown heading opening a literal, after any newline escapes: `\n## Fleet Clusters Summary`. */
const HEADING = /^(?:\\[nr])*#{1,6} /;

/**
 * What a literal vouches for besides itself.
 *
 * A literal with no whitespace is a token the code built, a path, a query or a selector, and each
 * of its pieces is the code's choice: '/api/v1/namespaces/kube-system/configmaps/shoot-info' names
 * `kube-system` and `shoot-info`, 'app=istiod' names `istiod`.
 *
 * A literal with whitespace is a sentence, and its words are not: 'failed to read the backend
 * database' must not vouch for a namespace called `backend`. A Markdown heading is the exception,
 * because `outlineOf` in api-digest.js prints a text answer's headings word by word. Even then only
 * the words with a capital letter count, and no namespace, pod or node name has one.
 */
function piecesOf(lit) {
  if (!/\s/.test(lit)) return lit.split(/[/?&,=()]+/).filter(Boolean);
  if (HEADING.test(lit)) return lit.replace(HEADING, '').split(/\\[nr]/)[0].split(/\s+/).filter(w => /[A-Z]/.test(w));
  return [];
}

/**
 * The slots a literal puts its pieces in, read the way `templatePath` reads a traced path.
 *
 * '/api/v1/namespaces/kube-system/configmaps/shoot-info' puts `kube-system` in a namespace slot and
 * `shoot-info` in a name slot. A template's static part can start mid-path, so a namespace is the
 * segment right after `namespaces/` wherever that stands. 'owner=helm' puts `helm` in a value slot.
 * '/dev/stdout' puts `dev` in none.
 *
 * @returns {['namespace' | 'name' | 'value', string][]}
 */
function slotsOf(lit) {
  if (/\s/.test(lit)) return [];
  const out = [];
  const seg = lit.split('?')[0].split('/').filter(Boolean);
  const ns = seg.indexOf('namespaces');
  if (ns !== -1 && seg[ns + 1]) out.push(['namespace', seg[ns + 1]]);
  // The resource follows `namespaces/<ns>/`, or the API base of a cluster-scoped path.
  const base = seg[0] === 'api' ? 2 : seg[0] === 'apis' ? 3 : -1;
  const resource = ns !== -1 && seg.length - ns >= 3 ? ns + 2 : base;
  if (resource !== -1 && seg[resource + 1]) out.push(['name', seg[resource + 1].split(':')[0]]);
  for (const term of lit.split(/[?&,()]+/)) {
    const value = term.slice(term.lastIndexOf('=') + 1);
    if (term.includes('=') && value) out.push(['value', value]);
  }
  return out;
}

const keep = (s, literals) => literals.has(s);

/** A string the code spells whole. A Set built by hand rather than by `literalsOf` is all whole literals. */
const isWhole = (s, literals) => (literals.whole ?? literals).has(s);

/** A namespace, a name or a value: spelled whole, or a piece a literal puts in that slot. */
const keepAt = (slot, s, literals) => isWhole(s, literals) || Boolean(literals.at?.[slot].has(s));

/** A Kubernetes API version (`v1`, `v1beta1`, `v2alpha3`) names nothing in a cluster. */
const API_VERSION = /^v\d+(?:(?:alpha|beta)\d+)?$/;

/** One selector term list, with every value the code did not choose replaced by `{value}`. */
function templateSelector(sel, literals) {
  return sel
    .replace(/\(([^)]*)\)/g, (_, set) =>
      `(${set.split(',').map(v => v.trim()).map(v => (keepAt('value', v, literals) ? v : '{value}')).join(',')})`)
    .replace(/(==|!=|=)([^,()]+)/g, (_, op, v) => `${op}${keepAt('value', v.trim(), literals) ? v.trim() : '{value}'}`);
}

/**
 * A traced path as a runnable template.
 *
 *   /api/v1/namespaces/istio-system/pods/istiod-7c9-x1/log?container=discovery&tailLines=20
 *   -> /api/v1/namespaces/istio-system/pods/{name}/log?container=discovery&tailLines=20
 *
 * @param {string} raw the `path` field of one trace line, with or without the `HIT ` prefix
 * @param {Set<string>} literals from `literalsOf` or `codeLiterals`, whose `whole` and `at` say
 *   where a piece may stand; a plain Set counts every member as a whole literal
 * @returns {{ path: string, cached: boolean }}
 */
function templatePath(raw, literals) {
  let s = String(raw);
  let cached = false;
  if (s.startsWith('HIT ')) {
    cached = true;
    s = s.slice(4);
  }
  const qAt = s.indexOf('?');
  const pathPart = qAt === -1 ? s : s.slice(0, qAt);
  const query = qAt === -1 ? '' : s.slice(qAt + 1);

  const seg = pathPart.split('/').filter(Boolean);
  const base = seg[0] === 'api' ? 2 : seg[0] === 'apis' ? 3 : 0;
  let out;
  if (!base || seg.length <= base) {
    // Non-resource paths (/version, /openapi/v3, discovery) are the code's own words.
    out = seg.map(x => (keep(x, literals) || /^v\d/.test(x) ? x : '{value}'));
  } else {
    out = seg.slice(0, base).map((x, i) => {
      if (i === 0 || keep(x, literals)) return x;
      if (base === 3 && i === 1) return '{group}';
      return API_VERSION.test(x) ? x : '{version}';
    });
    let rest = seg.slice(base);
    if (rest[0] === 'namespaces' && rest.length >= 3) {
      out.push('namespaces', keepAt('namespace', rest[1], literals) ? rest[1] : '{namespace}');
      rest = rest.slice(2);
    }
    if (rest.length) {
      const core = base === 2 && /^[a-z]+$/.test(rest[0]);
      out.push(core || keep(rest[0], literals) ? rest[0] : '{resource}');
      if (rest.length >= 2) {
        // `pods/<name>:15000/proxy/...` — the port is the code's, the name is the cluster's.
        const [name, port] = rest[1].split(':');
        const kept = keepAt('name', rest[1], literals) || keepAt('name', name, literals) ? name : '{name}';
        out.push(port ? `${kept}:${/^\d+$/.test(port) || isWhole(port, literals) ? port : '{port}'}` : kept);
      }
      // Subresources and proxied paths after the name are the code's (`log`, `proxy/stats`).
      for (const x of rest.slice(2)) out.push(keep(x, literals) || /^[a-z_]+$/.test(x) ? x : '{value}');
    }
  }

  let qs = '';
  if (query) {
    const parts = [];
    for (const [k, v] of new URLSearchParams(query)) {
      if (NUMERIC_KEYS.has(k) && /^(\d+|true|false)$/.test(v)) parts.push(`${k}=${v}`);
      else if (SELECTOR_KEYS.has(k)) parts.push(`${k}=${templateSelector(v, literals)}`);
      else parts.push(`${k}=${keepAt('value', v, literals) ? v : '{value}'}`);
    }
    qs = parts.length ? `?${parts.join('&')}` : '';
  }
  return { path: `/${out.join('/')}${qs}`, cached };
}

/**
 * The line the router's audit middleware prints as each request finishes:
 * `[fleet-audit] GET /api/fleet/clusters -> 200 (12ms) user=…`. Only the method and the URL are
 * read; the identity after them never leaves the log.
 */
const REQUEST_LINE = /^\[fleet-audit\] ([A-Z]+) (\S+) -> \d{3} /;

/**
 * What pino-pretty puts in front of a message (`[11:43:04.821] INFO (35797): `), plus any
 * colour codes. The server logs through Pino, so a captured log carries this before every line
 * the readers below anchor on; stripping it keeps them reading the message, not the framing.
 */
const LOG_PREFIX = /^(?:\u001b\[[0-9;]*m)*\[\d{2}:\d{2}:\d{2}\.\d{3}\] [A-Z]+ \(\d+\):\s*/;
const unprefix = line => line.replace(/\u001b\[[0-9;]*m/g, '').replace(LOG_PREFIX, '');

/**
 * Read the trace lines appended to `file` since `offset`, and the requests the server finished
 * in that time.
 *
 * @returns {{ lines: object[], requests: { method: string, url: string }[], offset: number }}
 */
function readTraceSince(file, offset) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], requests: [], offset };
  }
  if (size <= offset) return { lines: [], requests: [], offset: size };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    // Only whole lines: a line still being written is left for the next read.
    const end = text.lastIndexOf('\n') + 1;
    const lines = [];
    const requests = [];
    for (const raw of text.slice(0, end).split('\n')) {
      const l = unprefix(raw);
      const req = REQUEST_LINE.exec(l);
      if (req) {
        requests.push({ method: req[1], url: req[2] });
        continue;
      }
      if (!l.startsWith('{"k8s"')) continue;
      try {
        lines.push(JSON.parse(l));
      } catch {
        // a partial or foreign line; the trace is JSON-per-line by construction
      }
    }
    return { lines, requests, offset: offset + Buffer.byteLength(text.slice(0, end)) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Token minting is the fleet's own bookkeeping (the renewer), never a route's read. */
const isBookkeeping = p => /\/serviceaccounts\/[^/]+\/token$/.test(p.replace(/^HIT /, '').split('?')[0]);

/**
 * One route's reads, deduplicated by template.
 *
 * @param {object[]} lines trace lines for the route
 * @param {string} clusterId only this cluster's lines count
 * @param {Set<string>} literals the Set `literalsOf` returns, itself: a copy keeps the members but
 *   not where each piece stood, and then every piece would vouch for every slot
 */
function summariseReads(lines, clusterId, literals) {
  if (!literals.whole) throw new TypeError('summariseReads needs the Set literalsOf returns, not a copy of it');
  const byPath = new Map();
  let calls = 0;
  let cachedCalls = 0;
  let bytes = 0;
  let bookkeeping = 0;
  for (const l of lines) {
    if (l.k8s !== clusterId) continue;
    if (isBookkeeping(l.path)) {
      bookkeeping += 1;
      continue;
    }
    const t = templatePath(l.path, literals);
    calls += 1;
    if (t.cached) cachedCalls += 1;
    bytes += Number(l.bytes) || 0;
    const e = byPath.get(t.path) ?? { path: t.path, calls: 0, live: 0 };
    e.calls += 1;
    if (!t.cached) e.live += 1;
    byPath.set(t.path, e);
  }
  const reads = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { reads, calls, cachedCalls, bytes, bookkeeping };
}

export default { codeLiterals, literalsOf, templatePath, templateSelector, readTraceSince, summariseReads, isBookkeeping, NUMERIC_KEYS, REQUEST_LINE };
