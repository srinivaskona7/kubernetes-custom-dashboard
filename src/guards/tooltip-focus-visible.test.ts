// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * A hover tooltip may open on keyboard focus, never on any focus.
 *
 * `focus-within` also matches the focus a mouse click leaves on the button, so the Namespaces
 * sub-tab's tooltip stayed open after the pointer left (reported 2026-09-27). `:focus-visible` is
 * the keyboard-only form: the tip still opens when tabbing through the strip.
 */




const SRC = path.join(FAKE_DIR, '..', '..', 'src');
const OPENS_ON_FOCUS = /focus-within(?:\/[\w-]+)?:(?:visible|opacity-100|block|flex)\b/;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if ((e.isDirectory() && e.name !== 'guards')) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test('no tooltip opens on focus-within (it would stick after a click)', () => {
  const hits = sources(SRC).flatMap(file =>
    fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
      OPENS_ON_FOCUS.test(line) ? [`${path.relative(SRC, file)}:${i + 1}`] : []
    )
  );
  assert.deepStrictEqual(hits, [], `use group-has-[:focus-visible] instead: ${hits.join(', ')}`);
});
