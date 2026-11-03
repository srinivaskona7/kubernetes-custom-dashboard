/**
 * The drawer's height bounds.
 *
 * Both failure modes these functions exist to prevent are unclosable-drawer bugs, and neither shows
 * up in a screenshot at one window size: dragged past the top the header (and its close button) goes
 * off-screen, dragged past the bottom there is nothing left to grab. So the bounds are asserted
 * here, at both ends, including on a viewport too short for the two rules to agree.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAWER_FRACTION,
  MAX_DRAWER_FRACTION,
  MIN_DRAWER_PX,
  clampDrawerPx,
  defaultDrawerPx,
  drawerPxFromPointer,
  maxDrawerPx,
  nudgeDrawerPx
} from './drawer-size';

const VP = 900;

describe('maxDrawerPx', () => {
  it('is the configured fraction of an ordinary viewport', () => {
    expect(maxDrawerPx(VP)).toBe(Math.round(VP * MAX_DRAWER_FRACTION));
    expect(maxDrawerPx(VP)).toBeLessThan(VP);
  });

  it('never drops below the floor, so the upper bound cannot invert the lower one', () => {
    // 85% of 200px is 170px — under the 180px floor. An inverted pair makes every clamp nonsense.
    expect(maxDrawerPx(200)).toBe(MIN_DRAWER_PX);
    expect(maxDrawerPx(0)).toBe(MIN_DRAWER_PX);
    expect(maxDrawerPx(maxDrawerPx(200))).toBeGreaterThanOrEqual(MIN_DRAWER_PX);
  });
});

describe('defaultDrawerPx', () => {
  it('opens at half the window — a panel, not a page', () => {
    expect(defaultDrawerPx(VP)).toBe(Math.round(VP * DEFAULT_DRAWER_FRACTION));
  });

  it('leaves the page visible above it', () => {
    expect(defaultDrawerPx(VP)).toBeLessThan(maxDrawerPx(VP));
  });

  it('is still at least the floor on a short window', () => {
    expect(defaultDrawerPx(200)).toBe(MIN_DRAWER_PX);
  });
});

describe('clampDrawerPx', () => {
  it('passes an in-range height through unchanged', () => {
    expect(clampDrawerPx(400, VP)).toBe(400);
  });

  it('clamps a drag past the top to the maximum, keeping the header on screen', () => {
    expect(clampDrawerPx(VP + 500, VP)).toBe(maxDrawerPx(VP));
    expect(clampDrawerPx(VP, VP)).toBeLessThan(VP);
  });

  it('clamps a drag past the bottom to the floor, keeping the handle grabbable', () => {
    expect(clampDrawerPx(0, VP)).toBe(MIN_DRAWER_PX);
    expect(clampDrawerPx(-4000, VP)).toBe(MIN_DRAWER_PX);
  });

  it('rounds to whole pixels', () => {
    expect(clampDrawerPx(400.4, VP)).toBe(400);
    expect(clampDrawerPx(400.6, VP)).toBe(401);
  });

  it('falls back to the default for a non-finite height, and clamps that too', () => {
    expect(clampDrawerPx(NaN, VP)).toBe(defaultDrawerPx(VP));
    expect(clampDrawerPx(Infinity, VP)).toBe(defaultDrawerPx(VP));
    // The regression this covers: the fallback used to skip the floor, so a 200px window produced
    // a 100px drawer — shorter than its own header.
    expect(clampDrawerPx(NaN, 200)).toBe(MIN_DRAWER_PX);
  });

  it('is idempotent, which is what makes re-clamping on window resize safe', () => {
    for (const px of [-100, 0, 180, 400, 5000, NaN]) {
      const once = clampDrawerPx(px, VP);
      expect(clampDrawerPx(once, VP)).toBe(once);
    }
  });

  it('re-clamps a stored height down when the window shrinks', () => {
    const tall = clampDrawerPx(700, 900);
    expect(tall).toBe(700);
    expect(clampDrawerPx(tall, 400)).toBe(maxDrawerPx(400));
  });

  it('always returns a height inside both bounds', () => {
    for (const vp of [0, 200, 400, 900, 2160]) {
      for (const px of [-1000, 0, 1, 200, vp, vp * 3, NaN]) {
        const h = clampDrawerPx(px, vp);
        expect(h).toBeGreaterThanOrEqual(MIN_DRAWER_PX);
        expect(h).toBeLessThanOrEqual(maxDrawerPx(vp));
      }
    }
  });
});

describe('drawerPxFromPointer', () => {
  it('makes the drawer top follow the pointer, because the handle is the top edge', () => {
    expect(drawerPxFromPointer(500, VP)).toBe(400);
    expect(drawerPxFromPointer(300, VP)).toBe(600);
  });

  it('is absolute, not a delta — the same pointer position always gives the same height', () => {
    expect(drawerPxFromPointer(500, VP)).toBe(drawerPxFromPointer(500, VP));
  });

  it('clamps a pointer dragged above the window and below it', () => {
    expect(drawerPxFromPointer(-200, VP)).toBe(maxDrawerPx(VP));
    expect(drawerPxFromPointer(VP + 200, VP)).toBe(MIN_DRAWER_PX);
  });
});

describe('nudgeDrawerPx', () => {
  it('steps up and down by the given amount', () => {
    expect(nudgeDrawerPx(400, 40, VP)).toBe(440);
    expect(nudgeDrawerPx(400, -40, VP)).toBe(360);
  });

  it('stops at the bounds rather than running past them', () => {
    expect(nudgeDrawerPx(MIN_DRAWER_PX, -40, VP)).toBe(MIN_DRAWER_PX);
    expect(nudgeDrawerPx(maxDrawerPx(VP), 40, VP)).toBe(maxDrawerPx(VP));
  });

  it('reaches the same bounds a drag does, so keyboard and pointer agree', () => {
    let h = defaultDrawerPx(VP);
    for (let i = 0; i < 100; i += 1) h = nudgeDrawerPx(h, 40, VP);
    expect(h).toBe(drawerPxFromPointer(-1000, VP));
    for (let i = 0; i < 100; i += 1) h = nudgeDrawerPx(h, -40, VP);
    expect(h).toBe(drawerPxFromPointer(VP + 1000, VP));
  });
});
