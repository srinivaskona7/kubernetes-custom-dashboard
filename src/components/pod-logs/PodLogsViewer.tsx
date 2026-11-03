/**
 * The log pane. One implementation, used by the Live Pod Logs tab and by the bottom drawer.
 *
 * It was the `LogBody` inside `LogsTab`, moved here unchanged in behaviour so that the drawer could
 * not become a second, worse log viewer. Everything subtle about reading a live log lives in this
 * one component:
 *
 * - **Its own scroller.** `overflow-auto overscroll-contain` on the pane and nothing else: the page
 *   behind it never scrolls, and a wheel event that reaches the pane's end does not chain outwards
 *   into the pod table. That is the whole of the "only the log viewer scrolls" requirement — it is a
 *   property of this element, not of the page that mounts it.
 * - **It never steals the scrollbar.** A reader who has scrolled away from the newest line keeps
 *   their position across every poll; what arrived is banked and offered as a count.
 * - **The count is by line identity, not array length** — see `countNewSince`, which documents why
 *   length is wrong exactly when a tail window is full and turning over.
 *
 * Two copies of "is the reader at the tail" are deliberate and documented at `onTail` below.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LogLine, LogPod } from '../../api';
import { Empty, ErrorState, Skeleton } from '../ui';
import { ago } from '../../format';
import { logCutSentences } from './log-cut';
import {
  SERVER_ORDER,
  atTail,
  countNewSince,
  lineKey,
  newestKey,
  shouldFollowTail,
  tailEdge,
  tailPausedLabel,
  type LogDirection
} from '../../pages/cluster-tabs/log-pods';

const LEVEL_CLASS: Record<string, string> = {
  fatal: 'text-bad',
  error: 'text-bad',
  warn: 'text-warn',
  debug: 'text-muted'
};

export interface PodLogsViewerProps {
  loading: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /** What to render: filtered and ordered for reading. */
  lines: LogLine[];
  /**
   * The same read, unfiltered and in the server's own order. Only the new-line watermark uses it:
   * it changes exactly once per read, so it distinguishes "the log moved" from "the reader typed in
   * the filter box", which `lines` cannot.
   */
  stream: readonly LogLine[];
  /** Lines in the window before any filter — the denominator the footer reports. */
  total: number;
  truncated: boolean;
  /** The byte ceiling was reached — see `logCutSentences`. */
  bytesTruncated?: boolean;
  /** Lines the byte cut sliced through and had to discard. */
  partialLinesDropped?: number;
  fetchedAt: string | null;
  /** Whether a text or level filter is narrowing the view, so the footer says "N of M". */
  filtered: boolean;
  /** Lines the level floor removed for carrying no level at all. Reported, never swallowed. */
  unclassified: number;
  /** Other containers to offer when this one has written nothing. */
  siblings: LogPod['containers'];
  /** Which edge `lines[0]` is at. `lines` arrive already ordered; this says which end is newest. */
  dir: LogDirection;
  /** Which log this is. Changing it is a new subject, not new lines for the same one. */
  streamKey: string;
  onSwitchContainer: (name: string) => void;
  /** Extra footer content, right of the read time. The drawer puts its Live Pod Logs link here. */
  footerExtra?: ReactNode;
}

export function PodLogsViewer({
  loading,
  errorCode,
  errorMessage,
  lines,
  stream,
  total,
  truncated,
  bytesTruncated,
  partialLinesDropped,
  fetchedAt,
  filtered,
  unclassified,
  siblings,
  dir,
  streamKey,
  onSwitchContainer,
  footerExtra
}: PodLogsViewerProps): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  // Two copies of one fact, deliberately.
  //
  // The effect below needs the reader's position *synchronously*, during a render triggered by new
  // lines, which rules out state alone — a stale `atTail` there would scroll a reader who had just
  // moved. But the jump control has to *render*, and mutating a ref triggers nothing: the first
  // version kept only the ref, and the control never appeared no matter how far the reader scrolled,
  // because React had no reason to re-render. So the ref is the truth the effect reads and the state
  // is what the JSX reads, and `setTail` is the one place that writes both.
  const onTail = useRef(true);
  const [tailVisible, setTailVisible] = useState(true);
  const setTail = useCallback((v: boolean) => {
    onTail.current = v;
    setTailVisible(v);
  }, []);
  // `newLines` is what makes not-following bearable: the reader keeps their place *and* is told what
  // accumulated at the far edge. Counted by line identity against a watermark, never by array
  // length — see `countNewSince`, which documents why length is wrong exactly when it matters.
  const [newLines, setNewLines] = useState(0);
  const seen = useRef<string | null>(null);

  // Where "the newest line" is, in scroll offsets. Top for newest-first, bottom for oldest-first —
  // the single place the direction turns into geometry.
  const toTail = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = tailEdge(dir) === 'top' ? 0 : el.scrollHeight;
    setTail(true);
    setNewLines(0);
  }, [dir, setTail]);

  // Selecting a different pod or container — or flipping the order — is a different view, and it
  // must open on the newest line. Both pieces of scroll state survive the switch otherwise:
  // `onTail` because it is a ref, and the scroll offset itself because React reuses the same
  // scroller node. Without this, a reader who had scrolled away from pod A's tail got pod B's log
  // opened 4,000 lines from the newest, with nothing saying why.
  useEffect(() => {
    seen.current = null;
    toTail();
  }, [streamKey, toTail]);

  // Every read: follow the tail, or bank what arrived away from the reader. `shouldFollowTail` owns
  // the decision (see log-pods.ts) — notably it does *not* consult auto-refresh, because where the
  // reader is standing is what decides, not what fetched the lines.
  //
  // Keyed on `stream`, the unfiltered window, for two reasons. It is the thing that changes once per
  // read, so this runs on polls and not on keystrokes in the line filter; and the watermark has to
  // track the stream rather than the view, or typing a filter would erase the reference line and
  // report the whole window as new.
  useEffect(() => {
    const grew = countNewSince({
      since: seen.current,
      lines: stream,
      dir: SERVER_ORDER,
      key: lineKey
    });
    seen.current = newestKey(stream, SERVER_ORDER, lineKey);
    if (shouldFollowTail({ atTail: onTail.current, subjectChanged: false })) {
      const el = box.current;
      if (el) el.scrollTop = tailEdge(dir) === 'top' ? 0 : el.scrollHeight;
      setNewLines(0);
    } else if (grew > 0) {
      setNewLines(n => n + grew);
    }
    // `dir` is intentionally not a dependency: a direction change arrives as a new `streamKey`,
    // which re-anchors above. Listing it here would run this branch a second time on the old lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  const jump = tailPausedLabel({ atTail: tailVisible, newLines, dir });

  if (loading) return <Skeleton rows={12} />;
  if (errorCode) return <ErrorState code={errorCode} message={errorMessage ?? ''} />;
  if (total === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <Empty
          title="No output"
          hint="This container has written nothing to stdout or stderr in the tail window — some apps (the approuter among them) only emit access-log lines below INFO level."
        />
        {siblings.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <span className="text-[12px] text-muted">Try:</span>
            {siblings.map(c => (
              <button
                key={c.name}
                type="button"
                onClick={() => onSwitchContainer(c.name)}
                className="mono rounded-[6px] border border-line bg-raised px-2 py-1 text-[12px] text-text transition-colors hover:border-accent hover:text-accent"
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <Empty
        title="No matching lines"
        hint={
          unclassified > 0
            ? `None of the ${total} lines match. ${unclassified} of them carry no level at all, so a severity filter cannot see them — clear it to read them.`
            : `None of the ${total} lines contain that text.`
        }
      />
    );
  }

  return (
    <>
      {/* `relative`, so the jump control can sit over the log's own bottom-right corner rather
          than in the footer — it is about where the scroll is, and it belongs where the scroll is. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={box}
          onScroll={e => {
            const el = e.currentTarget;
            const was = onTail.current;
            const now = atTail(
              { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
              dir
            );
            if (now !== was) setTail(now);
            // Scrolling back to the newest line is how a reader resumes following, so the banked
            // count is spent here rather than only by the button.
            if (now && !was) setNewLines(0);
          }}
          className="mono panel-x min-h-0 flex-1 overflow-auto overscroll-contain bg-bg py-2 text-[13px] leading-[1.55]"
        >
          {lines.map((l, i) => (
            <div key={i} className="flex gap-3 whitespace-pre-wrap break-words hover:bg-raised">
              <span className="shrink-0 select-none text-muted">
                {l.at ? new Date(l.at).toISOString().slice(11, 23) : '            '}
              </span>
              <span className={l.level ? LEVEL_CLASS[l.level] : ''}>{l.message}</span>
            </div>
          ))}
        </div>
        {jump && (
          <button
            type="button"
            onClick={toTail}
            /* Anchored to the edge the newest line is at, so the control sits next to where it will
               take the reader rather than always in the same corner. */
            className={`absolute right-4 rounded-full border border-line bg-raised px-3 py-1.5 text-[12px] text-text shadow-lg transition-colors hover:border-accent hover:text-accent ${
              tailEdge(dir) === 'top' ? 'top-3' : 'bottom-3'
            }`}
          >
            {tailEdge(dir) === 'top' ? `${jump.arrow} ${jump.text}` : `${jump.text} ${jump.arrow}`}
          </button>
        )}
      </div>
      <footer className="panel-x flex shrink-0 items-center justify-between gap-3 border-t border-line py-1.5 text-[12px] text-muted">
        <span className="mono">
          {filtered ? `${lines.length} of ${total}` : `${total}`} lines
          {/* Named, not folded in. A severity floor that hides most of a container's output while
              showing "0 lines" reads as "no errors", which is a different and wrong answer. */}
          {unclassified > 0 && <span className="ml-2">· {unclassified} with no level</span>}
          {truncated && <span className="ml-2 text-warn">truncated at the server limit</span>}
          {logCutSentences(bytesTruncated, partialLinesDropped).map(s => (
            <span key={s} className="ml-2 text-warn">
              {s}
            </span>
          ))}
        </span>
        <span className="flex items-center gap-3">
          <span className="mono">read {ago(fetchedAt)}</span>
          {footerExtra}
        </span>
      </footer>
    </>
  );
}
