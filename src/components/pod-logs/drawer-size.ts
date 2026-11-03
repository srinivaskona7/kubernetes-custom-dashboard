/**
 * How tall the bottom log drawer is, and the bounds a drag cannot leave.
 *
 * Pure, because the two failure modes are arithmetic and neither is visible in a screenshot taken
 * at one window size:
 *
 * - **Dragged past the top.** A drawer taller than the viewport pushes its own header off-screen,
 *   and the header holds the close button. The drawer becomes unclosable except by Escape.
 * - **Dragged past the bottom.** Collapsing to 0 leaves a 1px line with no affordance to grow it
 *   back; the operator's only recovery is to close and reopen, losing the pod selection.
 *
 * Both are clamped here rather than in the drag handler so that a window *resize* is subject to the
 * same rule — the stored height has to be re-clamped against the new viewport, which is the case a
 * handler-only clamp always misses.
 */

/** Never shorter than this: header plus controls plus about four log lines. */
export const MIN_DRAWER_PX = 180;

/**
 * Never taller than this fraction of the viewport, so the page that opened the drawer keeps a
 * usable strip. §"do not navigate away" is not satisfied by a drawer that covers everything.
 */
export const MAX_DRAWER_FRACTION = 0.85;

/** What it opens at. Half the window reads as "a panel", not as "a new page". */
export const DEFAULT_DRAWER_FRACTION = 0.5;

export function maxDrawerPx(viewportPx: number): number {
  // `Math.max` with the minimum, not just the fraction: on a 200px-tall window 85% is 170px, which
  // is below the floor, and an upper bound below the lower bound makes `clamp` return nonsense.
  return Math.max(MIN_DRAWER_PX, Math.round(viewportPx * MAX_DRAWER_FRACTION));
}

export function defaultDrawerPx(viewportPx: number): number {
  return clampDrawerPx(Math.round(viewportPx * DEFAULT_DRAWER_FRACTION), viewportPx);
}

/**
 * The one place a drawer height is decided.
 *
 * A non-finite input falls back to the default *and is then clamped like any other value*. The
 * earlier form returned the raw half-viewport for that branch, which on a 200px-tall window is
 * 100px — under the 180px floor the same function enforces one line below, and short enough to clip
 * the drawer's own header. One exit, one pair of bounds.
 */
export function clampDrawerPx(px: number, viewportPx: number): number {
  const target = Number.isFinite(px) ? Math.round(px) : Math.round(viewportPx * DEFAULT_DRAWER_FRACTION);
  return Math.min(maxDrawerPx(viewportPx), Math.max(MIN_DRAWER_PX, target));
}

/**
 * The height a drag to `pointerY` asks for.
 *
 * The handle is the drawer's top edge, so the drawer's height is the distance from the pointer to
 * the bottom of the window. Expressed as a function of the pointer rather than of a delta because a
 * delta accumulates rounding across a drag and drifts away from the cursor.
 */
export function drawerPxFromPointer(pointerY: number, viewportPx: number): number {
  return clampDrawerPx(viewportPx - pointerY, viewportPx);
}

/** Keyboard resize: ±`step` px per press, clamped. Arrow-key parity with the drag handle. */
export function nudgeDrawerPx(current: number, step: number, viewportPx: number): number {
  return clampDrawerPx(current + step, viewportPx);
}
