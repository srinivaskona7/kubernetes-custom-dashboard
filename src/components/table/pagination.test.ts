/**
 * The paging rules, each one a bug that has shipped in somebody's console.
 *
 * Every test below names the failure it prevents rather than the function it calls. The two that
 * matter most are the clamp (a filter that shrinks the set while the operator is on page 9) and the
 * order of the pipeline (sort the whole set, *then* slice), because both produce a table that is
 * wrong while looking entirely normal.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  clampPage,
  countLabel,
  nextSort,
  pageCountOf,
  pageWindow,
  paginate,
  rangeLabel,
  rowsFingerprint,
  sortRows
} from './pagination';

const rows = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('pageCountOf', () => {
  it('is one page for an empty set, never zero', () => {
    // Zero pages means `clampPage` has no legal page to clamp to, and "page 1 of 0" is what the
    // control would print. An empty result is one empty page.
    expect(pageCountOf(0, 25)).toBe(1);
  });

  it('adds a page only when a row needs one', () => {
    expect(pageCountOf(25, 25)).toBe(1);
    expect(pageCountOf(26, 25)).toBe(2);
    expect(pageCountOf(430, 25)).toBe(18);
  });

  it('treats a nonsense page size as the default rather than dividing by it', () => {
    // A `pageSize` of 0 is division by zero and renders `Infinity` pages; negative is worse,
    // because the count goes negative and every comparison against it silently inverts.
    expect(pageCountOf(430, 0)).toBe(pageCountOf(430, DEFAULT_PAGE_SIZE));
    expect(pageCountOf(430, -5)).toBe(pageCountOf(430, DEFAULT_PAGE_SIZE));
  });
});

describe('clampPage', () => {
  it('pulls the page back when the row count shrinks under it', () => {
    // THE bug this module exists for: the operator is on page 9 of 430 groups, types into the
    // search box, and five rows match. Without this they get an empty table, no rows, no
    // explanation, and nothing on screen saying the page they are on no longer exists.
    expect(clampPage(9, 5, 25)).toBe(1);
    expect(clampPage(18, 60, 25)).toBe(3);
  });

  it('never returns a page below one', () => {
    expect(clampPage(0, 430, 25)).toBe(1);
    expect(clampPage(-4, 430, 25)).toBe(1);
  });

  it('survives a page that is not a whole number', () => {
    // A page number can arrive from a URL or from arithmetic; `NaN` propagates through `slice`
    // silently and returns an empty array, which reads on screen as "no rows matched".
    expect(clampPage(Number.NaN, 430, 25)).toBe(1);
    expect(clampPage(Number.POSITIVE_INFINITY, 430, 25)).toBe(18);
    expect(clampPage(2.7, 430, 25)).toBe(2);
  });
});

describe('paginate', () => {
  it('slices the page the operator asked for', () => {
    const p = paginate(rows(430), 2, 25);
    expect(p.rows[0]).toBe(26);
    expect(p.rows).toHaveLength(25);
    expect(p.from).toBe(26);
    expect(p.to).toBe(50);
    expect(p.total).toBe(430);
    expect(p.pageCount).toBe(18);
  });

  it('reports a short last page honestly', () => {
    const p = paginate(rows(430), 18, 25);
    expect(p.rows).toHaveLength(5);
    expect(p.from).toBe(426);
    expect(p.to).toBe(430);
  });

  it('clamps rather than returning an empty page', () => {
    // The clamp has to happen *inside* the slice, not only in the setter: state can be stale by a
    // render when the rows arrive before the page is corrected, and an empty page for one frame is
    // still a table that flashes "nothing here".
    const p = paginate(rows(5), 9, 25);
    expect(p.page).toBe(1);
    expect(p.rows).toHaveLength(5);
  });

  it('says a one-page result needs no control', () => {
    // §21: chrome for a single page of results is clutter. `many` is what the control keys off, so
    // it is asserted rather than left to the caller to recompute.
    expect(paginate(rows(25), 1, 25).many).toBe(false);
    expect(paginate(rows(26), 1, 25).many).toBe(true);
    expect(paginate([], 1, 25).many).toBe(false);
  });

  it('describes an empty set as empty rather than as page one of one row', () => {
    const p = paginate([], 1, 25);
    expect(p.rows).toEqual([]);
    expect(p.from).toBe(0);
    expect(p.to).toBe(0);
    expect(p.total).toBe(0);
  });

  it('does not copy the whole set to hand back one page', () => {
    const source = rows(430);
    const p = paginate(source, 2, 25);
    expect(source).toHaveLength(430);
    expect(p.rows).not.toBe(source);
  });
});

describe('the labels always name a denominator', () => {
  /*
    A count that shrank silently is indistinguishable from a read that returned less, which is the
    single failure this console exists to avoid. So every number the paging chrome prints carries
    the total it is a part of — enforced here rather than left to each call site.
  */
  it('reads "N of M", never a bare number', () => {
    expect(rangeLabel({ from: 1, to: 25, total: 430 })).toBe('1–25 of 430');
    expect(rangeLabel({ from: 426, to: 430, total: 430 })).toBe('426–430 of 430');
    expect(countLabel(12, 430)).toBe('12 of 430');
    for (const label of [rangeLabel({ from: 1, to: 25, total: 430 }), countLabel(0, 430)]) {
      expect(label).toContain(' of ');
    }
  });

  it('collapses a single-row page rather than printing "3–3"', () => {
    expect(rangeLabel({ from: 3, to: 3, total: 430 })).toBe('3 of 430');
  });

  it('says nothing is shown when nothing is', () => {
    expect(rangeLabel({ from: 0, to: 0, total: 0 })).toBe('0 of 0');
    expect(countLabel(0, 0)).toBe('0 of 0');
  });
});

describe('pageWindow', () => {
  it('lists every page while they fit', () => {
    expect(pageWindow(1, 5, 7)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the first and last page reachable in one press', () => {
    // Jumping to the end of 18 pages by pressing Next seventeen times is not navigation.
    const w = pageWindow(9, 18, 7);
    expect(w[0]).toBe(1);
    expect(w[w.length - 1]).toBe(18);
    expect(w).toContain(9);
    expect(w.filter(p => p === 'gap')).toHaveLength(2);
  });

  it('gaps on one side only when the current page is near an edge', () => {
    expect(pageWindow(1, 18, 7)).toEqual([1, 2, 3, 4, 5, 'gap', 18]);
    expect(pageWindow(18, 18, 7)).toEqual([1, 'gap', 14, 15, 16, 17, 18]);
  });

  it('never repeats a page and never exceeds its span', () => {
    for (let page = 1; page <= 18; page++) {
      const w = pageWindow(page, 18, 7);
      const numbers = w.filter((p): p is number => p !== 'gap');
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(w.length).toBeLessThanOrEqual(7);
      expect(numbers).toContain(page);
    }
  });

  it('is a single page when there is a single page', () => {
    expect(pageWindow(1, 1, 7)).toEqual([1]);
  });
});

describe('rowsFingerprint', () => {
  /*
    The signal behind "changing a filter resets to page 1". It is a fingerprint of the row keys
    rather than the array's identity, because the array identity changes on every re-render of a
    parent that does not memoise — and a page that resets itself on every render is not a page.
  */
  it('is stable for the same set', () => {
    expect(rowsFingerprint(['a', 'b', 'c'])).toBe(rowsFingerprint(['a', 'b', 'c']));
  });

  it('changes when the membership changes', () => {
    expect(rowsFingerprint(['a', 'b', 'c'])).not.toBe(rowsFingerprint(['a', 'b']));
    expect(rowsFingerprint(['a', 'b', 'c'])).not.toBe(rowsFingerprint(['a', 'b', 'd']));
  });

  it('distinguishes two sets of the same length whose keys are anagrams', () => {
    // A sum or an XOR of character codes collides here, and a collision means a filter change that
    // leaves the operator on page 9 of a different result set.
    expect(rowsFingerprint(['ab', 'cd'])).not.toBe(rowsFingerprint(['ba', 'dc']));
  });

  it('handles an empty set without collapsing to the same value as one empty key', () => {
    expect(rowsFingerprint([])).not.toBe(rowsFingerprint(['']));
  });
});

describe('sortRows', () => {
  const by = (r: { n: number | null }) => r.n;

  it('orders numbers both ways', () => {
    const set = [{ n: 3 }, { n: 1 }, { n: 2 }];
    expect(sortRows(set, by, 'asc').map(r => r.n)).toEqual([1, 2, 3]);
    expect(sortRows(set, by, 'desc').map(r => r.n)).toEqual([3, 2, 1]);
  });

  it('puts an absent value last in both directions', () => {
    // "No method recorded" is not the smallest string and not the largest: it is the absence of
    // one, and burying three of those under 425 rows of paths is how a gap stops being visible.
    const set = [{ n: 2 }, { n: null }, { n: 1 }];
    expect(sortRows(set, by, 'asc').map(r => r.n)).toEqual([1, 2, null]);
    expect(sortRows(set, by, 'desc').map(r => r.n)).toEqual([2, 1, null]);
  });

  it('compares strings the way a reader does', () => {
    const set = [{ s: 'pod-10' }, { s: 'pod-2' }];
    expect(sortRows(set, r => r.s, 'asc').map(r => r.s)).toEqual(['pod-2', 'pod-10']);
  });

  it('leaves the array it was handed alone', () => {
    const set = [{ n: 3 }, { n: 1 }];
    sortRows(set, by, 'asc');
    expect(set.map(r => r.n)).toEqual([3, 1]);
  });
});

describe('the pipeline order is the rule', () => {
  it('sorts the whole set before slicing, not the page after', () => {
    /*
      The canary. `rows` arrives in an order nobody asked for; sorting descending has to reach
      across all 100 rows so that page 2 holds the 26th-to-50th largest. Sorting the page instead
      produces a table that is internally consistent, ordered, and reporting the wrong rows — which
      is indistinguishable from correct unless you know the data.
    */
    const scrambled = rows(100).map(n => ({ n: (n * 37) % 100 }));
    const whole = sortRows(scrambled, r => r.n, 'desc');
    const page2 = paginate(whole, 2, 25);
    expect(page2.rows.map(r => r.n)).toEqual(rows(25).map(i => 74 - i + 1));

    const pageFirst = sortRows(paginate(scrambled, 2, 25).rows, r => r.n, 'desc');
    expect(pageFirst.map(r => r.n)).not.toEqual(page2.rows.map(r => r.n));
  });
});

describe('nextSort', () => {
  it('starts a new column in the direction that column is read in', () => {
    // A count wants its largest first; a path wants A→Z. The column says which, so neither needs a
    // second click to show the answer the operator opened the table for.
    expect(nextSort({ key: 'path', dir: 'asc' }, 'count', 'desc')).toEqual({ key: 'count', dir: 'desc' });
    expect(nextSort({ key: 'count', dir: 'desc' }, 'path', 'asc')).toEqual({ key: 'path', dir: 'asc' });
  });

  it('reverses the column that is already sorted', () => {
    expect(nextSort({ key: 'count', dir: 'desc' }, 'count', 'desc')).toEqual({ key: 'count', dir: 'asc' });
    expect(nextSort({ key: 'count', dir: 'asc' }, 'count', 'desc')).toEqual({ key: 'count', dir: 'desc' });
  });
});
