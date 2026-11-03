// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as colw from './helpers/column-width';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/*
  Source guards for the Traces cleanup (plan 2026-09-27, Task 6 step 5 and Task 7 step 4). The tab
  is JSX with no DOM test environment, so the structure it promises is pinned on the source.
*/




const TABS = path.join(FAKE_DIR, '../../src/pages/cluster-tabs');
// Comments stripped, so prose neither satisfies nor trips a rule (.claude/rules/tests.md).
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = f => stripComments(fs.readFileSync(path.join(TABS, f), 'utf8'));
const tab = read('TracesTab.tsx');
const map = read('TracesServiceMap.tsx');

test('Traces has the six approved views, in order, with stable ids', () => {
  const src = read('tabs.ts');
  const block = src.slice(src.indexOf('traces: ['), src.indexOf(']', src.indexOf('traces: [')));
  const ids = [...block.matchAll(/id: '([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(ids, ['journeys', 'successful', 'map', 'endpoints', 'outbound', 'refused']);
  assert.match(block, /label: 'Service calls'/);
  assert.match(block, /label: 'Blocked requests'/);
});

test('Refused Requests never calls a request an attack', () => {
  for (const f of ['TracesRefused.tsx', 'ingress/refused-view.ts']) {
    assert.doesNotMatch(read(f), /\b(attack|hacker|malicious)/i, f);
  }
});

test('Refused Requests does not read /traffic-errors twice: TracesTab owns the one read', () => {
  const refused = read('TracesRefused.tsx');
  assert.doesNotMatch(refused, /api\.clusterTrafficErrors\(/, 'TracesRefused fetches its own copy of the read TracesTab already made');
  // CANARY: the pattern itself must actually catch a duplicated read.
  assert.match('const { data } = useAsync(() => api.clusterTrafficErrors(id, {}), 0, key);', /api\.clusterTrafficErrors\(/);
});

test('every hook in TracesTab runs before its first early return', () => {
  const body = tab.slice(tab.indexOf('export default function TracesTab'));
  const firstReturn = body.indexOf('if (loading && !data) return');
  assert.ok(firstReturn > 0, 'early return anchor not found');
  const after = body.slice(firstReturn);
  assert.doesNotMatch(after, /\buse(State|Ref|Effect|Memo|Callback|ProxiesPanel|Section|Async)\(/, 'a hook is called after an early return');
});

test('the default outcome applies only until a person touches the filter', () => {
  assert.match(tab, /const touched = useRef\(false\)/);
  assert.match(tab, /if \(!touched\.current && payload\)[^\n]*initialOutcome\(payload\.summary\)/);
  // The chip, a drill and the reset each mark the choice as the person's.
  for (const fn of ['const drill = ', 'const pickOutcome = ', 'const resetJourneys = ']) {
    const at = tab.indexOf(fn);
    assert.ok(at >= 0, `${fn} missing`);
    const body = tab.slice(at, tab.indexOf('\n  };', at));
    assert.match(body, /touched\.current = true/, `${fn} does not set touched`);
  }
  assert.doesNotMatch(tab, /setFilter\(o\);\s*\}\}/, 'an outcome chip sets the filter without going through pickOutcome');
});

test('the correlation banner is a badge with its text behind an InfoTip', () => {
  assert.doesNotMatch(tab, /These journeys were stitched without trace headers/);
  assert.match(tab, /Hop order inferred\s*<InfoTip text=\{correlationTip\(corr\)\}/);
});

test('Multi-hop is a chip, never a tile', () => {
  assert.doesNotMatch(tab, /label="Multi-hop"/);
  assert.doesNotMatch(tab, /lg:grid-cols-5/);
});

test('every Traces tile row holds at most 4 tiles (spec: tiles, at most 4 per sub-tab)', () => {
  for (const [file, fn] of [['TracesEndpoints.tsx', 'EndpointTiles'], ['TracesOutbound.tsx', 'OutboundTiles'], ['TracesServiceMap.tsx', 'MapTiles']]) {
    const src = read(file);
    const at = src.indexOf(`export function ${fn}(`);
    assert.ok(at >= 0, `${fn} not found`);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    const n = (body.match(/<StatTile\b/g) ?? []).length;
    assert.ok(n > 0 && n <= 4, `${fn} renders ${n} tiles`);
  }
});

test('the journeys toolbar keeps Re-read visible and folds Polls and Tail into Read options', () => {
  assert.match(tab, /<details className="relative"/);
  assert.match(tab, /Read options/);
  const journeysBar = tab.slice(tab.indexOf('title="Request journeys"'), tab.indexOf('id="traces.journeys"'));
  assert.doesNotMatch(journeysBar, /\{readTail\}/);
  assert.match(journeysBar, /\{rereadButton\}/);
});

test('a Problems strip opens investigative sub-tabs; Successful requests is summary-only', () => {
  assert.match(tab, /import \{ ProblemStrip \} from '\.\/ProblemStrip'/);
  // One element: first in Journeys and above the tile row on investigative views.
  assert.match(tab, /const problemStrip = \(\s*<ProblemStrip\b/);
  assert.match(tab, /\{section === 'journeys' && problemStrip\}\s*\{section === 'journeys' && \(\s*<Section/);
  assert.match(tab, /\{tiled && <div className="pt-4">\{problemStrip\}<\/div>\}/);
  // A positive list, so a new sub-tab shows no strip or tile row until it is added here on purpose:
  // Blocked once fell through the negations and showed the outbound strip above an empty grid.
  assert.match(tab, /const tiled = section === 'endpoints' \|\| section === 'map' \|\| section === 'outbound';/);
  assert.equal((tab.match(/\{problemStrip\}/g) ?? []).length, 1, 'the strip renders once outside Journeys');
  assert.match(tab, /<SuccessfulRequests\b/);
});

test('Successful requests is handed the kept-count caption, not a null', () => {
  // SuccessfulRequests.test.tsx renders the caption. A required prop stops a deleted prop but not
  // `kept={null}`, which is a capped window with no denominator, so the tab's own line is pinned.
  const at = tab.indexOf('<SuccessfulRequests');
  const mount = tab.slice(at, tab.indexOf('/>', at) + 2);
  assert.ok(at > 0 && mount.endsWith('/>'), 'the SuccessfulRequests element was not found');
  assert.match(mount, /\bkept=\{keptCaption\(s\)\}/);
  // CANARY: the pattern fails on a null and on a dropped prop.
  assert.doesNotMatch('<SuccessfulRequests rows={r} kept={null} />', /\bkept=\{keptCaption\(s\)\}/);
  assert.doesNotMatch('<SuccessfulRequests rows={r} />', /\bkept=\{keptCaption\(s\)\}/);
});

test('Proxies read is a chip and a panel, not a footer', () => {
  assert.match(tab, /<ProxiesChip\b/);
  assert.match(tab, /<TracesProxiesRead\b/);
  assert.doesNotMatch(tab, /uppercase tracking-\[0\.06em\] text-muted">Proxies read<\/p>/);
});

test('a map problem picks its arrow', () => {
  assert.match(map, /pickRequest\?: \{ id: string; n: number \} \| null/);
  assert.match(map, /if \(pickRequest\) setPicked\(pickRequest\.id\)/);
  assert.match(tab, /pickRequest=\{mapPick\}/);
});

test('the journeys table floor keeps rows on screen', () => {
  assert.match(tab, /min-h-\[240px\] flex-\[1_1_240px\]/);
  assert.doesNotMatch(tab, /min-h-\[120px\] flex-\[1_1_120px\]/);
});

test('Service map tile captions are 40 characters or fewer', () => {
  const tiles = map.slice(map.indexOf('export function MapTiles'), map.indexOf('export function TracesServiceMap'));
  const literals = [...tiles.matchAll(/caption="([^"]+)"/g)].map(m => m[1]);
  assert.ok(literals.length > 0, 'no literal caption found');
  for (const c of literals) assert.ok(c.length <= 40, `tile caption over 40 characters: "${c}"`);
});

test('Journeys gives the table the tile row: its tiles repeated the outcome chips one for one', () => {
  // The headline grid renders for investigative sub-tabs; Successful requests owns its own summary.
  assert.match(tab, /\{tiled && \(\s*<div className=\{?[`"]grid grid-cols-2/);
  assert.doesNotMatch(tab, /label="Correlated by"/);
  // What the tiles said that the chips do not: the cap, on the result line; the source, on the badge.
  assert.match(tab, /resultLine=\{noEvidence \? 'Journeys not read' : .*keptCaption\(s\)/);
  assert.match(tab, /Hop order inferred\s*<InfoTip[^>]*>\s*(\{\}\s*)?\{corr\.source && <span className="mono[^"]*">\{corr\.source\}<\/span>\}/);
});

test('Problems come first: the strip renders above the tile row, on Traces and on Failures', () => {
  const strip = tab.indexOf('{tiled && <div className="pt-4">{problemStrip}</div>}');
  const tiles = tab.search(/\{tiled && \(\s*<div className=\{?[`"]grid grid-cols-2/);
  assert.ok(strip > 0 && tiles > 0 && strip < tiles, 'the Traces strip must precede the tile grid');
  const traffic = read('TrafficTab.tsx');
  const fStrip = traffic.indexOf("{activeSection === 'failures' && strip}");
  const fTiles = traffic.indexOf('Mesh-wide, every proxy read</p>');
  assert.ok(fStrip > 0 && fTiles > 0 && fStrip < fTiles, 'the Failures strip must precede the mesh-wide tiles');
});

test('Journeys spends no row it can share: scope and search sit on the heading row, the strip shows one problem', () => {
  const at = tab.indexOf('title="Request journeys"');
  const section = tab.slice(tab.lastIndexOf('<Section', at), tab.indexOf('<FilterBar', at));
  assert.match(section, /action=\{\s*<div[^>]*>\s*\{scopeControl\}\s*<label/, 'scope and search are not in the Section action');
  assert.match(tab, /<ProblemStrip[^>]*collapsed=\{section === 'journeys' \? 1 : undefined\}/);
  assert.match(read('ProblemStrip.tsx'), /visibleProblems\(problems, expanded, collapsed\)/);
});

test('Service map shows at most four tiles', () => {
  const start = map.indexOf('export function MapTiles');
  const body = map.slice(start, map.indexOf('\n}\n', start));
  assert.ok(start >= 0, 'MapTiles not found');
  assert.ok((body.match(/<StatTile\b/g) ?? []).length <= 4, 'more than four Service map tiles');
});

test('Journeys keeps Host at 1100: Started and Trace ID shed first, and every visible set fits its band', () => {
  const { tableWidth } = colw;
  const t = tableWidth('pages/cluster-tabs/TracesTab.tsx', 'columns');
  assert.deepEqual(t.unresolved, []);
  const prio = Object.fromEntries(t.columns.map(c => [c.key, c.priority]));
  // At 1100 the panel is an overlay and the table's container is ~812px: between the base tier's
  // 660 and 900, so prio-3 sheds and prio-2 stays. Host must be in the set that stays.
  assert.equal(t.tier, 'base');
  assert.ok(prio.host <= 2, `Host is priority ${prio.host}, so it sheds at 1100`);
  assert.equal(prio.started, 3, 'Started is the column that gives way for Host');
  assert.equal(prio.trace, 3);
  // The set each band shows fits the narrowest container in that band, so an open panel (which
  // narrows the container) sheds a column rather than overflowing.
  assert.ok(t.keptAbovePrio2 <= t.thresholds.prio2, `priority 1+2 need ${t.keptAbovePrio2}px, band starts at ${t.thresholds.prio2}px`);
  assert.ok(t.full <= t.thresholds.prio3, `all columns need ${t.full}px, band starts at ${t.thresholds.prio3}px`);
});

test('the journeys table toolbar is not pulled into its scroller, and the chips wrap', () => {
  const scroller = (/<div className=\{`\$\{CARD_TABLE_CLASS\} ([^`]*)`\}>\s*<DataTable\s+id="traces\.journeys"/.exec(tab) || [])[1];
  assert.ok(scroller, 'journeys scroller not found');
  // CARD_TABLE_CLASS pulls .table-tools up 10px; inside an overflow scroller that is clipped.
  assert.match(scroller, /\[&_\.table-tools\]:mt-0!/);
  assert.match(scroller, /\[&_\.table-tools\]:flex-wrap/);
  assert.match(tab, /aria-label="Filter journeys by outcome" className="[^"]*\bflex-wrap\b/);
});

test('Outbound From: the cell tooltip is the full caller, not the fitted name', () => {
  const out = read('TracesOutbound.tsx');
  const from = out.slice(out.indexOf("key: 'from'"), out.indexOf("key: 'to'"));
  assert.match(from, /title: r => fromTitle\(r\)/, 'the td title falls back to the fitted text');
  assert.match(from, /title=\{fromTitle\(r\)\}/);
});

test('no Traces surface paints a pill, dot or category in the brand violet', () => {
  const files = fs.readdirSync(TABS).filter(f => /^(Traces\w*\.tsx|traces-view\.ts|outbound-view\.ts|egress-view\.ts)$/.test(f));
  assert.ok(files.length >= 7, `only ${files.length} Traces files found`);
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /<(Pill|Dot)\b[^>]*tone=\{?[^>]*'accent'/, `${f}: a Pill or Dot takes the accent tone`);
    assert.doesNotMatch(src, /\bTone\s*\{[^}]*return 'accent'/, `${f}: a tone function returns accent`);
    assert.doesNotMatch(src, /\b(violet|purple|brand)-/, `${f}: a violet/brand class`);
  }
});

test('the waterfall paints no hop in the brand violet (accent is selection, never a status)', () => {
  const src = read('TracesTab.tsx');
  const start = src.indexOf('function Waterfall(');
  const end = src.indexOf('\nfunction ', start + 10);
  assert.ok(start > 0 && end > start, 'Waterfall not found');
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /\b(bg|border|text)-accent\b/, 'Waterfall uses an accent class');
  assert.doesNotMatch(read('waterfall.ts'), /\baccent\b/, 'waterfall.ts names accent');
});

test('Service map fits its 810px pane at 1100 up to three columns; wider maps scroll in their box', () => {
  const num = (src, re, what) => { const m = src.match(re); assert.ok(m, `${what} not found`); return Function(`return (${m[1]})`)(); };
  const layout = read('service-map-layout.ts');
  const nodeW = num(layout, /export const NODE_W = (\d+);/, 'NODE_W');
  const gapX = num(layout, /export const GAP_X = (\d+);/, 'GAP_X');
  const pad = num(map, /const PAD = (\d+);/, 'PAD');
  const floor = num(map, /const MIN_SCALE = ([\d.\s/]+);/, 'MIN_SCALE');
  const units = cols => cols * nodeW + (cols - 1) * gapX + 2 * pad;
  assert.ok(Math.round(units(3) * floor) <= 810, `a three-column map floors at ${Math.round(units(3) * floor)}px, wider than the 810px pane`);
  assert.ok(floor * 11 >= 8, `the floor draws 11px text at ${(floor * 11).toFixed(1)}px`);
  assert.match(map, /overflow-x-auto/, 'a map wider than the floor has no sideways scroll');
});

test('Path view: an inferred link is drawn dashed and carries its count; externals never say ms', () => {
  const view = read('JourneyPath.tsx');
  assert.match(view, /row\.dashed \? 'border-dashed/, 'dashed follows row.dashed');
  assert.match(view, /\{row\.linkText\}/, 'the link text (with its count) is rendered');
  const lib = read('journey-path.ts');
  const t0 = lib.indexOf('export function nodeTiming(');
  const t1 = lib.indexOf('\nexport function ', t0 + 10);
  assert.ok(t0 > 0 && t1 > t0, 'nodeTiming not found');
  assert.doesNotMatch(lib.slice(t0, t1), /\bms\(n\.openForMs\)/, 'open-for time printed as ms');
  assert.match(view, /candidates === 0 \? 'border-dotted/, 'declared-not-observed is drawn unlike a traffic-inferred link');
  assert.doesNotMatch(view, /\b(bg|border|text)-accent\b/, 'violet in the Path view');
});

test('Path view fits the 810px pane at 1100: no fixed width above 780px', () => {
  const view = read('JourneyPath.tsx');
  for (const m of view.matchAll(/w-\[(\d+)px\]/g)) assert.ok(Number(m[1]) <= 780, `w-[${m[1]}px]`);
  assert.match(view, /min-w-0/, 'label cells can shrink');
});

test('every external/BTP TCP timing carries the one connection-duration tooltip constant', () => {
  for (const f of ['JourneyPath.tsx', 'TracesOutbound.tsx']) {
    assert.match(read(f), /CONNECTION_DURATION_TIP/, `${f} does not reference CONNECTION_DURATION_TIP`);
  }
  // CANARY: the pattern must actually fail on a file that lacks the constant.
  assert.doesNotMatch(read('TracesEndpoints.tsx'), /CONNECTION_DURATION_TIP/);
});

test('a traces read that threw leaves the banner and Re-read alone on the page, never a body of zeros', () => {
  // With no payload `envelopeScope(id, undefined).of()` answers ok, so every tile would print 0 and
  // every table "none found" beside the banner. Memory fleet-page-level-failure-shows-zeros.
  const early = /if \(error && !data\) \{\s*return \(\s*<div className="flex items-center gap-3 py-4">\s*<div className="min-w-0 flex-1">\s*<ErrorBanner code=\{error\.code\} message=\{error\.message\} \/>\s*<\/div>\s*\{rereadButton\}\s*<\/div>/;
  assert.match(tab, early);
  const body = tab.slice(tab.indexOf('export default function TracesTab'));
  assert.ok(body.search(early) > body.indexOf('if (data && !data.ok)'), 'the transport-failure return follows the envelope-failure return');
  // The page that return draws has no toolbar, so Re-read must exist before the return that uses it.
  const declared = body.indexOf('const rereadButton = ');
  assert.ok(declared > 0 && declared < body.indexOf('if (loading && !data) return'), 'rereadButton is declared after the early returns, so a failed read leaves no way to ask again');
  // CANARY: the old shapes, a banner above a body that still renders and a banner with no Re-read, do not satisfy the pattern.
  assert.doesNotMatch('{error && (\n  <div className="pb-4">\n    <ErrorBanner code={error.code} message={error.message} />', early);
  assert.doesNotMatch('if (error && !data) {\n    return (\n      <div className="py-4">\n        <ErrorBanner code={error.code} message={error.message} />\n      </div>\n    );\n  }', early);
});

test('Network Operations Overview: only the Outbound failures card sets the failures-only filter', () => {
  const overview = read('NetworkOverview.tsx');
  const go = overview.slice(overview.indexOf('const go = '), overview.indexOf('const reRead'));
  const clears = go.indexOf("next.delete('outboundErrors')");
  assert.ok(clears > 0, 'go() does not clear outboundErrors, so one card leaves the filter on for the next');
  assert.ok(go.indexOf('Object.entries(extra)') > clears, 'go() clears outboundErrors after it applied the card params');
  assert.match(overview, /go\('outbound', \{ outboundErrors: '1' \}\)/);
  assert.equal((overview.match(/outboundErrors: '1'/g) ?? []).length, 1, 'a second card sets the failures-only filter');
});
