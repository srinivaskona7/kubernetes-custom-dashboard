/**
 * The compact cluster selector that sits at the top of the sidebar, in both of its states.
 *
 * Why it exists: collapsed to the icon rail inside a cluster, the sidebar showed a back arrow and
 * eleven section tiles, and nothing at all naming the cluster those sections belonged to. The one
 * surface an operator looks at first could not answer "which cluster am I on", and switching to
 * another meant going back to the fleet, finding it in a list, and re-entering — three navigations
 * to change one variable. Expanded it was slightly better and still a one-way trip.
 *
 * Built against the roster as it arrives, never against a fixed set:
 *  - Zero clusters is a real state (a fresh deployment) and renders as an invitation, not a gap.
 *  - The list scrolls, and a type-to-filter box appears once scanning is slower than typing.
 *  - A cluster onboarded while the console is open shows up on the next poll, with its health dot
 *    "Unknown" until the first `/summary` covers it — never a reassuring green by default.
 *
 * The dot is the same `railVerdict` the rail items use, so the selector and the list underneath it
 * cannot disagree about a cluster's state.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dot, type Tone } from './ui';
import { abbreviate, filterClusters, nextIndexForKey, showFilter } from './cluster-switcher';

export interface SwitcherEntry {
  id: string;
  displayName: string;
  env: string;
  tone: Tone;
  word: string;
  because: string | null;
}

/**
 * The popover. One list, whatever the trigger looked like.
 *
 * `role="menu"` is deliberately not used: these are links to URLs, the arrow keys move a visual
 * highlight rather than focus, and claiming the menu contract without the full roving-tabindex
 * implementation makes a screen reader switch to focus mode and hand the app arrow keys it does
 * not handle. A labelled listbox-free popover of links is what this actually is.
 */
function SwitcherPanel({
  entries,
  activeId,
  onClose,
  labelledBy,
  collapsed
}: {
  entries: SwitcherEntry[];
  activeId: string | null;
  onClose: () => void;
  labelledBy: string;
  /** Collapsed, the trigger is a 32px tile — too narrow to be the panel's width. */
  collapsed: boolean;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const panelRef = useRef<HTMLDivElement>(null);
  const filtered = filterClusters(entries, query);
  const withFilter = showFilter(entries.length);

  // Close on Escape and on a click that lands outside. Both, not one: Escape is the keyboard
  // contract and the outside click is what a mouse user does without thinking about it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // `mousedown` rather than `click`: a click that starts inside the panel and ends outside it
    // (a drag over a long name) should not be read as "dismiss".
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // Focus the first control so the keyboard can reach the list without a Tab through the page.
  useLayoutEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>('input, a, button');
    first?.focus();
  }, []);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && highlight >= 0 && filtered[highlight]) {
      e.preventDefault();
      navigate(`/clusters/${encodeURIComponent(filtered[highlight].id)}`);
      onClose();
      return;
    }
    const next = nextIndexForKey(e.key, highlight, filtered.length);
    if (next === null) return;
    e.preventDefault();
    setHighlight(next);
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={labelledBy}
      onKeyDown={onListKey}
      // Anchored to the sidebar's own edge rather than the viewport, so it tracks the resize
      // handle instead of detaching from it. `z-40` clears the sticky table headers (z-3).
      //
      // Expanded: exactly the trigger's footprint. Inset by even 4px, the active nav item
      // underneath — a full-content-width filled pill — showed as a purple sliver down both
      // edges of the panel, which reads as a rendering fault rather than as depth.
      //
      // Collapsed: the trigger is a 32px tile, so matching it would give a 32px-wide list of
      // cluster names. The panel floats out over the content area at a readable width instead,
      // left-aligned to the rail so it still points at the control that opened it.
      className={`absolute top-full z-40 mt-1 rounded-[8px] border border-line bg-surface shadow-[0_12px_28px_-8px_rgba(0,0,0,0.75)] ${
        collapsed ? 'left-0 w-[240px]' : 'inset-x-0'
      }`}
    >
      {withFilter && (
        <div className="border-b border-line p-2">
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setHighlight(-1); }}
            placeholder="Filter clusters"
            aria-label="Filter clusters"
            className="h-7 w-full rounded-[6px] border border-line bg-raised px-2 text-[13px] text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
      )}

      <div className="max-h-[300px] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted">
            {entries.length === 0
              ? 'No clusters yet. Add one to start.'
              : `Nothing matches “${query}”.`}
          </p>
        ) : (
          filtered.map((c, i) => (
            <a
              key={c.id}
              href={`#/clusters/${encodeURIComponent(c.id)}`}
              onClick={e => {
                e.preventDefault();
                navigate(`/clusters/${encodeURIComponent(c.id)}`);
                onClose();
              }}
              onMouseEnter={() => setHighlight(i)}
              aria-current={c.id === activeId ? 'page' : undefined}
              title={c.because ? `${c.word} — ${c.because}` : c.word}
              className={`flex items-center gap-2 px-3 py-1.5 text-[13px] transition-colors ${
                i === highlight ? 'bg-raised' : ''
              } ${c.id === activeId ? 'text-accent' : 'text-text hover:bg-raised'}`}
            >
              <Dot tone={c.tone} />
              <span className="min-w-0 flex-1 truncate">{c.displayName || c.id}</span>
              <span className="mono shrink-0 text-[11px] uppercase text-muted">{c.env}</span>
            </a>
          ))
        )}
      </div>

      <div className="border-t border-line p-1">
        <a
          href="#/"
          onClick={e => { e.preventDefault(); navigate('/'); onClose(); }}
          className="block rounded-[6px] px-2 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-text"
        >
          All clusters
        </a>
        <a
          href="#/onboard"
          onClick={e => { e.preventDefault(); navigate('/onboard'); onClose(); }}
          className="block rounded-[6px] px-2 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-text"
        >
          Add cluster
        </a>
        {activeId && (
          // A *link* to where removal lives, never the removal itself. The control belongs on
          // the Credentials tab, where it has room for the typed confirmation and for naming
          // what stays behind on the cluster; putting the action in a navigation popover is
          // how it came to be a mis-click hazard the first time.
          <a
            href={`#/clusters/${encodeURIComponent(activeId)}?tab=tokens`}
            onClick={e => {
              e.preventDefault();
              navigate(`/clusters/${encodeURIComponent(activeId)}?tab=tokens`);
              onClose();
            }}
            className="block rounded-[6px] px-2 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-text"
          >
            Credentials &amp; remove cluster…
          </a>
        )}
      </div>
    </div>
  );
}

export function ClusterSwitcher({
  entries,
  active,
  collapsed,
  loading
}: {
  entries: SwitcherEntry[];
  active: SwitcherEntry | null;
  collapsed: boolean;
  /** True until the roster has answered once. Distinguishes "none yet" from "none". */
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const close = useCallback(() => setOpen(false), []);

  // The verdict shown on the trigger. With no cluster open it is the fleet as a whole, and the
  // worst cluster is what it reports — a selector that says "Clear" while one of six is
  // unreachable is worse than no selector.
  const worst = entries.reduce<SwitcherEntry | null>((acc, c) => {
    const rank = (t: Tone) => (t === 'bad' ? 3 : t === 'warn' ? 2 : t === 'unknown' ? 1 : 0);
    return !acc || rank(c.tone) > rank(acc.tone) ? c : acc;
  }, null);

  const shown = active ?? worst;
  const tone: Tone = loading ? 'unknown' : (shown?.tone ?? 'unknown');
  const label = active
    ? `${active.displayName || active.id} · ${active.env} · ${active.word}`
    : loading
      ? 'Loading clusters'
      : entries.length === 0
        ? 'No clusters yet — add one'
        : `${entries.length} cluster${entries.length === 1 ? '' : 's'}`;

  const trigger = collapsed ? (
    <button
      type="button"
      id={labelId}
      onClick={() => setOpen(v => !v)}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={label}
      aria-label={`Switch cluster. ${label}`}
      className={`relative grid size-8 shrink-0 place-items-center rounded-[6px] border text-[11px] font-semibold uppercase transition-colors ${
        active ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-muted hover:bg-raised hover:text-text'
      }`}
    >
      <span aria-hidden="true">{active ? abbreviate(active) : '≡'}</span>
      <span className="absolute -right-0.5 -top-0.5" aria-hidden="true">
        <Dot tone={tone} />
      </span>
    </button>
  ) : (
    <button
      type="button"
      id={labelId}
      onClick={() => setOpen(v => !v)}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={label}
      aria-label={`Switch cluster. ${label}`}
      className="flex h-8 w-full items-center gap-2 rounded-[6px] border border-line px-2 text-left text-[13px] transition-colors hover:bg-raised"
    >
      <Dot tone={tone} />
      <span className={`min-w-0 flex-1 truncate font-medium ${active ? 'text-text' : 'text-muted'}`}>
        {active ? active.displayName || active.id : label}
      </span>
      {active && (
        <span className="mono shrink-0 rounded-[4px] border border-line px-1 text-[10px] font-bold uppercase tracking-wider text-muted">
          {active.env}
        </span>
      )}
      <span aria-hidden="true" className="shrink-0 text-[10px] text-muted">&#9662;</span>
    </button>
  );

  return (
    <div className={`relative ${collapsed ? '' : 'w-full'}`}>
      {trigger}
      {open && (
        <SwitcherPanel
          entries={entries}
          activeId={active?.id ?? null}
          onClose={close}
          labelledBy={labelId}
          collapsed={collapsed}
        />
      )}
    </div>
  );
}
