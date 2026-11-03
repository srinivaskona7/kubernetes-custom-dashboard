/**
 * The sidebar's width model, separated from the component that renders it.
 *
 * Its own module for one reason: `app/fleet-ui` runs vitest with no DOM environment (jsdom is
 * blocked by npm E401 on this workstation), so anything that has to be proven — clamping, the
 * snap band, what a held arrow key does, what a corrupt localStorage value becomes — has to be
 * reachable without mounting a component. Storage is injected rather than imported for the same
 * reason, and because private-mode Safari throws on `localStorage` access rather than returning
 * null, which a test should be able to reproduce.
 *
 * The React state, the pointer capture and the ARIA wiring stay in `layout.tsx`. Only the
 * arithmetic lives here.
 */

export const RAIL_WIDTH = 60;
/** Measured: "Autoscaling & Jobs" at 13px needs 132px of text box inside 16px of padding. */
export const MIN_LABELLED = 148;
/** Below this the labels still fit but the expanded padding does not. */
export const COMPACT_BELOW = 200;
export const MAX_WIDTH = 400;
/** Must match `--sidebar-w` in theme.css — that value is what the first paint uses. */
export const DEFAULT_WIDTH = 240;
/**
 * The gap between the rail and the narrowest labelled width. Drag into it and the sidebar lands
 * on the rail rather than rendering 120px of clipped labels, so there is no width at which a nav
 * item is present but unreadable.
 */
export const SNAP_TO_RAIL = 112;

export const SIDEBAR_WIDTH_KEY = 'k8s-fleet.sidebar.width';
/**
 * The last width the sidebar had while still showing labels. A second key rather than a derived
 * value: once the operator collapses to the rail, the live width is 60 and the 320px they chose
 * is gone.
 */
export const SIDEBAR_EXPANDED_KEY = 'k8s-fleet.sidebar.expandedWidth';

/** The slice of the Storage API this module uses. Injected so tests need no DOM. */
export interface WidthStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Every width that reaches the DOM goes through here, including the one read back from storage:
 * a stored `"9999"`, or a `"240px"` written by an older build, must not become a sidebar that
 * eats the page. Anything unparseable falls back to the default rather than to 0 — a zero-width
 * sidebar is indistinguishable from a broken app and there is no control left to drag it back
 * out with.
 */
export function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  if (n <= SNAP_TO_RAIL) return RAIL_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_LABELLED, n));
}

export function readStoredWidth(store: WidthStore | null): number {
  try {
    const raw = store?.getItem(SIDEBAR_WIDTH_KEY) ?? null;
    if (raw === null) return DEFAULT_WIDTH;
    return clampWidth(Number.parseFloat(raw));
  } catch {
    // Private-mode Safari throws on access rather than returning null.
    return DEFAULT_WIDTH;
  }
}

/**
 * The width to come back to from the rail. Clamped like every other stored number, then floored
 * at `MIN_LABELLED`: a stored value inside the snap band would clamp to `RAIL_WIDTH`, and
 * expanding would land back on the rail, which reads as a dead control.
 */
export function readExpandedWidth(store: WidthStore | null): number {
  try {
    const raw = store?.getItem(SIDEBAR_EXPANDED_KEY) ?? null;
    if (raw === null) return DEFAULT_WIDTH;
    const w = clampWidth(Number.parseFloat(raw));
    return w <= RAIL_WIDTH ? DEFAULT_WIDTH : w;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** The seed for "restore the last usable expanded width": prefer a live labelled width. */
export function seedExpandedWidth(store: WidthStore | null): number {
  const live = readStoredWidth(store);
  return live > RAIL_WIDTH ? live : readExpandedWidth(store);
}

/**
 * What one keypress on the resize handle does.
 *
 * Returns an updater, not a number, and the relative keys must stay that way: the browser fires
 * keydown faster than React commits, so a handler that computes from a captured `width` has every
 * press in a held burst start from the same pre-burst value. Measured — 20 × Shift+ArrowRight
 * from 232px landed on 256px instead of the 400px cap.
 *
 * `null` means the key is not ours; the handler must not preventDefault on it.
 */
export function nextWidthForKey(
  key: string,
  shiftKey: boolean,
  expandedWidth: number
): ((prev: number) => number) | null {
  // A step and a coarse step, because the useful range is 340px wide and 8px at a time is 42
  // presses from end to end. Home and End are the two states worth reaching in one key.
  const step = shiftKey ? 24 : 8;
  switch (key) {
    case 'ArrowLeft':
      return prev => prev - step;
    case 'ArrowRight':
      // Leaving the rail rightwards restores the width last used with labels on; a +8px step out
      // of 60 would land inside the snap band and bounce straight back.
      return prev => (prev <= RAIL_WIDTH ? expandedWidth : prev + step);
    case 'Home':
      return () => RAIL_WIDTH;
    case 'End':
      // Deliberately the *shipped* default, not the remembered width — this is the "put it back
      // how it came" key, and it is the only way out of a width the operator regrets.
      return () => DEFAULT_WIDTH;
    default:
      return null;
  }
}

/** Where a drag that started at `startWidth` and moved `deltaX` pixels lands. */
export function widthForDrag(startWidth: number, deltaX: number): number {
  return clampWidth(startWidth + deltaX);
}

export type SidebarState = 'rail' | 'compact' | 'expanded';

export function stateForWidth(width: number): SidebarState {
  if (width <= RAIL_WIDTH) return 'rail';
  return width < COMPACT_BELOW ? 'compact' : 'expanded';
}
