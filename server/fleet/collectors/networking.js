/**
 * Networking collector: Kyma APIRules, Istio VirtualServices, Gateways, Ingresses, and Services.
 *
 * Provides a single unified view of how services are exposed, their TLS status,
 * gateways, and host routing across the fleet.
 *
 * ## Why this reads APIRule v2 and never v1beta1
 *
 * Kyma's API Gateway module has moved the APIRule CR to `gateway.kyma-project.io/v2`.
 * v1beta1 carries `deprecated: true` on the CRD with the warning "Version v1beta1 of APIRule
 * is no longer supported. Migrate to version v2.", it can no longer be created or modified,
 * and API Gateway release 3.10 disabled reconciliation of v1beta1 APIRules entirely —
 * 19 August 2026 on the fast channel, 2 September 2026 on the regular channel.
 *
 * All three versions (v1beta1, v2, v2alpha1) are still *served* by the CRD, so reading v2
 * returns every APIRule on the cluster regardless of which version it was created as: the
 * conversion webhook converts on read. There is therefore no reason to ever query v1beta1,
 * and a 404 on v2 must surface as such rather than trigger a hidden downgrade — an operator
 * who is silently served the deprecated version has no signal that anything is wrong.
 *
 * Making that true costs one extra request on the 404 path; see `readApiRules` below.
 *
 * ## The two conversion annotations
 *
 * Conversion is lossy in one direction. When an APIRule created as v1beta1 is read as v2:
 *
 *   - `gateway.kyma-project.io/original-version` records the version it was created as
 *     ("v1beta1", "v2alpha1" or "v2"). This is the only reliable way to tell what still
 *     needs migrating, because the served representation looks like v2 either way.
 *   - `gateway.kyma-project.io/v1beta1-spec` holds the original spec as a JSON string,
 *     written when the v1beta1 rules cannot be expressed in v2 (the `allow`, `noop` and
 *     `oauth2_introspection` handlers have no v2 equivalent).
 *
 * In that lossy case `.spec.rules` comes back **empty**, and the same conversion drops
 * `.spec.gateway` when the old `gateway.namespace` format was used, since v2 accepts only
 * `namespace/name`. Reading `.spec` alone would report an exposed, still-serving workload as
 * having no rules and no gateway, so this collector falls back to the stored annotation for
 * rules, host, gateway and service before concluding there is nothing there.
 *
 * Verified against kyma-project/api-gateway @ d30c5b2 (2026-09-08):
 * apis/gateway/v2/apirule_conversion.go:15-16 and docs/user/apirule-migration/.
 */
import k8sModule from '../k8s.js';
const { list, call, namespaceSegment } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, absentList, unavailableLabels, truncatedLabels } = safeListModule;

/** The version this collector reads. See the module note on why v1beta1 is never queried. */
const APIRULE_VERSION = 'v2';

/** The Kyma API Gateway API group. A constant, never interpolated from a request. */
const APIRULE_GROUP = 'gateway.kyma-project.io';

/** Operator-facing name for the APIRule read, in `summary.unavailable`. */
const APIRULES_LABEL = 'apirules';

/**
 * Reason code for "the cluster's API Gateway module does not serve the version we read".
 * Not one of safe-list.js's five codes: those describe a failed request, and this request
 * succeeded in saying no. The UI renders `detail` in preference to any code, so a code it
 * does not know still reaches the operator as a sentence.
 */
const UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION';

/** Records the version an APIRule was created as; absent on resources predating the webhook. */
const ORIGINAL_VERSION_ANNOTATION = 'gateway.kyma-project.io/original-version';

/** Holds the original v1beta1 spec as JSON when conversion to v2 would be lossy. */
const V1BETA1_SPEC_ANNOTATION = 'gateway.kyma-project.io/v1beta1-spec';

/**
 * Parse the stored-spec annotation. It is a JSON string written by the conversion webhook,
 * but it reaches us as opaque user-editable metadata, so malformed content is a real case
 * and must degrade to "no stored spec" rather than fail the whole cluster's collection.
 */
function parseStoredSpec(raw) {
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Access strategies of a v2 rule. v2 replaced the v1beta1 `accessStrategies` list with three
 * mutually exclusive fields, exactly one of which is set. `noAuth` is a *bool, so an explicit
 * `false` must not read as "no auth configured".
 */
function v2AccessStrategies(rule) {
  const strategies = [];
  if (rule.noAuth === true) strategies.push('noAuth');
  if (rule.jwt) strategies.push('jwt');
  if (rule.extAuth) strategies.push('extAuth');
  return strategies;
}

/**
 * Request mutations of a v2 rule. v1beta1's `mutators[].handler` list became a single
 * `request` object with `headers` and `cookies` maps; report which of the two are in use so
 * the field keeps the same string-array shape the UI renders.
 */
function v2Mutators(rule) {
  const request = rule.request || {};
  const mutators = [];
  if (request.headers && Object.keys(request.headers).length > 0) mutators.push('headers');
  if (request.cookies && Object.keys(request.cookies).length > 0) mutators.push('cookies');
  return mutators;
}

/** Normalise one rule from either schema into the single shape the dashboard renders. */
function normalizeRule(rule, fromStoredSpec) {
  return {
    path: rule.path || '/*',
    methods: rule.methods || ['GET'],
    accessStrategies: fromStoredSpec
      ? (rule.accessStrategies || []).map(a => a.handler || 'noop')
      : v2AccessStrategies(rule),
    mutators: fromStoredSpec
      ? (rule.mutators || []).map(m => m.handler)
      : v2Mutators(rule)
  };
}

/**
 * v2 moved the single `spec.host` string to a `spec.hosts` array capped at one entry.
 * Accept both so a spec read from the v1beta1 annotation parses through the same path.
 */
function firstHost(spec) {
  if (Array.isArray(spec.hosts) && spec.hosts.length > 0) return spec.hosts[0] || '';
  return spec.host || '';
}

/**
 * One APIRule, read as v2, with the stored v1beta1 spec consulted for anything conversion
 * dropped. Reports the version it was created as so an operator can see what is unmigrated.
 */
function parseApiRule(ar) {
  const metadata = ar.metadata || {};
  const annotations = metadata.annotations || {};
  const spec = ar.spec || {};
  const status = ar.status || {};

  const originalVersion = annotations[ORIGINAL_VERSION_ANNOTATION] || null;
  const storedSpec = parseStoredSpec(annotations[V1BETA1_SPEC_ANNOTATION]);

  // Empty `.spec.rules` on a resource that has a stored spec means conversion was lossy, not
  // that the workload is unexposed. Prefer the served spec; fall back only when it is empty.
  const servedRules = Array.isArray(spec.rules) ? spec.rules : [];
  const usingStoredSpec = servedRules.length === 0 && Array.isArray(storedSpec && storedSpec.rules) && storedSpec.rules.length > 0;
  const effectiveSpec = usingStoredSpec ? storedSpec : spec;
  const rules = usingStoredSpec ? storedSpec.rules : servedRules;

  // The same conversion that drops the rules also drops a `gateway.namespace`-format gateway,
  // so read these through the stored spec too rather than reporting a blank.
  const fallbackSpec = storedSpec || {};
  const service = effectiveSpec.service || fallbackSpec.service || {};
  const host = firstHost(effectiveSpec) || firstHost(fallbackSpec);
  const gateway = effectiveSpec.gateway || effectiveSpec.externalGateway || fallbackSpec.gateway || '';

  return {
    id: `${metadata.namespace}/${metadata.name}`,
    name: metadata.name,
    namespace: metadata.namespace,
    host,
    gateway,
    serviceName: service.name || '',
    servicePort: service.port || 0,
    // v2 reports `status.state`; the v1beta1 nested code is kept for a cluster whose
    // conversion webhook has not yet rewritten the status subresource.
    state: status.state || (status.APIRuleStatus && status.APIRuleStatus.code) || 'Unknown',
    paths: rules.map(r => normalizeRule(r, usingStoredSpec)),
    // --- migration visibility ---
    /** The version this collector read the resource as. Always v2. */
    servedVersion: APIRULE_VERSION,
    /** The version it was created as, per annotation; null on resources predating it. */
    originalVersion,
    /**
     * True only for v1beta1. v2alpha1 converts to v2 losslessly and is still reconciled;
     * v1beta1 is the version whose reconciliation release 3.10 switched off, so it is the
     * one that carries an actual operational consequence. The raw `originalVersion` is
     * reported alongside for anyone who wants the finer distinction.
     */
    needsMigration: originalVersion === 'v1beta1',
    /** Whether the rules above came from `.spec` or from the stored-spec annotation. */
    specSource: usingStoredSpec ? 'v1beta1-annotation' : 'spec',
    createdAt: metadata.creationTimestamp || null
  };
}

/**
 * A safeList-shaped result that says "we could not read this", with a reason and a sentence.
 *
 * `truncated: false` is carried explicitly rather than left off: this is the one result in the
 * collector that safeList did not build, and `truncatedLabels` reading `undefined` off it
 * happens to be right today only by accident. A read that did not happen has no items for a
 * ceiling to have cut short.
 */
function unreadable(reason, detail) {
  return { label: APIRULES_LABEL, items: [], unavailable: true, reason, detail, truncated: false };
}

/**
 * Read APIRules as v2, telling the two kinds of 404 apart.
 *
 * `safeList` classifies every 404 as a true zero, which is right for an optional CRD: if
 * cert-manager is not installed, zero certificates is the honest count. For APIRules it is
 * right only half the time, because a 404 on the v2 path means one of two things:
 *
 *   - the API Gateway module is not installed at all    -> 0 really is the answer
 *   - the module is installed but older than v2 support -> the cluster has APIRules and we
 *     simply cannot see them. `kubectl get apirules` lists them while the console reports
 *     none, with nothing in `unavailable` to say otherwise. That is the confident zero the
 *     whole degradation contract exists to prevent.
 *
 * `absentList` (safe-list.js) is what actually runs the group-discovery probe and only on
 * the empty-result path, so the happy path still costs exactly one request. This function
 * exists on top of it because absentList's three-way {false, true, null} split is not quite
 * this read's vocabulary: "installed but too old to serve v2" is a fourth, APIRule-specific
 * case that absentList has no way to name, so it is reconstructed here from the group body
 * absentList's probe already fetched — no second copy of the discovery logic.
 */
async function readApiRules({ baseCtx, listFn, callFn, nsQuery }) {
  const path = `/apis/${APIRULE_GROUP}/${APIRULE_VERSION}/${nsQuery}apirules`;
  const result = await absentList(listFn, baseCtx, path, APIRULES_LABEL, {
    group: APIRULE_GROUP,
    version: APIRULE_VERSION,
    callFn
  });

  // A real list success, or a genuine failure unrelated to 404: nothing to reinterpret.
  if (result.unavailable || result.absent === false && result.items.length > 0) return result;
  // absentList confirmed the group itself is 404: the module is not installed, 0 is honest.
  if (result.absent === true) return { ...result, absent: undefined, absentEvidence: undefined };
  // absentList confirmed the group serves v2 and the list is genuinely empty.
  if (result.absent === false) return { ...result, absent: undefined, absentEvidence: undefined };

  // result.absent === null: the group probe answered but did not confirm v2 is served (either
  // it serves other versions, or the probe could not be evaluated, or it contradicts the
  // 404) — not a verified zero.
  if (result.absentProbeReason) {
    return unreadable(result.absentProbeReason, `could not tell whether ${APIRULE_GROUP} serves ${APIRULE_VERSION}: ${result.absentEvidence}`);
  }
  if (result.absentContradiction) {
    return unreadable('UPSTREAM', result.absentEvidence);
  }
  return unreadable(
    UNSUPPORTED_VERSION,
    `${result.absentEvidence || `${APIRULE_GROUP} does not serve ${APIRULE_VERSION}`} — its API Gateway ` +
      `module predates ${APIRULE_VERSION}, so any APIRules on it cannot be read and this is not a zero`
  );
}

/**
 * @param {{cluster: object, token: string, namespace?: string, listFn?: typeof list,
 *          callFn?: typeof call}} ctx
 * @returns {Promise<object>}
 */
async function collect({ cluster, token, namespace, listFn = list, callFn = call }) {
  const nsQuery = namespaceSegment(namespace);
  const baseCtx = { cluster, token };

  const [apirules, virtualservices, gateways, ingresses, services] = await Promise.all([
    readApiRules({ baseCtx, listFn, callFn, nsQuery }),
    safeList(listFn, baseCtx, `/apis/networking.istio.io/v1beta1/${nsQuery}virtualservices`, 'virtualservices'),
    safeList(listFn, baseCtx, `/apis/networking.istio.io/v1beta1/${nsQuery}gateways`, 'istio-gateways'),
    safeList(listFn, baseCtx, `/apis/networking.k8s.io/v1/${nsQuery}ingresses`, 'ingresses'),
    safeList(listFn, baseCtx, `/api/v1/${nsQuery}services`, 'services')
  ]);

  // Parse APIRules (Kyma API Gateway)
  const apiruleItems = apirules.items.map(parseApiRule);

  // Roll the per-rule versions up so the console can show what is left to migrate without
  // walking the list itself. `unknown` counts resources with no original-version annotation.
  const byVersion = { v1beta1: 0, v2alpha1: 0, v2: 0, unknown: 0 };
  for (const item of apiruleItems) {
    const key = item.originalVersion;
    if (key && Object.prototype.hasOwnProperty.call(byVersion, key)) byVersion[key] += 1;
    else byVersion.unknown += 1;
  }

  // Parse Istio VirtualServices
  const vsItems = virtualservices.items.map(vs => {
    const spec = vs.spec || {};
    const hosts = spec.hosts || [];
    const httpRules = (spec.http || []).flatMap(h =>
      (h.route || []).map(r => ({
        destinationHost: (r.destination && r.destination.host) || '',
        destinationPort: (r.destination && r.destination.port && r.destination.port.number) || null,
        weight: r.weight || 100
      }))
    );

    return {
      id: `${vs.metadata.namespace}/${vs.metadata.name}`,
      name: vs.metadata.name,
      namespace: vs.metadata.namespace,
      hosts,
      gateways: spec.gateways || [],
      routes: httpRules,
      createdAt: vs.metadata.creationTimestamp || null
    };
  });

  // Parse Ingresses
  const ingressItems = ingresses.items.map(ing => {
    const spec = ing.spec || {};
    const rules = (spec.rules || []).map(r => ({
      host: r.host || '*',
      paths: ((r.http && r.http.paths) || []).map(p => ({
        path: p.path || '/',
        pathType: p.pathType || 'ImplementationSpecific',
        backendService: (p.backend && p.backend.service && p.backend.service.name) || ''
      }))
    }));
    const tls = (spec.tls || []).map(t => ({
      hosts: t.hosts || [],
      secretName: t.secretName || null
    }));

    return {
      id: `${ing.metadata.namespace}/${ing.metadata.name}`,
      name: ing.metadata.name,
      namespace: ing.metadata.namespace,
      rules,
      tls,
      ingressClassName: spec.ingressClassName || null,
      createdAt: ing.metadata.creationTimestamp || null
    };
  });

  // Parse Services overview
  const serviceItems = services.items.map(svc => {
    const spec = svc.spec || {};
    return {
      name: svc.metadata.name,
      namespace: svc.metadata.namespace,
      type: spec.type || 'ClusterIP',
      clusterIP: spec.clusterIP || null,
      ports: (spec.ports || []).map(p => ({
        name: p.name || null,
        port: p.port,
        targetPort: p.targetPort,
        protocol: p.protocol || 'TCP'
      })),
      createdAt: svc.metadata.creationTimestamp || null
    };
  });

  return {
    cluster: { id: cluster.id, displayName: cluster.displayName || cluster.id, env: cluster.env || 'unknown' },
    summary: {
      apirulesCount: apiruleItems.length,
      virtualServicesCount: vsItems.length,
      gatewaysCount: gateways.items.length,
      ingressesCount: ingressItems.length,
      servicesCount: serviceItems.length,
      /** Which APIRule version each resource was created as. */
      apirulesByVersion: byVersion,
      /** How many APIRules are still v1beta1 and therefore no longer reconciled. */
      apirulesNeedingMigration: apiruleItems.filter(a => a.needsMigration).length,
      /**
       * Why `apirulesCount` is not a number to trust, when it is not.
       *
       * `unavailable` below is a list of bare labels and cannot say *why* — and for this
       * read the why is the whole point: "the API Gateway module is absent" and "the
       * module is too old to serve v2" both arrive as a 404 and mean opposite things.
       * Shaped as the UI's `UnavailableEntry` object so it can be fed straight into
       * `unavailableScope`. Null whenever the read succeeded.
       */
      apirulesUnavailable: apirules.unavailable
        ? { label: apirules.label, reason: apirules.reason, detail: apirules.detail }
        : null,
      /**
       * Labels of the reads that could not be performed. Non-empty means the counts above
       * are floors, not totals — a 403 is not a zero.
       */
      unavailable: unavailableLabels([apirules, virtualservices, gateways, ingresses, services]),
      /**
       * Labels of the reads that answered but stopped at the client's paging ceiling. Distinct
       * from `unavailable` in the direction of the error: the items behind a truncated read
       * are real, so the exposure this page describes is understated rather than fabricated —
       * a host that is not listed here may still be routing.
       */
      truncated: truncatedLabels([apirules, virtualservices, gateways, ingresses, services])
    },
    apirules: apiruleItems,
    virtualservices: vsItems,
    ingresses: ingressItems,
    services: serviceItems,
    collectedAt: new Date().toISOString()
  };
}

export default { collect };
