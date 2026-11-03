/**
 * The pure half of an expandable row: which keys are open, and what the control says.
 *
 * Only the set arithmetic and the accessible name live here, because those are the two things that
 * go wrong silently. A set mutated in place re-renders nothing, and a chevron whose only label is
 * the glyph is invisible to a screen reader — neither failure shows up in a screenshot.
 */
import { describe, expect, test } from 'vitest';
import { EXPAND_COLUMN_KEY, expandLabel, isExpanded, toggleKey } from './expand';

describe('toggleKey', () => {
  test('opens a closed key', () => {
    expect([...toggleKey(new Set(), 'a')]).toEqual(['a']);
  });

  test('closes an open key', () => {
    expect([...toggleKey(new Set(['a']), 'a')]).toEqual([]);
  });

  test('leaves the other open keys alone, so two rows can be open at once', () => {
    expect([...toggleKey(new Set(['a', 'b']), 'c')].sort()).toEqual(['a', 'b', 'c']);
  });

  /**
   * React bails out of a re-render when the state is the same object. Mutating the caller's set and
   * handing it back would leave the row rendered closed after a click that recorded it as open.
   */
  test('returns a new set and never mutates the one it was given', () => {
    const before = new Set(['a']);
    const after = toggleKey(before, 'b');
    expect(after).not.toBe(before);
    expect([...before]).toEqual(['a']);
  });
});

describe('isExpanded', () => {
  test('is false when no set has been provided at all', () => {
    expect(isExpanded(undefined, 'a')).toBe(false);
  });

  test('reads membership when one has', () => {
    expect(isExpanded(new Set(['a']), 'a')).toBe(true);
    expect(isExpanded(new Set(['a']), 'b')).toBe(false);
  });
});

describe('expandLabel', () => {
  test('names the row, not just the action, because a table has one chevron per row', () => {
    expect(expandLabel(false, 'kyma-fleet/srv-7d9')).toBe('Show details for kyma-fleet/srv-7d9');
    expect(expandLabel(true, 'kyma-fleet/srv-7d9')).toBe('Hide details for kyma-fleet/srv-7d9');
  });

  test('falls back to a usable name when the row identity is empty', () => {
    expect(expandLabel(false, '')).toBe('Show details for this row');
  });
});

describe('EXPAND_COLUMN_KEY', () => {
  /**
   * Stored column preferences are keyed by column key, and the chevron column is injected by the
   * table rather than declared by a caller. A key a caller could plausibly also use would let one
   * table's saved width land on the other's column.
   */
  test('is reserved, so no caller column can collide with it', () => {
    expect(EXPAND_COLUMN_KEY.startsWith('__')).toBe(true);
  });
});
