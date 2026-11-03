/**
 * Expandable-row state, kept out of `DataTable` so it can be tested without a DOM.
 *
 * The table itself holds no open/closed state: a caller that owns it can put it in the URL, which is
 * how a deep link to an opened row stays possible. See `expand.test.ts` for the two failure modes
 * this file exists to prevent.
 */

/**
 * The injected chevron column's key.
 *
 * Reserved rather than caller-supplied, because column preferences (order, width, hidden) are stored
 * under the key. A caller declaring its own `expand` column would inherit this one's saved width.
 */
export const EXPAND_COLUMN_KEY = '__expand';

/** Whether `key` is open. Absent state reads as closed, never as an error. */
export function isExpanded(keys: ReadonlySet<string> | undefined, key: string): boolean {
  return keys?.has(key) ?? false;
}

/** The set with `key` flipped — a new set every time, so React sees the change. */
export function toggleKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * The chevron's accessible name. Every row has one, so the name has to carry the row's identity —
 * "Show details" repeated forty times tells a screen-reader user nothing about which row they are on.
 */
export function expandLabel(expanded: boolean, rowName: string): string {
  const subject = rowName.trim() || 'this row';
  return `${expanded ? 'Hide' : 'Show'} details for ${subject}`;
}
