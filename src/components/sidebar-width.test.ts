/**
 * The sidebar width model — §17.1's sidebar cases.
 *
 * These run under the repo's DOM-free vitest (jsdom is blocked by npm E401 on this workstation),
 * which is exactly why the arithmetic was lifted out of `layout.tsx` into `sidebar-width.ts`.
 * They cover what a component test would otherwise have had to: clamping, the snap band, what a
 * held arrow key does, what a corrupt stored value becomes, and restoring the previous width.
 *
 * Each assertion names the wrong answer it exists to catch, so the guard is proven against a bad
 * input before it is trusted on a good one.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_LABELLED,
  RAIL_WIDTH,
  SIDEBAR_EXPANDED_KEY,
  SIDEBAR_WIDTH_KEY,
  clampWidth,
  nextWidthForKey,
  readExpandedWidth,
  readStoredWidth,
  seedExpandedWidth,
  stateForWidth,
  widthForDrag,
  type WidthStore
} from './sidebar-width';

/** A storage double. `throws` reproduces private-mode Safari, which raises rather than returning null. */
function store(entries: Record<string, string> = {}, throws = false): WidthStore {
  return {
    getItem(key) {
      if (throws) throw new Error('SecurityError: access denied');
      return key in entries ? entries[key]! : null;
    },
    setItem(key, value) {
      if (throws) throw new Error('SecurityError: access denied');
      entries[key] = value;
    }
  };
}

describe('clampWidth', () => {
  it('clamps to the min and max of the labelled range', () => {
    expect(clampWidth(MAX_WIDTH + 500)).toBe(MAX_WIDTH);
    expect(clampWidth(MIN_LABELLED - 1)).toBe(MIN_LABELLED);
    expect(clampWidth(300)).toBe(300);
  });

  it('snaps to the icon rail below the snap band, rather than rendering clipped labels', () => {
    // 112 is the top of the band. Anything at or under it is the rail — the wrong answer here
    // would be 148, which renders a labelled sidebar the operator was dragging away from.
    expect(clampWidth(112)).toBe(RAIL_WIDTH);
    expect(clampWidth(80)).toBe(RAIL_WIDTH);
    expect(clampWidth(0)).toBe(RAIL_WIDTH);
    expect(clampWidth(-400)).toBe(RAIL_WIDTH);
    // Just above the band must NOT snap.
    expect(clampWidth(113)).toBe(MIN_LABELLED);
  });

  it('falls back to the default for a non-finite value, never to zero', () => {
    // A zero-width sidebar is indistinguishable from a broken app, and there is no control left
    // to drag it back out with.
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_WIDTH);
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WIDTH);
    expect(clampWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_WIDTH);
  });
});

describe('widthForDrag', () => {
  it('tracks the pointer delta from the grab point', () => {
    expect(widthForDrag(240, 60)).toBe(300);
    expect(widthForDrag(240, -60)).toBe(180);
  });

  it('drag-left past the snap band lands on the icon rail', () => {
    expect(widthForDrag(240, -140)).toBe(RAIL_WIDTH);
  });

  it('a fast drag far past either end stays inside the range', () => {
    // Pointer capture keeps move events coming after the cursor leaves the window, so these
    // deltas are real, not hypothetical.
    expect(widthForDrag(240, 5000)).toBe(MAX_WIDTH);
    expect(widthForDrag(240, -5000)).toBe(RAIL_WIDTH);
  });
});

describe('readStoredWidth', () => {
  it('returns the default when nothing is stored', () => {
    expect(readStoredWidth(store())).toBe(DEFAULT_WIDTH);
  });

  it('rejects and clamps a corrupt persisted value', () => {
    // Each of these has been a real shape at some point: an older build wrote "240px", a bad
    // write produced "9999", and an empty string is what a cleared key looks like.
    expect(readStoredWidth(store({ [SIDEBAR_WIDTH_KEY]: '9999' }))).toBe(MAX_WIDTH);
    expect(readStoredWidth(store({ [SIDEBAR_WIDTH_KEY]: '-50' }))).toBe(RAIL_WIDTH);
    expect(readStoredWidth(store({ [SIDEBAR_WIDTH_KEY]: 'banana' }))).toBe(DEFAULT_WIDTH);
    expect(readStoredWidth(store({ [SIDEBAR_WIDTH_KEY]: '' }))).toBe(DEFAULT_WIDTH);
    // "240px" parses to 240 via parseFloat, which is the forgiving behaviour we want.
    expect(readStoredWidth(store({ [SIDEBAR_WIDTH_KEY]: '240px' }))).toBe(240);
  });

  it('survives storage that throws instead of returning null', () => {
    expect(readStoredWidth(store({}, true))).toBe(DEFAULT_WIDTH);
    expect(readStoredWidth(null)).toBe(DEFAULT_WIDTH);
  });
});

describe('readExpandedWidth', () => {
  it('never returns the rail width, so expanding cannot land back on the rail', () => {
    // A stored value inside the snap band clamps to RAIL_WIDTH; returning that would make the
    // expand control look dead. The wrong answer here is 60.
    expect(readExpandedWidth(store({ [SIDEBAR_EXPANDED_KEY]: '70' }))).toBe(DEFAULT_WIDTH);
    expect(readExpandedWidth(store({ [SIDEBAR_EXPANDED_KEY]: '0' }))).toBe(DEFAULT_WIDTH);
  });

  it('returns a valid remembered width', () => {
    expect(readExpandedWidth(store({ [SIDEBAR_EXPANDED_KEY]: '336' }))).toBe(336);
  });
});

describe('seedExpandedWidth', () => {
  it('prefers the live width when the sidebar is already showing labels', () => {
    // An operator sitting at 320px across a reload must not lose it to the default on their
    // first collapse.
    expect(seedExpandedWidth(store({ [SIDEBAR_WIDTH_KEY]: '320', [SIDEBAR_EXPANDED_KEY]: '260' }))).toBe(320);
  });

  it('falls back to the remembered width when the live one is the rail', () => {
    expect(seedExpandedWidth(store({ [SIDEBAR_WIDTH_KEY]: '60', [SIDEBAR_EXPANDED_KEY]: '336' }))).toBe(336);
  });

  it('falls back to the default when neither is usable', () => {
    expect(seedExpandedWidth(store({ [SIDEBAR_WIDTH_KEY]: '60' }))).toBe(DEFAULT_WIDTH);
  });
});

describe('nextWidthForKey', () => {
  it('ignores keys that are not its own, so they keep their default behaviour', () => {
    expect(nextWidthForKey('Enter', false, 240)).toBeNull();
    expect(nextWidthForKey('Tab', false, 240)).toBeNull();
    expect(nextWidthForKey('a', false, 240)).toBeNull();
  });

  it('steps 8px, and 24px with shift', () => {
    expect(nextWidthForKey('ArrowRight', false, 240)!(240)).toBe(248);
    expect(nextWidthForKey('ArrowLeft', false, 240)!(240)).toBe(232);
    expect(nextWidthForKey('ArrowRight', true, 240)!(240)).toBe(264);
    expect(nextWidthForKey('ArrowLeft', true, 240)!(240)).toBe(216);
  });

  it('returns an updater, so a held-key burst accumulates instead of collapsing to one step', () => {
    // The bug this exists for: keydown fires faster than React commits, so a handler that reads
    // a captured `width` has all 20 presses start from the same value. Measured before the fix —
    // 20 x Shift+ArrowRight from 232 landed on 256 instead of the 400 cap.
    let w = 232;
    for (let i = 0; i < 20; i++) w = clampWidth(nextWidthForKey('ArrowRight', true, 240)!(w));
    expect(w).toBe(MAX_WIDTH);
    expect(w).not.toBe(256);
  });

  it('Home collapses to the icon rail', () => {
    expect(nextWidthForKey('Home', false, 336)!(336)).toBe(RAIL_WIDTH);
  });

  it('End restores the shipped default, not the remembered width', () => {
    // Deliberate asymmetry with the expand control: End is the "put it back how it came" key,
    // and it is the only way out of a remembered width the operator regrets.
    expect(nextWidthForKey('End', false, 336)!(60)).toBe(DEFAULT_WIDTH);
  });

  it('ArrowRight out of the rail restores the previous expanded width', () => {
    // A +8px step out of 60 would land on 68, inside the snap band, and clamp straight back to
    // the rail — the control would look broken.
    expect(clampWidth(nextWidthForKey('ArrowRight', false, 336)!(RAIL_WIDTH))).toBe(336);
    expect(clampWidth(nextWidthForKey('ArrowRight', false, 336)!(RAIL_WIDTH))).not.toBe(RAIL_WIDTH);
  });
});

describe('stateForWidth', () => {
  it('names the three states at their boundaries', () => {
    expect(stateForWidth(RAIL_WIDTH)).toBe('rail');
    expect(stateForWidth(MIN_LABELLED)).toBe('compact');
    expect(stateForWidth(199)).toBe('compact');
    expect(stateForWidth(200)).toBe('expanded');
    expect(stateForWidth(DEFAULT_WIDTH)).toBe('expanded');
  });
});
