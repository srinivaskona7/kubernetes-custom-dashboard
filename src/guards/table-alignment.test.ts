// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The alignment contract, enforced as a source check.
 *
 * `DataTable.tsx` states the rule as two exported values — `NUMERIC` for a magnitude or a moment,
 * `ACTIONS` for a column of controls — and everything else stays left. Stating it was not enough:
 * the rule had already drifted in exactly the way a prose rule always does, and the drift is
 * invisible in any single screenshot because it needs two tables side by side to see. `Last audit`
 * was right in Admission Policies and left in the Overview table beside it; `Last seen` went both
 * ways across Observability and Traffic; `Chart version` was right on the cluster's Helm tab and
 * left in the release page's History; `Nodes` was a right-aligned count in the fleet Overview and a
 * left-aligned node *name* in the workloads table.
 *
 * So the check here is a consistency one rather than a taxonomy: this file does not try to decide
 * whether "Freshness" is a magnitude. It asserts that **one header label means one alignment across
 * the whole console**, which is the property an operator actually perceives, and it names the exact
 * pair of columns that disagree when it fails.
 *
 * Two structural rules come with it:
 *
 *  - A **pinned** column is the row's label and stays left whatever it holds. A right-aligned pinned
 *    column opens a gap between the table's own left edge and its first text, which is why
 *    `HelmHistory.revision` is left despite being a number. Pinned columns are therefore exempt from
 *    the consistency rule too — they are not competing with anything.
 *  - An **`...ACTIONS`** column is last in its array. A control column in the middle of a row puts a
 *    button between two facts, and the three that predated `ACTIONS` also carried an empty header,
 *    which left a blank `th` above a button and gave a screen reader nothing to announce.
 *
 * Scope and its honest limit: only columns whose `header` is a single-quoted string literal take part
 * in the consistency rule. A header built out of JSX or from a helper (`ratioHeader(what, 'request')`)
 * has no comparable label, so it is skipped rather than guessed at — which is also why the structural
 * rules below are checked against every column, string header or not.
 */




const UI_SRC = path.join(FAKE_DIR, '../../src');

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
  return files.map(file => ({ file: path.relative(UI_SRC, file), src: fs.readFileSync(file, 'utf8') }));
}

/** The doc comments in these files discuss alignment at length; a naive grep would match the prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every `Column<T>[]` array in the source, as an ordered list of its own entries.
 *
 * Grouped per array rather than flattened, because the "ACTIONS is last" rule is a statement about
 * position within one table and a flat list of every column in the file cannot express it.
 */
function columnArrays(src) {
  const arrays = [];
  const re = /const\s+(\w*columns\w*)\s*:\s*Column<[^;\n]*?>\[\]\s*=\s*\[/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const entries = [];
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
          if (key) entries.push(describe(key, body));
          start = -1;
        }
        brace--;
      }
    }
    if (entries.length) arrays.push({ name: m[1], entries });
  }
  return arrays;
}

/**
 * What one column declares about its own alignment.
 *
 * `align: 'right'` and the two spreads are the same statement written three ways, and all three have
 * to be recognised: an audit that understood only the literal reported every `...NUMERIC` column in
 * Observability as left-aligned, which is a guard that invents work.
 *
 * `center` is the third value and had to be taught before the first centred column shipped. This
 * collapsed to `right | left` while `CENTER` existed and was spread on the ZERO columns, so a centred
 * column read as *left* — which meant a `READY` column centred in one table and left in another would
 * have compared equal and passed, and the same column against a right-aligned `READY` elsewhere would
 * have been reported with the wrong prescription ("spread ...NUMERIC on both").
 */
function describe(key, body) {
  const actions = /\.\.\.ACTIONS\b/.test(body);
  const header = /header:\s*'([^']*)'/.exec(body);
  const right = /align:\s*'right'/.test(body) || /\.\.\.NUMERIC\b/.test(body) || actions;
  const center = /align:\s*'center'/.test(body) || /\.\.\.CENTER\b/.test(body);
  return {
    key,
    body,
    actions,
    pinned: /pin:\s*true/.test(body),
    align: right ? 'right' : center ? 'center' : 'left',
    // `ACTIONS` supplies the header itself, so such a column declares none of its own.
    header: actions ? 'Actions' : header ? header[1] : null
  };
}

/**
 * Columns that break the one-label rule on purpose, each keyed `file:key` and each with its reason.
 *
 * Narrow by construction: an entry names one column in one file, never a label, so the next table to
 * centre a Status still fails. Add one only for an explicit request, dated.
 */
const LABEL_EXEMPT = new Map([
  ['pages/cluster-tabs/NamespacesSection.tsx:status', 'user-requested centred layout 2026-09-24'],
  ['pages/cluster-tabs/PodsSection.tsx:status', 'matches the Namespaces table, user request 2026-09-25']
]);

/** The one-label-one-alignment offences across a set of `{ file, src }` sources. */
function labelOffences(files) {
  const byHeader = new Map();
  for (const { file, src } of files) {
    for (const array of columnArrays(stripComments(src))) {
      for (const c of array.entries) {
        // A pinned column is the row's label and is exempt — see the header comment.
        if (c.header === null || c.pinned || LABEL_EXEMPT.has(`${file}:${c.key}`)) continue;
        const label = c.header.toLowerCase();
        if (!byHeader.has(label)) byHeader.set(label, []);
        byHeader.get(label).push({ where: `${file}:${c.key}`, align: c.align });
      }
    }
  }

  const offences = [];
  for (const [label, columns] of [...byHeader].sort()) {
    if (new Set(columns.map(c => c.align)).size === 1) continue;
    // Grouped by whichever alignments actually appear, not by a hardcoded right/left pair: a
    // centred column against a right-aligned one is a real offence and used to print as
    // "right-aligned in … and left-aligned in <nothing>".
    const groups = ['left', 'center', 'right']
      .map(a => ({ a, where: columns.filter(c => c.align === a).map(c => c.where) }))
      .filter(g => g.where.length > 0)
      .map(g => `${g.a}-aligned in ${g.where.join(', ')}`);
    offences.push(
      `"${label}" is ${groups.join(' and ')} — two tables in one console disagreeing about where a value sits is what makes it feel assembled rather than designed. Spread \`...NUMERIC\` on both if it is a magnitude or a moment, \`...CENTER\` on both if it is a fixed-width ratio or badge, drop both if it is an identifier, or rename one header if the two columns render different facts.`
    );
  }
  return { byHeader, offences };
}

test('one header label means one alignment across the console', () => {
  const { byHeader, offences } = labelOffences(sources());
  // The scan finding no headers at all would pass the loop below without checking anything.
  assert.ok(byHeader.size >= 50, `only ${byHeader.size} string column headers found — the scan is broken, not the UI`);
  assert.deepEqual(offences, []);
});

test('the label exemption covers its own column and nothing else', () => {
  // The canary for LABEL_EXEMPT: the same centred Status, in a file it does not name, still fails.
  const left = "const columns: Column<R>[] = [{ key: 'status', header: 'Status', render: r => r }];";
  const centred = "const columns: Column<R>[] = [{ key: 'status', header: 'Status', ...CENTER, render: r => r }];";
  const exempt = { file: 'pages/cluster-tabs/NamespacesSection.tsx', src: centred };
  assert.deepEqual(labelOffences([{ file: 'a.tsx', src: left }, exempt]).offences, []);
  assert.equal(labelOffences([{ file: 'a.tsx', src: left }, { file: 'b.tsx', src: centred }]).offences.length, 1);
  for (const [where, why] of LABEL_EXEMPT) assert.match(why, /\d{4}-\d{2}-\d{2}/, `${where} carries no dated reason`);
});

test('a pinned leading column is never right-aligned', () => {
  const offences = [];
  for (const { file, src } of sources()) {
    for (const array of columnArrays(stripComments(src))) {
      for (const c of array.entries) {
        if (c.pinned && c.align === 'right') {
          offences.push(
            `${file}:${c.key} is pinned and right-aligned — a pinned column is the row's label, and right-aligning it opens a gap between the table's own left edge and its first text.`
          );
        }
      }
    }
  }
  assert.deepEqual(offences, []);
});

test('no column ships an empty header', () => {
  const offences = [];
  for (const { file, src } of sources()) {
    for (const array of columnArrays(stripComments(src))) {
      for (const c of array.entries) {
        if (c.header === '') {
          offences.push(
            `${file}:${c.key} declares \`header: ''\` — a blank th above a control makes the last column read as a rendering bug and gives a screen reader nothing to announce. Spread \`...ACTIONS\` for a control column, or name the column.`
          );
        }
      }
    }
  }
  assert.deepEqual(offences, []);
});

test('an ACTIONS column is the last column of its table', () => {
  const offences = [];
  let seen = 0;
  for (const { file, src } of sources()) {
    for (const array of columnArrays(stripComments(src))) {
      array.entries.forEach((c, i) => {
        if (!c.actions) return;
        seen += 1;
        if (i !== array.entries.length - 1) {
          offences.push(
            `${file}:${c.key} spreads ...ACTIONS but is column ${i + 1} of ${array.entries.length} in \`${array.name}\` — a control column belongs last, not between two facts.`
          );
        }
      });
    }
  }
  // Without this the test passes on a console that has no ACTIONS columns left at all.
  assert.ok(seen >= 3, `only ${seen} ...ACTIONS columns found — the scan is broken, or the shared control column was removed`);
  assert.deepEqual(offences, []);
});
