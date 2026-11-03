/**
 * The Logs-tab link, and which investigation steps a selected pod offers.
 *
 * Both are pure functions over a `URLSearchParams`/row pair precisely so they can be tested here
 * — the failure mode of a cross-tab link is never the click handler, it is which parameters
 * survive the jump. `vitest` runs without a DOM environment for this file, which is why these are
 * separate modules rather than logic inlined in `ClusterDetail`.
 */
import { describe, expect, it } from 'vitest';
import { clearLogParams, logParams } from './log-link';
import { investigationSteps, type PodLike } from '../../resources/investigate';
import type { ResourceRef } from '../../resources/types';

const podRef = (over: Partial<ResourceRef> = {}): ResourceRef => ({
  kind: 'Pod',
  namespace: 'ns-a',
  name: 'api-7d9f8b4c6-x2k9p',
  ...over
});

const pod = (over: Partial<PodLike> = {}): PodLike => ({
  namespace: 'ns-a',
  name: 'api-7d9f8b4c6-x2k9p',
  restarts: 0,
  containers: [{ name: 'api', restarts: 0 }],
  ...over
});

describe('logParams', () => {
  it('addresses the Logs tab with the namespace and pod', () => {
    const p = logParams(new URLSearchParams(), { namespace: 'ns-a', pod: 'api-1' });
    expect(p.get('tab')).toBe('logs');
    expect(p.get('ns')).toBe('ns-a');
    expect(p.get('pod')).toBe('api-1');
  });

  it('sets previous=1 only when asked, and the literal LogsTab tests for', () => {
    expect(logParams(new URLSearchParams(), { namespace: 'n', pod: 'p', previous: true }).get('previous')).toBe('1');
    expect(logParams(new URLSearchParams(), { namespace: 'n', pod: 'p', previous: false }).get('previous')).toBeNull();
    expect(logParams(new URLSearchParams(), { namespace: 'n', pod: 'p' }).get('previous')).toBeNull();
  });

  it('clears a stale previous flag when the next link does not ask for it', () => {
    // The bug this pins: read a crashlooping pod's previous log, then click Logs on a healthy
    // pod. A surviving `previous=1` shows "no previous instance" for a pod that is running fine.
    const from = new URLSearchParams({ tab: 'logs', ns: 'ns-a', pod: 'old', previous: '1' });
    const p = logParams(from, { namespace: 'ns-b', pod: 'new' });
    expect(p.get('previous')).toBeNull();
    expect(p.get('pod')).toBe('new');
  });

  it('deletes container rather than blanking it', () => {
    // `?container=` with an empty value reads as a selection named '', which LogsTab would try
    // and fail to match against the pod's real container list.
    const from = new URLSearchParams({ container: 'sidecar' });
    const p = logParams(from, { namespace: 'n', pod: 'p', container: null });
    expect(p.has('container')).toBe(false);
    expect(p.toString()).not.toContain('container');
  });

  it('never mutates the params it was given', () => {
    const from = new URLSearchParams({ tab: 'traffic' });
    logParams(from, { namespace: 'n', pod: 'p', previous: true });
    expect(from.get('tab')).toBe('traffic');
    expect(from.has('pod')).toBe(false);
  });

  it('preserves unrelated params so the drawer selection and tail size survive the jump', () => {
    const from = new URLSearchParams({ res: 'Pod/ns-a/api-1', tail: '2000' });
    const p = logParams(from, { namespace: 'ns-a', pod: 'api-1', container: 'api' });
    expect(p.get('res')).toBe('Pod/ns-a/api-1');
    expect(p.get('tail')).toBe('2000');
    expect(p.get('container')).toBe('api');
  });

  it('re-points the list filter at the target, so the pod is in the list it is selected in', () => {
    // The broken deep link this pins. `ns` selects a pod; `filterNs` filters the list. A link that
    // set the first and left the second pointing at an earlier visit's namespace filtered the named
    // pod out of its own list — and LogsTab's auto-select effect then quietly opened whichever pod
    // happened to be first in the *other* namespace. A confident wrong log, with nothing said.
    const from = new URLSearchParams({ tab: 'logs', filterNs: 'istio-system', ns: 'istio-system', pod: 'old' });
    const p = logParams(from, { namespace: 'polls', pod: 'polls-backend-1' });
    expect(p.get('ns')).toBe('polls');
    expect(p.get('pod')).toBe('polls-backend-1');
    expect(p.get('filterNs')).toBe('polls');
  });

  it('sets the list filter even when there was none before', () => {
    const p = logParams(new URLSearchParams(), { namespace: 'ns-a', pod: 'api-1' });
    expect(p.get('filterNs')).toBe('ns-a');
  });
});

describe('clearLogParams', () => {
  it('strips every Logs param, including previous', () => {
    const from = new URLSearchParams({ tab: 'logs', ns: 'n', pod: 'p', container: 'c', previous: '1', node: 'n1' });
    const p = clearLogParams(from);
    for (const k of ['ns', 'pod', 'container', 'previous']) expect(p.has(k)).toBe(false);
    // Not this function's job — `setTab` handles `node` and `workload` separately.
    expect(p.get('node')).toBe('n1');
  });

  it('strips the list state too, so no dead filter follows the operator into another tab', () => {
    const from = new URLSearchParams({ tab: 'logs', filterNs: 'polls', sort: 'problems' });
    const p = clearLogParams(from);
    expect(p.has('filterNs')).toBe(false);
    expect(p.has('sort')).toBe(false);
  });

  it('keeps how the reader likes to read a log, which is not which log they were reading', () => {
    // `tail` and `dir` are settings. Clearing them means re-picking "2000 lines, newest first"
    // on every single arrival, which is what made them URL state in the first place.
    const from = new URLSearchParams({ tab: 'logs', tail: '2000', dir: 'newest', pod: 'p' });
    const p = clearLogParams(from);
    expect(p.get('tail')).toBe('2000');
    expect(p.get('dir')).toBe('newest');
    expect(p.has('pod')).toBe(false);
  });
});

describe('investigationSteps', () => {
  it('offers the live log for a healthy pod, and nothing about a restart', () => {
    const steps = investigationSteps(podRef(), pod());
    expect(steps.map(s => s.kind)).toEqual(['logs']);
  });

  it('offers the previous instance once a pod has restarted', () => {
    const steps = investigationSteps(podRef(), pod({ restarts: 5 }));
    expect(steps.map(s => s.kind)).toEqual(['logs', 'logs-previous']);
    expect(steps[1]?.why).toContain('5 times');
  });

  it('says "once" rather than "1 times"', () => {
    const steps = investigationSteps(podRef(), pod({ restarts: 1 }));
    expect(steps[1]?.why).toContain('restarted once');
  });

  it('scopes the restart count to the selected container, not the pod', () => {
    // A pod whose sidecar is flapping while the app container is fine must not offer "logs
    // before the last restart" on the app container — that container has no previous instance,
    // so the link would land on an empty state.
    const row = pod({
      restarts: 9,
      containers: [
        { name: 'api', restarts: 0 },
        { name: 'istio-proxy', restarts: 9 }
      ]
    });
    expect(investigationSteps(podRef({ kind: 'Container', container: 'api' }), row).map(s => s.kind)).toEqual([
      'logs'
    ]);
    expect(
      investigationSteps(podRef({ kind: 'Container', container: 'istio-proxy' }), row).map(s => s.kind)
    ).toEqual(['logs', 'logs-previous']);
  });

  it('targets the container when one is selected', () => {
    const steps = investigationSteps(podRef({ kind: 'Container', container: 'istio-proxy' }), pod());
    expect(steps[0]?.target.container).toBe('istio-proxy');
    expect(steps[0]?.why).toContain('container istio-proxy');
  });

  it('takes the pod identity from the row, not the ref', () => {
    const steps = investigationSteps(podRef({ name: 'stale-name' }), pod({ namespace: 'ns-real', name: 'pod-real' }));
    expect(steps[0]?.target).toMatchObject({ namespace: 'ns-real', pod: 'pod-real' });
  });

  it('offers nothing for a Kind with no evidence screen', () => {
    expect(investigationSteps({ kind: 'Service', namespace: 'ns-a', name: 'svc' }, {})).toEqual([]);
    expect(investigationSteps({ kind: 'Node', namespace: null, name: 'node-1' }, {})).toEqual([]);
  });

  it('offers nothing when the row did not resolve', () => {
    // "Not in view" is a real and common drawer state — a ref can outlive a rename. A step list
    // built from a missing row would link to a pod that is not there.
    expect(investigationSteps(podRef(), undefined)).toEqual([]);
    expect(investigationSteps(podRef(), null)).toEqual([]);
    expect(investigationSteps(podRef(), {})).toEqual([]);
    expect(investigationSteps(podRef(), 'not-a-row')).toEqual([]);
  });

  it('treats a null or absent restart count as zero rather than throwing', () => {
    expect(investigationSteps(podRef(), pod({ restarts: null })).map(s => s.kind)).toEqual(['logs']);
    expect(
      investigationSteps(podRef({ kind: 'Container', container: 'api' }), {
        namespace: 'n',
        name: 'p',
        containers: null
      }).map(s => s.kind)
    ).toEqual(['logs']);
  });

  it('never offers a workload link, because the pod payload carries no ownerReference', () => {
    // Invariant: relationship navigation uses real relationships. Deriving the controller from
    // `api-7d9f8b4c6-x2k9p` → `api` is string similarity, and this pins that nothing added it
    // back on the grounds that it "usually works".
    const steps = investigationSteps(podRef(), pod({ restarts: 3 }));
    expect(steps.every(s => s.kind === 'logs' || s.kind === 'logs-previous')).toBe(true);
    expect(JSON.stringify(steps).toLowerCase()).not.toContain('workload');
  });
});
