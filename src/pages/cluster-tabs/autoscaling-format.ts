/**
 * How an HPA's replica counts and its scaling metrics read — the pure half of the Autoscaling tab.
 *
 * Both columns this file formats were reported as clutter, and both for the same reason: they packed
 * several facts into one undifferentiated mono string. `Replicas` printed `3 / 15 / 3 / 3` — four
 * numbers whose order lived in a tooltip — and `Metric Thresholds` printed `Resource (cpu): 4% / 80%`,
 * which is a type name, a live sample and a target with nothing to say which is which.
 *
 * Two things the rewrite has to get right, and neither is visible in a screenshot:
 *
 *  1. **Absent is not zero.** Every replica count is nullable (see `HpaRow`), and `0` is a real state:
 *     a KEDA-driven or HPAScaleToZero workload is deliberately at zero, while an HPA the controller
 *     has not reconciled yet reports nothing. They must not print the same way, so absent is `—`.
 *  2. **Four of the five metric types are not `Resource`.** `Pods`, `Object`, `External` and
 *     `ContainerResource` all exist, and an `External` metric is what every KEDA scaler writes. A
 *     formatter that made `Resource (cpu)` pretty and left the rest as raw strings would move the
 *     clutter to the rows that have the least context to spare.
 *
 * Tested without a DOM, which is why it is a `.ts` module: jsdom is unavailable here, so the `.tsx`
 * that consumes this is compile-verified only and every decision worth asserting lives below.
 */
import type { HpaMetric, HpaRow } from '../../api';
import type { Tone } from '../../components/ui';

/** A nullable count as text. `—` for absent, `0` for a genuine zero. */
export function replicaCount(n: number | null | undefined): string {
  return typeof n === 'number' ? String(n) : '—';
}

/**
 * The quiet second line of the Replicas cell: `min 3 · max 15`.
 *
 * `null` when the spec reported neither bound, so the cell renders one line rather than a line of two
 * em-dashes. One bound present and the other not still prints both, because a missing `maxReplicas` on
 * an object that has a `minReplicas` is itself worth seeing.
 */
export function boundsLabel(min: number | null | undefined, max: number | null | undefined): string | null {
  if (typeof min !== 'number' && typeof max !== 'number') return null;
  return `min ${replicaCount(min)} · max ${replicaCount(max)}`;
}

/**
 * Is this HPA already at its ceiling — `null` when it cannot be known.
 *
 * `null` rather than `false` for the unreconciled case, because the old expression
 * (`currentReplicas >= maxReplicas`) compared two absent values as `0 >= 0` and answered **yes, at
 * maximum** for an HPA that had never reported anything at all.
 */
export function hpaAtMax(h: Pick<HpaRow, 'currentReplicas' | 'maxReplicas'>): boolean | null {
  if (typeof h.currentReplicas !== 'number' || typeof h.maxReplicas !== 'number') return null;
  if (h.maxReplicas <= 0) return null;
  return h.currentReplicas >= h.maxReplicas;
}

/**
 * How near the ceiling the autoscaler is running, as the Replicas column's sort key.
 *
 * The reading that matters on this column is not the replica count but the headroom: an HPA at its max
 * cannot answer the next traffic increase. `null` sorts last in both directions, which is where a row
 * with nothing to compare belongs.
 */
export function replicaPressure(h: Pick<HpaRow, 'currentReplicas' | 'maxReplicas'>): number | null {
  if (typeof h.currentReplicas !== 'number' || typeof h.maxReplicas !== 'number' || h.maxReplicas <= 0) return null;
  return h.currentReplicas / h.maxReplicas;
}

/**
 * The HPA `Status` pill, which used to collapse four different situations into `Active` / `Degraded`.
 *
 * Two of those collapses were wrong in opposite directions:
 *
 *  - An HPA the controller has **never reconciled** has an empty `conditions` array. The old
 *    expression read `ScalingActive === 'True'`, found nothing, and asserted `Degraded` — a verdict
 *    about a workload nobody has evaluated yet. Absence of a verdict is not a bad verdict.
 *  - An HPA that is `ScalingActive=True` *and* `ScalingLimited=True` at its ceiling read `Active`,
 *    which is the one reading that matters here inverted: it is pinned at `maxReplicas` and cannot
 *    answer the next increase in load. `hpaAtMax()` already knew this and only the drawer asked it.
 *
 * So six states (seven with `Fixed at N`, below), and `At ceiling` requires **both** halves: `ScalingLimited=True` alone also fires
 * when an autoscaler is held at its *minimum* (`TooFewReplicas`), which is not a ceiling, and
 * `currentReplicas >= maxReplicas` alone can be a coincidence the controller has not acted on. Only
 * when the controller says it is limiting *and* the counts agree is the claim safe to print.
 *
 * `rank` sorts worst-known first ascending and is deliberately not a health score: `Not yet
 * reconciled` sorts below `No readable metric` because "unknown" is the state an operator should look
 * at before an asserted failure, and `null` has no place in a sort key that every row can answer.
 *
 * Two further states exist because the first four each asserted something unread:
 *
 *  - `Limited, ceiling unknown` — `ScalingLimited=True` with `hpaAtMax()` answering `null`. The
 *    controller says it is clamping, but the replica counts needed to say *which* bound it is
 *    clamping against did not arrive. This used to fall through to a green `Active` whose tooltip
 *    claimed the autoscaler was "limited below its ceiling" — an affirmative statement about a
 *    ceiling never read, contradicted by the `TooManyReplicas` reason printed in the same sentence.
 *  - `Cannot scale target` — `AbleToScale=False`. The collector has always shipped this condition
 *    and nothing consulted it, so an HPA whose scale target is missing or unscalable
 *    (`FailedGetScale`) read green as long as `ScalingActive` was `True`.
 */
export type HpaStatusLabel =
  | 'Active'
  | 'At ceiling'
  | 'Limited, ceiling unknown'
  | 'No readable metric'
  | 'Cannot scale target'
  | 'Not yet reconciled'
  | 'Scaling disabled'
  | `Fixed at ${number}`;

export interface HpaStatus {
  label: HpaStatusLabel;
  tone: Tone;
  /** The sentence behind the pill: the controller's own reason/message where it gave one. */
  title: string;
  /** Sort key. Ascending puts the rows that need reading first. */
  rank: number;
}

type HpaStatusInput = Pick<HpaRow, 'conditions' | 'currentReplicas' | 'maxReplicas'> &
  Partial<Pick<HpaRow, 'minReplicas'>>;

/**
 * The one replica count a `minReplicas == maxReplicas` autoscaler can ever hold — `null` otherwise.
 *
 * Such an HPA cannot change anything: every Kyma module HPA on platform-sbx shipped as 2/2. Its
 * counts always satisfy `current >= max`, which is why the ceiling test alone painted three idle
 * autoscalers amber. It is a configuration fact, not load pressure.
 */
export function hpaFixedAt(h: Partial<Pick<HpaRow, 'minReplicas' | 'maxReplicas'>>): number | null {
  return typeof h.minReplicas === 'number' && h.minReplicas === h.maxReplicas ? h.minReplicas : null;
}

/**
 * Which limit, if any, this autoscaler is sitting on — the one classification both the Status pill
 * (`hpaStatus`) and the drawer's Limit field (`hpaLimitLabel`) read, so the two cannot disagree.
 *
 * `ScalingLimited=True` fires for four different reasons in the HPA controller
 * (pkg/controller/podautoscaler/horizontal.go), and only one of them is a ceiling:
 *
 *  - `TooManyReplicas` — the desired count was clamped to `maxReplicas`. The ceiling, and the
 *    controller's own word for it, so it holds even while fewer pods than max are running yet.
 *  - `TooFewReplicas` — clamped *up* to `minReplicas`: the floor, the normal state of an idle
 *    workload. On a min == max HPA `current >= max` holds here too, which is how three idle Kyma
 *    autoscalers on platform-sbx read amber `At ceiling`.
 *  - `ScaleUpLimit` / `ScaleDownLimit` — a `behavior` rate policy is slowing a change. Moving, not
 *    stuck; `ScaleDownLimit` at max is a spike winding down.
 *
 * An unknown reason falls back to the counts. `ScalingActive=False (ScalingDisabled)` is the
 * controller standing down because the target was scaled to 0 on purpose.
 */
type HpaLimit =
  | { kind: 'disabled' }
  | { kind: 'ceiling' }
  | { kind: 'fixed'; at: number }
  | { kind: 'floor' }
  | { kind: 'rate-up' }
  | { kind: 'rate-down' }
  | { kind: 'limited-unknown' }
  | { kind: 'limited-other' }
  | { kind: 'at-max' }
  | { kind: 'unreported' }
  | { kind: 'none' };

function hpaLimit(h: HpaStatusInput): HpaLimit {
  const conditions = h.conditions ?? [];
  const active = conditions.find(c => c.type === 'ScalingActive');
  if (active?.status === 'False' && active.reason === 'ScalingDisabled') return { kind: 'disabled' };

  const limited = conditions.find(c => c.type === 'ScalingLimited' && c.status === 'True');
  const reason = limited?.reason ?? null;
  if (reason === 'TooManyReplicas') return { kind: 'ceiling' };
  const fixedAt = hpaFixedAt(h);
  if (fixedAt !== null) return { kind: 'fixed', at: fixedAt };
  if (reason === 'TooFewReplicas') return { kind: 'floor' };
  if (reason === 'ScaleUpLimit') return { kind: 'rate-up' };
  if (reason === 'ScaleDownLimit') return { kind: 'rate-down' };

  const atMax = hpaAtMax(h);
  if (limited) return atMax === true ? { kind: 'ceiling' } : atMax === null ? { kind: 'limited-unknown' } : { kind: 'limited-other' };
  if (atMax === true) return { kind: 'at-max' };
  return atMax === null ? { kind: 'unreported' } : { kind: 'none' };
}

export function hpaStatus(h: HpaStatusInput): HpaStatus {
  const conditions = h.conditions ?? [];
  if (conditions.length === 0) {
    return {
      label: 'Not yet reconciled',
      tone: 'unknown',
      title: 'This HorizontalPodAutoscaler reports no conditions — the controller has not evaluated it yet. Not a failure.',
      rank: 0
    };
  }

  const active = conditions.find(c => c.type === 'ScalingActive');
  const limited = conditions.find(c => c.type === 'ScalingLimited');
  const ableToScale = conditions.find(c => c.type === 'AbleToScale');
  const detail = (c?: { reason: string | null; message: string | null }) =>
    c ? [c.reason, c.message].filter(Boolean).join(' — ') : '';
  const limit = hpaLimit(h);

  // Read before ScalingActive: an autoscaler that can compute a replica count but cannot apply it to
  // its target is not scaling anything, whatever the metric says.
  if (ableToScale && ableToScale.status === 'False') {
    const why = detail(ableToScale);
    return {
      label: 'Cannot scale target',
      tone: 'bad',
      title: `AbleToScale=False: the controller cannot scale this autoscaler’s target${why ? ` (${why})` : ''}.`,
      rank: 2
    };
  }

  // Before the generic ScalingActive=False: a target scaled to 0 by hand is a choice, not a metric
  // the controller failed to read.
  if (limit.kind === 'disabled') {
    return {
      label: 'Scaling disabled',
      tone: 'unknown',
      title: `ScalingActive=False (${detail(active)}): the target was scaled to zero, so the controller stops scaling it until its replica count is raised again.`,
      rank: 1
    };
  }

  if (!active || active.status !== 'True') {
    const why = detail(active);
    return {
      label: 'No readable metric',
      tone: 'bad',
      title: active
        ? `ScalingActive=${active.status}: the controller could not compute a replica count${why ? ` (${why})` : ''}.`
        : 'No ScalingActive condition: the controller has reported conditions but not whether it can compute a replica count.',
      rank: 3
    };
  }

  const why = detail(limited);
  const max = typeof h.maxReplicas === 'number' ? ` ${h.maxReplicas}` : '';
  switch (limit.kind) {
    case 'ceiling':
      return {
        label: 'At ceiling',
        tone: 'warn',
        title: `Scaling, but the desired count is clamped at maxReplicas${max} — it cannot answer a further increase in load${why ? ` (${why})` : ''}.`,
        rank: 4
      };
    case 'limited-unknown':
      // Never print "limited below its ceiling" here: which bound the controller is clamping against
      // is exactly what the missing replica counts and the unrecognised reason leave unknown.
      return {
        label: 'Limited, ceiling unknown',
        tone: 'unknown',
        title: `ScalingLimited=True${why ? ` (${why})` : ''}, but the current and maximum replica counts were not reported, so which bound it is held at is not known.`,
        rank: 1
      };
    case 'fixed':
      return {
        label: `Fixed at ${limit.at}`,
        tone: 'unknown',
        title: `minReplicas equals maxReplicas (${limit.at}), so this autoscaler cannot change the replica count — it only holds the workload at ${limit.at}. A configuration choice, not load pressure.`,
        rank: 5
      };
  }

  const note: Record<string, string> = {
    floor: `, held at its minimum${typeof h.minReplicas === 'number' ? ` of ${h.minReplicas}` : ''} (${why})`,
    'rate-up': `, scaling up at the rate its scale-up policy allows (${why})`,
    'rate-down': `, scaling down at the rate its scale-down policy allows (${why})`,
    'limited-other': `, and limited below its ceiling (${why || 'ScalingLimited=True'})`,
    'at-max': `, running at maxReplicas${max} without the controller clamping it`
  };
  return {
    label: 'Active',
    tone: 'ok',
    title: `ScalingActive=True${note[limit.kind] ?? ''}.`,
    rank: 6
  };
}

/**
 * The drawer's "Limit" field, from the same `hpaLimit` classification as the Status pill.
 *
 * Replaces an "At maximum: Yes — cannot scale further" that read `current >= max` alone and so said
 * it about every min == max autoscaler held at its floor.
 */
export function hpaLimitLabel(h: HpaStatusInput): string {
  const limit = hpaLimit(h);
  switch (limit.kind) {
    case 'disabled':
      return 'Scaling disabled — the target is at 0 replicas';
    case 'ceiling':
      return 'At maximum — cannot scale further';
    case 'at-max':
      // Desired equals max exactly and the controller is not clamping: a reading, not the verdict
      // the pill reserves for `At ceiling`.
      return `Running at its maximum${typeof h.maxReplicas === 'number' ? ` of ${h.maxReplicas}` : ''}, not clamped`;
    case 'fixed':
      return `Fixed at ${limit.at} — min equals max, it cannot scale`;
    case 'floor':
      return `Held at its minimum${typeof h.minReplicas === 'number' ? ` of ${h.minReplicas}` : ''}`;
    case 'rate-up':
      return 'Scaling up, slowed by its scale-up policy';
    case 'rate-down':
      return 'Scaling down, slowed by its scale-down policy';
    case 'limited-unknown':
      return 'Limited, bound not reported';
    case 'limited-other':
      return 'Limited below its maximum';
    case 'unreported':
      return 'not reported yet';
    case 'none':
      return 'No — room to scale up';
  }
}

/** `cpu` → `CPU`, `memory` → `Memory`. Anything custom is left exactly as the cluster spelled it. */
function resourceLabel(name: string): string {
  if (name === 'cpu') return 'CPU';
  if (name === 'memory') return 'Memory';
  return name;
}

/** A percentage string back as a number, or `null` for anything that is not one (`100Mi`, `—`). */
export function percentOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

export interface MetricLine {
  /** What is being measured: `CPU`, `Memory`, `queue_length`, `CPU · istio-proxy`. */
  subject: string;
  /** The reading against its target: `4% (target 80%)`, `target 80%`, `— (target 80%)`. */
  reading: string;
  /** Tone for the reading, never for the subject — see the comment on `metricTone`. */
  tone: Tone;
  /** The full, untruncated form for the cell's `title`, since the column is capped. */
  title: string;
}

/**
 * The tone a reading carries.
 *
 * Only ever derived from two percentages of the *same* kind. A utilisation at or above its target is
 * the autoscaler being asked to scale up — `warn`, not `bad`, because that is the system working — and
 * anything below it is `ok`. Two quantities (`180Mi` against `200Mi`) are deliberately `unknown`:
 * comparing Kubernetes quantity strings needs a unit parser, and a wrong comparison on a memory
 * metric is worse than no colour at all.
 */
function metricTone(current: string | null, target: string | null): Tone {
  const c = percentOf(current);
  const t = percentOf(target);
  if (c === null || t === null) return 'unknown';
  return c >= t ? 'warn' : 'ok';
}

/**
 * One metric as the two strings the cell renders.
 *
 * The subject is built per type rather than from the metric's `type` display string, because each type
 * names its subject somewhere different: a resource metric in `name`, a ContainerResource metric in
 * `name` *and* `container`, an Object metric in `describedObject`, and Pods/External in the custom
 * metric name alone. A metric whose body the collector could not read keeps its `kind` as the subject,
 * which is honest and is also the one case where there is nothing better to say.
 */
export function metricLine(m: HpaMetric): MetricLine {
  const name = m.name;
  let subject: string;
  switch (m.kind) {
    case 'Resource':
      subject = name ? resourceLabel(name) : 'Resource';
      break;
    case 'ContainerResource':
      subject = `${name ? resourceLabel(name) : 'Resource'}${m.container ? ` · ${m.container}` : ''}`;
      break;
    case 'Object': {
      const on = m.describedObject && (m.describedObject.kind || m.describedObject.name);
      const where = on ? ` on ${[m.describedObject?.kind, m.describedObject?.name].filter(Boolean).join('/')}` : '';
      subject = `${name ?? 'Object'}${where}`;
      break;
    }
    case 'Pods':
      subject = name ? `${name} per pod` : 'Pods';
      break;
    case 'External':
      subject = name ?? 'External';
      break;
    default:
      subject = name ? `${m.kind} (${name})` : m.kind || 'Unknown';
  }

  const current = m.currentValue;
  const target = m.targetValue;
  // No target is possible on a metric the collector could not unpack, and a reading with nothing to
  // compare against is still the operator's only number — it prints alone rather than as `4% (target —)`.
  const reading = target === null ? current ?? '—' : `${current ?? '—'} (target ${target})`;

  return {
    subject,
    reading,
    tone: metricTone(current, target),
    title: `${m.kind}${name ? ` · ${name}` : ''} — ${reading}`
  };
}
