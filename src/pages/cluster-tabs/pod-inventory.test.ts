/**
 * Flattening the workloads payload into a pod inventory, and what the Owner column may claim.
 *
 * The regression these pin is a real one from `platform-sbx`: three Deployments in `platform-system`
 * share the selector `control-plane: controller-manager`, so the pod
 * `istio-controller-manager-79bd8f969f-d8bmw` is claimed by `application-connector-controller-manager`,
 * `istio-controller-manager` and `kim-snatch-controller-manager`. The table named the first of
 * them, and named it in the same tone as a correct answer.
 */
import { describe, expect, it } from 'vitest';
import { flattenPods, ownerVerdict } from './pod-inventory';
import type { WorkloadRow } from '../../api';

type Pod = WorkloadRow['pods'][number];

const pod = (over: Partial<Pod> = {}): Pod =>
  ({ name: 'p', namespace: 'ns', phase: 'Running', restarts: 0, reason: null, node: 'n1', ...over }) as Pod;

const workload = (name: string, pods: Pod[], kind = 'Deployment'): WorkloadRow =>
  ({ name, namespace: 'ns', kind, pods } as unknown as WorkloadRow);

describe('flattenPods', () => {
  it('emits one row per pod even when several workloads select it', () => {
    const p = pod({ name: 'ctrl-1' });
    const rows = flattenPods([workload('a', [p]), workload('b', [p]), workload('c', [p])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owners).toEqual(['Deployment/a', 'Deployment/b', 'Deployment/c']);
  });

  it('keys on namespace and name, so the same pod name in two namespaces stays two rows', () => {
    const rows = flattenPods([
      workload('a', [pod({ name: 'nginx', namespace: 'ns-1' })]),
      workload('b', [pod({ name: 'nginx', namespace: 'ns-2' })])
    ]);
    expect(rows.map(r => `${r.namespace}/${r.name}`)).toEqual(['ns-1/nginx', 'ns-2/nginx']);
  });

  it('records a workload once even if it lists the same pod twice', () => {
    const p = pod({ name: 'dup' });
    const rows = flattenPods([workload('a', [p, p])]);
    expect(rows[0]?.owners).toEqual(['Deployment/a']);
  });

  it('distinguishes two Kinds with the same name', () => {
    const p = pod({ name: 'x' });
    const rows = flattenPods([workload('api', [p], 'Deployment'), workload('api', [p], 'StatefulSet')]);
    expect(rows[0]?.owners).toEqual(['Deployment/api', 'StatefulSet/api']);
  });

  it('sorts a pod with a reason ahead of one that is merely not Running', () => {
    const rows = flattenPods([
      workload('a', [
        pod({ name: 'running', phase: 'Running' }),
        pod({ name: 'pending', phase: 'Pending' }),
        pod({ name: 'crashing', phase: 'Running', reason: 'CrashLoopBackOff' })
      ])
    ]);
    expect(rows.map(r => r.name)).toEqual(['crashing', 'pending', 'running']);
  });

  it('sorts by namespace and name within one severity', () => {
    const rows = flattenPods([
      workload('a', [pod({ name: 'b', namespace: 'ns-2' }), pod({ name: 'a', namespace: 'ns-2' })]),
      workload('b', [pod({ name: 'z', namespace: 'ns-1' })])
    ]);
    expect(rows.map(r => `${r.namespace}/${r.name}`)).toEqual(['ns-1/z', 'ns-2/a', 'ns-2/b']);
  });

  it('returns nothing for no workloads, and nothing for workloads with no pods', () => {
    expect(flattenPods([])).toEqual([]);
    expect(flattenPods([workload('a', [])])).toEqual([]);
  });

  it('does not mutate the pods it was given', () => {
    const p = pod({ name: 'x' });
    flattenPods([workload('a', [p]), workload('b', [p])]);
    expect('owners' in p).toBe(false);
  });
});

describe('ownerVerdict', () => {
  it('names the workload when exactly one selects the pod', () => {
    expect(ownerVerdict(['Deployment/api'])).toEqual({
      kind: 'one',
      name: 'api',
      full: 'Deployment/api'
    });
  });

  it('refuses to name one when several do', () => {
    // The specific bug: this used to return `application-connector-controller-manager`, which is
    // the wrong component, for a pod belonging to none of the three unambiguously.
    const v = ownerVerdict([
      'Deployment/application-connector-controller-manager',
      'Deployment/istio-controller-manager',
      'Deployment/kim-snatch-controller-manager'
    ]);
    expect(v.kind).toBe('ambiguous');
    expect(v).toMatchObject({ count: 3 });
    // Every candidate stays available for the tooltip — the ambiguity is reported, not hidden.
    expect(v.kind === 'ambiguous' && v.candidates).toHaveLength(3);
    expect(JSON.stringify(v)).not.toMatch(/"name"/);
  });

  it('reports none rather than a count of zero', () => {
    expect(ownerVerdict([])).toEqual({ kind: 'none' });
  });

  it('keeps a malformed entry whole rather than rendering an empty cell', () => {
    expect(ownerVerdict(['justaname'])).toMatchObject({ kind: 'one', name: 'justaname' });
  });

  it('copies the candidate list, so a caller cannot edit the row it came from', () => {
    const owners = ['Deployment/a', 'Deployment/b'];
    const v = ownerVerdict(owners);
    if (v.kind === 'ambiguous') v.candidates.push('Deployment/c');
    expect(owners).toHaveLength(2);
  });
});
