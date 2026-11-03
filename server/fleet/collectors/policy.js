/**
 * Policy & governance collector: admission enforcement (OPA Gatekeeter / native
 * ValidatingAdmissionPolicy), fail-closed webhook blast radius, and PodDisruptionBudget
 * coverage.
 *
 * THIS COLLECTOR OWNS PodDisruptionBudgets. No other collector may read
 * `poddisruptionbudgets` — see the note on C3 below for why a second reader would be a
 * wave-boundary violation, not a harmless duplicate.
 *
 * Three checks, C1/C2/C3, share exactly two joins and nothing else:
 *   - the namespaces list (C2's namespaceSelector evaluation)
 *   - the endpointslices list (C1 and C2's "is the webhook backend actually up" check)
 * C3 is deliberately independent of C1/C2's Gatekeeper/webhook reads — a fleet with no
 * Gatekeeper installed still gets a full PDB coverage report.
 */
import k8sModule from '../k8s.js';
const { list, call } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, absentList, unavailableLabels, truncatedLabels } = safeListModule;

const ADMISSION_GROUP = 'admissionregistration.k8s.io';
const ADMISSION_VERSION = 'v1';
const GATEKEEPER_TEMPLATES_GROUP = 'templates.gatekeeper.sh';
const GATEKEEPER_TEMPLATES_VERSION = 'v1';
const GATEKEEPER_CONSTRAINTS_GROUP = 'constraints.gatekeeper.sh';
const GATEKEEPER_CONSTRAINTS_VERSION = 'v1beta1';

/**
 * The name Gatekeeper gives its own admission webhook entry (not the webhook
 * *configuration* object's name, the individual `.webhooks[].name`). Deliberately reused
 * below as the `enforcementPoint` name a `scopedEnforcementActions` entry must carry to be
 * relevant to admission — both strings name the same thing, Gatekeeper's own validating
 * webhook, because that is genuinely what "does this constraint apply at admission" means.
 */
const GATEKEEPER_VALIDATING_WEBHOOK_NAME = 'validation.gatekeeper.sh';

/** Past this many ConstraintTemplates, a per-constraint read is too expensive to be honest. */
const MAX_CONSTRAINT_TEMPLATES = 25;

// --------------------------------------------------------------------------------------
// shared: LabelSelector evaluation (matchLabels + matchExpressions), used by C2's
// namespaceSelector join and C3's PDB-selector-vs-pod-template-labels join. Deliberately
// not imported from workloads.js: that module's version is unexported and pod-shaped
// (namespace + pod labels), this one is generic label-map-vs-selector, and the ~15 lines
// here are cheaper than making the two collectors share a private helper across a wave
// boundary.
// --------------------------------------------------------------------------------------

function matchesExpression(labels, expr) {
  const key = expr && expr.key;
  const op = expr && expr.operator;
  if (!key || !op) return false;
  const has = Object.prototype.hasOwnProperty.call(labels, key);
  const values = Array.isArray(expr.values) ? expr.values : [];
  switch (op) {
    case 'In': return has && values.includes(labels[key]);
    case 'NotIn': return !has || !values.includes(labels[key]);
    case 'Exists': return has;
    case 'DoesNotExist': return !has;
    default: return false;
  }
}

/** An absent selector, or one with neither field set, selects everything — LabelSelector semantics. */
function selectorMatches(labels, selector) {
  const safeLabels = labels || {};
  if (!selector) return true;
  const matchLabels = selector.matchLabels || null;
  const matchExpressions = Array.isArray(selector.matchExpressions) ? selector.matchExpressions : null;
  if (!matchLabels && !matchExpressions) return true;
  if (matchLabels && !Object.entries(matchLabels).every(([k, v]) => safeLabels[k] === v)) return false;
  if (matchExpressions && !matchExpressions.every(expr => matchesExpression(safeLabels, expr))) return false;
  return true;
}

// --------------------------------------------------------------------------------------
// C1: admission enforcement verdict
// --------------------------------------------------------------------------------------

/** Gatekeeper's convention: a ConstraintTemplate's plural resource name IS its own metadata.name
 * (which is itself lowercase(kind)). A generic pluralizer gets real Gatekeeper kinds wrong
 * (e.g. "K8sPSPAllowedUsers" is not "k8spspallowedus" or any other guessed plural) — the CRD
 * that Gatekeeper mints for the template is the only authority, and it names itself after the
 * template it was minted from, so reading the template's own name is exact, not a heuristic. */
function constraintPlural(constraintTemplate) {
  return constraintTemplate.metadata && constraintTemplate.metadata.name;
}

function constraintKind(constraintTemplate) {
  const names = constraintTemplate.spec && constraintTemplate.spec.crd && constraintTemplate.spec.crd.spec
    && constraintTemplate.spec.crd.spec.names;
  return (names && names.kind) || null;
}

/** scopedEnforcementActions entries relevant to admission — see GATEKEEPER_VALIDATING_WEBHOOK_NAME. */
function scopedAdmissionActions(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(e => {
      if (!e) return false;
      if (typeof e.enforcementPoint === 'string') return e.enforcementPoint === GATEKEEPER_VALIDATING_WEBHOOK_NAME;
      if (Array.isArray(e.enforcementPoints)) {
        return e.enforcementPoints.some(p => p && p.name === GATEKEEPER_VALIDATING_WEBHOOK_NAME);
      }
      return false;
    })
    .map(e => e.action)
    .filter(Boolean);
}

/**
 * The action(s) that actually govern admission-time behaviour for one Constraint instance.
 * `enforcementAction` absent defaults to Gatekeeper's own default, 'deny' — this is Gatekeeper's
 * documented default, not this collector inventing a safe-by-omission guess. A 'scoped' action
 * defers entirely to `scopedEnforcementActions` filtered to the admission enforcement point; if
 * none of those entries name it, this constraint has NO effect at admission (it may still run
 * under audit or gator), so it contributes nothing here.
 */
function effectiveAdmissionActions(constraint) {
  const spec = (constraint && constraint.spec) || {};
  const action = spec.enforcementAction || 'deny';
  if (action !== 'scoped') return [action];
  return scopedAdmissionActions(spec.scopedEnforcementActions);
}

function findGatekeeperValidatingWebhook(webhookConfigs) {
  for (const cfg of webhookConfigs) {
    for (const wh of (cfg.webhooks || [])) {
      if (wh.name === GATEKEEPER_VALIDATING_WEBHOOK_NAME) return wh;
    }
  }
  return null;
}

/**
 * 'ready'   >=1 endpoint across the matching EndpointSlice(s) has `conditions.ready !== false`.
 * 'none'    matching slice(s) exist but every endpoint on them is explicitly ready:false —
 *           the webhook config points at a Service with nothing healthy behind it.
 * 'unknown' no EndpointSlice matched the Service at all — cannot tell definitely-ready from
 *           definitely-not, so this must not be reported as either (see the module contract).
 */
function backendStatus(service, endpointslices) {
  if (!service || !service.name) return 'unknown';
  const slices = endpointslices.filter(s => {
    const labels = (s.metadata && s.metadata.labels) || {};
    const sameService = labels['kubernetes.io/service-name'] === service.name;
    const sameNamespace = !service.namespace || (s.metadata && s.metadata.namespace) === service.namespace;
    return sameService && sameNamespace;
  });
  if (slices.length === 0) return 'unknown';
  const anyReady = slices.some(s => (s.endpoints || []).some(ep => ep && ep.conditions && ep.conditions.ready !== false));
  return anyReady ? 'ready' : 'none';
}

/**
 * @returns {{policyEngineVerdict: string, constraintTemplates: object[], webhookPresent: boolean,
 *            webhookBackendStatus: string, constraintTemplateCount: number}}
 */
function buildAdmissionVerdict({ constraintTemplateItems, constraintsByPlural, validatingWebhooks, endpointslices }) {
  const templateCount = constraintTemplateItems.length;

  if (templateCount > MAX_CONSTRAINT_TEMPLATES) {
    // Past the limit we have not actually read every constraint, so any verdict beyond
    // "don't know" would be a partial answer dressed as a full one — the exact thing the
    // task calls out as dishonest.
    return {
      policyEngineVerdict: 'unknown',
      webhookPresent: null,
      webhookBackendStatus: null,
      constraintTemplateCount: templateCount,
      constraintTemplates: []
    };
  }

  const webhook = findGatekeeperValidatingWebhook(validatingWebhooks);
  const webhookPresent = webhook !== null;
  const service = webhook && webhook.clientConfig && webhook.clientConfig.service;
  const webhookBackend = webhookPresent ? backendStatus(service, endpointslices) : 'unknown';

  const templates = constraintTemplateItems.map(ct => {
    const plural = constraintPlural(ct);
    const constraintResult = constraintsByPlural.get(plural);
    const instances = (constraintResult && constraintResult.items) || [];
    const actions = instances.flatMap(effectiveAdmissionActions);
    return {
      name: ct.metadata.name,
      kind: constraintKind(ct),
      plural,
      constraintCount: instances.length,
      constraintsUnavailable: Boolean(constraintResult && constraintResult.unavailable),
      admissionActions: [...new Set(actions)]
    };
  });

  const anyReadFailed = templates.some(t => t.constraintsUnavailable);
  const allActions = templates.flatMap(t => t.admissionActions);
  const hasEnforcingAction = allActions.some(a => a === 'deny' || a === 'warn');

  let policyEngineVerdict;
  if (anyReadFailed) {
    policyEngineVerdict = 'unknown';
  } else if (!webhookPresent) {
    // No Gatekeeper CRDs and no webhook: nothing installed. Templates with zero instances
    // and no webhook is the same story — the engine, if present at all, enforces nothing.
    policyEngineVerdict = templateCount === 0 ? 'absent' : 'installed-inert';
  } else if (webhookBackend === 'none') {
    // The new state the task asks for by name: webhook object exists, but it resolves to
    // nothing live — requests either fail open or fail closed on failurePolicy alone,
    // never on the constraints Gatekeeper thinks it is running.
    policyEngineVerdict = 'enforcement-suspended';
  } else if (hasEnforcingAction) {
    policyEngineVerdict = 'enforcing';
  } else {
    policyEngineVerdict = 'installed-inert';
  }

  return { policyEngineVerdict, webhookPresent, webhookBackendStatus: webhookBackend, constraintTemplateCount: templateCount, constraintTemplates: templates };
}

// --------------------------------------------------------------------------------------
// C2: fail-closed webhook risk
// --------------------------------------------------------------------------------------

/** Every (group, resource) pair a rule's wildcards expand to, plus whether any of it is a wildcard. */
function ruleCoverage(rules) {
  const entries = [];
  let wildcard = false;
  for (const rule of (Array.isArray(rules) ? rules : [])) {
    const groups = Array.isArray(rule.apiGroups) && rule.apiGroups.length ? rule.apiGroups : ['*'];
    const resources = Array.isArray(rule.resources) && rule.resources.length ? rule.resources : ['*'];
    const operations = Array.isArray(rule.operations) ? rule.operations : [];
    for (const group of groups) {
      for (const resource of resources) {
        if (group === '*' || resource === '*') wildcard = true;
        entries.push({ group, resource, operations });
      }
    }
  }
  return { entries, wildcard };
}

/** Which of `namespaces` a webhook's namespaceSelector actually reaches, or 'unknown' if the join can't be made. */
function namespaceScopeFor(namespaceSelector, namespacesResult) {
  if (namespacesResult.unavailable) {
    return { evaluable: false, scope: 'unknown', matchedNamespaceCount: null, totalNamespaces: null };
  }
  const total = namespacesResult.items.length;
  if (!namespaceSelector) {
    return { evaluable: true, scope: 'cluster-wide', matchedNamespaceCount: total, totalNamespaces: total };
  }
  const matched = namespacesResult.items.filter(ns => selectorMatches((ns.metadata && ns.metadata.labels) || {}, namespaceSelector));
  return {
    evaluable: true,
    scope: 'selector',
    matchedNamespaceCount: matched.length,
    totalNamespaces: total,
    matchedNamespaces: matched.map(ns => ns.metadata.name).sort()
  };
}

/** `namespaceScopeFor` over every non-null selector at once: a namespace must satisfy all of them. */
function namespaceScopeForAll(selectors, namespacesResult) {
  const present = selectors.filter(Boolean);
  if (present.length <= 1) return namespaceScopeFor(present[0] || null, namespacesResult);
  const scope = namespaceScopeFor(present[0], namespacesResult);
  if (!scope.evaluable) return scope;
  const matched = namespacesResult.items.filter(ns =>
    present.every(sel => selectorMatches((ns.metadata && ns.metadata.labels) || {}, sel)));
  return { ...scope, matchedNamespaceCount: matched.length, matchedNamespaces: matched.map(ns => ns.metadata.name).sort() };
}

/**
 * 'fail-open'           failurePolicy: Ignore — a down backend is invisible, not a risk this
 *                        check is about (the risk here is the opposite: blocking too much).
 * 'active-outage-risk'  failurePolicy: Fail (or absent, which defaults to Fail) AND the
 *                        backend is confirmed down right now — matching requests are being
 *                        rejected this minute, not hypothetically.
 * 'latent-risk'         fail-closed and the backend is currently up — nothing is broken today,
 *                        but it would be the instant the backend's last replica went away.
 * 'unknown'             fail-closed but the backend join could not be made either way.
 */
function failClosedRisk(failurePolicy, resolvedBackendStatus) {
  const failClosed = (failurePolicy || 'Fail') === 'Fail';
  if (!failClosed) return 'fail-open';
  if (resolvedBackendStatus === 'none') return 'active-outage-risk';
  if (resolvedBackendStatus === 'unknown') return 'unknown';
  return 'latent-risk';
}

/**
 * How many ready endpoint addresses actually stand behind a webhook's Service.
 *
 * `backendStatus` answers ready/none/absent/unknown, which is what the risk verdict needs. The
 * webhooks table also states the number, because "ready" behind one endpoint and "ready" behind
 * twelve are different distances from an outage.
 */
function readyEndpointsFor(service, endpointslices) {
  if (!service || !service.name) return null;
  let n = 0;
  let seen = false;
  for (const slice of endpointslices || []) {
    const labels = (slice.metadata && slice.metadata.labels) || {};
    if (labels['kubernetes.io/service-name'] !== service.name) continue;
    if (service.namespace && slice.metadata.namespace !== service.namespace) continue;
    seen = true;
    for (const ep of slice.endpoints || []) {
      const cond = ep.conditions || {};
      if (cond.ready === undefined || cond.ready === true) n += (ep.addresses || []).length || 1;
    }
  }
  return seen ? n : null;
}

/**
 * What this webhook is doing to admission, in the words the table shows.
 *
 * Split out from `risk` because the two answer different questions and conflating them is the
 * exact error the master prompt forbids: `risk` is about the blast radius if the backend goes
 * away, while this is about whether the webhook is enforcing anything AT ALL right now. A
 * fail-open webhook with a dead backend is `backend-unavailable` here and `fail-open` there,
 * and an operator needs both facts.
 *
 * 'declared-matches-nothing'  its rules expand to nothing, or its namespaceSelector reaches
 *                             none of the namespaces we can see.
 * 'backend-unavailable'       the Service it points at has no ready endpoint. Nothing is being
 *                             enforced regardless of what the rules say.
 * 'unknown'                   the backend join could not be made — not "down", not "up".
 * 'fail-open'                 failurePolicy: Ignore. It enforces while the backend answers and
 *                             silently admits everything the moment it does not.
 * 'partially-effective'       fail-closed and up, but narrowed by an objectSelector or CEL match
 *                             conditions, so its rules overstate what it actually sees.
 * 'active-enforcing'          fail-closed, up, and matching everything its rules describe.
 */
function effectiveWebhookStatus({ failurePolicy, backendStatus: backend, ruleCount, namespaceScope, narrowed, urlBacked }) {
  if (ruleCount === 0) return 'declared-matches-nothing';
  if (namespaceScope && namespaceScope.evaluable && namespaceScope.matchedNamespaceCount === 0) {
    return 'declared-matches-nothing';
  }
  // A URL-backed webhook has no in-cluster Service, so there is no endpoint join to make and
  // 'absent'/'unknown' says nothing about whether it is up. Reported as unknown, not as down.
  if (urlBacked) return 'unknown';
  if (backend === 'absent' || backend === 'none') return 'backend-unavailable';
  if (backend === 'unknown') return 'unknown';
  if ((failurePolicy || 'Fail') === 'Ignore') return 'fail-open';
  if (narrowed) return 'partially-effective';
  return 'active-enforcing';
}

function webhookEntries(configs, kind, namespacesResult, endpointslices) {
  const out = [];
  for (const cfg of configs) {
    const cfgLabels = (cfg.metadata && cfg.metadata.labels) || {};
    const cfgAnnotations = (cfg.metadata && cfg.metadata.annotations) || {};
    for (const wh of (cfg.webhooks || [])) {
      const service = wh.clientConfig && wh.clientConfig.service;
      const resolvedBackendStatus = backendStatus(service, endpointslices);
      const coverage = ruleCoverage(wh.rules);
      const operations = [...new Set(coverage.entries.flatMap(e => e.operations))];
      const namespaceScope = namespaceScopeFor(wh.namespaceSelector, namespacesResult);
      const objectSelectorPresent = Boolean(wh.objectSelector && (wh.objectSelector.matchLabels || wh.objectSelector.matchExpressions));
      const urlBacked = Boolean(wh.clientConfig && wh.clientConfig.url);
      out.push({
        configName: cfg.metadata.name,
        webhookName: wh.name,
        kind,
        /**
         * Who installed this webhook, taken from the labels the installer wrote — never guessed
         * from the webhook's own name. `null` when nothing declares it, which is honest: plenty
         * of webhooks are applied by hand and carry no provenance at all.
         */
        owner: cfgLabels['app.kubernetes.io/managed-by']
          || cfgLabels['app.kubernetes.io/part-of']
          || cfgAnnotations['meta.helm.sh/release-name']
          || cfgLabels['kyma-project.io/module']
          || null,
        // Absent failurePolicy defaults to 'Fail' per the admissionregistration.k8s.io API
        // default — reported here as the literal effective value, never as "unset (safe)".
        failurePolicy: wh.failurePolicy || 'Fail',
        /** Absent timeoutSeconds defaults to 10 in the API. Reported as the effective number. */
        timeoutSeconds: wh.timeoutSeconds ?? 10,
        sideEffects: wh.sideEffects || null,
        matchPolicy: wh.matchPolicy || 'Equivalent',
        /** Only whether CEL match conditions exist, and their names — never the expressions. */
        matchConditions: (wh.matchConditions || []).map(m => m.name).filter(Boolean),
        admissionReviewVersions: wh.admissionReviewVersions || [],
        operations,
        backendStatus: resolvedBackendStatus,
        readyEndpoints: readyEndpointsFor(service, endpointslices),
        service: service
          ? { name: service.name, namespace: service.namespace || null, port: service.port ?? null, path: service.path || null }
          : null,
        /** A URL-backed webhook has no Service to join, which is why backendStatus is 'absent'. */
        urlBacked,
        /** Whether a CA bundle is pinned. Presence only — the bundle itself never crosses. */
        caBundlePresent: Boolean(wh.clientConfig && wh.clientConfig.caBundle),
        risk: failClosedRisk(wh.failurePolicy, resolvedBackendStatus),
        effectiveStatus: effectiveWebhookStatus({
          failurePolicy: wh.failurePolicy,
          backendStatus: resolvedBackendStatus,
          ruleCount: coverage.entries.length,
          namespaceScope,
          narrowed: objectSelectorPresent || (wh.matchConditions || []).length > 0,
          urlBacked
        }),
        namespaceSelector: wh.namespaceSelector || null,
        objectSelector: wh.objectSelector || null,
        objectSelectorPresent,
        blastRadius: {
          rules: coverage.entries,
          wildcard: coverage.wildcard,
          namespaceScope
        }
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------
// C1b: native ValidatingAdmissionPolicy rows
// --------------------------------------------------------------------------------------

/** A selector with neither field set selects everything, so it is reported as no selector at all. */
function effectiveSelector(selector) {
  if (!selector) return null;
  const hasLabels = selector.matchLabels && Object.keys(selector.matchLabels).length > 0;
  const hasExpressions = Array.isArray(selector.matchExpressions) && selector.matchExpressions.length > 0;
  return hasLabels || hasExpressions ? selector : null;
}

/**
 * Deny outranks Warn outranks Audit: the question an operator asks of a policy is "can it reject
 * anything", and one Deny binding answers yes however many Audit bindings sit beside it.
 */
const VAP_ACTION_RANK = { Deny: 3, Warn: 2, Audit: 1 };

/**
 * One row per ValidatingAdmissionPolicy, joined to the bindings that name it.
 *
 * A policy enforces nothing until a binding names it, and a binding enforces nothing when the
 * policy it names does not exist — both are admitted by the API server without complaint, which
 * is why they are split out as `unbound` and `orphanBindings` rather than left for the reader to
 * notice. CEL expressions stay on the cluster: only each validation's `message` crosses, the same
 * rule webhook entries follow for `matchConditions`.
 */
function nativePolicyEntries(policies, bindings, namespacesResult, { policiesRead = true, bindingsRead = true } = {}) {
  const byPolicy = new Map();
  for (const b of bindings) {
    const name = b.spec && b.spec.policyName;
    if (!name) continue;
    if (!byPolicy.has(name)) byPolicy.set(name, []);
    byPolicy.get(name).push(b);
  }
  const policyNames = new Set(policies.map(p => p.metadata && p.metadata.name));

  // A request reaches a binding only through the policy's own matchConstraints as well, so a
  // binding's reach is the intersection of both selectors, never the binding's alone.
  const bindingRow = (b, policyMatch) => {
    const spec = b.spec || {};
    const mr = spec.matchResources || {};
    const pm = policyMatch || {};
    const actions = Array.isArray(spec.validationActions) ? spec.validationActions : [];
    const paramRef = spec.paramRef || null;
    return {
      name: b.metadata && b.metadata.name,
      policyName: spec.policyName || null,
      validationActions: actions,
      paramRef: paramRef
        ? {
          name: paramRef.name || null,
          namespace: paramRef.namespace || null,
          selectorPresent: Boolean(paramRef.selector),
          parameterNotFoundAction: paramRef.parameterNotFoundAction || null
        }
        : null,
      namespaceScope: namespaceScopeForAll([effectiveSelector(pm.namespaceSelector), effectiveSelector(mr.namespaceSelector)], namespacesResult),
      objectSelectorPresent: Boolean(effectiveSelector(mr.objectSelector) || effectiveSelector(pm.objectSelector)),
      // A binding may narrow the policy's own match further; its rules replace nothing, they intersect.
      narrowsResources: Array.isArray(mr.resourceRules) && mr.resourceRules.length > 0
    };
  };

  const rows = policies.map(p => {
    const spec = p.spec || {};
    const labels = (p.metadata && p.metadata.labels) || {};
    const annotations = (p.metadata && p.metadata.annotations) || {};
    const name = p.metadata && p.metadata.name;
    const bound = (byPolicy.get(name) || []).map(b => bindingRow(b, spec.matchConstraints));
    const strongest = bound
      .flatMap(b => b.validationActions)
      .reduce((best, a) => ((VAP_ACTION_RANK[a] || 0) > (VAP_ACTION_RANK[best] || 0) ? a : best), null);
    const coverage = ruleCoverage((spec.matchConstraints && spec.matchConstraints.resourceRules) || []);
    const status = p.status || {};
    const warnings = (status.typeChecking && Array.isArray(status.typeChecking.expressionWarnings))
      ? status.typeChecking.expressionWarnings : [];
    return {
      name,
      owner: labels['app.kubernetes.io/managed-by']
        || labels['app.kubernetes.io/part-of']
        || annotations['meta.helm.sh/release-name']
        || labels['kyma-project.io/module']
        || null,
      module: labels['kyma-project.io/module'] || null,
      // Absent failurePolicy defaults to Fail, as for webhooks: reported as the effective value.
      failurePolicy: spec.failurePolicy || 'Fail',
      paramKind: spec.paramKind ? { apiVersion: spec.paramKind.apiVersion || null, kind: spec.paramKind.kind || null } : null,
      rules: coverage.entries,
      wildcard: coverage.wildcard,
      operations: [...new Set(coverage.entries.flatMap(e => e.operations))],
      validationCount: Array.isArray(spec.validations) ? spec.validations.length : 0,
      messages: (Array.isArray(spec.validations) ? spec.validations : [])
        .map(v => (typeof v.message === 'string' ? v.message : null))
        .filter(Boolean),
      matchConditionCount: Array.isArray(spec.matchConditions) ? spec.matchConditions.length : 0,
      auditAnnotationCount: Array.isArray(spec.auditAnnotations) ? spec.auditAnnotations.length : 0,
      typeCheckWarningCount: warnings.length,
      bindings: bound,
      strongestAction: strongest,
      // A refused binding read joins against nothing; that is not "no binding selects it".
      effectiveStatus: !bindingsRead
        ? 'unknown'
        : bound.length === 0
        ? 'unbound'
        : strongest === 'Deny' ? 'enforcing'
          : strongest === 'Warn' ? 'warn-only'
            : strongest === 'Audit' ? 'audit-only' : 'no-action'
    };
  });

  // Without the policy list every binding would look orphaned, so none is reported as one.
  const orphanBindings = !policiesRead ? [] : bindings
    .filter(b => b.spec && b.spec.policyName && !policyNames.has(b.spec.policyName))
    .map(b => bindingRow(b, null));

  return { policies: rows, orphanBindings };
}

// --------------------------------------------------------------------------------------
// C3: PodDisruptionBudget coverage
// --------------------------------------------------------------------------------------

function podTemplateLabels(workload) {
  return (workload.spec && workload.spec.template && workload.spec.template.metadata && workload.spec.template.metadata.labels) || {};
}

/** max(spec.replicas ?? 1, status.replicas) — guards a PDB written against a stale/scaled-down spec. */
function effectiveReplicas(workload, kind) {
  if (kind === 'DaemonSet') {
    const desired = workload.status && workload.status.desiredNumberScheduled;
    return Number.isFinite(desired) ? desired : 1;
  }
  const specReplicas = Number.isFinite(workload.spec && workload.spec.replicas) ? workload.spec.replicas : 1;
  const statusReplicas = Number.isFinite(workload.status && workload.status.replicas) ? workload.status.replicas : 0;
  return Math.max(specReplicas, statusReplicas);
}

function pdbCoversWorkload(pdb, workload) {
  if (pdb.metadata.namespace !== workload.namespace) return false;
  return selectorMatches(podTemplateLabels(workload), pdb.spec && pdb.spec.selector);
}

/**
 * PDBs whose selector matches no workload's pod template in the same namespace. Renamed
 * from "orphan" per the task: Istio's sidecar injection adds pod labels (e.g.
 * `security.istio.io/tlsMode`) that are on the running pod but absent from the owning
 * workload's own `spec.template.metadata.labels`, which produces a real, benign mismatch
 * that "orphan" would mischaracterise as an error to fix.
 */
function selectorUnmatchedPdbs(pdbs, workloads) {
  return pdbs
    .filter(pdb => !workloads.some(w => pdbCoversWorkload(pdb, w)))
    .map(pdb => ({ name: pdb.metadata.name, namespace: pdb.metadata.namespace }));
}

/**
 * PDBs at `disruptionsAllowed === 0`, gated on the controller having actually reconciled this
 * generation.
 *
 * Deliberately *not* named "drain blockers": nothing in this read is node-scoped, and the value is
 * 0 transiently during any rollout, so membership here means "currently allows no disruption
 * cluster-wide", not "a drain of node X will hang". The UI says so.
 */
function drainBlockingPdbs(pdbs) {
  return pdbs
    .filter(pdb => {
      const status = pdb.status || {};
      const meta = pdb.metadata || {};
      return status.disruptionsAllowed === 0 && status.observedGeneration === meta.generation;
    })
    .map(pdb => ({ name: pdb.metadata.name, namespace: pdb.metadata.namespace }));
}

/**
 * PDBs the controller has not evaluated for their current spec.
 *
 * `status.observedGeneration !== metadata.generation` (including a status with no
 * `observedGeneration` at all) means `disruptionsAllowed` describes an older spec or nothing yet.
 * Such a PDB used to fall out of `drainBlockingPdbs` and appear nowhere else, which reads exactly
 * like "evaluated, and fine". It is unknown, and it is reported as unknown.
 */
function unreconciledPdbs(pdbs) {
  return pdbs
    .filter(pdb => {
      const status = pdb.status || {};
      const meta = pdb.metadata || {};
      return status.observedGeneration !== meta.generation;
    })
    .map(pdb => ({
      name: pdb.metadata.name,
      namespace: pdb.metadata.namespace,
      // What the controller last evaluated, and what the object is now — the two numbers that
      // make the gap legible rather than just asserted.
      observedGeneration: (pdb.status && pdb.status.observedGeneration) ?? null,
      generation: (pdb.metadata && pdb.metadata.generation) ?? null
    }));
}

function buildPdbCoverage({ deploymentsResult, statefulSetsResult, daemonSetsResult, pdbsResult }) {
  const workloads = [
    ...deploymentsResult.items.map(w => ({ obj: w, kind: 'Deployment' })),
    ...statefulSetsResult.items.map(w => ({ obj: w, kind: 'StatefulSet' })),
    ...daemonSetsResult.items.map(w => ({ obj: w, kind: 'DaemonSet' }))
  ].map(({ obj, kind }) => ({
    name: obj.metadata.name,
    namespace: obj.metadata.namespace,
    kind,
    replicas: effectiveReplicas(obj, kind),
    // kept for the selector join; not part of the shape returned to callers
    _template: obj
  }));

  const pdbs = pdbsResult.items;
  const covered = workloads.filter(w => pdbs.some(pdb => pdbCoversWorkload(pdb, { namespace: w.namespace, spec: w._template.spec })));

  const ownReads = [deploymentsResult, statefulSetsResult, daemonSetsResult, pdbsResult];
  const ownUnavailable = unavailableLabels(ownReads);
  const ownTruncated = truncatedLabels(ownReads);
  // A percentage computed over a partial read is not a percentage — and a percentage of
  // zero workloads is not one either, so both degrade to null rather than a misleading 0/0.
  const coveragePercent = (ownUnavailable.length === 0 && ownTruncated.length === 0 && workloads.length > 0)
    ? Math.round((covered.length / workloads.length) * 1000) / 10
    : null;

  return {
    totalWorkloads: workloads.length,
    coveredWorkloads: covered.length,
    coveragePercent,
    selectorUnmatched: selectorUnmatchedPdbs(pdbs, workloads.map(w => ({ namespace: w.namespace, spec: w._template.spec }))),
    drainBlockers: drainBlockingPdbs(pdbs),
    // Neither blocking nor known-safe. Carried beside the other two lists so an unevaluated PDB
    // is visible as unknown rather than silently absent from both.
    unreconciled: unreconciledPdbs(pdbs),
    unavailable: ownUnavailable,
    truncated: ownTruncated
  };
}

// --------------------------------------------------------------------------------------
// collect
// --------------------------------------------------------------------------------------

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, callFn?: typeof call}} ctx
 */
async function collect({ cluster, token, listFn = list, callFn = call }) {
  const baseCtx = { cluster, token };

  const [
    validatingWebhooksResult,
    mutatingWebhooksResult,
    vapResult,
    vapBindingsResult,
    constraintTemplatesResult,
    namespacesResult,
    endpointslicesResult,
    deploymentsResult,
    statefulSetsResult,
    daemonSetsResult,
    pdbsResult
  ] = await Promise.all([
    safeList(listFn, baseCtx, `/apis/${ADMISSION_GROUP}/${ADMISSION_VERSION}/validatingwebhookconfigurations`, 'validatingwebhookconfigurations'),
    safeList(listFn, baseCtx, `/apis/${ADMISSION_GROUP}/${ADMISSION_VERSION}/mutatingwebhookconfigurations`, 'mutatingwebhookconfigurations'),
    safeList(listFn, baseCtx, `/apis/${ADMISSION_GROUP}/${ADMISSION_VERSION}/validatingadmissionpolicies`, 'validatingadmissionpolicies'),
    safeList(listFn, baseCtx, `/apis/${ADMISSION_GROUP}/${ADMISSION_VERSION}/validatingadmissionpolicybindings`, 'validatingadmissionpolicybindings'),
    absentList(listFn, baseCtx, `/apis/${GATEKEEPER_TEMPLATES_GROUP}/${GATEKEEPER_TEMPLATES_VERSION}/constrainttemplates`, 'constrainttemplates', {
      group: GATEKEEPER_TEMPLATES_GROUP, version: GATEKEEPER_TEMPLATES_VERSION, callFn
    }),
    safeList(listFn, baseCtx, '/api/v1/namespaces', 'namespaces'),
    safeList(listFn, baseCtx, '/apis/discovery.k8s.io/v1/endpointslices', 'endpointslices'),
    safeList(listFn, baseCtx, '/apis/apps/v1/deployments', 'deployments'),
    safeList(listFn, baseCtx, '/apis/apps/v1/statefulsets', 'statefulsets'),
    safeList(listFn, baseCtx, '/apis/apps/v1/daemonsets', 'daemonsets'),
    safeList(listFn, baseCtx, '/apis/policy/v1/poddisruptionbudgets', 'poddisruptionbudgets')
  ]);

  // Only reached when constrainttemplates read cleanly (possibly a confirmed absent-zero);
  // a template read that failed outright short-circuits per-constraint reads entirely rather
  // than firing up to 25 more requests for a verdict that is already going to be 'unknown'.
  const constraintTemplateItems = constraintTemplatesResult.unavailable ? [] : constraintTemplatesResult.items;
  const constraintsByPlural = new Map();
  if (!constraintTemplatesResult.unavailable && constraintTemplateItems.length <= MAX_CONSTRAINT_TEMPLATES) {
    const reads = await Promise.all(constraintTemplateItems.map(async ct => {
      const plural = constraintPlural(ct);
      const result = await absentList(
        listFn, baseCtx, `/apis/${GATEKEEPER_CONSTRAINTS_GROUP}/${GATEKEEPER_CONSTRAINTS_VERSION}/${plural}`,
        `constraints:${plural}`,
        { group: GATEKEEPER_CONSTRAINTS_GROUP, version: GATEKEEPER_CONSTRAINTS_VERSION, callFn }
      );
      return [plural, result];
    }));
    for (const [plural, result] of reads) constraintsByPlural.set(plural, result);
  }

  const admission = buildAdmissionVerdict({
    constraintTemplateItems,
    constraintsByPlural,
    validatingWebhooks: validatingWebhooksResult.unavailable ? [] : validatingWebhooksResult.items,
    endpointslices: endpointslicesResult.unavailable ? [] : endpointslicesResult.items
  });
  // constrainttemplates itself failing (not just per-constraint reads) also means unknown —
  // buildAdmissionVerdict only sees per-constraint failures via constraintsByPlural.
  if (constraintTemplatesResult.unavailable) admission.policyEngineVerdict = 'unknown';

  const endpointslicesForWebhooks = endpointslicesResult.unavailable ? [] : endpointslicesResult.items;
  const failClosedWebhooks = [
    ...webhookEntries(validatingWebhooksResult.unavailable ? [] : validatingWebhooksResult.items, 'Validating', namespacesResult, endpointslicesForWebhooks),
    ...webhookEntries(mutatingWebhooksResult.unavailable ? [] : mutatingWebhooksResult.items, 'Mutating', namespacesResult, endpointslicesForWebhooks)
  ];

  const pdbCoverage = buildPdbCoverage({ deploymentsResult, statefulSetsResult, daemonSetsResult, pdbsResult });

  const nativePolicies = nativePolicyEntries(
    vapResult.unavailable ? [] : vapResult.items,
    vapBindingsResult.unavailable ? [] : vapBindingsResult.items,
    namespacesResult,
    { policiesRead: !vapResult.unavailable, bindingsRead: !vapBindingsResult.unavailable }
  );

  const readResults = [
    validatingWebhooksResult, mutatingWebhooksResult, vapResult, vapBindingsResult,
    constraintTemplatesResult, namespacesResult, endpointslicesResult,
    deploymentsResult, statefulSetsResult, daemonSetsResult, pdbsResult
  ];

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    summary: {
      policyEngineVerdict: admission.policyEngineVerdict,
      constraintTemplateCount: admission.constraintTemplateCount,
      validatingAdmissionPolicyCount: vapResult.items.length,
      validatingAdmissionPolicyBindingCount: vapBindingsResult.items.length,
      // `failClosedWebhooks` holds every webhook (the name predates widening it); this count is
      // only the ones whose effective failurePolicy is Fail, which is what the label claims.
      webhookCount: failClosedWebhooks.length,
      failClosedWebhookCount: failClosedWebhooks.filter(w => w.failurePolicy === 'Fail').length,
      validatingAdmissionPolicyEnforcingCount: nativePolicies.policies.filter(p => p.effectiveStatus === 'enforcing').length,
      validatingAdmissionPolicyUnboundCount: nativePolicies.policies.filter(p => p.effectiveStatus === 'unbound').length,
      activeOutageRiskCount: failClosedWebhooks.filter(w => w.risk === 'active-outage-risk').length,
      pdbCoveragePercent: pdbCoverage.coveragePercent,
      pdbDrainBlockerCount: pdbCoverage.drainBlockers.length,
      unavailable: unavailableLabels(readResults),
      truncated: truncatedLabels(readResults)
    },
    admission,
    failClosedWebhooks,
    nativePolicies,
    pdbCoverage,
    collectedAt: new Date().toISOString()
  };
}

export default {
  collect,
  // exported for tests / neighbouring collectors that may want the same primitives
  selectorMatches,
  effectiveAdmissionActions,
  backendStatus,
  failClosedRisk,
  effectiveWebhookStatus,
  readyEndpointsFor,
  webhookEntries,
  nativePolicyEntries,
  effectiveReplicas,
  pdbCoversWorkload,
  drainBlockingPdbs,
  unreconciledPdbs,
  constraintPlural
};
