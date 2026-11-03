import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadBooks } from './config.js';
import { getLogger } from './logger.js';

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      genre TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_books_author ON books (author);
    CREATE INDEX IF NOT EXISTS idx_books_genre ON books (genre);
    CREATE TABLE IF NOT EXISTS fleet_clusters (
      id TEXT PRIMARY KEY,
      displayName TEXT,
      env TEXT,
      apiUrl TEXT,
      namespace TEXT,
      serviceAccount TEXT,
      data TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fleet_tokens (
      cluster_id TEXT PRIMARY KEY,
      token TEXT,
      expires_at TEXT,
      renewed_at TEXT,
      last_error TEXT,
      updated_at TEXT
    );
  `);
}

// Inserts the given books in one transaction. Only called on an empty table, so
// edits made in the DB are never overwritten by the seed file on restart.
export function seedBooks(db, books) {
  const insert = db.prepare('INSERT INTO books (id, title, author, genre) VALUES (@id, @title, @author, @genre)');
  db.transaction((rows) => {
    for (const b of rows) insert.run({ id: b.id, title: b.title, author: b.author, genre: b.genre });
  })(books);
}

export function listBooks(db) {
  return db.prepare('SELECT id, title, author, genre FROM books ORDER BY id').all();
}

export function getBook(db, id) {
  return db.prepare('SELECT id, title, author, genre FROM books WHERE id = ?').get(id);
}

export function listAuthors(db) {
  return db.prepare('SELECT author AS name, COUNT(*) AS bookCount FROM books GROUP BY author ORDER BY author').all();
}

export function listGenres(db) {
  return db.prepare('SELECT genre AS name, COUNT(*) AS bookCount FROM books GROUP BY genre ORDER BY genre').all();
}

export async function loadDb() {
  const log = getLogger();
  const path = process.env.DB_PATH || './data/app.db';
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  const count = db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
  if (count === 0) {
    seedBooks(db, await loadBooks());
    log.info('Seeded books from config.local.json');
  }
  log.info({ path }, 'SQLite database loaded');
  return db;
}
