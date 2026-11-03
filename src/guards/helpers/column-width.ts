// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fleet', 'helpers');

/**
 * A width model for a `DataTable` column, derived from its source.
 *
 * `table-shed-tier.test.js` counts columns and `table-fit.test.js` sums declared ceilings. Neither
 * can answer the question that actually decides whether an operator sees a clipped value: **how wide
 * is this column allowed to get?** A column with no `max` is sized by `table-layout: auto` from the
 * wider of its header and its widest cell, and on the wrapped-header tiers (`tbl-xwide`, `tbl-lean`)
 * the header is usually the winner — which is the whole reason those two tiers exist (see the
 * measurement block above `.tbl-xwide` in `theme.css`).
 *
 * So this module models three things and nothing else:
 *
 *  1. **The header's intrinsic width.** Uppercase 12px at 0.06em tracking. Anchored on the one
 *     measurement `theme.css` records to the pixel: "Current request headroom" — 24 characters —
 *     measured 197px, which is 8.2px per character. On a wrapping tier a header can break at a space
 *     but never inside a word, so its intrinsic width is its LONGEST WORD, not the whole string.
 *  2. **The column's declared width, and which property declared it.** `max` if there is one, else
 *     `width`. Both are charged to the budget, because either one is the width the column intends to
 *     occupy — but only `max` is a *ceiling* that clips, and `ceilingOf` keeps the two apart for the
 *     rule that depends on the difference.
 *  3. **What an uncapped column's content costs**, from the best source available for it: the table's
 *     own plan module where there is one (`planContentPx`), else its declared `width`, else a flat
 *     88px — the 437px/5 the Scheduled pods table's uncapped columns measured in Chrome.
 *
 * ## This model does not own the arithmetic where a plan module does
 *
 * Top Utilization has `pod-columns.ts`, which states the widest string each of its columns can print
 * and converts it at the 8.3px mono advance `pod-name.ts` uses. That is a better derivation than a flat
 * average and this file **reads it** rather than competing with it. Two modules stating different widths
 * for one table is the duplicated-fact problem, and it had already produced a 294px disagreement about
 * the pods table — nearly all of it this model's fault, twice over:
 *
 *  - it added `CELL_PAD_PX` to capped columns. Tailwind's preflight makes every cell `border-box`, so
 *    `max-width: 160px` is 160px *including* its padding. That was 32px × 6 capped columns.
 *  - it charged the flat default over the top of a declared `width`, second-guessing a measurement
 *    somebody took with an average.
 *
 * What this file adds on top of a plan module is the two things such a module does not model: a
 * header's intrinsic width as a floor (`Memory cluster share` and `Restarts` are sized by their labels,
 * not their values, and an `info:` tip is 18px of that) and the outer-edge padding `theme.css` zeroes.
 * On the pods table that is +47px and −16px, which accounts for the residual 31px to the pixel.
 *
 * ## What the totals are, and what they are not
 *
 * They are **ceilings**, not predictions. A `max: '300px'` column full of 18-character namespaces
 * renders at 160px and the model still charges 300px, because 300px is what the layout permits the day
 * a 40-character name arrives. Calibration, and the only Chrome measurement any of this rests on: the
 * Scheduled pods table models 1094px against the 1117px recorded in `table-fit.test.js` — 2.1% low.
 *
 * Which is why no assertion here compares a total against a container width and demands it fit. A
 * ceiling above the container means a *possible* overflow, and the only thing a possible overflow
 * justifies demanding is **the ability to shed** — never that something is shed. The opposite direction
 * is the mistake `theme.css` records twice: a threshold that fires where the columns still fit is not a
 * priority system, it is data loss.
 */


const UI_SRC = path.join(FAKE_DIR, '../../../src');

/** px per character of a `.tbl thead th`: 12px, 600 weight, uppercase, 0.06em tracking. */
const HEADER_ADVANCE_PX = 8.2;

/** The `InfoTip` control a column's `info:` adds beside its label. */
const INFO_TIP_PX = 18;

/**
 * The sort affordance every sortable header carries, which nothing here used to charge for.
 *
 * `DataTable.tsx` wraps a sortable header in `<button className="th-sort">` and appends
 * `<span className="th-sort-mark">` holding `↕` when the column is unsorted and `▲`/`▼` when it is.
 * `theme.css` makes `.th-sort` an `inline-flex` with `gap: 6px` and the mark `font-size: 9px`, so the
 * label is followed by 6px of gap plus roughly a 6px glyph — 12px the header needs and the model was
 * spending on nothing.
 *
 * It is charged in `headerFitsPx` ONLY, never in `columnPx`. That distinction is the whole point: a
 * capped column whose header does not fit does not get wider, it CLIPS — so the table's width is
 * still exactly the declared `max`, and folding this into the width sum would inflate every budget
 * in `table-fit.test.js` to describe pixels no table actually occupies. One number, two questions:
 * "how wide is this table" (columnPx) and "is this header readable" (headerFitsPx).
 *
 * Sizing a header from its own column's ceiling is the feedback loop this file already warns about,
 * so this is a FLOOR check against a declared constant, never an input to the ceiling.
 */
const SORT_MARK_PX = 12;

/** `.tbl thead th` / `.tbl tbody td` are `padding: 10px 16px` — 32px of inline padding per column. */
const CELL_PAD_PX = 32;

/**
 * The last-resort content width, for a column that states no `max`, no `width` and has no plan entry.
 *
 * 437px measured across five such columns on the Scheduled pods table — 87.4px each. Deliberately a
 * single number: a model with a branch per cell shape reads as precision it does not have, and where
 * real precision is wanted the answer is a plan module, not a longer switch in here.
 */
const UNCAPPED_CONTENT_PX = 88;

/** The two tiers whose `thead th` is `white-space: normal`, so a header wraps at its spaces. */
const WRAPPING_TIERS = new Set(['xwide', 'lean']);

/**
 * The container a full-width table gets at a 1440px viewport, rail expanded, no detail panel.
 *
 * Measured in Chrome and recorded in two places already — the `.tbl-xwide` block in `theme.css`
 * ("container 1167px") and `table-shed-tier.test.js` ("roughly 1090px"). The larger figure is the one
 * used here: it is the measurement taken on the tab this model audits, and over-stating the container
 * can only ever make a demand-to-shed rule quieter, never noisier.
 */
const CONTAINER_AT_1440_PX = 1167;

/**
 * Each tier's prio-3 and prio-2 container thresholds. Mirrors the `@container` rules in `theme.css`.
 *
 * `base` is listed so a table that declares no `shed` is measured rather than skipped — its 900px
 * prio-3 threshold sits far below the container at 1440, which is precisely the "sheds nothing, clips
 * instead" case both table guards exist to catch.
 */
const TIER_THRESHOLDS = {
  base: { prio3: 900, prio2: 660 },
  mid: { prio3: 1000, prio2: 700 },
  wide: { prio3: 1300, prio2: 1000 },
  xwide: { prio3: 1440, prio2: 1120 },
  lean: { prio3: 1440, prio2: 1040 }
};

function read(file) {
  return fs.readFileSync(path.join(UI_SRC, file), 'utf8');
}

/** The text between a `[`/`{` and its match, given the index just past the opener. */
function balanced(src, from, open, close) {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(from, i);
    }
  }
  throw new Error(`unbalanced ${open} at ${from}`);
}

/**
 * The top-level elements of a `Column<T>[]` array literal called `name`, as raw source strings.
 *
 * Elements are returned unparsed because they are three different shapes — an object literal, a
 * factory call, a bare identifier — and each is resolved differently by `columnsOf` below.
 */
function arrayElements(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*:\\s*Column<[^;\\n]*?>\\[\\]\\s*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) throw new Error(`no \`const ${name}: Column<…>[] = [\` in this source — the audit is measuring nothing`);
  const body = balanced(src, m.index + m[0].length, '[', ']');
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

/** Comments in these files discuss `max`, `priority` and header strings at length. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The object literal a `Column<T>`-returning factory returns, found wherever it is declared.
 *
 * `podLogsColumn(onViewLogs)` is one column shared by both Top Utilization pod tables, and it carries
 * the Logs button's `width: '92px'` — a width this model must charge to the table that renders it.
 * Reading the factory's own `return {` is the only way to get it without an allowlist of widths that
 * would drift from the factory the moment somebody retuned the button.
 */
function factoryBody(name) {
  for (const file of walk(UI_SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const re = new RegExp(`export\\s+function\\s+${name}\\s*\\([\\s\\S]{0,400}?\\)\\s*:\\s*Column<[^;\\n]*?>\\s*\\{`);
    const m = re.exec(src);
    if (!m) continue;
    const ret = src.indexOf('return {', m.index);
    if (ret === -1) continue;
    return balanced(src, ret + 'return {'.length, '{', '}');
  }
  throw new Error(`no exported \`${name}(…): Column<…>\` anywhere in fleet-ui — this factory's width is unmeasured`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return (e.isDirectory() && e.name !== 'guards') ? walk(full) : /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/**
 * An exported numeric constant, by name, from anywhere in fleet-ui.
 *
 * The Pod column states `max: \`${POD_MAX_PX}px\`` rather than a literal, and deliberately so —
 * `pod-name.ts` derives its character budget from the same constant, which is what stops the ceiling
 * and the budget disagreeing. A model that could not follow the indirection would charge that column
 * the uncapped default and under-state the widest table on the tab by 200px.
 */
function numericConstant(name) {
  for (const file of walk(UI_SRC)) {
    const m = new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*(\\d+)\\s*;`).exec(
      fs.readFileSync(file, 'utf8')
    );
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * A column's declared px, and which property declared it.
 *
 * The distinction is load-bearing and `DataTable.size()` is where it comes from: `max` becomes
 * `maxWidth` on both the `th` and the `td`, so it is a real ceiling that clips. `width` becomes
 * `width` alone, which under `table-layout: auto` is a suggestion the widest cell — or a `nowrap`
 * header — overrides. So a `width` below the header's intrinsic width does not clip the header, it
 * quietly makes the column wider than it says it is; only a `max` below it ellipsises the label.
 *
 * `max: \`${POD_MAX_PX}px\`` is followed to its constant. `pod-name.ts` derives the Pod column's
 * character budget from that same constant, which is what stops the ceiling and the budget disagreeing;
 * a model that could not follow the indirection would charge the uncapped default and under-state the
 * widest table on the tab by 200px.
 */
function ceilingOf(body) {
  const max = /\bmax:\s*'(\d+)px'/.exec(body) || /\bmax:\s*`\$\{(\w+)\}px`/.exec(body);
  const width = /\bwidth:\s*'(\d+)px'/.exec(body) || /\bwidth:\s*`\$\{(\w+)\}px`/.exec(body);
  const pick = max ?? width;
  if (!pick) return null;
  const px = /^\d+$/.test(pick[1]) ? Number(pick[1]) : numericConstant(pick[1]);
  if (px === null) {
    throw new Error(
      `a column states its width as \`${pick[1]}\`, which is not an exported numeric constant in fleet-ui — this model cannot charge it a width`
    );
  }
  return { px, from: max ? 'max' : 'width' };
}

/**
 * The object literals of a plain `const NAME = [...]` array, wherever in fleet-ui it is declared.
 *
 * For a fan-out element: `...METRIC_COLUMNS.map(metricColumn)` expands to one column per entry of a
 * *plan* array in `pod-columns.ts`. Unlike the `.map<Column<…>>(…)` fan-out that
 * `table-shed-tier.test.js` has to treat as unbounded — one column per cluster in the fleet — this one
 * is bounded by a source-literal array, so it can and must be counted exactly. Treating it as
 * unresolvable would exempt the six widest-growing columns on the tab from every check here.
 */
function planEntries(name) {
  for (const file of walk(UI_SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const m = new RegExp(`const\\s+${name}\\s*(?::[^=\\n]*)?=\\s*\\[`).exec(src);
    if (!m) continue;
    const body = balanced(src, m.index + m[0].length, '[', ']');
    return body
      .split(/\},\s*/)
      .map(e => e.trim())
      .filter(e => e.startsWith('{'))
      .map(e => (e.endsWith('}') ? e : `${e}}`));
  }
  throw new Error(`no \`const ${name} = […]\` anywhere in fleet-ui — a fan-out over it cannot be counted`);
}

/**
 * The object literal bound to `const NAME = { … }`, wherever in fleet-ui it is declared.
 *
 * For a builder call whose argument is a plan constant: `metricColumn(CPU_OF_LIMIT)` returns a column
 * whose `key` and `priority` are `plan.key` and `plan.priority`, so the builder's own body states
 * neither — reading it gives an entry with no identity at all, which this model must not silently
 * charge as a nameless column. The plan constant is where those two facts are literals.
 *
 * This is the second shape the Top Utilization metric columns have taken in a day (a
 * `...METRIC_COLUMNS.map(metricColumn)` fan-out was the first, and `planEntries` handles that one).
 * Both are resolved rather than exempted for the same reason: the six metric columns are the width
 * this table is arguing about, and a guard that cannot see them is measuring the wrong table.
 */
function objectConstant(name) {
  for (const file of walk(UI_SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const m = new RegExp(`const\\s+${name}\\s*(?::[^=\\n]*)?=\\s*\\{`).exec(src);
    if (!m) continue;
    return balanced(src, m.index + m[0].length, '{', '}');
  }
  return null;
}

/**
 * Every column of one audited table, with the facts this model needs.
 *
 * `header` is `null` whenever the source does not state a plain string literal — a template with an
 * interpolation, or a call like `ratioHeader('request')`. That is not a failure here: it is reported
 * as unresolved, and the caller is expected to fail on it rather than measure a header it could not
 * read. The same philosophy as the `unresolved` path in `table-shed-tier.test.js` — "I could not
 * measure this" must never render as "this is fine".
 */
function columnsOf(file, arrayName) {
  const src = stripComments(read(file));
  const bodies = [];
  for (const el of arrayElements(src, arrayName)) {
    // `...PLAN.map(builder)` — one column per plan entry. The plan entry carries the `key` and the
    // `priority`; the builder carries the header, which is computed and so has to be registered.
    const fan = /^\.\.\.\s*(\w+)\s*\.map\(/.exec(el);
    if (fan) {
      bodies.push(...planEntries(fan[1]));
      continue;
    }
    if (el.startsWith('{')) {
      bodies.push(el);
      continue;
    }
    const call = /^(\w+)\s*\(\s*([A-Z][\w]*)?\s*\)?/.exec(el);
    if (!call) throw new Error(`${file}:${arrayName} has an element this model cannot resolve: ${el.slice(0, 60)}`);
    // A SCREAMING_CASE argument is a plan constant, and it is where `key` and `priority` are literals.
    const plan = call[2] ? objectConstant(call[2]) : null;
    if (plan) {
      bodies.push(plan);
      continue;
    }
    bodies.push(factoryBody(call[1]));
  }
  return bodies.map(raw => {
    // `...ACTIONS` contributes `header: 'Actions'`; resolved by textual substitution because it is a
    // frozen two-field constant in DataTable.tsx, not a shape that varies per call site.
    const body = /\.\.\.ACTIONS\b/.test(raw) ? `${raw}\nheader: 'Actions',` : raw;
    const literal = /\bheader:\s*'([^']*)'/.exec(body);
    return {
      key: (/\bkey:\s*'([^']+)'/.exec(body) || [])[1] ?? null,
      header: literal ? literal[1] : null,
      rawHeader: (/\bheader:\s*([^\n]*)/.exec(body) || [])[1]?.trim().replace(/,$/, '') ?? null,
      ceiling: ceilingOf(body),
      priority: Number((/\bpriority:\s*([123])/.exec(body) || [])[1] ?? 1),
      info: /\binfo:/.test(body)
    };
  });
}

/** The `shed` tier of the `<DataTable>` that renders `arrayName`, read from its element. */
function tierOf(file, arrayName) {
  const src = read(file);
  const at = src.indexOf(`columns={${arrayName}}`);
  if (at === -1) throw new Error(`${file}: nothing renders \`${arrayName}\` — the audit is measuring an unused array`);
  const open = src.lastIndexOf('<DataTable', at);
  const element = src.slice(open, src.indexOf('/>', at));
  return (/shed="(mid|wide|xwide|lean)"/.exec(element) || [, 'base'])[1];
}

/** How wide a header label is at its narrowest, given whether its tier lets it wrap. */
function headerPx(header, { wraps, info }) {
  const longest = wraps ? header.split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), '') : header;
  return Math.ceil(longest.length * HEADER_ADVANCE_PX) + (info ? INFO_TIP_PX : 0);
}

/**
 * The width a column's header actually needs before it starts clipping — label, its `info:` tip, the
 * sort mark, and the cell's own inline padding.
 *
 * `sortable` defaults to true because `DataTable` decides it from `!!c.sortValue`, and in the audited
 * tables all but the Actions column state one. Pass `false` only for a column with no `sortValue`.
 */
function headerFitsPx(column, tier, headers, { sortable = true } = {}) {
  const label = column.header ?? headers?.[column.key];
  if (label == null) return null;
  const head = headerPx(label, { wraps: WRAPPING_TIERS.has(tier), info: column.info });
  return head + CELL_PAD_PX + (sortable ? SORT_MARK_PX : 0);
}

/**
 * The per-column worst-case content widths a table's own plan module declares, keyed by column key.
 *
 * Top Utilization has such a module — `pod-columns.ts` — and it does this better than the flat default
 * above: it states the widest string each column can print (`No request` at ten characters, not an
 * average) and converts it at the same 8.3px mono advance `pod-name.ts` uses. So this model READS it
 * rather than deriving a rival number.
 *
 * That is the whole point. Two modules stating different ceilings for one table is the duplicated-fact
 * problem, and it had already produced a 294px disagreement about the pods table before the border-box
 * bug above was found — this model's, which was wrong. Where a plan module exists it is the authority
 * and this file is a consumer; where none exists (the Autoscaling tables) the flat default applies and
 * is coarse, which is stated rather than hidden.
 *
 * Returns `{}` if the module has no such map, so a table without a plan is measured, not skipped.
 */
function planContentPx(file) {
  const src = stripComments(read(file));
  const at = src.indexOf('WORST_CASE_CHARS');
  if (at === -1) return {};
  const open = src.indexOf('{', src.indexOf('=', at));
  const body = balanced(src, open + 1, '{', '}');
  const advance = Number((/const MONO_ADVANCE_PX = ([\d.]+);/.exec(src) || [])[1]);
  const padding = Number((/const CELL_PADDING_PX = (\d+);/.exec(src) || [])[1]);
  if (!advance || !padding) {
    throw new Error(`${file} declares WORST_CASE_CHARS but not the advance and padding it converts with — its widths cannot be read`);
  }
  const out = {};
  for (const m of body.matchAll(/(\w+):\s*\{\s*chars:\s*(\d+)/g)) out[m[1]] = Math.round(Number(m[2]) * advance) + padding;
  return out;
}

/**
 * One column's width, padding included, and the header width to check it against.
 *
 * ## `max` is border-box, and getting that wrong cost 192px
 *
 * Tailwind's preflight sets `box-sizing: border-box` on everything, and nothing in `theme.css`
 * overrides it for a table cell. So `max-width: 160px` on a `td` is 160px **including** its 32px of
 * inline padding — a capped column costs its ceiling and not a pixel more. The first version of this
 * model added `CELL_PAD_PX` to every column including the capped ones, which over-charged the six
 * capped columns of the Top Utilization pods table by 32px each and put its total 294px above the
 * figure `pod-columns.ts` derives for the same table. That module was right and this one was wrong.
 *
 * Which leaves three cases, not one:
 *
 *  - a `max`: the column costs exactly that. It cannot grow, and a header too wide for it is clipped
 *    rather than accommodated — which is what `ceilingPx` is reported for.
 *  - a `width`: border-box too, but `table-layout: auto` overrides it, so the column costs the widest
 *    of the stated width, the header and the content — each plus its padding.
 *  - neither: content and header are both free to set it, so it costs the wider of the two plus padding.
 */
function columnPx(column, tier, headers, content) {
  const label = column.header ?? headers?.[column.key];
  if (label === undefined || label === null) return null;
  const head = headerPx(label, { wraps: WRAPPING_TIERS.has(tier), info: column.info });
  const capped = column.ceiling?.from === 'max';
  const declaredPx = column.ceiling?.px ?? null;
  /*
    Three sources for "how wide is this column's content", in descending order of authority.

    A plan module's per-column worst-case string is best. A declared `width` is next and is NOT
    improved on by the flat default: somebody sized the Logs button at 92px, and charging it the 120px
    default over the top of that is this model second-guessing a measurement with an average. The flat
    default is the last resort, for a column that states nothing at all.
  */
  const contentPx = content?.[column.key] ?? (declaredPx ?? UNCAPPED_CONTENT_PX + CELL_PAD_PX);
  const total = capped ? declaredPx : Math.max(declaredPx ?? 0, head + CELL_PAD_PX, contentPx);
  return { head, ceilingPx: capped ? declaredPx : null, declaredPx, body: total - CELL_PAD_PX, total };
}

/**
 * The whole table's width, and the width of the set each tier threshold leaves behind.
 *
 * `full` is what the table needs when nothing is shed. `keptAbovePrio2` is what survives the prio-3
 * threshold, which is the set an operator sees for the whole band between a tier's two numbers — the
 * band that covers a 1440px laptop on every tier from `wide` up.
 *
 * The outer-edge credit is applied per surviving set rather than once per table, and only to an
 * UNCAPPED first or last column. `theme.css` zeroes `padding-inline-start` on the first cell and
 * `padding-inline-end` on the last, which is 16px off each — but only for a column whose width its
 * content sets. A column pinned by a border-box `max` is that many pixels wide whatever its padding
 * does, so crediting it would be inventing room the layout does not give back. Which column is last
 * changes as columns shed, which is why this is computed per set: on the pods table the last column
 * is the capped Logs button until prio-2 sheds and something uncapped becomes last.
 */
function tableWidth(file, arrayName, headers, plan) {
  const tier = tierOf(file, arrayName);
  const columns = columnsOf(file, arrayName);
  const content = { ...planContentPx(file), ...(plan ? planContentPx(plan) : {}) };
  const unresolved = [];
  const sized = [];
  for (const c of columns) {
    const px = c.key === null ? null : columnPx(c, tier, headers, content);
    if (!px) {
      unresolved.push({ key: c.key, header: c.rawHeader });
      continue;
    }
    sized.push({ ...c, ...px });
  }
  const sum = set => {
    if (set.length === 0) return 0;
    const edge = c => (c.ceilingPx === null ? CELL_PAD_PX / 2 : 0);
    return set.reduce((a, c) => a + c.total, 0) - edge(set[0]) - edge(set[set.length - 1]);
  };
  return {
    tier,
    thresholds: TIER_THRESHOLDS[tier],
    columns: sized,
    unresolved,
    count: columns.length,
    full: sum(sized),
    keptAbovePrio2: sum(sized.filter(c => c.priority <= 2)),
    keptPinned: sum(sized.filter(c => c.priority === 1))
  };
}

export {
  CELL_PAD_PX,
  CONTAINER_AT_1440_PX,
  HEADER_ADVANCE_PX,
  SORT_MARK_PX,
  TIER_THRESHOLDS,
  UNCAPPED_CONTENT_PX,
  WRAPPING_TIERS,
  columnsOf,
  headerFitsPx,
  headerPx,
  planContentPx,
  tableWidth,
  tierOf
};
