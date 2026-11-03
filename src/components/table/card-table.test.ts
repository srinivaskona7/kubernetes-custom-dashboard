/**
 * The toolbar row a card table restates. The wrapper breaks `.filter-bar + .table-block` and
 * `.section-head + .table-block`, so `CARD_TABLE_CLASS` restates their collapse as utilities, and the
 * band from the divider (or heading) to the card's top edge must come out the same 20px or less that
 * `table-chrome.test.ts` holds those two rules to. A restatement that adds its own bottom margin
 * leaves a blank strip under the hover toolbar on every card table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_TABLE_CLASS } from './card-table';

const css = readFileSync(join(import.meta.dirname, '../../theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** A spacing utility on `.table-tools`, in px: `-mt-2.5` → -10, `mb-0` → 0, `min-h-[18px]` → 18. */
function tools(prop: 'mt' | 'mb' | 'min-h'): number {
  const hits = CARD_TABLE_CLASS.split(/\s+/)
    .map(c => /^\[&_\.table-tools\]:(-?)([a-z-]+?)-(\[(\d+)px\]|[\d.]+)$/.exec(c))
    .filter((m): m is RegExpExecArray => !!m && m[2] === prop);
  expect(hits, `CARD_TABLE_CLASS states [&_.table-tools]:${prop} once`).toHaveLength(1);
  const [, sign, , value, arbitrary] = hits[0]!;
  const n = arbitrary ? Number(arbitrary) : Number(value) * 4;
  return sign ? -n : n;
}

/** The margin-bottom theme.css gives the rule this class restates. */
function themeMarginBottom(selector: string): number {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map(s => s.trim().replace(/\s+/g, ' '));
    const mb = /margin-bottom:\s*(-?\d+)(?:px)?\s*;/.exec(m[2] ?? '');
    if (selectors.includes(selector) && mb) return Number(mb[1]);
  }
  throw new Error(`theme.css has no margin-bottom for ${selector}`);
}

describe('CARD_TABLE_CLASS toolbar row', () => {
  const band = (marginAbove: number) => Math.max(0, marginAbove + tools('mt')) + tools('min-h') + tools('mb');

  it('is at most 20px from a FilterBar divider to the card edge', () => {
    expect(band(12)).toBeLessThanOrEqual(20);
  });

  it('is at most 20px from a Section heading to the card edge', () => {
    expect(band(8)).toBeLessThanOrEqual(20);
  });

  it('leaves no margin under the toolbar that the restated rule does not', () => {
    expect(tools('mb')).toBe(themeMarginBottom('.filter-bar + .table-block > .table-tools'));
  });
});
