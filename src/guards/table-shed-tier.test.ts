// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The column-shedding contract, enforced as a source check.
 *
 * `theme.css` defines five tiers, and each is calibrated to a column count measured in Chrome:
 *
 *   .tbl         900 / 660    six to eight columns
 *   .tbl-mid    1000 / 700    nine columns
 *   .tbl-wide   1300 / 1000   ten or more columns
 *   .tbl-xwide  1440 / 1120   ten to twelve numeric columns with wrapped headers
 *   .tbl-lean   1440 / 1040   eleven columns whose priority-1 set is narrow (policy tables)
 *
 * `xwide` was added for the retired Top Utilization tab and this file was not told about it, so its
 * four tables — ten, eleven, eleven and twelve columns — read as `base` and the suite reported them as declaring
 * no tier at all. A guard that does not know the current vocabulary reports the wrong table.
 *
 * The failure this file exists to catch is counter-intuitive, so it is worth stating plainly: a tier
 * that is too LOW for its column count does not shed too much, it sheds NOTHING. The thresholds are
 * container widths, and a wide table's container at a 1440px viewport is roughly 1090px — above
 * `mid`'s 1000px trigger, so `mid` stays quiet and eleven columns render and clip off the right
 * edge. That is exactly how the policy, violation and webhook tables lost Enforcement,
 * Status and Violations: not to an overzealous priority system, but to one that never fired.
 *
 * Two invariants follow, and both are checked below against the real component sources:
 *
 *  1. Every `<DataTable>` declares a tier that matches its column count.
 *  2. A hand-rolled `<table className="tbl…">` carries `prio-*` classes, and its header and body
 *     agree on which columns they are. `DataTable` derives the body class from the column's own
 *     `priority`, so it cannot drift; hand-rolled markup repeats the class in two places and can.
 */




const UI_SRC = path.join(FAKE_DIR, '../../src');

/** Minimum columns each tier is calibrated for. Mirrors the comment block in theme.css. */
const TIER_MIN_COLUMNS = { base: 0, mid: 9, wide: 10, xwide: 10, lean: 10 };

/**
 * The tiers a table may declare when its column count comes from the data rather than the source.
 *
 * `base` (900/660) and `mid` (1000/700) are both below the container width this console gives a
 * table at 1440 — 1090px with the rail expanded, 1405px with it collapsed — so on a fan-out matrix
 * they never fire and the far columns clip instead of shedding. `wide` and above are the tiers whose
 * thresholds are still above that container.
 */
const DYNAMIC_SAFE_TIERS = new Set(['wide', 'xwide', 'lean']);

/**
 * There is deliberately NO rule forbidding a tier above a table's column count.
 *
 * An earlier version failed any table with fewer than nine columns that declared a tier, on the
 * reasoning that "a threshold firing where nothing overflows is data loss". Measurement disproved
 * it: column count does not predict overflow, total content width does. An admission-webhook table (9
 * columns) and the Workloads table (9) both overflowed a 1090px container by hundreds of pixels and
 * both needed `wide`, because their text columns are wide, not because they are many. Keeping that
 * rule would have blocked the fix it was written to protect.
 */

/** Above this, the base tier's 900/660 thresholds are too generous and the table clips. */
const BASE_TIER_MAX_COLUMNS = 8;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return (e.isDirectory() && e.name !== 'guards') ? walk(full) : /\.tsx$/.test(e.name) ? [full] : [];
  });
}

function sources() {
  const files = walk(UI_SRC);
  // A scan that finds nothing passes every assertion below, which is the one way this file could
  // lie. Pin the floor so a moved directory fails loudly instead of silently going green.
  assert.ok(files.length >= 30, `the fleet-ui scan found only ${files.length} .tsx files — the scan is broken, not the UI`);
  const all = files.map(file => ({ file: path.relative(UI_SRC, file), src: fs.readFileSync(file, 'utf8') }));
  // Cross-file, so it has to be built from the whole scan rather than from the file being measured.
  // No assertion on its size: a factory that stops being recognised makes its table *unresolved*,
  // which fails the tier test by name — the loud direction.
  FACTORIES = singleColumnFactories(all);
  return all;
}

/**
 * Exported helpers that return exactly ONE `Column<T>`, wherever in the console they are declared.
 *
 * A shared column is the point: two tables that take their Logs action from one factory cannot
 * drift into opening slightly different drawers. But a call element is neither an object literal nor a spread of a local array,
 * so the counter below reported it as unresolved and both tables became unmeasurable — a guard that
 * fails on the very refactor that removed the duplication teaches people to delete the guard.
 *
 * Resolved by scanning for the declaration's own return type rather than by an allowlist of names,
 * so nothing has to be registered here by hand, and a helper that starts returning `Column<T>[]`
 * stops being counted as one column the moment its signature changes.
 */
function singleColumnFactories(all) {
  const names = new Set();
  for (const { src } of all) {
    const re = /export\s+function\s+(\w+)\s*\([\s\S]{0,400}?\)\s*:\s*Column<[^;\n]*?>\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

/**
 * Filled once per run, from every source file, because a factory is used in a different file from
 * the one that declares it. Module-scoped rather than threaded through `countElements` so the two
 * public entry points (`columnCounts`, `spreadWidths`) keep their signatures.
 */
let FACTORIES = new Set();

/** Comments here describe tiers and priorities at length; a naive grep would match the prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The text between a `[` and its matching `]`, given the index just past the `[`.
 *
 * Every counter below works on the array's own body rather than scanning to end-of-file, because
 * the first version's brace walk ran past the array it was measuring whenever an element was a bare
 * identifier and its bracket depth bookkeeping drifted.
 */
function arrayBody(src, from) {
  let bracket = 1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '[') bracket++;
    else if (src[i] === ']') {
      bracket--;
      if (bracket === 0) return src.slice(from, i);
    }
  }
  return src.slice(from);
}

/** Split an array body on its own top-level commas — not those inside an element. */
function topLevelElements(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map(e => e.trim()).filter(Boolean);
}

/**
 * How many columns one `columns` array really declares.
 *
 * An element at the top level of the array is one of exactly three things, and all three count:
 *
 *   - an object literal — one column;
 *   - `...helper(…)` or `...CONST` — however many that helper declares;
 *   - a bare identifier naming a single `Column<T>` — one column.
 *
 * Both of the latter two were invisible to the first version of this counter, and the consequences
 * were the same each time: the Observability tab's eleven-column route table measured as *four*,
 * which is under every threshold in the file, so the widest table on the tab was exempt from the
 * one check that stops a table clipping. An element this cannot classify is reported as
 * `unresolved` and fails the test, because "I could not count this table" must never read as "this
 * table is fine".
 */
function countElements(body, widths, singles) {
  let columns = 0;
  const unresolved = [];
  let dynamic = false;
  for (const el of topLevelElements(body)) {
    if (el.startsWith('{')) {
      columns++;
      continue;
    }
    /*
      A fan-out: `...clusters.map<Column<T>>(c => ({…}))`, one column per cluster in the fleet or per
      policy category in use. Its width is a property of the data, not of the source, so no static
      count exists — reporting it as `unresolved` would be a guard demanding the impossible, and
      counting it as one column would be a guard that lies. It is recorded as dynamic instead, and
      the tier test then requires the WIDEST tier, because a table whose column count is unbounded is
      the one that must be able to shed.
    */
    if (/^\.\.\.[\w.]+\.map<\s*Column</.test(el)) {
      dynamic = true;
      continue;
    }
    const spread = /^\.\.\.\s*(\w+)/.exec(el);
    if (spread) {
      const name = spread[1];
      if (widths.has(name)) columns += widths.get(name);
      else unresolved.push(name);
      continue;
    }
    const ident = /^(\w+)$/.exec(el);
    if (ident) {
      if (singles.has(ident[1])) columns++;
      else if (widths.has(ident[1])) columns += widths.get(ident[1]);
      else unresolved.push(ident[1]);
      continue;
    }
    // `podLogsColumn(onViewLogs)` — a call to a helper whose declared return type is a single
    // `Column<T>`. One column, verified from that declaration; see `singleColumnFactories`.
    const call = /^(\w+)\s*\(/.exec(el);
    if (call && FACTORIES.has(call[1])) {
      columns++;
      continue;
    }
    unresolved.push(el.slice(0, 40));
  }
  return { columns, unresolved, dynamic };
}

/** Every `columns` array in the source, with its resolved column count. */
function columnCounts(src) {
  const widths = spreadWidths(src);
  const singles = singleColumns(src);
  const counts = [];
  const re = /const\s+(\w*columns\w*)\s*:\s*Column<[^;\n]*?>\[\]\s*=\s*\[/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    counts.push({ name: m[1], ...countElements(arrayBody(src, re.lastIndex), widths, singles) });
  }
  return counts;
}

/**
 * Every helper in this source that returns a `Column<…>[]`, and how many columns it contributes.
 *
 * Matches both `const f = (…): Column<T>[] => [` and `const a: Column<T>[] = [`, so a shared set of
 * columns can be a function of the row label or a plain constant. A `.filter(…)` applied to the
 * spread is deliberately NOT modelled: it can only ever remove columns, so counting the helper's
 * full width errs towards demanding a wider tier, which is the safe direction.
 *
 * The generic argument is matched as `[^;\n]*?` rather than `[\s\S]*?`. Across newlines the lazy
 * form happily spanned a preceding `const lastSeen: Column<T> = {…};` all the way to the *next*
 * array's `>[] = [`, which swallowed `serviceColumns` whole — the declaration was matched, under the
 * wrong name, and the table it belonged to was measured against a sibling's column count.
 */
function spreadWidths(src) {
  const widths = new Map();
  const re = /const\s+(\w+)\s*(?::\s*Column<[^;\n]*?>\[\]\s*=|=\s*\([^)]*\)\s*:\s*Column<[^;\n]*?>\[\]\s*=>)\s*\[/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Recursive on purpose: a helper array may itself spread another one.
    const body = arrayBody(src, re.lastIndex);
    widths.set(m[1], countElements(body, widths, singleColumns(src)).columns);
  }
  return widths;
}

/** Names bound to a *single* `Column<T>` object, which a `columns` array may list by name. */
function singleColumns(src) {
  const names = new Set();
  const re = /const\s+(\w+)\s*:\s*Column<[^;\n]*?>\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

/**
 * Every column entry of every `columns` array, as `{ key, body }`.
 *
 * Same depth-1 brace walk as `columnCounts`, but keeping each entry's source so a rule can ask what
 * the column declares and what its render does.
 */
function columnEntries(src) {
  const entries = [];
  const re = /const\s+(\w*columns\w*)\s*:\s*Column<[^;\n]*?>\[\]\s*=\s*\[/gi;
  while (re.exec(src) !== null) {
    let bracket = 0;
    let brace = 0;
    let start = -1;
    for (let i = re.lastIndex - 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === '[') bracket++;
      else if (ch === ']') {
        bracket--;
        if (bracket === 0) break;
      } else if (ch === '{') {
        brace++;
        if (brace === 1 && bracket === 1) start = i;
      } else if (ch === '}') {
        if (brace === 1 && bracket === 1 && start >= 0) {
          const body = src.slice(start, i + 1);
          const key = (/key:\s*'([^']+)'/.exec(body) || [])[1];
          if (key) entries.push({ key, body });
          start = -1;
        }
        brace--;
      }
    }
  }
  return entries;
}

/**
 * Split the source into one segment per hand-rolled `<table>`.
 *
 * Scoping matters: OpaCoverage renders TWO tables, and summing `prio-*` classes across both compared
 * nine columns' headers against a different table's cells. The totals happened to disagree for the
 * bug being canaried and could just as easily have coincidentally agreed, which is a guard that
 * passes for the wrong reason.
 */
function tableSegments(src) {
  const segments = [];
  const re = /<table\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf('</table>', m.index);
    segments.push(src.slice(m.index, end === -1 ? src.length : end));
  }
  return segments;
}

/**
 * Pair every `<DataTable>` element with the column array it actually renders.
 *
 * Association is by nearest PRECEDING `Column<…>[] = [` declaration, not by the name in
 * `columns={…}`: ClusterDetail declares three separate arrays all called `columns`, one per
 * component, so a name lookup is ambiguous exactly where the coverage matters most.
 *
 * This exists because the first version of the tier test bailed out with `counts.length !== 1`,
 * which silently exempted every multi-table file — ClusterDetail's Nodes, Workloads and Pods tables
 * were three of the widest in the console and none of them was ever checked. The suite was green
 * and measuring nothing, which is the failure mode this whole file is supposed to prevent.
 */
function dataTables(src) {
  const decls = [];
  const re = /Column<[^;\n]*?>\[\]\s*=\s*\[/g;
  let m;
  while ((m = re.exec(src)) !== null) decls.push(m.index);

  const counts = columnCounts(src);
  const out = [];
  const useRe = /<DataTable\b/g;
  while ((m = useRe.exec(src)) !== null) {
    const end = src.indexOf('/>', m.index);
    const element = src.slice(m.index, end === -1 ? m.index + 800 : end);
    const shed = /shed="(mid|wide|xwide|lean)"/.exec(element);

    /*
      Association, in two steps.

      By NAME first, when the name is declared exactly once in the file: a component that renders
      three tables from three arrays — Observability's services, routes and connections — declares
      all three above all three elements, so "nearest preceding declaration" gave every table the
      LAST array's count. Both of the wide ones were then measured against the narrow one and
      passed, which is how this guard reported four green tables while one of them clipped.

      Nearest-preceding stays as the fallback, because a name is genuinely ambiguous in
      ClusterDetail, where three separate components each declare an array called `columns`.
    */
    const named = /columns=\{(\w+)\}/.exec(element);
    let which = -1;
    if (named && counts.filter(c => c.name === named[1]).length === 1) {
      which = counts.findIndex(c => c.name === named[1]);
    } else {
      // The nearest declaration above this element is the one in the same component scope.
      for (let i = 0; i < decls.length; i++) if (decls[i] < m.index) which = i;
    }
    if (which === -1 || !counts[which]) continue;

    out.push({
      columns: counts[which].columns,
      unresolved: counts[which].unresolved,
      dynamic: counts[which].dynamic,
      tier: shed ? shed[1] : 'base'
    });
  }
  return out;
}

test('every DataTable declares the shed tier its column count needs', () => {
  const offences = [];
  for (const { file, src } of sources()) {
    const clean = stripComments(src);
    if (!clean.includes('<DataTable')) continue;

    for (const { columns, tier, unresolved, dynamic } of dataTables(clean)) {
      // An unresolvable spread means this file cannot know the column count, and a check that
      // cannot count must say so rather than pass. Name the helper it could not find.
      for (const name of unresolved ?? []) {
        offences.push(`${file}: a columns array spreads \`...${name}\`, which this guard cannot resolve to a Column<…>[] in the same file — so the table's real column count is unknown and its tier is unchecked. Declare the helper in this file, or inline the columns.`);
      }
      /*
        A fan-out table — one column per cluster, per category, per zone. Its width grows with the
        data, so the only tier that is safe for it is one whose thresholds still fire when the fleet
        doubles. `mid` is the trap: its 1000px trigger sits below the container width at 1440, so a
        matrix that has grown past the container never sheds and clips instead.
      */
      if (dynamic && !DYNAMIC_SAFE_TIERS.has(tier)) {
        offences.push(`${file}: a columns array fans out over the data (\`.map<Column<…>>\`) at shed="${tier === 'base' ? 'none' : tier}" — its column count is unbounded, so it needs a tier whose thresholds still fire at 1440: ${[...DYNAMIC_SAFE_TIERS].join(', ')}.`);
      }
      if (columns === 0) continue;

      if (columns > BASE_TIER_MAX_COLUMNS && tier === 'base') {
        offences.push(`${file}: ${columns} columns with no shed tier — the base 900/660 thresholds never fire, so the table clips instead of shedding`);
      }
      if (columns >= TIER_MIN_COLUMNS.wide && tier === 'mid') {
        offences.push(`${file}: ${columns} columns at shed="mid" — mid's 1000px trigger sits below this table's container width at 1440, so nothing sheds and the last columns clip. Use shed="wide".`);
      }
    }
  }
  assert.deepEqual(offences, []);
});

/**
 * A `truncate` or `line-clamp-*` on a `.tbl` cell is INERT without a `max`.
 *
 * `.tbl tbody td` already sets `white-space: nowrap`, and `table-layout: auto` treats a `width` on
 * the `th` as a suggestion the widest body cell overrides. So the class announces "this text is
 * clipped" while the column silently grows to its longest row instead. Measured at 1440: a policy
 * overview's Purpose column rendered 961px inside a 1090px container and overflowed the table by
 * 1065px, and the Workloads table's Workload column rendered 528px against a declared 260px.
 *
 * `width` does NOT satisfy this rule. Only `max`, which `DataTable` applies to both the `th` and
 * the `td`, is a ceiling that holds.
 */
test('a truncating column declares a max, or its truncate does nothing', () => {
  const offences = [];
  for (const { file, src } of sources()) {
    const clean = stripComments(src);
    if (!clean.includes('<DataTable')) continue;

    for (const entry of columnEntries(clean)) {
      if (!/\btruncate\b|line-clamp-/.test(entry.body)) continue;
      if (/\bmax:/.test(entry.body)) continue;
      const key = `${file}:${entry.key}`;
      if (TRUNCATE_WITHOUT_MAX_DEBT.has(key)) continue;
      offences.push(`${key}: the cell truncates but the column declares no \`max\`, so nothing bounds it — .tbl already sets nowrap, and a \`width\` on the th is a suggestion the widest cell overrides. The column grows to its longest row and pushes the table off its container.`);
    }
  }
  assert.deepEqual(offences, []);
});

/**
 * The debt list, now empty — every truncating column in the console declares a ceiling.
 *
 * It stays as an empty Set rather than being deleted, because it is the ratchet's release valve: a
 * future table whose correct cap needs a measurement nobody has taken yet can be parked here with a
 * comment, instead of the rule being weakened or the file deleted. The staleness test below means a
 * parked entry cannot outlive its fix.
 *
 * All nine original entries were fixed by measuring the live cluster at 1440 and capping to the
 * container. Three of them shared a distinct bug worth naming: the cap was written on the SPAN inside
 * the cell (`max-w-[38ch]`, `max-w-[60ch]`, `max-w-[70ch]`, `max-w-full`), which bounds the text but
 * leaves the COLUMN free to grow to that width — so the table overflowed by exactly the amount the
 * author thought they had capped.
 */
const TRUNCATE_WITHOUT_MAX_DEBT = new Set([]);

test('the truncate-without-max debt list has no stale entries', () => {
  const live = new Set();
  for (const { file, src } of sources()) {
    const clean = stripComments(src);
    if (!clean.includes('<DataTable')) continue;
    for (const entry of columnEntries(clean)) {
      if (/\btruncate\b|line-clamp-/.test(entry.body) && !/\bmax:/.test(entry.body)) {
        live.add(`${file}:${entry.key}`);
      }
    }
  }
  const stale = [...TRUNCATE_WITHOUT_MAX_DEBT].filter(k => !live.has(k));
  assert.deepEqual(stale, [], 'these columns were fixed or removed — delete them from the debt list so it keeps ratcheting down');
});

test('a hand-rolled tbl sheds columns, and its header and body agree which', () => {
  const offences = [];
  for (const { file, src } of sources()) {
    const clean = stripComments(src);
    for (const [n, seg] of tableSegments(clean).entries()) {
      // Hand-rolled only: a `className="tbl"` literal. DataTable builds its class from `shed`.
      if (!/className="tbl(?:\s+tbl-(?:mid|wide|xwide|lean))?"/.test(seg)) continue;
      const where = `${file} table #${n + 1}`;

      // A group header spanning the whole row is not a column. Counting it inflated Coverage's
      // nine columns to ten and would eventually trip the base-tier rule for the wrong reason.
      const headerTags = (seg.match(/<th\b[^>]*>/g) || []).filter(t => !/colSpan/i.test(t));
      const headerPrios = headerTags.filter(t => /\bprio-[23]\b/.test(t)).length;
      const bodyPrios = (seg.match(/<td\b[^>]*>/g) || []).filter(t => /\bprio-[23]\b/.test(t)).length;

      if (headerTags.length > BASE_TIER_MAX_COLUMNS && headerPrios === 0) {
        offences.push(`${where}: ${headerTags.length} columns and no prio-* class — no cell is eligible to shed, so the widest columns clip off the edge instead`);
      }
      if (headerPrios !== bodyPrios) {
        offences.push(`${where}: ${headerPrios} prio-* headers but ${bodyPrios} prio-* cells — when a th sheds and its td does not, every following column shifts left by one and the row reads under the wrong headers`);
      }
      if (headerTags.length >= TIER_MIN_COLUMNS.mid && !/tbl-(?:mid|wide|xwide|lean)/.test(seg)) {
        offences.push(`${where}: ${headerTags.length} columns on the base tier — 900/660 is calibrated for eight, so it fires where this table has already overflowed`);
      }
    }
  }
  assert.deepEqual(offences, []);
});
