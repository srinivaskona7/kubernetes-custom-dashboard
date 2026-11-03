/**
 * Workload reliability — the "is this actually staying up" view, one layer under the plain
 * ready/desired counts `workloads.js` already reports.
 *
 * Five separate questions, each with its own failure mode if collapsed into a neighbour:
 *
 *   E1  is a container crashlooping right now, even before Kubernetes has escalated the
 *       waiting reason, and without producing an absurd rate for a container that just
 *       started (a floored denominator).
 *   E2  is a Deployment/StatefulSet's rollout actually finished and correct — a Deployment
 *       reports `Available` on stale pods just as readily as fresh ones, and a StatefulSet
 *       reports no `Available` condition at all, so each kind needs its OWN derivation, not
 *       one shared function bent to fit both. For the Deployment half, "which pods are this
 *       Deployment's" is answered by reading ReplicaSets and walking the real owner chain,
 *       because label selectors overlap — see `replicaSetOwnerIndex`.
 *   E3  a Deployment that finished rolling out and is STILL short of its desired replica
 *       count — distinct from one that is merely mid-rollout, which is not a capacity problem.
 *   E4  a DaemonSet's own coverage of the nodes it targets — including the calm case where it
 *       targets none at all, which must not be reported as broken.
 *   E5  a Service with zero ready endpoints, joined to EndpointSlices by namespace-scoped
 *       Service name, never by name alone across the fleet.
 *
 * PodDisruptionBudgets are deliberately not read here — that resource belongs to policy.js
 * exclusively, and a "steady-state under-capacity" check does not need them: E3 already
 * answers "is this Deployment short of replicas" without knowing what a voluntary-eviction
 * budget would allow.
 *
 * Every one of E1-E5 is downgraded to `verdict: 'unknown'` for a cluster whose own pod list
 * could not be read — a clean crashloop/rollout/capacity/endpoint reading built on top of a
 * degraded pod sweep would be exactly the silent-zero failure mode this whole codebase exists
 * to avoid, just one collector over from where the read actually failed.
 */
import k8sModule from '../k8s.js';
const { list, call, namespaceSegment, METADATA_ONLY } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, absentList, unavailableLabels, truncatedLabels } = safeListModule;

const ENDPOINTSLICE_GROUP = 'discovery.k8s.io';
const ENDPOINTSLICE_VERSION = 'v1';

// Never divide a restart count by an elapsed time near zero — a container that restarted
// twice ninety seconds after starting is not really doing "80 restarts/hour", it just
// hasn't been observed long enough for the rate to mean anything. Five minutes is short
// enough that a genuine fast crashloop still clears the recency threshold below well within
// the floor, and long enough that the floor itself never manufactures a false alarm.
const MIN_AGE_HOURS = 5 / 60;

// A container that has restarted at least this many times, at at least this rate, is
// "recently and repeatedly failing" even if Kubernetes has not (yet, or ever, if it hasn't
// crossed the backoff escalation point) written CrashLoopBackOff into `state.waiting.reason`.
const RECENCY_MIN_RESTARTS = 3;
const RECENCY_MIN_RATE = 3;

/**
 * E1. Per-container crashloop signal for one pod.
 *
 * `waiting.reason === 'CrashLoopBackOff'` and the recency signal are combined with OR, not
 * used as alternatives to pick between: recency alone would MISS a crashloop that has not
 * yet accumulated a `lastState.terminated` entry within the observed window (a container can
 * be in CrashLoopBackOff — Kubernetes says so directly — before this function has any restart
 * history to compute a rate from at all), and the waiting-reason check alone would miss a
 * loop Kubernetes has not escalated to that string yet. Either check firing is enough.
 *
 * @param {object} pod
 * @param {number} now epoch ms, injectable for tests
 * @returns {Array<{namespace: string, pod: string, container: string, restartCount: number,
 *                  restartsPerHour: number, reason: string|null, detectedBy: string}>}
 */
function crashLoopsForPod(pod, now = Date.now()) {
  const status = pod.status || {};
  const startTime = status.startTime ? new Date(status.startTime).getTime() : now;
  const ageHours = Math.max((now - startTime) / 3600000, MIN_AGE_HOURS);
  const statuses = status.containerStatuses || [];

  const out = [];
  for (const cs of statuses) {
    const restartCount = cs.restartCount || 0;
    const restartsPerHour = restartCount / ageHours;
    const waiting = cs.state && cs.state.waiting;
    const waitingCrashLoop = Boolean(waiting && waiting.reason === 'CrashLoopBackOff');
    const recencySignal = restartCount >= RECENCY_MIN_RESTARTS && restartsPerHour >= RECENCY_MIN_RATE;
    if (!waitingCrashLoop && !recencySignal) continue;

    out.push({
      namespace: pod.metadata.namespace,
      pod: pod.metadata.name,
      container: cs.name,
      restartCount,
      restartsPerHour: Math.round(restartsPerHour * 100) / 100,
      reason: (waiting && waiting.reason)
        || (cs.lastState && cs.lastState.terminated && cs.lastState.terminated.reason)
        || null,
      detectedBy: waitingCrashLoop ? 'waiting-reason' : 'recency'
    });
  }
  return out;
}

/**
 * Normalise an image reference so `nginx`, `nginx:latest`, `docker.io/nginx:latest` and
 * `docker.io/library/nginx` all compare equal — Kubernetes itself treats them as the same
 * pull, and comparing the raw strings would report every one of those pairs as drift.
 */
function normalizeImage(image) {
  if (!image) return image;
  let ref = image;
  const atIndex = ref.indexOf('@');
  const digest = atIndex === -1 ? '' : ref.slice(atIndex);
  if (atIndex !== -1) ref = ref.slice(0, atIndex);

  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  let repo = ref;
  let tag = 'latest';
  if (lastColon > lastSlash) {
    tag = ref.slice(lastColon + 1);
    repo = ref.slice(0, lastColon);
  }

  const parts = repo.split('/');
  let normalizedRepo;
  if (parts.length === 1) {
    normalizedRepo = `docker.io/library/${parts[0]}`;
  } else {
    const first = parts[0];
    const looksLikeRegistryHost = first.includes('.') || first.includes(':') || first === 'localhost';
    if (!looksLikeRegistryHost) {
      normalizedRepo = `docker.io/${repo}`;
    } else if (first === 'docker.io' && parts.length === 2) {
      normalizedRepo = `docker.io/library/${parts[1]}`;
    } else {
      normalizedRepo = repo;
    }
  }
  return `${normalizedRepo}:${tag}${digest}`;
}

/**
 * The part of an image reference an operator actually reads: its tag, or failing that the
 * digest. Only used to phrase `explanation` — never to compare, which is `normalizeImage`'s
 * job, because two different references can perfectly well share a tag.
 *
 * A reference with neither a tag nor a digest (`nginx`) yields the reference itself rather
 * than the empty string an unguarded `slice` would produce: a sentence that names no version
 * at all is worse than one that names the whole reference.
 */
function imageShortForm(image) {
  const ref = String(image == null ? '' : image);
  if (!ref) return ref;
  const at = ref.indexOf('@');
  const digest = at === -1 ? '' : ref.slice(at + 1);
  const named = at === -1 ? ref : ref.slice(0, at);
  const lastSlash = named.lastIndexOf('/');
  const lastColon = named.lastIndexOf(':');
  if (lastColon > lastSlash) return named.slice(lastColon + 1);
  if (digest) return digest.slice(0, 19);
  return ref;
}

/**
 * The operator-facing sentence for one container's drift, naming both versions.
 *
 * When the two short forms come out identical — two pushes to the same mutable tag, differing
 * only by digest — the sentence falls back to the full references. "Template declares latest,
 * but the live container is running latest" is a sentence that reads as a bug in the tool.
 */
function mismatchExplanation(specImage, liveImage) {
  const specShort = imageShortForm(specImage);
  const liveShort = imageShortForm(liveImage);
  const [spec, live] = specShort === liveShort ? [specImage, liveImage] : [specShort, liveShort];
  return `Pod is running a stale image. Template declares ${spec}, but the live container is running ${live}.`;
}

/**
 * Is this value an image *reference* at all, or a bare content-addressable image ID?
 *
 * Eight kube-system Deployments on platformsbx report `containerStatuses[].image` as
 * `sha256:1a3d043f79f8…` with no repository component whatsoever, while their template pins
 * `…/coredns:v1.14.7@sha256:086b5184d964…`. Those two digests are not the same kind of digest
 * — one is the manifest digest from the reference, the other the runtime's own image ID — so
 * they cannot be compared for equality even in principle, and `imageID` carries the same
 * ambiguity so it is no help either.
 *
 * Comparing them anyway is worse than useless, because `normalizeImage` has no registry host
 * to recognise and rewrites the ID to `docker.io/library/sha256:1a3d043f…` — a fabricated
 * reference to an image that does not exist. Every one of those eight then reported drift.
 *
 * The test is deliberately narrow: no `/` (so no repository path) AND an `<alg>:<hex>` shape
 * with at least 32 hex digits. `nginx:latest`, `nginx` and `app:1.2.3` all have no `/` either
 * and must stay comparable — `normalizeImage` handles them correctly today.
 */
const BARE_IMAGE_ID = /^[a-z][a-z0-9]*:[0-9a-f]{32,}$/i;

function isBareImageId(image) {
  const ref = String(image == null ? '' : image);
  if (!ref || ref.includes('/')) return false;
  return BARE_IMAGE_ID.test(ref);
}

/**
 * Per-container-name image comparison between a workload's spec and one of its live pods.
 *
 * Two distinct kinds of "no mismatch" come out of here, and collapsing them would be the
 * silent-zero failure again one level down: a container whose images genuinely agree, and a
 * container whose live image is a bare ID and therefore cannot be compared at all. The second
 * is reported separately in `uncomparable` — same reasoning as the `live === undefined` skip
 * just below, which is also "we cannot compare", not "the images differ".
 *
 * @returns {{mismatches: object[], uncomparable: object[]}}
 */
function podImageMismatches(specContainers, pod) {
  const statuses = (pod.status && pod.status.containerStatuses) || [];
  const liveByName = new Map(statuses.map(cs => [cs.name, cs.image]));
  const mismatches = [];
  const uncomparable = [];
  for (const c of specContainers) {
    const live = liveByName.get(c.name);
    if (live === undefined) continue; // container not started/reported yet — not a drift verdict
    if (isBareImageId(live) || isBareImageId(c.image)) {
      uncomparable.push({
        container: c.name,
        specImage: c.image,
        liveImage: live,
        reason: 'BARE_IMAGE_ID',
        explanation: 'The running container reports a bare image ID instead of an image reference, '
          + 'so it cannot be compared with the template. This is not drift — it is unknown.'
      });
      continue;
    }
    if (normalizeImage(c.image) !== normalizeImage(live)) {
      mismatches.push({
        container: c.name,
        specImage: c.image,
        liveImage: live,
        explanation: mismatchExplanation(c.image, live)
      });
    }
  }
  return { mismatches, uncomparable };
}

/**
 * `namespace/replicaSetName` -> the name of the Deployment that owns that ReplicaSet, taken
 * from the ReplicaSet's OWN `ownerReferences`.
 *
 * This index is the whole reason this collector reads ReplicaSets at all. The alternative —
 * matching pods to a Deployment by its `spec.selector` — is wrong on any real Kyma cluster,
 * because label selectors overlap: a dozen operators in `kyma-system` share
 * `control-plane: manager`, so `keda-manager`'s pods matched the `nats-manager` Deployment and
 * were compared against the wrong template, reporting a dozen Deployments as image-drifted
 * when none of them were.
 *
 * Stripping the `-<hash>` suffix off a ReplicaSet name to guess its Deployment (as mesh.js
 * does, deliberately, having no ReplicaSet grant) is not used here: this collector has the
 * grant, and a real owner reference beats a string that merely looks like one.
 */
function replicaSetOwnerIndex(replicaSets) {
  const index = new Map();
  for (const rs of replicaSets || []) {
    const meta = (rs && rs.metadata) || {};
    if (!meta.name || !meta.namespace) continue;
    const owners = meta.ownerReferences || [];
    const owner = owners.find(o => o && o.kind === 'Deployment' && o.controller === true)
      || owners.find(o => o && o.kind === 'Deployment');
    if (!owner || !owner.name) continue;
    index.set(`${meta.namespace}/${meta.name}`, owner.name);
  }
  return index;
}

/**
 * The Deployment a pod belongs to, resolved one hop at a time: pod -> its controlling
 * ReplicaSet -> that ReplicaSet's owning Deployment. Both hops are real API relations.
 *
 * `null` for a pod with no owner at all (a bare Pod), for one owned by a DaemonSet or
 * StatefulSet, and for one whose ReplicaSet is not in the index. None of those belong to a
 * Deployment for drift purposes, and a bare pod must NOT fall back to selector matching —
 * that is exactly the overlap this function exists to avoid.
 *
 * @returns {{namespace: string, name: string}|null}
 */
function deploymentOwnerOfPod(pod, ownerIndex) {
  const meta = (pod && pod.metadata) || {};
  const owners = meta.ownerReferences || [];
  const owner = owners.find(o => o && o.kind === 'ReplicaSet' && o.controller === true)
    || owners.find(o => o && o.kind === 'ReplicaSet');
  if (!owner || !owner.name || !meta.namespace) return null;
  const deployment = ownerIndex.get(`${meta.namespace}/${owner.name}`);
  return deployment ? { namespace: meta.namespace, name: deployment } : null;
}

/**
 * E2, Deployment. Existing image-drift + Available-condition logic: a Deployment is only
 * "rolled out correctly" when it both reports Available AND every live pod's containers
 * match the template — Available alone is what let a stuck-on-old-image Deployment read as
 * healthy in the first place.
 *
 * A rollout in progress (`status.updatedReplicas < status.replicas`, or the controller has
 * not yet observed the latest spec generation) produces the exact same per-container symptom
 * — old pods still running the old image — as a genuinely stuck rollout. Attributing that to
 * `revision` rather than `drift` is what keeps "a rolling update in flight" from paging
 * anyone as "the image is stuck".
 *
 * Which pods count as this Deployment's is decided by the owner chain (`ownership.index`),
 * never by `spec.selector`. When that index could not be built — the ReplicaSet read failed
 * or came back short — there is NO fallback: the drift verdict becomes unknown
 * (`ownerResolution: 'unavailable'`, empty detail arrays, `drifted: false`), because falling
 * back to selector matching would reinstate the false positives while looking green.
 *
 * @param {object} dep
 * @param {object[]} pods
 * @param {{index: Map<string,string>|null, reason?: string|null}} [ownership]
 */
function deploymentRolloutTruth(dep, pods, ownership = { index: null, reason: null }) {
  const status = dep.status || {};
  const meta = dep.metadata || {};
  const available = (status.conditions || []).some(c => c.type === 'Available' && c.status === 'True');
  const revisionInProgress = (status.updatedReplicas || 0) < (status.replicas || 0)
    || meta.generation !== status.observedGeneration;

  const specContainers = ((dep.spec && dep.spec.template && dep.spec.template.spec && dep.spec.template.spec.containers) || []);
  const namespace = meta.namespace;
  const ownerIndex = ownership && ownership.index instanceof Map ? ownership.index : null;

  const base = {
    kind: 'Deployment',
    name: meta.name,
    namespace,
    available,
    revisionInProgress
  };

  if (!ownerIndex) {
    return {
      ...base,
      ownerResolution: 'unavailable',
      ownerResolutionReason: (ownership && ownership.reason) || null,
      drifted: false,
      driftDetails: [],
      revisionDetails: [],
      uncomparableImages: 0,
      uncomparableDetails: []
    };
  }

  const ownedPods = pods.filter(p => {
    const owner = deploymentOwnerOfPod(p, ownerIndex);
    if (!owner) return false;
    if (owner.namespace !== namespace || owner.name !== meta.name) return false;
    // A pod already mid-termination commonly still shows the old image for a few seconds —
    // that is not a rollout finding, it is the old pod on its way out.
    return !p.metadata.deletionTimestamp;
  });

  const driftDetails = [];
  const revisionDetails = [];
  const uncomparableDetails = [];
  for (const pod of ownedPods) {
    const { mismatches, uncomparable } = podImageMismatches(specContainers, pod);
    if (uncomparable.length) uncomparableDetails.push({ pod: pod.metadata.name, containers: uncomparable });
    if (!mismatches.length) continue;
    const entry = { pod: pod.metadata.name, mismatches };
    if (revisionInProgress) revisionDetails.push(entry);
    else driftDetails.push(entry);
  }

  return {
    ...base,
    ownerResolution: 'owner-chain',
    ownerResolutionReason: null,
    drifted: driftDetails.length > 0,
    driftDetails,
    revisionDetails,
    // The third state, hoisted to the Deployment entry so a caller drawing a three-way verdict
    // (drifted / clean / not comparable) reads one number instead of walking the details. A
    // clean verdict is `drifted: false` AND `uncomparableImages === 0`; anything above 0 means
    // at least one container could not be compared at all, and no restart can change that.
    uncomparableImages: uncomparableDetails.reduce((n, d) => n + d.containers.length, 0),
    uncomparableDetails
  };
}

/**
 * E2, StatefulSet. `currentRevision === updateRevision` and NOTHING else — a StatefulSet
 * publishes no `Available` condition at all, so gating this on one (as the Deployment check
 * does) makes the whole check permanently unfireable for every StatefulSet in the fleet: the
 * gate condition can never become true, so a genuinely stuck StatefulSet rollout would never
 * be reported.
 */
function statefulSetRolloutTruth(sts) {
  const status = sts.status || {};
  const meta = sts.metadata || {};
  // Absent on a StatefulSet that has never been updated since creation — nothing stale to
  // detect yet, so rollout is current by definition.
  const current = !status.currentRevision || !status.updateRevision
    || status.currentRevision === status.updateRevision;
  return { kind: 'StatefulSet', name: meta.name, namespace: meta.namespace, current };
}

/**
 * E3. Deployment only, and specifically the case that E2's own gates rule OUT of being a
 * rollout problem: Available AND rollout finished (no revision skew) AND still short of the
 * desired count. A Deployment mid-rollout is expected to be temporarily under capacity —
 * that is what E2's `revisionInProgress` already names — so this check must not double-report it.
 */
function deploymentUnderCapacity(dep, rolloutTruth) {
  const status = dep.status || {};
  const spec = dep.spec || {};
  const desired = spec.replicas === undefined ? 1 : spec.replicas;
  const ready = status.readyReplicas || 0;
  const finished = rolloutTruth.available && !rolloutTruth.revisionInProgress;
  return finished && ready < desired
    ? { name: dep.metadata.name, namespace: dep.metadata.namespace, desired, ready }
    : null;
}

/**
 * E4. Everything comes from the DaemonSet's own status — no node read needed.
 *
 * `desiredNumberScheduled === 0` means this DaemonSet's nodeSelector/affinity/taints
 * currently match no node in the cluster. That is a calm, valid state (a GPU-only DaemonSet
 * on a fleet with no GPU nodes, say) — reporting it as "broken" would be indistinguishable
 * from a genuinely misconfigured DaemonSet and would page someone for nothing.
 *
 * `stuckRollout` is gated on `observedGeneration === metadata.generation`: without that gate,
 * a DaemonSet whose spec was JUST edited and has not been reconciled yet — a state that lasts
 * milliseconds in a healthy cluster — reads identically to a rollout that has been stuck for
 * a week, because in both cases `updatedNumberScheduled < desiredNumberScheduled` momentarily.
 */
function daemonSetCoverage(obj) {
  const status = obj.status || {};
  const meta = obj.metadata || {};
  const desiredNumberScheduled = status.desiredNumberScheduled || 0;
  const numberAvailable = status.numberAvailable || 0;
  const updatedNumberScheduled = status.updatedNumberScheduled || 0;
  const numberMisscheduled = status.numberMisscheduled || 0;
  const numberReady = status.numberReady || 0;

  const targetsNoNodes = desiredNumberScheduled === 0;
  const reconciled = meta.generation === status.observedGeneration;
  const stuckRollout = !targetsNoNodes && reconciled && updatedNumberScheduled < desiredNumberScheduled;
  const underCovered = !targetsNoNodes && numberAvailable < desiredNumberScheduled;

  return {
    name: meta.name,
    namespace: meta.namespace,
    desiredNumberScheduled,
    numberAvailable,
    updatedNumberScheduled,
    numberMisscheduled,
    numberReady,
    targetsNoNodes,
    stuckRollout,
    underCovered
  };
}

/**
 * E5. Services with zero ready endpoints, joined to EndpointSlices strictly namespace/name
 * scoped — via the `kubernetes.io/service-name` label on a slice that already lives in that
 * service's own namespace. Joining by name alone would cross-match `payments/api` against a
 * same-named `staging/api` in a different namespace, which is not the same service at all.
 *
 * A Service can legitimately own MULTIPLE slices for the same address type (the default
 * max-endpoints-per-slice is 100, and dual-stack services get one slice per family), so every
 * matching slice's ready count is summed, never just the first one found.
 *
 * `addressType` is filtered to IPv4 only — this collector does not yet present IPv6 or FQDN
 * endpoints, and folding those counts into the IPv4 total would misrepresent an IPv6-only
 * service's real (non-zero) endpoint count as zero.
 *
 * An `endpoint.conditions.ready` of `undefined` counts as ready, per the API's own documented
 * default (the condition is only written when known to be false) — treating "not stated" as
 * "not ready" would report every EndpointSlice from a Kubernetes version that predates the
 * condition, or any slice a controller wrote without it, as entirely unready.
 */
function servicesWithZeroReadyEndpoints(services, slices) {
  const readyByServiceKey = new Map();
  for (const slice of slices) {
    if (slice.addressType !== 'IPv4') continue;
    const meta = slice.metadata || {};
    const serviceName = (meta.labels || {})['kubernetes.io/service-name'];
    if (!serviceName) continue;
    const key = `${meta.namespace}/${serviceName}`;
    const readyCount = (slice.endpoints || [])
      .filter(ep => !ep.conditions || ep.conditions.ready !== false)
      .reduce((n, ep) => n + ((ep.addresses || []).length || 1), 0);
    readyByServiceKey.set(key, (readyByServiceKey.get(key) || 0) + readyCount);
  }

  return services
    // ExternalName services are never backed by pods/endpoints by design — reporting them
    // as "zero ready endpoints" would be true of every single one of them, always, which is
    // not a finding.
    .filter(svc => (svc.spec && svc.spec.type) !== 'ExternalName')
    .map(svc => {
      const key = `${svc.metadata.namespace}/${svc.metadata.name}`;
      return { name: svc.metadata.name, namespace: svc.metadata.namespace, readyEndpoints: readyByServiceKey.get(key) || 0 };
    })
    .filter(s => s.readyEndpoints === 0);
}

/**
 * @param {{cluster: object, token: string, namespace?: string, listFn?: typeof list,
 *          callFn?: typeof call}} ctx
 */
async function collect({ cluster, token, namespace, listFn = list, callFn = call }) {
  const nsQuery = namespaceSegment(namespace);
  const baseCtx = { cluster, token };

  const [deploymentsResult, statefulSetsResult, daemonSetsResult, replicaSetsResult, podsResult, servicesResult, slicesResult] = await Promise.all([
    safeList(listFn, baseCtx, `/apis/apps/v1/${nsQuery}deployments`, 'deployments'),
    safeList(listFn, baseCtx, `/apis/apps/v1/${nsQuery}statefulsets`, 'statefulsets'),
    safeList(listFn, baseCtx, `/apis/apps/v1/${nsQuery}daemonsets`, 'daemonsets'),
    // Metadata only: `ownerReferences`, `name` and `namespace` are all this read needs, and
    // they all live under `metadata` — a ReplicaSet's spec carries a full pod template this
    // collector never looks at. Nothing outside `metadata` may be read off these items.
    safeList(
      listFn, { ...baseCtx, accept: METADATA_ONLY },
      `/apis/apps/v1/${nsQuery}replicasets`, 'replicasets'
    ),
    safeList(listFn, baseCtx, `/api/v1/${nsQuery}pods?limit=2000`, 'pods'),
    safeList(listFn, baseCtx, `/api/v1/${nsQuery}services`, 'services'),
    absentList(
      listFn, baseCtx, `/apis/${ENDPOINTSLICE_GROUP}/${ENDPOINTSLICE_VERSION}/${nsQuery}endpointslices`,
      'endpointslices',
      { group: ENDPOINTSLICE_GROUP, version: ENDPOINTSLICE_VERSION, callFn }
    )
  ]);

  const deployments = deploymentsResult.items;
  const statefulSets = statefulSetsResult.items;
  const daemonSets = daemonSetsResult.items;
  const pods = podsResult.items;
  const services = servicesResult.items;

  // EndpointSlices being merely empty (`absent: false`) is a true zero — nothing to serve.
  // EndpointSlices' own API group being unregistered cluster-wide (`absent: true`) is a
  // different, much louder fact: discovery itself is off, not "no slices exist right now" —
  // it must read as unavailable, never as the honest zero absentList would otherwise hand a
  // caller for a genuinely-optional CRD.
  const slicesMissingApi = slicesResult.absent === true;
  const slicesUnavailable = slicesResult.unavailable || slicesMissingApi;
  const slicesReason = slicesResult.unavailable ? slicesResult.reason : (slicesMissingApi ? 'MISSING_API' : null);
  const effectiveSlicesResult = { ...slicesResult, unavailable: slicesUnavailable, reason: slicesReason };

  // A degraded pod sweep is not "no crashloops" or "no under-capacity Deployments" — it is
  // "we don't know". Every E1-E5 verdict for this cluster rides on that one read, so a
  // failure of it must not let a downstream check quietly report a clean answer built on
  // fewer pods than the fleet actually has.
  const podsOk = !podsResult.unavailable;

  const crashLoops = podsOk ? pods.flatMap(p => crashLoopsForPod(p)) : [];

  // A pod-to-Deployment map built from a ReplicaSet list that failed, or that stopped at the
  // paging ceiling, would resolve some pods to no Deployment at all and silently UNDER-report
  // drift — a clean-looking verdict from an incomplete relation. Both cases therefore make the
  // drift verdict unknown rather than clean; `reason` says which.
  const rsOk = !replicaSetsResult.unavailable && !replicaSetsResult.truncated;
  const ownership = rsOk
    ? { index: replicaSetOwnerIndex(replicaSetsResult.items), reason: null }
    : { index: null, reason: replicaSetsResult.unavailable ? replicaSetsResult.reason : 'TRUNCATED' };

  const deploymentRollouts = podsOk ? deployments.map(d => deploymentRolloutTruth(d, pods, ownership)) : [];
  const statefulSetRollouts = podsOk ? statefulSets.map(statefulSetRolloutTruth) : [];

  const underCapacity = podsOk
    ? deployments
      .map((d, i) => deploymentUnderCapacity(d, deploymentRollouts[i]))
      .filter(Boolean)
    : [];

  // daemonSetCoverage needs no pod data at all, but the belt-and-braces rule in this
  // collector's brief is deliberately cluster-wide, not per-check: a caller that trusts a
  // clean E4 from a cluster whose pod sweep failed has no way to know the other four
  // checks (E1, E2, E3, E5) on the SAME response are silently empty rather than genuinely
  // clean, so E4 is gated the same way for consistency of the one `verdict` field below.
  const daemonSetCoverageItems = podsOk ? daemonSets.map(daemonSetCoverage) : [];

  const zeroEndpointServices = (podsOk && !slicesUnavailable)
    ? servicesWithZeroReadyEndpoints(services, slicesResult.items)
    : [];

  const unavailable = unavailableLabels([
    deploymentsResult, statefulSetsResult, daemonSetsResult, replicaSetsResult, podsResult, servicesResult, effectiveSlicesResult
  ]);
  const truncated = truncatedLabels([
    deploymentsResult, statefulSetsResult, daemonSetsResult, replicaSetsResult, podsResult, servicesResult, slicesResult
  ]);

  return {
    summary: {
      // 'ok' means every one of E1-E5 below reflects a real read; 'unknown' means the pod
      // sweep failed and every array is empty by construction, not by a clean fleet.
      verdict: podsOk ? 'ok' : 'unknown',
      crashLoops: crashLoops.length,
      // `null`, never 0, when the owner chain could not be resolved: every rollout below then
      // carries `ownerResolution: 'unavailable'` and no drift was evaluated at all. signals.js
      // stays silent on a null count, which is the correct amount to say about an unread fact.
      driftedDeployments: (podsOk && rsOk) ? deploymentRollouts.filter(r => r.drifted).length : null,
      // Explicit rather than silently skipped: these containers were LOOKED at and could not be
      // compared, which is a different fact from "no drift found". Same null-when-unread rule as
      // the count above.
      uncomparableImages: (podsOk && rsOk)
        ? deploymentRollouts.reduce((n, r) => n + r.uncomparableImages, 0)
        : null,
      staleStatefulSets: statefulSetRollouts.filter(r => !r.current).length,
      underCapacity: underCapacity.length,
      daemonSetsStuck: daemonSetCoverageItems.filter(d => d.stuckRollout).length,
      zeroEndpointServices: zeroEndpointServices.length,
      unavailable,
      truncated
    },
    crashLoops,
    rollouts: { deployments: deploymentRollouts, statefulSets: statefulSetRollouts },
    daemonSets: daemonSetCoverageItems,
    underCapacity,
    zeroEndpointServices
  };
}

export default {
  collect,
  crashLoopsForPod,
  normalizeImage,
  imageShortForm,
  isBareImageId,
  podImageMismatches,
  replicaSetOwnerIndex,
  deploymentOwnerOfPod,
  deploymentRolloutTruth,
  statefulSetRolloutTruth,
  deploymentUnderCapacity,
  daemonSetCoverage,
  servicesWithZeroReadyEndpoints
};
