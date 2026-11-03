/**
 * The shared vocabulary of the console: status pills, capacity bars, cards, and the
 * designed empty and error states.
 *
 * Two rules are enforced here rather than left to each page:
 *
 *  1. **Status is never colour alone.** Every pill is a dot plus a word. The design must
 *     survive greyscale and colour blindness, and a red dot on its own does not.
 *  2. **Nothing renders as a blank card or an endless spinner.** Every list has a
 *     designed empty state, and every failure says which cluster and why.
 */
import { Component, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';
import { band, percent } from '../format';
import { SESSION_LOST, retryAuthentication } from '../api';
import { explainError } from '../errors';

export { Icon } from './icons';

export type Tone = 'ok' | 'warn' | 'bad' | 'unknown' | 'accent';

/**
 * The tone → text-colour map, exported because a status is not always a pill.
 *
 * Where the dot lives in one column and its word in the next — the Workloads table, whose pill used
 * to displace every row's name by the width of its own status text — the word still has to carry the
 * tone, or the two columns read as unrelated facts. Same five classes as `Pill` uses, so a tone can
 * never mean one colour inside a pill and another outside one.
 */
export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  unknown: 'text-unknown',
  accent: 'text-accent'
};

const TONE_BG: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  unknown: 'bg-unknown',
  accent: 'bg-accent'
};

/**
 * A hover-and-focus explanation, anchored to a small `i` and rendered outside every scroll container.
 *
 * This exists because the console is full of columns whose *name* is not their definition. `CPU
 * (used/req)` is two facts from two different sources — a live sample from metrics-server and a
 * number somebody typed into a pod spec — and no header short enough to fit will ever say that. A
 * `title` attribute could, and was the obvious first answer; it was wrong for three measured reasons:
 * it takes about a second to appear, it cannot be reached by keyboard, and per the derived-tooltip
 * note in the operator guide the browser shows the *innermost* `title` in a subtree, so a tip on a
 * header inside a cell that already has one is silently swallowed.
 *
 * ## Three things it must not break, each of which it got wrong first
 *
 * **1. Row clicks.** A `DataTable` row with `onSelect` is a `role="button"`, so a click anywhere in
 * it opens the drawer. An `i` inside a header is not in a row — but an InfoTip in a *cell* would be,
 * and the tip is deliberately usable there too, so the trigger stops `click` and `pointerdown` from
 * propagating. `pointerdown` as well as `click` is the load-bearing half: the table's
 * outside-press handlers and the row's own press affordance both fire on pointerdown, which happens
 * first, so stopping only `click` leaves a drawer that opens behind the panel.
 *
 * **2. Sorting.** A sortable header's label is a `.th-sort` button. A `<button>` inside a `<button>`
 * is invalid HTML and React will render it anyway, with the inner press toggling the sort. So the
 * trigger renders as a focusable `<span role="button">` rather than a `<button>`, and the same
 * `stopPropagation` keeps a press off the sort control.
 *
 * **3. Clipping.** `.table-wrap` sets `overflow-x: auto`, which computes `overflow-y` to `auto` as
 * well, so an absolutely positioned panel inside a header is clipped by the table's own scroller —
 * the trap already recorded in `components/table/Popover.tsx`. The panel is therefore portalled to
 * `document.body` and positioned against the trigger's viewport rectangle, and any scroll closes it,
 * because a panel pinned to a rectangle that has scrolled away is worse than no panel.
 *
 * Hover opens it after 120ms and closing is immediate. The delay is not a flourish: without it,
 * dragging the pointer across a header row of eleven columns flashes eleven panels. Focus and Escape
 * work the same way they do in `Popover`, and the text is also exposed as the trigger's
 * `aria-describedby`, so a screen reader gets the explanation without a hover event existing at all.
 */
type InfoTipProps = {
  text: string;
  title?: string;
  className?: string;
};

export function InfoTip({ text, title, className = '' }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const id = useId();

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /**
   * Positioned against the trigger's viewport rect, clamped to the window.
   *
   * Centred on the trigger and below it, flipping above only when there is no room below — a header
   * near the bottom of a long table is the case that flips. The panel has a declared width in
   * `.infotip-panel`, so this can clamp without measuring and the panel does not jump on its first
   * frame the way a measured right-aligned menu does.
   */
  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 260;
    const height = panel.current?.offsetHeight ?? 0;
    const below = r.bottom + 8;
    const flip = height > 0 && below + height > window.innerHeight - 8 && r.top - height - 8 > 8;
    setBox({
      top: Math.round(flip ? r.top - height - 8 : below),
      left: Math.round(Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8))
    });
  }, []);

  const show = useCallback(() => {
    cancel();
    timer.current = window.setTimeout(() => {
      setOpen(true);
      place();
    }, 120);
  }, [cancel, place]);

  const hide = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);

  // Re-placed once the panel exists, because the flip decision needs its height.
  useEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancel();
        setOpen(false);
      }
    };
    const scrolled = () => {
      cancel();
      setOpen(false);
    };
    document.addEventListener('keydown', key);
    // `capture`, because the scroll that matters is the table's own and it does not bubble.
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', scrolled);
    return () => {
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', scrolled);
    };
  }, [cancel, open]);

  useEffect(() => cancel, [cancel]);

  return (
    <>
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        aria-label={title ?? 'What this shows'}
        className={`infotip ${className}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // Both, and in this order of importance: `pointerdown` is what a row's press affordance and
        // the table's outside-press handlers listen on, and it fires before `click`.
        onPointerDown={e => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onClick={e => {
          e.stopPropagation();
          cancel();
          setOpen(o => !o);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            cancel();
            setOpen(o => !o);
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
            role="tooltip"
            className="infotip-panel"
            style={{
              top: box?.top ?? -9999,
              left: box?.left ?? -9999,
              visibility: box ? 'visible' : 'hidden'
            }}
          >
            {title && <div className="mb-1 font-semibold text-text">{title}</div>}
            <div>{text}</div>
          </div>,
          document.body
        )}
    </>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${TONE_BG[tone]}`} aria-hidden />;
}

/**
 * A dot and a word. Never a bare colour.
 *
 * `size="sm"` is for a dense table cell where the pill sits beside other badges; the default is
 * every other call site's.
 */
export function Pill({
  tone,
  children,
  title,
  size = 'md'
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
  size?: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'gap-1.5 rounded-[4px] px-1.5 py-px text-[12px]' : 'gap-2 rounded-[6px] px-2 py-[3px] text-[13px]';
  return (
    <span
      title={title}
      className={`inline-flex items-center border border-line bg-raised font-medium ${box} ${TONE_TEXT[tone]}`}
    >
      <Dot tone={tone} />
      {children}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
  flush = false
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * The card holds a table and nothing else.
   *
   * The divider and every row separator then run the full width of the card instead of stopping
   * 20px short of it, and the cells take their inline inset from `--page-x` so the first column
   * still starts directly under the card title. See `.card-body-flush` in theme.css.
   */
  flush?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head flex h-[52px] items-center justify-between gap-4 border-b border-line">
          <h2 className="text-[16px]">{title}</h2>
          {action}
        </header>
      )}
      <div className={flush ? 'card-body-flush' : 'card-body'}>{children}</div>
    </section>
  );
}

/**
 * A list of values in one table cell — comma-joined, capped, ellipsised, and hoverable.
 *
 * Written because a hand-rolled table cannot use `DataTable`'s `max`/`title` pair, and eleven cells
 * across Networking, Storage and Reliability rendered `items.join(', ')` raw: a VirtualService with
 * nine hosts made its column 700px wide and pushed every column after it off the right edge, and the
 * ones that had been given `truncate` cut the value off with no way to read the rest.
 *
 * The cap is the cell's, not this span's — a `max-width` on an inline element inside a
 * `table-layout: auto` cell does not stop the column growing. So the `td` carries
 * `max-w-[Npx] truncate` and this carries the tooltip, which is the half that cannot be done in CSS.
 */
export function CellList({
  items,
  empty = '—',
  className = ''
}: {
  items: readonly (string | null | undefined)[];
  /** What to show when the list is empty. A fact ("mesh", "None"), never a fabricated zero. */
  empty?: string;
  className?: string;
}) {
  const text = items.filter(Boolean).join(', ');
  return (
    <span className={className} title={text || undefined}>
      {text || empty}
    </span>
  );
}

/**
 * A two-part metric — `9m / 500m`, `130 MiB / 477 MiB`, `35 / 50` — with the separator on a column.
 *
 * Right-aligning the whole string looks correct and is not: the two operands have independent widths,
 * so the separator lands somewhere different on every row. Measured on the Workloads table before
 * this existed, the `/` moved across 25px in the CPU column and 50px in memory, which is exactly the
 * wobble that makes a dense table read as unaligned even though every cell is flush right.
 *
 * `.pair` is a three-track grid that fills the cell: `1fr auto 1fr` puts the separator at the same x
 * on every row of the column, with the first value flush against it and the second reading away from
 * it. That is also why a paired column is centre-aligned rather than right — the header centres over
 * the separator instead of sitting above the second operand's last digit.
 *
 * Both halves are nowrap and ellipsised, so a long value clips rather than pushing the separator.
 * The separator is a real character, not `aria-hidden`: "nine milli slash five hundred milli" is the
 * ratio, and a screen reader that reads the two numbers with nothing between them loses it.
 */
export function Pair({
  a,
  b,
  sep = '/',
  title,
  className = ''
}: {
  a: ReactNode;
  b: ReactNode;
  /** The separator. `/` for a ratio, `→` for a transition. */
  sep?: string;
  title?: string;
  className?: string;
}) {
  return (
    <span className={`pair mono ${className}`} title={title}>
      <span className="pair-a">{a}</span>
      <span className="pair-sep">{sep}</span>
      <span className="pair-b">{b}</span>
    </span>
  );
}

/** A 6px utilisation bar. The fill colour is the band, never the brand violet. */export function CapacityBar({
  used,
  total,
  pct,
  label
}: {
  used: string;
  total: string;
  pct: number | null;
  label: string;
}) {
  const tone = band(pct);
  const width = pct === null ? 0 : Math.min(100, pct);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] text-muted">{label}</span>
        <span className="mono num">
          {used} / {total} <span className={TONE_TEXT[tone]}>({percent(pct)})</span>
        </span>
      </div>
      <div
        className="h-[6px] w-full overflow-hidden rounded-[3px] bg-raised"
        role="meter"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} utilisation`}
      >
        <div className={`h-full ${TONE_BG[tone]}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

/** A designed empty state: one sentence, and the single action that resolves it. */
export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 page-x py-14 text-center">
      <p className="text-[16px] font-medium">{title}</p>
      {hint && <p className="max-w-[46ch] text-[14px] text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * The one place the console offers a way out of a lapsed SSO session.
 *
 * `retryAuthentication()` clears the reload cooldown and reloads, so it is the whole action —
 * a caller must not also re-run its own fetch. Rendered only for SESSION_LOST: a retry button
 * on an UPSTREAM 500 or a FORBIDDEN is a lie, because retrying changes nothing about either.
 *
 * Gated on the `code` string rather than on `isSessionLost(err)` so that every existing
 * ErrorState and ErrorBanner call site gains it without being touched — they all already pass
 * `code`. The trade is that a caller inventing its own 'SESSION_LOST' string would get a
 * button it did not mean; nothing does, and the alternative was threading the error object
 * through a dozen call sites.
 */
function SessionRetry({ code }: { code: string }) {
  if (code !== SESSION_LOST) return null;
  return (
    <Btn variant="primary" onClick={retryAuthentication} title="Reload and sign in again">
      Sign in again
    </Btn>
  );
}

/**
 * One labelled line of the error template. Label left, prose right, so the four parts of every
 * error land in the same places on every surface and a reader learns the shape once.
 */
function ErrorLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <div className="shrink-0 pt-px text-[12px] font-semibold uppercase tracking-[0.06em] text-muted sm:w-[116px]">
        {label}
      </div>
      <div className="min-w-0 max-w-[80ch] text-[13px] leading-[1.6] text-text">{children}</div>
    </div>
  );
}

/**
 * The failure state — one unreachable cluster inside an otherwise working page, or a whole-page
 * read that failed.
 *
 * Every error reads the same four ways: what went wrong in plain language, what it means for what
 * is on screen, what to do next, and the backend's own words verbatim. The copy comes from
 * `explainError` so that all ~22 call sites say the same thing about the same code; this component
 * only lays it out. The previous version printed `CODE` and the raw upstream sentence, which is
 * accurate and tells an operator neither what it means nor who fixes it.
 *
 * `detail` is never dropped. It is the line someone quotes in a ticket, and paraphrasing an
 * upstream message is how a UI starts asserting causes it never observed.
 */
export function ErrorState({
  cluster,
  code,
  message,
  needsReseed,
  command
}: {
  cluster?: string;
  code: string;
  message: string;
  needsReseed?: boolean;
  command?: string;
}) {
  const e = explainError(code);
  return (
    <div className="flex flex-col items-start gap-3.5 page-x py-10">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        {/* `needsReseed` outranks the copy's own tone: a broken credential chain is the one state
            where the cluster stays dark until a human acts, whatever the code's usual severity. */}
        <Dot tone={needsReseed ? 'bad' : e.tone === 'info' ? 'unknown' : e.tone} />
        <span className="text-[16px] font-medium text-text">{e.title}</span>
        {cluster && (
          <span className="mono text-[13px] text-muted" title="Cluster this applies to">
            {cluster}
          </span>
        )}
      </div>

      <div className="flex w-full flex-col gap-2">
        <ErrorLine label="What it means">{e.meaning}</ErrorLine>
        <ErrorLine label="What to do">{e.action}</ErrorLine>
        <ErrorLine label="Reported as">
          <span className="mono">
            <span className="text-warn">{code}</span>
            {message ? <span className="text-muted"> — {message}</span> : null}
          </span>
        </ErrorLine>
      </div>

      {command && (
        <pre className="mono w-full overflow-x-auto rounded-[6px] border border-line bg-bg px-3 py-2 text-[13px] text-text">
          {command}
        </pre>
      )}
      <SessionRetry code={code} />
    </div>
  );
}

/**
 * The inline, page-level failure banner — for a whole-page fetch that failed, where ErrorState's
 * full template would push the page's own content off screen.
 *
 * It carries the same title and the same code, and the `action` line as a tooltip rather than a
 * fourth row: the banner has one line of vertical space, and losing the code entirely (which an
 * earlier hand-rolled version did) leaves the operator a sentence with nothing to quote.
 */
export function ErrorBanner({ code, message }: { code: string; message: string }) {
  const e = explainError(code);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[8px] border border-line bg-raised px-4 py-3 text-[14px]">
      <Dot tone={e.tone === 'info' ? 'unknown' : e.tone} />
      <span className="font-medium text-text" title={e.meaning}>
        {e.title}
      </span>
      <span className="mono text-[12px] text-warn" title={e.action}>
        {code}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted" title={message}>
        {message}
      </span>
      <SessionRetry code={code} />
    </div>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-[36px] animate-pulse rounded-[6px] bg-raised" />
      ))}
    </div>
  );
}

/**
 * Catches a render-time throw from one tab's body — e.g. a collector field the UI assumed
 * was always an array coming back `undefined` — and shows an in-page error instead of
 * unmounting the whole app to a solid background. Error boundaries only work as class
 * components (no hook equivalent exists); `resetKey` remounts the boundary (clearing the
 * caught error) whenever the caller passes a new value, which ClusterDetail uses to recover
 * automatically on tab switch rather than leaving the banner stuck forever.
 */
export class TabErrorBoundary extends Component<
  { children: ReactNode; label: string; resetKey?: string | number },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string | number }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page-x py-4">
          <ErrorBanner code="RENDER_ERROR" message={`${this.props.label} failed to render: ${this.state.error.message}`} />
        </div>
      );
    }
    return this.props.children;
  }
}

export function Btn({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title
}: {
  children: ReactNode;
  onClick?: () => void;
  /**
   * `danger` exists for exactly one control — de-registering a cluster on the Credentials tab.
   * This console is read-only against clusters, so a red button anywhere else would be
   * claiming a destructiveness it does not have; keep it rare enough that it still reads as a
   * warning rather than as decoration.
   */
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  const base =
    'inline-flex h-8 items-center gap-2 rounded-[6px] px-3 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45';
  const style =
    variant === 'primary'
      ? 'bg-accent text-white hover:bg-accent-hover'
      : variant === 'danger'
        ? 'border border-bad/50 bg-bad/10 text-bad hover:bg-bad/20'
        : 'border border-line bg-raised text-text hover:border-line-strong';
  return (
    <button type="button" className={`${base} ${style}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}
