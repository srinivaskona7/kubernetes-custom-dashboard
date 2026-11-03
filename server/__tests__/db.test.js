import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, seedBooks, listBooks, getBook, listAuthors, listGenres, loadDb } from '../db.js';
import redisStoreModule from '../fleet/redis-store.js';
const { FleetRedisStore, memClusters, memTokens, memDeleted } = redisStoreModule;

const SAMPLE = [
  { id: 'b2', title: 'Two', author: 'Ann', genre: 'Sci-Fi' },
  { id: 'b1', title: 'One', author: 'Ann', genre: 'History' },
  { id: 'b3', title: 'Three', author: 'Bob', genre: 'Sci-Fi' },
];

function memDb(books = SAMPLE) {
  const db = new Database(':memory:');
  initSchema(db);
  seedBooks(db, books);
  return db;
}

describe('initSchema', () => {
  it('creates the books, fleet_clusters, and fleet_tokens tables', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(names).toContain('books');
    expect(names).toContain('fleet_clusters');
    expect(names).toContain('fleet_tokens');
  });

  it('indexes author and genre', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(['idx_books_author', 'idx_books_genre']));
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
  });
});

describe('seedBooks', () => {
  it('ignores extra fields on input objects', () => {
    const db = memDb([{ id: 'x', title: 'X', author: 'A', genre: 'G', isbn: '123' }]);
    expect(getBook(db, 'x')).toEqual({ id: 'x', title: 'X', author: 'A', genre: 'G' });
  });

  it('rolls back the whole batch on a duplicate id', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => seedBooks(db, [SAMPLE[0], SAMPLE[0]])).toThrow();
    expect(listBooks(db)).toEqual([]);
  });
});

describe('queries', () => {
  it('listBooks returns all books ordered by id', () => {
    expect(listBooks(memDb()).map(b => b.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('getBook returns a book or undefined', () => {
    const db = memDb();
    expect(getBook(db, 'b3').title).toBe('Three');
    expect(getBook(db, 'nope')).toBeUndefined();
  });

  it('listAuthors aggregates book counts', () => {
    expect(listAuthors(memDb())).toEqual([
      { name: 'Ann', bookCount: 2 },
      { name: 'Bob', bookCount: 1 },
    ]);
  });

  it('listGenres aggregates book counts', () => {
    expect(listGenres(memDb())).toEqual([
      { name: 'History', bookCount: 1 },
      { name: 'Sci-Fi', bookCount: 2 },
    ]);
  });
});

describe('loadDb', () => {
  const tmpPath = join(tmpdir(), `bps-test-${process.pid}`, 'app.db');

  afterEach(() => {
    delete process.env.DB_PATH;
    rmSync(join(tmpPath, '..'), { recursive: true, force: true });
  });

  it('creates the DB at DB_PATH and seeds it from config.local.json', async () => {
    process.env.DB_PATH = tmpPath;
    const db = await loadDb();
    expect(listBooks(db).length).toBeGreaterThan(0);
    db.close();
  });

  it('does not reseed a non-empty DB on restart', async () => {
    process.env.DB_PATH = tmpPath;
    const first = await loadDb();
    first.prepare('DELETE FROM books WHERE id != ?').run(listBooks(first)[0].id);
    first.close();
    const second = await loadDb();
    expect(listBooks(second)).toHaveLength(1);
    second.close();
  });

  it('persists fleet_clusters and fleet_tokens schema tables across database restarts', async () => {
    process.env.DB_PATH = tmpPath;
    const firstDb = await loadDb();
    const tables = firstDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tables).toContain('fleet_clusters');
    expect(tables).toContain('fleet_tokens');
    firstDb.close();
  });
});
