// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * Source-reading guards for the sampled-window disclosures.
 *
 * `app/fleet-ui` runs vitest under `environment: 'node'` and jsdom cannot be installed here, so a
 * rule that has to live inside JSX is pinned by reading the .tsx as text. Every rule below is one a
 * reviewer could otherwise only catch by eye, and each was wrong in exactly the way asserted:
 *
 *   - the "HTTP requests timed" tile printed `lat.httpRequests`, which counts every HTTP record
 *     whether or not it carried a duration — overstating how many requests were actually timed;
 *   - the Observability tab's own sources section named the read but never its selection bias, so a
 *     mesh-wide p95 drawn from an ingress-first, cap-limited sample read as a mesh-wide fact;
 *   - the mesh-wide response-code shares on Traffic Errors said the same thing with the same silence.
 *
 * The string rules themselves live in `traffic/sample-basis.ts` and are unit-tested there. These
 * guards pin only that the JSX still calls them, and still calls them on the right number.
 */




const UI = path.join(FAKE_DIR, '..', '..', 'src', 'pages', 'cluster-tabs');
const read = f => fs.readFileSync(path.join(UI, f), 'utf8');

test('the mesh-wide response-code shares on Traffic Errors carry the bias line', () => {
  const src = read('TrafficTab.tsx');
  assert.match(src, /const biasLine = selectionBiasLine\(w\)/);
  assert.match(src, /Response codes across the whole mesh[\s\S]{0,400}\$\{biasLine\}/);
});

test('the host table is introduced with both denominators named', () => {
  const src = read('TrafficTab.tsx');
  const note = src.slice(src.indexOf("activeSection === 'hosts'"), src.indexOf('<IngressHosts'));
  // records, HTTP requests and connections all named, and the tile that shows the other one called out.
  assert.match(note, /summary\.records\.toLocaleString\(\)/);
  assert.match(note, /summary\.requests\.toLocaleString\(\)/);
  assert.match(note, /summary\.connections\.toLocaleString\(\)/);
  assert.match(note, /Sampled requests/);
});

test('every windowLine interpolation on the Traffic tab is guarded, so an absent window prints nothing', () => {
  const src = read('TrafficTab.tsx');
  // An unguarded `${windowLine}.` renders a stray "." (or ". ") when there is no window at all.
  // Each occurrence must sit inside a ternary on `windowLine`.
  const occurrences = [...src.matchAll(/\$\{windowLine\}/g)];
  assert.ok(occurrences.length > 0, 'the window is still stated somewhere');
  for (const m of occurrences) {
    const around = src.slice(Math.max(0, m.index - 220), m.index + 40);
    assert.match(around, /windowLine \?/, `unguarded windowLine at index ${m.index}`);
  }
});
