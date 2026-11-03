import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getWhisperSecret } from './lib/whisper.js';
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

export async function loadWhisper() {
  const log = getLogger();
  const secretName = process.env.WHISPER_SECRET_NAME || 'btp-kyma-fleet-dashboard-prod';
  const namespace = process.env.WHISPER_NAMESPACE || 'btp-pltform-security';

  try {
    const raw = await getWhisperSecret(secretName, namespace);
    log.info({ secretName, namespace }, 'Whisper secret loaded');
    return raw;
  } catch (err) {
    log.warn({ err: err.message }, 'Whisper unavailable, continuing without it');
    return null;
  }
}
