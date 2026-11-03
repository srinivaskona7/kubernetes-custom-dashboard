/**
 * A panel anchored to a button, rendered outside every scroll container on the page.
 *
 * The portal is the whole point. A menu rendered as a child of its button lives inside
 * `.table-wrap`, which sets `overflow-x: auto` — and `overflow-x: auto` computes `overflow-y` to
 * `auto` as well, so an absolutely positioned panel is clipped by the table's own horizontal scroller
 * the moment it is taller than the rows below the button. That failure has already cost this project
 * time once (see the popover-clipping note in the operator guide); the fix is to take the panel out of
 * the DOM subtree entirely and position it against the button's viewport rectangle.
 *
 * Deliberately small: no arrow, no flip-and-shift library, no focus trap. It closes on Escape, on a
 * pointer press outside it, and on scroll — because a panel positioned against a rectangle that has
 * since scrolled away is worse than no panel.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Popover({
  label,
  title,
  children,
  align = 'right',
  triggerClass = 'table-tool'
}: {
  /** The trigger's visible text. */
  label: ReactNode;
  title?: string;
  /**
   * The panel's contents. Given a function, it receives `close` — for the one control inside a panel
   * whose job is finished the moment it is pressed (Reset), where leaving the menu open reads as if
   * nothing happened.
   */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Which edge of the panel lines up with the button. */
  align?: 'left' | 'right';
  /**
   * The trigger's class. Defaults to `table-tool`, the 12px ghost button that lives in a table's
   * hover-revealed toolbar.
   *
   * `filter-tool` is the other one: a toolbar filter control has to be visible without hovering and
   * has to line up with `FilterSelect`'s 32px height beside it, because a filter nobody can see is a
   * filter that silently hides rows.
   */
  triggerClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  // Measured after layout rather than on click, so the panel's own width is known and a
  // right-aligned menu does not jump left on its first frame.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = panel.current?.offsetWidth ?? 220;
    const left = align === 'right' ? r.right - width : r.left;
    setBox({
      top: Math.round(r.bottom + 6),
      // Never off-screen, whichever edge the button is near.
      left: Math.round(Math.min(Math.max(8, left), window.innerWidth - width - 8))
    });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (panel.current?.contains(t) || btn.current?.contains(t))) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    // A panel positioned against a rectangle that has since scrolled away is worse than no panel, so
    // any scroll closes it — `capture`, because the scroll that matters is the table's own rather than
    // the document's, and it does not bubble. Removed with the rest: a listener that outlives the open
    // state closes the *next* panel the moment the page moves.
    //
    // A scroll *inside* the panel is exempt, and that exemption is load-bearing. The panel's own
    // rectangle has not moved, so closing would be wrong — and without the exemption a scrollable list
    // inside a popover (the namespace multi-select on a cluster with sixty namespaces) closes itself
    // the instant the user reaches for the item they came for.
    const scrolled = (e: Event) => {
      const t = e.target as Node | null;
      if (t && panel.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        className={triggerClass}
        onClick={() => setOpen(o => !o)}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            className="popover"
            style={{ top: box?.top ?? -9999, left: box?.left ?? -9999, visibility: box ? 'visible' : 'hidden' }}
          >
            {typeof children === 'function'
              ? children(() => {
                  setOpen(false);
                  btn.current?.focus();
                })
              : children}
          </div>,
          document.body
        )}
    </>
  );
}
