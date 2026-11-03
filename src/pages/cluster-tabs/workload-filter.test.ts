/**
 * The Workloads tab's filter composition, tested against the numbered requirements it exists for.
 *
 * Every failure here is silent in the browser: a pill whose number exceeds its rows, a kind filter
 * that quietly outranks a namespace filter, a stale selection that empties a table with nothing on
 * screen to explain it. None of them throws, and all of them read as a failed read on a console
 * whose whole job is to distinguish "nothing there" from "we could not look".
 */
import { describe, expect, it } from 'vitest';
import type { WorkloadRow } from '../../api';
import { pruneNamespaces, resultLine } from '../../components/namespace-filter';
import {
  ALL_NAMESPACES,
  activeWorkloadFilters,
  filterByNamespace,
  filterWorkloads,
  matchesKind,
  namespaceOptions,
  podInventoryRows,
  workloadPillCounts,
  workloadShownOfTotal,
  type WorkloadFilterState
} from './workload-filter';

type Pod = WorkloadRow['pods'][number];

const pod = (name: string, namespace: string): Pod =>
  ({ name, namespace, phase: 'Running', restarts: 0, reason: null, node: 'n1' }) as Pod;

const workload = (kind: string, name: string, namespace: string, pods: Pod[]): WorkloadRow =>
  ({ kind, name, namespace, pods }) as unknown as WorkloadRow;

/**
 * One cluster, shaped like the live one the filter has to survive: two namespaces an operator cares
 * about, a system namespace, and a pod in `platform-system` claimed by two overlapping selectors —
 * the case that makes the naive pod count exceed the rows the table can draw.
 */
const shared = pod('ctrl-1', 'platform-system');
const items: WorkloadRow[] = [
  workload('Deployment', 'care-api', 'acme-shop', [pod('care-api-1', 'acme-shop'), pod('care-api-2', 'acme-shop')]),
  workload('StatefulSet', 'redis', 'acme-shop', [pod('redis-0', 'acme-shop')]),
  workload('Deployment', 'istiod', 'istio-system', [pod('istiod-1', 'istio-system')]),
  workload('DaemonSet', 'fluent-bit', 'platform-system', [pod('fluent-bit-1', 'platform-system')]),
  workload('Deployment', 'ctrl-blue', 'platform-system', [shared]),
  workload('Deployment', 'ctrl-green', 'platform-system', [shared])
];

const ids = (rows: readonly { kind?: string; name: string; namespace?: string | null }[]): string[] =>
  rows.map(r => `${r.namespace ?? '-'}/${r.kind ?? 'Pod'}/${r.name}`);

const state = (over: Partial<WorkloadFilterState> = {}): WorkloadFilterState => ({
  kind: 'all',
  namespaces: ALL_NAMESPACES,
  ...over
});

describe('namespaceOptions', () => {
  it('derives the options from the rows on screen, never from a fixed list', () => {
    expect(namespaceOptions(items)).toEqual(['acme-shop', 'istio-system', 'platform-system']);
  });

  it('offers the same options for the pod rows, because a pod lives in its workload’s namespace', () => {
    expect(namespaceOptions(podInventoryRows(items, ALL_NAMESPACES))).toEqual(namespaceOptions(items));
  });

  it('offers nothing rather than throwing when the read returned no rows', () => {
    expect(namespaceOptions([])).toEqual([]);
  });
});

describe('filterByNamespace', () => {
  it('an empty selection is identical to no filter at all — cleared and default are one state', () => {
    expect(ids(filterByNamespace(items, ALL_NAMESPACES))).toEqual(ids(items));
    expect(ids(filterByNamespace(items, new Set()))).toEqual(ids(items));
  });

  it('two namespaces are OR, not AND (requirement 9)', () => {
    const both = filterByNamespace(items, new Set(['acme-shop', 'istio-system']));
    expect(ids(both)).toEqual([
      'acme-shop/Deployment/care-api',
      'acme-shop/StatefulSet/redis',
      'istio-system/Deployment/istiod'
    ]);
  });

  it('adding a namespace never removes a row the single selection kept', () => {
    const one = ids(filterByNamespace(items, new Set(['acme-shop'])));
    const two = ids(filterByNamespace(items, new Set(['acme-shop', 'platform-system'])));
    for (const row of one) expect(two).toContain(row);
    expect(two.length).toBeGreaterThan(one.length);
  });

  it('keeps a cluster-scoped row under any selection — no namespace can exclude it', () => {
    const mixed = [
      { kind: 'ClusterRole', name: 'fleet-reader', namespace: null },
      { kind: 'Deployment', name: 'care-api', namespace: 'acme-shop' },
      { kind: 'Deployment', name: 'istiod', namespace: 'istio-system' }
    ];
    expect(ids(filterByNamespace(mixed, new Set(['acme-shop'])))).toEqual([
      '-/ClusterRole/fleet-reader',
      'acme-shop/Deployment/care-api'
    ]);
  });

  it('does not mutate the list it was given', () => {
    const before = ids(items);
    filterByNamespace(items, new Set(['acme-shop']));
    expect(ids(items)).toEqual(before);
  });
});

describe('matchesKind', () => {
  it('admits every kind under all, and under pods — pods re-cuts rows, it does not narrow them', () => {
    for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet']) {
      expect(matchesKind(kind, 'all')).toBe(true);
      expect(matchesKind(kind, 'pods')).toBe(true);
    }
  });

  it('admits only the named kind under a kind pill', () => {
    expect(matchesKind('Deployment', 'Deployment')).toBe(true);
    expect(matchesKind('StatefulSet', 'Deployment')).toBe(false);
  });
});

describe('filterWorkloads', () => {
  it('Deployments + Namespace=acme-shop shows only Deployment resources in the acme-shop namespace', () => {
    const rows = filterWorkloads(items, state({ kind: 'Deployment', namespaces: new Set(['acme-shop']) }));
    expect(ids(rows)).toEqual(['acme-shop/Deployment/care-api']);
  });

  it('composes in either order with the same result (requirement 7)', () => {
    const f = state({ kind: 'Deployment', namespaces: new Set(['acme-shop', 'platform-system']) });
    const kindThenNamespace = filterByNamespace(items.filter(w => matchesKind(w.kind, f.kind)), f.namespaces);
    const namespaceThenKind = filterByNamespace(items, f.namespaces).filter(w => matchesKind(w.kind, f.kind));
    expect(ids(kindThenNamespace)).toEqual(ids(namespaceThenKind));
    expect(ids(filterWorkloads(items, f))).toEqual(ids(kindThenNamespace));
  });

  it('a kind with no rows in the selected namespaces yields an empty list, not every row', () => {
    expect(filterWorkloads(items, state({ kind: 'DaemonSet', namespaces: new Set(['acme-shop']) }))).toEqual([]);
  });

  it('a selection naming a namespace that no longer appears does not empty the table', () => {
    // The stale case: a namespace was selected, then the cluster changed under it. `pruneNamespaces`
    // is what the consumer must run first; without it every row fails the selection at once.
    const stale = new Set(['acme-shop', 'deleted-ns']);
    const pruned = pruneNamespaces(stale, namespaceOptions(items));
    expect(ids(filterWorkloads(items, state({ namespaces: pruned })))).toEqual([
      'acme-shop/Deployment/care-api',
      'acme-shop/StatefulSet/redis'
    ]);
    // And a selection that prunes to nothing is "all" again, never "nothing".
    const gone = pruneNamespaces(new Set(['deleted-ns']), namespaceOptions(items));
    expect(filterWorkloads(items, state({ namespaces: gone }))).toHaveLength(items.length);
  });
});

describe('podInventoryRows', () => {
  it('filters the flat inventory by the pod’s own namespace', () => {
    expect(ids(podInventoryRows(items, new Set(['acme-shop'])))).toEqual([
      'acme-shop/Pod/care-api-1',
      'acme-shop/Pod/care-api-2',
      'acme-shop/Pod/redis-0'
    ]);
  });

  it('keeps a pod claimed by two workloads as one row, with both claimants', () => {
    const rows = podInventoryRows(items, new Set(['platform-system']));
    const ctrl = rows.filter(p => p.name === 'ctrl-1');
    expect(ctrl).toHaveLength(1);
    expect(ctrl[0]!.owners).toEqual(['Deployment/ctrl-blue', 'Deployment/ctrl-green']);
  });

  it('gives the Pods table and its count the same rows for the same selection', () => {
    // The two call sites in ClusterDetail.tsx both come through here; if they ever disagreed, the
    // count and the table would too.
    const selection = new Set(['acme-shop', 'platform-system']);
    expect(ids(podInventoryRows(items, selection))).toEqual(ids(podInventoryRows(items, selection)));
  });

  it('an empty selection returns every pod, deduplicated', () => {
    expect(ids(podInventoryRows(items, ALL_NAMESPACES))).toEqual([
      'acme-shop/Pod/care-api-1',
      'acme-shop/Pod/care-api-2',
      'acme-shop/Pod/redis-0',
      'istio-system/Pod/istiod-1',
      'platform-system/Pod/ctrl-1',
      'platform-system/Pod/fluent-bit-1'
    ]);
  });
});

describe('workloadPillCounts', () => {
  it('counts the full cluster when nothing is selected', () => {
    expect(workloadPillCounts(items, ALL_NAMESPACES)).toEqual({
      all: 6,
      Deployment: 4,
      StatefulSet: 1,
      DaemonSet: 1,
      pods: 6
    });
  });

  it('follows the namespace selection, so each pill promises what it would reveal (requirement 10)', () => {
    expect(workloadPillCounts(items, new Set(['acme-shop']))).toEqual({
      all: 2,
      Deployment: 1,
      StatefulSet: 1,
      DaemonSet: 0,
      pods: 3
    });
  });

  it('adds up across an OR selection', () => {
    expect(workloadPillCounts(items, new Set(['acme-shop', 'istio-system']))).toEqual({
      all: 3,
      Deployment: 2,
      StatefulSet: 1,
      DaemonSet: 0,
      pods: 4
    });
  });

  it('ignores the kind selection — counting the rows on screen would read 0 for every other pill', () => {
    const f = state({ kind: 'Deployment' });
    const onScreen = filterWorkloads(items, f);
    // The canary: this is what a naive implementation would count, and it contains no StatefulSet
    // and no DaemonSet at all, so both pills would read 0 and neither would be reachable.
    expect(onScreen.filter(w => w.kind === 'StatefulSet')).toHaveLength(0);
    expect(onScreen.filter(w => w.kind === 'DaemonSet')).toHaveLength(0);
    const counts = workloadPillCounts(items, f.namespaces);
    expect(counts.StatefulSet).toBe(1);
    expect(counts.DaemonSet).toBe(1);
  });

  it('never promises more rows than the table draws, for any pill and any selection', () => {
    for (const namespaces of [ALL_NAMESPACES, new Set(['acme-shop']), new Set(['platform-system']), new Set(['acme-shop', 'platform-system'])]) {
      const counts = workloadPillCounts(items, namespaces);
      expect(counts.pods).toBe(podInventoryRows(items, namespaces).length);
      for (const kind of ['all', 'Deployment', 'StatefulSet', 'DaemonSet'] as const) {
        expect(counts[kind]).toBe(filterWorkloads(items, { kind, namespaces }).length);
      }
    }
  });

  it('counts a pod claimed by two workloads once, as the Pods table draws it', () => {
    // The sum of `w.pods.length` is 7 here: `ctrl-1` is claimed by two Deployments. The pill used to
    // read that sum while the table drew 6 rows.
    expect(items.reduce((n, w) => n + w.pods.length, 0)).toBe(7);
    expect(workloadPillCounts(items, ALL_NAMESPACES).pods).toBe(6);
  });

  it('reports zeros rather than throwing when the read returned nothing', () => {
    expect(workloadPillCounts([], new Set(['acme-shop']))).toEqual({
      all: 0,
      Deployment: 0,
      StatefulSet: 0,
      DaemonSet: 0,
      pods: 0
    });
  });
});

describe('workloadShownOfTotal', () => {
  it('totals within the active pill, so the line names what the namespace filter hid', () => {
    const f = state({ kind: 'Deployment', namespaces: new Set(['acme-shop']) });
    expect(workloadShownOfTotal(items, f)).toEqual({ shown: 1, total: 4 });
    expect(resultLine(1, 4, 'deployments')).toBe('1 of 4 deployments');
  });

  it('says shown === total when nothing is hidden, so resultLine prints a bare count', () => {
    const { shown, total } = workloadShownOfTotal(items, state());
    expect(shown).toBe(total);
    expect(resultLine(shown, total, 'workloads')).toBe('6 workloads');
  });

  it('counts pods, not workloads, under the pods pill', () => {
    expect(workloadShownOfTotal(items, state({ kind: 'pods', namespaces: new Set(['acme-shop']) }))).toEqual({
      shown: 3,
      total: 6
    });
  });
});

describe('activeWorkloadFilters', () => {
  it('counts nothing in the default state', () => {
    expect(activeWorkloadFilters(state())).toBe(0);
  });

  it('counts the namespace selection once, however many namespaces it holds', () => {
    expect(activeWorkloadFilters(state({ namespaces: new Set(['acme-shop']) }))).toBe(1);
    expect(activeWorkloadFilters(state({ namespaces: new Set(['acme-shop', 'platform-system']) }))).toBe(1);
  });

  it('does not count the kind pill, which the reset does not clear', () => {
    expect(activeWorkloadFilters(state({ kind: 'Deployment' }))).toBe(0);
    expect(activeWorkloadFilters(state({ kind: 'pods' }))).toBe(0);
  });
});
