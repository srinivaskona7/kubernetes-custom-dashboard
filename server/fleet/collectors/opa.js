/**
 * OPA Gatekeeper inspection collector — read-only, and structurally incapable of anything else:
 * every function here takes a list result and returns a plain object. There is no `call` with a
 * method, no PATCH, no body.
 *
 * ## Why this is a separate collector from policy.js
 *
 * `policy.js` answers one question about Gatekeeper — "is admission actually enforced on this
 * cluster" — and to answer it, it already reads ConstraintTemplates and every Constraint under
 * them. It then throws almost all of that away, keeping a count and a set of actions, because a
 * fleet-wide verdict is all its callers wanted.
 *
 * This module keeps it. Same two reads, same primitives (imported from policy.js rather than
 * re-derived, so there is exactly one implementation of "which action governs admission" in the
 * repo), normalised into one policy row per Constraint with its match scope, its parameters, its
 * audit violations and a named reason when it enforces nothing.
 *
 * The alternative — widening `policy.js` — would make every consumer of the fleet-wide policy
 * summary pay for per-violation detail it never renders. `policy.js` stays the verdict; this is
 * the inspector, and it is fetched only when the OPA screen is open.
 *
 * ## What Gatekeeper actually tells us, and what it does not
 *
 * `Constraint.status` carries the AUDIT result: `totalViolations`, a `violations[]` array capped
 * by the audit pod's `--constraint-violations-limit` (20 on the reference cluster), and
 * `auditTimestamp`. `status.byPod[].enforced` says the constraint is loaded in each Gatekeeper
 * pod's OPA instance.
 *
 * None of that is an admission decision. An audit violation means "this object exists and would
 * fail the policy", which most often means it predates the policy or is excluded from the
 * webhook — not that any request was ever denied. Runtime denials live only in Gatekeeper's
 * Prometheus counters and in its log, when `--log-denies=true`. This module therefore never
 * reports a denial count; `decisions()` goes and finds out whether either source exists and says
 * so in words. See the note there.
 */
import YAML from 'yaml';
import k8sModule from '../k8s.js';
const { list, call } = k8sModule;
import cap from '../capability.js';
import safeListModule from './safe-list.js';
const { safeList, absentList, unavailableLabels, truncatedLabels } = safeListModule;
import policyModule from './policy.js';
const { constraintPlural, effectiveAdmissionActions, selectorMatches } = policyModule;
import helmModule from './helm.js';
const { maskValues } = helmModule;
import gkLibrary from './gatekeeper-library.js';

const TEMPLATES_GROUP = 'templates.gatekeeper.sh';
const TEMPLATES_VERSION = 'v1';
const CONSTRAINTS_GROUP = 'constraints.gatekeeper.sh';
const CONSTRAINTS_VERSION = 'v1beta1';

/** Same ceiling as policy.js: past this, a per-template constraint read is too many requests. */
const MAX_CONSTRAINT_TEMPLATES = 25;

/** Gatekeeper's own namespace, where its Deployments and metrics Service live. */
const GATEKEEPER_NAMESPACE = 'gatekeeper-system';
const GATEKEEPER_WEBHOOK_DEPLOYMENT = 'gatekeeper-controller-manager';
const GATEKEEPER_AUDIT_DEPLOYMENT = 'gatekeeper-audit';

/**
 * The four enforcement actions Gatekeeper defines, plus our own 'unknown'.
 *
 * `scoped` is deliberately absent: it is not an action, it is a redirection to
 * `scopedEnforcementActions`, which `effectiveAdmissionActions` (policy.js) already resolves.
 * A scoped constraint that names no admission enforcement point resolves to no action at all,
 * and lands here as 'unknown' — which is the truth: it does nothing at admission.
 */
const KNOWN_ACTIONS = new Set(['deny', 'warn', 'dryrun']);

/**
 * Category assignment, in the two deterministic forms and no other.
 *
 * The rule this table exists to enforce: a category must come from something the cluster
 * declares, never from words in a display name. "restrict-jenkins-deployer" contains no evidence
 * about what it restricts, and guessing 'Image provenance' from a substring would put a made-up
 * fact on the screen. So:
 *
 *   1. TEMPLATE_CATEGORIES — an explicit map, keyed by ConstraintTemplate name (which is the
 *      lowercased CRD kind, so it is stable and cluster-independent). Covers the upstream
 *      gatekeeper-library templates plus the templates on the reference cluster.
 *   2. KIND_CATEGORIES — the API kinds the Constraint's own `match.kinds` targets. Also
 *      declared, also exact.
 *
 * Anything else is 'Other', and `categorySource` says which of the three produced it so the UI
 * can show 'Other (uncategorised)' rather than implying a judgement was made.
 */
const TEMPLATE_CATEGORIES = {
  // security context / privilege
  k8spspprivilegedcontainer: 'Security context',
  k8spspallowprivilegeescalationcontainer: 'Security context',
  k8spspcapabilities: 'Security context',
  k8spsphostnamespace: 'Security context',
  k8spsphostnetworkingports: 'Security context',
  k8spsphostfilesystem: 'Security context',
  k8spspreadonlyrootfilesystem: 'Security context',
  k8spspallowedusers: 'Security context',
  k8spspseccomp: 'Security context',
  k8spspselinuxv2: 'Security context',
  k8spspprocmount: 'Security context',
  k8spspfsgroup: 'Security context',
  k8spspforbiddensysctls: 'Security context',
  k8spspautomountserviceaccounttokenpodenforcement: 'Security context',
  denyallowprivorrunasnonrootfalse: 'Security context',
  disallowprivilegedandhostnetwork: 'Security context',
  // resource requests and limits
  k8srequiredresources: 'Resource requests and limits',
  k8scontainerlimits: 'Resource requests and limits',
  k8scontainerrequests: 'Resource requests and limits',
  k8scontainerratio: 'Resource requests and limits',
  k8srequestslimitsratio: 'Resource requests and limits',
  // image provenance
  k8sallowedrepos: 'Image provenance',
  k8simagedigests: 'Image provenance',
  k8sdisallowedtags: 'Image provenance',
  k8simagepullpolicy: 'Image provenance',
  // networking
  k8spspallowedhostpaths: 'Storage',
  k8shttpsonly: 'Networking',
  k8sblockloadbalancer: 'Networking',
  k8sblocknodeport: 'Networking',
  k8suniqueingresshost: 'Networking',
  k8suniqueserviceselector: 'Networking',
  k8sexternalips: 'Networking',
  // labels and ownership
  k8srequiredlabels: 'Labels and ownership',
  k8srequiredannotations: 'Labels and ownership',
  k8srequiredprobes: 'Labels and ownership',
  k8sblockwildcardingress: 'Networking',
  // storage
  k8spersistentvolumeclaimstorageclass: 'Storage',
  k8sstorageclass: 'Storage',
  k8sblockephemeralstorage: 'Storage'
};

/** Kinds → category, used only when the template name is not in the explicit map. */
const KIND_CATEGORIES = {
  NetworkPolicy: 'Networking',
  Ingress: 'Networking',
  Service: 'Networking',
  Gateway: 'Networking',
  VirtualService: 'Networking',
  APIRule: 'Networking',
  PersistentVolumeClaim: 'Storage',
  PersistentVolume: 'Storage',
  StorageClass: 'Storage',
  VolumeSnapshot: 'Storage'
};

const CATEGORIES = [
  'Security context',
  'Resource requests and limits',
  'Image provenance',
  'Networking',
  'Labels and ownership',
  'Storage',
  'Other'
];

// --------------------------------------------------------------------------------------
// normalisation
// --------------------------------------------------------------------------------------

/**
 * The plain-language purpose of a policy, and where it came from.
 *
 * Priority order, exactly as specified, and the last rung is deliberately a sentence that
 * asserts nothing beyond the identity we actually read: "Validates <kinds> using <Template>".
 * There is no rung that reads the name and guesses an intent — a wrong purpose on a security
 * screen is worse than a plain one, because the operator has no way to tell it is invented.
 *
 * @returns {{text: string, source: 'annotation'|'template-annotation'|'mapping'|'identity'}}
 */
function describe({ constraint, template, targetKinds }) {
  const cAnn = (constraint.metadata && constraint.metadata.annotations) || {};
  const tAnn = (template.metadata && template.metadata.annotations) || {};

  // Gatekeeper's own documented description annotations first, then the generic ones. Not
  // `last-applied-configuration`, which is a serialised spec rather than prose.
  const KEYS = [
    'metadata.gatekeeper.sh/description',
    'metadata.gatekeeper.sh/title',
    'description',
    'kubernetes.io/description',
    'policies.kyma-project.io/description'
  ];
  for (const key of KEYS) {
    if (typeof cAnn[key] === 'string' && cAnn[key].trim()) {
      return { text: cAnn[key].trim(), source: 'annotation' };
    }
  }
  for (const key of KEYS) {
    if (typeof tAnn[key] === 'string' && tAnn[key].trim()) {
      return { text: tAnn[key].trim(), source: 'template-annotation' };
    }
  }

  const mapped = KNOWN_PURPOSES[template.metadata && template.metadata.name];
  if (mapped) return { text: mapped, source: 'mapping' };

  const kinds = [...new Set(targetKinds.flatMap(t => t.kinds))];
  const kindText = kinds.length === 0
    ? 'no configured kinds'
    : kinds.length <= 4
      ? kinds.join(', ')
      : `${kinds.slice(0, 4).join(', ')} and ${kinds.length - 4} more kinds`;
  const templateKind = (template.spec && template.spec.crd && template.spec.crd.spec
    && template.spec.crd.spec.names && template.spec.crd.spec.names.kind)
    || (template.metadata && template.metadata.name)
    || 'an unnamed ConstraintTemplate';
  return { text: `Validates ${kindText} using ${templateKind}`, source: 'identity' };
}

/**
 * Maintained descriptions for templates whose intent is known from their upstream definition or
 * from this platform's own policy set. Keyed by ConstraintTemplate name, never by a substring.
 * Every entry here is a claim about what the Rego does, so an entry may only be added by reading
 * that Rego — this is not a place to paraphrase a name.
 */
const KNOWN_PURPOSES = {
  denyallowprivorrunasnonrootfalse:
    'Rejects workloads whose containers request privilege escalation or set runAsNonRoot to false.',
  disallowprivilegedandhostnetwork:
    'Rejects workloads that run privileged containers or attach to the host network namespace.',
  restrictjenkinsdeployer:
    'Restricts which subjects may be granted the listed roles, so the Jenkins deployer ServiceAccount cannot be bound to cluster-admin.',
  k8srequiredresources: 'Requires containers to declare CPU and memory requests and limits.',
  k8sallowedrepos: 'Requires container images to come from an allowed registry prefix.',
  k8srequiredlabels: 'Requires the listed labels to be present on the targeted resources.',
  k8spspprivilegedcontainer: 'Rejects containers running in privileged mode.',
  k8shttpsonly: 'Requires Ingress objects to serve TLS only.',
  k8sblocknodeport: 'Rejects Services of type NodePort.'
};

/** `match.kinds` normalised so an absent apiGroups/kinds reads as the wildcard it means. */
function targetKindsOf(match) {
  const kinds = (match && Array.isArray(match.kinds)) ? match.kinds : [];
  return kinds.map(k => ({
    apiGroups: Array.isArray(k.apiGroups) && k.apiGroups.length ? k.apiGroups : ['*'],
    kinds: Array.isArray(k.kinds) && k.kinds.length ? k.kinds : ['*']
  }));
}

/**
 * Which namespaces a Constraint's match block reaches, evaluated against the real namespace list.
 *
 * `evaluable: false` when the namespace read failed — the scope is then genuinely unknown, and
 * every count derived from it stays null rather than becoming a confident number over an empty
 * list. Same rule as policy.js's webhook namespace scope, for the same reason.
 */
function namespaceScopeOf(match, namespacesResult) {
  const included = (match && Array.isArray(match.namespaces)) ? match.namespaces : null;
  const excluded = (match && Array.isArray(match.excludedNamespaces)) ? match.excludedNamespaces : null;
  const selector = (match && match.namespaceSelector) || null;

  if (namespacesResult.unavailable) {
    return {
      included, excluded, selector,
      evaluable: false,
      scope: 'unknown',
      matchedNamespaceCount: null,
      totalNamespaces: null,
      matchedNamespaces: null
    };
  }

  const all = namespacesResult.items.map(ns => ({
    name: ns.metadata.name,
    labels: (ns.metadata && ns.metadata.labels) || {}
  }));
  // Gatekeeper's own precedence: an explicit `namespaces` list wins as an allowlist,
  // `excludedNamespaces` removes, and `namespaceSelector` filters what is left. A prefix
  // wildcard (`kube-*`) is legal in both lists.
  const matched = all
    .filter(ns => (included ? included.some(p => nameMatches(ns.name, p)) : true))
    .filter(ns => (excluded ? !excluded.some(p => nameMatches(ns.name, p)) : true))
    .filter(ns => selectorMatches(ns.labels, selector));

  const constrained = Boolean(included || excluded || selector);
  return {
    included, excluded, selector,
    evaluable: true,
    scope: constrained ? 'selector' : 'cluster-wide',
    matchedNamespaceCount: matched.length,
    totalNamespaces: all.length,
    matchedNamespaces: matched.map(ns => ns.name).sort()
  };
}

/** Gatekeeper allows a single trailing `*` in a namespace match entry. */
function nameMatches(name, pattern) {
  if (typeof pattern !== 'string') return false;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * The action that governs this Constraint at admission, reduced to one word for display.
 *
 * `effectiveAdmissionActions` (policy.js) can return several — a scoped constraint with more
 * than one admission entry — so the reduction picks the strictest, because that is the one an
 * operator needs to know about: if any entry denies, a matching request is denied.
 */
function enforcementActionOf(constraint) {
  const actions = effectiveAdmissionActions(constraint).filter(a => KNOWN_ACTIONS.has(a));
  if (actions.includes('deny')) return 'deny';
  if (actions.includes('warn')) return 'warn';
  if (actions.includes('dryrun')) return 'dryrun';
  return 'unknown';
}

/**
 * Kind-derived categorisation requires UNANIMITY, and that is the whole subtlety here.
 *
 * The reference cluster's `restrictjenkinsdeployer` targets four RBAC kinds and NetworkPolicy.
 * Taking the first kind that happens to be in the table filed an RBAC policy under 'Networking'
 * on the strength of one kind out of five — deterministic, and wrong in the way that matters:
 * an operator filtering Networking would have been handed a policy about role bindings.
 *
 * So a mixed or partly-unmapped kind set is not evidence of a category, and falls through to
 * 'Other' with `categorySource: 'fallback'`, which the UI renders as "uncategorised" rather than
 * as a judgement. A policy is only filed by kind when every kind it targets agrees.
 */
function categoryOf(templateName, targetKinds) {
  const mapped = TEMPLATE_CATEGORIES[templateName];
  if (mapped) return { category: mapped, categorySource: 'mapping' };

  const kinds = [...new Set(targetKinds.flatMap(t => t.kinds))].filter(k => k !== '*');
  const categories = new Set(kinds.map(k => KIND_CATEGORIES[k] || null));
  if (kinds.length > 0 && categories.size === 1 && !categories.has(null)) {
    return { category: [...categories][0], categorySource: 'target-kinds' };
  }
  return { category: 'Other', categorySource: 'fallback' };
}

/**
 * Every reason this policy does not deliver the enforcement its existence implies.
 *
 * A list, not a boolean, and never derived from a violation count: zero violations is the
 * outcome a working deny policy produces, so treating it as evidence of ineffectiveness would
 * flag exactly the policies that are doing their job. Every entry below is a structural fact
 * read off the objects — a missing instance, a dry-run action, an unreconciled status, a
 * webhook that is not there.
 *
 * @param {object} args
 * @param {boolean} args.webhookActive  is Gatekeeper's own validating webhook present AND
 *   backed by a ready endpoint? Passed in from the shared policy verdict rather than
 *   recomputed, so the two screens can never disagree about it.
 */
function ineffectiveReasons({ constraint, template, enforcementAction, targetKinds, namespaceScope, webhookActive, auditFreshness, constraintsUnavailable, auditState }) {
  const reasons = [];

  if (constraintsUnavailable) {
    reasons.push({
      code: 'CONSTRAINTS_UNREADABLE',
      text: 'The Constraint instances under this template could not be read, so enforcement cannot be confirmed.'
    });
  }
  if (!constraint) {
    reasons.push({
      code: 'NO_CONSTRAINT_INSTANCES',
      text: 'The ConstraintTemplate is installed but no Constraint instantiates it, so it evaluates nothing.'
    });
    // Nothing below applies without an instance to inspect.
    return reasons;
  }

  const templateErrors = ((template.status && template.status.byPod) || [])
    .flatMap(p => (Array.isArray(p.errors) ? p.errors : []))
    .map(e => (e && (e.message || e.code)) || null)
    .filter(Boolean);
  if (templateErrors.length > 0) {
    reasons.push({
      code: 'TEMPLATE_ERROR',
      text: `The ConstraintTemplate failed to compile: ${templateErrors[0]}`
    });
  }

  if (enforcementAction === 'dryrun') {
    reasons.push({
      code: 'DRY_RUN',
      text: 'enforcementAction is dryrun: violations are recorded by audit and nothing is ever rejected.'
    });
  }
  if (enforcementAction === 'unknown') {
    const raw = (constraint.spec && constraint.spec.enforcementAction) || 'deny';
    reasons.push({
      code: 'UNSUPPORTED_ACTION',
      text: raw === 'scoped'
        ? 'enforcementAction is scoped but no scopedEnforcementActions entry names the admission webhook, so this constraint has no effect at admission.'
        : `enforcementAction "${raw}" is not one of deny, warn or dryrun, so its admission behaviour cannot be determined.`
    });
  }

  const byPod = (constraint.status && constraint.status.byPod) || [];
  if (byPod.length === 0) {
    reasons.push({
      code: 'NOT_RECONCILED',
      text: 'No Gatekeeper pod reports this constraint in status.byPod, so it has not been loaded yet.'
    });
  } else if (byPod.every(p => p && p.enforced === false)) {
    reasons.push({
      code: 'NOT_ENFORCED_BY_PODS',
      text: 'Every Gatekeeper pod reports enforced: false for this constraint.'
    });
  }

  if (targetKinds.length === 0) {
    reasons.push({
      code: 'NO_TARGET_KINDS',
      text: 'match.kinds is empty, so the constraint targets nothing.'
    });
  }
  if (namespaceScope.evaluable && namespaceScope.matchedNamespaceCount === 0) {
    reasons.push({
      code: 'EMPTY_NAMESPACE_SCOPE',
      text: 'The namespace match resolves to none of the namespaces on this cluster.'
    });
  }

  if (webhookActive === false) {
    reasons.push({
      code: 'WEBHOOK_INACTIVE',
      text: "Gatekeeper's validating webhook is absent or has no ready backend, so no constraint is consulted at admission."
    });
  }
  if (auditFreshness.state === 'never') {
    reasons.push({
      code: 'AUDIT_NEVER_RAN',
      text: 'status.auditTimestamp is absent: the audit controller has not evaluated this constraint, so its violation count is not a zero.'
    });
  }

  // Audit disabled and audit stale are two different facts about the same number and must not
  // collapse into one reason: 'disabled' means the count can never move again, 'stale' means it
  // moved once and stopped. A caller that cannot read the audit Deployment passes neither.
  if (auditState === 'disabled') {
    reasons.push({
      code: 'AUDIT_DISABLED',
      text: 'Gatekeeper runs no audit controller (absent, or scaled to zero), so this violation count cannot change and is not a zero.'
    });
  } else if (auditState === 'not-ready') {
    reasons.push({
      code: 'AUDIT_NOT_READY',
      text: 'The Gatekeeper audit controller exists but has no ready replica, so violation counts are not being refreshed.'
    });
  } else if (auditFreshness.state === 'stale') {
    reasons.push({
      code: 'AUDIT_STALE',
      text: `The last audit of this constraint was ${auditFreshness.ageSeconds}s ago, well past the audit interval, so its violation count is out of date.`
    });
  }

  return reasons;
}

/**
 * How old the audit result is, and whether it is old enough to distrust.
 *
 * The threshold follows Gatekeeper's own `--audit-interval` (60s by default) when the caller has
 * read it off the audit Deployment: ten intervals, floored at five minutes so a one-second
 * interval cannot make every constraint look stale. Without that argument — the audit Deployment
 * was unreadable — it falls back to a fixed generous window, where 'stale' means "much older than
 * any reasonable interval" rather than "one cycle late".
 */
const AUDIT_STALE_AFTER_MS = 30 * 60 * 1000;
const AUDIT_STALE_INTERVAL_MULTIPLE = 10;
const AUDIT_STALE_FLOOR_MS = 5 * 60 * 1000;

function auditStaleAfterMs(intervalSeconds) {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return AUDIT_STALE_AFTER_MS;
  return Math.max(AUDIT_STALE_FLOOR_MS, intervalSeconds * 1000 * AUDIT_STALE_INTERVAL_MULTIPLE);
}

function auditFreshnessOf(auditTimestamp, now, intervalSeconds) {
  const thresholdMs = auditStaleAfterMs(intervalSeconds);
  const thresholdSeconds = Math.round(thresholdMs / 1000);
  if (!auditTimestamp) return { state: 'never', at: null, ageSeconds: null, thresholdSeconds };
  const at = Date.parse(auditTimestamp);
  if (!Number.isFinite(at)) return { state: 'unknown', at: auditTimestamp, ageSeconds: null, thresholdSeconds };
  const ageMs = now - at;
  return {
    state: ageMs > thresholdMs ? 'stale' : 'fresh',
    at: new Date(at).toISOString(),
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    thresholdSeconds
  };
}

/**
 * One audit violation, normalised.
 *
 * `source` is always 'gatekeeper-audit' here and the field exists so a violation from a metric
 * or a decision log — if a cluster ever exposes one — can join the same table without the UI
 * having to guess which kind it is holding. Nothing in this function can produce another value;
 * that is intentional, because nothing in this collector reads another source.
 *
 * The `message` is Gatekeeper's own rendered denial text. It is passed through as-is except for
 * length: a Rego message can embed the object under review, and the whole point of the
 * `secrets never leave as values` rule is that no code path may relay object contents blindly.
 * A violation on a Secret carries its name and namespace, which are metadata, and its message,
 * which is truncated — never `data`, which this collector never reads.
 */
const MAX_VIOLATION_MESSAGE = 400;

function normaliseViolation({ raw, policyId, enforcementAction, category, auditAt, index }) {
  const kind = (raw && raw.kind) || 'Unknown';
  const namespace = (raw && raw.namespace) || null;
  const name = (raw && raw.name) || 'unknown';
  const message = typeof raw.message === 'string'
    ? (raw.message.length > MAX_VIOLATION_MESSAGE
        ? `${raw.message.slice(0, MAX_VIOLATION_MESSAGE - 1)}…`
        : raw.message)
    : '';
  return {
    // Stable across polls so a selected row survives a refetch: the identity of a violation is
    // (policy, object), not its position in the array. `index` only disambiguates the pathological
    // case of one policy reporting the same object twice.
    id: `${policyId}|${kind}/${namespace || '-'}/${name}|${index}`,
    policyId,
    enforcementAction: (raw && raw.enforcementAction) || enforcementAction,
    category,
    message,
    group: (raw && raw.group) || '',
    version: (raw && raw.version) || '',
    kind,
    namespace,
    name,
    // Gatekeeper does not report when it first saw a violation, only the audit cycle that
    // recorded this one. Reporting `firstSeen` would be an invention, so both timestamps are
    // the audit time and the UI labels them as such.
    firstSeen: null,
    lastSeen: auditAt,
    source: 'gatekeeper-audit'
  };
}

// --------------------------------------------------------------------------------------
// collect
// --------------------------------------------------------------------------------------

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, callFn?: typeof call,
 *          now?: number}} ctx
 */
async function collect({ cluster, token, listFn = list, callFn = call, now = Date.now() }) {
  const baseCtx = { cluster, token };

  const [templatesResult, namespacesResult, validatingWebhooksResult, endpointslicesResult, gatekeeperDeploymentsResult] = await Promise.all([
    absentList(listFn, baseCtx, `/apis/${TEMPLATES_GROUP}/${TEMPLATES_VERSION}/constrainttemplates`, 'constrainttemplates', {
      group: TEMPLATES_GROUP, version: TEMPLATES_VERSION, callFn
    }),
    safeList(listFn, baseCtx, '/api/v1/namespaces', 'namespaces'),
    safeList(listFn, baseCtx, '/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations', 'validatingwebhookconfigurations'),
    safeList(listFn, baseCtx, '/apis/discovery.k8s.io/v1/endpointslices', 'endpointslices'),
    // One extra namespace-scoped list, for the two facts the Overview header states about
    // Gatekeeper itself: which version is installed, and whether the audit controller is running
    // at all. Without it, "0 violations" cannot be distinguished from "the audit is switched off".
    safeList(listFn, baseCtx, `/apis/apps/v1/namespaces/${GATEKEEPER_NAMESPACE}/deployments`, 'gatekeeper deployments')
  ]);

  const runtime = gatekeeperRuntime(gatekeeperDeploymentsResult);

  const gatekeeper = installationState(templatesResult);

  const templateItems = templatesResult.unavailable ? [] : templatesResult.items;
  const overTemplateLimit = templateItems.length > MAX_CONSTRAINT_TEMPLATES;

  /** @type {Map<string, {items: any[], unavailable: boolean, label: string, truncated: boolean}>} */
  const constraintsByPlural = new Map();
  if (!templatesResult.unavailable && !overTemplateLimit) {
    const reads = await Promise.all(templateItems.map(async ct => {
      const plural = constraintPlural(ct);
      const result = await absentList(
        listFn, baseCtx, `/apis/${CONSTRAINTS_GROUP}/${CONSTRAINTS_VERSION}/${plural}`, `constraints:${plural}`,
        { group: CONSTRAINTS_GROUP, version: CONSTRAINTS_VERSION, callFn }
      );
      return [plural, result];
    }));
    for (const [plural, result] of reads) constraintsByPlural.set(plural, result);
  }

  const webhook = gatekeeperWebhookState(validatingWebhooksResult, endpointslicesResult);

  const policies = [];
  const violations = [];

  for (const template of templateItems) {
    const plural = constraintPlural(template);
    const constraintResult = constraintsByPlural.get(plural);
    const constraintsUnavailable = Boolean(constraintResult && constraintResult.unavailable);
    const instances = (constraintResult && !constraintResult.unavailable && constraintResult.items) || [];
    const templateName = (template.metadata && template.metadata.name) || plural || 'unknown';
    // Per template, not per Constraint: every instance of one template shares its Rego.
    const library = gkLibrary.libraryMatch(template);

    // A template with no instances is still a row: "declared, enforces nothing" is exactly the
    // state this screen exists to surface, and it has no Constraint to hang off.
    const rows = instances.length > 0 ? instances : [null];

    for (const constraint of rows) {
      const match = (constraint && constraint.spec && constraint.spec.match) || null;
      const targetKinds = targetKindsOf(match);
      const namespaceScope = namespaceScopeOf(match, namespacesResult);
      const { category, categorySource } = categoryOf(templateName, targetKinds);
      const constraintName = (constraint && constraint.metadata && constraint.metadata.name) || null;
      const id = `${templateName}/${constraintName || '(no instance)'}`;
      const enforcementAction = constraint ? enforcementActionOf(constraint) : 'unknown';
      const status = (constraint && constraint.status) || {};
      const audit = auditFreshnessOf(status.auditTimestamp, now, runtime.audit.intervalSeconds);

      const reasons = ineffectiveReasons({
        constraint, template, enforcementAction, targetKinds, namespaceScope,
        webhookActive: webhook.active, auditFreshness: audit, constraintsUnavailable,
        // Only claim the audit is off when the Deployment was actually readable; an unreadable
        // audit controller is a gap in our view, not a disabled audit.
        auditState: runtime.audit.state
      });

      const rawViolations = Array.isArray(status.violations) ? status.violations : [];
      const rowViolations = rawViolations.map((raw, index) => normaliseViolation({
        raw, policyId: id, enforcementAction, category, auditAt: audit.at, index
      }));
      violations.push(...rowViolations);

      // Gatekeeper caps `violations[]` at the audit pod's --constraint-violations-limit while
      // still reporting the true `totalViolations`. The two disagreeing is not an error, it is
      // the cap — and saying so is the difference between "20 violations" and "20 of 143 shown".
      const violationCount = Number.isFinite(status.totalViolations) ? status.totalViolations : null;
      const listTruncated = violationCount !== null && rowViolations.length < violationCount;

      policies.push({
        id,
        templateName,
        constraintName,
        displayName: constraintName || templateName,
        constraintKind: (template.spec && template.spec.crd && template.spec.crd.spec
          && template.spec.crd.spec.names && template.spec.crd.spec.names.kind) || null,
        purpose: describe({ constraint: constraint || {}, template, targetKinds }),
        library,
        enforcementAction,
        category,
        categorySource,
        status: policyStatus({ constraint, reasons, enforcementAction }),
        ineffectiveReasons: reasons,
        targetKinds,
        namespaceScope,
        // Parameters are policy configuration (allowed registries, required labels, replica
        // floors) and are passed through. Not a secret surface: a Constraint's spec is readable
        // by anyone who can read the constraint, and this collector never touches Secrets.
        parameters: (constraint && constraint.spec && constraint.spec.parameters) || null,
        enforcedByPods: ((constraint && constraint.status && constraint.status.byPod) || [])
          .map(p => ({ pod: p && p.id, enforced: p ? p.enforced === true : false })),
        violationCount,
        violationsShown: rowViolations.length,
        violationsTruncated: listTruncated,
        audit,
        sourceReferences: [
          { kind: 'ConstraintTemplate', namespace: null, name: templateName },
          ...(constraintName ? [{ kind: 'GatekeeperConstraint', namespace: null, name: constraintName, plural }] : [])
        ]
      });
    }
  }

  const readResults = [templatesResult, namespacesResult, validatingWebhooksResult, endpointslicesResult,
    gatekeeperDeploymentsResult, ...constraintsByPlural.values()];

  /**
   * What each OPA screen can answer, established from the reads that just happened.
   *
   * Five verdicts rather than one, because these five fail independently and each sends the
   * operator somewhere different: the inventory needs the ConstraintTemplate CRD, the violation
   * numbers need a running audit controller, the webhook screen needs
   * `validatingwebhookconfigurations` plus EndpointSlices, and coverage needs the namespace list.
   * A single page-level verdict would report the whole surface dead because one of the four was
   * refused — and, worse, would let a refused Constraint read pass as "no policies".
   *
   * Decision Activity is deliberately absent here: it is the one screen whose sources this
   * collector does not read, and `decisions()` states its own verdict.
   */
  const constraintReads = [...constraintsByPlural.values()];
  const capabilities = {
    policies: cap.fromReads({
      feature: 'OPA policy inventory',
      reads: [templatesResult, ...constraintReads],
      gotAnything: policies.length > 0,
      notInstalledCause: 'the Gatekeeper ConstraintTemplate CRD is not registered on this cluster'
    }),
    /**
     * Violation counts are a claim about *when* as much as *how much*. A disabled or unready audit
     * controller means the numbers cannot move; a stale one means they moved and stopped. Both are
     * reported as their own state, so nothing on the screen prints a frozen number as current.
     */
    violations: (() => {
      const fromRead = cap.fromReads({
        feature: 'Gatekeeper audit violations',
        reads: [templatesResult, ...constraintReads],
        gotAnything: policies.length > 0
      });
      if (fromRead.state !== 'available') return fromRead;
      if (runtime.audit.state === 'disabled') {
        return cap.notConfigured(
          'Gatekeeper audit violations',
          'this cluster runs no Gatekeeper audit controller, so no violation scan produces these counts',
          runtime.detail
        );
      }
      if (runtime.audit.state === 'not-ready') {
        return cap.stale(
          'Gatekeeper audit violations',
          'the Gatekeeper audit controller has no ready replica, so the counts below are not being refreshed',
          { auditState: runtime.audit.state }
        );
      }
      const stalest = policies
        .map(p => p.audit)
        .filter(a => a.state === 'stale')
        .sort((a, b) => (b.ageSeconds || 0) - (a.ageSeconds || 0))[0];
      if (stalest) {
        return cap.stale(
          'Gatekeeper audit violations',
          `the oldest constraint audit on this cluster ran ${stalest.ageSeconds}s ago, past the ${stalest.thresholdSeconds}s staleness threshold`,
          { ageSeconds: stalest.ageSeconds, thresholdSeconds: stalest.thresholdSeconds }
        );
      }
      return cap.available('Gatekeeper audit violations', { auditState: runtime.audit.state });
    })(),
    webhooks: cap.fromReads({
      feature: 'Admission webhook inventory',
      reads: [validatingWebhooksResult, endpointslicesResult],
      gotAnything: !validatingWebhooksResult.unavailable
    }),
    coverage: (() => {
      const fromRead = cap.fromReads({
        feature: 'Policy coverage',
        reads: [namespacesResult, templatesResult, ...constraintReads],
        gotAnything: policies.length > 0
      });
      if (fromRead.state !== 'available') return fromRead;
      // Readable, and still only partial by construction: applicability is computed from the
      // namespace list and each policy's match block, never by enumerating every object in the
      // cluster. Saying so is the difference between a coverage matrix and a coverage claim.
      return cap.capability({
        feature: 'Policy coverage',
        state: 'partial',
        cause:
          'applicable resources are derived from namespace scope and target kinds, not from an enumeration of every object in the cluster',
        extra: { reason: 'by-design' }
      });
    })(),
    runtime:
      runtime.audit.state === 'unreadable'
        ? cap.fromReads({
            feature: 'Gatekeeper runtime',
            reads: [gatekeeperDeploymentsResult],
            gotAnything: false
          })
        : runtime.audit.state === 'unknown'
          ? cap.unknown(
              'Gatekeeper runtime',
              `neither Gatekeeper Deployment is in the ${GATEKEEPER_NAMESPACE} namespace, so its version and audit state could not be established`,
              runtime.detail
            )
          : cap.available('Gatekeeper runtime', { auditState: runtime.audit.state })
  };

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    gatekeeper,
    // Gatekeeper's own version and audit-controller state. Separate from `gatekeeper`, which
    // answers "are the CRDs there": a cluster can have every CRD installed and no audit running.
    runtime,
    capabilities,
    webhook,
    summary: {
      ...counts(policies),
      policyCount: policies.length,
      templateCount: templateItems.length,
      // Over the template ceiling nothing was read, so every count above is about zero policies
      // rather than about a clean cluster. The flag is what stops the UI rendering that as good news.
      templateLimitExceeded: overTemplateLimit,
      templateLimit: MAX_CONSTRAINT_TEMPLATES,
      categories: categoryCounts(policies, violations),
      // Counted per template, not per Constraint row, so a template with three instances is one.
      // Needs only the template list, so it stays exact over the template ceiling, where only the
      // Constraint reads are skipped; a failed template read leaves `constrainttemplates` unavailable.
      library: libraryCounts(templatesResult.unavailable ? [] : templateItems),
      unavailable: unavailableLabels(readResults),
      truncated: truncatedLabels(readResults)
    },
    policies,
    violations,
    // Which upstream library templates this cluster runs, per Pod Security bundle. Empty when the
    // template list was not read, so the UI never draws "0 of 12" over a read that did not happen.
    library: {
      source: gkLibrary.CATALOGUE_SOURCE,
      bundles: templatesResult.unavailable || overTemplateLimit ? [] : gkLibrary.bundleCoverage(policies)
    },
    collectedAt: new Date().toISOString()
  };
}

/** library / modified / custom / behind counts over the templates themselves. */
function libraryCounts(templateItems) {
  const out = { library: 0, modified: 0, custom: 0, behind: 0 };
  for (const t of templateItems) {
    const m = gkLibrary.libraryMatch(t);
    out[m.state] += 1;
    if (m.behind === true) out.behind += 1;
  }
  return out;
}

/**
 * Is Gatekeeper installed at all — and if we cannot tell, which of the two reasons is it?
 *
 * The distinction the task calls out by name: a 404 on the ConstraintTemplate CRD means the
 * operator has not installed Gatekeeper, while a 403 means it may well be installed and this
 * token simply may not look. Those need opposite actions from the reader, so they get different
 * states rather than a shared "no data".
 */
function installationState(templatesResult) {
  if (templatesResult.unavailable) {
    return {
      installed: null,
      state: templatesResult.reason === 'FORBIDDEN' || templatesResult.reason === 'UNAUTHORIZED'
        ? 'forbidden'
        : 'unreadable',
      reason: templatesResult.reason,
      detail: templatesResult.detail
    };
  }
  if (templatesResult.items.length === 0) {
    // absentList's group probe is what makes this a fact rather than an inference.
    return {
      installed: templatesResult.absent === true ? false : null,
      state: templatesResult.absent === true ? 'absent' : 'no-templates',
      reason: null,
      detail: templatesResult.absentEvidence || null
    };
  }
  return { installed: true, state: 'installed', reason: null, detail: null };
}

const GATEKEEPER_WEBHOOK_NAME = 'validation.gatekeeper.sh';

/**
 * Gatekeeper's own validating webhook and whether it can currently do anything.
 *
 * `active: false` is only ever set on evidence — the webhook object is missing, or its Service
 * resolves to EndpointSlices whose every endpoint is explicitly not ready. A Service with no
 * matching slice at all leaves `active: null`, because "we could not join it" is not "it is
 * down", and calling it down would put a fake outage on a security screen.
 */
function gatekeeperWebhookState(validatingWebhooksResult, endpointslicesResult) {
  if (validatingWebhooksResult.unavailable) {
    return { present: null, active: null, backendStatus: 'unknown', failurePolicy: null, timeoutSeconds: null, service: null, reason: validatingWebhooksResult.reason };
  }
  let found = null;
  let configName = null;
  for (const cfg of validatingWebhooksResult.items) {
    for (const wh of (cfg.webhooks || [])) {
      if (wh.name === GATEKEEPER_WEBHOOK_NAME) { found = wh; configName = cfg.metadata.name; break; }
    }
    if (found) break;
  }
  if (!found) {
    return { present: false, active: false, backendStatus: 'absent', failurePolicy: null, timeoutSeconds: null, service: null, reason: null };
  }

  const service = (found.clientConfig && found.clientConfig.service) || null;
  const slices = endpointslicesResult.unavailable ? null : endpointslicesResult.items;
  let backendStatus = 'unknown';
  if (slices && service && service.name) {
    const matching = slices.filter(s => {
      const labels = (s.metadata && s.metadata.labels) || {};
      return labels['kubernetes.io/service-name'] === service.name
        && (!service.namespace || (s.metadata && s.metadata.namespace) === service.namespace);
    });
    if (matching.length > 0) {
      backendStatus = matching.some(s => (s.endpoints || []).some(ep => ep && ep.conditions && ep.conditions.ready !== false))
        ? 'ready'
        : 'none';
    }
  }

  return {
    present: true,
    active: backendStatus === 'ready' ? true : backendStatus === 'none' ? false : null,
    backendStatus,
    configName,
    webhookName: found.name,
    failurePolicy: found.failurePolicy || 'Fail',
    timeoutSeconds: Number.isFinite(found.timeoutSeconds) ? found.timeoutSeconds : null,
    operations: [...new Set((found.rules || []).flatMap(r => (Array.isArray(r.operations) ? r.operations : [])))],
    service: service ? { name: service.name, namespace: service.namespace || null, port: service.port ?? null } : null,
    reason: null
  };
}

/**
 * 'active'    it can reject or warn, and nothing structural stops it.
 * 'warning'   it works but something about it is worth reading — dry-run, a stale audit, an
 *             empty scope. Deliberately not 'inactive': the policy is loaded and evaluating.
 * 'inactive'  it cannot affect admission at all: no instance, no target kinds, no webhook.
 * 'unknown'   a read failed somewhere on the path to this answer.
 */
const HARD_INEFFECTIVE = new Set([
  'NO_CONSTRAINT_INSTANCES', 'NO_TARGET_KINDS', 'EMPTY_NAMESPACE_SCOPE',
  'WEBHOOK_INACTIVE', 'TEMPLATE_ERROR', 'NOT_RECONCILED', 'NOT_ENFORCED_BY_PODS',
  'UNSUPPORTED_ACTION'
]);

function policyStatus({ constraint, reasons }) {
  if (reasons.some(r => r.code === 'CONSTRAINTS_UNREADABLE')) return 'unknown';
  if (!constraint) return 'inactive';
  if (reasons.some(r => HARD_INEFFECTIVE.has(r.code))) return 'inactive';
  if (reasons.length > 0) return 'warning';
  return 'active';
}

function counts(policies) {
  const byAction = { deny: 0, warn: 0, dryrun: 0, unknown: 0 };
  const byStatus = { active: 0, warning: 0, inactive: 0, unknown: 0 };
  let violationTotal = 0;
  let violationCountUnknown = 0;
  let ineffective = 0;
  for (const p of policies) {
    byAction[p.enforcementAction] += 1;
    byStatus[p.status] += 1;
    if (p.violationCount === null) violationCountUnknown += 1;
    else violationTotal += p.violationCount;
    if (p.ineffectiveReasons.length > 0) ineffective += 1;
  }
  return {
    byAction,
    byStatus,
    ineffectiveCount: ineffective,
    // A total over policies whose own count was unreadable is a floor, not a total — which is
    // the same distinction safe-list draws between truncated and unavailable, one level up.
    auditViolationTotal: violationTotal,
    auditViolationCountPartial: violationCountUnknown > 0,
    policiesWithUnknownViolationCount: violationCountUnknown
  };
}

function categoryCounts(policies, violations) {
  const out = {};
  for (const c of CATEGORIES) out[c] = { policies: 0, violations: 0 };
  for (const p of policies) out[p.category].policies += 1;
  for (const v of violations) {
    if (out[v.category]) out[v.category].violations += 1;
  }
  return out;
}

/**
 * Is there any source of RUNTIME admission decisions on this cluster, and if not, exactly why?
 *
 * This is a separate function with its own route because it answers a different question from
 * everything above, and on most clusters its answer is "no". Rendering that honestly requires
 * naming the missing source, which requires two reads:
 *
 *   - Gatekeeper's controller-manager Deployment, for `--log-denies`. Off by default, and while
 *     it is off Gatekeeper writes no denial line at any log level — so scraping the pod log
 *     would return cert-rotation chatter and an empty table that reads as "no denials happened".
 *   - Gatekeeper's metrics Service. The counters (`gatekeeper_validation_request_count` by
 *     `admission_status`) are the real source, and reaching them needs `get` on `services/proxy`
 *     in gatekeeper-system. The fleet-reader ClusterRole this console installs (see onboard.js)
 *     grants `services`, never `services/proxy`, so the endpoint is unreachable BY CONSTRUCTION
 *     — a fact about our own RBAC, which is why it needs no probe. Asking the cluster instead
 *     would mean POSTing a SelfSubjectAccessReview, and while that creates nothing, the repo's
 *     read-only guard greps server/fleet for write methods and is worth more intact than this one
 *     request is worth making.
 *
 * `available` is therefore almost always false, and the empty state it drives says which of the
 * two knobs would change that. The alternative — showing audit violations under a "Denied"
 * heading — is the single most misleading thing this screen could do.
 */
async function decisions({ cluster, token, listFn = list }) {
  const baseCtx = { cluster, token };

  const deploymentsResult = await safeList(
    listFn, baseCtx,
    `/apis/apps/v1/namespaces/${GATEKEEPER_NAMESPACE}/deployments`,
    'gatekeeper deployments'
  );

  if (deploymentsResult.unavailable) {
    return {
      available: false,
      state: 'unreadable',
      reason: deploymentsResult.reason,
      detail: deploymentsResult.detail,
      // Refused, not unconfigured. The distinction decides whether the operator edits a role
      // binding or a controller flag, and there is no way back to it from "unavailable".
      capability: cap.fromReads({
        feature: 'OPA Decision Activity',
        reads: [deploymentsResult],
        gotAnything: false
      }),
      sources: [],
      entries: [],
      collectedAt: new Date().toISOString()
    };
  }

  const byName = new Map(deploymentsResult.items.map(d => [d.metadata.name, d]));
  const controller = byName.get(GATEKEEPER_WEBHOOK_DEPLOYMENT) || null;
  // The audit facts come from the same helper collect() uses, so the two screens can never
  // disagree about the audit interval, the violations limit or whether audit runs at all.
  const runtime = gatekeeperRuntime(deploymentsResult);

  if (!controller) {
    return {
      available: false,
      state: 'gatekeeper-absent',
      reason: null,
      detail: `No ${GATEKEEPER_WEBHOOK_DEPLOYMENT} Deployment in ${GATEKEEPER_NAMESPACE}.`,
      capability: cap.unknown(
        'OPA Decision Activity',
        `no ${GATEKEEPER_WEBHOOK_DEPLOYMENT} Deployment exists in ${GATEKEEPER_NAMESPACE}, so there is no admission controller here whose decisions could be recorded`,
        null
      ),
      sources: [],
      entries: [],
      collectedAt: new Date().toISOString()
    };
  }

  const args = argsOf(controller);
  const logDenies = flagValue(args, '--log-denies');
  const metrics = await metricsEndpoint({ listFn, baseCtx, controller });

  const sources = [
    {
      id: 'decision-log',
      label: 'Gatekeeper denial log',
      available: logDenies === 'true',
      detail: logDenies === 'true'
        ? `${GATEKEEPER_WEBHOOK_DEPLOYMENT} runs with --log-denies=true, so denials are written to its container log.`
        : `${GATEKEEPER_WEBHOOK_DEPLOYMENT} runs with --log-denies=${logDenies ?? 'unset (defaults to false)'}, so Gatekeeper writes no line when it denies a request.`
    },
    {
      id: 'admission-metric',
      label: 'Gatekeeper Prometheus counters',
      available: false,
      detail: metrics.detail
    }
  ];

  return {
    // No source is wired, so there are no entries — and `available: false` is what the UI needs
    // to render the honest empty state instead of an empty table.
    available: sources.some(s => s.available),
    state: 'no-source',
    reason: null,
    detail: null,
    /**
     * The verdict, in the operator's words. `not-configured` rather than `forbidden` or a bare
     * zero: both reads succeeded, the controller is right there, and the reason nothing is here is
     * that nothing was ever asked to record it. That is a flag on a Deployment and a metrics RBAC
     * rule — two fixable things — and neither is discoverable from the word "unavailable".
     */
    capability: sources.some(s => s.available)
      ? cap.available('OPA Decision Activity')
      : cap.notConfigured(
          'OPA Decision Activity',
          'admission decision telemetry is not configured',
          sources.map(s => s.detail).join(' ')
        ),
    sources,
    // Context the reader needs to understand what IS available instead: audit violations, and
    // how often they refresh.
    audit: {
      present: runtime.audit.present,
      state: runtime.audit.state,
      intervalSeconds: runtime.audit.intervalSeconds,
      violationsLimit: runtime.audit.violationsLimit
    },
    entries: [],
    collectedAt: new Date().toISOString()
  };
}

/**
 * Why the Prometheus counters are out of reach ON THIS CLUSTER — measured, not asserted.
 *
 * This used to return one fixed sentence blaming our own RBAC: "the fleet-reader ClusterRole
 * grants services but not the proxy subresource". That was a product assumption dressed as a
 * cluster fact, and on the first cluster it was checked against it was the wrong reason.
 * `gatekeeper-system` there exposes exactly one Service — `gatekeeper-webhook-service:443` —
 * while `--prometheus-port=8888` is a bare containerPort with no Service in front of it. Adding
 * the proxy grant would have bought the privilege and still reached nothing.
 *
 * The distinction is the operator's next action, which is the only thing this sentence is for:
 *
 *   - no metrics Service   → install one (or point Prometheus at the pods). RBAC is irrelevant.
 *   - Service exists       → the grant is the blocker, and that is a role change.
 *
 * A refused Service list is reported as refused rather than folded into either answer: not
 * knowing is a third state, and guessing between the two above would send the operator to edit
 * the wrong thing. The proxy subresource is deliberately absent from `readOnlyRules()` either
 * way — see the exclusions table there — so this never becomes an instruction to widen it.
 */
async function metricsEndpoint({ listFn, baseCtx, controller }) {
  const port = flagValue(argsOf(controller), '--prometheus-port');
  const lead = `gatekeeper_validation_request_count is served on ${GATEKEEPER_WEBHOOK_DEPLOYMENT}’s`
    + ` metrics port${port ? ` (--prometheus-port=${port})` : ''}.`;

  const servicesResult = await safeList(
    listFn, baseCtx,
    `/api/v1/namespaces/${GATEKEEPER_NAMESPACE}/services`,
    `${GATEKEEPER_NAMESPACE} services`
  );

  if (servicesResult.unavailable) {
    return {
      state: 'unreadable',
      detail: `${lead} Whether a Service exposes it could not be determined:`
        + ` listing Services in ${GATEKEEPER_NAMESPACE} failed (${servicesResult.reason}).`
    };
  }

  // A Service exposes the metrics port when one of its ports targets it — by number, or by the
  // container port's name. Matching on the Service's own name would be name-matching, and a
  // chart is free to call it anything.
  const wanted = port ? Number(port) : null;
  const exposing = servicesResult.items.filter(svc =>
    ((svc.spec && svc.spec.ports) || []).some(p => {
      const target = p.targetPort;
      if (wanted !== null && (Number(target) === wanted || Number(p.port) === wanted)) return true;
      return typeof target === 'string' && /metric/i.test(target);
    })
  );

  if (exposing.length === 0) {
    const names = servicesResult.items.map(s => s.metadata.name);
    return {
      state: 'no-service',
      detail: `${lead} No Service in ${GATEKEEPER_NAMESPACE} exposes that port`
        + `${names.length ? ` (found ${names.join(', ')})` : ' (no Services at all)'},`
        + ' so the counters are not reachable through the Kubernetes API at all — a proxy'
        + ' permission would not change that. Exposing the metrics port, or scraping it with'
        + ' Prometheus, is what would make this tab live.'
    };
  }

  return {
    state: 'forbidden',
    detail: `${lead} ${exposing.map(s => s.metadata.name).join(', ')} exposes it, but reading it`
      + ` needs get on services/proxy in ${GATEKEEPER_NAMESPACE}. That subresource is deliberately`
      + ' not in the fleet-reader role: a proxy grant is arbitrary HTTP to any port of any'
      + ' workload in the cluster, which is a wider blast radius than this one counter is worth.'
  };
}

function argsOf(deployment) {
  const containers = (deployment && deployment.spec && deployment.spec.template
    && deployment.spec.template.spec && deployment.spec.template.spec.containers) || [];
  return containers.flatMap(c => (Array.isArray(c.args) ? c.args : []));
}

/**
 * Gatekeeper's own runtime: which version is installed, and is the audit controller running.
 *
 * Both belong on the Overview header, and both are facts about DEPLOYMENTS rather than about
 * policies — so this is one read of `gatekeeper-system` shared by `collect()` and `decisions()`
 * instead of two divergent copies. `audit.state` is the distinction §5 asks for by name:
 * `disabled` (no audit controller, or scaled to zero — every violation count is then stale by
 * construction) is not the same as `unreadable` (we were not allowed to look).
 */
function gatekeeperRuntime(deploymentsResult) {
  if (deploymentsResult.unavailable) {
    return {
      version: null,
      versionSource: null,
      controllerPresent: null,
      controllerReady: null,
      audit: { state: 'unreadable', present: null, ready: null, intervalSeconds: null, violationsLimit: null },
      reason: deploymentsResult.reason,
      detail: deploymentsResult.detail
    };
  }
  const byName = new Map(deploymentsResult.items.map(d => [d.metadata.name, d]));
  const controller = byName.get(GATEKEEPER_WEBHOOK_DEPLOYMENT) || null;
  const audit = byName.get(GATEKEEPER_AUDIT_DEPLOYMENT) || null;

  // The version label the Gatekeeper chart writes, with the image tag as the fallback. Never a
  // guess: `versionSource` says which one answered, and null means neither did.
  const labels = (controller && controller.metadata && controller.metadata.labels) || {};
  let version = labels['app.kubernetes.io/version'] || null;
  let versionSource = version ? 'app.kubernetes.io/version label' : null;
  if (!version && controller) {
    const image = (((controller.spec.template.spec.containers || [])[0]) || {}).image || '';
    const tag = /:([^:/@]+)$/.exec(image);
    if (tag && tag[1] !== 'latest') {
      version = tag[1];
      versionSource = 'controller image tag';
    }
  }

  const auditReplicas = audit ? ((audit.spec && audit.spec.replicas) ?? 1) : 0;
  const auditReady = audit ? ((audit.status && audit.status.readyReplicas) || 0) : 0;
  const auditInterval = flagValue(argsOf(audit), '--audit-interval');
  const violationsLimit = flagValue(argsOf(audit), '--constraint-violations-limit');

  // 'disabled' is a claim about the operator's configuration, so it needs the controller as
  // corroboration: a namespace holding neither Deployment means Gatekeeper is installed somewhere
  // this collector is not looking, and calling that "audit disabled" would put a false reason on
  // every policy row. Without the controller the honest answer is 'unknown'.
  let auditState;
  if (!controller && !audit) auditState = 'unknown';
  else if (!audit || auditReplicas === 0) auditState = 'disabled';
  else auditState = auditReady > 0 ? 'running' : 'not-ready';

  return {
    version,
    versionSource,
    controllerPresent: Boolean(controller),
    controllerReady: controller ? ((controller.status && controller.status.readyReplicas) || 0) : 0,
    audit: {
      state: auditState,
      present: Boolean(audit),
      ready: auditReady,
      intervalSeconds: auditInterval ? Number(auditInterval) : null,
      violationsLimit: violationsLimit ? Number(violationsLimit) : null
    },
    reason: null,
    detail: null
  };
}

/** `--flag=value` → 'value'; a bare `--flag` → 'true'; absent → null. */
function flagValue(args, flag) {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (arg === flag) return 'true';
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}


// --------------------------------------------------------------------------------------
// YAML, for exactly two Kinds
// --------------------------------------------------------------------------------------

/**
 * The live YAML of one ConstraintTemplate and, optionally, one Constraint under it.
 *
 * ## Why this is not a generic resource GET
 *
 * The obvious way to serve a YAML view is `GET /clusters/:id/raw/:group/:version/:plural/:name`,
 * and it is the wrong way: that endpoint reads any object the fleet-reader token can read, which
 * includes every Secret on the cluster. The console's standing rule is that Secret VALUES never
 * cross this wire, and a route whose Kind is a caller-supplied parameter cannot keep that rule —
 * it delegates the decision to whoever writes the URL.
 *
 * So the Kind is not a parameter. This function reads `templates.gatekeeper.sh` and
 * `constraints.gatekeeper.sh` and nothing else; the group, version and resource are constants in
 * this file. `template` and `constraint` name objects within those two groups, and a name that
 * does not exist answers 404 rather than reaching for something else.
 *
 * Defence in depth all the same: both documents go through `maskValues` before serialisation, so
 * if a future Gatekeeper field ever carried credential-shaped content it would be masked by the
 * same rule that masks Helm values. Constraint parameters — allowed registries, required labels —
 * are policy configuration and are not credential-shaped, so they survive intact.
 */
async function manifest({ cluster, token, template, constraint, callFn = call }) {
  if (!template || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(template)) {
    throw Object.assign(new Error('template must be a Kubernetes resource name'), { status: 400 });
  }
  if (constraint && !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(constraint)) {
    throw Object.assign(new Error('constraint must be a Kubernetes resource name'), { status: 400 });
  }

  const templateObj = await callFn({
    cluster, token,
    path: `/apis/${TEMPLATES_GROUP}/${TEMPLATES_VERSION}/constrainttemplates/${encodeURIComponent(template)}`
  });

  const documents = [{
    // The label the UI prints above the pane. `LIVE` because it is the object the API server
    // holds right now, which is a different thing from Helm's rendered manifest — the console
    // shows both in places and conflating them is how an operator debugs the wrong copy.
    label: 'LIVE CONSTRAINTTEMPLATE',
    kind: 'ConstraintTemplate',
    name: template,
    yaml: YAML.stringify(maskValues(stripManaged(templateObj)))
  }];

  if (constraint) {
    const plural = constraintPlural(templateObj);
    const constraintObj = await callFn({
      cluster, token,
      path: `/apis/${CONSTRAINTS_GROUP}/${CONSTRAINTS_VERSION}/${plural}/${encodeURIComponent(constraint)}`
    });
    documents.push({
      label: 'LIVE GATEKEEPER CONSTRAINT',
      kind: (templateObj.spec && templateObj.spec.crd && templateObj.spec.crd.spec
        && templateObj.spec.crd.spec.names && templateObj.spec.crd.spec.names.kind) || plural,
      name: constraint,
      yaml: YAML.stringify(maskValues(stripManaged(constraintObj)))
    });
  }

  return { documents, collectedAt: new Date().toISOString() };
}

/**
 * Drop the two fields that are pure API-server bookkeeping and are longer than the object.
 *
 * `managedFields` is field-ownership metadata that no operator reads and that routinely triples
 * a Constraint's YAML. `last-applied-configuration` is a JSON copy of the whole spec, so leaving
 * it in means the pane shows every value twice, once unreadably.
 */
function stripManaged(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const metadata = { ...(obj.metadata || {}) };
  delete metadata.managedFields;
  if (metadata.annotations) {
    const annotations = { ...metadata.annotations };
    delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
    if (Object.keys(annotations).length === 0) delete metadata.annotations;
    else metadata.annotations = annotations;
  }
  return { ...obj, metadata };
}

export default {
  collect,
  decisions,
  manifest,
  stripManaged,
  // exported for tests
  enforcementActionOf,
  ineffectiveReasons,
  namespaceScopeOf,
  categoryOf,
  describe,
  auditFreshnessOf,
  auditStaleAfterMs,
  gatekeeperRuntime,
  normaliseViolation,
  installationState,
  gatekeeperWebhookState,
  policyStatus,
  flagValue,
  targetKindsOf,
  CATEGORIES,
  MAX_CONSTRAINT_TEMPLATES,
  MAX_VIOLATION_MESSAGE
};
