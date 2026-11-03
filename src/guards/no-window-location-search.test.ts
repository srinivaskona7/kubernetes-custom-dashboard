// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * The console reads its query string from the router, never from `window.location`.
 *
 * It mounts under HashRouter, so a page's parameters live after the `#`
 * (`/kyma-fleet-dashboard/#/clusters/x?tab=network&section=outbound`) and `window.location.search`
 * is the empty string on every page. A read of it is a filter that never applies, with no error and
 * no failing test: the Outbound failures card on Network Operations → Overview linked to a filter
 * that `TracesTab` could never see, so the link opened the unfiltered list. `useSearchParams()` is
 * the way in, and so is react-router's `useLocation()`, whose `search` is the hash's.
 *
 * Flagged: `window.location.search` and every spelling of the same read: `window['location']`,
 * `location['search']`, `?.`, a line break before `.search`, and `const { search } = window.location`,
 * on `window`, `globalThis`, `document` or `self`. Not flagged: a bare `location.search`, because in
 * the console that name is the `useLocation()` result, and an alias (`const loc = window.location`).
 * Comments come off through the string-aware scanner the API digest uses, so a slash-star inside a
 * string cannot hide the read after it; JSX text holding `//` still reads as a line comment.
 * Strings are kept, because the bracket spellings need the quoted word, so a string or a test
 * title that names the read trips the guard too: reword it.
 * Pattern `UI-10` in docs/engineering/DEFECT_PATTERNS.md.
 */





// The regex strip other guards use reads a slash-star inside a string as a comment and deletes the
// code after it (memory regex-comment-strip-eats-code).
import digestSource from '../../server/fleet/tools/api-digest-source.js';
const { stripComments } = digestSource;

const SRC = path.resolve(FAKE_DIR, '..', '..', 'src');

const GLOBAL_LOCATION = String.raw`\b(?:window|globalThis|document|self)\.location\b`;
const SEARCH_READS = [
  new RegExp(String.raw`${GLOBAL_LOCATION}\.search\b`),
  new RegExp(String.raw`\{[^}]*\bsearch\b[^}]*\}\s*=\s*${GLOBAL_LOCATION}`)
];

/** `window['location']`, `location['search']`, `?.` and a line break all spell the plain read. */
const plain = code =>
  code
    .replace(/\?\./g, '.')
    .replace(/\[\s*(['"`])(\w+)\1\s*\]/g, '.$2')
    .replace(/\s*\.\s*/g, '.')
    // `window?.['location']` leaves two dots in a row once both rewrites have run.
    .replace(/\.{2,}/g, '.');

function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if ((entry.isDirectory() && entry.name !== 'guards')) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const readsWindowSearch = text => {
  const code = plain(stripComments(text));
  return SEARCH_READS.some(re => re.test(code));
};

test('the console reads query parameters from the router, not from window.location', () => {
  const files = sources(SRC);
  assert.ok(files.length > 50, `the walk found ${files.length} source files; it is looking in the wrong place`);

  const offenders = files
    .filter(file => readsWindowSearch(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(SRC, file));

  assert.deepEqual(
    offenders,
    [],
    'window.location.search is always empty under HashRouter; read the parameter with useSearchParams()'
  );
});

test('the guard flags every spelling of a window search read and ignores comments and the router location (canary)', () => {
  const reads = [
    'const p = new URLSearchParams(window.location.search);',
    'const p = new URLSearchParams(globalThis.location.search);',
    'const p = new URLSearchParams(window.location\n    .search);',
    'const p = new URLSearchParams(window.location?.search);',
    "const p = new URLSearchParams(window['location'].search);",
    "const p = new URLSearchParams(window.location['search']);",
    "const p = new URLSearchParams(window?.['location']?.['search']);",
    'const { search } = window.location;',
    'const { hash, search: query } = window.location;',
    // A slash-star inside a string opens no comment, so the read after it still counts.
    "const glob = '/*';\nconst p = window.location.search;\n/* a real comment */"
  ];
  for (const src of reads) assert.ok(readsWindowSearch(src), `not flagged: ${src}`);

  const clean = [
    '// window.location.search is always empty here\nconst a = 1;',
    '/* window.location.search\n   is always empty */ const a = 1;',
    'const location = useLocation();\nconst p = new URLSearchParams(location.search);',
    'const { search } = useLocation();',
    'window.location.reload();',
    'const origin = window.location.origin;'
  ];
  for (const src of clean) assert.ok(!readsWindowSearch(src), `flagged: ${src}`);
});
