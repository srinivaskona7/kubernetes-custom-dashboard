
/**
 * The taint/toleration pairing, tested against the shapes a real cluster produced.
 *
 * Every fixture here is taken from the live sbx cluster's own pod specs (120 pods, 3 untainted
 * nodes, 50 pods with an authored toleration, 42 of them universal). The rules being pinned are the
 * ones where a plausible implementation is wrong in a way that renders confidently:
 *
 *  - all 120 pods have a toleration, so an unfiltered list ranks nothing
 *  - `Exists` with no key is the most permissive toleration, and renders as blank cells
 *  - a toleration matching no taint grants nothing today, and on an untainted cluster that is all
 *    of them — but "grants nothing" and "not checked" must not collapse into one value
 *  - tolerating a taint is not being scheduled by it
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';

import _taints from '../collectors/taints.js';
const {
  authored,
  collectTaints,
  isInjectedDefault,
  isUniversal,
  matchesTaint,
  nodeTaints,
  podTolerations
} = _taints;

/** The pair Kubernetes injects into essentially every pod. */
const INJECTED = [
  { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
  { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 }
];

const pod = (name, namespace, node, tolerations) => ({
  metadata: { name, namespace },
  spec: { nodeName: node, tolerations },
  status: { phase: 'Running' }
});

const node = (name, taints) => ({ metadata: { name }, spec: taints ? { taints } : {} });

test('the injected defaults are recognised and filtered, so the list is not every pod', () => {
  assert.equal(isInjectedDefault(INJECTED[0]), true);
  assert.equal(isInjectedDefault(INJECTED[1]), true);
  assert.equal(authored(INJECTED).length, 0, 'a pod with only the injected pair has no authored toleration');

  // Measured on the live cluster: 120/120 pods carry a toleration, 50 carry an authored one.
  const pods = [
    ...Array.from({ length: 70 }, (_, i) => pod(`default-${i}`, 'kyma-system', 'n1', INJECTED)),
    ...Array.from({ length: 50 }, (_, i) =>
      pod(`authored-${i}`, 'kyma-system', 'n1', [...INJECTED, { operator: 'Exists', effect: 'NoSchedule' }])
    )
  ];
  const out = collectTaints([node('n1')], pods);
  assert.equal(out.summary.podsRead, 120, 'every pod is still read');
  assert.equal(
    out.summary.podsWithAuthoredTolerations,
    50,
    'the authored filter is what makes this list answerable — without it the answer is "all 120"'
  );
});

test('an explicit not-ready:NoSchedule is authored, not the injected NoExecute default', () => {
  // Three pods on the live cluster declare exactly this. Matching on key alone would erase them.
  const t = { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoSchedule' };
  assert.equal(isInjectedDefault(t), false);
  assert.equal(authored([...INJECTED, t]).length, 1);
});

test('Exists with no key is universal — the most permissive row, not an empty one', () => {
  assert.equal(isUniversal({ operator: 'Exists' }), true);
  assert.equal(isUniversal({ operator: 'Exists', key: 'dedicated' }), false);
  assert.equal(isUniversal({ operator: 'Equal' }), false);

  // It tolerates a taint it shares no field with, which is the whole point.
  assert.equal(
    matchesTaint({ operator: 'Exists' }, { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }),
    true,
    'a keyless Exists toleration must match every taint'
  );
});

test('matchesTaint follows the API server rule for effect, operator and value', () => {
  const taint = { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' };

  // Effect must match, or be absent on the toleration (meaning all effects).
  assert.equal(matchesTaint({ key: 'dedicated', operator: 'Exists', effect: 'NoExecute' }, taint), false);
  assert.equal(matchesTaint({ key: 'dedicated', operator: 'Exists' }, taint), true);

  // Exists ignores the value; Equal requires it.
  assert.equal(matchesTaint({ key: 'dedicated', operator: 'Exists', effect: 'NoSchedule' }, taint), true);
  assert.equal(
    matchesTaint({ key: 'dedicated', operator: 'Equal', value: 'cpu', effect: 'NoSchedule' }, taint),
    false
  );
  assert.equal(
    matchesTaint({ key: 'dedicated', operator: 'Equal', value: 'gpu', effect: 'NoSchedule' }, taint),
    true
  );

  // An absent operator defaults to Equal, so an absent value must not read as a wildcard.
  assert.equal(matchesTaint({ key: 'dedicated', effect: 'NoSchedule' }, taint), false,
    'an absent operator is Equal; with no value it must not match a taint that has one');
});

test('an untainted cluster reports zero taints and marks every toleration inert', () => {
  // The live cluster exactly: 3 nodes, no taints, pods holding universal tolerations.
  const nodes = [node('n1'), node('n2'), node('n3')];
  const pods = [pod('ds-a', 'istio-system', 'n1', [...INJECTED, { operator: 'Exists', effect: 'NoSchedule' }])];
  const out = collectTaints(nodes, pods);

  assert.equal(out.summary.taints, 0, 'no node declares a taint — a true zero, and not an error');
  assert.equal(out.summary.nodesReporting, 3);
  assert.equal(out.summary.podsWithUniversalToleration, 1);
  assert.equal(out.pods[0].tolerations[0].inert, true,
    'a toleration matching no taint on the cluster grants nothing today, and must say so');
  assert.equal(out.summary.allTolerationsInert, true);
});

test('a failed node read reports unknown, never "no taints" and never "inert"', () => {
  const pods = [pod('a', 'ns', 'n1', [...INJECTED, { operator: 'Exists', effect: 'NoSchedule' }])];
  const out = collectTaints([], pods, { nodesRead: false });

  assert.equal(out.summary.taints, null, 'an unread node list must not report zero taints');
  assert.equal(out.summary.taintedNodes, null);
  assert.equal(
    out.pods[0].tolerations[0].inert,
    null,
    '"grants nothing" and "could not check" are different answers; inert must be null when unchecked'
  );
  assert.equal(out.summary.allTolerationsInert, false, 'no inert verdict is claimed without a node read');
});

test('tolerating a taint is counted separately from being placed on that node', () => {
  const nodes = [node('gpu-1', [{ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }]), node('plain-1')];
  const pods = [
    // Permitted and placed there.
    pod('trainer', 'ml', 'gpu-1', [...INJECTED, { key: 'dedicated', operator: 'Equal', value: 'gpu', effect: 'NoSchedule' }]),
    // Permitted, but scheduled somewhere else entirely — the case that makes "N pods tolerate
    // this taint" read as "N pods are on this node" if the two are not kept apart.
    pod('idle', 'ml', 'plain-1', [...INJECTED, { key: 'dedicated', operator: 'Equal', value: 'gpu', effect: 'NoSchedule' }]),
    // Not permitted at all.
    pod('other', 'ns', 'plain-1', INJECTED)
  ];
  const out = collectTaints(nodes, pods);

  assert.equal(out.taints.length, 1);
  assert.equal(out.taints[0].podsTolerating, 2, 'both pods hold a matching toleration');
  assert.equal(out.taints[0].podsOnNode, 1, 'only one of them is actually on the tainted node');
  assert.equal(out.taints[0].node, 'gpu-1');
  assert.equal(out.pods.find(p => p.name === 'trainer').tolerations[0].inert, false);
});

test('tolerationSeconds is reported for NoExecute only, because Kubernetes ignores it elsewhere', () => {
  const nodes = [node('n1')];
  const withSeconds = pod('a', 'ns', 'n1', [
    { key: 'k', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 60 },
    { key: 'k', operator: 'Exists', effect: 'NoSchedule', tolerationSeconds: 60 }
  ]);
  const out = collectTaints(nodes, [withSeconds]);
  assert.equal(out.pods[0].tolerations[0].tolerationSeconds, 60);
  assert.equal(
    out.pods[0].tolerations[1].tolerationSeconds,
    null,
    'tolerationSeconds on a NoSchedule toleration is a field the scheduler ignores; reporting it implies an eviction timer that does not exist'
  );
});

test('the count of hidden injected tolerations travels with the pod', () => {
  const out = collectTaints([node('n1')], [pod('a', 'ns', 'n1', [...INJECTED, { operator: 'Exists' }])]);
  assert.equal(out.pods[0].injectedCount, 2, 'the defaults are filtered from the list but not from the record');
  assert.equal(out.pods[0].tolerations.length, 1);
});

test('nodeTaints reports the effect verbatim and never defaults it', () => {
  const rows = nodeTaints(node('n1', [{ key: 'k', value: 'v', effect: 'NoSchedule' }, { key: 'bare' }]));
  assert.equal(rows[0].effect, 'NoSchedule');
  assert.equal(rows[1].effect, null, 'a taint with no effect is malformed; inventing NoSchedule would hide that');
  assert.equal(rows[0].node, 'n1', 'every taint carries the node it came from');
});

test('podTolerations keeps the node name as a fact, not as a cause', () => {
  // The pod is on an untainted node while holding a toleration — the node name must still be
  // reported, and the toleration must not be credited with the placement.
  const out = podTolerations(
    pod('a', 'ns', 'plain-1', [...INJECTED, { key: 'dedicated', operator: 'Exists', effect: 'NoSchedule' }]),
    [{ id: 'dedicated=:NoSchedule', node: 'gpu-1', key: 'dedicated', value: null, effect: 'NoSchedule' }],
    true
  );
  assert.equal(out.node, 'plain-1');
  assert.equal(out.tolerations[0].inert, false, 'the toleration does match a taint that exists on the cluster');
  assert.deepEqual(
    out.tolerations[0].matchesNodes,
    ['gpu-1'],
    'the nodes it would permit are named separately from the node it is actually on'
  );
});
