/**
 * The order the pod list is read in, and the follow rule for the log beside it.
 *
 * Both are decisions about *attention*, which is why they are here rather than inline in the
 * component: they are the two places where the tab either points the operator at the right line or
 * fights them for control of the scrollbar, and neither is checkable from a screenshot.
 */
import type { LogPod } from '../../api';

/**
 * How close to the newest line still counts as being *at* it, in px. Roughly three lines at
 * 13px/1.55 leading, which is the slack a trackpad's momentum needs: landing 6px short of the edge
 * must not read as "the reader has scrolled away and wants to be left alone".
 */
export const TAIL_SLACK_PX = 40;

/** The orders the pod list offers. `newest` is the default; see {@link comparePods}. */
export type PodOrder = 'newest' | 'problems' | 'name';

export const POD_ORDERS: { id: PodOrder; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'problems', label: 'Problems first' },
  { id: 'name', label: 'Name' }
];

export function isPodOrder(v: string | null): v is PodOrder {
  return v === 'newest' || v === 'problems' || v === 'name';
}

export const DEFAULT_POD_ORDER: PodOrder = 'newest';

/** Unhappy first — the server's own order, restated here so `problems` does not depend on it. */
function trouble(p: LogPod): number {
  if (p.phase !== 'Running' && p.phase !== 'Succeeded') return 0;
  if (p.restarts > 0) return 1;
  return 2;
}

function startedMs(p: LogPod): number {
  if (!p.startedAt) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(p.startedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

const byName = (a: LogPod, b: LogPod) =>
  (a.namespace + '/' + a.name).localeCompare(b.namespace + '/' + b.name);

/**
 * How two pods compare, per order.
 *
 * `newest` is the default because the pod an operator opens this tab to read is almost always the
 * one that just started — a rollout, a restart, a job that fired a minute ago — and the collector's
 * own order (`problems`, then alphabetical) buried it: a freshly restarted pod is `Running` with a
 * restart count, which ranks it in the middle of a list of 200, alphabetically, where it is
 * indistinguishable from every long-lived neighbour.
 *
 * A pod with no `startedAt` (pending, never scheduled) sorts *last* under `newest` rather than
 * first. Treating an unknown start time as "infinitely recent" would put exactly the pods with no
 * log to read at the top of a list whose purpose is finding a log — and unknown is not newest.
 * It still surfaces immediately under `problems`, which is the order that ranks by state.
 */
export function comparePods(order: PodOrder): (a: LogPod, b: LogPod) => number {
  if (order === 'name') return byName;
  if (order === 'problems') return (a, b) => trouble(a) - trouble(b) || byName(a, b);
  return (a, b) => startedMs(b) - startedMs(a) || byName(a, b);
}

/** The list in the requested order. Never mutates the payload the cache is holding. */
export function orderPods(pods: readonly LogPod[], order: PodOrder): LogPod[] {
  return [...pods].sort(comparePods(order));
}

/**
 * Which end of the log pane holds the newest line.
 *
 * `newest` puts it at the top: the pane opens on the most recent line, and scrolling *down* walks
 * backwards in time. That is the default because the question this tab is opened to answer is
 * almost always "what did it just say?", and finding that at the bottom of a 2,000-line pane means
 * either trusting an auto-scroll or dragging to the end.
 *
 * `oldest` is the order the container actually wrote, and it stays available for one specific
 * reason: a multi-line record only reads correctly in write order. A Java stack trace, a Go panic, a
 * wrapped YAML error — reversing the lines prints the innermost frame first and the exception
 * message last, which is precisely backwards for the one kind of output an operator most needs to
 * read carefully. Reversal is a per-line operation and a stack trace is not one line, so this is a
 * real limitation of `newest` rather than a preference; the control is how a reader escapes it.
 */
export type LogDirection = 'newest' | 'oldest';

export const LOG_DIRECTIONS: { id: LogDirection; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' }
];

export const DEFAULT_LOG_DIRECTION: LogDirection = 'newest';

export function isLogDirection(v: string | null): v is LogDirection {
  return v === 'newest' || v === 'oldest';
}

/** The edge of the scroller the newest line sits at. */
export function tailEdge(dir: LogDirection): 'top' | 'bottom' {
  return dir === 'newest' ? 'top' : 'bottom';
}

/**
 * The lines in reading order for `dir`.
 *
 * The server sends them oldest-first, as the container wrote them, and that is left untouched for
 * `oldest`. Copies rather than reverses in place — the array belongs to the response cache.
 */
export function orderLines<T>(lines: readonly T[], dir: LogDirection): T[] {
  return dir === 'newest' ? [...lines].reverse() : [...lines];
}

/**
 * The order the server sends lines in: oldest first, as the container wrote them. Named because the
 * watermark below counts against the *stream*, which never changes orientation, rather than against
 * whatever the reader has the view flipped to.
 */
export const SERVER_ORDER: LogDirection = 'oldest';

/**
 * A line's identity, for telling "these are the same lines again" from "these are new lines".
 *
 * `at` alone is not enough — a busy proxy writes several lines in the same millisecond, and some
 * runtimes emit no timestamp at all — so the message is part of the key. Length-prefixed rather
 * than joined by a separator: no printable character is safe to reserve when one half is arbitrary
 * log output, and control characters are not allowed in this source tree.
 */
export function lineKey(l: { at: string | null; message: string }): string {
  const at = l.at ?? '';
  return `${at.length}:${at}${l.message}`;
}

/** The identity of the newest line in a window, or null when the window is empty. */
export function newestKey<T>(
  lines: readonly T[],
  dir: LogDirection,
  key: (l: T) => string
): string | null {
  const newest = lines[tailEdge(dir) === 'top' ? 0 : lines.length - 1];
  return newest === undefined ? null : key(newest);
}

/**
 * How many lines arrived since the one identified by `since`.
 *
 * Counted by *identity*, not by array length. Length is what the first version used and it is wrong
 * the moment it matters: a tail is a fixed-size window, so on a busy container the array sits
 * permanently at `tailLines` and its length stops changing while every line inside it turns over.
 * The reader was then told "0 new" while thousands scrolled past — measured live at `tail=100` on
 * an ingress gateway, where the control read "Jump to latest" with no count for as long as it was
 * watched.
 *
 * `since === null` is the first read of a subject and counts as nothing new; there is no "before"
 * for it to have arrived after. A `since` that is nowhere in the window means the whole window
 * rolled over between reads, and every line in it is new — the honest answer, and it under-states
 * rather than over-states, because more than a windowful may have gone by unseen.
 *
 * One bounded inaccuracy, accepted deliberately: a container that writes the identical line twice
 * in the same millisecond is indistinguishable, so a run of exact duplicates can be under-counted.
 * The alternative is a sequence number the log API does not carry.
 */
export function countNewSince<T>(opts: {
  since: string | null;
  lines: readonly T[];
  /** Which end of `lines` is the newest. */
  dir: LogDirection;
  key: (l: T) => string;
}): number {
  const { since, lines, dir, key } = opts;
  if (since === null) return 0;
  const newestFirst = tailEdge(dir) === 'top';
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const l = lines[newestFirst ? i : n - 1 - i];
    if (l !== undefined && key(l) === since) return i;
  }
  return n;
}

/** Scroll geometry, as the three numbers any scroller can report. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Is the reader sitting at the newest line?
 *
 * Direction-aware on purpose: with `newest` the tail is `scrollTop === 0`, and asking the
 * bottom-anchored question there would report "not at the tail" the instant the pane opened — which
 * would put a "Jump to latest" control on screen pointing at the line already under the cursor.
 */
export function atTail(m: ScrollMetrics, dir: LogDirection): boolean {
  if (tailEdge(dir) === 'top') return m.scrollTop <= TAIL_SLACK_PX;
  return m.scrollHeight - m.scrollTop - m.clientHeight <= TAIL_SLACK_PX;
}

/**
 * Whether the log view should jump to the newest line after a read.
 *
 * The rule is *not* "follow while polling". That was the first version and it is wrong in both
 * directions: it fights a reader who scrolled away to read a stack trace while the tail is running,
 * and it strands a reader sitting at the newest line who pressed Reload with auto-refresh off. What
 * decides it is where the reader already is —
 *
 *   - at the newest line → follow. They are watching the tail, whether a timer or a button fetched
 *     it. Which edge that is depends on {@link LogDirection}; see {@link atTail}.
 *   - scrolled away → do not move. They are reading, and their place is the thing to protect. New
 *     lines still arrive; `newLines` is how the UI says so without moving them.
 *   - new subject → follow. A different pod is a different log, and it has no place to keep.
 *
 * `polling` is deliberately absent as an argument. It changes how *often* this is asked and whether
 * the paused affordance is worth showing — see {@link tailPausedLabel} — never the answer.
 */
export function shouldFollowTail(opts: {
  /** The reader is within {@link TAIL_SLACK_PX} of the newest line. */
  atTail: boolean;
  /** A different pod or container than the last render. */
  subjectChanged: boolean;
}): boolean {
  return opts.subjectChanged || opts.atTail;
}

/**
 * What to call the control that returns a scrolled-away reader to the newest line, or null to hide
 * it, and which way the arrow points.
 *
 * Hidden when the reader is already at the newest line (there is nothing to jump to). The count is
 * the informative part — an always-present button that says only "Jump to latest" is one more thing
 * on screen that tells the operator nothing.
 */
export function tailPausedLabel(opts: {
  atTail: boolean;
  newLines: number;
  dir: LogDirection;
}): { text: string; arrow: '↑' | '↓' } | null {
  if (opts.atTail) return null;
  const arrow = tailEdge(opts.dir) === 'top' ? '↑' : '↓';
  const text =
    opts.newLines > 0
      ? `Jump to latest · ${opts.newLines.toLocaleString()} new`
      : 'Jump to latest';
  return { text, arrow };
}

