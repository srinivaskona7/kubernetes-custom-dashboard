/**
 * The four-part explanation popover, and the source registry behind it.
 *
 * `InfoTip` in `ui.tsx` is the right control for one sentence beside a column header. This is its
 * bigger sibling, for the places where an honest answer needs four different things said and kept
 * apart:
 *
 * - **what it means** — the definition, in the operator's language
 * - **data source** — which log field or API object this actually came from
 * - **limitations** — what the number cannot tell you, stated before you act on it
 * - **sources** — the official documentation, so a disagreement is settled by Istio and not by us
 *
 * That separation is the whole point, not decoration. The failure this console is built to avoid is
 * a confident number whose provenance and blind spots live only in someone's head. A tooltip that
 * blends "here is what this is" with "here is what it cannot see" lets the second half be skipped.
 *
 * ## Why it is click-first
 *
 * `InfoTip` opens on hover after 120ms, which is right for a one-line gloss. Four paragraphs on
 * hover is a panel that appears while you are reaching for something else and covers the table you
 * were reading. So this opens on **click** (and Enter/Space, and focus does not open it), while
 * `title` still carries a short summary for the pointer — which also satisfies "do not rely only on
 * hover" in the request.
 *
 * ## The three traps it inherits
 *
 * Documented at length on `InfoTip`, and all three apply here identically:
 * 1. `pointerdown` **and** `click` are stopped, because a `DataTable` row's press affordance and the
 *    table's outside-press handlers listen on `pointerdown`, which fires first.
 * 2. The trigger is a `<span role="button">`, never a `<button>`, because a sortable header's label
 *    is already a button and React will happily render a button inside one.
 * 3. The panel is portalled to `document.body`, because `.table-wrap` sets `overflow-x: auto` which
 *    computes `overflow-y` to `auto` and clips anything positioned inside it.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

/**
 * The official documentation this page cites, defined once.
 *
 * One registry rather than links written at each call site, for the same reason `COLUMN_INFO` exists:
 * a definition repeated in four places drifts in three of them. Istio only — a technical claim about
 * what an access-log field means is settled by the project that writes the field.
 */
export const SOURCES = {
  accessLog: {
    label: 'Istio: Envoy access logs',
    href: 'https://istio.io/latest/docs/tasks/observability/logs/access-log/'
  },
  telemetryApi: {
    label: 'Istio: Telemetry API',
    href: 'https://istio.io/latest/docs/tasks/observability/logs/telemetry-api/'
  },
  networkIssues: {
    label: 'Istio: traffic management problems',
    href: 'https://istio.io/latest/docs/ops/common-problems/network-issues/'
  }
} as const;

export type SourceKey = keyof typeof SOURCES;

export interface InfoPopoverContent {
  /** The heading. Short — this is what the operator scanned for. */
  title: string;
  /** The definition. One or two sentences, in the operator's language. */
  means: ReactNode;
  /** Which log field or API object the value came from. Omit only when there genuinely is no source. */
  source?: ReactNode;
  /**
   * What this number cannot tell you.
   *
   * Each entry is a separate claim, so none of them can be skimmed past inside a paragraph. Omitting
   * this is a decision, not a default: if a metric really has no caveat, say nothing rather than
   * padding it.
   */
  limitations?: readonly ReactNode[];
  /** Keys into {@link SOURCES}. */
  sources?: readonly SourceKey[];
}

const WIDTH = 340;

/**
 * The trigger and its panel.
 *
 * @param content the four parts.
 * @param ariaLabel what a screen reader announces for the trigger. **Required**, and it must name
 *   the subject — "Explain no HTTP response", not "Info". Twelve identical "Info" buttons on one
 *   page is a page that cannot be navigated without sight.
 */
export function InfoPopover({
  content,
  ariaLabel,
  className = ''
}: {
  content: InfoPopoverContent;
  ariaLabel: string;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const id = useId();

  /**
   * Placed below the trigger and clamped to the viewport, flipping above only when there is no room.
   *
   * `useLayoutEffect` rather than an effect, so the panel's measured height is known before the
   * browser paints and it does not visibly jump from below to above on its first frame.
   *
   * Left-aligned to the trigger rather than centred on it, unlike `InfoTip`. These triggers sit
   * beside a heading at the left of a card, and a centred 340px panel would hang off that edge and
   * get clamped — which puts it back over the content it was supposed to sit beside.
   */
  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const height = panel.current?.offsetHeight ?? 0;
    const below = r.bottom + 8;
    const flip = height > 0 && below + height > window.innerHeight - 8 && r.top - height - 8 > 8;
    setBox({
      top: Math.round(flip ? r.top - height - 8 : below),
      left: Math.round(Math.min(Math.max(8, r.left - 4), window.innerWidth - WIDTH - 8))
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (panel.current?.contains(t) || anchor.current?.contains(t))) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        anchor.current?.focus();
      }
    };
    // A scroll inside the panel is exempt: its own rectangle has not moved, and a four-part
    // explanation is tall enough to scroll, so closing on it would shut the panel the moment the
    // reader reached the limitations — the part they most needed.
    const scrolled = (e: Event) => {
      const t = e.target as Node | null;
      if (t && panel.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    // `capture`, because the scroll that matters is a table's own and it does not bubble.
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', scrolled);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', scrolled);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen(o => !o), []);

  return (
    <>
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        // The pointer gets the heading as a short summary, so the control is not hover-only *and*
        // not click-only. Full prose in a native title would duplicate the panel and, on a nested
        // element, the browser shows only the innermost one anyway.
        title={content.title}
        className={`infotip ${className}`}
        onPointerDown={e => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onClick={e => {
          e.stopPropagation();
          toggle();
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            toggle();
          }
        }}
      >
        <Icon name="info" size={13} />
      </span>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={content.title}
            className="info-popover"
            style={{
              top: box?.top ?? -9999,
              left: box?.left ?? -9999,
              width: WIDTH,
              visibility: box ? 'visible' : 'hidden'
            }}
          >
            <div className="info-popover-title">{content.title}</div>

            <Part label="What it means">{content.means}</Part>

            {content.source && <Part label="Data source">{content.source}</Part>}

            {content.limitations && content.limitations.length > 0 && (
              <Part label="Limitations">
                <ul className="info-popover-list">
                  {content.limitations.map((l, i) => (
                    // Index keys are safe here: the list is a static literal per call site, never
                    // reordered and never filtered.
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </Part>
            )}

            {content.sources && content.sources.length > 0 && (
              <Part label="Sources">
                <ul className="info-popover-list">
                  {content.sources.map(k => (
                    <li key={k}>
                      <a
                        className="info-popover-link"
                        href={SOURCES[k].href}
                        target="_blank"
                        // `noreferrer` as well as `noopener`: this console's URLs carry a cluster id,
                        // and a documentation site has no business receiving it in a Referer header.
                        rel="noopener noreferrer"
                      >
                        {SOURCES[k].label}
                      </a>
                    </li>
                  ))}
                </ul>
              </Part>
            )}
          </div>,
          document.body
        )}
    </>
  );
}

/** One labelled block. Separate element rather than a heading inside prose, so the four parts stay
 *  visually distinct and none of them reads as a continuation of the one above. */
function Part({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="info-popover-part">
      <div className="info-popover-label">{label}</div>
      <div className="info-popover-body">{children}</div>
    </div>
  );
}
