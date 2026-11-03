// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The structural half of the table standard: "never allow header/data drift".
 *
 * `table-alignment.test.js` checks what the columns *declare*. This file checks the mechanism that
 * makes a declaration reach both rows of the table — because alignment, width, priority and the
 * ellipsis are only single-sourced while every table is a `DataTable`, whose `th` and `td` are built
 * from the same `Column` object by the same two helpers. A hand-written `<table className="tbl">`
 * states the header's class in one JSX element and the body's in another, which is not a rule an
 * operator can see being broken until the two are one column apart. Thirty-one of those existed on
 * this branch; every one has been folded into the shared component, and this test is what stops the
 * thirty-second being written.
 *
 * Both assertions were canaried in both directions before being trusted: reverting `cls(c)` on the
 * `td` to a literal string fails the second test, and re-adding one hand-rolled `<table
 * className="tbl">` fails the first.
 */




const UI_SRC = path.join(FAKE_DIR, '../../src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return (e.isDirectory() && e.name !== 'guards') ? walk(full) : /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

function sources() {
  const files = walk(UI_SRC);
  assert.ok(files.length >= 40, `the fleet-ui scan found only ${files.length} files — the scan is broken, not the UI`);
  return files.map(file => ({ file: path.relative(UI_SRC, file), src: fs.readFileSync(file, 'utf8') }));
}

/** Prose about tables is everywhere in this codebase; a naive grep would match the doc comments. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * `tbl-inline` is a different primitive and a deliberate exception.
 *
 * It is the two-to-three column table that lives *inside* a card — a LimitRange's defaults, a
 * ConfigMap's keys — where a 44px row and a 36px uppercase header would dwarf the card holding it.
 * Those are single `<table>` elements with no shed tier, no resize and no toolbar, so a header
 * cannot drift from a body it was written beside; and giving each card a `DataTable` would put one
 * toolbar per card on the page and share one preferences id between all of them.
 *
 * Listed by file rather than allowed by class name so a new one is a decision somebody makes here.
 */
const INLINE_EXCEPTIONS = [
  'pages/ClusterDetail.tsx',
  'pages/cluster-tabs/StorageTab.tsx',
  'pages/cluster-tabs/opa/OpaOverview.tsx',
  // The Pods row's opened panel: a pod's containers and its recent events, inside one detail row
  // of the pods DataTable. A nested DataTable would bring its own toolbar and preferences per row.
  'pages/cluster-tabs/PodsSection.tsx'
];

test('every console table is a DataTable — no hand-written .tbl markup', () => {
  const offences = [];
  for (const { file, src } of sources()) {
    if (file === 'components/DataTable.tsx') continue;
    const body = stripComments(src);
    // `className="tbl"` / `"tbl tbl-wide"` / a template literal starting with tbl — but not
    // `tbl-inline`, which is its own primitive.
    const re = /<table[^>]*className=[{`"']+\s*(tbl[\w- ]*)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const cls = m[1].trim();
      if (cls.startsWith('tbl-inline')) {
        assert.ok(
          INLINE_EXCEPTIONS.includes(file),
          `${file} renders a \`tbl-inline\` table and is not in INLINE_EXCEPTIONS — add it there with the reason, or use \`DataTable\`.`
        );
        continue;
      }
      offences.push(
        `${file} renders \`<table className="${cls}">\` by hand. Its header classes and its body classes are then two separate statements that have to agree — which is the drift the standard forbids. Use \`DataTable\` with a \`Column[]\`: alignment, \`max\`, \`priority\`, resize, reorder, Columns and sorting all come with it.`
      );
    }
  }
  assert.deepEqual(offences, []);
});

test('DataTable applies the same class and the same width to the th and the td', () => {
  const src = fs.readFileSync(path.join(UI_SRC, 'components/DataTable.tsx'), 'utf8');
  const body = stripComments(src);

  // The header cell and the body cell, each taking both helpers from the same `Column` object.
  const th = /<th\b[\s\S]*?className=\{cls\(c\)\}[\s\S]*?style=\{size\(c\)\}/.test(body);
  const td = /<td\b[^>]*className=\{cls\(c\)\}[^>]*style=\{size\(c\)\}/.test(body);
  assert.ok(th, 'the `th` in DataTable no longer takes both `cls(c)` and `size(c)` from the column');
  assert.ok(td, 'the `td` in DataTable no longer takes both `cls(c)` and `size(c)` from the column');

  // One `<table>`, one `<thead>`, one `<tbody>`: the structural reason a header cannot drift.
  for (const tag of ['<table', '<thead>', '<tbody>']) {
    const count = body.split(tag).length - 1;
    assert.equal(count, 1, `DataTable renders ${count} \`${tag}\` elements — it must render exactly one`);
  }

  // A `colgroup` is the one element that could state a width outside `Column`, and `display: none`
  // does not apply to it, so on a table that has shed a column its widths would be off by one.
  assert.ok(!body.includes('<colgroup'), 'DataTable must not use a `<colgroup>` — see the note in the component');
});

/**
 * Every spanning row — the group header and the expandable row's detail panel — must cover exactly
 * the columns that are rendered right now, which is `visible.length` plus the injected chevron when
 * the table renders one (`chevron`: expandable, and the caller did not opt out with
 * `expandChevron="none"` because a column of its own carries the toggle). A literal, or the full declared column count, leaves the rule short of or
 * past the table's edge the moment a column is hidden or shed.
 *
 * Asserted through the shared `span` constant rather than per-`colSpan`: two spanning rows counting
 * columns by two different expressions is the drift this guards against.
 */
test('every spanning row spans however many columns are visible', () => {
  const body = stripComments(fs.readFileSync(path.join(UI_SRC, 'components/DataTable.tsx'), 'utf8'));

  const def = /const span = ([^;]+);/.exec(body);
  assert.ok(def, 'DataTable no longer defines a single `span` for its spanning rows');
  assert.equal(
    def[1].trim(),
    "visible.length + (chevron ? 1 : 0)",
    `\`span\` is \`${def[1].trim()}\` — it must count the visible columns plus the injected chevron column, and nothing else.`
  );

  const spans = [...body.matchAll(/colSpan=\{([^}]+)\}/g)].map(m => m[1].trim());
  assert.ok(spans.length >= 2, `DataTable renders ${spans.length} spanning rows — expected the group header and the detail row`);
  for (const s of spans) {
    assert.equal(s, 'span', `a spanning row counts columns as \`${s}\` instead of the shared \`span\``);
  }
});

