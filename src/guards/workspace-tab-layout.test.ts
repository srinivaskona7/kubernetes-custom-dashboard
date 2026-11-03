// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The workspace-tab height chain, enforced as a source check.
 *
 * Live Pod Logs is a pod list beside a log stream, and each pane must fill the viewport and scroll
 * itself. Both panes already declared `flex-1 min-h-0 overflow-y-auto` and neither scrolled: a
 * `flex-1` child only gets a definite height if *every* ancestor between it and the viewport is a
 * bounded flex column, and four links in that chain were missing. The panes therefore fell back to
 * `height: auto`, grew to their full content height, and the page column scrolled instead — so
 * reaching the bottom of the log carried on into the page and dragged the pod list off the top.
 *
 * That failure is invisible to every other check in this repo. The markup is valid, TypeScript is
 * happy, the tab renders, the tests pass, and the only symptom is a scroll gesture behaving wrongly
 * in a browser. Hence this file, which asserts the chain itself:
 *
 *   1. `tabs.ts` states, for every tab in the union, which of the two layouts it gets.
 *   2. `ClusterDetail.tsx` applies all four links, each keyed on the same `workspace` flag.
 *   3. Each pane in a workspace tab is a real independent scroller: `min-h-0` so it can shrink,
 *      and `overscroll-contain` so hitting its end does not chain out to whatever is behind it.
 *
 * Rule 2 is deliberately a whole-chain check rather than four separate ones. Three of the four
 * links are individually useless — the value is only in having all of them — so a guard that
 * passed on three would be the exact green-and-wrong signal this file exists to prevent.
 */




const UI_SRC = path.join(FAKE_DIR, '../../src');

const read = rel => fs.readFileSync(path.join(UI_SRC, rel), 'utf8');

/** Block and line comments removed, so a class named only in prose never satisfies a rule. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('every tab states which of the two page layouts it gets', () => {
  const src = read('pages/cluster-tabs/tabs.ts');
  const code = stripComments(src);

  const union = /export type Tab =([\s\S]*?);/.exec(code);
  assert.ok(union, 'the `Tab` union was not found in tabs.ts');
  const tabs = [...union[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(tabs.length >= 10, `expected the full tab union, parsed only ${tabs.length}`);

  const record = /const IS_WORKSPACE: Record<Tab, boolean> = \{([\s\S]*?)\n\};/.exec(code);
  assert.ok(
    record,
    'IS_WORKSPACE is gone or no longer an exhaustive `Record<Tab, boolean>`. It is what forces a ' +
      'new tab to choose a layout instead of defaulting into the document one by omission.'
  );
  const declared = new Map(
    [...record[1].matchAll(/(\w+):\s*(true|false)/g)].map(m => [m[1], m[2] === 'true'])
  );

  for (const tab of tabs) {
    assert.ok(
      declared.has(tab),
      `tab '${tab}' has no entry in IS_WORKSPACE. Decide: does it scroll as a document (false), ` +
        `or own the viewport with panes that scroll themselves (true)?`
    );
  }
  for (const name of declared.keys()) {
    assert.ok(tabs.includes(name), `IS_WORKSPACE declares '${name}', which is not a Tab`);
  }

  // The pane rules below are written against Live Pod Logs specifically. A second workspace tab is
  // welcome — it just has to be added to WORKSPACE_FILES, and failing here is how the author finds
  // that out rather than shipping a second unscrollable workspace.
  const workspace = [...declared].filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(
    workspace.sort(),
    ['logs', 'network', 'traces', 'traffic'],
    'a tab was marked as a workspace. Add its component to WORKSPACE_FILES in this file so its ' +
      'panes are checked for independent scrolling too.'
  );
});

test('ClusterDetail hands the viewport height down through all four links', () => {
  const code = stripComments(read('pages/ClusterDetail.tsx'));

  assert.match(
    code,
    /const workspace = isWorkspaceTab\(tab\)/,
    'ClusterDetail no longer reads `isWorkspaceTab`, so the two layouts cannot differ at all.'
  );

  // Each entry: what the link does, and the pattern that proves it is applied on the `workspace`
  // flag rather than unconditionally (which would break every document tab's page scrolling).
  const links = [
    {
      what: 'the page column stops scrolling, so the panes below own the viewport',
      re: /workspace \? 'overflow-hidden' : 'overflow-y-auto'/
    },
    {
      what: 'the content row may shrink below its content and stretches its children to full height',
      re: /workspace \? 'min-h-0 items-stretch' : 'items-start'/
    },
    {
      what: "the row's child becomes a bounded flex column instead of an auto-height block",
      re: /workspace \? 'flex min-h-0 flex-col' : ''/
    },
    {
      what: 'the gutter passes a definite height to the tab root',
      re: /workspace \? 'flex min-h-0 flex-1 flex-col' : ''/
    }
  ];

  const missing = links.filter(l => !l.re.test(code));
  assert.deepEqual(
    missing.map(l => l.what),
    [],
    'the workspace height chain is broken. Every link is load-bearing and three of four is the ' +
      'same as none: the pane keeps `height: auto`, grows to its content, and the page scrolls ' +
      'instead. See the note on IS_WORKSPACE in cluster-tabs/tabs.ts.'
  );
});

/**
 * Workspace tab id -> every file that renders one of its panes. Keep in step with IS_WORKSPACE.
 *
 * Two files for `logs`, not one, because the log pane itself moved out of the tab: the bottom log
 * drawer and this tab now render the SAME `PodLogsViewer`, which is the only way "every Logs button
 * opens the same viewer" can be true. The pane list has to follow the pane. Listing only the tab
 * left this guard measuring a file with one scroller in it — the pane had not lost its scroller, the
 * guard had lost the pane.
 */
const WORKSPACE_FILES = {
  logs: ['pages/cluster-tabs/LogsTab.tsx', 'components/pod-logs/PodLogsViewer.tsx'],
  // Network Operations owns the customer-level view switch; its three views each retain their
  // focused panes, so changing view never turns the whole page into one shared scroller.
  network: [
    'pages/cluster-tabs/NetworkOperationsTab.tsx',
    'pages/cluster-tabs/TrafficTab.tsx',
    'pages/cluster-tabs/TracesTab.tsx',
    'pages/cluster-tabs/NetworkMeshTab.tsx'
  ],
  // The journey list and the other sub-tabs' body. The journey panel's scroller is DetailPanel's
  // body in components/layout.tsx, checked on its own below: that file also holds the nav rail's
  // scrollers, which are not Traces panes.
  traces: ['pages/cluster-tabs/TracesTab.tsx'],
  // Ingress & Traffic: the tab owns the sub-tab bodies and the failing-requests list; Hosts & Routes
  // and Access control each seat a table column beside a DetailPanel, so their columns scroll too.
  traffic: [
    'pages/cluster-tabs/TrafficTab.tsx',
    'pages/cluster-tabs/ingress/IngressHosts.tsx',
    'pages/cluster-tabs/ingress/IngressClients.tsx'
  ]
};

/** Where the log viewer's scroll-follow logic lives, shared by the tab and the bottom drawer. */
const LOG_VIEWER = 'components/pod-logs/PodLogsViewer.tsx';

/** Where the viewer's re-anchor key is built — one hook, the console's only `api.logs` caller. */
const LOG_TAIL_HOOK = 'components/pod-logs/use-pod-log-tail.ts';

test('each pane of a workspace tab is an independent scroller', () => {
  for (const [tab, files] of Object.entries(WORKSPACE_FILES)) {
    const rel = files.join(' + ');
    const code = files.map(f => stripComments(read(f))).join('\n');

    // Every className that scrolls vertically, taken as a whole so the co-requirements below are
    // checked on the same element rather than merely present somewhere in the file.
    const scrollers = [...code.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
      .map(m => m[1] ?? m[2])
      .filter(c => /\boverflow-(?:y-)?auto\b/.test(c) && !/\boverflow-x-auto\b/.test(c));

    assert.ok(
      scrollers.length >= 2,
      `${tab} (${rel}) declares ${scrollers.length} vertical scroller(s). A workspace tab has at ` +
        'least two panes and each scrolls itself; one scroller means the panes share one, which is ' +
        'exactly the coupling this layout exists to remove.'
    );

    for (const cls of scrollers) {
      assert.match(
        cls,
        /\bmin-h-(?:0|\[\d+px\])(?=\s|$)/,
        `${rel}: the scroller \`${cls}\` has no \`min-h-0\` (or an explicit \`min-h-[Npx]\` floor). A flex item's default ` +
          '`min-height: auto` refuses to shrink below its content, so the element overflows its ' +
          'parent instead of scrolling — the scrollbar never appears.'
      );
      assert.match(
        cls,
        /\boverscroll-contain\b/,
        `${rel}: the scroller \`${cls}\` has no \`overscroll-contain\`. Without it, reaching the ` +
          "end of this pane chains the gesture to whatever is behind it — the reader's scroll " +
          'jumps to the other pane or the page, which is the behaviour being fixed here.'
      );
    }
  }
});

test('switching the subject of a log re-anchors it on the newest line', () => {
  const code = stripComments(read(LOG_VIEWER));

  assert.match(
    code,
    /streamKey/,
    'LogBody no longer takes a `streamKey`. Both pieces of scroll state survive a pod switch — the ' +
      'follow flag because it is a ref, and the offset because React reuses the same scroller node — ' +
      'so without it a new pod opens wherever the previous one was left.'
  );
  assert.match(
    code,
    /toTail\(\);[\s\S]{0,80}\}, \[streamKey, toTail\]\)/,
    'the re-anchor effect must key on `streamKey` (plus its own callback) and nothing else. Keying ' +
      'it on the log payload would fire on every poll and fight a reader who scrolled away on purpose.'
  );

  // The subject is the pod, the container, and the direction — a direction flip moves the newest
  // line to the other edge, so the scroller has to re-anchor. `tailLines` and `previous` re-read the
  // *same* log, and re-anchoring on them would undo a deliberate scroll every time the tail grew.
  // Composed in the hook now, not spelled out at the call site: the tab and the drawer both pass
  // `streamKey={log.streamKey}`, and a key built twice is a key that can disagree with itself.
  const key = /streamKey:\s*`([^`]*)`/.exec(stripComments(read(LOG_TAIL_HOOK)));
  assert.ok(key, `the streamKey in ${LOG_TAIL_HOOK} is no longer a template literal this guard can read`);
  for (const forbidden of ['tailLines', 'previous']) {
    assert.ok(
      !key[1].includes(forbidden),
      `\`streamKey\` includes \${${forbidden}}, which re-reads the same log rather than naming a ` +
        'different one. Re-anchoring on it throws the reader back to the newest line whenever it changes.'
    );
  }
  assert.ok(
    key[1].includes('dir'),
    '`streamKey` must include `dir`: flipping the order relocates the newest line to the opposite ' +
      'edge, and a scroller left at its old offset then sits in the middle of the log.'
  );
});

test('the paused-tail control renders from state, never from a ref', () => {
  const code = stripComments(read(LOG_VIEWER));

  // This shipped broken once and no other check could see it. The follow flag has to be a ref so the
  // new-lines effect can read the reader's position synchronously, and the first version kept *only*
  // the ref — so scrolling away mutated it, React had no reason to re-render, and the "Jump to
  // latest" control never appeared no matter how far the reader scrolled. Verified in the browser:
  // `onScroll` fired, the ref flipped, the button stayed absent.
  assert.match(
    code,
    /tailPausedLabel\(\{\s*atTail: (?!onTail\.current)/,
    'the jump control is being derived from a ref (`onTail.current`). Mutating a ref triggers no ' +
      'render, so the control will never appear. Derive it from the state mirror instead — see ' +
      '`setTail`, which writes both.'
  );
  assert.match(
    code,
    /const setTail = useCallback\([\s\S]{0,160}onTail\.current = v;[\s\S]{0,80}setTailVisible\(v\)/,
    'the ref and its state mirror must be written in one place. Two call sites is how they drift, ' +
      'and a drifted pair means either the control renders wrongly or the follow decision does.'
  );
  assert.match(
    code,
    /shouldFollowTail\(\{ atTail: onTail\.current/,
    'the follow decision must read the *ref*, not the state. State is one render behind, and a stale ' +
      "read here scrolls a reader who has just moved away — the exact behaviour being prevented."
  );
});

test("the detail panel's body is an independent scroller, so a journey panel scrolls itself", () => {
  const code = stripComments(read('components/layout.tsx'));
  const body = /className="(detail-panel-enter card-body[^"]*)"/.exec(code);
  assert.ok(body, 'the DetailPanel body (`detail-panel-enter card-body`) was not found in layout.tsx');
  for (const cls of ['flex-1', 'min-h-0', 'overflow-y-auto', 'overscroll-contain']) {
    assert.match(
      body[1],
      new RegExp(`(^|\\s)${cls}(\\s|$)`),
      `the DetailPanel body lacks \`${cls}\`: without it an inline journey panel grows to its content and ` +
        'its lower half is unreachable in a workspace tab, where the page column does not scroll.'
    );
  }
});

test('Traces keeps its read controls in reach and never squeezes the journey list to nothing', () => {
  const code = stripComments(read('pages/cluster-tabs/TracesTab.tsx'));
  // Endpoints, Service map and Outbound scroll their whole body: each FilterBar sticks to its top.
  const pinned = /const PINNED_FILTERS = '([^']*)'/.exec(code);
  assert.ok(pinned, 'PINNED_FILTERS not found in TracesTab.tsx');
  for (const cls of ['sticky', 'top-0', 'bg-bg']) {
    assert.match(pinned[1], new RegExp(`(^|\\s)${cls}(\\s|$)`), `PINNED_FILTERS lacks \`${cls}\`: the sub-tab FilterBar scrolls away with the table.`);
  }
  const wrapped = code.match(/<div className=\{PINNED_FILTERS\}>\s*<FilterBar activeCount=\{readFilterCount\}/g) || [];
  assert.equal(wrapped.length, 3, 'each of Endpoints, Service map and Outbound wraps its FilterBar in PINNED_FILTERS');
  // The journey list has a floor, so a short window scrolls the column around it rather than
  // leaving a zero-height table and a clipped proxies block below it.
  assert.match(code, /\$\{CARD_TABLE_CLASS\} min-h-\[(\d+)px\] flex-\[1_1_\1px\] overflow-y-auto/, 'the journey table scroller needs a min-h-[Npx] floor and a matching flex basis: with flex-1 (0% basis) the section\'s minimum becomes the whole table');
  assert.match(code, /'flex min-h-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain pb-4'/, 'the journeys column is not the fallback scroller');
  assert.match(code, /className="flex flex-1 flex-col"\s+title="Request journeys"/, 'the journeys Section may not take min-h-0: it would shrink below its own content and the proxies block would paint over the table');
});
