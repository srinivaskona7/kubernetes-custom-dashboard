/** When a changed `useAsync` key may keep the rows on screen, and when it must blank them. */
import { describe, expect, it } from 'vitest';
import { createRetainStore, isStaleRead, keepsDataAcrossKeyChange } from './async-retain';

describe('keepsDataAcrossKeyChange', () => {
  it('keeps the rows when only the read window moved under the same subject', () => {
    expect(keepsDataAcrossKeyChange('platform-sbx', 'platform-sbx')).toBe(true);
  });

  it('blanks when the subject changed: another cluster must never show the previous one’s rows', () => {
    expect(keepsDataAcrossKeyChange('platform-sbx', 'appkymadv')).toBe(false);
  });

  it('blanks when the caller named no subject, the hook’s original contract', () => {
    expect(keepsDataAcrossKeyChange(undefined, undefined)).toBe(false);
  });
});

describe('isStaleRead', () => {
  it('marks rows from an older key as stale while the new read runs', () => {
    expect(isStaleRead(true, 'a:1000', 'a:500')).toBe(true);
  });

  it('is not stale once the rows belong to the current key, or when nothing is held', () => {
    expect(isStaleRead(true, 'a:500', 'a:500')).toBe(false);
    expect(isStaleRead(false, undefined, 'a:500')).toBe(false);
  });
});

describe('createRetainStore: the last good read survives an unmount', () => {
  it('hands back the rows a remounted tab last read for the same subject and key', () => {
    const store = createRetainStore<string>(4);
    store.put('sbx', 'sbx|500', 'rows', 1000);
    expect(store.get('sbx', 'sbx|500')).toEqual({ value: 'rows', fetchedAt: 1000 });
  });

  it('never hands one cluster the rows of another, or another window of the same one', () => {
    const store = createRetainStore<string>(4);
    store.put('sbx', 'sbx|500', 'rows', 1000);
    expect(store.get('dev', 'sbx|500')).toBeUndefined();
    expect(store.get('sbx', 'sbx|1000')).toBeUndefined();
  });

  it('keeps no read for a caller that names no subject', () => {
    const store = createRetainStore<string>(4);
    store.put(undefined, 'k', 'rows', 1000);
    expect(store.get(undefined, 'k')).toBeUndefined();
  });

  it('drops the least recently written entry past its limit', () => {
    const store = createRetainStore<string>(2);
    store.put('a', 1, 'a', 1);
    store.put('b', 1, 'b', 2);
    store.put('a', 1, 'a2', 3);
    store.put('c', 1, 'c', 4);
    expect(store.get('b', 1)).toBeUndefined();
    expect(store.get('a', 1)?.value).toBe('a2');
    expect(store.get('c', 1)?.value).toBe('c');
  });
});
