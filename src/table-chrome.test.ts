/**
 * The chrome around a table's rows: the selected-row bar, and the band between whatever sits above a
 * table and its header.
 *
 * Both were design-review findings on the OPA pages, and both are geometry a type cannot express:
 *
 *  1. The selected-row bar was `box-shadow: inset 3px 0 0` on the first cell, and the flush outer
 *     edge gives that cell `padding-inline-start: 0` — so the bar painted over the first three pixels
 *     of the first glyph ("module rma" read "odule rma"). The bar now lives in a gutter left of the
 *     cell, inside `.table-wrap`'s own padding (the one clipping box it can land in), with a gap
 *     before the text. `.card-body-flush` cells carry `--page-x` of start padding and sit against a
 *     card border, so that one context keeps the inset bar and gets no gutter.
 *  2. A FilterBar's divider sat 40px above the header it filters, and a Section's hint 36px: the
 *     FilterBar's 12px margin (or the Section's 8px gap) stacked on the table toolbar's reserved 28px.
 *     The toolbar now pulls up into that margin when it directly follows either.
 *
 * These read the source. Comments are stripped first, because the prose here quotes the old rules.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '.');
const stripBlock = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** Source with comments removed: block comments, JSX comments and whole-line `//` comments. */
const read = (rel: string) => stripBlock(readFileSync(join(SRC, rel), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
const css = read('theme.css');

/** Every declaration block whose selector list contains `selector` exactly, merged. */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map(s => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const d of (m[2] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return out;
}
const px = (v: string | undefined): number => {
  if (v === '0') return 0;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v ?? '');
  if (!m) throw new Error(`expected a px length, got ${JSON.stringify(v)}`);
  return Number(m[1]);
};

const SELECTED_ROW = ".tbl tbody tr[data-selected='true']";
const SELECTED_FIRST = `${SELECTED_ROW} td:first-child`;

describe('the selected-row bar', () => {
  it('is not painted inside a first cell whose start padding is zero', () => {
    expect(decls('.tbl thead th:first-child')['padding-inline-start']).toBe('0');
    expect(decls(SELECTED_FIRST)['box-shadow']).toBeDefined();
    expect(decls(SELECTED_FIRST)['box-shadow']).not.toMatch(/inset/);
  });

  it('sits wholly inside the table-wrap gutter, with air before the text', () => {
    const wrap = decls('.table-wrap');
    const gutter = px(wrap['padding-inline-start']);
    // The gutter must not move the table: the padding is paid back by an equal negative margin, so
    // the content box — which the shed container queries measure — keeps its width.
    expect(px(wrap['margin-inline-start'])).toBe(-gutter);

    // Two outer shadows on the first cell. Not a pseudo-element: a capped first column gets
    // `overflow-hidden` from DataTable, which clips a cell's own `::before` (measured live, it never
    // showed), and an absolute `tr::before` made Chromium insert an anonymous cell — a blank column
    // in front of every selected row. A cell's own box-shadow is clipped by neither.
    const layers = (decls(SELECTED_FIRST)['box-shadow'] ?? '').split(/,(?![^(]*\))/).map(l => l.trim());
    expect(layers).toHaveLength(2);
    const [gap, bar] = layers.map(l => {
      const m = /^(-\d+)px 0 0 var\((--color-[a-z-]+)\)$/.exec(l);
      if (!m) throw new Error(`not an outer left shadow: ${l}`);
      return { reach: -Number(m[1]), colour: m[2] };
    });
    // The first layer paints on top: the row's own tint, so the air reads as part of the row.
    expect(gap!.colour).toBe('--color-raised');
    expect(decls(`${SELECTED_ROW} td`).background).toBe('var(--color-raised)');
    expect(bar!.colour).toBe('--color-accent');
    expect(bar!.reach).toBeLessThanOrEqual(gutter);
    expect(bar!.reach - gap!.reach).toBe(3);
    expect(gap!.reach).toBeGreaterThanOrEqual(3);
    // It outranks the pinned cell's gutter mask, which is the same property.
    expect(decls('.tbl .pin')['box-shadow']).toMatch(/^-\d+px 0 0 var\(--color-surface\)$/);
    expect(decls(`${SELECTED_ROW}::before`).content).toBeUndefined();
    expect(decls(`${SELECTED_FIRST}::before`).content).toBeUndefined();
  });

  it('leaves the pinned cell at left 0, because sticky already insets by the gutter', () => {
    // Measured in Chromium: in a scroll container with 8px of start padding, a `left: 0` sticky cell
    // sits 8px in at rest and stays 8px in when scrolled — the sticky rectangle is the padding-inset
    // scrollport. A `left` equal to the gutter would push the pinned column 8px right on scroll.
    expect(decls('.tbl .pin').left).toBe('0');
  });

  it('keeps the inset bar in a flush card, where the first cell has padding and no gutter fits', () => {
    const wrap = decls('.card-body-flush .table-wrap');
    expect(wrap['padding-inline-start']).toBe('0');
    expect(wrap['margin-inline-start']).toBe('0');
    expect(decls('.card-body-flush .tbl tbody td:first-child')['padding-inline-start']).toBe('var(--page-x)');
    expect(decls(`.card-body-flush ${SELECTED_FIRST}`)['box-shadow']).toMatch(/inset/);
  });
});

describe('the band above a table header', () => {
  /** Divider (or hint) to header top, from the margin above and the pulled-up toolbar. */
  function band(marginAbove: number, rule: string): number {
    const tools = decls(rule);
    const pulled = Math.max(0, marginAbove + px(tools['margin-top']));
    return pulled + px(tools['min-height']) + px(tools['margin-bottom']);
  }

  it('is at most 20px under a FilterBar', () => {
    const filters = read('components/filters.tsx');
    // FilterBar's root: the class this rule keys on, and the 12px margin it pulls up into.
    expect(filters).toMatch(/className="filter-bar mb-3 /);
    expect(band(12, '.filter-bar + .table-block > .table-tools')).toBeLessThanOrEqual(20);
  });

  it('is at most 20px under a Section heading', () => {
    const layout = read('components/layout.tsx');
    // The Section root always carries space-y-2; a caller may add layout classes after it.
    expect(layout).toMatch(/<section className=\{`space-y-2 \$\{className \?\? ''\}`\}>/);
    expect(layout).toMatch(/className="section-head flex items-baseline justify-between"/);
    expect(band(8, '.section-head + .table-block > .table-tools')).toBeLessThanOrEqual(20);
  });

  it('fits the toolbar buttons inside the shortened row', () => {
    for (const rule of ['.filter-bar + .table-block .table-tool', '.section-head + .table-block .table-tool']) {
      const b = decls(rule);
      const h = px(b['line-height']) + 2 * px(b['padding-block']) + 2; // + the 1px border, both sides
      expect(h).toBeLessThanOrEqual(px(decls(rule.replace(' .table-tool', ' > .table-tools'))['min-height']));
    }
  });
});

describe('OPA table cells', () => {
  const block = (file: string, key: string) => {
    const src = read(file);
    const at = src.indexOf(`key: '${key}'`);
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("key: '", at + 1);
    return src.slice(at, next === -1 ? undefined : next);
  };

  it('keeps an Overview scope line such as "every namespace (30)" on one line', () => {
    const scope = block('pages/cluster-tabs/opa/OpaOverview.tsx', 'scope');
    expect(scope).toMatch(/whitespace-nowrap/);
    expect(scope).not.toMatch(/overflow-hidden|truncate|text-ellipsis/);
  });

  it('keeps Native policies Validations when the detail panel narrows the table', () => {
    // The panel leaves a ~645px container: under `mid`'s 700px every priority-2 and -3 column sheds.
    const v = block('pages/cluster-tabs/opa/OpaNativePolicies.tsx', 'validations');
    expect(v).not.toMatch(/priority: [23]/);
  });
});
