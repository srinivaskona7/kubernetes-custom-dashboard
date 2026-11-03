/**
 * The floor under an identity column, and why it is not simply a constant.
 *
 * An identity column — the pod name, the node, the release — needs a minimum width or a neighbour
 * with a long value crushes it to a few characters. But the floor was first applied unconditionally
 * to every table's first column, and that broke a table that had been measured and tuned: Traffic's
 * `Code` column is a three-digit status pill declared at `78px`, the floor made it `120px`, and the
 * extra 42px pushed the eight-column row 41px past its container at a 1280px window. A default that
 * silently overrides an explicit declaration is not a default.
 *
 * So the floor is clamped by whatever the column already declares. A column that states a narrow
 * width means it, and a column that states a ceiling can never be given a floor above it — a
 * `minWidth` greater than `maxWidth` is a contradiction the browser resolves by ignoring the max,
 * which is precisely the overflow the ceiling existed to prevent.
 */

/** How wide an identity column should be allowed to get, when nothing narrower is declared. */
export const MIN_IDENTITY_PX = 120;

/**
 * A CSS length in px as a number, or null for anything else.
 *
 * Deliberately only `px`. A `%`, `ch` or `rem` cannot be compared against a px floor without a
 * layout, and guessing at a conversion would be worse than declining: null means "no opinion", and
 * the caller falls back to the plain floor.
 */
export function pxOf(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The floor for an identity column that declares `width` and/or `max`.
 *
 * Never above either declaration. Returns null when there is nothing to apply, so the caller can
 * leave `minWidth` off the style object entirely rather than writing `120px` everywhere.
 */
export function identityFloorPx(width?: string, max?: string): number {
  return Math.min(MIN_IDENTITY_PX, pxOf(width) ?? Infinity, pxOf(max) ?? Infinity);
}
