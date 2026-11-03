/**
 * Turning the workloads payload inside out: one row per pod, with every workload that claims it.
 *
 * This is pure and lives in its own module for one reason — the interesting part is not the
 * rendering, it is *ownership*, and ownership here is not a fact the backend supplies. The pods
 * inside a `WorkloadRow` were matched by **label selector**, and selectors overlap. Three
 * Deployments in `kyma-system` share `control-plane: controller-manager`, so one pod legitimately
 * appears under all three, and the naive flatten rendered it three times until React complained
 * about the duplicate key.
 *
 * Deduplicating is the easy half. The half that was wrong for longer is what to *show*: the
 * column named the first claimant, so `istio-controller-manager-…` was labelled
 * `application-connector-controller-manager`, a name from a different component, rendered exactly
 * as confidently as a correct one.
 *
 * `PodRow` carries no `ownerReferences` (see `api.ts`), and deriving a controller from
 * `api-7d9f8b4c6-x2k9p` → `api` is string similarity, which the relationship model forbids. So
 * this function reports the ambiguity instead of resolving it, and the caller renders it.
 */
import type { WorkloadRow } from '../../api';

/** A pod as it appears in the flat inventory: the workload's own row plus who claimed it. */
export type InventoryPod = WorkloadRow['pods'][number] & { owners: string[] };

/** `Kind/name`, the form the tooltip lists and the column strips for display. */
function ownerKey(w: WorkloadRow): string {
  return `${w.kind}/${w.name}`;
}

/**
 * Sort key: unhealthy first, then namespace/name.
 *
 * A pod with a `reason` is worse than one that is merely not `Running`, which is worse than one
 * that is running — the same order the workload table uses, so the two tables read alike.
 */
function severity(p: InventoryPod): number {
  if (p.reason) return 0;
  return p.phase === 'Running' ? 2 : 1;
}

/**
 * @param items every workload on the cluster, each with its selector-matched pods
 * @returns one row per pod, worst first, each carrying every workload that selected it
 */
export function flattenPods(items: readonly WorkloadRow[]): InventoryPod[] {
  const byKey = new Map<string, InventoryPod>();

  for (const w of items) {
    for (const p of w.pods) {
      const k = `${p.namespace}/${p.name}`;
      const owner = ownerKey(w);
      const seen = byKey.get(k);
      if (seen) {
        if (!seen.owners.includes(owner)) seen.owners.push(owner);
      } else {
        byKey.set(k, { ...p, owners: [owner] });
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      severity(a) - severity(b) || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
  );
}

/**
 * What the Owner column says.
 *
 * `{ kind: 'one' }` names the workload. `{ kind: 'ambiguous' }` says how many selected the pod and
 * refuses to name one, because naming one would be a coin toss presented as an answer.
 * `{ kind: 'none' }` should be unreachable — a row exists only because some workload claimed it —
 * and renders as an em dash rather than as `0 workloads`.
 */
export type OwnerVerdict =
  | { kind: 'none' }
  | { kind: 'one'; name: string; full: string }
  | { kind: 'ambiguous'; count: number; candidates: string[] };

export function ownerVerdict(owners: readonly string[]): OwnerVerdict {
  if (!owners.length) return { kind: 'none' };
  if (owners.length === 1) {
    const full = owners[0] as string;
    // `Kind/name` → `name`. A name containing a slash is not possible in Kubernetes, so the
    // split is safe; the fallback covers a malformed entry rather than a legal one.
    return { kind: 'one', name: full.split('/')[1] ?? full, full };
  }
  return { kind: 'ambiguous', count: owners.length, candidates: [...owners] };
}
