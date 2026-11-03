import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBooks, loadAppConfig } from '../config.js';

// Sample test demonstrating the convention: extract pure functions from I/O so
// they can be unit-tested, and co-locate the test under __tests__/ next to the
// module it covers. Every new server-side function should get a test like this.

const validBooks = [
  { id: '1', title: 'The Pragmatic Programmer', author: 'Hunt & Thomas', genre: 'Software' },
  { id: '2', title: 'Sapiens', author: 'Yuval Noah Harari', genre: 'History' },
];

describe('validateBooks', () => {
  it('returns the books unchanged when valid', () => {
    expect(validateBooks(validBooks)).toBe(validBooks);
  });

  it('throws when books is not an array', () => {
    expect(() => validateBooks(undefined)).toThrow(/non-empty "books" array/);
    expect(() => validateBooks({})).toThrow(/non-empty "books" array/);
  });

  it('throws when books is empty', () => {
    expect(() => validateBooks([])).toThrow(/non-empty "books" array/);
  });

  it('throws when a book is missing required fields', () => {
    expect(() => validateBooks([{ id: '1', title: 'A', author: 'X' }])).toThrow(/missing required fields/);
    expect(() => validateBooks([{ title: 'A', author: 'X', genre: 'G' }])).toThrow(/missing required fields/);
  });
});

describe('loadAppConfig', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  const file = (content) => {
    dir = mkdtempSync(join(tmpdir(), 'app-config-'));
    const path = join(dir, 'config.json');
    if (content !== undefined) writeFileSync(path, content);
    return path;
  };

  it('returns the parsed object from APP_CONFIG_FILE', async () => {
    const path = file(JSON.stringify({ title: 'Prod fleet' }));
    expect(await loadAppConfig({ APP_CONFIG_FILE: path })).toEqual({ title: 'Prod fleet' });
  });

  it('returns null when the file does not exist', async () => {
    expect(await loadAppConfig({ APP_CONFIG_FILE: file() })).toBeNull();
  });

  it('returns null, never throws, on a file that is not JSON', async () => {
    expect(await loadAppConfig({ APP_CONFIG_FILE: file('{not json') })).toBeNull();
  });

  it('defaults to /etc/fleet-dashboard/config.json, which is absent here', async () => {
    expect(await loadAppConfig({})).toBeNull();
  });
});
