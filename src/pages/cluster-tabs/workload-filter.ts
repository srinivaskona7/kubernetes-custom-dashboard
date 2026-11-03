/**
 * Composing the Workloads tab's kind pills with the namespace selection, with no JSX, so it can be
 * tested.
 *
 * `app/fleet-ui` runs vitest with `environment: 'node'` — jsdom cannot be installed on this
 * workstation (npm E401 against the internal registry). So the rules live here as plain functions
 * and `ClusterDetail.tsx` renders their answers.
 *
 * ## Every namespace judgement is delegated, never repeated
 *
 * `components/namespace-filter.ts` already owns what a selection means: the empty set is "all
 * namespaces", a cluster-scoped row belongs to no namespace so no selection can exclude it, and
 * members are OR (requirement 9). This module calls `matchesNamespace`/`namespacesOf` rather than
 * writing `selected.has(ns)` again, because a second copy of that predicate is a second answer to
 * one question, and the two would disagree the first time one of them learned about cluster-scoped
 * rows.
 *
 * ## Kind AND namespace, namespaces OR
 *
 * Requirement 7 — the pill and the namespace control must both keep working — is satisfied by
 * composition rather than by a combined predicate: `filterWorkloads` is `matchesKind` and
 * `matchesNamespace`, each usable alone, so requirement 8's example (Deployments + `acme-shop`) is
 * the same rows in either order. A test asserts that order-independence, because a single fused
 * predicate is exactly the shape that can silently prefer one filter over the other.
 *
 * ## The pill counts follow the namespace filter and ignore the kind filter
 *
 * A pill must show how many rows clicking it would reveal. That was "count the full list" while the
 * namespace control did not exist; with it, "would reveal" means *within the selected namespaces*,
 * so the counts are computed over the namespace-filtered list and never over the kind-filtered one.
 * Both halves matter: counting the kind-filtered list would make every inactive pill read 0, and
 * ignoring the namespace selection would leave `Deployment 14` on a pill that reveals 2 rows —
 * a number contradicted by the table beneath it, which on this console is a defect, not a rounding.
 *
 * ## Generic row shapes
 *
 * Requirement 15 puts the same control over Pods, Deployments, StatefulSets, DaemonSets, Jobs,
 * Services, ConfigMaps and Secrets. A function typed to `WorkloadRow` could not serve a Services
 * table, so the row filters constrain instead of naming: anything with a `namespace`. Only the pill
 * counts are pinned to `WorkloadRow`, because they count that tab's five specific pills.
 */
import type { WorkloadRow } from '../../api';
import { matchesNamespace, namespacesOf } from '../../components/namespace-filter';
import { flattenPods, type InventoryPod } from './pod-inventory';

/** The only shape the namespace filters require. `WorkloadRow` and `InventoryPod` both satisfy it. */
export interface Namespaced {
  /** Absent or null means cluster-scoped, which {@link matchesNamespace} keeps visible. */
  namespace?: string | null;
}

/** The only shape the kind filter requires. Declared as `string` so a Job or Service row fits too. */
export interface Kinded {
  kind: string;
}

/**
 * The pill vocabulary, restated here so this module has no import cycle back into `ClusterDetail`.
 *
 * Structurally identical to that file's local `WorkloadFilter`, so the two are mutually assignable
 * and the consumer can pass its own state through without a cast.
 */
export type WorkloadPill = 'all' | 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'pods';

/** The tab's whole filter state: which pill, and which namespaces. */
export interface WorkloadFilterState {
  kind: WorkloadPill;
  /** Empty means every namespace — see `namespace-filter.ts` for why that, and not "none". */
  namespaces: ReadonlySet<string>;
}

/**
 * The default, cleared, everything-shown selection.
 *
 * Exported as one shared instance so the consumer's initial state and its reset are the *same*
 * value: a fresh `new Set()` per render would change identity every time and defeat the `useMemo`
 * the filtered rows live in.
 */
export const ALL_NAMESPACES: ReadonlySet<string> = new Set<string>();

/** The namespace options for a set of rows, derived from the rows themselves (requirements 1, 2). */
export function namespaceOptions<T extends Namespaced>(rows: readonly T[]): string[] {
  return namespacesOf(rows, r => r.namespace);
}

/**
 * The rows a namespace selection admits.
 *
 * One code path for the empty selection rather than an early `return rows`: returning the input
 * unfiltered would hand the caller an array it could sort in place, and "empty selection behaves
 * exactly like no filter" is then proven by `matchesNamespace` and a test instead of by two
 * branches that have to agree.
 */
export function filterByNamespace<T extends Namespaced>(
  rows: readonly T[],
  namespaces: ReadonlySet<string>
): T[] {
  return rows.filter(r => matchesNamespace(r.namespace, namespaces));
}

/**
 * Whether a row's kind survives the pill.
 *
 * `all` and `pods` both admit every kind. `pods` re-cuts the same rows into one row per pod; it is
 * not a kind, and a `pods` pill that also dropped DaemonSet pods would be narrowing the operator
 * never asked for.
 */
export function matchesKind(kind: string, pill: WorkloadPill): boolean {
  return pill === 'all' || pill === 'pods' || kind === pill;
}

/** Kind AND namespace. The two predicates stay separate so either can be used on its own. */
export function filterWorkloads<T extends Namespaced & Kinded>(
  rows: readonly T[],
  f: WorkloadFilterState
): T[] {
  return rows.filter(r => matchesKind(r.kind, f.kind) && matchesNamespace(r.namespace, f.namespaces));
}

/**
 * The flat pod inventory under a namespace selection — the Pods sub-tab's rows.
 *
 * Exists because the Pods view renders from the raw workloads payload and not from the filtered
 * workload rows, so the filter has to land twice (the table and its count). Both call it, so
 * neither can drift into its own rule.
 *
 * Flatten first, then filter: `flattenPods` deduplicates a pod claimed by overlapping selectors and
 * merges every claimant into `owners`, and doing it in this order means the surviving row carries
 * the same owner list it would have carried unfiltered. Filtering the workloads first and
 * flattening after would produce the same rows today — a selector cannot cross namespaces — but it
 * would make the owner list depend on the filter, which is a property nothing should have.
 */
export function podInventoryRows(
  items: readonly WorkloadRow[],
  namespaces: ReadonlySet<string>
): InventoryPod[] {
  return filterByNamespace(flattenPods(items), namespaces);
}

/** One number per pill, keyed so the consumer can index it with the active pill directly. */
export interface WorkloadPillCounts {
  all: number;
  Deployment: number;
  StatefulSet: number;
  DaemonSet: number;
  pods: number;
}

/**
 * What each pill would reveal under the current namespace selection (requirement 10).
 *
 * Takes the namespace selection but *not* the pill — see the module header: this is the one
 * asymmetry in the whole filter, and it is what keeps every pill's number truthful while only one
 * of them is active.
 *
 * `pods` counts the deduplicated inventory rows rather than summing `w.pods.length`, because the
 * deduplicated rows are what the Pods table renders. The sum counts a pod once per workload whose
 * selector claimed it, so on a cluster with overlapping selectors — `platform-system` has them — the
 * pill promised more rows than the table could show.
 */
export function workloadPillCounts(
  items: readonly WorkloadRow[],
  namespaces: ReadonlySet<string>
): WorkloadPillCounts {
  const inScope = filterByNamespace(items, namespaces);
  const counts: WorkloadPillCounts = {
    all: inScope.length,
    Deployment: 0,
    StatefulSet: 0,
    DaemonSet: 0,
    // The same function the table calls, so the number and the rows cannot disagree.
    pods: podInventoryRows(items, namespaces).length
  };
  for (const w of inScope) counts[w.kind] += 1;
  return counts;
}

/**
 * `shown` and `total` for `resultLine`, within the active pill.
 *
 * `total` is what the pill would show across every namespace, so the line reads "2 of 14
 * deployments" and names exactly what the namespace selection hid. Totalling the whole cluster
 * instead would put the other kinds into a denominator the operator is not looking at, and
 * "2 of 68" beside a Deployments table answers a question nobody asked.
 *
 * The pods pill counts pods, because that is what its rows are.
 */
export function workloadShownOfTotal(
  items: readonly WorkloadRow[],
  f: WorkloadFilterState
): { shown: number; total: number } {
  if (f.kind === 'pods') {
    return {
      shown: podInventoryRows(items, f.namespaces).length,
      total: podInventoryRows(items, ALL_NAMESPACES).length
    };
  }
  return {
    shown: filterWorkloads(items, f).length,
    total: filterWorkloads(items, { kind: f.kind, namespaces: ALL_NAMESPACES }).length
  };
}

/**
 * What `FilterBar`'s reset badge counts — and it must count exactly what the reset clears.
 *
 * One per control, as `activeNodePodFilters` does: three selected namespaces are one filter to
 * clear, not three. Counting the members was considered and rejected — the badge sits on a button
 * reading "Clear filters", so a 3 there claims three things will go away when one will.
 *
 * The kind pill is deliberately not counted. It is sub-navigation: it is always on screen with its
 * own active state, clearing it would move the operator to a different table rather than reveal
 * rows in this one, and a badge that counts it while the reset leaves it alone is a badge that
 * lies. If the reset ever does return the pill to `all`, extend this function — the count and the
 * reset are one decision and belong in one place.
 */
export function activeWorkloadFilters(f: WorkloadFilterState): number {
  return f.namespaces.size > 0 ? 1 : 0;
}
