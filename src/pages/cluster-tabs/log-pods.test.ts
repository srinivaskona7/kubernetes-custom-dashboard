/**
 * Pod ordering and the tail-follow rule — the two places this tab either points the operator at the
 * right thing or fights them for the scrollbar.
 */
import { describe, expect, it } from 'vitest';
import type { LogPod } from '../../api';
import {
  DEFAULT_LOG_DIRECTION,
  DEFAULT_POD_ORDER,
  LOG_DIRECTIONS,
  POD_ORDERS,
  SERVER_ORDER,
  TAIL_SLACK_PX,
  atTail,
  comparePods,
  countNewSince,
  isLogDirection,
  isPodOrder,
  lineKey,
  newestKey,
  orderLines,
  orderPods,
  shouldFollowTail,
  tailEdge,
  tailPausedLabel
} from './log-pods';

function pod(over: Partial<LogPod> = {}): LogPod {
  return {
    name: 'a',
    namespace: 'ns',
    cluster: 'c1',
    node: 'node-1',
    phase: 'Running',
    restarts: 0,
    startedAt: '2026-09-18T10:00:00Z',
    containers: [],
    ...over
  };
}

describe('isPodOrder', () => {
  it('accepts the three orders and rejects anything else', () => {
    expect(isPodOrder('newest')).toBe(true);
    expect(isPodOrder('problems')).toBe(true);
    expect(isPodOrder('name')).toBe(true);
    // A hand-edited or stale URL must fall back, not sort by an order that does not exist.
    expect(isPodOrder('oldest')).toBe(false);
    expect(isPodOrder('')).toBe(false);
    expect(isPodOrder(null)).toBe(false);
  });

  it('offers exactly the orders it can execute', () => {
    expect(POD_ORDERS.map(o => o.id).sort()).toEqual(['name', 'newest', 'problems']);
    expect(isPodOrder(DEFAULT_POD_ORDER)).toBe(true);
  });
});

describe('orderPods — newest', () => {
  const old_ = pod({ name: 'old', startedAt: '2026-09-01T00:00:00Z' });
  const mid = pod({ name: 'mid', startedAt: '2026-09-15T00:00:00Z' });
  const fresh = pod({ name: 'fresh', startedAt: '2026-09-18T11:59:00Z' });

  it('puts the most recently started pod first', () => {
    expect(orderPods([old_, fresh, mid], 'newest').map(p => p.name)).toEqual(['fresh', 'mid', 'old']);
  });

  it('sorts a pod with no start time LAST, not first', () => {
    // Unknown is not newest. Ranking it first would put exactly the pods with no log to read at the
    // top of a list whose entire purpose is finding a log.
    const pending = pod({ name: 'pending', phase: 'Pending', startedAt: null });
    expect(orderPods([pending, old_, fresh], 'newest').map(p => p.name)).toEqual([
      'fresh',
      'old',
      'pending'
    ]);
  });

  it('treats an unparseable timestamp the same as a missing one', () => {
    const junk = pod({ name: 'junk', startedAt: 'not-a-date' });
    expect(orderPods([junk, old_], 'newest').map(p => p.name)).toEqual(['old', 'junk']);
  });

  it('breaks an exact tie by namespace/name, so the order is stable across polls', () => {
    const at = '2026-09-18T10:00:00Z';
    const rows = [
      pod({ name: 'b', namespace: 'x', startedAt: at }),
      pod({ name: 'a', namespace: 'x', startedAt: at }),
      pod({ name: 'a', namespace: 'w', startedAt: at })
    ];
    expect(orderPods(rows, 'newest').map(p => `${p.namespace}/${p.name}`)).toEqual([
      'w/a',
      'x/a',
      'x/b'
    ]);
  });
});

describe('orderPods — problems and name', () => {
  const healthy = pod({ name: 'healthy' });
  const restarted = pod({ name: 'restarted', restarts: 4 });
  const crashing = pod({ name: 'crashing', phase: 'CrashLoopBackOff' });
  const done = pod({ name: 'done', phase: 'Succeeded' });

  it('ranks not-running, then restarted, then healthy', () => {
    expect(orderPods([healthy, restarted, crashing], 'problems').map(p => p.name)).toEqual([
      'crashing',
      'restarted',
      'healthy'
    ]);
  });

  it('does not treat a completed pod as a problem', () => {
    // Succeeded is a Job that finished, not an incident.
    expect(orderPods([crashing, done], 'problems').map(p => p.name)).toEqual(['crashing', 'done']);
    expect(orderPods([done, restarted], 'problems').map(p => p.name)).toEqual(['restarted', 'done']);
  });

  it('sorts by namespace then name, ignoring state and age entirely', () => {
    const rows = [
      pod({ name: 'zeta', namespace: 'a', phase: 'CrashLoopBackOff' }),
      pod({ name: 'alpha', namespace: 'b', startedAt: '2026-09-18T11:00:00Z' })
    ];
    expect(orderPods(rows, 'name').map(p => p.name)).toEqual(['zeta', 'alpha']);
  });

  it('never mutates the array the cache is holding', () => {
    const rows = [pod({ name: 'b' }), pod({ name: 'a' })];
    orderPods(rows, 'name');
    expect(rows.map(p => p.name)).toEqual(['b', 'a']);
  });

  it('exposes a comparator, so the sort is testable without an array', () => {
    expect(comparePods('name')(pod({ name: 'a' }), pod({ name: 'b' }))).toBeLessThan(0);
  });
});

describe('orderLines', () => {
  const wire = ['first', 'second', 'third'];

  it('leaves the container\'s own write order alone for oldest-first', () => {
    expect(orderLines(wire, 'oldest')).toEqual(['first', 'second', 'third']);
  });

  it('reverses for newest-first, so the most recent line is lines[0]', () => {
    expect(orderLines(wire, 'newest')).toEqual(['third', 'second', 'first']);
  });

  it('never mutates the array the response cache is holding', () => {
    const held = [...wire];
    orderLines(held, 'newest');
    expect(held).toEqual(wire);
  });
});

describe('tailEdge / atTail', () => {
  it('puts the newest line at the top for newest-first, the bottom for oldest-first', () => {
    expect(tailEdge('newest')).toBe('top');
    expect(tailEdge('oldest')).toBe('bottom');
  });

  // A 3000px-tall log in a 700px pane.
  const m = (scrollTop: number) => ({ scrollTop, scrollHeight: 3000, clientHeight: 700 });

  it('newest-first: the tail is scrollTop 0, within the slack', () => {
    expect(atTail(m(0), 'newest')).toBe(true);
    expect(atTail(m(TAIL_SLACK_PX), 'newest')).toBe(true);
    expect(atTail(m(TAIL_SLACK_PX + 1), 'newest')).toBe(false);
    expect(atTail(m(2300), 'newest')).toBe(false);
  });

  it('oldest-first: the tail is the far end', () => {
    expect(atTail(m(2300), 'oldest')).toBe(true);
    expect(atTail(m(2300 - TAIL_SLACK_PX), 'oldest')).toBe(true);
    expect(atTail(m(2300 - TAIL_SLACK_PX - 1), 'oldest')).toBe(false);
    expect(atTail(m(0), 'oldest')).toBe(false);
  });

  it('reports the tail when the log is too short to scroll, in either direction', () => {
    // scrollHeight === clientHeight. Both edges are the same place, and it is the tail.
    const short = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };
    expect(atTail(short, 'newest')).toBe(true);
    expect(atTail(short, 'oldest')).toBe(true);
  });
});

describe('shouldFollowTail', () => {
  it('follows when the reader is on the newest line', () => {
    expect(shouldFollowTail({ atTail: true, subjectChanged: false })).toBe(true);
  });

  it('leaves a reader who scrolled away exactly where they are', () => {
    expect(shouldFollowTail({ atTail: false, subjectChanged: false })).toBe(false);
  });

  it('always jumps to the newest line on a new subject', () => {
    // A different pod is a different log; it has no place to keep.
    expect(shouldFollowTail({ atTail: false, subjectChanged: true })).toBe(true);
  });
});

describe('tailPausedLabel', () => {
  it('shows nothing while the reader is already on the newest line', () => {
    expect(tailPausedLabel({ atTail: true, newLines: 0, dir: 'newest' })).toBeNull();
    expect(tailPausedLabel({ atTail: true, newLines: 900, dir: 'oldest' })).toBeNull();
  });

  it('names the count of lines banked away from the reader', () => {
    expect(tailPausedLabel({ atTail: false, newLines: 1, dir: 'newest' })?.text).toBe(
      'Jump to latest · 1 new'
    );
    expect(tailPausedLabel({ atTail: false, newLines: 1234, dir: 'newest' })?.text).toBe(
      'Jump to latest · 1,234 new'
    );
  });

  it('points the arrow at the edge the newest line is actually on', () => {
    expect(tailPausedLabel({ atTail: false, newLines: 3, dir: 'newest' })?.arrow).toBe('↑');
    expect(tailPausedLabel({ atTail: false, newLines: 3, dir: 'oldest' })?.arrow).toBe('↓');
  });

  it('still offers the jump when nothing new arrived', () => {
    expect(tailPausedLabel({ atTail: false, newLines: 0, dir: 'newest' })?.text).toBe('Jump to latest');
  });
});

describe('LOG_DIRECTIONS', () => {  it('offers exactly the directions it can execute, and validates the URL param', () => {
    expect(LOG_DIRECTIONS.map(d => d.id).sort()).toEqual(['newest', 'oldest']);
    expect(isLogDirection(DEFAULT_LOG_DIRECTION)).toBe(true);
    expect(isLogDirection('desc')).toBe(false);
    expect(isLogDirection(null)).toBe(false);
  });

  it('defaults to newest-first', () => {
    expect(DEFAULT_LOG_DIRECTION).toBe('newest');
  });
});

/**
 * The regression this suite exists for: the count used to be `lines.length - lastLength`, which is
 * permanently 0 once a busy container fills the tail window. Measured live at `tail=100` on an
 * ingress gateway — the control read "Jump to latest" with no count while the whole window turned
 * over.
 */
describe('countNewSince', () => {
  const L = (message: string, at: string | null = null) => ({ at, message });
  const key = lineKey;

  it('counts nothing on the first read of a subject', () => {
    expect(countNewSince({ since: null, lines: [L('a'), L('b')], dir: 'oldest', key })).toBe(0);
  });

  it('counts the lines that arrived after the watermark', () => {
    const before = [L('a'), L('b'), L('c')];
    const after = [L('a'), L('b'), L('c'), L('d'), L('e')];
    const mark = newestKey(before, 'oldest', key);
    expect(countNewSince({ since: mark, lines: after, dir: 'oldest', key })).toBe(2);
  });

  it('still counts when the array length never changes — the tail-cap case', () => {
    // A window of 3 at the cap: 'a' fell off the front, 'd' arrived at the back. Length is identical
    // before and after, which is exactly what the old length-based counter could not see.
    const before = [L('a'), L('b'), L('c')];
    const after = [L('b'), L('c'), L('d')];
    expect(before.length).toBe(after.length);
    const mark = newestKey(before, 'oldest', key);
    expect(countNewSince({ since: mark, lines: after, dir: 'oldest', key })).toBe(1);
  });

  it('reports the whole window when the watermark has rolled off entirely', () => {
    const mark = newestKey([L('a')], 'oldest', key);
    const after = [L('x'), L('y'), L('z')];
    expect(countNewSince({ since: mark, lines: after, dir: 'oldest', key })).toBe(3);
  });

  it('reports 0 when nothing arrived between two reads', () => {
    const w = [L('a'), L('b')];
    expect(countNewSince({ since: newestKey(w, 'oldest', key), lines: w, dir: 'oldest', key })).toBe(
      0
    );
  });

  it('walks from whichever end holds the newest line', () => {
    // Same window, presented newest-first. The answer must not change with the reader's view.
    const before = [L('c'), L('b'), L('a')];
    const after = [L('e'), L('d'), L('c'), L('b'), L('a')];
    const mark = newestKey(before, 'newest', key);
    expect(countNewSince({ since: mark, lines: after, dir: 'newest', key })).toBe(2);
  });

  it('handles an empty window without inventing a watermark', () => {
    expect(newestKey([], 'oldest', key)).toBeNull();
    expect(newestKey([], 'newest', key)).toBeNull();
    expect(countNewSince({ since: 'anything', lines: [], dir: 'oldest', key })).toBe(0);
  });

  it('tells two lines apart by timestamp as well as by message', () => {
    expect(key(L('same', '2026-09-18T10:00:00Z'))).not.toBe(key(L('same', '2026-09-18T10:00:01Z')));
    expect(key(L('a', null))).not.toBe(key(L('a', '2026-09-18T10:00:00Z')));
  });

  it('cannot be spoofed by a message that looks like the key encoding', () => {
    // Length-prefixed, so a message beginning with digits and a colon cannot forge a different
    // timestamp. `at` is 20 chars here; a naive separator join would collide.
    const a = { at: '2026-09-18T10:00:00Z', message: 'x' };
    const b = { at: null, message: '20:2026-09-18T10:00:00Zx' };
    expect(key(a)).not.toBe(key(b));
  });

  it('names the server order, so the watermark never depends on the view', () => {
    // The API sends oldest-first. Flipping the reader's `dir` must not re-key the stream.
    expect(SERVER_ORDER).toBe('oldest');
  });
});
