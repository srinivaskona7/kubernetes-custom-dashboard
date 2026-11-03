import { describe, it, expect } from 'vitest';
import { validateBooks } from '../config.js';

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
