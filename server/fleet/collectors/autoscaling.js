/**
 * Autoscaling & CronJob collector: HPAs and scheduled batch jobs.
 *
 * Reads HorizontalPodAutoscalers (v2) and CronJobs across the fleet,
 * providing insights into automated scaling health, target vs current utilization,
 * and scheduled job execution history.
 */
import k8sModule from '../k8s.js';
const { list } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, unavailableLabels, truncatedLabels } = safeListModule;
import fanoutModule from '../fanout.js';
const { publicCluster } = fanoutModule;

/**
 * Where each HPA metric type keeps its own body, and what names the metric inside it.
 *
 * The v2 API has five, and only `Resource` was ever unpacked here — every other type rendered as
 * `Pods: — / —`, which on a KEDA-driven cluster is *every row*, because KEDA writes its scalers as
 * `External` metrics with no CPU or memory in sight. The type name alone is not a metric.
 *
 * `Resource` and `ContainerResource` name a compute resource directly (`spec.resource.name`); the
 * other three carry a `metric: { name, selector }` object instead.
 */
const METRIC_BODIES = {
  Resource: { field: 'resource', named: 'resource' },
  ContainerResource: { field: 'containerResource', named: 'resource' },
  Pods: { field: 'pods', named: 'metric' },
  Object: { field: 'object', named: 'metric' },
  External: { field: 'external', named: 'metric' }
};

/**
 * One `target` or `current` block as the string an operator reads.
 *
 * The three keys are mutually exclusive in practice and ordered by how the API prefers them:
 * `averageUtilization` is a percentage of the request, `averageValue` a per-pod quantity, `value` a
 * total. `null` rather than `'—'`, so the caller decides how an absent reading prints — a metric
 * with no current value is an unreconciled or unreadable metric, not a zero.
 */
function quantity(block) {
  if (!block || typeof block !== 'object') return null;
  if (typeof block.averageUtilization === 'number') return `${block.averageUtilization}%`;
  if (block.averageValue !== undefined && block.averageValue !== null) return String(block.averageValue);
  if (block.value !== undefined && block.value !== null) return String(block.value);
  return null;
}

/** The metric's own name: `cpu` for a resource metric, the custom/external metric name otherwise. */
function metricName(body, spec) {
  if (!spec) return null;
  return (body.named === 'resource' ? spec.name : spec.metric && spec.metric.name) || null;
}

/**
 * The `status.currentMetrics` entry belonging to one `spec.metrics` entry.
 *
 * Matched on type *and* name rather than by index: the status list is not guaranteed to be ordered
 * with the spec list, and an HPA with a cpu and a memory metric would otherwise report cpu's
 * utilisation against memory's target.
 */
function currentFor(status, type, body, name) {
  const entries = status.currentMetrics || [];
  for (const entry of entries) {
    if (entry.type && entry.type !== type) continue;
    const side = entry[body.field];
    if (!side) continue;
    if (metricName(body, side) !== name) continue;
    return side.current || null;
  }
  return null;
}

/**
 * @param {{cluster: object, token: string, listFn?: typeof list}} ctx
 */
async function collect(ctx) {
  const listFn = ctx.listFn || list;

  const [hpasResult, cronJobsResult] = await Promise.all([
    safeList(listFn, ctx, '/apis/autoscaling/v2/horizontalpodautoscalers', 'hpa'),
    safeList(listFn, ctx, '/apis/batch/v1/cronjobs', 'cronjobs')
  ]);
  const hpasRaw = hpasResult.items;
  const cronJobsRaw = cronJobsResult.items;

  const hpas = hpasRaw.map(h => {
    const meta = h.metadata || {};
    const spec = h.spec || {};
    const status = h.status || {};
    const targetRef = spec.scaleTargetRef || {};

    const metrics = (spec.metrics || []).map(m => {
      const type = m.type || 'Unknown';
      const body = METRIC_BODIES[type];
      const side = body ? m[body.field] : null;
      const name = body ? metricName(body, side) : null;
      const target = side ? quantity(side.target) : null;
      const current = body ? quantity(currentFor(status, type, body, name)) : null;
      // The described object an Object metric is scaled against — `Ingress/bookshop`, say. Nothing
      // else carries one, and without it an Object metric named `requests_per_second` says nothing
      // about *whose*.
      const described = side && side.describedObject ? side.describedObject : null;

      return {
        /*
          `type` stays the display string it has always been — `Resource (cpu)` — because the
          resource drawer and the fleet-wide digests join on it. The structured fields beside it are
          what the table formats; nothing derives a metric's kind by parsing this string.
        */
        type: name ? `${type} (${name})` : type,
        target: target ?? '—',
        current: current ?? '—',
        kind: type,
        name,
        // Only ContainerResource is per-container: the same `cpu` metric means the pod on a Resource
        // metric and one named container on a ContainerResource one.
        container: (side && side.container) || null,
        describedObject: described ? { kind: described.kind || null, name: described.name || null } : null,
        // Nullable siblings of `target`/`current`: absent is absent, and `'—'` cannot be compared.
        targetValue: target,
        currentValue: current
      };
    });

    const conditions = (status.conditions || []).map(c => ({
      type: c.type,
      status: c.status,
      reason: c.reason || null,
      message: c.message || null
    }));

    return {
      id: `${ctx.cluster.id}:${meta.namespace}/${meta.name}`,
      clusterId: ctx.cluster.id,
      name: meta.name,
      namespace: meta.namespace,
      targetKind: targetRef.kind || 'Deployment',
      targetName: targetRef.name || '—',
      /*
        All four are nullable, and used to be `|| 1` / `|| 0`.

        `status.currentReplicas` and `status.desiredReplicas` are absent until the controller has
        reconciled the HPA at least once, and `|| 0` reported that unreconciled HPA as *scaled to
        zero* — a real and deliberate state under HPAScaleToZero and KEDA, and the opposite reading.
        `spec.minReplicas` has the same problem in the other direction: the apiserver defaults it to
        1 on write, so `|| 1` was usually right, and turned an explicit `minReplicas: 0` into a 1.
        Absent now stays absent and the UI renders it `—`.
      */
      minReplicas: typeof spec.minReplicas === 'number' ? spec.minReplicas : null,
      maxReplicas: typeof spec.maxReplicas === 'number' ? spec.maxReplicas : null,
      currentReplicas: typeof status.currentReplicas === 'number' ? status.currentReplicas : null,
      desiredReplicas: typeof status.desiredReplicas === 'number' ? status.desiredReplicas : null,
      metrics,
      conditions,
      lastScaleTime: status.lastScaleTime || null,
      createdAt: meta.creationTimestamp || null
    };
  });

  const cronjobs = cronJobsRaw.map(cj => {
    const meta = cj.metadata || {};
    const spec = cj.spec || {};
    const status = cj.status || {};

    return {
      id: `${ctx.cluster.id}:${meta.namespace}/${meta.name}`,
      clusterId: ctx.cluster.id,
      name: meta.name,
      namespace: meta.namespace,
      schedule: spec.schedule || '—',
      suspend: Boolean(spec.suspend),
      activeJobsCount: (status.active || []).length,
      lastScheduleTime: status.lastScheduleTime || null,
      lastSuccessfulTime: status.lastSuccessfulTime || null,
      concurrencyPolicy: spec.concurrencyPolicy || 'Allow',
      createdAt: meta.creationTimestamp || null
    };
  });

  return {
    // publicCluster strips caData/caFile — this collector's raw ctx.cluster came from the
    // registry record, which carries both, and neither belongs on a browser response.
    cluster: publicCluster(ctx.cluster),
    summary: {
      totalHpas: hpas.length,
      scalingActive: hpas.filter(h => h.conditions.some(c => c.type === 'ScalingActive' && c.status === 'True')).length,
      totalCronJobs: cronjobs.length,
      activeCronJobs: cronjobs.filter(cj => !cj.suspend).length,
      unavailable: unavailableLabels([hpasResult, cronJobsResult]),
      // Reads that answered but stopped at the client's paging ceiling. The counts above that
      // derive from them are floors, not totals.
      truncated: truncatedLabels([hpasResult, cronJobsResult])
    },
    hpas,
    cronjobs
  };
}

export default { collect };
