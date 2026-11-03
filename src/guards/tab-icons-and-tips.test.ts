// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * Every tab explains itself, and every icon exists — enforced as source checks.
 *
 * Both are failures that render as *nothing*. A tab with no entry in `TAB_ICON` renders a heading
 * with a gap where a glyph should be; a tab with no entry in `TAB_ABOUT` renders a heading with no
 * `i` beside it, which looks exactly like a heading that was never meant to have one. TypeScript
 * catches the missing key, because both maps are exhaustive `Record<Tab, …>` — but it cannot catch
 * the two ways these go wrong in practice:
 *
 *  1. **An empty or stub value.** `''` and `'TODO'` satisfy `Record<Tab, string>`.
 *  2. **An explanation that promises what the collector does not read.** This is the completeness
 *     contract's failure mode wearing prose: a sentence claiming historical trends or request tracing
 *     is more damaging than no sentence, because an operator will act on it. This console has no
 *     time-series store, forwards traces without keeping them, and is refused `pods/proxy` — see the
 *     observability ceiling in the operator guide. So the words that describe those capabilities are
 *     banned outright here, rather than left to review.
 *
 * The column-level tips get the same treatment for a third reason specific to them: `COLUMN_INFO` is
 * the one definition of each concept, and the whole value of that is lost the moment a table writes
 * its own sentence inline instead. So this also asserts that no `info:` in the console is a bare
 * string literal.
 */




const UI_SRC = path.join(FAKE_DIR, '../../src');
const read = rel => fs.readFileSync(path.join(UI_SRC, rel), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function sourceFiles(dir = UI_SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if ((entry.isDirectory() && entry.name !== 'guards')) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The `Tab` union — the set both maps have to cover. */
function tabs() {
  const code = stripComments(read('pages/cluster-tabs/tabs.ts'));
  const union = /export type Tab =([\s\S]*?);/.exec(code);
  assert.ok(union, 'the `Tab` union was not found in tabs.ts');
  const ids = [...union[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(ids.length >= 10, `expected the full tab union, parsed only ${ids.length}`);
  return ids;
}

/** One `Record<Tab, …>` literal in tabs.ts, as a `Map<tab, rawValue>`. */
function recordOf(name) {
  const code = stripComments(read('pages/cluster-tabs/tabs.ts'));
  const block = new RegExp(`export const ${name}: Record<Tab, [^>]+> = \\{([\\s\\S]*?)\\n\\};`).exec(code);
  assert.ok(block, `${name} is gone from tabs.ts, or is no longer a single \`Record<Tab, …>\` literal`);

  const out = new Map();
  // Values span lines (the long `TAB_ABOUT` strings wrap), so split on the key rather than on \n.
  for (const m of block[1].matchAll(/(\w+):\s*([\s\S]*?)(?=,\n\s*\w+:|\s*$)/g)) {
    out.set(m[1], m[2].trim().replace(/,$/, ''));
  }
  assert.ok(out.size >= 10, `${name} parsed as only ${out.size} entries — the parser is broken`);
  return out;
}

test('every tab has a glyph', () => {
  const icons = recordOf('TAB_ICON');
  const names = new Set(
    [...stripComments(read('components/icons.tsx')).matchAll(/^ {2}\| '([a-z]+)'|^export type IconName =\s*\| '([a-z]+)'/gm)]
      .map(m => m[1] ?? m[2])
      .filter(Boolean)
  );
  assert.ok(names.size >= 10, `parsed only ${names.size} icon names from icons.tsx`);

  for (const tab of tabs()) {
    const name = icons.get(tab);
    assert.ok(name, `TAB_ICON has no entry for '${tab}', so its heading renders without a glyph`);
    const bare = name.replace(/'/g, '');
    assert.ok(
      names.has(bare),
      `TAB_ICON.${tab} is '${bare}', which is not in the \`IconName\` union — \`PATHS[name]\` would ` +
        `be \`undefined\` and the <svg> would render empty rather than failing.`
    );
  }
});

test('every tab says what it reads, and promises nothing it cannot deliver', () => {
  const about = recordOf('TAB_ABOUT');

  for (const tab of tabs()) {
    const text = about.get(tab);
    assert.ok(text, `TAB_ABOUT has no entry for '${tab}'`);
    // The raw literal includes its quotes and any `\u` escapes; 80 chars is roughly one sentence.
    assert.ok(
      text.length > 80,
      `TAB_ABOUT.${tab} is ${text.length} characters. A one-clause stub satisfies the type and ` +
        `explains nothing — the point of this string is to name the API objects read and the ` +
        `limitation of reading them.`
    );
  }

  /*
   * Capabilities this console does not have. Each one is a sentence an operator would act on:
   * "historical" and "over time" imply a series to compare against, and there is no TSDB; "trace"
   * as a stored artefact is wrong because traces are forwarded and not kept; "cost" has no source
   * at all. `pods/proxy` is refused outright by the fleet-reader role.
   */
  const forbidden = [
    /\bhistorical\b/i,
    /\bover time\b/i,
    /\btime[- ]series\b/i,
    /\btrend\b/i,
    /\bcost\b/i,
    /\bpods\/proxy\b/
  ];
  for (const [tab, text] of about) {
    for (const re of forbidden) {
      // `no metrics history behind this console` is the honest form and has to stay legal, so the
      // ban is on the capability claim, not the word: a negated mention is allowed.
      const negated = /\bno\b[^.]{0,40}$/.test(text.slice(0, (re.exec(text)?.index ?? 0)));
      if (re.test(text) && !negated) {
        assert.fail(
          `TAB_ABOUT.${tab} matches ${re} without negating it. This console has no time-series ` +
            `store, forwards traces without keeping them, has no cost source, and is refused ` +
            `pods/proxy. A tab note that implies otherwise is worse than no note, because an ` +
            `operator will go looking for the feature.`
        );
      }
    }
  }
});

test('no table writes its own column explanation inline', () => {
  const offences = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(UI_SRC, file);
    if (rel === path.join('components', 'DataTable.tsx')) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    // Only files that declare table columns. `info` is an ordinary property name elsewhere — a
    // severity-to-tone map and a console log style both have one, and neither is a column tip.
    if (!/Column</.test(code)) continue;
    for (const m of code.matchAll(/^\s*info:\s*(.+)$/gm)) {
      const value = m[1].trim();
      // A reference (`COLUMN_INFO.x`, a builder call, a ternary over either) is the whole point;
      // a bare literal is a second definition of a concept that already has one.
      if (/^['"`]/.test(value)) offences.push(`${rel}: info: ${value.slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    'a column explanation is written as a literal instead of coming from `COLUMN_INFO` or a builder ' +
      'in a shared module. "Restarts" means the same thing on four tables, and it only ' +
      'stays that way while there is one sentence rather than four:\n' +
      offences.join('\n')
  );
});

test('the three columns whose name is not their definition all carry a tip', () => {
  /*
   * Named individually rather than as a count, because a count is satisfiable by adding a tip
   * anywhere. These three are the ones an operator misreads: `CPU (used/req)` is two facts from two
   * sources, `Ready` counts readiness rather than Running, and `Restarts` is cumulative across every
   * pod lifecycle rather than the current one.
   */
  const wanted = [
    ['pages/ClusterDetail.tsx', /header: metricsAvailable \? 'CPU \(used\/req\)'[\s\S]{0,120}?info: metricsAvailable \? COLUMN_INFO\.cpuUsedReq/],
    ['pages/ClusterDetail.tsx', /header: 'Ready',\s*\n\s*info: COLUMN_INFO\.ready/],
    ['pages/ClusterDetail.tsx', /header: 'Restarts',\s*\n\s*info: COLUMN_INFO\.restarts/]
  ];
  for (const [rel, re] of wanted) {
    assert.match(
      stripComments(read(rel)),
      re,
      `${rel} no longer pairs a header with its \`COLUMN_INFO\` tip (${re}). These three columns ` +
        `are the ones whose label actively misleads without an explanation.`
    );
  }

  /*
   * Per-definition, not file-wide.
   *
   * This used to assert `/metrics-server/` against the whole file, which a canary showed passes after
   * the phrase is deleted from the CPU definition — six other definitions still mention it. A
   * provenance check has to run on the one sentence it is about.
   */
  const defs = stripComments(read('components/table/column-info.ts'));
  const required = {
    cpuUsedReq: /metrics-server/,
    memUsedReq: /metrics-server/,
    // "ready" as distinct from Running is the entire content of this one.
    ready: /readiness probe|ready/i,
    // Cumulative across lifecycles, not since the current container started.
    restarts: /cumulative|across all pod lifecycles/i
  };
  for (const [key, re] of Object.entries(required)) {
    const entry = new RegExp(`\\b${key}:\\s*\n?\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(defs);
    assert.ok(entry, `COLUMN_INFO.${key} is gone, or is no longer a single-quoted string literal`);
    assert.match(
      entry[1],
      re,
      `COLUMN_INFO.${key} no longer matches ${re}. Provenance and the limitation are the whole ` +
        `content of these sentences — a definition that does not say where the number came from, or ` +
        `what it is not telling you, answers nothing an operator was asking.`
    );
  }
});

test('the InfoTip cannot trigger a row click or a column sort', () => {
  const code = stripComments(read('components/ui.tsx'));
  const tip = /export function InfoTip\(([\s\S]*?)\n}/.exec(code);
  assert.ok(tip, '`InfoTip` is gone from ui.tsx');

  for (const handler of ['onPointerDown', 'onClick', 'onKeyDown']) {
    /*
     * Each handler's own body, bounded by its closing `}}`.
     *
     * An earlier version matched `<handler>=\{e => \{` followed by `stopPropagation` within 240
     * characters, which is wrong in the way a lazy quantifier always is: deleting
     * `onPointerDown`'s call still passed, because the scan ran on into `onClick`'s. A canary caught
     * it. The body has to be extracted first and searched on its own.
     */
    const body = new RegExp(`${handler}=\\{e => \\{([\\s\\S]*?)\\n\\s*\\}\\}`).exec(tip[1]);
    assert.ok(
      body,
      `InfoTip has no \`${handler}\` handler at all. All three are required: a press has to be ` +
        `stopped from reaching the row and the sort control, whichever input started it.`
    );
    assert.ok(
      /e\.stopPropagation\(\)/.test(body[1]),
      `InfoTip's \`${handler}\` does not call \`e.stopPropagation()\`. A \`DataTable\` row with ` +
        `\`onSelect\` is a \`role="button"\` and a sortable header's label *is* a button, so without ` +
        `this a press on the tip opens the drawer or re-sorts the table. \`pointerdown\` is the ` +
        `load-bearing one: it fires before \`click\`, and it is what the row affordance and the ` +
        `outside-press handlers listen on.`
    );
  }

  assert.doesNotMatch(
    tip[1],
    /<button/,
    'the InfoTip trigger is a `<button>` again. It renders inside a sortable header, whose label is ' +
      'already a `<button>` — nesting one is invalid HTML, and the inner press fights the sort. ' +
      '`<span role="button" tabIndex={0}>` is focusable without being a button.'
  );
  assert.match(
    tip[1],
    /createPortal\(/,
    'the InfoTip panel is no longer portalled. `.table-wrap` sets `overflow-x: auto`, which computes ' +
      '`overflow-y` to `auto` as well, so a panel inside a `<th>` is clipped by the table\'s own ' +
      'scroller — the trap already recorded in components/table/Popover.tsx.'
  );
});
