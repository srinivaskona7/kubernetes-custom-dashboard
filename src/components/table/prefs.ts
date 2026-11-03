/**
 * What the operator changed about a table, remembered between visits.
 *
 * Column width, order, visibility and row height are per-person preferences on a console somebody
 * keeps open all day: an SRE who widens `Pod` once should not have to widen it again after every
 * navigation, and the pod name column is the one every operator widens, because a
 * Deployment appends two hash segments to a name that was already long.
 *
 * `localStorage`, not the URL and not the server. The fleet API is read-only by design and has no
 * per-user store, and a URL carrying four columns' pixel widths is a URL nobody can share. The keys
 * are namespaced per table so two tables that happen to both have a `pod` column do not overwrite
 * each other.
 *
 * Everything read back out of storage is treated as **untrusted input**, because it is: it survives
 * across deploys, so it is the previous version of this file's output, and a column that has since
 * been renamed or removed must not be able to hide a column that exists now or pin one to 4px.
 * `sanitize()` is the whole reason this module is separate and tested.
 */

/** Row height mode. `compact` is the console default: one line, ellipsis, 44px rows. */
export type RowMode = 'compact' | 'wrap';

export interface TablePrefs {
  /** Pixel widths, by column key. Only columns the operator actually dragged appear here. */
  widths: Record<string, number>;
  /** Column keys in the operator's order. Keys not listed keep their declared position. */
  order: string[];
  /** Column keys the operator hid. Locked columns can never appear here — see `sanitize`. */
  hidden: string[];
  rows: RowMode;
}

export const DEFAULT_PREFS: TablePrefs = { widths: {}, order: [], hidden: [], rows: 'compact' };

/**
 * The narrowest and widest a dragged column may become.
 *
 * A floor because a column dragged to 12px is a column the operator cannot find again to drag back —
 * the handle goes with it. A ceiling because the widest useful pod name is about 520px at this font,
 * and a column dragged to 4000px turns every other column into an ellipsis with no way to see that
 * the table is now scrolled sideways.
 */
export const MIN_COLUMN_PX = 72;
export const MAX_COLUMN_PX = 720;

const VERSION = 1;
const PREFIX = 'fleet.table.';

/** A cap on how much one table may store, so a loop that resizes cannot fill the origin's quota. */
const MAX_KEYS = 40;

export function storageKey(tableId: string): string {
  return `${PREFIX}v${VERSION}.${tableId}`;
}

function clampWidth(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, Math.round(n)));
}

/**
 * Reconcile stored preferences against the columns this table actually has today.
 *
 * The four rules, each of which exists because the alternative is a broken table:
 *
 *  - **Unknown keys are dropped.** A stored `order` from a previous release can name a column that no
 *    longer exists; carrying it through would leave a gap in the rendered order.
 *  - **Missing keys are appended in declared order.** A column added by a release the operator's
 *    stored order predates must still appear, and it appears where the code put it relative to the
 *    columns around it.
 *  - **Locked columns are never hidden and never move.** The row's identity column and the Actions
 *    column are how a row is recognised and how it is acted on; a table that has lost both is a table
 *    the operator cannot use and cannot repair, because the control that would repair it lists columns
 *    by the name it can no longer show.
 *  - **Every column hidden is the same as no table.** If storage would hide everything, the whole
 *    preference is discarded rather than partially honoured.
 */
export function sanitize(
  stored: unknown,
  columns: { key: string; locked?: boolean }[]
): TablePrefs {
  const known = new Map(columns.map(c => [c.key, c]));
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Partial<TablePrefs>;

  const widths: Record<string, number> = {};
  if (raw.widths && typeof raw.widths === 'object') {
    for (const [key, value] of Object.entries(raw.widths).slice(0, MAX_KEYS)) {
      if (!known.has(key)) continue;
      const px = clampWidth(value);
      if (px !== null) widths[key] = px;
    }
  }

  const requested = Array.isArray(raw.order) ? raw.order.filter(k => typeof k === 'string') : [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const key of requested) {
    if (!known.has(key) || seen.has(key)) continue;
    // A locked column keeps its declared slot; letting storage move it is how Actions ends up
    // between two facts.
    if (known.get(key)?.locked) continue;
    seen.add(key);
    order.push(key);
  }

  const hidden = (Array.isArray(raw.hidden) ? raw.hidden : [])
    .filter((k): k is string => typeof k === 'string')
    .filter(k => known.has(k) && !known.get(k)?.locked)
    .slice(0, MAX_KEYS);

  const visible = columns.filter(c => !hidden.includes(c.key));
  const rows: RowMode = raw.rows === 'wrap' ? 'wrap' : 'compact';
  if (visible.length === 0) return { ...DEFAULT_PREFS, widths, rows };
  return { widths, order, hidden, rows };
}

/** Read one table's preferences. Never throws: a bad value is the same as no value. */
export function loadPrefs(tableId: string, columns: { key: string; locked?: boolean }[]): TablePrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS };
  try {
    const text = localStorage.getItem(storageKey(tableId));
    if (!text) return { ...DEFAULT_PREFS };
    return sanitize(JSON.parse(text), columns);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist one table's preferences, or clear the entry when they are back to the default. */
export function savePrefs(tableId: string, prefs: TablePrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const isDefault =
      prefs.rows === 'compact' &&
      prefs.hidden.length === 0 &&
      prefs.order.length === 0 &&
      Object.keys(prefs.widths).length === 0;
    if (isDefault) localStorage.removeItem(storageKey(tableId));
    else localStorage.setItem(storageKey(tableId), JSON.stringify(prefs));
  } catch {
    // A full or disabled store is not a reason to break the table. The preference is simply
    // per-session in that case, which is what it was before this module existed.
  }
}

/**
 * Apply an order to a declared column list.
 *
 * Locked columns are re-inserted at their declared index afterwards, which is what keeps the identity
 * column first and Actions last however the operator drags the middle of the table around.
 */
export function applyOrder<T extends { key: string; locked?: boolean }>(columns: T[], order: string[]): T[] {
  if (!order.length) return columns;
  const byKey = new Map(columns.map(c => [c.key, c]));
  const movable = order.map(k => byKey.get(k)).filter((c): c is T => !!c && !c.locked);
  const rest = columns.filter(c => !c.locked && !order.includes(c.key));
  const middle = [...movable, ...rest];
  const out: T[] = [];
  let m = 0;
  for (const c of columns) {
    if (c.locked) out.push(c);
    else if (m < middle.length) out.push(middle[m++]!);
  }
  return out;
}
