/**
 * Clean Dynamic Shell:
 * - Default view: Overview as the primary dashboard + Add Cluster + Target Clusters list.
 * - Selected Cluster view: Dynamic sidebar displaying the cluster details, next renewal countdown, and all cluster sub-options.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode
} from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type PerClusterGroups } from '../api';
import { ago } from '../format';
import { useRosterVersion } from '../roster-signal';
import { useAsync } from '../useAsync';
import { TONE_OF, WORD_OF, phrase, worstOf, type Health } from './health-vocabulary';
import { ClusterSwitcher, type SwitcherEntry } from './ClusterSwitcher';
import { abbreviate } from './cluster-switcher';
import { Dot, InfoTip, type Tone } from './ui';
import { splitHint } from '../pages/cluster-tabs/hint';
import { Icon, type IconName } from './icons';
import { ThemeToggle } from './ThemeToggle';
import {
  COMPACT_BELOW,
  MAX_WIDTH,
  RAIL_WIDTH,
  SIDEBAR_EXPANDED_KEY,
  SIDEBAR_WIDTH_KEY,
  clampWidth,
  nextWidthForKey,
  readStoredWidth,
  seedExpandedWidth,
  widthForDrag,
  type WidthStore
} from './sidebar-width';
import { DEFAULT_TAB, TAB_ABBR, TAB_GROUPS, TAB_IDS, TAB_LABEL, type Tab } from '../pages/cluster-tabs/tabs';
import { tabSwitchParams } from '../pages/cluster-tabs/tab-params';

export { RAIL_WIDTH } from './sidebar-width';

/**
 * The lean fleet-wide nav. Everything that inspects ONE cluster now lives as a tab inside
 * ClusterDetail (`/clusters/:id?tab=...`) — see that file's `TABS` array. What stays here
 * compares ACROSS clusters and has no single-cluster home: the roster itself, token health
 * for every cluster at a glance, and the fleet drift/parity matrix.
 */
const NAV_ITEMS: { to: string; label: string; abbr: string; end?: boolean }[] = [
  { to: '/', label: 'Overview', abbr: 'OV', end: true },
  // "Token Health" is what this page calls itself in its own <h1>. It used to be listed here
  // as "Access & Tokens", which was also the name of a cluster tab going somewhere else
  // entirely — one label, two destinations, and a rail item that disagreed with the heading
  // it led to. The cluster tab is now "Credentials"; this keeps the page's own name.
  { to: '/tokens', label: 'Token Health', abbr: 'TK' },
  { to: '/drift', label: 'Fleet Drift & Parity', abbr: 'DR' },
  { to: '/status', label: 'Status', abbr: 'ST' }
];

/**
 * One tile in the icon rail.
 *
 * The two letters are `aria-hidden` and the accessible name is always the full label: "DR" is
 * not a destination anyone can act on, and a rail of eleven of them with no names is a rail a
 * screen-reader user cannot navigate. `title` gives the sighted operator the same string on hover,
 * which is the only way the rail is usable at all.
 *
 * The active tile carries a 3px bar flush to the sidebar's left border as well as its filled
 * background. Two signals for one state, on purpose: the filled tile is a colour difference, and
 * a rail of eleven identical squares is exactly the place where a colour difference alone is hard
 * to find — the eye lands on the edge marker first because it is the only thing breaking the
 * column's left line. The tile is 32px centred in a 60px rail, so `-left-[14px]` puts the bar on
 * the border rather than floating beside the tile.
 */
function RailTile({
  abbr,
  label,
  active,
  onClick,
  to
}: {
  abbr: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
  to?: string;
}) {
  const className = `relative grid size-8 shrink-0 place-items-center rounded-[6px] text-[11px] font-semibold uppercase tracking-tight transition-colors ${
    active ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-raised hover:text-text'
  }`;
  const body = (
    <>
      {active && <span aria-hidden="true" className="rail-edge" />}
      <span aria-hidden="true">{abbr}</span>
    </>
  );
  return to ? (
    <Link to={to} title={label} aria-label={label} aria-current={active ? 'page' : undefined} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-current={active ? 'true' : undefined} className={className}>
      {body}
    </button>
  );
}

function RailDivider() {
  return <div className="my-1 h-px w-6 shrink-0 bg-line" aria-hidden="true" />;
}

/**
 * The sidebar's width, remembered across reloads.
 *
 * A dense table (68 workloads × 9 columns, 155 secrets) is the reason this exists: 250px of
 * permanent navigation is the difference between reading a pod name and reading `fleet-app-…`.
 * It used to be a boolean — 250px or 52px — and the two numbers were someone else's guess about
 * every operator's screen. A continuous width lets a 1280px laptop trade 90px of nav for a column
 * of the Nodes table without giving up labels entirely, which is the trade the boolean could not
 * express.
 *
 * localStorage rather than a URL param — it is a property of the operator's screen, not of the
 * thing being looked at, so it should not travel in a shared link.
 *
 * Three states, and the middle one is continuous:
 *
 *   Icon rail   RAIL_WIDTH            two-letter tiles, full name in `title` and `aria-label`
 *   Compact     MIN_LABELLED–200px    labels, tighter padding and type
 *   Expanded    200–MAX_WIDTH         labels, full padding
 *
 * `SNAP_TO_RAIL` is the gap between the rail and the narrowest labelled width. Drag into it and
 * the sidebar lands on the rail rather than rendering 120px of clipped labels, and there is no
 * width at which a nav item is present but unreadable.
 *
 * The arithmetic itself — clamping, the snap band, key handling, storage validation — lives in
 * `./sidebar-width`, where it can be tested without a DOM. This file keeps the React state, the
 * pointer capture and the ARIA wiring.
 */

/**
 * Storage access, guarded. Private-mode Safari throws on `localStorage` rather than returning
 * null, and a sidebar that cannot remember its width must still render one.
 */
const widthStore: WidthStore | null = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

export type SidebarWidth = {
  width: number;
  /** Live, un-persisted. Used on every frame of a drag. */
  preview: (next: number) => void;
  /**
   * Persisted. Used at the end of a drag and by every discrete control.
   *
   * Takes an updater as well as a number, and the arrow keys must use the updater form: holding
   * ArrowLeft fires keydown faster than React commits, so every press in the burst read the same
   * `sidebar.width` out of its closure and twenty presses moved the sidebar exactly one step.
   * Measured — 20 × Shift+ArrowRight from 232px landed on 256px instead of the 400px cap.
   */
  commit: (next: number | ((prev: number) => number)) => void;
  /**
   * The width to restore when leaving the rail — the last one the operator actually used with
   * labels on, not a constant. Never `RAIL_WIDTH`.
   */
  expandedWidth: number;
};

export function useSidebarWidth(): SidebarWidth {
  const [width, setWidth] = useState(() => readStoredWidth(widthStore));
  // `useRef(expr)` evaluates `expr` on every render, and the seed touches storage — so it is
  // computed once, lazily, behind a null sentinel.
  const expanded = useRef<number | null>(null);
  if (expanded.current === null) expanded.current = seedExpandedWidth(widthStore);
  const preview = useCallback((next: number) => setWidth(clampWidth(next)), []);
  // Separate from `preview` because a drag produces one of these per animation frame, and
  // `localStorage.setItem` is synchronous: persisting 60 times a second put a measurable stall
  // into the drag on the first build. The commit happens once, on pointerup.
  const commit = useCallback((next: number | ((prev: number) => number)) => {
    setWidth(prev => {
      const w = clampWidth(typeof next === 'function' ? next(prev) : next);
      // Only a labelled width is worth remembering as "expanded"; the rail is a state, not a size.
      if (w > RAIL_WIDTH) expanded.current = w;
      try {
        widthStore?.setItem(SIDEBAR_WIDTH_KEY, String(w));
        if (w > RAIL_WIDTH) widthStore?.setItem(SIDEBAR_EXPANDED_KEY, String(w));
      } catch {
        /* a sidebar that forgets is still a sidebar that works */
      }
      return w;
    });
  }, []);
  return { width, preview, commit, expandedWidth: expanded.current };
}
/**
 * The drag handle, and the keyboard equivalent of dragging it.
 *
 * `role="separator"` with `aria-orientation="vertical"` and the value triple is the one ARIA
 * pattern that describes a resizable pane divider; a focusable separator is expected to be
 * operable with the arrow keys, so it is, and `aria-valuetext` says "icon rail" rather than "60"
 * at the bottom of the range because that is the state, not the number.
 *
 * Pointer capture rather than `document`-level listeners: capture keeps the move events coming
 * after the pointer leaves the 7px handle — which it does immediately — and guarantees the
 * matching `pointerup`, so a drag that ends over an iframe or off the window edge still ends.
 * `pointercancel` is handled too: on a touch device the browser can take the gesture away, and
 * without that branch the sidebar stayed in dragging state with its transition disabled.
 */
function SidebarHandle({ sidebar }: { sidebar: SidebarWidth }) {
  const [dragging, setDragging] = useState(false);
  // The pointer's origin and the width it started from. A delta from the start beats reading
  // `clientX` as an absolute width: the sidebar does not necessarily begin at x=0 (it does today,
  // but a future banner above the shell would break that silently), and the delta form keeps the
  // grab point under the cursor instead of jumping the edge to the pointer on the first move.
  const origin = useRef<{ x: number; width: number } | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef(sidebar.width);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const onPointerDown = (e: RPointerEvent<HTMLButtonElement>) => {
    // Primary button only. A right-click or a two-finger tap on the divider should open the
    // browser's own menu, not start a resize the operator cannot see they are in.
    if (e.button !== 0) return;
    origin.current = { x: e.clientX, width: sidebar.width };
    latest.current = sidebar.width;
    setDragging(true);
    // The shell, not React state, because App would have to re-render to drop the transition and
    // that re-render is the first frame of the drag — the 150ms ease would still eat it. An
    // attribute set here is in effect before the first `pointermove` lands.
    e.currentTarget.closest('.app-shell')?.setAttribute('data-sidebar-dragging', 'true');
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const from = origin.current;
    if (!from) return;
    // Delta from the grab point, clamped by the same function every other width goes through.
    const next = widthForDrag(from.width, e.clientX - from.x);
    latest.current = next;
    // Coalesce to one layout per frame. Chrome delivers pointermove faster than it paints, and
    // every one of these changes a grid track — without the rAF gate the drag reflowed the whole
    // table two or three times per frame for no visible difference.
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      sidebar.preview(latest.current);
    });
  };

  const end = (e: RPointerEvent<HTMLButtonElement>) => {
    if (!origin.current) return;
    origin.current = null;
    setDragging(false);
    e.currentTarget.closest('.app-shell')?.removeAttribute('data-sidebar-dragging');
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    sidebar.commit(latest.current);
  };

  const onKeyDown = (e: RKeyboardEvent<HTMLButtonElement>) => {
    // The key-to-width mapping lives in `sidebar-width` so it can be tested without a DOM. It
    // returns an updater, never a number: the browser fires keydown faster than React commits,
    // so a handler that computes from a captured width loses every press in a held burst.
    const next = nextWidthForKey(e.key, e.shiftKey, sidebar.expandedWidth);
    if (!next) return;
    e.preventDefault();
    sidebar.commit(next);
  };

  const rail = sidebar.width <= RAIL_WIDTH;
  return (
    <button
      type="button"
      className="sidebar-handle"
      data-dragging={dragging ? 'true' : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize navigation. Arrow keys adjust, Home collapses to the icon rail, End restores the default width."
      aria-valuenow={sidebar.width}
      aria-valuemin={RAIL_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuetext={rail ? 'Icon rail' : `${Math.round(sidebar.width)} pixels`}
      // A double-click on a pane divider toggling between collapsed and default is the
      // convention every editor with one shares, and it costs nothing to honour.
      onDoubleClick={() => sidebar.commit(rail ? sidebar.expandedWidth : RAIL_WIDTH)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * A cluster's worst topic, for the rail's dot.
 *
 * The dot used to read `c.ok` from `GET /clusters`, which is one bit: did the cluster answer at
 * all. So a cluster that answered every read and happened to have three crashlooping containers
 * showed the same green dot as a spotless one, and the rail — the thing an operator looks at first
 * — was the least informative surface in the console.
 *
 * This reads `GET /summary`'s `perCluster` breakdown instead, which costs nothing extra: the
 * fan-out already visits every cluster on every sweep, and the response simply stopped throwing
 * the per-cluster dimension away. Worst-topic-wins, and the topic is named in the tooltip so the
 * dot says *what* rather than only *that*.
 *
 * `unknown` is not folded into `bad`: "we could not read this" and "this is broken" send an
 * operator to different places, and the rail is exactly where that distinction is cheapest to
 * keep.
 *
 * The colour, the word and the ordering all come from `health-vocabulary.ts`. They were duplicated
 * here once, and the copy drifted: the two rankings disagreed about whether an unread topic
 * outranks a warning, and this copy had no `partial` case at all, so the rail said "Warning" where
 * the Overview said "Partial" about the same group.
 */
type RailVerdict = { tone: Tone; word: string; because: string | null };

function railVerdict(groups: PerClusterGroups[string] | undefined, reachable: boolean | null): RailVerdict {
  // `null` is the third state and it is not a failure: the cluster is registered but this
  // fan-out has not covered it — almost always because it was onboarded seconds ago. Folding it
  // into `!reachable` put a red "Unreachable" dot on a cluster nothing had contacted yet, which
  // is the same mistake as reporting a forbidden read as a zero.
  if (reachable === null) {
    return { tone: 'unknown', word: 'Not read yet', because: 'the fleet has not completed a read for this cluster' };
  }
  // A cluster the fleet could not reach at all outranks anything its topics could say, and
  // `perCluster` will be all-`unknown` for it anyway. Say the reachable thing plainly.
  if (!reachable) return { tone: 'bad', word: 'Unreachable', because: 'the fleet could not read this cluster' };
  const entries = Object.entries(groups || {});
  if (!entries.length) return { tone: 'unknown', word: 'Unknown', because: null };

  const worstEntry = worstOf(groups);
  const worst: Health = worstEntry ? worstEntry[1].health : 'clear';
  if (worst === 'clear') return { tone: 'ok', word: 'Clear', because: `${entries.length} topics, none reporting a problem` };

  const first = worstEntry?.[1].signals?.[0];
  const detail = first
    ? phrase(first)
    : worst === 'unknown'
      ? 'could not be read'
      : 'reported a problem';
  return {
    tone: TONE_OF[worst],
    word: WORD_OF[worst],
    because: `${worstEntry?.[0] ?? 'a topic'}: ${detail}`
  };
}

export function Rail({
  user,
  refreshedAt,
  sidebar
}: {
  user: string | null;
  refreshedAt: string | null;
  sidebar: SidebarWidth;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  // Keyed on the roster version as well as polled: membership changes (an onboard, a removal)
  // must show here at once, not up to 30 seconds later. See src/roster-signal.ts.
  const rosterVersion = useRosterVersion();
  const clustersMeta = useAsync(useCallback(() => api.clusters(), []), 30_000, rosterVersion);
  // Shares every cache entry with the cluster tabs on the server, so the dots cost no reads the
  // console was not already paying for. See `summarizeGroups` in srv/fleet/router.js.
  const summary = useAsync(useCallback(() => api.summary(), []), 30_000);
  const collapsed = sidebar.width <= RAIL_WIDTH;
  const setCollapsed = (next: boolean) => sidebar.commit(next ? RAIL_WIDTH : sidebar.expandedWidth);
  // Between MIN_LABELLED and 200 the labels still fit but the padding that frames them at 240
  // does not: "Autoscaling & Jobs" lost its last word to `px-3` at 160. Compact trims the
  // horizontal padding and the gaps, and changes nothing else — the labels are the point.
  const compact = !collapsed && sidebar.width < COMPACT_BELOW;
  const padX = compact ? 'px-2' : 'px-3';

  // Check if current route is inside a specific cluster or has ?cluster= parameter
  const searchParams = new URLSearchParams(location.search);
  const clusterFromQuery = searchParams.get('cluster');
  const clusterMatch = location.pathname.match(/^\/clusters\/([^/]+)/);
  const rawClusterId = clusterMatch && clusterMatch[1] ? decodeURIComponent(clusterMatch[1]) : clusterFromQuery;
  const activeClusterId = rawClusterId === 'add' ? null : rawClusterId;

  const clusterList = clustersMeta.data?.clusters ?? [];
  const activeClusterEnv = clusterList.find(c => c.cluster.id === activeClusterId) ?? null;
  const activeCluster = activeClusterEnv?.cluster ?? null;
  const perCluster: PerClusterGroups = summary.data?.perCluster ?? {};
  // Before the first /summary lands, the rail says "Unknown" rather than a reassuring green.
  const verdictFor = (id: string, reachable: boolean | null) =>
    summary.data ? railVerdict(perCluster[id], reachable) : { tone: 'unknown' as Tone, word: 'Unknown', because: null };

  // One roster, shaped once, used by the switcher in both sidebar states. Built from whatever
  // `GET /clusters` returned on the last poll, so a cluster onboarded a moment ago appears here
  // without any other change — and with an Unknown dot until `/summary` has actually covered it.
  const switcherEntries: SwitcherEntry[] = clusterList.map(c => {
    const v = verdictFor(c.cluster.id, c.ok);
    return {
      id: c.cluster.id,
      displayName: c.cluster.displayName || c.cluster.id,
      env: c.cluster.env,
      tone: v.tone,
      word: v.word,
      because: v.because
    };
  });
  const activeEntry = switcherEntries.find(e => e.id === activeClusterId) ?? null;
  // "Loading" is the honest state until the roster answers — not "no clusters", which is a
  // different fact and sends an operator to the onboarding page for nothing.
  const rosterLoading = !clustersMeta.data;

  return (
    <nav
      // Hidden below `lg`, where `ClusterSectionStrip` in ClusterDetail takes over. Both were
      // visible at once before, so a narrow viewport showed the same ten destinations twice.
      //
      // No width class and no `shrink-0`: the width is the grid track `--sidebar-w` on the shell
      // (see `.app-shell` in theme.css), and a `w-[250px]` here would silently win over it on
      // every drag. `min-w-0` so the track, not the content, decides.
      className="relative flex min-w-0 flex-col border-r border-line bg-surface select-none"
    >
      <SidebarHandle sidebar={sidebar} />
      {/* Brand Header */}
      <div className={`flex h-[60px] items-center border-b border-line ${collapsed ? 'justify-center px-2' : `justify-between ${compact ? 'px-3' : 'px-5'}`}`}>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title="Expand navigation"
            aria-label="Expand navigation"
            aria-expanded={false}
            className="grid size-7 place-items-center rounded-[6px] bg-accent text-[14px] font-bold text-white shadow-sm hover:opacity-90"
          >
            K
          </button>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-[6px] bg-accent text-[14px] font-bold text-white shadow-sm">
                K
              </span>
              {/* `truncate` and `min-w-0` because the header is the one row in the sidebar with two
                  competing children: at 182px the wordmark wrapped to "Kubernetes / Fleet" and pushed the
                  collapse control below the 60px header, off the visible strip. The product name
                  ellipsising is the cheaper loss. */}
              <span className="truncate font-display text-[16px] font-semibold text-text">Kubernetes Fleet Dashboard</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* The build number is the first thing worth dropping when the header runs out of
                  room — it is never what an operator came for, and the collapse control is. */}
              {!compact && <span className="mono rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">v2.1</span>}
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                title="Collapse to the icon rail"
                aria-label="Collapse to the icon rail"
                aria-expanded
                className="grid size-5 place-items-center rounded text-[13px] text-muted hover:bg-raised hover:text-text"
              >
                «
              </button>
            </div>
          </>
        )}
      </div>

      {/* The selector is the first thing under the header in BOTH states, because "which cluster
          am I on" is the question the sidebar exists to answer first. Collapsed it is a single
          tile with the cluster's initials and its health dot; expanded it is a full-width row
          with the name and env. Either way it opens the full roster, so switching clusters is
          one click from anywhere rather than a trip back to the fleet.

          It sits OUTSIDE the scrolling region on purpose. `overflow-y: auto` computes
          `overflow-x` to `auto` as well, so a popover wider than the icon rail was clipped to
          60px and reachable only by scrolling the rail sideways. Out here it also stays put
          while the sections underneath scroll. */}
      <div className={`shrink-0 pb-1 pt-2 ${collapsed ? 'flex justify-center' : 'px-2'}`}>
        <ClusterSwitcher
          entries={switcherEntries}
          active={activeEntry}
          collapsed={collapsed}
          loading={rosterLoading}
        />
      </div>

      {/* The icon rail carries the same destinations as the expanded sidebar, not a subset.
          It used to carry only the cluster dots, which meant collapsing the sidebar inside a
          cluster took away all eleven of its sections and left no way back to them except
          expanding again — so the collapse control was unusable exactly where the width mattered
          most, on a wide table inside a cluster. */}
      {collapsed ? (
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
          <RailDivider />
          {activeCluster ? (
            <>
              <RailTile
                to="/"
                abbr="&#8592;"
                label={`Back to the fleet — leave ${activeCluster.displayName || activeCluster.id}`}
              />
              <RailDivider />
              <ClusterSections clusterId={activeCluster.id} collapsed />
            </>
          ) : (
            <>
              {NAV_ITEMS.map(item => (
                <RailTile
                  key={item.to}
                  to={item.to}
                  abbr={item.abbr}
                  label={item.label}
                  active={item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)}
                />
              ))}
              {clusterList.length > 0 && <RailDivider />}
              {clusterList.map(c => {
            const v = verdictFor(c.cluster.id, c.ok);
            const isActive = c.cluster.id === activeClusterId;
            return (
            <Link
              key={c.cluster.id}
              to={`/clusters/${encodeURIComponent(c.cluster.id)}`}
              title={`${c.cluster.displayName || c.cluster.id} · ${c.cluster.env} · ${v.word}${v.because ? ` — ${v.because}` : ''}`}
              // The visible text is two letters, so the link needs a real name: `title` is
              // not an accessible name in every combination that matters, and "PL" is not a
              // destination anyone can act on. The label carries the cluster, its env and its
              // verdict — collapsed, the status dot is the only other thing on the tile, and a
              // dot is not readable — and aria-current marks the one you are on.
              aria-label={`${c.cluster.displayName || c.cluster.id} · ${c.cluster.env} · ${v.word}`}
              aria-current={isActive ? 'page' : undefined}
              className={`relative grid size-8 shrink-0 place-items-center rounded-[6px] text-[12px] font-semibold uppercase transition-colors ${
                isActive
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-muted hover:bg-raised hover:text-text'
              }`}
            >
              {isActive && <span aria-hidden="true" className="rail-edge" />}
              <span aria-hidden="true">{abbreviate(c.cluster)}</span>
              {/* Collapsed there is no room for a word, so the dot is corner-mounted rather than
                  inline. It is redundant with the aria-label above, which carries the verdict in
                  text — the dot is the glanceable copy, never the only copy. */}
              <span className="absolute -right-0.5 -top-0.5" aria-hidden="true">
                <Dot tone={v.tone} />
              </span>
            </Link>
            );
          })}
            </>
          )}
        </div>
      ) : (
      /* Dynamic Cluster Context or Main Navigation */
      <div className="flex-1 overflow-y-auto py-2">
        {activeCluster ? (
          /* ================= CLUSTER CONTEXT MODE ================= */
          <div className="space-y-3 px-2">
            {/* The way back out. The cluster's identity used to be repeated here as a button and
                an env badge; the selector above now carries both, and carries them identically
                whether or not a cluster is open. What is left is the one thing the selector does
                not offer: leaving. */}
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex w-full items-center gap-1.5 px-1 pb-1 text-left text-[12px] text-muted hover:text-accent"
              title="Back to the fleet"
            >
              <span aria-hidden="true">&#8592;</span>
              <span className="truncate">Back to the fleet</span>
            </button>

            {/* The cluster's own sections, in the one sidebar rather than a second column
                beside it.

                The note that used to sit here said cluster navigation belonged to the tab strip,
                not the rail — "one destination, one control". That rule still holds; what
                changed is which control. The tab strip is gone, so these ten destinations have
                exactly one home again, and it is here: directly under the cluster you are in,
                which is what they are about. Rendered only when a cluster is open, so the fleet
                view is unaffected. A release page keeps it too — it is inside a cluster, and
                losing every other section on the way into one release is a dead end. */}
            <ClusterSections clusterId={activeCluster.id} />
          </div>
        ) : (
          /* ================= DEFAULT GROUPED NAVIGATION ================= */
          <div className="space-y-4 px-2">
            <ul className="space-y-0.5">
              {NAV_ITEMS.map(item => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `flex h-9 items-center rounded-[6px] ${padX} text-[14px] transition-colors ${
                        isActive
                          ? 'bg-accent font-medium text-white shadow-sm'
                          : 'text-muted hover:bg-raised hover:text-text'
                      }`
                    }
                  >
                    <span className="truncate" title={item.label}>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>

            {/* Target Clusters List */}
            {clusterList.length > 0 && (
              <div className="border-t border-line/60 pt-3">
                <div className={`flex items-center justify-between ${padX} pb-2 text-[11px] font-bold uppercase tracking-wider text-muted`}>
                  <span>Target Clusters</span>
                  <span className="mono">{clusterList.length}</span>
                </div>
                <div className="space-y-1">
                  {clusterList.map(c => {
                    const v = verdictFor(c.cluster.id, c.ok);
                    return (
                    <div
                      key={c.cluster.id}
                      className="group flex items-center justify-between rounded-[6px] transition-colors hover:bg-raised pr-1"
                    >
                      <NavLink
                        to={`/clusters/${encodeURIComponent(c.cluster.id)}`}
                        title={v.because ? `${v.word} — ${v.because}` : v.word}
                        className={({ isActive }) =>
                          `flex flex-1 items-center justify-between rounded-[6px] ${padX} py-2 text-[13px] transition-colors ${
                            isActive
                              ? 'bg-accent/10 font-medium text-accent border border-accent/20'
                              : 'text-muted hover:text-text'
                          }`
                        }
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Dot tone={v.tone} />
                          <span className="truncate font-medium text-text">{c.cluster.displayName || c.cluster.id}</span>
                        </div>
                        {/* The env code is what this said before and is still what you need when
                            two clusters share a name; the verdict word replaces it only while
                            something is wrong, which is the one time it is worth more. */}
                        <span className="mono text-[11px] uppercase text-muted shrink-0 group-hover:hidden">
                          {v.tone === 'ok' ? c.cluster.env : v.word}
                        </span>
                      </NavLink>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Footer: Add cluster action + Identity & Sync */}
      {/* The theme toggle sits beside "Add cluster" rather than in the identity block below it,
          because that block is `!collapsed` only — a collapsed rail would have hidden the one
          control that changes how the whole console looks. Stacked when collapsed, since two
          32px controls do not fit side by side in a 64px rail. */}
      <div
        className={`flex gap-2 border-t border-line py-3 ${collapsed ? 'flex-col items-center px-2' : compact ? 'px-2' : 'px-3'}`}
      >
        <NavLink
          to="/onboard"
          title={collapsed ? 'Add cluster' : undefined}
          // Collapsed, the only visible text is "+", which is not a name. The label is always
          // "Add cluster" so the control reads the same to a screen reader in both states.
          aria-label={collapsed ? 'Add cluster' : undefined}
          className={({ isActive }) =>
            `flex h-9 min-w-0 flex-1 items-center justify-center rounded-[6px] text-[14px] font-medium transition-colors ${
              isActive
                ? 'bg-accent text-white shadow-sm'
                : 'border border-line text-text hover:bg-raised'
            }`
          }
        >
          <span aria-hidden={collapsed ? 'true' : undefined}>{collapsed ? '+' : 'Add cluster'}</span>
        </NavLink>
        <ThemeToggle />
      </div>
      {!collapsed && (
        <div className={`border-t border-line py-3 text-[13px] text-muted bg-raised/20 ${compact ? 'px-3' : 'px-5'}`}>
          <div className="truncate font-medium text-text" title={user ?? undefined}>
            {user ?? 'Connected'}
          </div>
          <div className="mono mt-0.5 text-[12px] text-muted">
            {refreshedAt ? `synced ${ago(refreshedAt)}` : 'live stream active'}
          </div>
        </div>
      )}
    </nav>
  );
}

/**
 * The page heading: a glyph, the title, an optional explanation, and the page's controls.
 *
 * `icon` and `info` are optional and every cluster tab passes both, from `TAB_ICON` and `TAB_ABOUT`.
 * Doing it here rather than in each tab is the whole reason it is consistent: there is exactly one
 * place a tab's heading is rendered (`ClusterDetail` passes `TAB_LABEL[tab]`), so fourteen tabs get
 * their icon and their provenance note from one edit and cannot drift apart.
 *
 * The icon is sized 20 against a 20px title and given `text-muted`, not the accent. A coloured glyph
 * beside every heading makes the accent mean "decoration" everywhere, and this console spends the
 * accent on the one thing on each screen that is actually actionable.
 *
 * The InfoTip sits *inside* the `h1`, after the text. Outside it, the two would be flex siblings and
 * the tip would centre against the whole heading block including the subtitle; inside, it rides the
 * title's own baseline, which is where a reader's eye already is when they want it.
 */
export function PageHeader({
  title,
  icon,
  info,
  subtitle,
  actions
}: {
  title: string;
  icon?: IconName;
  /** One or two sentences on what this screen reads. Rendered as an `InfoTip` on the title. */
  info?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    // `shrink-0`: the header is a flex item of the page column, and on a workspace page (Live Pod
    // Logs) that column does not scroll — without this the header would give up its own height to
    // the panes below it and the title would be squeezed away rather than staying put.
    <header className="page-x flex shrink-0 items-start justify-between gap-6 pb-3 pt-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          {icon && <Icon name={icon} size={20} className="text-muted" />}
          <h1 className="text-[20px] font-semibold text-text">
            {title}
            {info && <InfoTip title={title} text={info} />}
          </h1>
        </div>
        {(subtitle || info) && (
          <p className="mt-1 truncate text-[14px] text-muted" title={!subtitle && info ? info : undefined}>
            {subtitle ?? info}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>}
    </header>
  );
}

/**
 * The body of a page, below its header.
 *
 * The one content container. It exists because the gutter was previously written out as a literal
 * `px-6` at twenty-one call sites, which is twenty-one places for it to drift and no place to change
 * it: the
 * page header, the section strip and the card grids each carried their own copy, and a table's
 * first column carried a fourth inset on top of whichever one it sat inside. Every one of those now
 * resolves to `--page-x` through this component or the `.page-x` class.
 *
 * No max-width, by the same argument as `.page-x` itself: the operator chose the window width.
 */
export function PageBody({
  children,
  className = '',
  as: Tag = 'div'
}: {
  children: ReactNode;
  className?: string;
  /** `section` where the block is a landmark in its own right; `div` otherwise. */
  as?: 'div' | 'section';
}) {
  return <Tag className={`page-x ${className}`}>{children}</Tag>;
}

export function Section({
  title,
  label,
  hint,
  compactHint,
  action,
  className,
  children
}: {
  title?: string;
  label?: string;
  hint?: string;
  /**
   * Opt-in: the hint shows as one line (its first sentence when that fits) and the whole text moves
   * into an InfoTip beside the heading. Off by default, so every other tab keeps its full hint.
   */
  compactHint?: boolean;
  action?: ReactNode;
  /** Extra classes on the section, e.g. a bounded flex column for a workspace pane. */
  className?: string;
  children: ReactNode;
}) {
  const heading = title || label || '';
  const compact = compactHint ? splitHint(hint) : null;
  return (
    <section className={`space-y-2 ${className ?? ''}`}>
      {/*
        No inset of its own. It used to carry `px-1`, which put the section heading 4px right of the
        page heading above it and 4px left of nothing in particular — the table under it was inset
        12px by its own cell padding. Both are gone; the heading and the first column of the table
        it names now start on the same pixel.
      */}
      <div className="section-head flex items-baseline justify-between">
        {/* min-w-0 only when compact, so the one line can truncate; the default markup is unchanged. */}
        <div className={compact ? 'min-w-0' : undefined}>
          {compact ? (
            <>
              <h2 className="flex items-baseline gap-2 text-[14px] font-semibold uppercase tracking-[0.04em] text-text">
                {heading}
                {compact.tip && <InfoTip text={compact.tip} title={heading} />}
              </h2>
              {compact.line && <p className="truncate text-[13px] text-muted">{compact.line}</p>}
            </>
          ) : (
            <>
              <h2 className="text-[14px] font-semibold uppercase tracking-[0.04em] text-text">{heading}</h2>
              {hint && <p className="text-[13px] text-muted">{hint}</p>}
            </>
          )}
        </div>
        {action && <div>{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={`mt-0.5 text-[14px] text-text ${mono ? 'mono' : ''}`}>{value}</div>
    </div>
  );
}

/**
 * The panel's width, and the viewport below which it stops taking space and starts covering.
 *
 * The width itself is `--panel-w` in theme.css, which is a *share of the viewport* per band —
 * 40% at 1440 and up, 46% from 1200, then 53% and 100% as an overlay below that. A fixed pixel
 * count cannot serve both ends of that range: 400px, which this used to be, reads well at 1280 and
 * is a cramped 26% at 1536, and the amount of detail a resource has does not shrink with the screen.
 *
 * The content column is correspondingly narrower than it was, and that is the case the
 * column-priority container queries were written for — they measure the table's own box, so the
 * lowest-priority columns shed rather than clipping off the right edge.
 *
 * 1200px is the switch to an inline panel, matching the band boundary in theme.css. Below it the
 * remaining content column would be too narrow to be worth reading beside the panel, so the panel
 * covers the page instead and the table gets its full width back.
 */
const PANEL_WIDTH = 'var(--panel-w)';
const INLINE_VIEWPORT = '(min-width: 1200px)';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The detail panel. Two layouts, one component, and the difference is not cosmetic —
 * it decides the box model *and* the accessibility semantics.
 *
 * **Inline** — viewport at or above 1280px, on a page whose body is laid out as a flex
 * row. The panel is a real flex sibling, so opening it takes 420px *away from* the
 * content column instead of covering it. `.table-wrap` is an inline-size container, so
 * it genuinely narrows and the column-priority queries in theme.css finally fire:
 * prio-3 drops, then prio-2. That system was written for exactly this moment and has
 * never once been reachable, because a `position: fixed` panel cannot change a
 * sibling's width. The table stays visible and clickable beside the panel, so this is a
 * complementary region — not a dialog. No `aria-modal`, no focus trap: trapping the
 * keyboard inside a panel while the content next to it is plainly usable is a lie the
 * screen reader repeats.
 *
 * **Overlay** — below 1280px, or on a page whose body is a flex *column* and therefore
 * has nowhere to seat the panel beside itself. Fixed to the right edge over a scrim.
 * Here the panel really does obscure the page, so it is modal in fact and must be modal
 * in markup: `role="dialog"`, `aria-modal="true"`, and a real focus trap.
 *
 * Escape closes either way, and focus goes back to whatever opened the panel.
 */
export function DetailPanel({
  title,
  subtitle,
  onClose,
  inlineClassName,
  children
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /**
   * Extra classes for the INLINE layout only, so a caller that seats the panel beside a long
   * table can pin and bound it (`sticky top-… max-h-…`) without the overlay inheriting a
   * max-height it has no use for. Ignored below 1280px.
   */
  inlineClassName?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);
  const headingId = useId();
  const [inline, setInline] = useState(false);

  // Remember who opened us before we steal focus, and hand it back on close — losing
  // your place in a 200-row table because you pressed Escape is its own defect.
  //
  // Captured exactly once, and never from inside the panel. StrictMode re-runs this
  // effect after simulating an unmount, and by then the panel has already taken focus:
  // re-reading `activeElement` would record the panel as its own opener, and closing
  // would then hand focus to a node that no longer exists — which is how this lands
  // back on `<body>` and drops the operator at the top of the page.
  useLayoutEffect(() => {
    closingRef.current = false;
    const active = document.activeElement;
    if (openerRef.current === null && active instanceof HTMLElement && !panelRef.current?.contains(active)) {
      openerRef.current = active;
    }
    return () => {
      // Disarm the trap first. This cleanup runs in the mutation phase, while the panel
      // is still in the document and the trap's `focusin` guard is still listening —
      // hand focus back without saying "we are closing" and the guard reads it as an
      // escape attempt and drags focus back onto a panel that is about to be deleted.
      closingRef.current = true;
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      // If the operator had deliberately moved focus out of an inline panel before
      // closing it, React's own `restoreSelection` runs after this and puts focus back
      // where they left it, overriding the line above. That is the behaviour we want
      // for a non-modal region — don't "fix" it. When focus was inside the panel, the
      // element React snapshotted is gone by then and the opener restore stands.
    };
  }, []);

  // Inline only where it can actually work: a wide enough viewport *and* a parent that
  // lays its children out in a row. On a page whose body is a column the panel would
  // land underneath the table rather than beside it, so it stays an overlay there until
  // that page nests its body — at which point this picks it up with no further change.
  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) return;
    const viewport = window.matchMedia(INLINE_VIEWPORT);
    const decide = () => {
      const parentStyle = getComputedStyle(parent);
      const seatsARow =
        (parentStyle.display === 'flex' || parentStyle.display === 'inline-flex') &&
        parentStyle.flexDirection === 'row';
      setInline(viewport.matches && seatsARow);
    };
    decide();
    viewport.addEventListener('change', decide);
    return () => viewport.removeEventListener('change', decide);
  }, []);

  // Announce the region and put Tab inside it. The panel mounts once per open, so this
  // does not fight the operator arrowing from row to row with the panel already up.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Modal means modal: while the overlay covers the page, Tab cycles within the panel
  // and focus cannot be dragged out from underneath it.
  useEffect(() => {
    const el = panelRef.current;
    if (inline || !el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        n => n.getClientRects().length > 0
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        el.focus();
        return;
      }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (closingRef.current || !el.isConnected) return;
      if (!el.contains(e.target as Node)) el.focus();
    };

    el.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      el.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [inline]);

  return (
    <>
      {!inline && <div className="fixed inset-0 z-30 bg-bg/70" onClick={onClose} aria-hidden="true" />}
      <div
        ref={panelRef}
        tabIndex={-1}
        role={inline ? 'complementary' : 'dialog'}
        aria-modal={inline ? undefined : true}
        aria-labelledby={headingId}
        style={{ width: PANEL_WIDTH }}
        className={
          inline
            ? `flex shrink-0 flex-col overflow-hidden border-l border-line bg-surface ${inlineClassName ?? ''}`
            : 'fixed inset-y-0 right-0 z-40 flex max-w-full flex-col overflow-hidden border-l border-line bg-surface shadow-2xl'
        }
      >
        <div className="detail-panel-enter panel-head flex h-[60px] shrink-0 items-center justify-between">
          <div className="min-w-0 flex-1">
            <h2 id={headingId} className="truncate font-display text-[16px] font-semibold text-text">
              {title}
            </h2>
            {subtitle && <div className="truncate text-[13px] text-muted">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            title="Close details"
            className="grid size-7 place-items-center rounded-[6px] border border-line text-muted hover:bg-raised hover:text-text"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="detail-panel-enter card-body flex-1 min-h-0 space-y-4 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </>
  );
}

/**
 * The open cluster's sections, grouped, inside the fleet rail.
 *
 * Reads and writes `?tab=` itself rather than taking props. `Rail` is rendered by `App` outside
 * `<Routes>`, so there is no prop path from `ClusterDetail` to here — and the URL is the state
 * anyway: it is what every deep link, Overview tile and cross-page drill-down already addresses.
 * Plumbing a callback through would add a second source of truth for something the address bar
 * already holds.
 *
 * Deliberately NOT role="tablist"/role="tab". Those roles promise a keyboard contract — roving
 * tabIndex, ArrowLeft/Right/Home/End, `aria-controls` onto a role="tabpanel" — and claiming it
 * without implementing it is worse than not claiming it: a screen reader announces "tab, 1 of
 * 10", switches to focus mode, and the arrow keys it then hands the app do nothing. These are
 * URL-addressable destinations, so they are navigation, and `aria-current` says where you are.
 */
/**
 * The cluster's eleven sections.
 *
 * Two behaviours, because the URL means different things on the two routes that show this:
 *
 * - On `/clusters/:id` a section is a *filter on the current screen*, so it sets `?tab=` in place
 *   and keeps the rest of the query — which is what makes the back button walk the sections.
 * - On a sub-route such as `/clusters/:id/helm/:ns/:name` the pathname is what decides the screen,
 *   so setting `?tab=` would move the highlight and leave the operator on the release page: a nav
 *   that lies about where you are. There the section is a *destination* and this navigates.
 *
 * The sub-route also highlights the section it belongs to, so a release page reads as being inside
 * Helm Releases rather than nowhere.
 */
function ClusterSections({ clusterId, collapsed = false }: { clusterId: string; collapsed?: boolean }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const inPlace = /^\/clusters\/[^/]+$/.test(location.pathname);
  const subRouteTab: Tab | null = /^\/clusters\/[^/]+\/helm\//.test(location.pathname) ? 'helm' : null;

  const raw = params.get('tab');
  const fromQuery: Tab = raw && TAB_IDS.has(raw) ? (raw as Tab) : DEFAULT_TAB;
  const tab: Tab | null = inPlace ? fromQuery : subRouteTab;

  const select = (next: Tab) => {
    if (!inPlace) {
      navigate(`/clusters/${encodeURIComponent(clusterId)}?tab=${next}`);
      return;
    }
    // The same param hygiene ClusterDetail's own setTab does, through the one shared rule. Hand-written
    // copies here drifted twice: once on `previous`, then on `top` and `nsview`.
    setParams(tabSwitchParams(params, next), { replace: true });
  };

  // Same eleven destinations, same selection logic, same `aria-current`; only the tile differs.
  // Splitting this into a second component would have duplicated `select`'s param hygiene, which
  // is the part that must not drift.
  if (collapsed) {
    return (
      <nav aria-label="Cluster sections" className="flex flex-col items-center gap-1">
        {TAB_GROUPS.map((group, index) => (
          <div key={group.label} className="contents">
            {index > 0 && <RailDivider />}
            {group.tabs.map(t => <RailTile key={t} abbr={TAB_ABBR[t]} label={`${group.label}: ${TAB_LABEL[t]}`} active={tab === t} onClick={() => select(t)} />)}
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Cluster sections" className="space-y-3">
      {TAB_GROUPS.map(group => (
        <section key={group.label} aria-label={group.label}>
          <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">{group.label}</div>
          <div className="space-y-0.5">
            {group.tabs.map(t => {
              const active = tab === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => select(t)}
                  aria-current={active ? 'true' : undefined}
                  title={TAB_LABEL[t]}
                  className={`flex h-[30px] w-full items-center rounded-[6px] px-3 text-left text-[13px] leading-tight transition-colors ${
                    active ? 'bg-accent font-medium text-white shadow-sm' : 'text-muted hover:bg-raised hover:text-text'
                  }`}
                >
                  <span className="truncate">{TAB_LABEL[t]}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </nav>
  );
}
