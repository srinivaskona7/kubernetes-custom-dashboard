/**
 * Stored table preferences are untrusted input, and this is the file that proves it.
 *
 * Everything `sanitize()` guards against has a concrete failure behind it: a release that renames a
 * column, a release that adds one, storage written by a version that did not lock the Actions column,
 * and a width dragged to a value that leaves the column impossible to find again.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyOrder,
  loadPrefs,
  savePrefs,
  sanitize,
  storageKey,
  DEFAULT_PREFS,
  MAX_COLUMN_PX,
  MIN_COLUMN_PX
} from './prefs';

const COLUMNS = [
  { key: 'pod', locked: true },
  { key: 'ns' },
  { key: 'workload' },
  { key: 'cpu' },
  { key: 'actions', locked: true }
];

describe('sanitize', () => {
  test('a stored key that no longer exists is dropped, not carried through', () => {
    const prefs = sanitize({ widths: { gone: 200, ns: 150 }, order: ['gone', 'cpu'], hidden: ['gone'] }, COLUMNS);
    expect(prefs.widths).toEqual({ ns: 150 });
    expect(prefs.order).toEqual(['cpu']);
    expect(prefs.hidden).toEqual([]);
  });

  test('a column added since the preference was written still renders', () => {
    const prefs = sanitize({ order: ['cpu', 'ns'] }, COLUMNS);
    // `workload` is not named, so it keeps its declared slot rather than vanishing.
    const shown = applyOrder(
      COLUMNS.map(c => ({ ...c })),
      prefs.order
    ).map(c => c.key);
    expect(shown).toContain('workload');
    expect(shown).toHaveLength(COLUMNS.length);
  });

  test('a locked column can never be hidden or moved', () => {
    const prefs = sanitize({ hidden: ['pod', 'actions', 'ns'], order: ['actions', 'cpu'] }, COLUMNS);
    expect(prefs.hidden).toEqual(['ns']);
    expect(prefs.order).toEqual(['cpu']);
  });

  test('a width outside the usable range is clamped rather than honoured', () => {
    const prefs = sanitize({ widths: { ns: 4, cpu: 9000, workload: 'wide' } }, COLUMNS);
    expect(prefs.widths.ns).toBe(MIN_COLUMN_PX);
    expect(prefs.widths.cpu).toBe(MAX_COLUMN_PX);
    expect(prefs.widths).not.toHaveProperty('workload');
  });

  test('a preference that would hide every column is discarded', () => {
    const prefs = sanitize({ hidden: ['ns', 'workload', 'cpu'] }, [{ key: 'ns' }, { key: 'workload' }, { key: 'cpu' }]);
    expect(prefs.hidden).toEqual([]);
  });

  test('rubbish in place of an object is the same as no preference', () => {
    for (const bad of [null, undefined, 42, 'prefs', [], { widths: 'none', order: 7, hidden: {} }]) {
      expect(sanitize(bad, COLUMNS)).toEqual(DEFAULT_PREFS);
    }
  });

  test('a duplicated key in the stored order appears once', () => {
    expect(sanitize({ order: ['cpu', 'cpu', 'ns'] }, COLUMNS).order).toEqual(['cpu', 'ns']);
  });
});

describe('applyOrder', () => {
  const cols = () => COLUMNS.map(c => ({ ...c }));

  test('locked columns keep their declared position however the rest is reordered', () => {
    const out = applyOrder(cols(), ['cpu', 'workload', 'ns']).map(c => c.key);
    expect(out[0]).toBe('pod');
    expect(out[out.length - 1]).toBe('actions');
    expect(out).toEqual(['pod', 'cpu', 'workload', 'ns', 'actions']);
  });

  test('an empty order is the declared order', () => {
    expect(applyOrder(cols(), []).map(c => c.key)).toEqual(COLUMNS.map(c => c.key));
  });

  test('no column is ever lost or duplicated', () => {
    const out = applyOrder(cols(), ['workload']).map(c => c.key);
    expect([...out].sort()).toEqual(COLUMNS.map(c => c.key).sort());
  });
});

describe('load and save', () => {
  /**
   * A three-method `localStorage`, because this suite runs without a DOM.
   *
   * The jsdom environment is not installable on this workstation (the registry answers 401 for it),
   * and everything under test here is `getItem`/`setItem`/`removeItem` plus `JSON`. A stub keeps the
   * guard honest about what it covers: the storage *contract*, not the browser.
   */
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      }
    };
  });

  test('a round trip returns what was stored', () => {
    savePrefs('t', { widths: { ns: 200 }, order: ['cpu'], hidden: ['workload'], rows: 'wrap' });
    expect(loadPrefs('t', COLUMNS)).toEqual({ widths: { ns: 200 }, order: ['cpu'], hidden: ['workload'], rows: 'wrap' });
  });

  test('saving the default clears the entry instead of storing an empty object', () => {
    savePrefs('t', { widths: { ns: 200 }, order: [], hidden: [], rows: 'compact' });
    expect(localStorage.getItem(storageKey('t'))).not.toBeNull();
    savePrefs('t', { ...DEFAULT_PREFS });
    expect(localStorage.getItem(storageKey('t'))).toBeNull();
  });

  test('a corrupt entry reads as no preference rather than throwing', () => {
    localStorage.setItem(storageKey('t'), '{not json');
    expect(loadPrefs('t', COLUMNS)).toEqual(DEFAULT_PREFS);
  });

  test('two tables do not share an entry', () => {
    savePrefs('a', { widths: { ns: 300 }, order: [], hidden: [], rows: 'compact' });
    expect(loadPrefs('b', COLUMNS).widths).toEqual({});
  });
});
