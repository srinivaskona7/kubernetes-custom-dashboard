import { describe, expect, it } from 'vitest';
import { initialOutcome, outcomeUnclassified } from './traces-view';

/*
  Review Focus 4 (plan 2026-09-27): Journeys opens on the outcome initialOutcome picks, so that
  outcome must never be a chip the toolbar disables. The two functions answer from different
  fields (classCounts.app vs classCounts' presence); this pins that they never disagree.
*/
describe('the default outcome is never a disabled chip', () => {
  const summaries = [
    undefined,
    {},
    { classCounts: {} },
    { classCounts: { app: 0 } },
    { classCounts: { app: 4 } },
    { classCounts: { 'direct-or-tls': 200 } }
  ];
  for (const s of summaries) {
    it(`summary ${JSON.stringify(s)}`, () => {
      expect(outcomeUnclassified(initialOutcome(s), s)).toBe(false);
    });
  }
});
