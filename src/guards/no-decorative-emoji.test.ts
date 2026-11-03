// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * No decorative emoji in the console.
 *
 * Seven emoji tiles ("🚀 Workloads", "🌐 Networking", …) had grown on the Overview rail and five
 * more across Drift's cards and sub-tabs. Each one cost a line of vertical space on a console whose
 * density budget is spent on data, none of them carried information the adjacent label did not, and
 * one — a ⚠️ — was standing in for a status indicator, which means it was load-bearing decoration:
 * delete it naively and the banner signals with colour alone, which this console does not do.
 *
 * Functional glyphs stay, and the distinction is mechanical rather than a matter of taste:
 *
 *   allowed   text-presentation symbols and arrows — ▲ ▼ ↕ ✕ ✓ ↻ ▾ ▸ ⌘ − …  they render as glyphs
 *             in the UI font, inherit `currentColor`, and are affordances (sort direction, close,
 *             collapse) with no emoji rendering anywhere.
 *   banned    anything in the pictographic planes (U+1F000–U+1FAFF), and any character followed by
 *             U+FE0F, the emoji-presentation variation selector. ☸️ and ⚠️ are banned by the second
 *             rule while ✕ and ▲ pass, which is exactly the line.
 *
 * The U+FE0F rule is the useful half: it catches a BMP symbol deliberately asked to render as a
 * colour emoji, which is the thing that looks out of place, rather than trying to enumerate glyphs.
 */





const SRC = path.resolve(FAKE_DIR, '..', '..', 'src');

const VARIATION_SELECTOR_16 = 0xfe0f;

/** Walk every source file the UI actually ships. */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if ((entry.isDirectory() && entry.name !== 'guards')) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Find emoji-presentation characters in one file.
 *
 * A code-point walk rather than a regex with a character class: the input is by definition full of
 * astral-plane characters, and a `.` or a `[^…]` in a non-unicode regex splits a surrogate pair and
 * matches half of one. This is the same reason router.js walks code points to strip control chars.
 */
function emojiIn(text) {
  const points = [...text];
  const found = [];
  for (let i = 0; i < points.length; i += 1) {
    const ch = points[i];
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const pictographic = cp >= 0x1f000 && cp <= 0x1faff;
    const forcedEmoji = points[i + 1] !== undefined && points[i + 1].codePointAt(0) === VARIATION_SELECTOR_16;
    if (pictographic || forcedEmoji) {
      found.push({ ch, cp: `U+${cp.toString(16).toUpperCase()}`, line: text.slice(0, text.indexOf(ch)).split('\n').length });
    }
  }
  return found;
}

test('no source file renders a decorative emoji', () => {
  const offences = [];
  for (const file of sources(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const hit of emojiIn(text)) {
      offences.push(`${path.relative(SRC, file)}:${hit.line} ${hit.cp} ${hit.ch}`);
    }
  }

  assert.deepStrictEqual(
    offences,
    [],
    'these are emoji, not UI glyphs:\n  ' +
      offences.join('\n  ') +
      '\nUse the label alone, or a <Dot tone> if the glyph was carrying status. Text-presentation ' +
      'symbols (▲ ▼ ✕ ✓ ↻) are fine — it is the pictographs and anything followed by U+FE0F that are not.',
  );
});

test('the scan recognises an emoji when one is present', () => {
  // Canary: the assertion above passes trivially if `emojiIn` never matches anything. Both halves
  // of the rule are exercised — a pictograph, and a BMP symbol forced into emoji presentation.
  assert.strictEqual(emojiIn('<span>\u{1F680}</span>').length, 1, 'missed a pictographic emoji');
  assert.strictEqual(emojiIn('<span>⚠️</span>').length, 1, 'missed a U+FE0F emoji presentation');
  assert.deepStrictEqual(emojiIn('{sorted ? ▲ : ▼} ✕ ✓ ↻'), [], 'flagged a functional glyph');
});
