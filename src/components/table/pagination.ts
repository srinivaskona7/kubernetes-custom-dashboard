/**
 * One page of a table, and the rules that keep the page honest when the rows move under it.
 *
 * This is the first pagination in this console: `DataTable` renders every row it is handed, which is
 * right for a node list and wrong for 430 traffic-failure groups. The logic lives here rather than in
 * the component because `app/fleet-ui` runs vitest with `environment: 'node'` — jsdom cannot be
 * installed on this workstation (npm E401 against the internal registry) — so anything inside a
 * `.tsx` is unreachable by a test. Every rule below is therefore a function, and every one of them is
 * a bug that has shipped in somebody's table:
 *
 *   clamping      a filter that shrinks the set while the operator is on page 9 must not leave them
 *                 staring at an empty table with no explanation.
 *   "N of M"      a count that shrank silently is indistinguishable from a read that returned less,
 *                 which is the failure this console exists to avoid. No number prints alone.
 *   one page      a single page of results gets no control at all. Chrome for one page is clutter.
 *   sort first    {@link sortRows} then {@link paginate}, never the other way round — see the note on
 *                 `sortRows`, which is the half that looks correct while being wrong.
 *
 * {@link sortRows} sits beside the paging rather than in the component for exactly that last reason:
 * the ORDER of the two steps is the rule, and a rule split across two modules is a rule one of them
 * will eventually break.
 */

/**
 * Rows per page. 25 fills the viewport at 44px rows without the operator scrolling to reach the
 * control below the table.
 *
 * Deliberately one value rather than a picker: the only setting anybody reaches for is "all of them",
 * and 430 rows of nowrap cells inside a container query is the thing the page exists to avoid.
 */
export const DEFAULT_PAGE_SIZE = 25;

export type SortDir = 'asc' | 'desc';

/** Which column the whole filtered set is ordered by. Never null: a table always has an order. */
export interface SortState {
  key: string;
  dir: SortDir;
}

export interface PageOf<T> {
  /** The page actually shown, after clamping. May differ from the one that was asked for. */
  page: number;
  /** Always at least 1 — an empty result is one empty page, not zero pages. */
  pageCount: number;
  rows: T[];
  /** 1-based index of the first and last row on this page; both 0 when nothing is shown. */
  from: number;
  to: number;
  /** How many rows the page was taken from. The denominator every label prints. */
  total: number;
  /** More than one page. The only condition under which a paging control is worth rendering. */
  many: boolean;
}

/** A page size that can be divided by. Guards the two values that turn a count into `Infinity` or a negative. */
function sizeOf(pageSize: number): number {
  return Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
}

export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / sizeOf(pageSize)));
}

/**
 * The page that exists, given the page that was asked for.
 *
 * Non-finite input is clamped to 1 rather than passed through: `NaN` survives arithmetic, reaches
 * `slice`, and returns an empty array — which renders as "no rows matched" and blames the filter for
 * a bug in the page number.
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const count = pageCountOf(total, pageSize);
  if (!Number.isFinite(page)) return page > 0 ? count : 1;
  return Math.min(count, Math.max(1, Math.floor(page)));
}

/**
 * One page of rows.
 *
 * The clamp happens here and not only in the setter, because state is a render behind the data: rows
 * can arrive narrowed before the page number is corrected, and an empty page for one frame is still a
 * table that flashes "nothing here".
 */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): PageOf<T> {
  const size = sizeOf(pageSize);
  const total = rows.length;
  const pageCount = pageCountOf(total, size);
  const current = clampPage(page, total, size);
  const start = (current - 1) * size;
  const slice = rows.slice(start, start + size);
  return {
    page: current,
    pageCount,
    rows: slice,
    from: slice.length ? start + 1 : 0,
    to: slice.length ? start + slice.length : 0,
    total,
    many: pageCount > 1
  };
}

/** `1–25 of 430`. Collapses to `3 of 430` for a single row, which `3–3` would only make look broken. */
export function rangeLabel({ from, to, total }: { from: number; to: number; total: number }): string {
  const span = from === to ? `${from.toLocaleString()}` : `${from.toLocaleString()}–${to.toLocaleString()}`;
  return `${span} of ${total.toLocaleString()}`;
}

/** `12 of 430`. The filtered count beside the count it was filtered from — never one without the other. */
export function countLabel(shown: number, total: number): string {
  return `${shown.toLocaleString()} of ${total.toLocaleString()}`;
}

/**
 * The page numbers a control should offer, with `'gap'` where it skips.
 *
 * The first and last page are always present: reaching page 18 by pressing Next seventeen times is
 * not navigation. `span` is the total number of slots, gaps included, so the control's width does not
 * change as the operator moves through the pages — a row of buttons that reflows under the pointer is
 * one that gets mis-clicked.
 */
export function pageWindow(page: number, pageCount: number, span = 7): (number | 'gap')[] {
  const slots = Math.max(5, span);
  if (pageCount <= slots) return Array.from({ length: pageCount }, (_, i) => i + 1);

  const run = slots - 4; // the middle run, once both ends and both gaps have taken a slot
  const start = page - Math.floor((run - 1) / 2);
  const end = start + run - 1;

  // Near the start: one gap on the right, and the left-hand run grows into the slot the other gap
  // would have taken, so the control keeps its width.
  if (start <= 3) {
    return [...Array.from({ length: slots - 2 }, (_, i) => i + 1), 'gap', pageCount];
  }
  if (end >= pageCount - 2) {
    const first = pageCount - (slots - 3);
    return [1, 'gap', ...Array.from({ length: slots - 2 }, (_, i) => first + i)];
  }
  return [1, 'gap', ...Array.from({ length: run }, (_, i) => start + i), 'gap', pageCount];
}

/**
 * A fingerprint of the rows currently on screen, for "a filter change resets to page 1".
 *
 * Derived from the row keys rather than from the array's identity on purpose. A parent that does not
 * memoise its filter hands down a new array on every render, and a page that resets itself on every
 * render is not a page — while a parent that memoises too aggressively would never reset at all.
 * The keys are the one thing that changes exactly when the result set does.
 *
 * djb2 over the keys with a separator and the count, rather than a sum or an XOR: those collide on
 * anagrams (`['ab','cd']` against `['ba','dc']`), and a collision means the operator stays on page 9
 * of a set that no longer has one.
 */
export function rowsFingerprint(keys: readonly string[]): string {
  let hash = 5381;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) hash = (hash * 33) ^ key.charCodeAt(i);
    hash = (hash * 33) ^ 124; // '|', so two keys never run together
  }
  return `${keys.length}:${hash >>> 0}`;
}

/**
 * The whole filtered set, ordered.
 *
 * **Sort, then paginate.** Slicing first and sorting the slice produces a table that is ordered,
 * internally consistent and showing the wrong rows — page 2 of "count, descending" would hold the
 * 26th-to-50th rows of the *arrival* order, sorted. Nothing on screen distinguishes that from
 * correct, which is why the order of the two calls is asserted in this module's test rather than
 * left as a convention.
 *
 * Absent values sort last in **both** directions, matching `DataTable`'s own comparator: "no method
 * recorded" is not the smallest string, it is the absence of one, and burying the three rows that
 * have none under 425 that do is how a gap in the data stops being visible.
 */
export function sortRows<T>(
  rows: readonly T[],
  valueOf: (row: T) => string | number | null | undefined,
  dir: SortDir
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = valueOf(a) ?? null;
    const y = valueOf(b) ?? null;
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
  });
}

/**
 * What a press on a column header means.
 *
 * Two states per column, not `DataTable`'s three (asc → desc → back to the API's order). The third
 * state is worth having where the API's own ranking is meaningful and must be reachable again; here
 * the default sort — count, descending — is itself a column sort, so "back to unsorted" would land on
 * a state the operator can already reach by pressing Count. A third press that silently jumps to a
 * different column is the kind of control people stop trusting.
 *
 * `firstDir` is the column's own reading direction: a count wants its largest first, a path wants
 * A→Z. Without it every column costs two presses to show the answer the table was opened for.
 */
export function nextSort(current: SortState, key: string, firstDir: SortDir): SortState {
  if (current.key !== key) return { key, dir: firstDir };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}
