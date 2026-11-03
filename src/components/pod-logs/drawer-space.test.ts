/**
 * The page has to be able to scroll past the log drawer.
 *
 * This guards a bug that a screenshot does not show and a green test suite did not catch. The drawer
 * is `position: fixed` over the bottom of the content column, which is what keeps the page it opened
 * over intact — and it is also what silently amputated that page: the scroll container still ended
 * where it always did, so a 498px drawer covered the last 498px of content with no way to bring it
 * into view. Measured on the Nodes tab, the final rows of the Scheduled pods table were unreachable
 * while the drawer was open.
 *
 * The fix is two halves that only work together, in two different files — exactly the shape that rots
 * when someone tidies one of them:
 *
 * 1. `PodLogsDrawer` publishes its live height as `--pod-logs-h` on `:root` and sets
 *    `data-pod-logs='open'`, cleaning both up when it unmounts.
 * 2. `theme.css` turns that into `padding-bottom` on the page's scroll container.
 *
 * Source scanning, because this project's vitest has no DOM (jsdom is unavailable from the registry)
 * and the relationship being protected is between a component and a stylesheet rather than inside
 * either one. Both halves were canaried: deleting the CSS rule, and dropping the cleanup, each fail
 * a test here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = new URL('.', import.meta.url).pathname;
const drawer = readFileSync(join(here, 'PodLogsDrawer.tsx'), 'utf8');
const theme = readFileSync(join(here, '../../theme.css'), 'utf8');

/** The rule that reserves the space, with its comment stripped so a mention is not a match. */
function spaceRule(): string | null {
  const m = theme.match(/:root\[data-pod-logs=['"]open['"]\][^{]*\{[^}]*\}/);
  return m ? m[0] : null;
}

describe('the drawer publishes its height', () => {
  it('sets the attribute that scopes the stylesheet rule', () => {
    expect(drawer).toMatch(/dataset\.podLogs\s*=\s*['"]open['"]/);
  });

  it('publishes the live height, not a constant', () => {
    // `${height}px` and not a literal: the drawer is resizable from its top edge, and reserved space
    // that does not track the drag is wrong in one direction or the other from the first pointermove.
    expect(drawer).toMatch(/setProperty\(\s*['"]--pod-logs-h['"]\s*,\s*`\$\{height\}px`\s*\)/);
  });

  it('re-publishes when the height changes', () => {
    // The effect must depend on `height`. A `[]` dependency list would publish the opening height
    // once and then lie for the rest of the session.
    const effect = drawer.slice(drawer.indexOf('dataset.podLogs'));
    const deps = effect.match(/\}\s*,\s*\[([^\]]*)\]\s*\)/);
    expect(deps?.[1]).toContain('height');
  });

  it('removes both the attribute and the property when it closes', () => {
    // Left behind, they reserve a screenful of empty space at the bottom of every page for the rest
    // of the session — a bug that looks like a layout mistake rather than a missing cleanup.
    const cleanup = drawer.slice(drawer.indexOf('dataset.podLogs'));
    expect(cleanup).toMatch(/delete\s+root\.dataset\.podLogs/);
    expect(cleanup).toMatch(/removeProperty\(\s*['"]--pod-logs-h['"]\s*\)/);
  });
});

describe('the stylesheet reserves the space', () => {
  it('has a rule scoped to the open drawer', () => {
    expect(spaceRule()).not.toBeNull();
  });

  it('pads the page scroll container by the drawer height', () => {
    const rule = spaceRule() ?? '';
    expect(rule).toMatch(/padding-bottom:\s*var\(--pod-logs-h/);
  });

  it('falls back to zero, so a stale attribute cannot pad by an invalid length', () => {
    expect(spaceRule() ?? '').toMatch(/var\(--pod-logs-h,\s*0px\)/);
  });

  it('targets the page inside main rather than the shell or the body', () => {
    // `main > *` is the page's own scroll container on every route. Padding the shell or the body
    // would not add scrollable overflow to the element that actually scrolls.
    expect(spaceRule() ?? '').toMatch(/main\s*>\s*\*/);
  });

  it('does not pad the drawer itself', () => {
    expect(spaceRule() ?? '').not.toMatch(/pod-logs-drawer/);
  });
});
