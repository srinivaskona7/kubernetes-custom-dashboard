import { describe, expect, it } from 'vitest';
import { podState, reasonLabel, workloadStateSummary } from './pod-state';

/*
  The two facts this module exists to keep apart: a pod's phase, and a container's waiting reason.
  Every case below is a payload shape `srv/fleet/collectors/workloads.js` actually publishes.
*/

const running = (over: Partial<Parameters<typeof podState>[0]> = {}) => ({
  name: 'api-7f9c',
  phase: 'Running',
  reason: null,
  conditions: [
    { type: 'Ready', status: 'True' },
    { type: 'ContainersReady', status: 'True' }
  ],
  containers: [{ name: 'web', ready: true, init: false, reason: null }],
  ...over
});

describe('podState', () => {
  it('never puts a container reason in the phase slot', () => {
    const s = podState(
      running({
        reason: 'CrashLoopBackOff',
        conditions: [{ type: 'ContainersReady', status: 'False' }],
        containers: [{ name: 'web', ready: false, init: false, reason: 'CrashLoopBackOff' }]
      })
    );
    expect(s.phase).toBe('Running');
    expect(s.reason).toBe('CrashLoopBackOff');
    expect(s.containerRef).toBe('web');
    expect(reasonLabel(s)).toBe('CrashLoopBackOff (container web)');
    expect(s.tone).toBe('bad');
  });

  it('attributes the reason to the container that reported it, not the first container', () => {
    const s = podState(
      running({
        reason: 'ImagePullBackOff',
        containers: [
          { name: 'web', ready: true, init: false, reason: null },
          { name: 'sidecar', ready: false, init: false, reason: 'ImagePullBackOff' }
        ]
      })
    );
    expect(s.containerRef).toBe('sidecar');
  });

  it('reserves the ok tone for Running AND ContainersReady=True', () => {
    expect(podState(running()).tone).toBe('ok');
    expect(podState(running()).readyText).toBe('1/1');
  });

  it('warns on Running with ContainersReady=False and shows the ready count', () => {
    const s = podState(
      running({
        conditions: [
          { type: 'Ready', status: 'False' },
          { type: 'ContainersReady', status: 'False' }
        ],
        containers: [{ name: 'web', ready: false, init: false, reason: null }]
      })
    );
    expect(s.tone).toBe('warn');
    expect(s.readyText).toBe('0/1');
    expect(s.reason).toBeNull();
  });

  it('treats a missing ContainersReady condition as unknown readiness, not as ready', () => {
    const s = podState(running({ conditions: [] }));
    expect(s.tone).toBe('warn');
  });

  it('excludes initContainers from the ready count', () => {
    const s = podState(
      running({
        containers: [
          { name: 'init-db', ready: true, init: true, reason: null },
          { name: 'web', ready: true, init: false, reason: null }
        ]
      })
    );
    expect(s.readyText).toBe('1/1');
  });

  it('prints no ready count for a Succeeded pod and keeps it ok', () => {
    const s = podState(
      running({ phase: 'Succeeded', conditions: [], containers: [{ name: 'job', ready: false, init: false, reason: null }] })
    );
    expect(s.readyText).toBeNull();
    expect(s.tone).toBe('ok');
  });

  it('is bad on Failed and Unknown phases, and on an OOMKill with no waiting reason', () => {
    expect(podState(running({ phase: 'Failed', conditions: [] })).tone).toBe('bad');
    expect(podState(running({ phase: 'Unknown', conditions: [] })).tone).toBe('bad');
    expect(podState(running({ isOOMKilled: true })).tone).toBe('bad');
  });

  it('warns on Pending rather than claiming a phase is fine', () => {
    expect(podState(running({ phase: 'Pending', conditions: [], containers: [] })).tone).toBe('warn');
  });

  it('carries no ready count when the payload has no container statuses', () => {
    expect(podState(running({ containers: [] })).readyText).toBeNull();
  });
});

describe('workloadStateSummary', () => {
  /*
    These two cases previously passed `pods` and matched each pod's `reason` against `state`. That
    could never fire against real data: the collector's `state` is only ever
    Ready/Progressing/Unavailable, so no container waiting reason equals it, and the function was
    dead code that always returned the bare state. It now consumes the collector's own attributed
    `podIssues`, so the controller state and the container diagnosis are both on the row.
  */
  it('keeps the controller state and appends the attributed container reasons', () => {
    const s = workloadStateSummary('Progressing', [
      {
        reason: 'CrashLoopBackOff',
        pods: 2,
        containers: [
          { namespace: 'alpha', pod: 'api-1', container: 'web' },
          { namespace: 'alpha', pod: 'api-2', container: 'web' }
        ]
      }
    ]);
    expect(s.text).toBe('Progressing — 2 pods CrashLoopBackOff');
    expect(s.title).toContain("Progressing is this controller's own state");
    expect(s.title).toContain('alpha/api-1 (container web)');
    expect(s.title).toContain('alpha/api-2 (container web)');
  });

  it('orders several reasons worst first and pluralises a single pod', () => {
    const s = workloadStateSummary('Unavailable', [
      { reason: 'ImagePullBackOff', pods: 1, containers: [{ namespace: 'alpha', pod: 'api-9', container: 'web' }] },
      { reason: 'CrashLoopBackOff', pods: 3, containers: [] }
    ]);
    expect(s.text).toBe('Unavailable — 3 pods CrashLoopBackOff, 1 pod ImagePullBackOff');
  });

  it('leaves a state with no reported pod issues exactly as it is', () => {
    const s = workloadStateSummary('Ready', []);
    expect(s.text).toBe('Ready');
    expect(s.title).toBe('Ready');
  });
});
