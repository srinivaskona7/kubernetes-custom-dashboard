/**
 * The table. One component, used by every page, because the density rules — 44px rows,
 * 36px uppercase header, separators on, striping off, whole row clickable — are worth
 * enforcing in exactly one place.
 *
 * That "one place" has since become load-bearing for more than density. Everything the request calls
 * a global table standard is implemented here rather than per tab, so a table written next month gets
 * it without anybody remembering:
 *
 *   alignment      derived from the header text by `align.ts` when a column states none, so `CPU` is
 *                  right and `Namespace` is left before any reviewer looks at it
 *   long names      a ceiling (`max`) plus ellipsis plus a tooltip derived from the rendered cell
 *   resizing        a drag handle on every header's right edge, clamped, remembered per table
 *   reordering      drag a header, or ↑/↓ in the Columns menu for the keyboard path
 *   visibility      the Columns menu; identity and Actions columns are locked and cannot be lost
 *   sorting         opt-in per column via `sortValue`, which sorts the *underlying* value
 *   row height      a Wrap names mode that lets a long name take two lines and grows the row
 *   responsive      container-query shed tiers (theme.css) plus a sticky identity column
 *
 * `priority` is what keeps a wide table honest when the detail panel takes 40-46% of it:
 * 1 never hides, 2 hides in a tight column, 3 hides first. The hiding itself is a CSS
 * container query in theme.css, so it responds to the width the table really has rather
 * than to the viewport.
 *
 * One `<table>`, one `<thead>`, one `<tbody>`: a header is structurally incapable of drifting from
 * the column under it, and every width, class and alignment below is applied to the `th` and the `td`
 * from the same `Column` object. That is the mechanism behind "never allow header/data drift" — not a
 * review step.
 */
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import { textOf } from './cell-text';
import { Empty, InfoTip } from './ui';
import { alignFor, type Align } from './table/align';
import { expandLabel, isExpanded } from './table/expand';
import { identityFloorPx } from './table/size';
import {
  applyOrder,
  loadPrefs,
  savePrefs,
  MAX_COLUMN_PX,
  MIN_COLUMN_PX,
  type RowMode,
  type TablePrefs
} from './table/prefs';
import { TableTools } from './table/TableTools';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** 1 = always visible (default), 2 = hides when tight, 3 = hides first. */
  priority?: 1 | 2 | 3;
  /**
   * Which way the values read. Omit it: `align.ts` decides from the header text, which is how the
   * rule stays the same across 24 tables. State it only where the header is ambiguous — a `Nodes`
   * column holding node *names* rather than a node count is the case that needs `'left'` in writing.
   */
  align?: Align;
  /** Sticks to the left edge while the table scrolls horizontally. */
  pin?: boolean;
  width?: string;
  /**
   * A floor on this column's width, for a column that must stay readable when the operator drags a
   * neighbour wide. Identity columns get one by default (see `MIN_IDENTITY_PX`).
   */
  min?: string;
  /**
   * A hard ceiling on this column's width. Use it on any column whose content has no natural
   * bound — a resource list, a message, a prose explanation.
   *
   * This exists because `width` alone caps nothing. `.tbl` uses the default `table-layout: auto`,
   * where a `<th>` width is a *suggestion* the widest cell overrides, and `.tbl tbody td` sets
   * `white-space: nowrap`, so a cell never wraps and the column grows to its longest row instead.
   * Measured on OPA Admission Webhooks at 1440: eight visible columns summed to 2157px inside a
   * 1090px container — Webhook 463px, Target resources 392px, Backend 336px — and shedding a whole
   * column recovered 100px of the 1067px overflow. The tier was necessary and nowhere near
   * sufficient; uncapped text columns were the dominant term.
   *
   * Applied to BOTH the `th` and the `td`, which is the part that matters: on the `th` alone the
   * body cell still forces the column wider. The cell truncates with an ellipsis rather than
   * clipping mid-glyph, and every capped cell in this codebase already carries a `title` with the
   * full value, so nothing becomes unreadable — it becomes hoverable.
   */
  max?: string;
  /**
   * One or two sentences on what this column *is*, shown in an `InfoTip` beside the header.
   *
   * For the columns whose name is not their definition. `CPU (used/req)` is a live sample from
   * metrics-server against a number somebody typed into a pod spec — two facts from two sources, and
   * no header short enough to fit a table will ever say so. `Restarts` is the count across every
   * container lifecycle in the pod, not since the pod started, which is the difference between
   * "flapping now" and "flapped once in March".
   *
   * Not on every column. `Namespace` needs no explanation and eleven `i` glyphs in one header row is
   * a row of noise; the test in `test/fleet/column-info.test.js` asserts the columns that *do* need
   * one have it, rather than asserting a count.
   *
   * The tip's own press is stopped from propagating, so it never triggers this column's sort or the
   * row's `onSelect` — see `InfoTip`.
   */
  info?: string;
  /**
   * What the cell's tooltip should say, when the text cannot be derived from what `render`
   * returns — a cell built out of a custom component, or one whose visible form is an
   * abbreviation of something longer ("3d" for a real timestamp).
   *
   * Leave it off for the ordinary case. A capped column gets its tooltip automatically; see
   * `titleFor` below.
   */
  title?: (row: T) => string | undefined;
  /**
   * The value this column sorts on — which is deliberately not the string the cell renders.
   *
   * `512 MiB` sorts above `5 GiB` as text and below it as a quantity, and a truncated pod name sorts
   * on the part that survived the ellipsis. A column without this is not sortable: most tables on
   * this console arrive ranked by the API (worst-first pressure, newest-first events) and inventing a
   * client-side sort over a truncated page would be a control that quietly disagrees with the data.
   */
  sortValue?: (row: T) => string | number | null;
  /**
   * Keep this column in place: never hidden, never reordered. The identity column and the Actions
   * column are locked automatically; this is for a third one, if a table ever needs it.
   */
  lock?: boolean;
  render: (row: T) => ReactNode;
}

/**
 * The console's alignment rule, as a value rather than as prose.
 *
 * Spread it into any column whose cell is a **magnitude or a moment** — a count, a duration, an age,
 * a timestamp, a percentage, a byte or core figure. Those read down a column only when their digits
 * line up on the right, and `DataTable` puts the same class on the `th` and the `td`, so the header
 * follows the cells automatically.
 *
 * Still worth spreading even though `align.ts` now derives the same answer from most headers: it is
 * the explicit form for a header the classifier has no opinion about, and it reads at the call site.
 * Everything the classifier does not recognise stays left, which is the default: names, namespaces,
 * kinds, HTTP status *codes* (a code is an identifier, not a quantity), enforcement modes, phases,
 * pills, prose. Right-aligning those would ragged their left edge, which is the edge the eye scans.
 */
export const NUMERIC: { align: 'right' } = { align: 'right' };

/**
 * A compact indicator — a boolean tick, a one-word fixed-width badge.
 *
 * Not for status. A status cell on this console holds a pill whose text runs from `Running` to
 * `CreateContainerConfigError`, and centring variable-width content ragged both of its edges at once,
 * which is worse to scan down than either alignment. See the note in `align.ts`.
 */
export const CENTER: { align: 'center' } = { align: 'center' };

/**
 * A column of controls. Always last, always right, always headed `Actions`, never hidden.
 *
 * The three that existed before this had an empty header — which left a blank `th` above a button and
 * made the row's last column look like a rendering bug rather than a deliberate control. An empty
 * header also gives a screen reader nothing to announce for the cell.
 */
export const ACTIONS: { align: 'right'; header: string; lock: true } = {
  align: 'right',
  header: 'Actions',
  lock: true
};

/** Below this many columns there is nothing worth a Columns menu, so no toolbar is rendered. */
const TOOLS_MIN_COLUMNS = 6;

/**
 * How wide each column actually rendered, by key — the one thing a cell cannot work out for itself.
 *
 * A cell that shortens its own text needs the width it *has*, not the width its column was declared
 * with. Those differ in both directions: an operator drags the column to 500px, or its neighbours
 * squeeze it to its floor, and a budget computed from the declared ceiling is then either 200px short
 * of the space available or wider than the cell — in which case the cell's own `text-overflow` cuts
 * the already-shortened string a *second* time. See `pod-name.ts`.
 *
 * A context rather than a `render(row, width)` argument: the width is needed by whichever element
 * inside the cell does the shortening, which on the Pod column is two components down, and widening
 * every `Column.render` signature in the console to serve one cell is the wrong trade.
 *
 * Empty until the first measurement lands, and `useColumnPx` answers `null` then, so a cell keeps its
 * declared fallback rather than rendering at a guessed width.
 */
const ColumnPxContext = createContext<Readonly<Record<string, number>>>({});

/**
 * The measured width of one column in px, or `null` before the first measurement.
 *
 * `null` is not zero and must not be collapsed into one: a hidden column and an unmeasured column
 * would both look like zero, and only one of them means "there is no space to render in".
 */
export function useColumnPx(key: string): number | null {
  const widths = useContext(ColumnPxContext);
  return widths[key] ?? null;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

/**
 * The React key for the one group an ungrouped table has.
 *
 * A literal was the obvious choice and it cost an hour: the first version used a `\u0000` sentinel so
 * it could not collide with a real group label, and a NUL byte in a source file makes git, grep and
 * diff treat the whole file as binary. Any string works, because an ungrouped table has exactly one
 * group and nothing to collide with.
 */
const UNGROUPED_KEY = 'ungrouped';

/**
 * A stable id for one table's stored preferences.
 *
 * Derived from the column keys when the call site gives no `id`, so widths and hidden columns persist
 * on all 24 existing tables without threading an id through 24 files. Two tables with an identical
 * column set would share preferences — acceptable, and in practice they are the same table rendered
 * twice (a cluster's pod list and a node's), where sharing is the behaviour an operator expects.
 */
function tableId<T>(id: string | undefined, columns: Column<T>[]): string {
  return id ?? columns.map(c => c.key).join('.');
}

export function DataTable<T>({
  id,
  columns,
  rows,
  rowKey,
  selectedKey,
  onSelect,
  onIntent,
  groupOf,
  groupSummary,
  shed,
  tools,
  empty,
  renderExpandedRow,
  expandedKeys,
  onToggleExpand,
  expandChevron = 'start'
}: {
  /** Names this table's stored column preferences. Defaults to its column keys. */
  id?: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onSelect?: (row: T) => void;
  /**
   * The operator is *about* to open this row — pointer over it, or keyboard focus on it.
   *
   * Only worth wiring where the row leads somewhere expensive. A Helm release page's `/related`
   * read costs ~4s cold against a remote cluster, and the pointer sits on the row for a few
   * hundred milliseconds before the click lands; spending that window on the read the click is
   * going to make is the difference between a page that appears and a page that loads.
   *
   * This is a hint, not a fetch: the handler is expected to be idempotent and cheap to call
   * repeatedly, because a pointer crossing a table fires it once per row.
   */
  onIntent?: (row: T) => void;
  /**
   * Which bucket a row belongs to, or `null` for an ungrouped table.
   *
   * A grouped table is still ONE `<table>` with one `<thead>`: the group's name is a spanning row
   * inside the same `<tbody>`, so every group keeps the same column edges. One table per group is
   * the obvious alternative and the wrong one — nine columns re-measured per group is how a matrix
   * stops being scannable down a column, and each table would also get its own toolbar and its own
   * copy of the column preferences under one id.
   *
   * Group ORDER comes from the order the rows arrived in, not from the active sort, so sorting a
   * column rearranges rows inside their groups and never reshuffles the groups themselves.
   */
  groupOf?: (row: T) => string | null;
  /** What the group's spanning row says. Defaults to the label and the row count. */
  groupSummary?: (label: string, count: number) => ReactNode;
  /**
   * Which shed tier this table's column count needs. Omit for the six-to-eight column default;
   * `'mid'` for nine columns (Workloads, pod inventory); `'wide'` for ten-plus (Nodes);
   * `'xwide'` for the Top Utilization tables, whose twelve columns are wider still because most
   * of them are numeric columns with a two-word header naming a denominator; `'lean'` for a wide
   * table whose priority-1 set is unusually narrow, which lets its priority-2 columns survive a
   * much narrower container than `xwide` allows.
   *
   * This is per-table because one global pair of thresholds cannot serve both ends: Nodes'
   * twelve columns need 1589px and overflowed by 427px at the container width where Workloads'
   * nine still fit, while Overview's eight fit a 940px container with zero overflow and lose
   * three columns to a threshold raised on their behalf. See the five tiers in theme.css.
   */
  shed?: 'mid' | 'wide' | 'xwide' | 'lean';
  /** Force the Columns / Wrap names toolbar on or off. Defaults to on at six columns or more. */
  tools?: boolean;
  empty: ReactNode;
  /**
   * The detail panel for an opened row, rendered as a spanning row directly beneath it.
   *
   * Inline rather than a drawer where the detail is a *breakdown of the row* — a pod's containers
   * against the pod's own numbers — because a drawer costs the operator the row they were reading.
   * The panel is only mounted while the row is open, so its cost is per-open, not per-row.
   *
   * Providing this adds one narrow chevron column at the left. It is not part of the column set:
   * it is never hidden by the Columns menu, never dragged, never sorted, and carries no stored
   * width, which is why it has no `Column` entry and why its key is reserved.
   */
  renderExpandedRow?: (row: T) => ReactNode;
  /**
   * Which `rowKey`s are open. Owned by the caller so it can live in the URL — see `expand.ts`.
   *
   * Nothing is expandable unless BOTH this and `onToggleExpand` arrive with `renderExpandedRow`;
   * a chevron that cannot change anything is worse than no chevron.
   */
  expandedKeys?: ReadonlySet<string>;
  onToggleExpand?: (key: string) => void;
  /**
   * `none` when a column of the caller's already carries the toggle (the Pods table's trailing
   * chevron, matching the Namespaces table's). The detail row still spans every column.
   */
  expandChevron?: 'start' | 'none';
}) {
  /**
   * Which column is the row's identity, and which ones the operator may not lose.
   *
   * The identity is the declared `pin` if there is one, otherwise the first column — the cell an
   * operator reads to know *which* row this is. It is locked and left-aligned whatever it holds.
   */
  const locks = useMemo(() => {
    const pinned = columns.find(c => c.pin);
    const identity = pinned ?? columns[0];
    return new Set(
      columns.filter(c => c.lock || c === identity || c.align === 'right' && textOf(c.header) === 'Actions').map(c => c.key)
    );
  }, [columns]);

  const lockable = useMemo(
    () => columns.map(c => ({ key: c.key, locked: locks.has(c.key) })),
    [columns, locks]
  );

  const storeId = tableId(id, columns);
  // Read once per mount. Storage is the operator's own previous session, not a live source; re-reading
  // it on every render would fight the state below for control of the same widths.
  const [prefs, setPrefs] = useState<TablePrefs>(() => loadPrefs(storeId, lockable));
  const [sort, setSort] = useState<SortState>(null);

  const update = useCallback(
    (next: TablePrefs) => {
      setPrefs(next);
      savePrefs(storeId, next);
    },
    [storeId]
  );

  /* ------------------------------------------------ measuring what each column actually got */

  /**
   * One `ResizeObserver` over the header cells, publishing each column's rendered width.
   *
   * The header row, not the body: there is one `th` per column against hundreds of `td`s, and under
   * `table-layout: auto` a column's `th` and its `td`s are the same width by definition.
   *
   * Two properties this has to have:
   *
   *  - **Integer px, and no state write when the integer is unchanged.** A `ResizeObserver` reports
   *    fractional widths and fires on every frame of a drag, so rounding first means a sub-pixel
   *    wobble produces the same number and React bails out instead of re-rendering the table. It is
   *    also what bounds the one feedback path this feature creates — a cell shortens its text, the
   *    text is narrower, the column is re-measured: a column that states a `width` does not follow
   *    its content at all, and one that does not is clamped by its own `max`, so the movement is
   *    bounded and settles rather than ratcheting down to the floor.
   *  - **Observation follows the visible set.** A shed or hidden column's `th` leaves the DOM, its ref
   *    callback fires with `null`, and its entry is dropped — so a stale width can never be read for a
   *    column that is no longer on screen.
   */
  const [colPx, setColPx] = useState<Record<string, number>>({});
  const headCells = useRef(new Map<string, HTMLTableCellElement>());
  const observer = useRef<ResizeObserver | null>(null);

  const measure = useCallback((key: string, px: number) => {
    const next = Math.round(px);
    setColPx(prev => (prev[key] === next ? prev : { ...prev, [key]: next }));
  }, []);

  useEffect(() => {
    // Absent in a non-DOM environment, and this whole feature is an enhancement over a budget that
    // already works — so its absence is a no-op, never a crash.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.colKey;
        if (key) measure(key, entry.contentRect.width);
      }
    });
    observer.current = ro;
    for (const el of headCells.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, [measure]);

  const headCellRefFns = useRef<Map<string, (el: HTMLTableCellElement | null) => void>>(new Map());

  const registerHeadCell = useCallback(
    (key: string, el: HTMLTableCellElement | null) => {
      const known = headCells.current.get(key);
      if (known === el) return;
      if (known) {
        observer.current?.unobserve(known);
        headCells.current.delete(key);
      }
      if (el) {
        headCells.current.set(key, el);
        observer.current?.observe(el);
        // The first width is read directly rather than waited for: an observer fires after the frame,
        // and a cell rendered at its fallback budget for one frame is a visible re-truncation on every
        // mount of every table.
        const w = el.getBoundingClientRect().width;
        if (w > 0) {
          measure(key, w);
        }
      } else {
        setColPx(prev => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [measure]
  );

  const getHeadCellRef = useCallback(
    (key: string) => {
      let fn = headCellRefFns.current.get(key);
      if (!fn) {
        fn = (el: HTMLTableCellElement | null) => registerHeadCell(key, el);
        headCellRefFns.current.set(key, fn);
      }
      return fn;
    },
    [registerHeadCell]
  );

  /* -------------------------------------------------------- the columns actually rendered */

  const ordered = useMemo(
    () => applyOrder(columns.map(c => ({ ...c, locked: locks.has(c.key) })), prefs.order),
    [columns, locks, prefs.order]
  );

  const visible = useMemo(() => ordered.filter(c => !prefs.hidden.includes(c.key)), [ordered, prefs.hidden]);

  /**
   * The current preferences, readable from an event handler that must not re-subscribe.
   *
   * A pointermove handler that closed over `prefs` would be a new function on every frame of a drag,
   * and the one that ends the drag has to persist whatever the last frame produced — which the
   * closure from pointerdown does not know.
   */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /* ------------------------------------------------------------------ column resizing */

  const dragging = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  /**
   * Start a width drag, and listen for the rest of it on `window`.
   *
   * Not `setPointerCapture` on the handle, which is the obvious way and the broken one: every
   * pointermove re-renders this table, React replaces the header, and the captured element goes with
   * it — so no `pointerup` ever arrives, `dragging` stays set, and the column silently resizes again
   * the *next* time the pointer crosses the handle. That is how a table this branch had never dragged
   * came back from storage with two columns at hand-set widths. `window` listeners survive the
   * re-render, and they are removed by the same handler that ends the drag.
   */
  const onResizeStart = useCallback(
    (e: ReactPointerEvent, key: string) => {
      // The handle sits inside the header, and the header may be a sort button and a drag source.
      // Neither should fire because the operator grabbed the edge.
      e.preventDefault();
      e.stopPropagation();
      const th = (e.currentTarget as HTMLElement).closest('th');
      if (!th) return;
      dragging.current = { key, startX: e.clientX, startWidth: th.getBoundingClientRect().width };

      const move = (ev: PointerEvent) => {
        const d = dragging.current;
        if (!d) return;
        const px = Math.min(
          MAX_COLUMN_PX,
          Math.max(MIN_COLUMN_PX, Math.round(d.startWidth + (ev.clientX - d.startX)))
        );
        // Local state while the pointer is down: a `localStorage` write per frame is not a preference,
        // it is a hundred of them.
        setPrefs(p => (p.widths[d.key] === px ? p : { ...p, widths: { ...p.widths, [d.key]: px } }));
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (!dragging.current) return;
        dragging.current = null;
        savePrefs(storeId, prefsRef.current);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    },
    [storeId]
  );

  /* ----------------------------------------------------------------- column reordering */

  const dragKey = useRef<string | null>(null);

  /** The movable columns' keys, in the order they are rendered right now. */
  const movableOrder = useCallback(
    () => ordered.filter(c => !locks.has(c.key)).map(c => c.key),
    [ordered, locks]
  );

  const moveBefore = useCallback(
    (key: string, beforeKey: string) => {
      if (key === beforeKey || locks.has(key) || locks.has(beforeKey)) return;
      const next = movableOrder();
      const from = next.indexOf(key);
      const to = next.indexOf(beforeKey);
      if (from < 0 || to < 0) return;
      next.splice(from, 1);
      next.splice(to, 0, key);
      update({ ...prefsRef.current, order: next });
    },
    [locks, movableOrder, update]
  );

  const moveBy = useCallback(
    (key: string, delta: -1 | 1) => {
      const next = movableOrder();
      const from = next.indexOf(key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= next.length) return;
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      update({ ...prefsRef.current, order: next });
    },
    [movableOrder, update]
  );

  /* ---------------------------------------------------------------------------- sorting */

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const sign = sort.dir === 'asc' ? 1 : -1;
    // A copy, and a comparator that puts absent values last in both directions: "no sample" is not
    // the smallest number, it is the absence of one, and burying it under 200 rows of zeros is how a
    // gap in the data stops being visible.
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
    });
  }, [rows, sort, columns]);

  const cycleSort = useCallback((key: string) => {
    // asc → desc → back to the order the API sent, which is itself meaningful on most of these
    // tables (worst-first, newest-first) and must be reachable again.
    setSort(s => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  }, []);

  /* --------------------------------------------------------------------------- grouping */

  /**
   * The body as a list of groups — one unlabelled group when the table is not grouped.
   *
   * Two passes on purpose: the group order is taken from the *unsorted* rows so it is the caller's,
   * while the rows inside each group come from `sorted` so a column sort still works. Bucketing
   * `sorted` alone would let clicking a header reorder the groups too, which reads as the table
   * rebuilding itself rather than sorting.
   */
  const body = useMemo(() => {
    if (!groupOf) return [{ label: null, rows: sorted }];
    const order: string[] = [];
    const buckets = new Map<string, T[]>();
    for (const row of rows) {
      const label = groupOf(row) ?? '';
      if (!buckets.has(label)) {
        buckets.set(label, []);
        order.push(label);
      }
    }
    for (const row of sorted) buckets.get(groupOf(row) ?? '')!.push(row);
    return order.map(label => ({ label: label || null, rows: buckets.get(label)! }));
  }, [rows, sorted, groupOf]);

  /* ---------------------------------------------------------------------------- styling */

  const alignOf = (c: Column<T>): Align => c.align ?? alignFor(textOf(c.header) || '') ?? 'left';

  /**
   * Whether the identity column sticks to the left edge while the rest scrolls past.
   *
   * Only on a table that declares a shed tier. Those are the ten-to-twelve column tables that really
   * do scroll sideways at a narrow container, and the primary identifier staying put is what stops a
   * horizontally scrolled row becoming five numbers belonging to nobody. On a six-column table there
   * is nothing to scroll, and making its first column sticky would only change how its background
   * paints.
   */
  const stickyIdentity = !!shed;

  const cls = (c: Column<T> & { locked?: boolean }) => {
    const align = alignOf(c);
    return [
      c.priority && c.priority > 1 ? `prio-${c.priority}` : '',
      align === 'right' ? 'num' : align === 'center' ? 'ctr' : '',
      c.pin || (stickyIdentity && c.key === visible[0]?.key) ? 'pin' : '',
      // `truncate` would add its own `white-space: nowrap`, which `.tbl tbody td` already sets.
      // What a capped column needs is the overflow + ellipsis pair, applied to the cell itself.
      c.max || prefs.widths[c.key] ? 'overflow-hidden text-ellipsis' : ''
    ]
      .filter(Boolean)
      .join(' ');
  };

  /**
   * The width triple for one column.
   *
   * A dragged width has to hold against `table-layout: auto`, where a `<th>` width is a suggestion
   * the widest cell overrides — so a resized column states all three of `width`, `minWidth` and
   * `maxWidth` at the same pixel value, which is the only combination auto layout cannot argue with.
   * An untouched column keeps the declared behaviour: `width` as a hint, `max` as the ceiling that
   * actually holds, and a floor under the identity column so a neighbour cannot crush it.
   */
  const size = (c: Column<T> & { locked?: boolean }): CSSProperties | undefined => {
    const dragged = prefs.widths[c.key];
    if (dragged) return { width: `${dragged}px`, minWidth: `${dragged}px`, maxWidth: `${dragged}px` };
    const min = c.min ?? (c.key === visible[0]?.key ? `${identityFloorPx(c.width, c.max)}px` : undefined);
    if (!c.width && !c.max && !min) return undefined;
    return { width: c.width, maxWidth: c.max, minWidth: min };
  };

  /**
   * The tooltip for one cell, and the reason a capped column no longer needs to remember one.
   *
   * A `max` is what stops a long value pushing the table off its container — and it is also what
   * cuts that value off mid-word. Twenty columns across the console declared the ceiling and no
   * tooltip, so the operator could see a namespace was truncated and had no way to read it. The
   * title is now derived from the content the cell already renders, which is the one source that
   * cannot drift from what is on screen.
   *
   * Capped, resized and wrapped columns get one; an uncapped cell in compact mode shows its value in
   * full, and a tooltip repeating text that is already legible is noise on every hover across a
   * 200-row table.
   */
  const titleFor = (c: Column<T>, row: T, content: ReactNode): string | undefined => {
    if (c.title) return c.title(row) || undefined;
    if (!c.max && !prefs.widths[c.key]) return undefined;
    return textOf(content) || undefined;
  };

  const dirty =
    prefs.rows !== 'compact' ||
    prefs.hidden.length > 0 ||
    prefs.order.length > 0 ||
    Object.keys(prefs.widths).length > 0;

  const showTools = tools ?? columns.length >= TOOLS_MIN_COLUMNS;

  // All three or none: see `renderExpandedRow`.
  const expandable = !!renderExpandedRow && !!onToggleExpand && !!expandedKeys;
  /** What a spanning row has to cover. The chevron column is outside `visible`, so it is added here. */
  const chevron = expandable && expandChevron === 'start';
  const span = visible.length + (chevron ? 1 : 0);

  // After the hooks, never before them: an early return above `useState` is the one way to break the
  // hook order between a table that has rows and the same table a refresh later that does not.
  if (rows.length === 0) {
    return typeof empty === 'string' ? <Empty title={empty} /> : <>{empty}</>;
  }

  return (
    /*
      The provider wraps the whole block rather than each cell: the width a cell needs is measured on
      the header, which is a sibling several levels up, and one context read per cell is cheaper than
      a prop threaded through `Column.render` at twenty-eight call sites.
    */
    <ColumnPxContext.Provider value={colPx}>
    <div className="table-block">
      {showTools && (
        <TableTools
          columns={ordered.map(c => ({
            key: c.key,
            label: textOf(c.header) || c.key,
            locked: locks.has(c.key),
            hidden: prefs.hidden.includes(c.key)
          }))}
          rows={prefs.rows}
          dirty={dirty}
          onToggle={key =>
            update({
              ...prefs,
              hidden: prefs.hidden.includes(key) ? prefs.hidden.filter(k => k !== key) : [...prefs.hidden, key]
            })
          }
          onMove={moveBy}
          onRows={(mode: RowMode) => update({ ...prefs, rows: mode })}
          onReset={() => update({ widths: {}, order: [], hidden: [], rows: 'compact' })}
        />
      )}
      <div className="table-wrap">
        {/*
          Deliberately no `<colgroup>`: a `<col>` is the only element that could state a width once for
          the whole column, but `display: none` does not apply to it, so on a table that has shed its
          lowest-priority columns the colgroup would still declare widths for columns that have no
          cells left. The width is single-sourced instead from `Column.width`, which `size()` applies
          to the header and the body cell from the same object.
        */}
        <table className={shed ? `tbl tbl-${shed}` : 'tbl'} data-rows={prefs.rows}>
          <thead>
            <tr>
              {chevron && (
                /* No visible label — the column is 28px wide and every cell under it is a chevron
                   whose own accessible name carries the row. The header still needs a name for a
                   screen reader reading the column list. */
                <th className="tbl-expand" scope="col">
                  <span className="sr-only">Details</span>
                </th>
              )}
              {visible.map(c => {
                const sortable = !!c.sortValue;
                const active = sort?.key === c.key;
                return (
                  // The header is capped by the same `max` as its cells and clips the same way —
                  // "Chart version" in a 90px column reads "Chart vers…". Derived from the header
                  // node for the same reason the body's is derived from the cell.
                  <th
                    key={c.key}
                    // The measured-width source for every cell in this column — see `useColumnPx`.
                    ref={getHeadCellRef(c.key)}
                    data-col-key={c.key}
                    className={cls(c)}
                    style={size(c)}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    title={c.max ? textOf(c.header) || undefined : undefined}
                    // Reordering by drag. Locked columns are not drag sources and not drop targets,
                    // which is what keeps the identity column first and Actions last.
                    draggable={!locks.has(c.key)}
                    onDragStart={locks.has(c.key) ? undefined : () => (dragKey.current = c.key)}
                    onDragOver={locks.has(c.key) ? undefined : e => e.preventDefault()}
                    onDrop={
                      locks.has(c.key)
                        ? undefined
                        : e => {
                            e.preventDefault();
                            if (dragKey.current) moveBefore(dragKey.current, c.key);
                            dragKey.current = null;
                          }
                    }
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => cycleSort(c.key)}
                        title={`Sort by ${textOf(c.header) || c.key}`}
                      >
                        {c.header}
                        <span aria-hidden="true" className="th-sort-mark">
                          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                    {/*
                      Outside the sort button, not inside it. A focusable element nested in a
                      `<button>` is invalid HTML and, more practically, its press would have to fight
                      the sort handler; as a sibling it is simply the next inline box in the header,
                      so `text-align` still positions the pair as one unit whichever way the column
                      reads. `InfoTip` stops its own press from reaching either the sort or the row.
                    */}
                    {c.info && <InfoTip text={c.info} />}
                    {/*
                      The resize handle. A 6px strip on the column's right edge — wide enough to hit,
                      narrow enough that it is not in the way of the header's own click target.
                    */}
                    <span
                      className="col-resize"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${textOf(c.header) || c.key}`}
                      onPointerDown={e => onResizeStart(e, c.key)}
                      onDragStart={e => e.preventDefault()}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {body.map(group => (
              <Fragment key={group.label ?? UNGROUPED_KEY}>
                {group.label !== null && (
                  <tr className="tbl-group">
                    {/* Spans whatever is currently visible — a shed or hidden column changes the
                        count, and a stale colSpan would leave the group rule short of the table. */}
                    <th colSpan={span} scope="colgroup">
                      {groupSummary ? (
                        groupSummary(group.label, group.rows.length)
                      ) : (
                        <>
                          <span className="mono text-[12px] text-text">{group.label}</span>
                          <span className="ml-2 text-[12px] text-muted">
                            {group.rows.length} {group.rows.length === 1 ? 'row' : 'rows'}
                          </span>
                        </>
                      )}
                    </th>
                  </tr>
                )}
                {group.rows.map(row => {
                  const key = rowKey(row);
                  const selected = selectedKey === key;
                  const open = isExpanded(expandedKeys, key);
                  return (
                    <Fragment key={key}>
                    <tr
                      data-selected={selected}
                      // The whole row is the click target, and it is reachable by keyboard —
                      // an operations console that needs a mouse is a broken one.
                      tabIndex={onSelect ? 0 : undefined}
                      role={onSelect ? 'button' : undefined}
                      aria-pressed={onSelect ? selected : undefined}
                      onClick={onSelect ? () => onSelect(row) : undefined}
                      // `pointerenter`, not `mouseover`: it fires once for the row rather than once
                      // per cell crossed. Focus covers the keyboard path, where the operator arrows
                      // down a table and presses Enter — the same intent, without a pointer.
                      onPointerEnter={onIntent ? () => onIntent(row) : undefined}
                      onFocus={onIntent ? () => onIntent(row) : undefined}
                      onKeyDown={
                        onSelect
                          ? e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onSelect(row);
                              }
                            }
                          : undefined
                      }
                    >
                      {chevron && (
                        /* `stopPropagation`, because on a table that also has `onSelect` the row is a
                           button: without it, opening the breakdown would navigate away from it. */
                        <td className="tbl-expand" onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            className="tbl-expand-btn"
                            aria-expanded={open}
                            aria-label={expandLabel(open, key)}
                            onClick={() => onToggleExpand!(key)}
                          >
                            <span aria-hidden="true" data-open={open}>
                              ▸
                            </span>
                          </button>
                        </td>
                      )}
                      {visible.map(c => {
                        const content = c.render(row);
                        return (
                          <td key={c.key} className={cls(c)} style={size(c)} title={titleFor(c, row, content)}>
                            {content}
                          </td>
                        );
                      })}
                    </tr>
                    {open && (
                      <tr className="tbl-detail">
                        <td colSpan={span}>{renderExpandedRow!(row)}</td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </ColumnPxContext.Provider>
  );
}
