/**
 * Platform / aggregated-API health collector.
 *
 * G1 — Aggregated APIService availability. `apiregistration.k8s.io/v1/apiservices` is a
 * built-in, cluster-scoped, always-registered API on every real Kubernetes cluster (it is
 * how the apiserver itself tracks metrics-server, custom.metrics and any other extension
 * API server). A 404 here is therefore never "the feature is absent" the way a CRD's 404
 * is — it means either the fleet-reader role lost `list` on this resource (re-onboarding
 * fixes it: `npm run fleet:onboard`) or something is badly wrong with the API server, and
 * `requiredList` (safe-list.js) is what encodes that distinction: a 404 comes back
 * `unavailable: true` rather than as a trusted zero. Counts are `null`, never `0`, whenever
 * the read did not happen — a `0` here would read as "no aggregated APIs registered",
 * which is not a state a real cluster can be in.
 *
 * Verified against the real fleet cluster measured for this build (2026-09-08): 82
 * APIServices total, 2 aggregated (spec.service set, i.e. not `Local`), both `Available`.
 * So on a healthy read this feature is unremarkable and all-green — do not mistake the
 * boring fixture shapes in platform.test.js for an undertested feature; that boring shape
 * IS the real one. The only way this page has content is a fleet where a token has lapsed,
 * in which case every number here is an em-dash and `unavailable` names which read failed.
 *
 * G2 — served-API self-audit. This collector's own reads depend on
 * `apiregistration.k8s.io/v1` being served; a k8s upgrade that renames or removes it would
 * silently start returning 0 aggregated services rather than an error, because a stale
 * client can still successfully call a *removed* version's list path right up until the
 * apiserver actually drops it — the failure mode this collector exists to catch would then
 * be hidden by the very code meant to catch it for other resources. `auditServedVersions`
 * rides the same `GET /apis` discovery call the rest of the fleet already pays for (Wave 0's
 * `absentList` probes `/apis/<group>`; this reads the flat `/apis` list once instead, since
 * it is checking several groups at once and a probe per group would be four requests for
 * one boolean each). This is deliberately NOT the F1 discovery oracle w1-observability is
 * building for monitoring.coreos.com / telemetry.kyma-project.io — that is a general "is
 * this Kyma module installed" answer; this is a narrow "are the two groups THIS collector
 * itself reads still served the way it expects", and duplicating the general oracle here
 * would be the second independent implementation the task says not to write. If a second
 * caller ever needs the general form, it belongs next to that oracle, not here.
 */
import k8sModule from '../k8s.js';
const { list, call } = k8sModule;
import safeListModule from './safe-list.js';
const { requiredList, unavailableLabels, truncatedLabels } = safeListModule;
import fanoutModule from '../fanout.js';
const { publicCluster } = fanoutModule;

const APISERVICES_LABEL = 'apiservices';
const CERTIFICATES_GROUP = 'cert.gardener.cloud';
const CERTIFICATES_VERSION = 'v1alpha1';

/**
 * A 403 on a resource every fleet-reader grant is supposed to cover almost always means the
 * role bound to this cluster predates the resource — see MEMORY's
 * `fleet-reader-role-drifted-behind-code.md` — so the fix is a re-onboard, not a bug report.
 * Every other reason code is left as `requiredList`/`detailOf` produced it.
 */
function withOnboardingHint(result) {
  if (result.reason !== 'FORBIDDEN') return result;
  return { ...result, detail: `${result.detail} — re-run npm run fleet:onboard to refresh this cluster's fleet-reader role` };
}

/** The two groups this collector's own reads depend on; see the G2 doc comment above. */
const AUDITED_GROUPS = {
  'apiregistration.k8s.io': 'v1',
  [CERTIFICATES_GROUP]: CERTIFICATES_VERSION
};

/**
 * Confirm the group/version pairs this collector reads are still served, from one `/apis`
 * call. Returns `null` (not a failure) when the probe itself could not be made — an
 * unaudited cluster is not the same claim as a confirmed-drifted one, and the caller must
 * not conflate the two.
 *
 * @param {typeof call} callFn
 * @param {{cluster: object, token: string}} baseCtx
 * @returns {Promise<{checked: boolean, drifted: string[], detail: string|null}>}
 */
async function auditServedVersions(callFn, baseCtx) {
  let body;
  try {
    body = await callFn({ ...baseCtx, path: '/apis' });
  } catch {
    return { checked: false, drifted: [], detail: 'could not reach /apis to audit served versions' };
  }
  const groups = (body && Array.isArray(body.groups)) ? body.groups : [];
  const served = new Map(groups.map(g => [g.name, (g.versions || []).map(v => v.version)]));

  const drifted = [];
  for (const [group, version] of Object.entries(AUDITED_GROUPS)) {
    const versions = served.get(group);
    if (!versions || !versions.includes(version)) drifted.push(`${group}/${version}`);
  }
  return {
    checked: true,
    drifted,
    detail: drifted.length > 0
      ? `no longer served: ${drifted.join(', ')} — this collector's reads may be stale`
      : null
  };
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, callFn?: typeof call}} ctx
 */
async function collect(ctx) {
  const listFn = ctx.listFn || list;
  const callFn = ctx.callFn || call;
  const baseCtx = { cluster: ctx.cluster, token: ctx.token };

  const [apiservicesRaw, audit] = await Promise.all([
    requiredList(APISERVICES_LABEL, () => listFn({ ...baseCtx, path: '/apis/apiregistration.k8s.io/v1/apiservices' })),
    auditServedVersions(callFn, baseCtx)
  ]);
  const apiservicesResult = withOnboardingHint(apiservicesRaw);

  const apiservices = apiservicesResult.items.map(a => {
    const meta = a.metadata || {};
    const spec = a.spec || {};
    const status = a.status || {};
    const availableCond = (status.conditions || []).find(c => c.type === 'Available');
    return {
      name: meta.name,
      group: spec.group || null,
      version: spec.version || null,
      // A built-in (non-aggregated) API has no `spec.service` at all; Kubernetes marks
      // that kind `Local` in `kubectl get apiservices` output, and this mirrors it.
      isAggregated: Boolean(spec.service),
      serviceRef: spec.service ? `${spec.service.namespace}/${spec.service.name}` : 'Local',
      isAvailable: availableCond ? availableCond.status === 'True' : null,
      availableReason: availableCond ? (availableCond.reason || null) : null
    };
  });

  const aggregated = apiservices.filter(a => a.isAggregated);
  const unreadable = apiservicesResult.unavailable;

  return {
    cluster: publicCluster(ctx.cluster),
    summary: {
      // Every count is null rather than 0 when the read failed — see the module doc.
      totalApiServices: unreadable ? null : apiservices.length,
      aggregatedApiServices: unreadable ? null : aggregated.length,
      unavailableAggregated: unreadable ? null : aggregated.filter(a => a.isAvailable === false).length,
      servedVersionDrift: audit.checked ? audit.drifted : null,
      unavailable: unavailableLabels([apiservicesResult]),
      truncated: truncatedLabels([apiservicesResult])
    },
    apiservices,
    servedVersionAudit: audit
  };
}

export default { collect, auditServedVersions, AUDITED_GROUPS };
