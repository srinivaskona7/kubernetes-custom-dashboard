// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * Does the Hosts table on Ingress & Traffic > Hosts & TLS fit the card it sits in?
 *
 * It did not, by 9px at 1440x900: the table rendered 1149px in a 1140px card and drew a horizontal
 * scrollbar under a table that had been declared to fit. Two facts the declarations hid:
 *
 *  1. **A capped column costs exactly its `max`, padding included** (border-box, see
 *     `helpers/column-width.js`). Under pressure a `nowrap` capped column sits AT its cap, not below
 *     it, so the caps are the table's floor.
 *  2. **The numeric columns cost their header, not their `width`.** `width: '78px'` on Requests
 *     rendered 113px: an uppercase label plus its sort mark and InfoTip is the column's min-content,
 *     and `table-layout: auto` never goes under it. So the free columns are charged the header widths
 *     measured in Chrome, keyed by the header text they were measured with — change a label and this
 *     test asks for a re-measure rather than trusting a stale number.
 *
 * The card is the scroll column minus its 2px border, measured in Chrome with overlay scrollbars
 * (1150px at 1440x900, 810px at 1100x800). A desktop Chrome with classic scrollbars gives up to 15px
 * of that to the vertical scrollbar, which is the case that overflowed, so the budget is the card less
 * a 15px scrollbar.
 */


import { columnsOf, tierOf, TIER_THRESHOLDS } from './helpers/column-width';

const FILE = 'pages/cluster-tabs/ingress/IngressHosts.tsx';

/** Header min-content in Chrome (label + sort mark + InfoTip + 32px padding), keyed by header text. */
const MEASURED_HEADER_PX = {
  Requests: 113,
  '4xx': 71,
  '5xx': 71,
  // 151px headless, 153px in the operator's Chrome (2026-09-26); the wider one is charged.
  'Error share': 153,
  'Latency p50 / p95': 197
};

/** The card's inner width at each viewport, overlay scrollbars. */
const CARD_PX = { 1440: 1150, 1100: 810 };

/** The widest classic scrollbar a desktop Chrome draws in the scroll column. */
const SCROLLBAR_PX = 15;

function columnCost(c) {
  if (c.ceiling?.from === 'max') return c.ceiling.px;
  const measured = MEASURED_HEADER_PX[c.header];
  assert.ok(measured, `Hosts column \`${c.key}\` (header ${JSON.stringify(c.header)}) is uncapped and has no measured header width — measure it in Chrome and record it`);
  return Math.max(measured, c.ceiling?.px ?? 0);
}

/** The columns a tier leaves at a given card width: below prio3 sheds 3, below prio2 sheds 2. */
function kept(columns, tier, card) {
  const t = TIER_THRESHOLDS[tier];
  return columns.filter(c => (c.priority === 3 ? card >= t.prio3 : c.priority === 2 ? card >= t.prio2 : true));
}

for (const viewport of [1440, 1100]) {
  test(`Hosts table fits its card at ${viewport}px with a classic scrollbar`, () => {
    const columns = columnsOf(FILE, 'columns');
    const tier = tierOf(FILE, 'columns');
    const budget = CARD_PX[viewport] - SCROLLBAR_PX;
    const shown = kept(columns, tier, budget);
    const sum = shown.reduce((a, c) => a + columnCost(c), 0);
    assert.ok(
      sum <= budget,
      `at ${viewport}px the ${shown.length} Hosts columns shown cost ${sum}px against a ${budget}px card ` +
        `(${shown.map(c => `${c.key} ${columnCost(c)}`).join(', ')}) — ${sum - budget}px of horizontal scroll`
    );
  });
}

test('every capped Hosts column states width equal to its max', () => {
  // A `max` with no `width` lets auto layout hand the column spare room (Host rendered 220px against a
  // 216px cap at 1100), and a pill sized to its own cell then reflows with it. One stated width holds.
  const src = fs.readFileSync(path.join(FAKE_DIR, '../../src', FILE), 'utf8');
  for (const c of columnsOf(FILE, 'columns').filter(c => c.ceiling?.from === 'max')) {
    const body = new RegExp(`key:\\s*'${c.key}'[\\s\\S]*?render:`).exec(src)?.[0] ?? '';
    const width = /\bwidth:\s*'(\d+)px'/.exec(body);
    assert.equal(width && Number(width[1]), c.ceiling.px, `Hosts column \`${c.key}\` caps at ${c.ceiling.px}px but states width ${width ? width[1] + 'px' : 'none'}`);
  }
});
