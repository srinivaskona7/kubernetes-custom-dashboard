// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * Source-reading guards for the ClusterDetail renderings that cannot be unit-tested.
 *
 * `app/fleet-ui` runs vitest with `environment: 'node'` and jsdom cannot be installed here, so the
 * rules that live inside JSX are pinned by reading the .tsx as text. Each assertion below names a
 * specific wrong rendering that shipped, so a regression restores a known defect rather than
 * merely failing a style check.
 */




const root = path.join(FAKE_DIR, '..', '..');
const clusterDetail = fs.readFileSync(
  path.join(root, 'src/pages/ClusterDetail.tsx'),
  'utf8'
);
const capacitySection = fs.readFileSync(
  path.join(root, 'src/pages/cluster-tabs/CapacitySection.tsx'),
  'utf8'
);

test('a pod pill never falls back from the phase to a container reason', () => {
  // `reason ?? phase` printed CrashLoopBackOff where the phase belongs. Both former call sites.
  assert.ok(
    !/\{\s*p\.reason\s*\?\?\s*p\.phase\s*\}/.test(clusterDetail),
    'ClusterDetail renders a container reason in the phase slot again'
  );
});

test('both pod state cells are derived from podState, not from an inline tone expression', () => {
  assert.ok(clusterDetail.includes("from './cluster-tabs/pod-state'"), 'pod-state is not imported');
  const uses = clusterDetail.match(/podState\(p\)/g) || [];
  assert.ok(uses.length >= 2, `expected the inventory row and the workload drawer to use podState, found ${uses.length}`);
  assert.ok(
    !/tone=\{p\.reason \? 'bad' : p\.phase === 'Running' \? 'ok' : 'warn'\}/.test(clusterDetail),
    'a pod pill tones Running green without reading ContainersReady again'
  );
});

test('the workload State column renders the collector-attributed podIssues, not the pod list', () => {
  // `r.pods` was the old argument, and matching a container reason against `r.state` could never
  // fire — `state` is only ever Ready/Progressing/Unavailable. The attribution the row needs is
  // `podIssues`, which workloads.js publishes as {reason, pods, containers[]}.
  assert.ok(
    clusterDetail.includes('workloadStateSummary(r.state, r.podIssues)'),
    'the State cell no longer reads the attributed podIssues'
  );
  assert.ok(
    !clusterDetail.includes('workloadStateSummary(r.state, r.pods)'),
    'the State cell still passes the pod list, whose reasons can never equal a controller state'
  );
});

test('the pod-slot bar is labelled with the nodes it covers and disclaims placement', () => {
  assert.ok(
    clusterDetail.includes('Pod slots used / capacity on Ready, uncordoned nodes'),
    'the slot bar is not labelled with its predicate'
  );
  assert.ok(
    !/label="Scheduled \/ schedulable"/.test(clusterDetail),
    '"Scheduled / schedulable" is back, and it means something else on the card beside it'
  );
  assert.ok(
    clusterDetail.includes('A free slot is not a placement guarantee'),
    'the placement disclaimer is missing from the slot card'
  );
  assert.ok(
    clusterDetail.includes('slotAccounting(nodes)'),
    'the slot bar computes its own denominator again instead of using slotAccounting'
  );
});

test('Headroom & Scheduling says it reports pressure, not spare capacity', () => {
  assert.ok(
    capacitySection.includes('Scheduling pressure, not spare capacity'),
    'the Headroom heading promises headroom with no qualifier again'
  );
});

test('the node-conditions empty state comes from nodeConditionsEmpty', () => {
  assert.ok(clusterDetail.includes('nodeConditionsEmpty(nodes)'), 'the conditions empty state is hardcoded again');
  // The all-clear sentence belongs to node-slots.ts, which words it against the live predicate.
  // Inlining it here is what let the wording drift behind `isProblemCondition` the first time: the
  // string outlived the predicate that justified it. `Ready` is now inside the predicate
  // (health.js HEALTHY_WHEN_TRUE), so the sentence may claim readiness — but only from one owner.
  assert.ok(
    !clusterDetail.includes('No node is reporting NotReady'),
    'the node-conditions all-clear is inlined in the page again instead of coming from nodeConditionsEmpty'
  );
});

test('the problem-conditions tile does not claim readiness is excluded', () => {
  // `nodeProblems` filters EVERY condition through `isProblemCondition`, and Ready is healthy-when-
  // True, so a NotReady node is counted in this tile. The caption used to read
  // "beyond Ready/SystemdUnitsReady", which described the predicate as it was two changes ago.
  assert.ok(
    !capacitySection.includes('beyond Ready/SystemdUnitsReady'),
    'the tile caption excludes Ready again, but isProblemCondition counts NotReady'
  );
  assert.ok(
    capacitySection.includes('including NotReady'),
    'the tile no longer says NotReady is part of the count'
  );
});

test('the compliance verdict pill does not read as certification', () => {
  assert.ok(
    clusterDetail.includes('BOOTSTRAP_VERDICT_LABEL[r.verdict]'),
    'the compliance pill uses the generic VERDICT_LABEL again'
  );
  assert.ok(
    !/VERDICT_LABEL\[r\.verdict\]/.test(clusterDetail.replace(/BOOTSTRAP_VERDICT_LABEL\[r\.verdict\]/g, '')),
    'VERDICT_LABEL is back on a compliance row'
  );
  assert.ok(clusterDetail.includes('{BOOTSTRAP_CHART}'), 'the namespace-bootstrapping chart is not named on screen');
  assert.ok(
    clusterDetail.includes('bootstrapSummary(r.checks)'),
    'the per-namespace row no longer prints the present/applicable convention count'
  );
  assert.ok(
    clusterDetail.includes('bootstrapCheckName(c.id, c.name)'),
    'check names are printed unqualified again, so PSA claims a workload verdict'
  );
});

test('compliance cross-links to the sub-tab that does look at workloads', () => {
  assert.ok(
    clusterDetail.includes("setTab('security', 'isolation')"),
    'the compliance → Security & Isolation cross-link is gone'
  );
  assert.ok(
    clusterDetail.includes('Workload-level evidence is on Security'),
    'the cross-link has no visible label'
  );
});
