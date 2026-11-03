/**
 * The Autoscaling formatters, and the two absences they must not flatten: a replica count that was
 * never reported, and a metric type that is not `Resource`.
 */
import { describe, expect, it } from 'vitest';
import type { HpaMetric, HpaRow } from '../../api';
import {
  boundsLabel,
  hpaAtMax,
  hpaLimitLabel,
  hpaStatus,
  metricLine,
  percentOf,
  replicaCount,
  replicaPressure
} from './autoscaling-format';

function metric(over: Partial<HpaMetric> = {}): HpaMetric {
  return {
    type: 'Resource (cpu)',
    target: '80%',
    current: '4%',
    kind: 'Resource',
    name: 'cpu',
    container: null,
    describedObject: null,
    targetValue: '80%',
    currentValue: '4%',
    ...over
  };
}

function hpa(over: Partial<HpaRow> = {}): HpaRow {
  return {
    id: 'c:prod/bookshop',
    clusterId: 'c',
    name: 'bookshop',
    namespace: 'prod',
    targetKind: 'Deployment',
    targetName: 'bookshop-srv',
    minReplicas: 3,
    maxReplicas: 15,
    currentReplicas: 3,
    desiredReplicas: 3,
    metrics: [],
    conditions: [],
    lastScaleTime: null,
    createdAt: null,
    ...over
  };
}

describe('replicaCount', () => {
  it('prints a genuine scaled-to-zero workload as 0', () => {
    expect(replicaCount(0)).toBe('0');
  });

  it('prints an unreported count as an em-dash, never as 0', () => {
    expect(replicaCount(null)).toBe('—');
    expect(replicaCount(undefined)).toBe('—');
  });
});

describe('boundsLabel', () => {
  it('reads as quiet helper text under the counts', () => {
    expect(boundsLabel(3, 15)).toBe('min 3 · max 15');
  });

  it('keeps an explicit zero minimum, which HPAScaleToZero makes meaningful', () => {
    expect(boundsLabel(0, 15)).toBe('min 0 · max 15');
  });

  it('is null when the spec reported neither bound, so the cell drops the line', () => {
    expect(boundsLabel(null, null)).toBeNull();
  });

  it('still prints both sides when only one bound is missing', () => {
    expect(boundsLabel(2, null)).toBe('min 2 · max —');
  });
});

describe('hpaAtMax', () => {
  it('answers yes at the ceiling and no below it', () => {
    expect(hpaAtMax({ currentReplicas: 15, maxReplicas: 15 })).toBe(true);
    expect(hpaAtMax({ currentReplicas: 3, maxReplicas: 15 })).toBe(false);
  });

  it('is unknown, not "at maximum", for an HPA that has reported nothing', () => {
    // The bug this replaces: `null >= null` coerces to `0 >= 0` and answers true.
    expect(hpaAtMax({ currentReplicas: null, maxReplicas: null })).toBeNull();
    expect(hpaAtMax({ currentReplicas: 3, maxReplicas: null })).toBeNull();
  });
});

describe('replicaPressure', () => {
  it('sorts on headroom rather than on the replica count', () => {
    expect(replicaPressure({ currentReplicas: 3, maxReplicas: 15 })).toBeCloseTo(0.2);
    expect(replicaPressure({ currentReplicas: 8, maxReplicas: 10 })).toBeCloseTo(0.8);
  });

  it('is null when there is nothing to compare, so the row sorts last either way', () => {
    expect(replicaPressure({ currentReplicas: null, maxReplicas: 10 })).toBeNull();
    expect(replicaPressure({ currentReplicas: 4, maxReplicas: 0 })).toBeNull();
  });
});

describe('percentOf', () => {
  it('reads a percentage and refuses a quantity', () => {
    expect(percentOf('80%')).toBe(80);
    expect(percentOf('4.5%')).toBe(4.5);
    expect(percentOf('180Mi')).toBeNull();
    expect(percentOf('—')).toBeNull();
    expect(percentOf(null)).toBeNull();
  });
});

describe('metricLine', () => {
  it('reads a CPU utilisation metric as a subject and a reading', () => {
    const line = metricLine(metric());
    expect(line.subject).toBe('CPU');
    expect(line.reading).toBe('4% (target 80%)');
    expect(line.tone).toBe('ok');
  });

  it('warns once utilisation has reached its target, because that is the scale-up request', () => {
    expect(metricLine(metric({ currentValue: '80%' })).tone).toBe('warn');
    expect(metricLine(metric({ currentValue: '140%' })).tone).toBe('warn');
  });

  it('names a memory metric and declines to compare two quantities', () => {
    const line = metricLine(metric({ kind: 'Resource', name: 'memory', currentValue: '180Mi', targetValue: '200Mi' }));
    expect(line.subject).toBe('Memory');
    expect(line.reading).toBe('180Mi (target 200Mi)');
    expect(line.tone).toBe('unknown');
  });

  it('shows a ContainerResource metric with the container it is scoped to', () => {
    const line = metricLine(metric({ kind: 'ContainerResource', name: 'cpu', container: 'istio-proxy' }));
    expect(line.subject).toBe('CPU · istio-proxy');
  });

  it('names the custom metric on a Pods metric', () => {
    const line = metricLine(
      metric({ kind: 'Pods', name: 'http_requests', currentValue: '9', targetValue: '10' })
    );
    expect(line.subject).toBe('http_requests per pod');
    expect(line.reading).toBe('9 (target 10)');
  });

  it('says what an Object metric is measured against', () => {
    const line = metricLine(
      metric({
        kind: 'Object',
        name: 'requests_per_second',
        describedObject: { kind: 'Ingress', name: 'bookshop' },
        currentValue: '120',
        targetValue: '100'
      })
    );
    expect(line.subject).toBe('requests_per_second on Ingress/bookshop');
  });

  it('renders the External metric a KEDA scaler writes, rather than a bare type name', () => {
    const line = metricLine(
      metric({ kind: 'External', name: 'rabbitmq-queue-length', currentValue: '412', targetValue: '50' })
    );
    expect(line.subject).toBe('rabbitmq-queue-length');
    expect(line.reading).toBe('412 (target 50)');
  });

  it('prints an unreconciled metric as an em-dash against its target', () => {
    expect(metricLine(metric({ currentValue: null })).reading).toBe('— (target 80%)');
  });

  it('prints a reading alone when there is no target to compare it to', () => {
    expect(metricLine(metric({ targetValue: null })).reading).toBe('4%');
  });

  it('falls back to the kind when the collector could not read the metric body', () => {
    const line = metricLine(metric({ kind: 'Unknown', name: null, currentValue: null, targetValue: null }));
    expect(line.subject).toBe('Unknown');
    expect(line.reading).toBe('—');
  });

  it('carries the untruncated form as a title, since the column is capped', () => {
    expect(metricLine(metric()).title).toBe('Resource · cpu — 4% (target 80%)');
  });
});

describe('the row type this all reads from', () => {
  it('accepts an HPA whose status has not been written yet', () => {
    const row = hpa({ currentReplicas: null, desiredReplicas: null });
    expect(replicaCount(row.currentReplicas)).toBe('—');
    expect(replicaCount(row.desiredReplicas)).toBe('—');
    expect(boundsLabel(row.minReplicas, row.maxReplicas)).toBe('min 3 · max 15');
  });
});

describe('hpaStatus', () => {
  const cond = (type: string, status: string, reason: string | null = null, message: string | null = null) => ({
    type,
    status,
    reason,
    message
  });

  it('does not assert Degraded about an HPA the controller has never evaluated', () => {
    const s = hpaStatus(hpa({ conditions: [], currentReplicas: null, desiredReplicas: null }));
    expect(s.label).toBe('Not yet reconciled');
    expect(s.tone).toBe('unknown');
  });

  it('reports a scaling autoscaler below its ceiling as Active', () => {
    const s = hpaStatus(hpa({ conditions: [cond('ScalingActive', 'True')], currentReplicas: 3, maxReplicas: 15 }));
    expect(s.label).toBe('Active');
    expect(s.tone).toBe('ok');
  });

  it('reports an autoscaler pinned at maxReplicas as At ceiling, not Active', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooManyReplicas', 'the desired replica count is more than the maximum replica count')],
        currentReplicas: 15,
        maxReplicas: 15
      })
    );
    expect(s.label).toBe('At ceiling');
    expect(s.tone).toBe('warn');
    expect(s.title).toContain('TooManyReplicas');
  });

  it('does not call a minimum-limited autoscaler At ceiling', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooFewReplicas')],
        currentReplicas: 3,
        maxReplicas: 15
      })
    );
    expect(s.label).toBe('Active');
  });

  it('does not call an unreconciled replica count At ceiling (0 >= 0), and does not call it Active either', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'SomeFutureReason')],
        currentReplicas: null,
        maxReplicas: null
      })
    );
    expect(s.label).toBe('Limited, ceiling unknown');
    expect(s.tone).toBe('unknown');
    // The old green pill asserted a ceiling it never read.
    expect(s.title).not.toContain('below its ceiling');
    expect(s.title).toContain('SomeFutureReason');
  });

  it('takes TooManyReplicas as the ceiling on its own, even before the pods have caught up', () => {
    // Desired clamped to max 10 while only 6 run (pods still starting, or a quota blocking them).
    for (const currentReplicas of [6, null]) {
      const s = hpaStatus(
        hpa({ conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooManyReplicas')], minReplicas: 2, maxReplicas: 10, currentReplicas })
      );
      expect(s.label).toBe('At ceiling');
      expect(s.tone).toBe('warn');
      expect(s.title).not.toContain('below its ceiling');
    }
  });

  it('does not call a scale-down rate limit a ceiling, even at max', () => {
    for (const currentReplicas of [10, 7]) {
      const s = hpaStatus(
        hpa({ conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'ScaleDownLimit')], minReplicas: 2, maxReplicas: 10, currentReplicas })
      );
      expect(s.label).toBe('Active');
      expect(s.title).toContain('scaling down');
      expect(s.title).not.toContain('ceiling');
    }
  });

  it('reads a scale-up rate limit as scaling up, not as a ceiling', () => {
    const s = hpaStatus(
      hpa({ conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'ScaleUpLimit')], minReplicas: 2, maxReplicas: 10, currentReplicas: 4 })
    );
    expect(s.label).toBe('Active');
    expect(s.title).toContain('scaling up');
  });

  it('reads ScalingDisabled (target at 0) as a neutral state, not a metric failure', () => {
    const s = hpaStatus(
      hpa({ conditions: [cond('AbleToScale', 'True'), cond('ScalingActive', 'False', 'ScalingDisabled', 'scaling is disabled since the replica count of the target is zero')], currentReplicas: 0 })
    );
    expect(s.label).toBe('Scaling disabled');
    expect(s.tone).toBe('unknown');
    expect(s.title).toContain('zero');
  });

  it('keeps the ceiling unknown when maxReplicas is zero, rather than dividing into a verdict', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True')],
        currentReplicas: 0,
        maxReplicas: 0
      })
    );
    expect(s.label).toBe('Limited, ceiling unknown');
  });

  it('reports AbleToScale=False as Cannot scale target, not Active', () => {
    const s = hpaStatus(
      hpa({
        conditions: [
          cond('AbleToScale', 'False', 'FailedGetScale', 'deployments/scale.apps "web" not found'),
          cond('ScalingActive', 'True')
        ],
        currentReplicas: 3,
        maxReplicas: 15
      })
    );
    expect(s.label).toBe('Cannot scale target');
    expect(s.tone).toBe('bad');
    expect(s.title).toContain('FailedGetScale');
  });

  it('leaves AbleToScale=True alone', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('AbleToScale', 'True', 'ReadyForNewScale'), cond('ScalingActive', 'True')],
        currentReplicas: 3,
        maxReplicas: 15
      })
    );
    expect(s.label).toBe('Active');
  });

  it('reports ScalingActive=False as No readable metric, with the controller reason', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'False', 'FailedGetResourceMetric', 'no metrics returned from resource metrics API')],
        currentReplicas: 3
      })
    );
    expect(s.label).toBe('No readable metric');
    expect(s.tone).toBe('bad');
    expect(s.title).toContain('FailedGetResourceMetric');
  });

  it('treats ScalingActive=Unknown as unreadable rather than active', () => {
    expect(hpaStatus(hpa({ conditions: [cond('ScalingActive', 'Unknown')] })).label).toBe('No readable metric');
  });

  it('sorts the rows that need reading before the healthy ones', () => {
    const rank = (conditions: ReturnType<typeof cond>[], currentReplicas: number | null, maxReplicas: number | null) =>
      hpaStatus(hpa({ conditions, currentReplicas, maxReplicas })).rank;
    expect(rank([], null, null)).toBeLessThan(rank([cond('ScalingActive', 'False')], 3, 15));
    expect(rank([cond('ScalingActive', 'False')], 3, 15)).toBeLessThan(
      rank([cond('ScalingActive', 'True'), cond('ScalingLimited', 'True')], 15, 15)
    );
    expect(rank([cond('ScalingActive', 'True'), cond('ScalingLimited', 'True')], 15, 15)).toBeLessThan(
      rank([cond('ScalingActive', 'True')], 3, 15)
    );
    // The two states added because the old four asserted something unread: an unknown ceiling sorts
    // above every asserted verdict, and a target that cannot be scaled sorts above a healthy row.
    expect(rank([cond('ScalingActive', 'True'), cond('ScalingLimited', 'True')], null, null)).toBeLessThan(
      rank([cond('ScalingActive', 'False')], 3, 15)
    );
    expect(rank([cond('AbleToScale', 'False'), cond('ScalingActive', 'True')], 3, 15)).toBeLessThan(
      rank([cond('ScalingActive', 'True')], 3, 15)
    );
  });

  it('never pairs the ok tone with a claim it did not read', () => {
    const cases = [
      [cond('ScalingActive', 'True')],
      [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooFewReplicas')],
      [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooManyReplicas')],
      [cond('AbleToScale', 'False'), cond('ScalingActive', 'True')]
    ];
    for (const conditions of cases) {
      for (const [currentReplicas, maxReplicas] of [[3, 15], [null, null], [15, 15]] as [number | null, number | null][]) {
        const s = hpaStatus(hpa({ conditions, currentReplicas, maxReplicas }));
        if (s.tone !== 'ok') continue;
        // A green verdict may only mention a ceiling when both counts were actually reported.
        if (/ceiling/i.test(s.title)) {
          expect(typeof currentReplicas).toBe('number');
          expect(typeof maxReplicas).toBe('number');
        }
        expect(s.label).toBe('Active');
      }
    }
  });

  /*
    Found live on platform-sbx: three Kyma HPAs at min 2 = max 2, running at 7–30% of target, with
    `ScalingLimited=True (TooFewReplicas)` — the controller holding them *up* at their minimum. The
    counts said current >= max, so the pill read an amber `At ceiling` about autoscalers with no load
    pressure at all. The reason says which bound, and min == max says neither bound can move.
  */
  it('reports min == max as Fixed at N in a neutral tone, not At ceiling', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooFewReplicas')],
        minReplicas: 2,
        maxReplicas: 2,
        currentReplicas: 2
      })
    );
    expect(s.label).toBe('Fixed at 2');
    expect(s.tone).toBe('unknown');
    expect(s.title).toContain('cannot change');
  });

  it('reports min == max as Fixed even with no ScalingLimited condition', () => {
    const s = hpaStatus(
      hpa({ conditions: [cond('ScalingActive', 'True')], minReplicas: 4, maxReplicas: 4, currentReplicas: 4 })
    );
    expect(s.label).toBe('Fixed at 4');
  });

  it('still reports a fixed autoscaler that wants more replicas (TooManyReplicas) as At ceiling', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooManyReplicas')],
        minReplicas: 2,
        maxReplicas: 2,
        currentReplicas: 2
      })
    );
    expect(s.label).toBe('At ceiling');
  });

  it('lets a failure outrank Fixed', () => {
    const s = hpaStatus(
      hpa({ conditions: [cond('ScalingActive', 'False')], minReplicas: 2, maxReplicas: 2, currentReplicas: 2 })
    );
    expect(s.label).toBe('No readable metric');
  });

  it('never calls a TooFewReplicas autoscaler At ceiling, whatever the counts say', () => {
    for (const [currentReplicas, maxReplicas] of [[3, 15], [15, 15], [null, null]] as [number | null, number | null][]) {
      const s = hpaStatus(
        hpa({ conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooFewReplicas')], currentReplicas, maxReplicas })
      );
      expect(s.label).not.toBe('At ceiling');
      expect(s.label).not.toBe('Limited, ceiling unknown');
    }
  });

  it('describes a minimum-held autoscaler as held at its minimum, not "below its ceiling"', () => {
    const s = hpaStatus(
      hpa({
        conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooFewReplicas')],
        minReplicas: 3,
        currentReplicas: 3,
        maxReplicas: 15
      })
    );
    expect(s.label).toBe('Active');
    expect(s.title).toContain('held at its minimum of 3');
    expect(s.title).not.toContain('below its ceiling');
  });

  it('sorts Fixed after the rows that need reading and before Active', () => {
    const fixed = hpaStatus(hpa({ conditions: [cond('ScalingActive', 'True')], minReplicas: 2, maxReplicas: 2, currentReplicas: 2 })).rank;
    const ceiling = hpaStatus(hpa({ conditions: [cond('ScalingActive', 'True'), cond('ScalingLimited', 'True', 'TooManyReplicas')], currentReplicas: 15 })).rank;
    const active = hpaStatus(hpa({ conditions: [cond('ScalingActive', 'True')] })).rank;
    expect(ceiling).toBeLessThan(fixed);
    expect(fixed).toBeLessThan(active);
  });

  it('never emits the old two-state vocabulary', () => {
    const labels = [
      hpaStatus(hpa({ conditions: [] })).label,
      hpaStatus(hpa({ conditions: [cond('ScalingActive', 'False')] })).label
    ];
    expect(labels).not.toContain('Degraded');
  });
});

describe('hpaLimitLabel', () => {
  const limited = (reason: string | null) => [{ type: 'ScalingLimited', status: 'True', reason, message: null }];

  it('names a min == max autoscaler as fixed rather than at its maximum', () => {
    expect(hpaLimitLabel(hpa({ minReplicas: 2, maxReplicas: 2, currentReplicas: 2, conditions: limited('TooFewReplicas') }))).toBe(
      'Fixed at 2 — min equals max, it cannot scale'
    );
  });

  it('names the floor from TooFewReplicas', () => {
    expect(hpaLimitLabel(hpa({ minReplicas: 3, currentReplicas: 3, maxReplicas: 15, conditions: limited('TooFewReplicas') }))).toBe(
      'Held at its minimum of 3'
    );
  });

  it('names the ceiling from TooManyReplicas or from the counts', () => {
    expect(hpaLimitLabel(hpa({ currentReplicas: 15, maxReplicas: 15, conditions: limited('TooManyReplicas') }))).toBe(
      'At maximum — cannot scale further'
    );
    // At max with no ScalingLimited: the controller is not clamping, so it is a reading, not the ceiling verdict.
    expect(hpaLimitLabel(hpa({ currentReplicas: 15, maxReplicas: 15 }))).toBe('Running at its maximum of 15, not clamped');
  });

  it('keeps unreported counts unknown and headroom as headroom', () => {
    expect(hpaLimitLabel(hpa({ currentReplicas: null, maxReplicas: null }))).toBe('not reported yet');
    expect(hpaLimitLabel(hpa({ currentReplicas: 3, maxReplicas: 15 }))).toBe('No — room to scale up');
  });
});

describe('hpaStatus and hpaLimitLabel agree', () => {
  const c = (type: string, status: string, reason: string | null = null) => ({ type, status, reason, message: null });
  const reasons = [null, 'TooFewReplicas', 'TooManyReplicas', 'ScaleUpLimit', 'ScaleDownLimit', 'Other'];
  const shapes: [number | null, number | null, number | null][] = [
    [2, 2, 2], [2, 10, 10], [2, 10, 6], [3, 15, 3], [null, null, null], [2, 10, null]
  ];

  it('never pairs a ceiling pill with a non-ceiling Limit, or the reverse', () => {
    for (const reason of reasons) {
      for (const [minReplicas, maxReplicas, currentReplicas] of shapes) {
        const conditions = [c('ScalingActive', 'True'), ...(reason ? [c('ScalingLimited', 'True', reason)] : [])];
        const row = hpa({ conditions, minReplicas, maxReplicas, currentReplicas });
        const pill = hpaStatus(row).label;
        const limit = hpaLimitLabel(row);
        const ctx = `${reason} ${minReplicas}/${maxReplicas} cur ${currentReplicas}: ${pill} vs ${limit}`;
        expect(pill === 'At ceiling', ctx).toBe(limit.startsWith('At maximum'));
        expect(pill.startsWith('Fixed at'), ctx).toBe(limit.startsWith('Fixed at'));
      }
    }
  });

  it('says scaling is disabled in the Limit field when the target is at 0', () => {
    const row = hpa({ conditions: [c('ScalingActive', 'False', 'ScalingDisabled')], currentReplicas: 0 });
    expect(hpaLimitLabel(row)).toBe('Scaling disabled — the target is at 0 replicas');
  });

  it('names rate limits in the Limit field', () => {
    const lim = (reason: string) =>
      hpaLimitLabel(hpa({ conditions: [c('ScalingActive', 'True'), c('ScalingLimited', 'True', reason)], minReplicas: 2, maxReplicas: 10, currentReplicas: 10 }));
    expect(lim('ScaleDownLimit')).toBe('Scaling down, slowed by its scale-down policy');
    expect(lim('ScaleUpLimit')).toBe('Scaling up, slowed by its scale-up policy');
  });
});
