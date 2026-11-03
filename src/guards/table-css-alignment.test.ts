// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The CSS half of the alignment contract.
 *
 * `table-alignment.test.js` checks what the *columns declare*. This checks that the stylesheet
 * actually honours a declaration, which is a separate failure and was the real bug: `DataTable` puts
 * the same `num`/`ctr` class on the `th` and the `td`, so the column definitions were correct and the
 * header still rendered hard left above right-aligned digits.
 *
 * The cause is cascade layers, not specificity. `theme.css` declares `.num { text-align: right }` in
 * `@layer base` and `.tbl thead th { text-align: left }` later in `@layer components`; a later layer
 * wins outright and specificity is never consulted across layers. Measured live on the Security tab
 * before the fix, `PODS`, `POLICIES` and `UNSELECTED PODS` all computed `left` on the `th` over
 * `right` on the `td`. Sortable columns escaped it by accident — their label is a flex `.th-sort`
 * button positioned by `justify-content`, a different property entirely — which is why the defect
 * survived: the columns an operator clicks looked fine.
 *
 * So the assertions below are about *ordering inside the stylesheet*, the thing a screenshot of one
 * table cannot show and a type cannot express:
 *
 *  1. the `th.num` / `th.ctr` overrides exist at all;
 *  2. they come *after* the blanket `.tbl thead th { text-align: left }` in source order, because two
 *     rules of equal specificity in the same layer are decided by position — moving the override up a
 *     few lines while tidying would silently restore the bug;
 *  3. both live in the same layer as the rule they override, since a `base`-layer override of a
 *     `components`-layer rule loses however specific it is.
 *
 * It also pins the `.pair` grid, whose three tracks are what put a compound metric's separator on the
 * same x down a column. `min-width: 0` on the operands is the load-bearing part: a grid item defaults
 * to `min-width: auto`, so without it a long value widens its own track and shoves the separator
 * across instead of ellipsising — which is the 25px/50px slash wobble the grid was added to remove.
 */




const CSS_PATH = path.join(FAKE_DIR, '../../src/theme.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

/**
 * Comments in this stylesheet discuss `text-align` at length — the fix's own docstring quotes the
 * broken rule verbatim — so every check below runs against the declarations only.
 */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The index of a selector's declaration block, or -1. Whitespace-tolerant, comment-free input. */
function ruleAt(selector, decl) {
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*${decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );
  const m = pattern.exec(code);
  return m ? m.index : -1;
}

/** Which `@layer <name>` block an index falls inside, by walking braces from the top of the file. */
function layerAt(index) {
  let depth = 0;
  let layer = null;
  let layerDepth = -1;
  for (let i = 0; i < index; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (layer !== null && depth < layerDepth) {
        layer = null;
        layerDepth = -1;
      }
    } else if (ch === '@') {
      const m = /^@layer\s+([\w\s,]+?)\s*\{/.exec(code.slice(i));
      if (m) {
        layer = m[1].trim();
        layerDepth = depth + 1;
      }
    }
  }
  return layer;
}

test('a right- or centre-aligned column keeps its header alignment', () => {
  // Both table classes, because the nested `.tbl-inline` repeats the same
  // `thead th { text-align: left }` blanket and shipped with the same defect.
  for (const table of ['.tbl', '.tbl-inline']) {
    const base = ruleAt(`${table} thead th`, 'text-align: left');
    assert.ok(
      base >= 0,
      `the blanket \`${table} thead th { text-align: left }\` is gone. If header alignment is now ` +
        'stated some other way this test no longer guards anything — rewrite it against the new ' +
        'rule rather than deleting it, because the bug it caught is invisible in a screenshot of ' +
        'any single table.'
    );

    for (const [cls, want] of [
      [`${table} thead th.num`, 'text-align: right'],
      [`${table} thead th.ctr`, 'text-align: center']
    ]) {
      const at = ruleAt(cls, want);
      assert.ok(
        at >= 0,
        `\`${cls} { ${want} }\` is missing. \`DataTable\` puts the same class on the th and the td, ` +
          `so without it every non-sortable ${cls.endsWith('num') ? 'right' : 'centre'}-aligned ` +
          `column renders its label hard left above a column that is not.`
      );
      assert.ok(
        at > base,
        `\`${cls}\` is declared BEFORE the blanket \`${table} thead th { text-align: left }\`. Same ` +
          `layer, same specificity — source order decides, so the blanket rule wins and the ` +
          `override does nothing. Move it back below.`
      );
      assert.equal(
        layerAt(at),
        layerAt(base),
        `\`${cls}\` sits in layer "${layerAt(at)}" while the rule it overrides sits in ` +
          `"${layerAt(base)}". A later cascade layer wins regardless of specificity — that ` +
          `asymmetry is the original bug (\`.num\` in @layer base lost to \`.tbl thead th\` in ` +
          `@layer components), and splitting these two apart reintroduces it.`
      );
    }
  }
});

test('a numeric column gets tabular figures, not just a right edge', () => {
  /*
   * Right alignment lines up the last digit; it does nothing about the ones in front of it. In a
   * proportional font `1` is narrower than `8`, so `11%` and `88%` on adjacent rows put their first
   * digit at two different x positions and a column of percentages reads jagged even though every
   * cell is flush right. `font-variant-numeric: tabular-nums` on `.num` is the fix, and it is
   * inherited — which is why the cells inside a `.num` cell do not each restate it, and why deleting
   * it here would quietly un-align every numeric column in the console at once.
   */
  const num = /\.num\s*\{([^}]*)\}/.exec(code);
  assert.ok(num, '`.num` is gone from theme.css');
  assert.match(
    num[1],
    /font-variant-numeric:\s*tabular-nums/,
    '`.num` no longer declares `font-variant-numeric: tabular-nums`. Every right-aligned column on ' +
      'every table relies on inheriting it from the cell — without it a column of percentages is ' +
      'flush right and still ragged, which is what the Top Utilization tables were reported as.'
  );
  assert.match(num[1], /text-align:\s*right/, '`.num` must still right-align');
});

test('the compound-metric grid pins its separator', () => {
  assert.ok(
    ruleAt('.pair', 'grid-template-columns: 1fr auto 1fr') >= 0,
    'the `.pair` three-track grid is gone. Right-aligning `9m / 500m` as one string aligns the last ' +
      'digit and lets the slash land wherever the operand widths put it — measured at 25px of drift ' +
      'in CPU and 50px in memory down one screenful of the Workloads table.'
  );

  const operands = /\.pair-a,\s*\.pair-b\s*\{([^}]*)\}/.exec(code);
  assert.ok(operands, '`.pair-a, .pair-b` no longer share a rule');
  assert.match(
    operands[1],
    /min-width:\s*0/,
    '`min-width: 0` is gone from the pair operands. A grid item defaults to `min-width: auto`, so a ' +
      'long value widens its own track and pushes the separator across instead of ellipsising — the ' +
      'exact wobble `.pair` exists to remove.'
  );
  assert.match(operands[1], /text-overflow:\s*ellipsis/, 'a clipped operand must show that it is clipped');

  assert.ok(ruleAt('.pair-a', 'text-align: right') >= 0, '`.pair-a` must read into the separator');
  assert.ok(ruleAt('.pair-b', 'text-align: left') >= 0, '`.pair-b` must read away from the separator');
});

/**
 * Vertical centring, which until now lived only in prose.
 *
 * A `td` is `vertical-align: middle` by default, so this invariant holds by *omission* — which is
 * exactly why it needs a guard: the rule that breaks it is not a wrong value, it is a well-meant
 * `vertical-align: top` added to make one tall cell look tidier, and it would silently top-align
 * every row on every table in the console. A row whose 44px of height holds a pill, a name and a
 * number must put all three on one axis; on a 28px `.tbl-inline` row the same applies.
 *
 * Only body cells are checked. `.tbl thead th` is a fixed 36px of single-line uppercase label and
 * has no second thing to align against, and the inner truncation rule deliberately uses
 * `vertical-align: bottom` on an *inline-block* — a different property on a different box, and the
 * one value that keeps a clipped inline-block on the same baseline as the plain text beside it.
 */
test('table body cells stay vertically centred', () => {
  for (const selector of ['.tbl tbody td', '.tbl-inline tbody td']) {
    const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(code);
    assert.ok(rule, `${selector} is gone from theme.css`);
    const declared = /vertical-align:\s*([a-z-]+)/.exec(rule[1]);
    assert.ok(
      declared === null || declared[1] === 'middle',
      `${selector} declares \`vertical-align: ${declared?.[1]}\`. A body cell must be middle-aligned — ` +
        'either by declaring it or by leaving the `td` default alone. Anything else pins a row\'s pill, ' +
        'name and number to three different axes, and it does it to every table in the console at once.'
    );
  }
});

/**
 * The 2026-09-27 all-tabs sweep, measured against the live console, each fixed in theme.css.
 *
 * A numeric column's label must end on its digits' edge. The sort mark follows the label in the DOM,
 * so with a plain row every sortable numeric label ended 12px short of its digits; `row-reverse` puts
 * the mark on the inner side. `row-reverse` also flips the main axis, so the packing that hugs the
 * right edge is `flex-start` — `flex-end` would throw the label to the left of the cell.
 *
 * The first table in a card body collapses its hidden toolbar row to 18px (it was a 52px blank band
 * under the title on seven cards), but only when that table has a toolbar — without one the table
 * fell flush against the title — and never on an IngressCard body, which has its own -6px pull that
 * a later `margin-top: 0` silently cancels.
 *
 * The scroll cue has to be a registered `<length>`, or the keyframes jump instead of fading. The mask
 * itself is pinned too: without it the timeline animates a variable nothing reads.
 */
test('the 2026-09-27 alignment fixes stay in theme.css', () => {
  const sortRule = /\.num \.th-sort\s*\{([^}]*)\}/.exec(code);
  assert.ok(sortRule, '`.num .th-sort` is gone');
  assert.match(sortRule[1], /flex-direction:\s*row-reverse/, 'the sort mark must sit on the label\'s inner side');
  assert.match(
    sortRule[1],
    /justify-content:\s*flex-start/,
    'under row-reverse, `flex-start` is the right edge; `flex-end` pushes a numeric header to the left'
  );

  assert.match(
    code,
    /\.card-body:not\(\.panel-x-children\):has\(> \.table-block:first-child > \.table-tools\)[^{]*\{[^}]*padding-top:\s*0/,
    'the card-body toolbar collapse must key on a toolbar being present and skip IngressCard bodies'
  );
  assert.match(
    code,
    /\.card-body:not\(\.panel-x-children\) > \.table-block:first-child > \.table-tools[^{]*\{[^}]*min-height:\s*18px/,
    'the card-body toolbar row must collapse to 18px'
  );
  assert.ok(
    ruleAt('.panel-x-children > .table-block:first-child > .table-tools', 'margin-top: -6px') >= 0,
    'the IngressCard pull-up is gone'
  );

  assert.match(code, /@property --table-fade\s*\{[^}]*syntax:\s*'<length>'[^}]*initial-value:\s*0px/);
  assert.match(code, /@keyframes table-fade\s*\{/);
  assert.match(code, /\.table-wrap\s*\{[^}]*mask-image:\s*linear-gradient\([^;]*var\(--table-fade\)/, 'the fade mask is gone from `.table-wrap`');
  assert.match(code, /animation-timeline:\s*scroll\(self inline\)/);
});
