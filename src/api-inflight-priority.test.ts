/**
 * The join/upgrade decision `sharedGet` makes when a caller finds an entry already in flight.
 *
 * Pinned separately from prefetch.test.ts's timing-based coverage because this is the one
 * property that must hold regardless of *when* the two callers arrive: a foreground caller
 * never inherits a `low` demotion by joining someone else's read.
 */
import { describe, expect, it } from 'vitest';

import { shouldJoinInflight } from './api';

describe('shouldJoinInflight', () => {
  it('refuses to join a low entry for a foreground caller', () => {
    expect(shouldJoinInflight('low', undefined)).toBe(false);
  });

  it('lets a low caller join a foreground entry', () => {
    expect(shouldJoinInflight(undefined, 'low')).toBe(true);
  });

  it('lets a foreground caller join a foreground entry', () => {
    expect(shouldJoinInflight(undefined, undefined)).toBe(true);
  });

  it('lets a low caller join a low entry', () => {
    expect(shouldJoinInflight('low', 'low')).toBe(true);
  });
});
