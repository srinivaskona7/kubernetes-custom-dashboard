// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * Taints and Tolerations are sub-tabs of Nodes & Topology, and their copy has one owner.
 *
 * Source-reading guards by necessity: `app/fleet-ui` runs vitest under `environment: 'node'` and
 * jsdom cannot be installed here, so there is no render test to write. Each assertion below was
 * canaried against a mutation of the source it reads.
 *
 * The properties that matter:
 *
 *  1. **Registered and dispatched.** A `?section=` id present in `TAB_SECTIONS` but missing from
 *     the dispatch renders the tab's last branch, so an operator clicking Taints reads Headroom &
 *     Scheduling under the wrong heading. They are sub-tabs, so they add no rail entry and `TABS`
 *     stays at 14.
 *  2. **No Kubernetes sentence is written in the .tsx.** Every explanation of an effect, a
 *     wildcard or an inert toleration comes from `taint-labels.ts`, which is unit-tested. A
 *     sentence restated in the component is a second version with no test behind it.
 *  3. **The zero-taint headline is not printed twice.** The paragraph and the empty state carried
 *     the identical sentence, and both rendered — caught on screen, pinned here.
 */





const UI = path.join(FAKE_DIR, '..', '..', 'src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');
/** Comments explain what the code must NOT do, so every assertion reads the code only. */
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const TABS_TS = code(read(path.join('pages', 'cluster-tabs', 'tabs.ts')));
const DETAIL = code(read(path.join('pages', 'ClusterDetail.tsx')));
const SECTION = code(read(path.join('pages', 'cluster-tabs', 'NodeTaintsSection.tsx')));

function nodeSections() {
  const at = TABS_TS.indexOf('\n  nodes: [');
  assert.ok(at > 0, 'TAB_SECTIONS.nodes is gone from tabs.ts — this guard is measuring nothing');
  const end = TABS_TS.indexOf('\n  ],', at);
  assert.ok(end > at, 'could not find the end of the TAB_SECTIONS.nodes list');
  return TABS_TS.slice(at, end);
}

test('taints and tolerations are registered as node sub-tabs, and TABS stays at 14', () => {
  const list = nodeSections();
  const ids = [...list.matchAll(/id: '([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(
    ids,
    ['overview', 'nodes', 'zones', 'slots', 'conditions', 'taints', 'tolerations', 'headroom'],
    'the nodes sub-tab order changed. `taints` sits after `conditions` (the other per-node ' +
      'constraint view) and `tolerations` directly after it, because the second is only ' +
      'interpretable with the first. `overview` must stay first: every component takes its ' +
      'useSection fallback from NODE_SECTIONS[0].id.'
  );

  const tabs = /export const TABS: \{ id: Tab; label: string \}\[\] = \[([\s\S]*?)\n\];/.exec(TABS_TS);
  assert.ok(tabs, 'the TABS array is gone from tabs.ts');
  assert.equal(
    [...tabs[1].matchAll(/id: '[a-z-]+'/g)].length,
    14,
    'TABS is no longer 14 entries. Taints and Tolerations are sub-tabs of Nodes & Topology by ' +
      'decision, so a new rail entry is the change this asserts against. It was 13 until the ' +
      'network split: Ingress & Traffic and Distributed Traces became views inside Network ' +
      'Operations (-2), and Networking, Istio & Mesh, Observability and Certificates each took ' +
      'their own entry (+4), and the Modules & Telemetry tab was retired into Observability (-1).'
  );
});

test('the tolerations description says whose tolerations, and promises no sample', () => {
  const list = nodeSections();
  const entry = /id: 'tolerations',[\s\S]*?description:\s*'([^']*)'/.exec(list);
  assert.ok(entry, "the `tolerations` entry has no single-quoted `description:`");
  const description = entry[1];
  // The description is a promise about a read. This section reads pod specs and node specs and
  // nothing else — it must not imply a metric, a history, or a scheduling verdict.
  assert.match(description, /Node/, 'the description must name the node, which is the column an operator comes here for');
  for (const re of [/metrics/i, /\busage\b/i, /\bhistor/i, /\bevict/i, /\bscheduled because\b/i]) {
    assert.doesNotMatch(
      description,
      re,
      `the tolerations description matches ${re}. Nothing here reads metrics-server or decides why ` +
        `a pod was placed; a description implying either sends an operator in with a conclusion ` +
        `already formed.`
    );
  }
});

test('ClusterDetail dispatches both sections to NodeTaintsSection with distinct views', () => {
  assert.match(
    DETAIL,
    /import NodeTaintsSection from '\.\/cluster-tabs\/NodeTaintsSection';/,
    'ClusterDetail no longer imports NodeTaintsSection'
  );
  for (const view of ['taints', 'tolerations']) {
    const re = new RegExp(`section === '${view}' && <NodeTaintsSection id=\\{id\\} view="${view}"`);
    assert.match(
      DETAIL,
      re,
      `the \`${view}\` section is not dispatched to <NodeTaintsSection view="${view}">. An id that ` +
        `is registered but not dispatched falls through to the tab's final branch, so the ` +
        `operator clicks ${view} and reads Headroom & Scheduling under the wrong heading.`
    );
  }
});

test('no Kubernetes sentence is written in the .tsx — every one comes from taint-labels', () => {
  assert.match(
    SECTION,
    /from '\.\/taint-labels'/,
    'NodeTaintsSection no longer imports from ./taint-labels, so whatever it renders is untested copy'
  );

  /*
    The vocabulary of the rules this screen states. Each has exactly one owner — taint-labels.ts —
    because that is the only file here a unit test can read. `NoExecute` evicting and `NoSchedule`
    not is the distinction most worth protecting: they are one word apart and opposite in effect.
  */
  const banned = [
    /\bevicted\b/i,
    /already running stay/i,
    /preference, not a rule/i,
    /grants nothing/i,
    /\bmalformed\b/i,
    /tolerates every taint/i,
    /injects a not-ready/i
  ];
  for (const re of banned) {
    assert.doesNotMatch(
      SECTION,
      re,
      `NodeTaintsSection.tsx writes Kubernetes copy of its own (${re}). Every effect meaning, ` +
        `wildcard label and inert verdict has one owner in taint-labels.ts. Import the sentence ` +
        `instead of restating it.`
    );
  }
});

test('the zero-taint headline is rendered once, not by both the paragraph and the empty state', () => {
  // Both branches called taintsHeadline(t.summary) unconditionally, so on a cluster with no taints
  // the identical paragraph appeared twice on screen. Caught by looking at it; pinned here.
  const at = SECTION.indexOf("if (view === 'taints')");
  assert.ok(at > -1, 'the taints branch is gone from NodeTaintsSection — this guard measures nothing');
  const branch = SECTION.slice(at, at + 900);
  assert.doesNotMatch(
    branch,
    /<p[^>]*>\{taintsHeadline\(t\.summary\)\}<\/p>\s*\{t\.taints\.length === 0/,
    'the headline paragraph renders above the empty-state branch again, so a cluster with no ' +
      'taints prints the same sentence twice — once as the summary and once as the Empty hint.'
  );
});

test('the tolerations view keeps the default-only pods reachable rather than dropping them', () => {
  // "Do not remove a capability because its presentation is redundant." Filtering the injected
  // defaults is what makes the list answerable, but a pod whose only tolerations are the defaults
  // is still a real answer, so the toggle has to exist.
  assert.match(
    SECTION,
    /showAll/,
    'the show-all toggle is gone. Without it the 70 pods carrying only the injected defaults are ' +
      'unreachable from this screen, which deletes a real answer rather than deprioritising it.'
  );
  assert.match(
    SECTION,
    /t\.summary\.podsRead - t\.summary\.podsWithAuthoredTolerations/,
    'the toggle no longer says how many pods it would add, so the filter hides an unknown quantity'
  );
});
