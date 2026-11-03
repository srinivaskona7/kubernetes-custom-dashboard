import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Seed source for the SQLite DB — only read by loadDb() when the books table is empty.
export async function loadBooks() {
  const log = getLogger();
  const localPath = join(__dirname, '..', 'config', 'config.local.json');
  const raw = await readFile(localPath, 'utf-8');
  const config = JSON.parse(raw);

  const books = validateBooks(config.books);

  log.info({ books: books.length }, 'Books loaded');
  return books;
}

// Pure validation, split out from loadBooks() so it can be unit-tested without
// touching the filesystem. Throws on invalid input; returns the books on success.
export function validateBooks(books) {
  if (!Array.isArray(books) || books.length === 0) {
    throw new Error('config.local.json must contain a non-empty "books" array');
  }
  for (const b of books) {
    if (!b.id || !b.title || !b.author || !b.genre) {
      throw new Error(`Book "${b.id || b.title || '(unknown)'}" is missing required fields (id, title, author, genre)`);
    }
  }
  return books;
}

const DEFAULT_APP_CONFIG_FILE = '/etc/fleet-dashboard/config.json';

// Optional deployment config, mounted from a ConfigMap at APP_CONFIG_FILE. Absent is normal, and
// unreadable or malformed is logged and treated the same: a bad config file must not stop the
// server from starting. Never throws.
export async function loadAppConfig(env = process.env) {
  const log = getLogger();
  const path = env.APP_CONFIG_FILE || DEFAULT_APP_CONFIG_FILE;
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn({ path, err: err.message }, 'App config unreadable, continuing without it');
    return null;
  }
  try {
    const config = JSON.parse(raw);
    log.info({ path }, 'App config loaded');
    return config;
  } catch (err) {
    log.warn({ path, err: err.message }, 'App config is not valid JSON, continuing without it');
    return null;
  }
}
