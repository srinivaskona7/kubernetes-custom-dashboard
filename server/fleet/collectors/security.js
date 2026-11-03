/**
 * Security and Compliance posture collector.
 *
 * Checks:
 *   - NetworkPolicies (ingress/egress isolation)
 *   - Pod Security Standards enforcement
 *   - Pod container security context (non-root, privileged flags)
 *   - Secret Metadata (counts and type breakdown only — NEVER any secret values, completely public-safe)
 */
import k8sModule from '../k8s.js';
const { list, METADATA_ONLY } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels, isTruncated } = safeListModule;
// Generic label-map-vs-LabelSelector evaluation. Shared rather than re-implemented so the
// NetworkPolicy coverage below cannot disagree with the admission page about which pods a
// selector actually picks up.
import policyModule from './policy.js';
const { selectorMatches } = policyModule;
// The one rule for "is this a system/app namespace", shared with compliance.js so the two
// pages cannot contradict each other about the same cluster — they used to each hardcode
// their own list (24 vs 18 namespaces) and disagree.
import complianceModule from './compliance.js';
const { SYSTEM_NAMESPACES } = complianceModule;

/**
 * Which directions a NetworkPolicy actually governs.
 *
 * `spec.policyTypes` is optional, and its default is not "both" — the API server infers
 * `["Ingress"]`, plus `"Egress"` only when `spec.egress` is present. Treating an absent
 * `policyTypes` as both directions is the mistake that makes a cluster look egress-isolated
 * when nothing restricts egress at all, so the inference is written out rather than assumed.
 */
function policyDirections(np) {
  const spec = (np && np.spec) || {};
  if (Array.isArray(spec.policyTypes) && spec.policyTypes.length) return spec.policyTypes;
  const inferred = ['Ingress'];
  if (Array.isArray(spec.egress) && spec.egress.length) inferred.push('Egress');
  return inferred;
}

/** A LabelSelector with neither field set selects every pod in the namespace. */
function selectsAllPods(selector) {
  if (!selector) return true;
  const hasLabels = selector.matchLabels && Object.keys(selector.matchLabels).length > 0;
  const hasExprs = Array.isArray(selector.matchExpressions) && selector.matchExpressions.length > 0;
  return !hasLabels && !hasExprs;
}

/**
 * How completely one direction is covered in a namespace.
 *
 *   none    — no policy in the namespace names this direction, so it is unrestricted
 *   all     — at least one policy names it with an all-pods selector (the default-deny shape)
 *   partial — policies name it, but every one of them is pod-selective, so any pod outside
 *             those selectors is still unrestricted in this direction
 *
 * `partial` is deliberately not folded into `all`. "Has a NetworkPolicy" and "is isolated" are
 * different claims, and the first one rendered as a green pill is how an unprotected pod hides
 * behind a protected neighbour.
 */
function directionCoverage(nsPolicies, direction) {
  const governing = nsPolicies.filter(np => policyDirections(np).includes(direction));
  if (!governing.length) return 'none';
  return governing.some(np => selectsAllPods(np.spec && np.spec.podSelector)) ? 'all' : 'partial';
}

/**
 * How many containers either posture list will carry.
 *
 * The lists exist so that "9 Privileged" is something an operator can open rather than a dead
 * end, and a name-only row is cheap — but a cluster where every container fails the non-root
 * test would put thousands of rows on the wire for a page nobody scrolls that far down. Past
 * this ceiling the list is a sample and says so through `summary.truncated`; the counts beside
 * it stay the true totals.
 */
const CONTAINER_LIST_CAP = 200;

/**
 * Does this container avoid running as root?
 *
 * The one place the rule lives. The count and the list are derived from this same call, because
 * the two disagreeing is the failure that matters here: a list that re-implements the rule and
 * forgets the pod-level `runAsNonRoot` names containers that the number beside it considers
 * fine, and an operator has no way to tell which of the two lied.
 *
 * Note that a pod-level `runAsNonRoot: true` counts for every container in the pod, and that
 * `runAsUser: 0` is explicitly root — so it is root-capable, the same as saying nothing at all.
 */
function runsAsNonRoot(cSec, podSec) {
  return cSec.runAsNonRoot === true
    || (podSec && podSec.runAsNonRoot === true)
    || (cSec.runAsUser && cSec.runAsUser > 0);
}

/** Stable order between polls: namespace, then pod, then container. */
function byLocation(a, b) {
  return a.namespace.localeCompare(b.namespace)
    || a.pod.localeCompare(b.pod)
    || a.container.localeCompare(b.container);
}

/**
 * The Secret types worth naming on the posture page, counted with a field selector each.
 *
 * `type` is one of the two fields the apiserver indexes for Secrets (the other is
 * `metadata.name`), so each of these is a cheap server-side count rather than a client-side
 * tally over objects we had to download first. The list is the Kubernetes built-ins plus the
 * two this platform produces in bulk — Helm's release storage and Istio's root CA.
 */
const COUNTED_SECRET_TYPES = [
  'Opaque',
  'kubernetes.io/service-account-token',
  'kubernetes.io/dockercfg',
  'kubernetes.io/dockerconfigjson',
  'kubernetes.io/basic-auth',
  'kubernetes.io/ssh-auth',
  'kubernetes.io/tls',
  'bootstrap.kubernetes.io/token',
  'helm.sh/release.v1',
  'istio.io/ca-root'
];

/**
 * Count Secrets without ever fetching one.
 *
 * This page reports two things about Secrets and only two: how many there are, and how they
 * break down by type. It used to get both by listing every Secret object in the cluster —
 * measured at 1.2 MB gzipped and 4.3 s on platformsbx, and every byte of `data` came into
 * this process so that it could be counted and thrown away. That is the single most
 * sensitive read the dashboard makes, made for the least sensitive reason.
 *
 * Now the total comes from a metadata-only list (38 KB, 1.6 s) and each type from a
 * server-side field-selector count, all concurrent. No Secret value is ever transferred, so
 * the §16 rule that Secret data must not reach the browser is enforced a layer earlier than
 * serialization: there is nothing to strip.
 *
 * On honesty, which is the part a faster read can quietly break. A type whose count failed is
 * **omitted** from the distribution rather than reported as 0 — an absent key means "not
 * known", a 0 would mean "none exist". And `other` is only emitted when every counted type
 * succeeded *and* the total is known, because it is a subtraction: one failed count would
 * turn into a wrong number of mystery Secrets rather than a visibly missing one.
 */
async function collectSecrets(listFn, baseCtx) {
  const metaCtx = { ...baseCtx, accept: METADATA_ONLY };
  const [totalResult, ...typeResults] = await Promise.all([
    safeList(listFn, metaCtx, '/api/v1/secrets', 'secrets'),
    ...COUNTED_SECRET_TYPES.map(t => safeList(
      listFn,
      metaCtx,
      `/api/v1/secrets?fieldSelector=type%3D${encodeURIComponent(t)}`,
      `secrets[type=${t}]`
    ))
  ]);

  const distribution = {};
  let everyTypeCounted = true;
  let countedSum = 0;
  COUNTED_SECRET_TYPES.forEach((t, i) => {
    const r = typeResults[i];
    if (r.unavailable || r.truncated) { everyTypeCounted = false; return; }
    countedSum += r.items.length;
    // Zero is a real answer here — the read succeeded and found none — but a type nobody
    // uses is noise on the page, so only non-empty buckets are shown.
    if (r.items.length > 0) distribution[t] = r.items.length;
  });

  const totalKnown = !totalResult.unavailable && !totalResult.truncated;
  if (everyTypeCounted && totalKnown) {
    const other = totalResult.items.length - countedSum;
    if (other > 0) distribution.other = other;
  }

  return {
    totalResult,
    // Only worth reporting individually when the total itself arrived. A denial on Secrets
    // denies all eleven reads at once, and listing every bucket beside the parent turns one
    // missing fact into eleven rows that say the same thing. When the parent failed, its own
    // label already says the section is unknown.
    typeResults: totalKnown ? typeResults : [],
    distribution,
    // Surfaced so the UI can say the breakdown is partial instead of implying it is complete.
    distributionComplete: everyTypeCounted && totalKnown
  };
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list}} ctx
 * @returns {Promise<object>}
 */
async function collect({ cluster, token, listFn = list }) {
  const baseCtx = { cluster, token };

  const [namespacesResult, networkpoliciesResult, pods, secretPosture, serviceaccountsResult] = await Promise.all([
    safeList(listFn, baseCtx, '/api/v1/namespaces', 'namespaces'),
    safeList(listFn, baseCtx, '/apis/networking.k8s.io/v1/networkpolicies', 'networkpolicies'),
    // Pods are core fleet health, not an optional posture signal (see security-context audit
    // below): a cluster this token cannot list pods on is broken, not partially informative,
    // so this call is deliberately left outside safeList and still fails loudly.
    listFn({ ...baseCtx, path: '/api/v1/pods?limit=1500' }),
    collectSecrets(listFn, baseCtx),
    safeList(listFn, baseCtx, '/api/v1/serviceaccounts', 'serviceaccounts')
  ]);
  const namespaces = namespacesResult.items;
  const networkpolicies = networkpoliciesResult.items;
  const secretsResult = secretPosture.totalResult;
  const serviceaccounts = serviceaccountsResult.items;
  // The pod audit bypasses safeList, so its ceiling flag has to be picked up by hand. Not a
  // safeList result — it carries no `items`, only the one field `truncatedLabels` reads.
  const podsTruncation = { label: 'pods', truncated: isTruncated(pods) };

  // Namespaces with NetworkPolicies
  const nsWithNetPol = new Set(networkpolicies.map(np => np.metadata.namespace));
  const appNamespaces = namespaces.filter(ns => {
    const name = ns.metadata.name;
    return !SYSTEM_NAMESPACES.has(name) && !name.startsWith('kube-');
  });

  const podsByNamespace = new Map();
  for (const pod of pods) {
    const ns = pod.metadata && pod.metadata.namespace;
    if (!ns) continue;
    if (!podsByNamespace.has(ns)) podsByNamespace.set(ns, []);
    podsByNamespace.get(ns).push(pod);
  }

  const policiesByNamespace = new Map();
  for (const np of networkpolicies) {
    const ns = np.metadata && np.metadata.namespace;
    if (!ns) continue;
    if (!policiesByNamespace.has(ns)) policiesByNamespace.set(ns, []);
    policiesByNamespace.get(ns).push(np);
  }

  const netPolAudit = appNamespaces.map(ns => {
    const name = ns.metadata.name;
    const nsPolicies = policiesByNamespace.get(name) || [];
    const nsPods = podsByNamespace.get(name) || [];
    return {
      namespace: name,
      hasNetworkPolicy: nsWithNetPol.has(name),
      policyCount: nsPolicies.length,
      // A floor when the pod read hit its ceiling — see `podsTruncation`.
      podsObserved: nsPods.length,
      ingress: directionCoverage(nsPolicies, 'Ingress'),
      egress: directionCoverage(nsPolicies, 'Egress'),
      // Pods in this namespace that no NetworkPolicy in it selects at all. These are the
      // exceptions the policy count hides: "4 Policies" on a namespace reads as covered, and
      // stays green, while the three pods none of those four selectors reach are wide open.
      unselectedPods: nsPolicies.length === 0
        ? nsPods.length
        : nsPods.filter(p => !nsPolicies.some(np =>
          selectorMatches((p.metadata && p.metadata.labels) || {}, np.spec && np.spec.podSelector))).length
    };
  });

  // Pod Security Audit (Checking non-root, privileged flags)
  //
  // The two name lists are built in this same walk deliberately: they cost no extra cluster
  // read and no extra RBAC rule, because every fact they carry — namespace, pod name, container
  // name — is already in the pod objects the counts are computed from. That is load-bearing.
  // Fetching them separately would add a second pod list to the most expensive read on the page.
  //
  // Each entry carries those three names and nothing else. No image, no env, no securityContext
  // values: the classification happened here, and what the browser needs is the identity of the
  // container so an operator can go and look at it.
  let totalContainers = 0;
  let nonRootContainers = 0;
  let privilegedContainers = 0;
  const privilegedFound = [];
  const rootCapableFound = [];

  for (const pod of pods) {
    // Every container that runs in this pod, not just the long-lived ones. An initContainer runs
    // with its own securityContext before the app starts, and a privileged one is exactly as much
    // host access as a privileged app container — walking `spec.containers` alone rendered it as
    // "0 Privileged". `ephemeralContainers` are debug attachments and carry the same risk.
    const containers = [
      ...((pod.spec && pod.spec.containers) || []),
      ...((pod.spec && pod.spec.initContainers) || []),
      ...((pod.spec && pod.spec.ephemeralContainers) || [])
    ];
    const podSec = pod.spec && pod.spec.securityContext;
    const meta = pod.metadata || {};
    for (const c of containers) {
      totalContainers++;
      const cSec = c.securityContext || {};
      const where = { namespace: meta.namespace || '', pod: meta.name || '', container: c.name || '' };
      if (cSec.privileged) {
        privilegedContainers++;
        privilegedFound.push(where);
      }
      if (runsAsNonRoot(cSec, podSec)) {
        nonRootContainers++;
      } else {
        rootCapableFound.push(where);
      }
    }
  }

  // Sort before capping, so the cap keeps the same window between polls rather than whichever
  // pods the apiserver happened to page first.
  privilegedFound.sort(byLocation);
  rootCapableFound.sort(byLocation);
  const privilegedContainerList = privilegedFound.slice(0, CONTAINER_LIST_CAP);
  const rootCapableContainerList = rootCapableFound.slice(0, CONTAINER_LIST_CAP);
  // Same shape and same channel as `podsTruncation`: a list cut short is a sample of a real
  // population, not a failed read, so it rides in `truncated` and never in `unavailable`. The
  // counts in `summary` are the full totals either way — a capped list must never shrink one.
  const privilegedTruncation = {
    label: 'containers[privileged]',
    truncated: privilegedFound.length > CONTAINER_LIST_CAP
  };
  const rootCapableTruncation = {
    label: 'containers[root-capable]',
    truncated: rootCapableFound.length > CONTAINER_LIST_CAP
  };

  // Secret metadata only — counts and a type breakdown, never a value. Both are computed by
  // `collectSecrets` from metadata-only and field-selector reads, so no Secret body was
  // fetched to produce them.
  const secretTypes = secretPosture.distribution;

  // The fraction of app namespaces holding at least one NetworkPolicy. `null`, never 100, when
  // there were no app namespaces to divide by: a cluster nothing was audited on used to render a
  // full green bar. Clamped as well, so no arithmetic here can hand the UI a width above 100.
  const safeIsolationScore = appNamespaces.length > 0
    ? Math.min(100, Math.max(0, Math.round((netPolAudit.filter(a => a.hasNetworkPolicy).length / appNamespaces.length) * 100)))
    : null;

  // Every plain-text consumer (the markdown /report, a CSV export) interpolates the score into a
  // sentence, and `${null}%` renders the literal string `null%` — a figure that claims nonsense.
  // The already-formatted string is therefore part of the contract, so no renderer has to know
  // the field is nullable. It is never a bare number with a `%` glued on by the caller.
  const isolationScoreText = safeIsolationScore === null
    ? 'not applicable (no app namespaces)'
    : `${safeIsolationScore}%`;

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    summary: {
      totalNamespaces: namespaces.length,
      appNamespacesAudited: appNamespaces.length,
      networkPolicyProtectedNamespaces: netPolAudit.filter(a => a.hasNetworkPolicy).length,
      // Deliberately narrower than `networkPolicyProtectedNamespaces`, and reported beside it:
      // "has a NetworkPolicy" is what the score above counts, and it is the weaker claim. This
      // counts the namespaces where both directions are covered by an all-pods selector — the
      // shape that actually denies an unlabelled pod.
      networkPolicyFullyIsolatedNamespaces: netPolAudit.filter(a => a.ingress === 'all' && a.egress === 'all').length,
      networkPolicyIsolationScore: safeIsolationScore,
      // The same ratio, already rendered. Text consumers must print this and never build their own
      // percent string from the nullable number above.
      networkPolicyIsolationScoreText: isolationScoreText,
      totalNetworkPolicies: networkpolicies.length,
      totalPodsAudited: pods.length,
      totalContainers,
      nonRootContainers,
      privilegedContainers,
      totalSecretsCount: secretsResult.items.length,
      totalServiceAccounts: serviceaccounts.length,
      unavailable: unavailableLabels([
        namespacesResult,
        networkpoliciesResult,
        secretsResult,
        // A type count that was refused is reported by name, so a breakdown missing a bucket
        // reads as "this was not knowable" rather than as "there are none of those".
        ...secretPosture.typeResults,
        serviceaccountsResult
      ]),
      // Reads that answered but stopped at the client's paging ceiling. The counts above are
      // then floors; `networkPolicyIsolationScore` is worse than a floor, because a ratio over
      // the part of the fleet that arrived can move in either direction against the true one.
      truncated: truncatedLabels([
        namespacesResult,
        networkpoliciesResult,
        podsTruncation,
        privilegedTruncation,
        rootCapableTruncation,
        secretsResult,
        ...secretPosture.typeResults,
        serviceaccountsResult
      ])
    },
    networkPolicies: netPolAudit,
    // The containers behind the two numbers above, named so they cannot be mistaken for them:
    // `summary.privilegedContainers` is a count, `privilegedContainerList` is who. Capped at
    // CONTAINER_LIST_CAP, and `summary.truncated` names the list when it was.
    privilegedContainerList,
    rootCapableContainerList,
    secretTypeDistribution: secretTypes,
    // False when any bucket was refused or cut short: the named counts are still true, but
    // they do not add up to the total and the UI must not present them as a whole.
    secretTypeDistributionComplete: secretPosture.distributionComplete,
    collectedAt: new Date().toISOString()
  };
}

export default { collect, policyDirections, directionCoverage, selectsAllPods, CONTAINER_LIST_CAP };
