
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _reliability from '../collectors/reliability.js';
const {
  crashLoopsForPod,
  normalizeImage,
  imageShortForm,
  isBareImageId,
  podImageMismatches,
  replicaSetOwnerIndex,
  deploymentRolloutTruth,
  statefulSetRolloutTruth,
  deploymentUnderCapacity,
  daemonSetCoverage,
  servicesWithZeroReadyEndpoints
} = _reliability;

const NOW = new Date('2026-09-09T12:00:00Z').getTime();

function pod({ name = 'p', namespace = 'default', startTime, containerStatuses = [], deletionTimestamp } = {}) {
  return {
    metadata: { name, namespace, deletionTimestamp },
    status: { startTime, containerStatuses }
  };
}

// --- E1: crashloop taxonomy -------------------------------------------------------------

test('E1: waiting.reason CrashLoopBackOff is caught even with zero restart history (no lastState.terminated yet)', () => {
  const p = pod({
    startTime: new Date(NOW - 2 * 3600000).toISOString(),
    containerStatuses: [{ name: 'app', restartCount: 0, state: { waiting: { reason: 'CrashLoopBackOff' } } }]
  });
  const found = crashLoopsForPod(p, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].detectedBy, 'waiting-reason');

  // Canary: dropping the waiting-reason check and relying on the recency signal alone would
  // miss this container entirely, since restartCount is 0 and no rate can be computed.
  const recencyOnly = (restartCount, ageHours) => restartCount >= 3 && (restartCount / ageHours) >= 3;
  assert.equal(recencyOnly(0, 2), false, 'recency-only would have missed this crashloop — canary confirms the OR is load-bearing');
});

test('E1: recency signal catches a fast crashloop before Kubernetes escalates the waiting reason', () => {
  const p = pod({
    startTime: new Date(NOW - 6 * 60000).toISOString(), // 6 minutes old
    containerStatuses: [{ name: 'app', restartCount: 4, state: { waiting: { reason: 'ContainerCreating' } } }]
  });
  const found = crashLoopsForPod(p, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].detectedBy, 'recency');
});

test('E1: restartsPerHour denominator is floored so a just-started container does not report an absurd rate', () => {
  const p = pod({
    startTime: new Date(NOW - 5000).toISOString(), // 5 seconds old
    containerStatuses: [{ name: 'app', restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } }]
  });
  const [found] = crashLoopsForPod(p, NOW);
  // Without the floor, 5 restarts / (5000ms in hours) would be ~3600/hr. Floored at 5 minutes,
  // it is 5 / (5/60) = 60/hr — large, but not an absurd four-digit number.
  assert.ok(found.restartsPerHour <= 60.01, `expected a floored rate, got ${found.restartsPerHour}`);
  assert.ok(found.restartsPerHour > 0);
});

test('E1: a healthy container produces no finding', () => {
  const p = pod({
    startTime: new Date(NOW - 3600000).toISOString(),
    containerStatuses: [{ name: 'app', restartCount: 0, state: { running: { startedAt: 'x' } } }]
  });
  assert.deepEqual(crashLoopsForPod(p, NOW), []);
});

// --- normalizeImage ----------------------------------------------------------------------

test('normalizeImage: implicit docker.io/library and :latest are stripped for comparison', () => {
  assert.equal(normalizeImage('nginx'), normalizeImage('docker.io/library/nginx:latest'));
  assert.equal(normalizeImage('nginx:latest'), normalizeImage('nginx'));
  assert.equal(normalizeImage('myorg/app:1.2.3'), normalizeImage('docker.io/myorg/app:1.2.3'));
  assert.notEqual(normalizeImage('myorg/app:1.2.3'), normalizeImage('myorg/app:1.2.4'));
});

// --- E2: Deployment rollout truth ---------------------------------------------------------

function deployment({ name = 'd', namespace = 'ns', replicas = 2, updatedReplicas = 2, generation = 1, observedGeneration = 1, available = true, image = 'app:v1' } = {}) {
  return {
    metadata: { name, namespace, generation },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { spec: { containers: [{ name: 'app', image }] } } },
    status: {
      replicas, updatedReplicas, observedGeneration,
      conditions: available ? [{ type: 'Available', status: 'True' }] : []
    }
  };
}

function livePod(name, namespace, image, { deletionTimestamp, replicaSet = 'd-rs', ownerReferences } = {}) {
  return {
    metadata: {
      name,
      namespace,
      labels: { app: namespace === 'ns' ? 'd' : namespace },
      deletionTimestamp,
      ownerReferences: ownerReferences !== undefined
        ? ownerReferences
        : [{ kind: 'ReplicaSet', name: replicaSet, controller: true }]
    },
    status: { containerStatuses: [{ name: 'app', image }] }
  };
}

/** A metadata-only ReplicaSet, as the PartialObjectMetadataList read returns it. */
function replicaSet(name, namespace, deploymentName) {
  return {
    metadata: {
      name,
      namespace,
      ownerReferences: [{ kind: 'Deployment', name: deploymentName, controller: true }]
    }
  };
}

/** The `ownership` argument deploymentRolloutTruth takes, built from ReplicaSets. */
function owners(...replicaSets) {
  return { index: replicaSetOwnerIndex(replicaSets), reason: null };
}

const DEFAULT_OWNERS = owners(replicaSet('d-rs', 'ns', 'd'));

test('E2 Deployment: matching image + Available is not drift', () => {
  const dep = deployment();
  const pods = [livePod('d-1', 'ns', 'app:v1')];
  const result = deploymentRolloutTruth(dep, pods, DEFAULT_OWNERS);
  assert.equal(result.drifted, false);
  assert.equal(result.available, true);
  assert.equal(result.ownerResolution, 'owner-chain');
});

test('E2 Deployment: image mismatch with rollout finished is drift, not revision', () => {
  const dep = deployment({ updatedReplicas: 2, generation: 1, observedGeneration: 1 });
  const pods = [livePod('d-1', 'ns', 'app:v0-stuck')];
  const result = deploymentRolloutTruth(dep, pods, DEFAULT_OWNERS);
  assert.equal(result.drifted, true);
  assert.equal(result.revisionDetails.length, 0);
  assert.equal(result.driftDetails.length, 1);
});

test('E2 Deployment: image mismatch during an in-progress rollout is attributed to revision, not drift', () => {
  // updatedReplicas < replicas => rollout in flight
  const dep = deployment({ replicas: 2, updatedReplicas: 1 });
  const pods = [livePod('d-1', 'ns', 'app:v0')]; // still on old image, normal mid-rollout
  const result = deploymentRolloutTruth(dep, pods, DEFAULT_OWNERS);
  assert.equal(result.revisionInProgress, true);
  assert.equal(result.drifted, false, 'a rolling update in flight must not be reported as drift');
  assert.equal(result.revisionDetails.length, 1);
});

test('E2 Deployment: a pod mid-termination (deletionTimestamp set) is excluded from drift comparison', () => {
  const dep = deployment();
  const pods = [livePod('d-1', 'ns', 'app:v0-old', { deletionTimestamp: '2026-09-09T00:00:00Z' })];
  const result = deploymentRolloutTruth(dep, pods, DEFAULT_OWNERS);
  assert.equal(result.drifted, false, 'a terminating pod showing a stale image is not a rollout finding');
});

// --- E2: pods belong to a Deployment by owner chain, never by label selector ---------------

test('E2 Deployment: two Deployments sharing control-plane:manager do not drift on each other\'s pods', () => {
  // The reported bug, reduced: keda-manager and nats-manager both carry
  // `control-plane: manager` in kyma-system, each running its own correct image.
  const shared = { matchLabels: { 'control-plane': 'manager' } };
  const mk = (name, image) => {
    const dep = deployment({ name, namespace: 'kyma-system', image });
    dep.spec.selector = shared;
    return dep;
  };
  const keda = mk('keda-manager', 'keda:1.0.0');
  const nats = mk('nats-manager', 'nats:2.0.0');
  const pods = [
    {
      metadata: {
        name: 'keda-manager-rs-abc', namespace: 'kyma-system', labels: { 'control-plane': 'manager' },
        ownerReferences: [{ kind: 'ReplicaSet', name: 'keda-manager-6f9', controller: true }]
      },
      status: { containerStatuses: [{ name: 'app', image: 'keda:1.0.0' }] }
    },
    {
      metadata: {
        name: 'nats-manager-rs-def', namespace: 'kyma-system', labels: { 'control-plane': 'manager' },
        ownerReferences: [{ kind: 'ReplicaSet', name: 'nats-manager-7a1', controller: true }]
      },
      status: { containerStatuses: [{ name: 'app', image: 'nats:2.0.0' }] }
    }
  ];
  const ownership = owners(
    replicaSet('keda-manager-6f9', 'kyma-system', 'keda-manager'),
    replicaSet('nats-manager-7a1', 'kyma-system', 'nats-manager')
  );

  assert.equal(deploymentRolloutTruth(keda, pods, ownership).drifted, false);
  assert.equal(deploymentRolloutTruth(nats, pods, ownership).drifted, false);

  // Canary: matching by the shared selector — what this collector used to do — reports both
  // Deployments as image-drifted against the other one's pod.
  const bySelector = (dep) => {
    const image = dep.spec.template.spec.containers[0].image;
    return pods.filter(p => p.metadata.labels['control-plane'] === 'manager')
      .some(p => p.status.containerStatuses[0].image !== image);
  };
  assert.equal(bySelector(keda), true, 'canary: selector matching produces the false positive');
  assert.equal(bySelector(nats), true, 'canary: selector matching produces the false positive');
});

test('E2 Deployment: a pod owned by a DIFFERENT Deployment is not evaluated against this one', () => {
  const dep = deployment({ name: 'mine', namespace: 'ns', image: 'app:0.3.0' });
  const pods = [{
    metadata: {
      name: 'theirs-1', namespace: 'ns', labels: { app: 'mine' },
      ownerReferences: [{ kind: 'ReplicaSet', name: 'theirs-rs', controller: true }]
    },
    status: { containerStatuses: [{ name: 'app', image: 'app:0.1.0' }] }
  }];
  const ownership = owners(replicaSet('theirs-rs', 'ns', 'theirs'), replicaSet('mine-rs', 'ns', 'mine'));
  const result = deploymentRolloutTruth(dep, pods, ownership);
  assert.equal(result.drifted, false);
  assert.deepEqual(result.driftDetails, []);
});

test('E2 Deployment: a bare pod matching the selector is owned by nothing and is not drift', () => {
  const dep = deployment({ name: 'd', namespace: 'ns', image: 'app:0.3.0' });
  const bare = livePod('loose', 'ns', 'app:0.1.0', { ownerReferences: undefined });
  delete bare.metadata.ownerReferences;
  const result = deploymentRolloutTruth(dep, [bare], DEFAULT_OWNERS);
  assert.equal(result.drifted, false, 'a pod with no owner reference belongs to no Deployment');
  assert.deepEqual(result.driftDetails, []);
});

test('E2 Deployment: genuine drift names both tags in a plain-sentence explanation', () => {
  const dep = deployment({ image: 'registry/app:0.3.0' });
  const pods = [livePod('d-1', 'ns', 'registry/app:0.1.0')];
  const result = deploymentRolloutTruth(dep, pods, DEFAULT_OWNERS);
  assert.equal(result.drifted, true);
  const [mismatch] = result.driftDetails[0].mismatches;
  assert.equal(mismatch.container, 'app');
  assert.equal(mismatch.specImage, 'registry/app:0.3.0');
  assert.equal(mismatch.liveImage, 'registry/app:0.1.0');
  assert.equal(
    mismatch.explanation,
    'Pod is running a stale image. Template declares 0.3.0, but the live container is running 0.1.0.'
  );
});

test('E2 Deployment: an untaggable reference falls back to the full image, never an empty string', () => {
  const dep = deployment({ image: 'registry/app@sha256:aaaabbbbccccdddd' });
  const pods = [livePod('d-1', 'ns', 'registry/app@sha256:1111222233334444')];
  const [mismatch] = deploymentRolloutTruth(dep, pods, DEFAULT_OWNERS).driftDetails[0].mismatches;
  assert.match(mismatch.explanation, /sha256:aaaabbbbccc/);
  assert.match(mismatch.explanation, /sha256:111122223333/);
  assert.equal(imageShortForm('nginx'), 'nginx', 'no tag and no digest yields the reference itself');
});

// --- E2: a bare image ID cannot be compared, so it is not drift ---------------------------

// The real pair from kube-system/coredns on platformsbx: a pinned reference whose digest is a
// MANIFEST digest, against a live value that is the runtime's own image ID.
const COREDNS_SPEC = 'europe-docker.pkg.dev/gardener-project/releases/coredns/coredns:v1.14.7'
  + '@sha256:086b5184d964f6477cb2bcddc867bc3c0ea5b4fbd481f3fd6c9d3a87ae06084b';
const COREDNS_LIVE = 'sha256:1a3d043f79f8b891e427cd20dbe997553df58658a98cef9b027f93f5fa25ad9a';

test('E2 Deployment: a live container reporting a bare image ID is not comparable, therefore not drift', () => {
  const dep = deployment({ image: COREDNS_SPEC });
  const pods = [livePod('coredns-1', 'ns', COREDNS_LIVE)];
  const result = deploymentRolloutTruth(dep, pods, DEFAULT_OWNERS);
  assert.equal(result.drifted, false, 'a manifest digest and a runtime image ID are not comparable in principle');
  assert.deepEqual(result.driftDetails, []);

  // Not silently skipped: the collector says what it could not determine.
  assert.equal(result.uncomparableDetails.length, 1);
  const [entry] = result.uncomparableDetails;
  assert.equal(entry.pod, 'coredns-1');
  assert.equal(entry.containers[0].reason, 'BARE_IMAGE_ID');
  assert.equal(entry.containers[0].specImage, COREDNS_SPEC);
  assert.equal(entry.containers[0].liveImage, COREDNS_LIVE);
  assert.equal(result.uncomparableImages, 1, 'the Deployment entry carries the count for a three-way verdict');

  // Canary: comparing them anyway is not merely wrong, it invents a reference. normalizeImage
  // has no registry host to recognise in a bare ID and rewrites it to a docker.io library path.
  assert.equal(
    normalizeImage(COREDNS_LIVE),
    'docker.io/library/sha256:1a3d043f79f8b891e427cd20dbe997553df58658a98cef9b027f93f5fa25ad9a',
    'canary: the fabricated reference that produced 8 of the 12 false positives'
  );
  assert.notEqual(normalizeImage(COREDNS_SPEC), normalizeImage(COREDNS_LIVE),
    'canary: an unguarded comparison reports this as drift');
});

test('E2: isBareImageId distinguishes a digest-only ID from a short reference with no registry', () => {
  assert.equal(isBareImageId(COREDNS_LIVE), true);
  // These have no registry host either, and normalizeImage handles all of them correctly —
  // none may be swept up as "uncomparable".
  for (const ref of ['nginx', 'nginx:alpine', 'nginx:latest', 'app:1.2.3', 'app:v1.14.7']) {
    assert.equal(isBareImageId(ref), false, `${ref} is a reference, not an image ID`);
  }
  assert.equal(isBareImageId('registry/app@sha256:086b5184d964aaa1d4a0b1f1c4e0e8b0f6c5f7c0c1d2e3f4a5b6c7d8e9f0123456'), false);
});

test('E2: the four reference pairs normalizeImage already gets right stay non-drifted', () => {
  const pairs = [
    ['nginx:alpine', 'docker.io/library/nginx:alpine'],
    ['nginx', 'docker.io/library/nginx:latest'],
    ['sapse/sap-transp-proxy-operator:1.10.0', 'docker.io/sapse/sap-transp-proxy-operator:1.10.0'],
    ['openpolicyagent/gatekeeper:v3.23.0', 'docker.io/openpolicyagent/gatekeeper:v3.23.0']
  ];
  for (const [specImage, liveImage] of pairs) {
    const { mismatches, uncomparable } = podImageMismatches(
      [{ name: 'app', image: specImage }],
      { status: { containerStatuses: [{ name: 'app', image: liveImage }] } }
    );
    assert.deepEqual(mismatches, [], `${specImage} vs ${liveImage} must not be drift`);
    assert.deepEqual(uncomparable, [], `${specImage} vs ${liveImage} is comparable`);
  }
});

// --- The reported defect, end to end: 12 drifted Deployments must become exactly 1 ----------

/**
 * A reduced reproduction of the platformsbx shape that produced the twelve false positives:
 * three selector collisions (two byte-identical selectors, one a strict SUBSET of a foreign
 * pod's labels), eight kube-system Deployments whose pods report a bare image ID, and one
 * genuinely drifted Deployment. Only the last may be reported.
 */
function platformsbxShape() {
  const deployments = [];
  const replicaSets = [];
  const pods = [];

  const add = (namespace, name, image, selector, podImages) => {
    const dep = deployment({ name, namespace, image });
    if (selector) dep.spec.selector = selector;
    deployments.push(dep);
    replicaSets.push(replicaSet(`${name}-rs`, namespace, name));
    podImages.forEach((live, i) => pods.push({
      metadata: {
        name: `${name}-rs-${i}`,
        namespace,
        labels: { ...(selector ? selector.matchLabels : { app: name }), 'app.kubernetes.io/name': name },
        ownerReferences: [{ kind: 'ReplicaSet', name: `${name}-rs`, controller: true }]
      },
      status: { containerStatuses: [{ name: 'app', image: live }] }
    }));
  };

  // (1) Two byte-identical selectors, five pods each — each pod on its own correct image.
  const identical = { matchLabels: { 'control-plane': 'controller-manager' } };
  add('kyma-system', 'application-connector-controller-manager', 'acc:1.0.0', identical, Array(5).fill('acc:1.0.0'));
  add('kyma-system', 'kim-snatch-controller-manager', 'kim:2.0.0', identical, Array(5).fill('kim:2.0.0'));
  // (1b) nats-manager's selector is a strict SUBSET of the keda-manager pod's label set, so
  // comparing selectors to each other would not catch this one — only the owner chain does.
  add('kyma-system', 'nats-manager', 'nats:3.0.0', { matchLabels: { 'control-plane': 'manager' } }, ['nats:3.0.0']);
  const keda = deployment({ name: 'keda-manager', namespace: 'kyma-system', image: 'keda:4.0.0' });
  keda.spec.selector = { matchLabels: { 'control-plane': 'manager', 'app.kubernetes.io/name': 'keda-manager' } };
  deployments.push(keda);
  replicaSets.push(replicaSet('keda-manager-rs', 'kyma-system', 'keda-manager'));
  pods.push({
    metadata: {
      name: 'keda-manager-rs-0', namespace: 'kyma-system',
      labels: { 'control-plane': 'manager', 'app.kubernetes.io/name': 'keda-manager' },
      ownerReferences: [{ kind: 'ReplicaSet', name: 'keda-manager-rs', controller: true }]
    },
    status: { containerStatuses: [{ name: 'app', image: 'keda:4.0.0' }] }
  });

  // (2) Eight kube-system Deployments whose live image is a bare runtime image ID.
  const bareIdWorkloads = [
    'blackbox-exporter', 'calico-kube-controllers', 'calico-node-vertical-autoscaler',
    'calico-typha-deploy', 'calico-typha-horizontal-autoscaler', 'calico-typha-vertical-autoscaler',
    'coredns', 'metrics-server'
  ];
  bareIdWorkloads.forEach((name, i) => add(
    'kube-system', name,
    `europe-docker.pkg.dev/gardener/${name}:v1.${i}.0@sha256:086b5184d964f6477cb2bcddc867bc3c0ea5b4fbd481f3fd6c9d3a87ae06084b`,
    null,
    [`sha256:1a3d043f79f8b891e427cd20dbe997553df58658a98cef9b027f93f5fa25ad9${i}`]
  ));

  // (3) The one genuine drift: both pods a release behind the template.
  add('polls', 'polls-frontend',
    'sapcloudplatform-artifactory.apple.com/btp-kyma/polls/polls-frontend:0.3.0', null,
    Array(2).fill('sapcloudplatform-artifactory.apple.com/btp-kyma/polls/polls-frontend:0.1.0'));

  return { deployments, replicaSets, pods };
}

test('E2: the platformsbx shape reports exactly one drifted Deployment — polls/polls-frontend', () => {
  const { deployments, replicaSets, pods } = platformsbxShape();
  const ownership = owners(...replicaSets);
  const rollouts = deployments.map(d => deploymentRolloutTruth(d, pods, ownership));

  const drifted = rollouts.filter(r => r.drifted).map(r => `${r.namespace}/${r.name}`);
  assert.deepEqual(drifted, ['polls/polls-frontend']);
  const pollsRollout = rollouts.find(r => r.name === 'polls-frontend');
  assert.equal(pollsRollout.driftDetails.length, 2, 'both pods are a release behind');
  assert.equal(
    pollsRollout.driftDetails[0].mismatches[0].explanation,
    'Pod is running a stale image. Template declares 0.3.0, but the live container is running 0.1.0.'
  );

  // The eight bare-ID Deployments are accounted for explicitly, not silently dropped.
  const uncomparable = rollouts.filter(r => r.uncomparableDetails.length > 0).map(r => r.name);
  assert.equal(uncomparable.length, 8);
  assert.ok(uncomparable.includes('coredns'));
  // Each is the third verdict, not a clean one: drifted false AND uncomparableImages above 0.
  for (const r of rollouts.filter(x => uncomparable.includes(x.name))) {
    assert.equal(r.drifted, false);
    assert.ok(r.uncomparableImages > 0, `${r.name} must not read as clean`);
  }
  // And the one genuine drift is NOT contaminated by the new state.
  assert.equal(pollsRollout.uncomparableImages, 0);

  // Canary: the two root causes, each measured on this same shape.
  // (a) selector matching claims foreign pods and reports 3 extra Deployments as drifted;
  // (b) comparing a bare image ID reports the other 8.
  const bySelector = dep => {
    const want = dep.spec.template.spec.containers[0].image;
    const sel = Object.entries(dep.spec.selector.matchLabels);
    return pods
      .filter(p => p.metadata.namespace === dep.metadata.namespace
        && sel.every(([k, v]) => p.metadata.labels[k] === v))
      .some(p => normalizeImage(p.status.containerStatuses[0].image) !== normalizeImage(want));
  };
  const oldVerdict = deployments.filter(bySelector).map(d => `${d.metadata.namespace}/${d.metadata.name}`);
  assert.equal(oldVerdict.length, 12, `canary: the old logic reports 12 — got ${oldVerdict.join(', ')}`);
  assert.ok(oldVerdict.includes('kyma-system/nats-manager'));
  assert.ok(oldVerdict.includes('kube-system/coredns'));
  assert.ok(oldVerdict.includes('polls/polls-frontend'));
});

test('E2 Deployment: ReplicaSets unreadable makes the drift verdict unknown, not clean', () => {
  const dep = deployment({ image: 'app:0.3.0' });
  const pods = [livePod('d-1', 'ns', 'app:0.1.0')]; // would be genuine drift if resolvable
  const result = deploymentRolloutTruth(dep, pods, { index: null, reason: 'FORBIDDEN' });
  assert.equal(result.ownerResolution, 'unavailable');
  assert.equal(result.ownerResolutionReason, 'FORBIDDEN');
  assert.equal(result.drifted, false);
  assert.deepEqual(result.driftDetails, []);
  assert.deepEqual(result.revisionDetails, []);
});

// --- E2: StatefulSet rollout truth (no Available gate) ------------------------------------

test('E2 StatefulSet: current revision reads as current with no Available condition anywhere in the object', () => {
  const sts = { metadata: { name: 's', namespace: 'ns' }, status: { currentRevision: 'r2', updateRevision: 'r2' } };
  assert.equal(statefulSetRolloutTruth(sts).current, true);
});

test('E2 StatefulSet: revision skew is stale, independent of any Available-style gate', () => {
  const sts = { metadata: { name: 's', namespace: 'ns' }, status: { currentRevision: 'r1', updateRevision: 'r2' } };
  const result = statefulSetRolloutTruth(sts);
  assert.equal(result.current, false);

  // Canary: gating this on an Available condition (as the Deployment check does) would make
  // the check permanently unfireable, since StatefulSets never publish one.
  const wronglyGated = Boolean(sts.status.conditions && sts.status.conditions.some(c => c.type === 'Available'));
  assert.equal(wronglyGated, false, 'an Available-condition gate would never be true for a StatefulSet — canary confirms the check would never fire');
});

// --- E3: Deployment steady-state under-capacity --------------------------------------------

test('E3: Available + rollout finished + short of desired replicas is under-capacity', () => {
  const dep = deployment({ replicas: 3, updatedReplicas: 3 });
  dep.status.readyReplicas = 1;
  const truth = deploymentRolloutTruth(dep, [], DEFAULT_OWNERS);
  const result = deploymentUnderCapacity(dep, truth);
  assert.ok(result);
  assert.equal(result.desired, 3);
  assert.equal(result.ready, 1);
});

test('E3: a Deployment merely mid-rollout is not reported as under-capacity', () => {
  const dep = deployment({ replicas: 3, updatedReplicas: 1 });
  dep.status.readyReplicas = 1;
  const truth = deploymentRolloutTruth(dep, [], DEFAULT_OWNERS);
  assert.equal(truth.revisionInProgress, true);
  const result = deploymentUnderCapacity(dep, truth);
  assert.equal(result, null, 'mid-rollout under-capacity is expected, not a finding');
});

// --- E4: daemonSetCoverage -----------------------------------------------------------------

test('E4: desiredNumberScheduled 0 is a calm "targets no node" finding, not "broken"', () => {
  const ds = {
    metadata: { name: 'gpu-agent', namespace: 'ns', generation: 1 },
    status: { desiredNumberScheduled: 0, numberAvailable: 0, updatedNumberScheduled: 0, numberMisscheduled: 0, numberReady: 0, observedGeneration: 1 }
  };
  const result = daemonSetCoverage(ds);
  assert.equal(result.targetsNoNodes, true);
  assert.equal(result.stuckRollout, false);
  assert.equal(result.underCovered, false);
});

test('E4: canary — a shared DaemonSet-inside-E2 function misreports desiredNumberScheduled:0 as broken', () => {
  // This reproduces the exact bug the task warns against: folding DaemonSet logic into the
  // Deployment/StatefulSet-style "ready === desired" check instead of E4's own function.
  function wronglySharedRolloutCheck(obj) {
    const status = obj.status || {};
    const desired = status.desiredNumberScheduled || 0;
    const ready = status.numberReady || 0;
    return { healthy: ready === desired && desired > 0 };
  }
  const ds = { metadata: { name: 'gpu-agent', namespace: 'ns', generation: 1 }, status: { desiredNumberScheduled: 0, numberReady: 0, observedGeneration: 1 } };
  assert.equal(wronglySharedRolloutCheck(ds).healthy, false, 'canary: the wrong shared function reports this calm zero-target DaemonSet as unhealthy');
  // The real function must not make that mistake.
  assert.equal(daemonSetCoverage(ds).targetsNoNodes, true);
  assert.equal(daemonSetCoverage(ds).stuckRollout, false);
});

test('E4: a genuinely stuck rollout is only reported once the spec change has been observed', () => {
  const unreconciled = {
    metadata: { name: 'ds', namespace: 'ns', generation: 2 },
    status: { desiredNumberScheduled: 5, numberAvailable: 5, updatedNumberScheduled: 2, numberMisscheduled: 0, numberReady: 5, observedGeneration: 1 }
  };
  assert.equal(daemonSetCoverage(unreconciled).stuckRollout, false, 'an unreconciled generation must not read as a stuck rollout');

  const reconciledStuck = { ...unreconciled, metadata: { ...unreconciled.metadata }, status: { ...unreconciled.status, observedGeneration: 2 } };
  assert.equal(daemonSetCoverage(reconciledStuck).stuckRollout, true);
});

test('E4: numberMisscheduled has its own dedicated field, not folded into another count', () => {
  const ds = {
    metadata: { name: 'ds', namespace: 'ns', generation: 1 },
    status: { desiredNumberScheduled: 3, numberAvailable: 3, updatedNumberScheduled: 3, numberMisscheduled: 2, numberReady: 3, observedGeneration: 1 }
  };
  const result = daemonSetCoverage(ds);
  assert.equal(result.numberMisscheduled, 2);
  assert.equal(result.stuckRollout, false);
  assert.equal(result.underCovered, false);
});

// --- E5: services with zero ready endpoints -------------------------------------------------

function service(name, namespace, type) {
  return { metadata: { name, namespace }, spec: { type } };
}
function slice({ namespace, serviceName, addressType = 'IPv4', endpoints = [] }) {
  return { metadata: { namespace, labels: { 'kubernetes.io/service-name': serviceName } }, addressType, endpoints };
}

test('E5: join is namespace-scoped — same service name in two namespaces does not cross-match', () => {
  const services = [service('api', 'payments'), service('api', 'staging')];
  const slices = [
    slice({ namespace: 'payments', serviceName: 'api', endpoints: [{ addresses: ['10.0.0.1'] }] })
    // staging/api has NO slice at all — must be reported as zero, not borrow payments' count.
  ];
  const zero = servicesWithZeroReadyEndpoints(services, slices);
  assert.deepEqual(zero.map(s => `${s.namespace}/${s.name}`), ['staging/api']);
});

test('E5: undefined conditions.ready counts as ready per the API default, not as unready', () => {
  const services = [service('web', 'ns')];
  const slices = [slice({ namespace: 'ns', serviceName: 'web', endpoints: [{ addresses: ['10.0.0.1'] }] })]; // no conditions at all
  assert.deepEqual(servicesWithZeroReadyEndpoints(services, slices), []);
});

test('E5: explicit ready:false is not counted', () => {
  const services = [service('web', 'ns')];
  const slices = [slice({ namespace: 'ns', serviceName: 'web', endpoints: [{ addresses: ['10.0.0.1'], conditions: { ready: false } }] })];
  const zero = servicesWithZeroReadyEndpoints(services, slices);
  assert.deepEqual(zero.map(s => s.name), ['web']);
});

test('E5: multiple slices for the same service are summed, not just the first found', () => {
  const services = [service('web', 'ns')];
  const slices = [
    slice({ namespace: 'ns', serviceName: 'web', endpoints: [] }), // e.g. the first of 2 slices, empty
    slice({ namespace: 'ns', serviceName: 'web', endpoints: [{ addresses: ['10.0.0.2'] }] })
  ];
  assert.deepEqual(servicesWithZeroReadyEndpoints(services, slices), []);
});

test('E5: non-IPv4 slices are not counted toward the IPv4-only total', () => {
  const services = [service('web', 'ns')];
  const slices = [slice({ namespace: 'ns', serviceName: 'web', addressType: 'IPv6', endpoints: [{ addresses: ['::1'] }] })];
  const zero = servicesWithZeroReadyEndpoints(services, slices);
  assert.deepEqual(zero.map(s => s.name), ['web'], 'an IPv6-only slice must not be read as an IPv4 endpoint');
});

test('E5: ExternalName services are excluded — they never have endpoints by design', () => {
  const services = [service('ext', 'ns', 'ExternalName')];
  assert.deepEqual(servicesWithZeroReadyEndpoints(services, []), []);
});

// --- collect(): pod-sweep failure downgrades every verdict to unknown ----------------------

const { collect } = _reliability;

function fakeListFn(byPath) {
  return async ({ path }) => {
    for (const [match, result] of byPath) {
      if (path.startsWith(match)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`unexpected path in test: ${path}`);
  };
}

test('collect(): a failed pod sweep downgrades every E1-E5 verdict to unknown, not a clean zero', async () => {
  const podsErr = Object.assign(new Error('forbidden'), { status: 403 });
  const listFn = fakeListFn([
    ['/apis/apps/v1/deployments', [deployment({ replicas: 3, updatedReplicas: 3 })]],
    ['/apis/apps/v1/statefulsets', []],
    ['/apis/apps/v1/daemonsets', []],
    ['/apis/apps/v1/replicasets', []],
    ['/api/v1/pods', podsErr],
    ['/api/v1/services', []],
    ['/apis/discovery.k8s.io/v1/endpointslices', []]
  ]);
  const result = await collect({ cluster: { id: 'c1' }, token: 't', listFn, callFn: async () => ({ versions: [] }) });
  assert.equal(result.summary.verdict, 'unknown');
  assert.deepEqual(result.crashLoops, []);
  assert.deepEqual(result.rollouts.deployments, [], 'a Deployment that would otherwise report drift must not be evaluated on a degraded pod sweep');
  assert.deepEqual(result.underCapacity, []);
  assert.deepEqual(result.zeroEndpointServices, []);
  assert.ok(result.summary.unavailable.includes('pods'));

  // Canary: without the podsOk gate, this same Deployment (3 desired, 3 updated, Available)
  // reads as drift-free and its underCapacity check would run against a pods array that is
  // actually empty only because the read failed — i.e. it would report a clean fleet built on
  // a read that never happened.
  const truthIfUngated = deploymentRolloutTruth(deployment({ replicas: 3, updatedReplicas: 3 }), [], DEFAULT_OWNERS);
  assert.equal(truthIfUngated.drifted, false, 'confirms an ungated check would have produced a false "clean" reading here');
});

test('collect(): endpointslices API 404ing cluster-wide is unavailable (MISSING_API), never a true zero', async () => {
  const notFound = Object.assign(new Error('the server could not find the requested resource'), { status: 404 });
  const groupNotFound = Object.assign(new Error('not found'), { status: 404 });
  const listFn = fakeListFn([
    ['/apis/apps/v1/deployments', []],
    ['/apis/apps/v1/statefulsets', []],
    ['/apis/apps/v1/daemonsets', []],
    ['/apis/apps/v1/replicasets', []],
    ['/api/v1/pods', []],
    ['/api/v1/services', [service('web', 'ns')]],
    ['/apis/discovery.k8s.io/v1/endpointslices', notFound]
  ]);
  const callFn = async ({ path }) => {
    if (path === '/apis/discovery.k8s.io') throw groupNotFound;
    throw new Error(`unexpected callFn path: ${path}`);
  };
  const result = await collect({ cluster: { id: 'c1' }, token: 't', listFn, callFn });
  assert.ok(result.summary.unavailable.includes('endpointslices'), 'a cluster-wide-disabled discovery API must be unavailable');
  assert.deepEqual(result.zeroEndpointServices, [], 'must not report a services-list read as zero endpoints when the slices API itself is missing');
});

test('collect(): a failed ReplicaSet read makes drift unknown — no selector fallback, no zero count', async () => {
  const rsErr = Object.assign(new Error('replicasets is forbidden'), { status: 403 });
  const dep = deployment({ image: 'app:0.3.0' });
  const listFn = fakeListFn([
    ['/apis/apps/v1/deployments', [dep]],
    ['/apis/apps/v1/statefulsets', []],
    ['/apis/apps/v1/daemonsets', []],
    ['/apis/apps/v1/replicasets', rsErr],
    // A pod that WOULD be reported as drift by the old selector match.
    ['/api/v1/pods', [livePod('d-1', 'ns', 'app:0.1.0')]],
    ['/api/v1/services', []],
    ['/apis/discovery.k8s.io/v1/endpointslices', []]
  ]);
  const result = await collect({ cluster: { id: 'c1' }, token: 't', listFn, callFn: async () => ({ versions: [] }) });

  const [rollout] = result.rollouts.deployments;
  assert.equal(rollout.ownerResolution, 'unavailable');
  assert.equal(rollout.ownerResolutionReason, 'FORBIDDEN');
  assert.equal(rollout.drifted, false);
  assert.deepEqual(rollout.driftDetails, []);
  assert.equal(result.summary.driftedDeployments, null, 'an unread owner chain is not a count of 0');
  assert.ok(result.summary.unavailable.includes('replicasets'));
  // E1/E3/E5 still rode on a good pod sweep, so the cluster verdict itself stays honest.
  assert.equal(result.summary.verdict, 'ok');
});

test('collect(): the owner chain resolves through ReplicaSets and reports genuine drift', async () => {
  const dep = deployment({ image: 'app:0.3.0' });
  const listFn = fakeListFn([
    ['/apis/apps/v1/deployments', [dep]],
    ['/apis/apps/v1/statefulsets', []],
    ['/apis/apps/v1/daemonsets', []],
    ['/apis/apps/v1/replicasets', [replicaSet('d-rs', 'ns', 'd')]],
    ['/api/v1/pods', [livePod('d-1', 'ns', 'app:0.1.0')]],
    ['/api/v1/services', []],
    ['/apis/discovery.k8s.io/v1/endpointslices', []]
  ]);
  const result = await collect({ cluster: { id: 'c1' }, token: 't', listFn, callFn: async () => ({ versions: [] }) });
  const [rollout] = result.rollouts.deployments;
  assert.equal(rollout.ownerResolution, 'owner-chain');
  assert.equal(rollout.drifted, true);
  assert.equal(result.summary.driftedDeployments, 1);
});

test('collect(): the ReplicaSet read is metadata-only — nothing outside metadata is ever asked for', async () => {
  const seen = [];
  const listFn = async ({ path, accept }) => {
    seen.push({ path, accept });
    return [];
  };
  await collect({ cluster: { id: 'c1' }, token: 't', listFn, callFn: async () => ({ versions: [] }) });
  const rs = seen.find(r => r.path.includes('replicasets'));
  assert.ok(rs, 'replicasets must be read');
  assert.match(rs.accept, /PartialObjectMetadataList/);
  const pods = seen.find(r => r.path.includes('/api/v1/pods'));
  assert.equal(pods.accept, undefined, 'the pod read still needs full objects');
});

// --- The wire envelope for the two unknown states ------------------------------------------
//
// The tests above assert the VERDICT; the UI branches on the ENVELOPE. Asserted separately on
// each side of that boundary, a refactor that stopped emitting `uncomparableImages` on the
// unavailable path, or renamed `reason` to something else, would leave this suite green and
// silently break the frontend's four-state discriminator. So each unknown state is pinned once
// as a whole object, from collect(), exactly as it goes on the wire.

test('collect() envelope: the unavailable state emits all five discriminator fields together', async () => {
  const rsErr = Object.assign(new Error('replicasets is forbidden'), { status: 403 });
  const listFn = fakeListFn([
    ['/apis/apps/v1/deployments', [deployment({ name: 'd', namespace: 'ns', image: 'app:0.3.0' })]],
    ['/apis/apps/v1/statefulsets', []],
    ['/apis/apps/v1/daemonsets', []],
    ['/apis/apps/v1/replicasets', rsErr],
    ['/api/v1/pods', [livePod('d-1', 'ns', 'app:0.1.0')]],
    ['/api/v1/services', []],
    ['/apis/discovery.k8s.io/v1/endpointslices', []]
  ]);
  const result = await collect({ cluster: { id: 'c1' }, token: 't', listFn, callFn: async () => ({ versions: [] }) });

  // One assertion on one object: `drifted` and the arrays are indistinguishable from clean in
  // this state, which is exactly why `ownerResolution` must be present rather than undefined.
  assert.deepEqual(result.rollouts.deployments[0], {
    kind: 'Deployment',
    name: 'd',
    namespace: 'ns',
    available: true,
    revisionInProgress: false,
    ownerResolution: 'unavailable',
    ownerResolutionReason: 'FORBIDDEN',
    drifted: false,
    driftDetails: [],
    revisionDetails: [],
    uncomparableImages: 0,
    uncomparableDetails: []
  });
});

test('collect() envelope: the not-comparable state emits reason and a non-empty explanation', async () => {
  const listFn = fakeListFn([
    ['/apis/apps/v1/deployments', [deployment({ name: 'coredns', namespace: 'ns', image: COREDNS_SPEC })]],
    ['/apis/apps/v1/statefulsets', []],
    ['/apis/apps/v1/daemonsets', []],
    ['/apis/apps/v1/replicasets', [replicaSet('d-rs', 'ns', 'coredns')]],
    ['/api/v1/pods', [livePod('coredns-1', 'ns', COREDNS_LIVE)]],
    ['/api/v1/services', []],
    ['/apis/discovery.k8s.io/v1/endpointslices', []]
  ]);
  const result = await collect({ cluster: { id: 'c1' }, token: 't', listFn, callFn: async () => ({ versions: [] }) });
  const entry = result.rollouts.deployments[0];

  assert.deepEqual(entry, {
    kind: 'Deployment',
    name: 'coredns',
    namespace: 'ns',
    available: true,
    revisionInProgress: false,
    ownerResolution: 'owner-chain',
    ownerResolutionReason: null,
    // Orthogonal to `uncomparableImages`, not an if/else: a Deployment can be both, and this
    // one is drift-free with one container that could not be compared at all.
    drifted: false,
    driftDetails: [],
    revisionDetails: [],
    uncomparableImages: 1,
    uncomparableDetails: [{
      pod: 'coredns-1',
      containers: [{
        container: 'app',
        specImage: COREDNS_SPEC,
        liveImage: COREDNS_LIVE,
        reason: 'BARE_IMAGE_ID',
        explanation: 'The running container reports a bare image ID instead of an image reference, '
          + 'so it cannot be compared with the template. This is not drift — it is unknown.'
      }]
    }]
  });
  assert.ok(entry.uncomparableImages > 0);
  assert.ok(entry.uncomparableDetails[0].containers[0].explanation.length > 0, 'the copy the UI renders must not be empty');
  assert.equal(result.summary.uncomparableImages, 1);
});
