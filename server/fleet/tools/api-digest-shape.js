/**
 * A fleet response's structure as a JSON skeleton, and what it carried — never a value.
 *
 * `api-digest.js` documents every route with the response a caller gets back. A flat list of
 * field paths answers "does this field exist" but not "where do I read it"; a panel author wants
 * the nesting. So a response is folded into a *shape* — every value replaced by its JSON type,
 * every array's elements merged into one element — and printed as JSON with comments.
 *
 * ## Value-free by construction
 *
 * A shape holds key names, type names and counts, and nothing else: no string, number or boolean
 * from the response is ever stored in it. Two places a value could still reach the page, and what
 * closes each:
 *
 *   - **Key names a user wrote.** `labels`, `annotations`, `selector`, a Secret's `data`, a Helm
 *     release's `values` and a Gatekeeper constraint's `parameters` are `OPAQUE`: recorded as a map,
 *     never entered, so no key under one is held in the shape. The envelope's own `data` (the
 *     payload of the wrapper and roster shapes) is the one `data` that is entered.
 *   - **Maps keyed by data.** A backend map keyed by node, pod, namespace or chart name would print
 *     those names as keys. An object is read as such a map when any key is not a plain identifier,
 *     when a key is a registered cluster's id (`opts.dataKeys`), when every key opens with a capital
 *     (a Kind, a pod phase, a QoS class: the collectors name their own fields in camelCase), or when
 *     it has more than `DICT_MIN_KEYS` keys and one of them is a word the fleet's own source never
 *     spells (`opts.vocabulary`); with no vocabulary, more than `DICT_MIN_KEYS` keys is enough. A
 *     count alone cannot tell the two apart: a node row, a trace row and the cost summary each carry
 *     more fields than that, every one a name a collector chose, so a wide record prints only words
 *     the source spells. A map prints as one `"<key>"` entry holding the merged shape of all its
 *     values, and once a path is a map it stays one.
 *
 * `server/fleet/__tests__/api-digest-modules.test.js` feeds a payload whose every string is a sentinel and asserts the
 * sentinel appears nowhere in the rendering; `server/fleet/__tests__/api-digest-shape.test.js` does the same
 * for the wide records a vocabulary prints and for every `OPAQUE` key, and holds the collectors'
 * own wide records to the rule.
 */

/**
 * Key names recorded without entering: whoever wrote the object chose the keys inside. A Helm
 * release's `overrides`, `values` and `defaults` are keyed by its chart and its operator, and a
 * Gatekeeper constraint's `parameters` by its policy's author, so a team or customer name can sit
 * in a key there.
 */
const OPAQUE = new Set([
  'data', 'stringData', 'binaryData', 'annotations', 'labels', 'matchLabels', 'nodeSelector', 'selector',
  'overrides', 'values', 'defaults', 'parameters'
]);

/** Dropped entirely, as `fieldDigest` drops it: server bookkeeping, never rendered. */
const SKIP = new Set(['managedFields']);

/** Envelope and completeness keys, which say how the read went rather than what it found. */
const ENVELOPE_KEYS = new Set([
  'cluster', 'clusterId', 'displayName', 'ok', 'error', 'code', 'collectedAt', 'fetchedAt',
  'unavailable', 'truncated', 'unreachable'
]);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DICT_MIN_KEYS = 24;

const DEFAULTS = { maxDepth: 12, mergeElements: 200, dictMinKeys: DICT_MIN_KEYS, vocabulary: null, dataKeys: null, maxLines: 160 };

const typeName = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const newShape = () => ({ seen: 0, nonNull: 0, types: new Set(), opaque: false, obj: null, arr: null });

/* ------------------------------------------------------------------------------ folding */

/** Merge two shapes into a new one. Used when an object turns out to be a map keyed by data. */
function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const s = newShape();
  s.seen = a.seen + b.seen;
  s.nonNull = a.nonNull + b.nonNull;
  s.types = new Set([...a.types, ...b.types]);
  s.opaque = a.opaque || b.opaque;
  if (a.arr || b.arr) {
    s.arr = {
      elem: union(a.arr?.elem ?? null, b.arr?.elem ?? null) ?? newShape(),
      total: (a.arr?.total ?? 0) + (b.arr?.total ?? 0),
      nonEmpty: (a.arr?.nonEmpty ?? 0) + (b.arr?.nonEmpty ?? 0)
    };
  }
  if (a.obj || b.obj) {
    const obj = { keys: new Map(), seen: (a.obj?.seen ?? 0) + (b.obj?.seen ?? 0), dict: false, value: null, deep: false };
    obj.deep = Boolean(a.obj?.deep || b.obj?.deep);
    if (a.obj?.dict || b.obj?.dict) {
      obj.dict = true;
      for (const o of [a.obj, b.obj]) {
        if (!o) continue;
        obj.value = union(obj.value, o.dict ? o.value : [...o.keys.values()].reduce(union, null));
      }
    } else {
      for (const o of [a.obj, b.obj]) {
        if (!o) continue;
        for (const [k, v] of o.keys) obj.keys.set(k, union(obj.keys.get(k) ?? null, v));
      }
    }
    s.obj = obj;
  }
  return s;
}

function toDict(obj) {
  obj.value = union(obj.value, [...obj.keys.values()].reduce(union, null));
  obj.keys.clear();
  obj.dict = true;
}

/**
 * Whether an object's keys are data rather than a schema:
 *
 *   - a key that is not a plain identifier (`kube-system`, `nvidia.com/gpu`);
 *   - a key among `dataKeys`, the registered cluster ids: `/summary`'s `perCluster` and `/drift`'s
 *     `clusterVersions` are keyed by cluster, and an id can be a plain identifier;
 *   - every key opening with a capital, the cluster's words (`Running`, `BestEffort`, a Kind);
 *   - more than `dictMinKeys` keys of which one is a word the fleet's source never spells. Without
 *     a vocabulary, more than `dictMinKeys` keys is enough.
 */
function keyedByData(keys, o) {
  if (keys.some(k => !IDENT.test(k))) return true;
  if (o.dataKeys && keys.some(k => o.dataKeys.has(k))) return true;
  if (keys.length && keys.every(k => /^[A-Z]/.test(k))) return true;
  if (keys.length <= o.dictMinKeys) return false;
  return !o.vocabulary || keys.some(k => !o.vocabulary.has(k));
}

function merge(s, v, path, depth, o) {
  s.seen += 1;
  const t = typeName(v);
  s.types.add(t);
  if (t === 'null') return;
  s.nonNull += 1;
  // Nothing under an author-written key is entered, not even a later row's copy that a map keyed
  // by data merged into a value already recorded as opaque.
  if (s.opaque) return;

  if (t === 'array') {
    s.arr ??= { elem: newShape(), total: 0, nonEmpty: 0 };
    s.arr.total += 1;
    if (v.length) s.arr.nonEmpty += 1;
    const n = Math.min(v.length, o.mergeElements);
    for (let i = 0; i < n; i += 1) merge(s.arr.elem, v[i], `${path}[]`, depth, o);
    return;
  }
  if (t !== 'object') return;

  s.obj ??= { keys: new Map(), seen: 0, dict: false, value: null, deep: false };
  s.obj.seen += 1;
  if (depth >= o.maxDepth) {
    s.obj.deep = true;
    return;
  }
  const keys = Object.keys(v).filter(k => !SKIP.has(k));
  if (!s.obj.dict && keyedByData(keys, o)) toDict(s.obj);

  for (const k of keys) {
    const child = s.obj.dict ? (s.obj.value ??= newShape()) : getOrAdd(s.obj.keys, k);
    const childPath = s.obj.dict ? `${path}.<key>` : path ? `${path}.${k}` : k;
    // The envelope's own `data` — root of a wrapper, or a roster entry's — is the payload, and
    // the one `data` that is entered. Every other `data` is a Secret's or ConfigMap's. A map keyed
    // by data records the key too, on its merged value: whatever folded the object, the key can
    // still be a record's, so nothing under it is entered from then on.
    const isPayload = k === 'data' && (path === '' || path === 'clusters[]');
    if (OPAQUE.has(k) && !isPayload) {
      child.seen += 1;
      child.types.add(typeName(v[k]));
      if (v[k] !== null) child.nonNull += 1;
      child.opaque = true;
      continue;
    }
    merge(child, v[k], childPath, depth + 1, o);
  }
}

function getOrAdd(map, k) {
  let s = map.get(k);
  if (!s) {
    s = newShape();
    map.set(k, s);
  }
  return s;
}

/**
 * Fold one response into its shape. `opts.vocabulary` is a Set of the identifiers the fleet's own
 * source spells (`identifiersOf` in api-digest.js): with it, an object wider than `dictMinKeys`
 * stays a record when every key is in the set. `opts.dataKeys` is a Set of the registered cluster
 * ids: an object keyed by one is a map. The fold is decided here, so the entry points that read a
 * folded shape (`renderShape`, `captureOf`, `shapeAt`, `fieldsOf`) need neither and ignore both.
 */
function shapeOfValue(value, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const s = newShape();
  merge(s, value, '', 0, o);
  return s;
}

/* ---------------------------------------------------------------------------- rendering */

const q = k => JSON.stringify(k);

function scalarText(s) {
  const types = [...s.types].filter(t => t !== 'null' && t !== 'object' && t !== 'array');
  if (!types.length) return 'null';
  const text = types.sort().join(' | ') + (s.types.has('null') ? ' | null' : '');
  return q(text);
}

function countFields(obj) {
  if (!obj) return 0;
  return obj.dict ? 1 : obj.keys.size;
}

/**
 * Lines for one value. The first line carries no indent (it follows `"key": `); later lines are
 * indented by `pad`. `note` collects the trailing comment for the first line.
 */
function valueLines(s, pad, depthLeft) {
  const notes = [];
  if (s.opaque) {
    // `or null` first, as on any other object.
    if (s.types.has('null')) notes.push('or null');
    notes.push('written by the object\'s author; not entered');
    return { lines: [s.types.has('array') ? '[ "…" ]' : '{ "<key>": "…" }'], notes };
  }
  const alsoNull = s.types.has('null') && (s.obj || s.arr);
  if (s.obj) {
    if (alsoNull) notes.push('or null');
    const extra = [...s.types].filter(t => !['object', 'null'].includes(t));
    if (extra.length) notes.push(`or ${extra.join(' | ')}`);
    return { lines: objectLines(s.obj, pad, depthLeft), notes };
  }
  if (s.arr) {
    if (alsoNull) notes.push('or null');
    // A value that is a list on some reads and a scalar on others says both; otherwise a folded
    // record's fields beside its empty `unavailable[]` read as one empty list.
    const extra = [...s.types].filter(t => !['array', 'null'].includes(t));
    if (extra.length) notes.push(`or ${extra.join(' | ')}`);
    if (!s.arr.nonEmpty) return { lines: ['[]'], notes: ['empty on this read', ...notes] };
    const inner = valueLines(s.arr.elem, `${pad}  `, depthLeft);
    if (inner.lines.length === 1) {
      return { lines: [`[ ${inner.lines[0]} ]`], notes: [...inner.notes, ...notes] };
    }
    const lines = ['['];
    lines.push(`${pad}  ${inner.lines[0]}${commentOf(inner.notes)}`);
    for (const l of inner.lines.slice(1)) lines.push(l);
    lines.push(`${pad}]`);
    return { lines, notes };
  }
  return { lines: [scalarText(s)], notes };
}

const commentOf = notes => (notes.length ? `  // ${notes.join('; ')}` : '');

function objectLines(obj, pad, depthLeft) {
  if (obj.deep || depthLeft <= 0) {
    const n = countFields(obj);
    return [n ? `{ "…": "${n} field${n === 1 ? '' : 's'}" }` : '{}'];
  }
  if (obj.dict) {
    if (!obj.value) return ['{}'];
    const inner = valueLines(obj.value, `${pad}  `, depthLeft - 1);
    const lines = ['{'];
    lines.push(`${pad}  "<key>": ${inner.lines[0]}${commentOf(['map keyed by data', ...inner.notes])}`);
    for (const l of inner.lines.slice(1)) lines.push(l);
    lines.push(`${pad}}`);
    return lines;
  }
  if (!obj.keys.size) return ['{}'];
  const lines = ['{'];
  const entries = [...obj.keys];
  entries.forEach(([k, child], i) => {
    const inner = valueLines(child, `${pad}  `, depthLeft - 1);
    const notes = [...inner.notes];
    if (child.seen < obj.seen) notes.push('optional');
    const comma = i < entries.length - 1 ? ',' : '';
    if (inner.lines.length === 1) {
      lines.push(`${pad}  ${q(k)}: ${inner.lines[0]}${comma}${commentOf(notes)}`);
    } else {
      lines.push(`${pad}  ${q(k)}: ${inner.lines[0]}${commentOf(notes)}`);
      for (const l of inner.lines.slice(1, -1)) lines.push(l);
      lines.push(`${inner.lines[inner.lines.length - 1]}${comma}`);
    }
  });
  lines.push(`${pad}}`);
  return lines;
}

/**
 * Render a shape as JSON-with-comments. When the full rendering is longer than `maxLines`, the
 * deepest objects are folded to `{ "…": "N fields" }` until it fits, so every route's structure
 * reads on one screen and the fold says what it hides.
 *
 * @returns {{ text: string, folded: boolean }}
 */
function renderShape(shape, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let depth = 64;
  let out = valueLines(shape, '', depth);
  const full = out.lines.length;
  while (out.lines.length > o.maxLines && depth > 2) {
    depth -= 1;
    out = valueLines(shape, '', depth);
  }
  const lines = [...out.lines];
  lines[0] = `${lines[0]}${commentOf(out.notes)}`;
  return { text: lines.join('\n'), folded: out.lines.length < full };
}

/* ------------------------------------------------------------------------------ capture */

/**
 * What one response carried, counted over its payload: leaf fields that held a value, and lists
 * that held at least one row. Envelope and completeness keys are left out, because an empty
 * `unavailable[]` is the good case, not an empty panel. `skipTop` names further top-level keys that
 * are envelope for this shape: the flattened shape's `clusters[]` status rows and its `summary`.
 *
 * @returns {{ leaves: number, withValue: number, lists: number, populated: number,
 *             emptyLists: string[], nullLeaves: string[] }}
 */
function captureOf(shape, { prefix = '', skipTop = [] } = {}) {
  const skip = new Set(skipTop);
  const c = { leaves: 0, withValue: 0, lists: 0, populated: 0, emptyLists: [], nullLeaves: [] };
  const walk = (s, path, top) => {
    if (!s) return;
    if (s.opaque) {
      c.leaves += 1;
      if (s.nonNull) c.withValue += 1;
      return;
    }
    if (s.arr) {
      c.lists += 1;
      if (s.arr.nonEmpty) c.populated += 1;
      else c.emptyLists.push(`${path}[]`);
      walk(s.arr.elem, `${path}[]`, false);
    }
    if (s.obj) {
      if (s.obj.dict) walk(s.obj.value, `${path}.<key>`, false);
      else {
        for (const [k, child] of s.obj.keys) {
          if (top && (ENVELOPE_KEYS.has(k) || skip.has(k))) continue;
          if (k === 'unavailable' || k === 'truncated') continue;
          walk(child, path ? `${path}.${k}` : k, false);
        }
      }
    }
    const scalar = [...s.types].some(t => t === 'string' || t === 'number' || t === 'boolean');
    if (!s.arr && !s.obj && (scalar || s.types.has('null'))) {
      c.leaves += 1;
      if (scalar && s.nonNull) c.withValue += 1;
      else c.nullLeaves.push(path);
    }
  };
  walk(shape, prefix, true);
  return c;
}

/** The sub-shape at a dotted path (`data`, `clusters[].data`), or null when absent. */
function shapeAt(shape, path) {
  let s = shape;
  for (const part of path.split('.').filter(Boolean)) {
    if (!s) return null;
    const isArr = part.endsWith('[]');
    const key = isArr ? part.slice(0, -2) : part;
    s = s.obj && !s.obj.dict ? s.obj.keys.get(key) ?? null : null;
    if (s && isArr) s = s.arr ? s.arr.elem : null;
  }
  return s;
}

/**
 * Every key path of a folded shape, for `--json-out`: `items[].name`, a map's keys as `<key>`
 * wherever the document prints them so, and an author-written key recorded as `map` with nothing
 * under it. Sorted by path.
 *
 * @returns {{ path: string, type: string }[]}
 */
function fieldsOf(shape) {
  const out = [];
  const typeOf = s => {
    if (s.opaque) return s.types.has('array') ? 'array' : 'map';
    if (s.arr) return s.arr.nonEmpty ? `array(${s.arr.elem.obj ? 'object' : [...s.arr.elem.types].filter(t => t !== 'null').join(' | ') || 'null'})` : 'array(empty)';
    if (s.obj) return s.obj.dict ? 'map' : 'object';
    return [...s.types].join(' | ');
  };
  const walk = (s, path) => {
    if (!s || s.opaque) return;
    if (s.arr) walk(s.arr.elem, path);
    if (!s.obj) return;
    const entries = s.obj.dict ? [['<key>', s.obj.value]] : [...s.obj.keys];
    for (const [k, child] of entries) {
      if (!child) continue;
      const p = `${path ? `${path}.` : ''}${k}${child.arr && !child.opaque ? '[]' : ''}`;
      out.push({ path: p, type: typeOf(child) });
      walk(child, p);
    }
  };
  walk(shape, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export default {
  OPAQUE, SKIP, ENVELOPE_KEYS, DICT_MIN_KEYS,
  shapeOfValue, renderShape, captureOf, shapeAt, fieldsOf, union
};
