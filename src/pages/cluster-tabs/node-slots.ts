/*
  Pod slots, and what a free slot does and does not prove.

  Two numbers on the Nodes tab both used to be called "schedulable": the pod-slot bar summed every
  node that reported a `podCapacity`, with no readiness or cordon predicate, while the card beside
  it counted `ready && !unschedulable`. One word, two denominators. A cordoned node's slots are not
  schedulable by definition, and a NotReady node's are not placeable either, so the bar now applies
  the same predicate as the card — and names every node it left out rather than folding them in.

  The second half is a wording problem that no arithmetic fixes: a free slot is a kubelet ceiling,
  not a placement. Taints, nodeSelector/affinity and CPU/memory fit all gate the same pod. The one
  observed scheduling signal in this console is the `Pending Pods (unschedulable)` tile, which is
  the scheduler's own message passed through.

  JSX-free so it can be unit-tested under vitest's `environment: 'node'`.
*/

export interface SlotNode {
  name: string;
  pods: number;
  podCapacity: number | null;
  ready: boolean;
  unschedulable: boolean;
}

export interface SlotAccounting {
  /** Pods on the nodes the bar covers. Same nodes as `capacity`, always. */
  used: number;
  /** Summed `podCapacity` over Ready, uncordoned nodes that reported one. Null when none did. */
  capacity: number | null;
  pct: number | null;
  free: number | null;
  countedNodes: number;
  /** Excluded because they reported no pod capacity — unknown, not zero. */
  excludedNoCapacity: number;
  /** Excluded because nothing can be scheduled there right now. */
  excludedNotReady: number;
  excludedCordoned: number;
}

/**
 * The ONE readiness/cordon predicate behind both the "schedulable nodes" card and the pod-slot
 * bar's denominator. Exported and imported rather than re-typed inline, because the defect this
 * module exists to fix was two spellings of one word — and a test that re-writes the predicate to
 * compare against it would only be testing arithmetic. The guard in `node-slots.test.ts` asserts
 * instead that no caller spells it out again.
 */
export function isSchedulable(n: Pick<SlotNode, 'ready' | 'unschedulable'>): boolean {
  return n.ready && !n.unschedulable;
}

export function slotAccounting(nodes: readonly SlotNode[]): SlotAccounting {
  let used = 0;
  let capacity: number | null = null;
  let countedNodes = 0;
  let excludedNoCapacity = 0;
  let excludedNotReady = 0;
  let excludedCordoned = 0;

  for (const n of nodes) {
    if (!isSchedulable(n)) {
      if (!n.ready) excludedNotReady += 1;
      else excludedCordoned += 1;
      continue;
    }
    if (n.podCapacity === null) {
      excludedNoCapacity += 1;
      continue;
    }
    capacity = (capacity ?? 0) + n.podCapacity;
    used += n.pods;
    countedNodes += 1;
  }

  return {
    used,
    capacity,
    // `capacity ?` and not `!== null`: a counted capacity of 0 gives no denominator, so there is
    // no percentage to state — dividing by it would be Infinity, and printing 0% would be a lie in
    // the other direction.
    pct: capacity ? Math.round((used / capacity) * 100) : null,
    /**
     * Free slots, never negative. `capacity - used` can go below zero — a node reporting
     * `pods: "0"` while running pods, or a count read a moment apart from the capacity read — and
     * "-12 free across 1 node" is not a measurement, it is a contradiction. Clamped at 0, with
     * `used` and `capacity` both returned so the caller can see which way they disagree.
     */
    free: capacity === null ? null : Math.max(0, capacity - used),
    countedNodes,
    excludedNoCapacity,
    excludedNotReady,
    excludedCordoned
  };
}

/** The sentence naming the nodes the bar does not cover, or null when it covers all of them. */
export function slotExclusionNote(a: SlotAccounting): string | null {
  const parts: string[] = [];
  if (a.excludedNotReady > 0) parts.push(`${a.excludedNotReady} NotReady`);
  if (a.excludedCordoned > 0) parts.push(`${a.excludedCordoned} cordoned`);
  if (a.excludedNoCapacity > 0) parts.push(`${a.excludedNoCapacity} reporting no pod capacity`);
  if (parts.length === 0) return null;
  const n = a.excludedNotReady + a.excludedCordoned + a.excludedNoCapacity;
  return `${n} node${n === 1 ? '' : 's'} not counted here: ${parts.join(', ')}.`;
}

/*
  The node-conditions empty state.

  History, because the wording has to track the predicate: `srv/fleet/collectors/health.js` once
  built `problems` from MemoryPressure / DiskPressure / PIDPressure and friends while deliberately
  filtering `Ready` out — so an empty `problems` list claimed "No node is reporting NotReady,
  MemoryPressure, DiskPressure or PIDPressure" beside a red NotReady pill on the Nodes list.

  That is no longer how it works. `isProblemCondition` (health.js:137-159) is now the single
  node-problem predicate, `HEALTHY_WHEN_TRUE` is `{Ready, SystemdUnitsReady}`, and `nodeProblems`
  filters *every* condition through it — so a NotReady node IS a node with a problem condition, and
  an empty list is a genuine all-clear covering readiness too. The all-clear therefore no longer
  has to disclaim readiness.

  The NotReady branch below is kept as a contradiction detector rather than a known gap: if the
  node list says NotReady while `problems` came back empty, two reads disagree, and saying so is
  more useful than printing either one alone.
*/
export function nodeConditionsEmpty(nodes: readonly { ready: boolean; unschedulable: boolean }[]): {
  title: string;
  hint: string;
} {
  const notReady = nodes.filter(n => !n.ready).length;
  if (notReady > 0) {
    return {
      title: `${notReady} node${notReady === 1 ? ' is' : 's are'} NotReady`,
      hint: `No problem condition was reported, yet ${
        notReady === 1 ? 'one node reads' : `${notReady} nodes read`
      } NotReady on the Nodes list. Readiness is part of the same predicate, so these two reads disagree — treat the Nodes list as the live one.`
    };
  }
  return {
    title: 'No node conditions need attention',
    hint: 'No node is reporting NotReady, MemoryPressure, DiskPressure or PIDPressure. Readiness is part of the same predicate, so this covers it.'
  };
}
