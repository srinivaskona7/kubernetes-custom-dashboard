// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * Where an Overview tile lands, enforced as a source check.
 *
 * The cluster Overview is a grid of tiles, each naming a topic and opening the screen that renders
 * it. Every tile used to set `?tab=` alone and let the destination tab pick its own sub-section —
 * and `useSection` picks by *silently replacing* any `?section=` it does not recognise with its own
 * default. So a tile could name a topic, arrive on a screen that did not contain it, and look
 * entirely deliberate doing so. Three tiles pointed at Security & Compliance and all three landed
 * on `isolation`; eight of seventeen were wrong the same way.
 *
 * Nothing else in this repo can catch that. The link is a valid URL, TypeScript is satisfied (the
 * section is a `string`), the page renders, and the only symptom is an operator reading the wrong
 * screen. Hence this file, which asserts the vocabulary itself:
 *
 *   1. `TAB_SECTIONS` in `tabs.ts` is the single list of every `?section=` value, keyed by a real
 *      `Tab` id, and every list it holds is rendered by a component.
 *   2. Every Overview destination names a section that exists in its target tab's list — and names
 *      one at all whenever the target tab has sections.
 *   3. Every component derives its `useSection` fallback from `SECTIONS[0].id` rather than
 *      repeating the literal, so "the first entry is the default" cannot drift.
 *
 * Rule 3 is what makes rule 2 worth having. A tile may legitimately point at a tab's default
 * section, and that link is only correct if the default is the entry the vocabulary says it is.
 */




const UI_SRC = path.join(FAKE_DIR, '../../src');

const read = rel => fs.readFileSync(path.join(UI_SRC, rel), 'utf8');

/** Block and line comments removed, so an id named only in prose never satisfies a rule. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every `.ts`/`.tsx` file under `src`, so a new tab cannot opt out by living somewhere new. */
function sourceFiles(dir = UI_SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if ((entry.isDirectory() && entry.name !== 'guards')) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The `Tab` union, which is what a `TAB_SECTIONS` key has to be one of. */
function parseTabUnion() {
  const code = stripComments(read('pages/cluster-tabs/tabs.ts'));
  const union = /export type Tab =([\s\S]*?);/.exec(code);
  assert.ok(union, 'the `Tab` union was not found in tabs.ts');
  const tabs = [...union[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(tabs.length >= 10, `expected the full tab union, parsed only ${tabs.length}`);
  return tabs;
}

/**
 * `TAB_SECTIONS` as a `Map<tab, orderedSectionIds>`.
 *
 * Line-based rather than one regex over the whole literal: the lists carry comments between their
 * entries (the `connections` label has a note that must not be lost to a refactor), and a parser
 * that quietly matched fewer entries than exist would weaken every assertion below it.
 */
function parseTabSections() {
  const code = stripComments(read('pages/cluster-tabs/tabs.ts'));
  const block = /export const TAB_SECTIONS = \{([\s\S]*?)\n\} as const;/.exec(code);
  assert.ok(
    block,
    'TAB_SECTIONS is gone or is no longer a single `as const` object literal in tabs.ts. It is ' +
      'the only place a tile can check its destination against, so it cannot move without this ' +
      'guard moving with it.'
  );

  const out = new Map();
  let current = null;
  for (const line of block[1].split('\n')) {
    const open = /^ {2}([A-Za-z]+): \[/.exec(line);
    if (open) {
      current = [];
      out.set(open[1], current);
      continue;
    }
    if (/^ {2}\]/.test(line)) {
      current = null;
      continue;
    }
    const id = /\{ id: '([a-z-]+)'/.exec(line);
    if (current && id) current.push(id[1]);
  }

  assert.ok(out.size >= 8, `expected every sectioned tab, parsed only ${out.size}`);
  for (const [tab, ids] of out) {
    // One is enough: `networking`, `istio` and `certificates` are single-view tabs that list their
    // one view so the `?section=` deep link and the tab's description have a registered home. A
    // list that parsed as empty is the failure this floor exists to catch.
    assert.ok(ids.length >= 1, `TAB_SECTIONS.${tab} parsed as ${ids.length} section(s)`);
    assert.equal(new Set(ids).size, ids.length, `TAB_SECTIONS.${tab} repeats a section id`);
  }
  return out;
}

/** One Overview tile list, as `{ label, tab, section }` rows. */
function parseTopics(name) {
  const code = stripComments(read('pages/cluster-tabs/OverviewTab.tsx'));
  const block = new RegExp(`const ${name}: Topic\\[\\] = \\[([\\s\\S]*?)\\n\\];`).exec(code);
  assert.ok(block, `${name} was not found in OverviewTab.tsx`);

  const rows = [];
  for (const line of block[1].split('\n')) {
    if (!/label:/.test(line)) continue;
    const label = /label: '([^']+)'/.exec(line);
    const tab = /tab: (?:'([a-z-]+)'|null)/.exec(line);
    assert.ok(label, `a ${name} entry has no parsable label: ${line.trim()}`);
    assert.ok(tab, `${name} entry "${label[1]}" has no parsable \`tab:\` — every tile states one`);
    const section = /section: '([a-z-]+)'/.exec(line);
    rows.push({ label: label[1], tab: tab[1] ?? null, section: section ? section[1] : null });
  }
  return rows;
}

/**
 * The tile count, pinned low and high.
 *
 * Low because a parser that matches nothing passes every destination check below it. High because
 * the grid was deliberately cut from eighteen cells to a handful of pillars (five since the modules
 * tile went with the Modules & Telemetry tab), and the failure mode of an
 * Overview is re-accretion: each new summary group arrives with an obvious argument for its own
 * tile, and eighteen is what that looks like after eleven of those arguments win. Crossing this
 * ceiling should be a decision someone writes down here, not a diff nobody notices.
 */
const MIN_TILES = 5;
const MAX_TILES = 8;

test('every TAB_SECTIONS key is a real tab, and every list is rendered by something', () => {
  const tabs = new Set(parseTabUnion());
  const sections = parseTabSections();
  const files = sourceFiles();

  for (const tab of sections.keys()) {
    assert.ok(
      tabs.has(tab),
      `TAB_SECTIONS.${tab} is not in the \`Tab\` union, so no \`?tab=\` value reaches it`
    );

    const consumers = files.filter(f => {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      return new RegExp(`TAB_SECTIONS\\.${tab}\\b`).test(code);
    });
    assert.ok(
      consumers.length > 0,
      `TAB_SECTIONS.${tab} is read by no component. A section list nothing renders is a ` +
        `destination an Overview tile can point at and a screen that will never show it.`
    );
  }
});

test('every Overview tile names a section that exists in the tab it opens', () => {
  const sections = parseTabSections();
  const tabs = new Set(parseTabUnion());
  const rows = parseTopics('TOPICS');

  assert.ok(
    rows.length >= MIN_TILES && rows.length <= MAX_TILES,
    `the Overview grid has ${rows.length} tiles, outside the agreed ${MIN_TILES}\u2013${MAX_TILES}. ` +
      `Below ${MIN_TILES} this parser may simply have stopped matching, which would make every ` +
      `destination check below pass while checking nothing. Above ${MAX_TILES} the screen is ` +
      `drifting back into the eighteen-cell index it was cut down from \u2014 if the new tile is ` +
      `genuinely a pillar, raise MAX_TILES here and say which one it replaces.`
  );

  for (const row of rows) {
    if (row.tab === null) {
      assert.equal(
        row.section,
        null,
        `tile "${row.label}" has no tab but names a section — there is nowhere for it to apply`
      );
      continue;
    }

    assert.ok(tabs.has(row.tab), `tile "${row.label}" opens '${row.tab}', which is not a tab`);
    const list = sections.get(row.tab);

    if (!list) {
      assert.equal(
        row.section,
        null,
        `tile "${row.label}" opens '${row.tab}', which has no sub-sections, yet names ` +
          `section '${row.section}'. \`?section=\` would be set and ignored.`
      );
      continue;
    }

    assert.ok(
      row.section,
      `tile "${row.label}" opens '${row.tab}', which has ${list.length} sub-sections, and names ` +
        `none. The tab would pick its default (${list[0]}) — the bug this file exists to stop.`
    );
    assert.ok(
      list.includes(row.section),
      `tile "${row.label}" opens '${row.tab}&section=${row.section}', which is not one of ` +
        `[${list.join(', ')}]. \`useSection\` would silently land on '${list[0]}' instead.`
    );
  }
});

test('every tab takes its useSection default from the first entry of its own list', () => {
  const sections = parseTabSections();
  const seen = new Set();

  for (const file of sourceFiles()) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(UI_SRC, file);

    for (const m of code.matchAll(/const (\w+) = TAB_SECTIONS\.(\w+);/g)) {
      const [, name, tab] = m;
      assert.ok(sections.has(tab), `${rel} reads TAB_SECTIONS.${tab}, which does not exist`);
      seen.add(tab);

      // The list may be handed to a nested component instead of driving a `useSection` here; only
      // a file that actually calls the hook has a fallback to get wrong.
      const call = new RegExp(`useSection<[^>]*>\\(\\s*${name}\\s*,\\s*([^)]+?)\\s*\\)`).exec(code);
      if (!call) continue;
      assert.equal(
        call[1],
        `${name}[0].id`,
        `${rel} passes \`${call[1]}\` as the useSection fallback for ${name}. It must be ` +
          `\`${name}[0].id\`: a repeated literal can drift from the list, and an Overview tile ` +
          `pointing at this tab's default section is only correct while the two agree.`
      );
    }
  }

  for (const tab of sections.keys()) {
    assert.ok(seen.has(tab), `TAB_SECTIONS.${tab} is never assigned to a component's SECTIONS`);
  }
});

/**
 * The Overview grid says nothing apologetic, and cannot.
 *
 * Three of the old eighteen cells went nowhere, and each one explained itself in grey text: "Not
 * summarised — too expensive to poll", "Collected by the server; no screen renders it yet". Both
 * sentences are true and neither is an operator's problem. They are the console describing its own
 * implementation on the first screen of a cluster, and the reason they existed is that `Topic`
 * allowed `key: null` and `tab: null`.
 *
 * So this checks the *shape*, not just the strings: with every field required, a cell with no
 * verdict or no destination cannot be added without a type error, and the apologies have nothing to
 * describe. Checking the strings alone would let the next `tab: null` tile arrive with fresh prose.
 */
test('no Overview tile has a dead destination or apologises for itself', () => {
  const src = read('pages/cluster-tabs/OverviewTab.tsx');
  const code = stripComments(src);

  const iface = /interface Topic \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(iface, 'the `Topic` interface is gone from OverviewTab.tsx');
  for (const field of ['key', 'label', 'what', 'tab', 'section']) {
    assert.match(
      iface[1],
      new RegExp(`\\n\\s*${field}: `),
      `\`Topic.${field}\` is missing or optional. Every field is required on purpose: \`key\` is ` +
        `what guarantees the tile has a verdict, \`tab\`/\`section\` that it has somewhere real to ` +
        `go. Making one optional re-opens the dead-end cell this test exists to prevent.`
    );
  }
  assert.doesNotMatch(
    iface[1],
    /\|\s*null|\?:/,
    'a `Topic` field is nullable or optional again. That is exactly how the three dead cells got ' +
      'onto the grid — and a dead cell has to apologise for itself in prose, which is what the ' +
      'strings below check for.'
  );

  for (const phrase of ['too expensive to poll', 'no screen renders it yet', 'Not summarised']) {
    assert.ok(
      !code.includes(phrase),
      `the Overview still says "${phrase}". That is the console explaining its own implementation ` +
        `on the first screen an operator opens. If a topic cannot be summarised it does not belong ` +
        `on this grid at all — the tab still has a permanent link in the rail.`
    );
  }

  assert.ok(
    !/LINK_ONLY/.test(code),
    '`LINK_ONLY` is back. A tile with no verdict is a second copy of a rail link wearing the ' +
      'costume of one; the rail already links every tab.'
  );
});
