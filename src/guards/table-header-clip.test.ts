// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * Does a capped column's HEADER fit, or does the label itself get cut off?
 *
 * `table-fit.test.js` answers "is this table wider than its container". This answers the question it
 * cannot: a column that states `max: '160px'` is exactly 160px wide whether or not its label fits, so
 * a header too wide for its own ceiling never widens the table and never trips that budget — it just
 * renders `SCHEDULE (CRO…`. The table fits, the ratchet passes, and the column is unidentifiable.
 *
 * A clipped VALUE is a considered trade in this console: the cell carries a `title`, the operator
 * hovers, and `max` exists precisely so one long pod name cannot set the table's width. A clipped
 * HEADER is not the same trade. It is the one string that says what the column means, it is the same
 * for every row, and no amount of hovering rows recovers it.
 *
 * The 12px the model was missing
 * ------------------------------
 * Every sortable header is a `<button class="th-sort">` with `gap: 6px` and a 9px `↕`/`▲`/`▼` mark
 * appended (`DataTable.tsx:769-779`, `theme.css:898-928`). Nothing charged for it, so the audit
 * believed `Schedule (Cron)` needed 155px against its 160px ceiling when it actually needs 167px.
 * That is why this file exists rather than one more assertion inside `table-fit.test.js`:
 * `SORT_MARK_PX` must NOT enter the width sums there, or every budget inflates to describe pixels no
 * table occupies. See the note on the constant.
 */




import { columnsOf, headerFitsPx, tierOf } from './helpers/column-width';

const UI_SRC = path.join(FAKE_DIR, '../../src');

/**
 * Clips that exist today, each with the width it needs, and why it is not simply widened here.
 *
 * This is DEBT, not an exemption: every entry is a header an operator cannot read in full. It is
 * recorded rather than fixed because the two available fixes both need something this suite cannot
 * supply on its own —
 *
 *  - widening the ceiling makes the table wider, and for the OpaCoverage pair that is +166px on one
 *    table, which has to be re-measured in Chrome against the 1167px container before it can be
 *    called an improvement rather than a horizontal scrollbar;
 *  - shortening the label changes the string `align.ts` classifies a column by, so it can silently
 *    move a column's alignment, and several header words are pinned by other guards.
 *
 * The list may SHRINK freely. Adding to it requires the same justification as any other recorded
 * trade-off, and the count assertion below is what forces that conversation instead of letting the
 * list grow quietly.
 */
const KNOWN_CLIPPED = [
  { array: 'columns', key: 'chartVersion', needs: 151, max: 120 },
  { array: 'columns', key: 'updated', needs: 143, max: 120 },
  { array: 'columns', key: 'appVersion', needs: 135, max: 130 }
];

const allowed = new Set(KNOWN_CLIPPED.map(c => `${c.array}.${c.key}`));

/** Every `Column<T>[]` literal under src, with the tier the table renders at. */
function everyAuditedTable() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if ((entry.isDirectory() && entry.name !== 'guards')) walk(p);
      else if (/\.tsx?$/.test(entry.name)) files.push(p);
    }
  })(UI_SRC);

  const tables = [];
  for (const abs of files) {
    const rel = path.relative(UI_SRC, abs);
    for (const m of fs.readFileSync(abs, 'utf8').matchAll(/const (\w+):\s*Column<[^\n]*=/g)) {
      let columns;
      let tier;
      try {
        columns = columnsOf(rel, m[1]);
        tier = tierOf(rel, m[1]);
      } catch {
        // An array this helper cannot parse, or one nothing renders. `table-fit.test.js` owns the
        // "is it rendered at all" complaint for the tables it audits; silently skipping here would
        // hide a table from THIS check, so the count assertion below is what notices.
        continue;
      }
      tables.push({ rel, array: m[1], tier, columns });
    }
  }
  return tables;
}

function clipsIn(tables) {
  const clips = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.header || !c.ceiling || c.ceiling.from !== 'max') continue;
      const needs = headerFitsPx(c, t.tier, null);
      if (needs != null && needs > c.ceiling.px) {
        clips.push({ ...t, key: c.key, header: c.header, max: c.ceiling.px, needs });
      }
    }
  }
  return clips;
}

test('no capped column clips its own header, except the clips already recorded as debt', () => {
  const clips = clipsIn(everyAuditedTable());
  const fresh = clips.filter(c => !allowed.has(`${c.array}.${c.key}`));
  assert.deepEqual(
    fresh.map(
      c =>
        `${c.rel} ${c.array}.${c.key} header '${c.header}' needs ${c.needs}px (label + info tip + 12px sort mark + 32px padding) but states max: '${c.max}px' — the label renders cut off. Widen the ceiling and re-measure the table in Chrome, shorten the label (check align.ts still classifies it the same way), or record it in KNOWN_CLIPPED with the reason.`
    ),
    []
  );
});

test('the recorded clip list is shrinking, not growing', () => {
  // A bare allowlist is a green gate that gates nothing: entries accumulate and the suite keeps
  // passing. Pinning the count means removing debt is a one-line edit and adding to it is a visible
  // decision. If you fixed one, lower this number in the same commit.
  assert.equal(
    KNOWN_CLIPPED.length,
    3,
    'KNOWN_CLIPPED changed size. Fixing a clip? Lower this count. Adding one? Say in the entry why neither widening nor shortening was possible.'
  );
});

test('every recorded clip still exists, and still needs the width recorded for it', () => {
  // The other half of the ratchet. Without this, a header that was fixed or renamed leaves a stale
  // entry behind that silently exempts a FUTURE clip on the same column key.
  const clips = clipsIn(everyAuditedTable());
  const seen = new Map(clips.map(c => [`${c.array}.${c.key}`, c]));
  const stale = [];
  for (const entry of KNOWN_CLIPPED) {
    const id = `${entry.array}.${entry.key}`;
    const live = seen.get(id);
    if (!live) {
      stale.push(`${id} no longer clips — delete it from KNOWN_CLIPPED and lower the count.`);
      continue;
    }
    if (live.needs !== entry.needs || live.max !== entry.max) {
      stale.push(
        `${id} now needs ${live.needs}px against max ${live.max}px, recorded as ${entry.needs}px against ${entry.max}px — update the entry.`
      );
    }
  }
  assert.deepEqual(stale, []);
});

test('the sweep is actually looking at tables', () => {
  // This suite discovers its own inputs, so a regex that stops matching would report zero clips and
  // pass. The floor is deliberately well under the real count so it survives ordinary refactors
  // while still failing if discovery breaks.
  const tables = everyAuditedTable();
  assert.ok(
    tables.length >= 20,
    `only ${tables.length} column arrays were discovered, which means the Column<T>[] sweep is broken, not that the console lost its tables`
  );
  assert.ok(
    tables.some(t => t.columns.some(c => c.ceiling && c.ceiling.from === 'max')),
    'no capped column was found anywhere — this suite is measuring nothing'
  );
});
