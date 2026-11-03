import { describe, it, expect } from 'vitest';
import {
  DRAIN_BLOCKER_LABEL,
  DRAIN_BLOCKER_QUALIFIER,
  DRAIN_COVERAGE_CONVERSE,
  PDB_UNRECONCILED_LABEL,
  PDB_UNRECONCILED_WHY,
  drainBlockerHeading,
  unreconciledHeading
} from './pdb-drain';

describe('PDB drain vocabulary', () => {
  it('calls a cluster-wide disruptionsAllowed=0 count potential, not definitive', () => {
    expect(DRAIN_BLOCKER_LABEL).toBe('Potential drain blockers');
    expect(DRAIN_BLOCKER_LABEL).not.toBe('Drain blockers');
  });

  it('states the two limits of the measurement in the qualifier', () => {
    expect(DRAIN_BLOCKER_QUALIFIER).toMatch(/0 allowed disruptions/);
    expect(DRAIN_BLOCKER_QUALIFIER).toMatch(/cluster-wide/);
    expect(DRAIN_BLOCKER_QUALIFIER).toMatch(/not evaluated against a target node/);
  });

  it('states the converse, so a green coverage figure is not read as a drain rehearsal', () => {
    expect(DRAIN_COVERAGE_CONVERSE).toMatch(/does not prove a drain completes/);
  });

  it('keeps the heading a measurement and agrees in number', () => {
    expect(drainBlockerHeading(1)).toBe(
      'Potential drain blockers - 1 PDB currently at 0 allowed disruptions (cluster-wide; not evaluated against a target node)'
    );
    expect(drainBlockerHeading(3)).toMatch(/3 PDBs currently at 0 allowed disruptions/);
  });

  it('names an unreconciled PDB unknown rather than omitting it', () => {
    expect(PDB_UNRECONCILED_LABEL).toMatch(/status unknown/);
    expect(PDB_UNRECONCILED_WHY).toMatch(/observedGeneration does not match metadata.generation/);
    expect(PDB_UNRECONCILED_WHY).toMatch(/neither known to block a drain nor known not to/);
    expect(unreconciledHeading(2)).toMatch(/^2 PDBs not yet evaluated/);
  });
});
