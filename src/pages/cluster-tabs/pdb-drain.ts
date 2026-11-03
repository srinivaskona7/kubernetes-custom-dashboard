/**
 * What a PDB at `disruptionsAllowed: 0` is allowed to be called.
 *
 * `srv/fleet/collectors/policy.js` filters cluster-wide on `status.disruptionsAllowed === 0`.
 * Nothing in that read is node-scoped, and the value is 0 transiently during any rollout, so a
 * PDB in the list may block no drain at all: its pods may not even be on the node being drained.
 * The component's own comment said as much while the label above it read "Drain blockers".
 *
 * The converse is the same mistake pointing the other way: `disruptionsAllowed >= 1` is not a
 * drain rehearsal — evicting one pod can drop the budget to 0 for the next.
 *
 * JSX-free so the strings are unit-tested (`app/fleet-ui` vitest runs `environment: 'node'`).
 */

export const DRAIN_BLOCKER_LABEL = 'Potential drain blockers';

export const DRAIN_BLOCKER_QUALIFIER =
  'PDBs currently at 0 allowed disruptions (cluster-wide; not evaluated against a target node)';

export const DRAIN_COVERAGE_CONVERSE =
  'The converse does not hold either: 1 or more allowed disruptions does not prove a drain completes, because evicting one pod can drop the budget to 0 for the next.';

/** The heading over the named list. Restates the measurement, never the conclusion. */
export function drainBlockerHeading(count: number): string {
  return `${DRAIN_BLOCKER_LABEL} - ${count} PDB${count === 1 ? '' : 's'} currently at 0 allowed disruptions (cluster-wide; not evaluated against a target node)`;
}

/**
 * A PDB whose `status.observedGeneration` does not match `metadata.generation` has not been
 * evaluated by the controller for its current spec, so `disruptionsAllowed` describes an older
 * spec or nothing at all. It belongs in neither the blocking nor the safe list; it is unknown,
 * and being silently absent from both is how it reads as safe.
 */
export const PDB_UNRECONCILED_LABEL = 'PDBs not yet evaluated by the controller - status unknown';

export const PDB_UNRECONCILED_WHY =
  'status.observedGeneration does not match metadata.generation, so the allowed-disruption count on this PDB does not describe its current spec. It is neither known to block a drain nor known not to.';

export function unreconciledHeading(count: number): string {
  return `${count} ${PDB_UNRECONCILED_LABEL}`;
}
