/**
 * Theme selection: the stored preference, the resolved theme, and the one place that writes it
 * to the document.
 *
 * ## Three values, not two
 *
 * The stored preference is `'system' | 'dark' | 'light'`, and it is deliberately not a boolean.
 * An operator who has never touched the toggle should get whatever their OS is set to — a
 * console opened on a machine in light mode should not be the one dark rectangle on the screen.
 * But an operator who *has* chosen dark must keep dark when their OS flips at sunset, and a
 * boolean cannot tell "I chose dark" apart from "dark is what the system happened to be when I
 * first loaded". So the preference records the choice and `resolve()` turns it into a theme.
 *
 * ## Why the class is written outside React
 *
 * `applyTheme` is called once from `main.tsx` before `createRoot`, and again from the toggle.
 * Doing it in an effect instead would paint one frame of the wrong theme on every load — the
 * flash is brief but it is the first thing the operator sees, and on a dark-to-light switch it
 * is a full-screen white flash. `index.html` ships `class="dark"` so that the very first paint,
 * before any JavaScript at all, is the theme this console is most often used in; `applyTheme`
 * then corrects it in the same task, before layout.
 *
 * The document class is the *only* output. Nothing reads `theme` to pick a colour — every colour
 * in the product comes from a token, and `html.light` in theme.css re-binds those tokens. That
 * is what keeps a theme from becoming a second set of component styles to maintain.
 */

export type ThemePref = 'system' | 'dark' | 'light';
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'kyma-fleet:theme';

/** Every value the preference is allowed to take, so a hand-edited localStorage cannot break boot. */
const PREFS: readonly ThemePref[] = ['system', 'dark', 'light'];

function isPref(v: unknown): v is ThemePref {
  return typeof v === 'string' && (PREFS as readonly string[]).includes(v);
}

/**
 * The stored preference.
 *
 * Wrapped, because `localStorage` is not merely empty in a private window or under a strict
 * storage policy — reading it *throws*. An unreadable preference is not an error worth
 * surfacing: it means "no preference", which is exactly `'system'`.
 */
export function readPref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isPref(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // A refused write means the choice does not survive a reload. The toggle still works for
    // this session, which is better than refusing to switch at all.
  }
}

/** What the OS asks for. Defaults to dark when the query is unsupported — this console's origin. */
export function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function resolve(pref: ThemePref): Theme {
  return pref === 'system' ? systemTheme() : pref;
}

/**
 * Write the resolved theme to `<html>`.
 *
 * Both classes are managed explicitly rather than toggling one: `html.dark` carries
 * `color-scheme: dark`, so leaving both off would hand form controls and the scrollbar back to
 * the browser's own guess while every token still said dark.
 */
export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  el.classList.toggle('light', theme === 'light');
  el.classList.toggle('dark', theme === 'dark');
  el.setAttribute('data-theme', theme);
}

/**
 * Apply the stored preference. Called from `main.tsx` before the first render.
 *
 * Returns the theme it applied so a caller can seed state without re-deriving it.
 */
export function initTheme(): { pref: ThemePref; theme: Theme } {
  const pref = readPref();
  const theme = resolve(pref);
  applyTheme(theme);
  return { pref, theme };
}

/**
 * Follow the OS while the preference is `'system'`.
 *
 * Returns an unsubscribe. `addEventListener('change')` rather than the deprecated
 * `addListener`, guarded because the older form is still what some embedded WebViews expose.
 */
export function watchSystem(onChange: (theme: Theme) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: light)');
  const handler = () => onChange(mq.matches ? 'light' : 'dark');
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  return () => {};
}

/**
 * The toggle's order: what pressing it next should select.
 *
 * Two positions, not three. Cycling through `system` in the middle of a two-state control is a
 * press that appears to do nothing whenever the system already matches — the operator presses
 * again, lands back where they started, and concludes the button is broken. `system` remains
 * reachable as the *default* (it is what an untouched console uses) and is never a stop on the
 * cycle. Pressing the toggle is always an explicit choice, which is the thing worth recording.
 */
export function nextTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}
