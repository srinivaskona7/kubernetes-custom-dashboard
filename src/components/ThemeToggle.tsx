/**
 * The theme toggle, and the favicon that follows it.
 *
 * ## The control
 *
 * One small icon button, in the sidebar's footer beside the signed-in user — the only chrome
 * that is mounted on every route. It is a real `<button>` with `aria-pressed`, and its accessible
 * name says what pressing it will *do* ("Switch to light theme"), not what the current state is:
 * a button named "Dark theme" is ambiguous about whether it reports or sets.
 *
 * The icon shows the *destination* too — a sun when pressing it gives you light, a moon when
 * pressing it gives you dark. Showing the current state instead is the more common choice and
 * it is the wrong one for a two-position control, because there is nothing on screen to compare
 * it against; the operator can already see which theme they are in by looking at the page.
 *
 * ## Why the favicon lives here
 *
 * A favicon is one of the few pieces of visual design that has to work on a background this
 * application does not control — a browser tab strip, which is light on one OS and dark on
 * another, and which shifts when the OS theme changes. So the mark is drawn as an inline SVG
 * data URI whose colours come from the resolved theme, and it is re-written whenever the theme
 * changes. That keeps it legible in both tab strips, and it means there is no binary asset in
 * the repo to fall out of step with the palette.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  applyTheme,
  nextTheme,
  readPref,
  resolve,
  watchSystem,
  writePref,
  type Theme
} from '../theme';

// ------------------------------------------------------------------- the mark

/**
 * The console's mark: three nodes in a triangle, joined by violet links.
 *
 * A fleet is several clusters seen as one thing, and that is what the shape says — three equal
 * nodes, none of them the "main" one, held together by the accent. The accent is the one colour
 * this product treats as identity rather than status, so it draws the links and never a node.
 *
 * Drawn at 32px for a 16px raster, which sets every number here: three 9px nodes and three 3.5px
 * links are seven marks, and seven is about the ceiling before a favicon becomes a smudge. The
 * links are drawn first so the nodes cover their ends — a link that overshot a node would read as
 * a stray pixel at 16px, and rounded caps alone do not hide it.
 *
 * (It replaced a three-bars-and-a-ring mark, which read as a hamburger menu rather than a fleet.)
 *
 * `--color-accent` is not read from CSS here: a favicon is serialised into an `href`, so it
 * cannot reference custom properties. The violet is the accent's literal value and is the one
 * duplicate of it in the codebase; it is annotated in theme.css so a palette change finds it.
 */
const ACCENT = '#6d5bd0';

function faviconSvg(theme: Theme): string {
  // The nodes need contrast against the tab strip, which is the opposite of the page: a light
  // theme means a light tab strip, so the nodes go dark.
  const node = theme === 'light' ? '#1c2128' : '#e6edf3';
  const link = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ACCENT}" stroke-width="3.5" stroke-linecap="round"/>`;
  const dot = (x: number, y: number) => `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" rx="2.5" fill="${node}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`,
    `<rect width="32" height="32" rx="7" fill="none"/>`,
    link(16, 7, 7, 25),
    link(16, 7, 25, 25),
    link(7, 25, 25, 25),
    dot(16, 7),
    dot(7, 25),
    dot(25, 25),
    `</svg>`
  ].join('');
}

/**
 * Point the document's icon at a freshly drawn mark.
 *
 * Creates the `<link>` if `index.html` did not ship one, so this is the single definition of the
 * favicon rather than a runtime override of a static file that would also have to be maintained.
 */
function applyFavicon(theme: Theme): void {
  const href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(theme))}`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = href;
}

// ----------------------------------------------------------------- the button

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.5" />
      {/* Eight rays, as two crossed pairs plus the diagonals — enough to read as a sun at 15px
          without becoming a starburst. */}
      {[
        [8, 0.8, 8, 2.4],
        [8, 13.6, 8, 15.2],
        [0.8, 8, 2.4, 8],
        [13.6, 8, 15.2, 8],
        [3.1, 3.1, 4.2, 4.2],
        [11.8, 11.8, 12.9, 12.9],
        [3.1, 12.9, 4.2, 11.8],
        [11.8, 4.2, 12.9, 3.1]
      ].map(([x1, y1, x2, y2]) => (
        <line
          key={`${x1}-${y1}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <path
        d="M13.2 9.9A5.7 5.7 0 0 1 6.1 2.8a5.9 5.9 0 1 0 7.1 7.1Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Owns the resolved theme for the session.
 *
 * `readPref()` rather than a hardcoded default, so the button's first render already agrees with
 * what `initTheme()` wrote to `<html>` before React mounted. If those two disagreed the operator
 * would see a sun icon on a light page — a control that lies about what it will do.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => resolve(readPref()));

  // The favicon is a side effect of the theme, not of the click: it also has to be drawn on
  // first mount, and re-drawn when the OS flips underneath a `'system'` preference.
  useEffect(() => {
    applyFavicon(theme);
  }, [theme]);

  // Follow the OS only while no explicit choice is stored. Re-reading the preference inside the
  // handler rather than capturing it keeps this correct after a click without re-subscribing.
  useEffect(
    () =>
      watchSystem(next => {
        if (readPref() !== 'system') return;
        setTheme(next);
        applyTheme(next);
      }),
    []
  );

  const toggle = useCallback(() => {
    setTheme(current => {
      const next = nextTheme(current);
      applyTheme(next);
      writePref(next);
      return next;
    });
  }, []);

  const goingTo = nextTheme(theme);
  const label = `Switch to ${goingTo} theme`;

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      // Reports the state; the name reports the action. Both are needed: `aria-pressed` alone
      // on a button named "Switch to light theme" would announce "Switch to light theme,
      // pressed", which is why the name never mentions the current theme.
      aria-pressed={theme === 'light'}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-line text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      {goingTo === 'light' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
