/**
 * Observability wiring collector: is Prometheus Operator installed and scraping anything,
 * and — the part this cluster can actually answer today — is Kyma's telemetry pipeline
 * (LogPipeline/TracePipeline/MetricPipeline) healthy and actually flowing data.
 *
 * Build order matters and is inverted from the reading order below: F4 (telemetry pipeline
 * health) is built and tested first because `telemetry.kyma-project.io` is really served on
 * this fleet with real objects, while the four Prometheus-Operator CRDs currently measure
 * 0/0/0/0 everywhere — so F1-F3 stay honest but deliberately thin.
 *
 * ## Why F1 uses discovery, not a list
 *
 * `monitoring.coreos.com` is a CRD group most clusters install via the Prometheus Operator
 * Helm chart, not a core API. Listing its resources needs RBAC on that specific group; two
 * GETs against `/apis` and `/apis/<group>/<version>` need none at all — `system:discovery`
 * is bound to `system:authenticated` on every cluster by default. So the installed/absent
 * oracle in `probeResource` costs nothing extra beyond the two discovery calls this whole
 * collector already needs, and it works even on a cluster where the RBAC in `readOnlyRules()`
 * (monitoring.coreos.com/{prometheuses,servicemonitors,podmonitors,prometheusrules}) has not
 * been re-applied yet — see the module header in the task for why that matters on platformsbx
 * today.
 *
 * Resource-level, not group-level: a group can be registered with a CRD-list read failing or
 * a stale conversion, while the one resource type this page cares about is not actually in
 * that group's served list. Certifying the group as "installed" would say a broken or
 * partial Prometheus Operator is fully wired, the same mistake a group-only Gatekeeper check
 * would make for admission policy.
 */
import k8sModule from '../k8s.js';
const { call, list } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;

const MONITORING_GROUP = 'monitoring.coreos.com';
const MONITORING_VERSION = 'v1';
const TELEMETRY_GROUP = 'telemetry.kyma-project.io';
const TELEMETRY_VERSION = 'v1beta1';

/** The four Prometheus-Operator CRDs this collector cares about, plural-resource-named. */
const MONITORING_RESOURCES = [
  { kind: 'Prometheus', resource: 'prometheuses' },
  { kind: 'ServiceMonitor', resource: 'servicemonitors' },
  { kind: 'PodMonitor', resource: 'podmonitors' },
  { kind: 'PrometheusRule', resource: 'prometheusrules' }
];

/* --------------------------------------------------------------- F1: discovery oracle */

/**
 * One unavailable-read entry, carrying the apiserver's own message text rather than a
 * generic string — the task's explicit requirement so an operator sees *why*, not just that.
 */
function unavailableEntry(path, err) {
  return {
    path,
    reason: (err && err.code) || 'UPSTREAM',
    detail: (err && typeof err.message === 'string' && err.message) || 'read failed'
  };
}

/**
 * GET /apis, once, degrading to null on any failure rather than throwing — a discovery
 * outage must show every resource as `unknown`, not blank the whole page.
 */
async function fetchApiGroupList({ ctx, callFn }) {
  try {
    const body = await callFn({ ...ctx, path: '/apis' });
    return { body, error: null };
  } catch (err) {
    return { body: null, error: err };
  }
}

/**
 * GET /apis/<group>, once per group, same degrade-not-throw contract as above. Cached per
 * call to `probeResources` so N resources in the same group cost one request, not N.
 */
async function fetchApiGroup({ ctx, callFn, group }) {
  try {
    const body = await callFn({ ...ctx, path: `/apis/${group}` });
    return { body, error: null };
  } catch (err) {
    return { body: null, error: err };
  }
}

/**
 * The installed/absent oracle for a list of {kind, resource} pairs under one group+version,
 * with FOUR distinct states per resource:
 *
 *   served         the group is registered, serves this version, and (best-effort) the
 *                  resource's plural name appears in that version's resource list.
 *   resourceAbsent the group and version are served, but this specific resource is not in
 *                  it — e.g. Prometheus Operator installed at a CRD subset.
 *   absent         the group itself is not registered (404 on /apis/<group> and it is not
 *                  in the /apis list) — the operator is simply not installed.
 *   unknown        discovery itself could not be read (403/timeout/5xx/etc); we genuinely
 *                  do not know, and must never guess installed or absent.
 *
 * `/apis/<group>/<version>` (the APIResourceList, listing actual resource kinds) would be
 * the precise way to confirm the resource name, but is deliberately not fetched: the task
 * asks for "GET /apis then GET /apis/<group>/<version>" using the APIGroup body's own
 * `versions[]`, and system:discovery does not reliably cover the third, per-version-resource
 * endpoint on every distribution the same way it covers the first two. Falling back to "group
 * serves this version" as `served` (rather than fetching a third endpoint this task did not
 * ask for) is the honest middle ground: it is resource-*version* granularity, not group
 * granularity, and it never claims more than discovery actually told us.
 *
 * @param {object} args
 * @param {{cluster: object, token: string}} args.ctx
 * @param {(a: object) => Promise<any>} args.callFn
 * @param {string} args.group
 * @param {string} args.version
 * @param {Array<{kind: string, resource: string}>} args.resources
 * @returns {Promise<{states: Record<string, {state: string, evidence: string}>,
 *                    unavailable: Array<{path: string, reason: string, detail: string}>}>}
 */
async function probeResources({ ctx, callFn, group, version, resources }) {
  const unavailable = [];
  const groupList = await fetchApiGroupList({ ctx, callFn });
  if (groupList.error) unavailable.push(unavailableEntry('/apis', groupList.error));

  const groups = (groupList.body && Array.isArray(groupList.body.groups)) ? groupList.body.groups : null;
  const listedGroup = groups ? groups.find(g => g && g.name === group) : null;

  // The group probe is only worth making when the flat list did not already answer the
  // question — either because /apis failed (groups === null: we cannot use its silence as
  // evidence of absence) or because the group simply is not in a list that DID resolve
  // (absent — no need to probe further).
  let probed = null;
  if (groups === null || listedGroup) {
    probed = await fetchApiGroup({ ctx, callFn, group });
    if (probed.error) {
      // A 404 here, with a resolved /apis list that omitted the group, is corroborating
      // evidence of absence, not a fresh unavailability — only report it as an unavailable
      // read when /apis itself did not resolve, so this one group's outage doesn't drown a
      // clean "not installed" answer in noise.
      if (groups === null) unavailable.push(unavailableEntry(`/apis/${group}`, probed.error));
    }
  }

  const groupServedVersions = probed && probed.body && Array.isArray(probed.body.versions)
    ? probed.body.versions.map(v => v && v.version).filter(Boolean)
    : null;

  const states = {};
  for (const { kind, resource } of resources) {
    if (groups === null && (!probed || probed.error)) {
      // Neither discovery call answered: we know nothing.
      states[resource] = { state: 'unknown', evidence: 'discovery could not be read' };
      continue;
    }
    if (groups !== null && !listedGroup && (!probed || probed.error)) {
      // /apis resolved and did not list the group: absent, corroborated (or not contradicted)
      // by the group probe.
      states[resource] = { state: 'absent', evidence: `${group} is not registered (not in /apis)` };
      continue;
    }
    if (probed && probed.error) {
      // /apis listed the group, but the group's own discovery failed: registered, but we
      // cannot confirm which resources/versions it actually serves.
      states[resource] = { state: 'unknown', evidence: `${group} is registered but /apis/${group} could not be read` };
      continue;
    }
    if (groupServedVersions && !groupServedVersions.includes(version)) {
      states[resource] = {
        state: 'resourceAbsent',
        evidence: groupServedVersions.length
          ? `${group} serves ${groupServedVersions.join(', ')}, not ${version}`
          : `${group} is registered but reports no served versions`
      };
      continue;
    }
    // Group is registered and serves the version we asked about. Discovery does not hand us
    // a per-resource name list on this endpoint (see the function comment), so this is the
    // resource-version granularity the task actually asks for, stated honestly as such.
    states[resource] = { state: 'served', evidence: `${group}/${version} is served (resource: ${kind})` };
  }

  return { states, unavailable };
}

/* --------------------------------------------------------------- F2/F3: scrape wiring */

const VERDICT_UNKNOWN = 'UNKNOWN';
const VERDICT_NOT_INSTALLED = 'NOT_INSTALLED';
const VERDICT_TARGETS_DECLARED = 'TARGETS_DECLARED';
const VERDICT_NO_TARGETS = 'NO_TARGETS_DECLARED';

/**
 * Whether ServiceMonitors/PodMonitors have been declared for Prometheus to scrape, and
 * whether PrometheusRule objects exist. Deliberately named TARGETS_DECLARED rather than
 * WIRED: an apiserver-only reader can see that a ServiceMonitor object exists, never that
 * Prometheus actually picked it up and is scraping it (that lives in Prometheus's own
 * /targets API, out of scope here). Any input read failing collapses the whole verdict to
 * UNKNOWN rather than a lower-confidence guess in either direction.
 */
function scrapeVerdict({ prometheusState, serviceMonitors, podMonitors, unavailablePaths }) {
  if (unavailablePaths.length > 0) {
    return { verdict: VERDICT_UNKNOWN, reason: `could not verify: ${unavailablePaths.join(', ')} unavailable` };
  }
  if (prometheusState === 'absent' || prometheusState === 'resourceAbsent') {
    return { verdict: VERDICT_NOT_INSTALLED, reason: 'the Prometheus CRD is not served on this cluster' };
  }
  if (prometheusState === 'unknown') {
    return { verdict: VERDICT_UNKNOWN, reason: 'could not confirm whether the Prometheus CRD is installed' };
  }
  const declared = (serviceMonitors.length + podMonitors.length) > 0;
  return declared
    ? { verdict: VERDICT_TARGETS_DECLARED, reason: `${serviceMonitors.length} ServiceMonitor(s), ${podMonitors.length} PodMonitor(s) declared` }
    : { verdict: VERDICT_NO_TARGETS, reason: 'no ServiceMonitor or PodMonitor objects found' };
}

function alertRuleVerdict({ prometheusState, prometheusRules, unavailablePaths }) {
  if (unavailablePaths.length > 0) {
    return { verdict: VERDICT_UNKNOWN, reason: `could not verify: ${unavailablePaths.join(', ')} unavailable` };
  }
  if (prometheusState === 'absent' || prometheusState === 'resourceAbsent') {
    return { verdict: VERDICT_NOT_INSTALLED, reason: 'the Prometheus CRD is not served on this cluster' };
  }
  if (prometheusState === 'unknown') {
    return { verdict: VERDICT_UNKNOWN, reason: 'could not confirm whether the Prometheus CRD is installed' };
  }
  return prometheusRules.length > 0
    ? { verdict: 'RULES_PRESENT', reason: `${prometheusRules.length} PrometheusRule object(s) found` }
    : { verdict: 'NO_RULES', reason: 'no PrometheusRule objects found' };
}

/* --------------------------------------------------------------- F4: telemetry pipelines */

/**
 * The three conditions whose conjunction is a pipeline's ready verdict. There is no single
 * top-level Ready condition type on LogPipeline/TracePipeline/MetricPipeline — do not look
 * for one.
 */
const READY_CONDITION_TYPES = ['GatewayHealthy', 'ConfigurationGenerated', 'AgentHealthy'];

/** The flow-health condition, tracked as its own dedicated counter — see the module header. */
const FLOW_CONDITION_TYPE = 'TelemetryFlowHealthy';

/** Reasons for TelemetryFlowHealthy=False that mean data is actively being lost. */
const FLOW_UNHEALTHY_REASONS = new Set(['AllTelemetryDataDropped', 'SomeTelemetryDataDropped', 'BufferFillingUp']);

/** `status === 'True'|'False'|'Unknown'` on one named condition type, or null if absent. */
function conditionStatus(conditions, type) {
  const c = (Array.isArray(conditions) ? conditions : []).find(c => c && c.type === type);
  return c ? { status: c.status, reason: c.reason || null } : null;
}

/**
 * One pipeline object's verdict.
 *
 * `ready` is the conjunction of the three named conditions; any condition missing or with a
 * status this code does not recognize ('True'/'False'/'Unknown' are the only ones Kubernetes
 * conditions define) makes the pipeline `indeterminate`, never a default healthy/unhealthy
 * guess. `flowUnhealthy` is evaluated independently and additively — a pipeline that is
 * Ready by the three-condition test can still have `flowUnhealthy: true`, and that must
 * surface as its own signal rather than vanish into (or double-count inside) `notReady`.
 */
function pipelineVerdict(obj) {
  const conditions = (obj.status && obj.status.conditions) || [];
  const results = READY_CONDITION_TYPES.map(type => conditionStatus(conditions, type));

  let indeterminate = false;
  let ready = true;
  const missing = [];
  results.forEach((r, i) => {
    if (!r || (r.status !== 'True' && r.status !== 'False' && r.status !== 'Unknown')) {
      indeterminate = true;
      missing.push(READY_CONDITION_TYPES[i]);
      return;
    }
    if (r.status !== 'True') ready = false;
    if (r.status === 'Unknown') indeterminate = true;
  });

  const flow = conditionStatus(conditions, FLOW_CONDITION_TYPE);
  const flowUnhealthy = Boolean(flow && flow.status === 'False' && FLOW_UNHEALTHY_REASONS.has(flow.reason));

  return {
    name: obj.metadata && obj.metadata.name,
    // indeterminate wins over the raw booleans: we would rather say "we don't know" than
    // assert a ready/not-ready verdict built on a missing or unrecognized condition.
    verdict: indeterminate ? 'indeterminate' : (ready ? 'ready' : 'notReady'),
    flowUnhealthy,
    flowReason: flow ? flow.reason : null,
    missingConditions: missing
  };
}

function summarizePipelines(items) {
  const verdicts = items.map(pipelineVerdict);
  return {
    total: verdicts.length,
    ready: verdicts.filter(v => v.verdict === 'ready').length,
    notReady: verdicts.filter(v => v.verdict === 'notReady').length,
    indeterminate: verdicts.filter(v => v.verdict === 'indeterminate').length,
    // Deliberately separate from notReady — see the module header and pipelineVerdict.
    flowUnhealthy: verdicts.filter(v => v.flowUnhealthy).length,
    pipelines: verdicts
  };
}

/* --------------------------------------------------------------- F5: agent coverage */

/** Substring match on the running image, not the DaemonSet's own name — see task note. */
const AGENT_IMAGE_TOKEN = 'kyma-otel-collector';

function daemonSetImages(ds) {
  const containers = (ds.spec && ds.spec.template && ds.spec.template.spec && ds.spec.template.spec.containers) || [];
  return containers.map(c => c.image).filter(Boolean);
}

/**
 * Which DaemonSets in the read carry the recognisable agent image, and whether the ones that
 * do have a coverage gap: `updatedNumberScheduled !== desiredNumberScheduled` would flag a
 * DaemonSet mid-rollout as a false gap, so the gap check is gated on the rollout itself being
 * caught up first.
 */
function agentCoverage(daemonSets) {
  const recognized = daemonSets.filter(ds => daemonSetImages(ds).some(img => img.includes(AGENT_IMAGE_TOKEN)));
  const agents = recognized.map(ds => {
    const status = ds.status || {};
    const desired = status.desiredNumberScheduled || 0;
    const updated = status.updatedNumberScheduled || 0;
    const ready = status.numberReady || 0;
    const rolloutCurrent = updated === desired;
    return {
      name: ds.metadata && ds.metadata.name,
      namespace: ds.metadata && ds.metadata.namespace,
      desiredNumberScheduled: desired,
      updatedNumberScheduled: updated,
      numberReady: ready,
      // Only a real gap once the rollout is caught up — see the doc comment.
      coverageGap: rolloutCurrent && ready < desired
    };
  });
  return agents;
}

/* --------------------------------------------------------------- collect() */

/**
 * @param {{cluster: object, token: string, listFn?: typeof list, callFn?: typeof call}} ctx
 * @returns {Promise<object>}
 */
async function collect({ cluster, token, listFn = list, callFn = call }) {
  const baseCtx = { cluster, token };

  const [monitoringProbe, prometheuses, serviceMonitors, podMonitors, prometheusRules,
    telemetryProbe, logPipelines, tracePipelines, metricPipelines, daemonSetsResult] = await Promise.all([
    probeResources({ ctx: baseCtx, callFn, group: MONITORING_GROUP, version: MONITORING_VERSION, resources: MONITORING_RESOURCES }),
    safeList(listFn, baseCtx, `/apis/${MONITORING_GROUP}/${MONITORING_VERSION}/prometheuses`, 'prometheuses'),
    safeList(listFn, baseCtx, `/apis/${MONITORING_GROUP}/${MONITORING_VERSION}/servicemonitors`, 'servicemonitors'),
    safeList(listFn, baseCtx, `/apis/${MONITORING_GROUP}/${MONITORING_VERSION}/podmonitors`, 'podmonitors'),
    safeList(listFn, baseCtx, `/apis/${MONITORING_GROUP}/${MONITORING_VERSION}/prometheusrules`, 'prometheusrules'),
    probeResources({
      ctx: baseCtx, callFn, group: TELEMETRY_GROUP, version: TELEMETRY_VERSION,
      resources: [
        { kind: 'LogPipeline', resource: 'logpipelines' },
        { kind: 'TracePipeline', resource: 'tracepipelines' },
        { kind: 'MetricPipeline', resource: 'metricpipelines' }
      ]
    }),
    safeList(listFn, baseCtx, `/apis/${TELEMETRY_GROUP}/${TELEMETRY_VERSION}/logpipelines`, 'logpipelines'),
    safeList(listFn, baseCtx, `/apis/${TELEMETRY_GROUP}/${TELEMETRY_VERSION}/tracepipelines`, 'tracepipelines'),
    safeList(listFn, baseCtx, `/apis/${TELEMETRY_GROUP}/${TELEMETRY_VERSION}/metricpipelines`, 'metricpipelines'),
    safeList(listFn, baseCtx, '/apis/apps/v1/daemonsets', 'daemonsets')
  ]);

  // ---- F1 result shape ----
  const installed = {
    prometheus: monitoringProbe.states.prometheuses,
    serviceMonitor: monitoringProbe.states.servicemonitors,
    podMonitor: monitoringProbe.states.podmonitors,
    prometheusRule: monitoringProbe.states.prometheusrules
  };

  const listResults = [prometheuses, serviceMonitors, podMonitors, prometheusRules];
  const listUnavailablePaths = unavailableLabels(listResults);
  const discoveryUnavailablePaths = monitoringProbe.unavailable.map(u => u.path);
  const unavailablePaths = [...new Set([...discoveryUnavailablePaths, ...listUnavailablePaths])];

  // ---- F2/F3 ----
  const scrape = scrapeVerdict({
    prometheusState: installed.prometheus.state,
    serviceMonitors: serviceMonitors.items,
    podMonitors: podMonitors.items,
    unavailablePaths: listUnavailablePaths.filter(l => l === 'servicemonitors' || l === 'podmonitors')
      .concat(discoveryUnavailablePaths)
  });
  const alerting = alertRuleVerdict({
    prometheusState: installed.prometheus.state,
    prometheusRules: prometheusRules.items,
    unavailablePaths: listUnavailablePaths.filter(l => l === 'prometheusrules').concat(discoveryUnavailablePaths)
  });

  // ---- F4 ----
  const telemetryInstalled = {
    logPipeline: telemetryProbe.states.logpipelines,
    tracePipeline: telemetryProbe.states.tracepipelines,
    metricPipeline: telemetryProbe.states.metricpipelines
  };
  const telemetry = {
    logPipelines: summarizePipelines(logPipelines.items),
    tracePipelines: summarizePipelines(tracePipelines.items),
    metricPipelines: summarizePipelines(metricPipelines.items)
  };

  // ---- F5 ----
  // null (never []) when the read itself failed — see agentCoverage's caller contract in
  // the task: "recognizedAgents must be null when the underlying read failed".
  const recognizedAgents = daemonSetsResult.unavailable ? null : agentCoverage(daemonSetsResult.items);

  const allResults = [...listResults, logPipelines, tracePipelines, metricPipelines, daemonSetsResult];

  return {
    summary: {
      unavailable: [...new Set([...unavailableLabels(allResults), ...discoveryUnavailablePaths, ...telemetryProbe.unavailable.map(u => u.path)])],
      truncated: truncatedLabels(allResults)
    },
    prometheusOperator: {
      installed,
      counts: {
        prometheuses: prometheuses.items.length,
        servicemonitors: serviceMonitors.items.length,
        podmonitors: podMonitors.items.length,
        prometheusrules: prometheusRules.items.length
      },
      scrapeWiring: scrape,
      alertRules: alerting,
      unavailablePaths
    },
    telemetry: {
      installed: telemetryInstalled,
      ...telemetry
    },
    agentCoverage: {
      recognizedAgents
    }
  };
}

export default {
  collect,
  probeResources,
  scrapeVerdict,
  alertRuleVerdict,
  pipelineVerdict,
  summarizePipelines,
  agentCoverage,
  VERDICT_UNKNOWN,
  VERDICT_NOT_INSTALLED,
  VERDICT_TARGETS_DECLARED,
  VERDICT_NO_TARGETS,
  MONITORING_GROUP,
  MONITORING_VERSION,
  TELEMETRY_GROUP,
  TELEMETRY_VERSION,
  AGENT_IMAGE_TOKEN
};
