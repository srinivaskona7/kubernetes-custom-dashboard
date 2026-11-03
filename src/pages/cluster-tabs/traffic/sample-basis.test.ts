/**
 * The sample-basis rules, pinned.
 *
 * The bias claim is the one worth a test: it must appear when the cap bit and must NOT appear when
 * every candidate was read, because "edge-weighted" on a complete read is as wrong as silence on a
 * capped one.
 */
import { describe, expect, it } from 'vitest';
import {
  isCompleteRead,
  isEdgeWeighted,
  proxiesFailedCount,
  sampleBasis,
  selectionBiasLine,
  timedCaption,
  timedRequests,
  type SampleBasisWindow
} from './sample-basis';

const w = (over: Partial<SampleBasisWindow> = {}): SampleBasisWindow => ({
  proxiesRead: 10,
  proxyCandidates: 42,
  proxiesSkipped: 32,
  tailLines: 300,
  readsSkipped: false,
  proxiesFailed: [],
  ...over
});

/** Three proxies that answered 403 on `pods/log` — the least random omission there is. */
const refused = [
  { namespace: 'prod', pod: 'checkout-7f9', reason: 'FORBIDDEN' },
  { namespace: 'prod', pod: 'orders-1ab', reason: 'FORBIDDEN' },
  { namespace: 'prod', pod: 'carts-9cd', reason: 'TIMEOUT' }
];

describe('sampleBasis', () => {
  it('prints proxies read, candidates and lines each, and marks a capped read edge-weighted', () => {
    expect(sampleBasis(w())).toBe('from 10 of 42 proxies, 300 lines each — edge-weighted');
  });

  it('does not claim a skew when every candidate was read', () => {
    expect(sampleBasis(w({ proxiesRead: 8, proxyCandidates: 8, proxiesSkipped: 0 }))).toBe(
      'from 8 of 8 proxies, 300 lines each — every proxy in scope was read'
    );
  });

  it('says there is no sample when the read was skipped', () => {
    expect(sampleBasis(w({ readsSkipped: true }))).toBe('no sample — none of 42 proxies were read');
  });

  it('is empty with no window rather than inventing zeros', () => {
    expect(sampleBasis(undefined)).toBe('');
  });

  it('never calls a read with refused proxies complete, even when the cap bit nothing', () => {
    expect(
      sampleBasis(w({ proxiesRead: 5, proxyCandidates: 8, proxiesSkipped: 0, proxiesFailed: refused }))
    ).toBe('from 5 of 8 proxies, 300 lines each — 3 could not be read');
  });

  it('names both defects when the cap bit and proxies also refused', () => {
    expect(sampleBasis(w({ proxiesFailed: refused }))).toBe(
      'from 10 of 42 proxies, 300 lines each — edge-weighted, 3 could not be read'
    );
  });

  it('says there is no sample when every proxy asked failed, rather than "from 0 of 42"', () => {
    expect(sampleBasis(w({ proxiesRead: 0, proxiesFailed: refused }))).toBe(
      'no sample — all 3 proxies asked of 42 failed to answer'
    );
  });
});

describe('isCompleteRead', () => {
  it('is true only when nothing was capped and nothing refused', () => {
    expect(isCompleteRead(w({ proxiesSkipped: 0 }))).toBe(true);
    expect(isCompleteRead(w())).toBe(false);
    expect(isCompleteRead(w({ proxiesSkipped: 0, proxiesFailed: refused }))).toBe(false);
    expect(isCompleteRead(w({ readsSkipped: true, proxiesSkipped: 0 }))).toBe(false);
    expect(isCompleteRead(undefined)).toBe(false);
  });
});

describe('proxiesFailedCount', () => {
  it('counts the refused reads, and is 0 with no window', () => {
    expect(proxiesFailedCount(w({ proxiesFailed: refused }))).toBe(3);
    expect(proxiesFailedCount(w())).toBe(0);
    expect(proxiesFailedCount(undefined)).toBe(0);
  });
});

describe('isEdgeWeighted', () => {
  it('is true only when the per-request cap bit', () => {
    expect(isEdgeWeighted(w())).toBe(true);
    expect(isEdgeWeighted(w({ proxiesSkipped: 0 }))).toBe(false);
    expect(isEdgeWeighted(w({ readsSkipped: true }))).toBe(false);
    expect(isEdgeWeighted(undefined)).toBe(false);
  });
});

describe('selectionBiasLine', () => {
  it('names the order, the count over the cap, and what it does to a mesh-wide figure', () => {
    const line = selectionBiasLine(w());
    expect(line).toContain('Ingress gateways are read first');
    expect(line).toContain('32 of 42 proxies were over the per-request cap');
    expect(line).toContain('edge-weighted');
  });

  it('states plainly that nothing is skewed when nothing was skipped', () => {
    expect(selectionBiasLine(w({ proxiesSkipped: 0 }))).toBe(
      'All 42 proxies with an istio-proxy container were read, so the read order skews nothing.'
    );
  });

  it('never says a read order skews nothing when proxies were refused', () => {
    const line = selectionBiasLine(w({ proxiesRead: 5, proxyCandidates: 8, proxiesSkipped: 0, proxiesFailed: refused }));
    expect(line).not.toContain('skews nothing');
    expect(line).toBe(
      '3 of 8 proxies were asked and could not be read (prod/checkout-7f9 (FORBIDDEN), ' +
        'prod/orders-1ab (FORBIDDEN), prod/carts-9cd (TIMEOUT)), so their traffic is missing from ' +
        'every figure below. A refused read follows permissions and reachability, not chance, so ' +
        'what it omits is not a random sample.'
    );
  });

  it('counts the unnamed remainder past the first three', () => {
    const many = [...refused, { namespace: 'prod', pod: 'search-2ef', reason: null }];
    expect(selectionBiasLine(w({ proxiesSkipped: 0, proxiesFailed: many }))).toContain('and 1 more');
  });

  it('reports both the cap and the refusals when both happened', () => {
    const line = selectionBiasLine(w({ proxiesFailed: refused }));
    expect(line).toContain('over the per-request cap');
    expect(line).toContain('could not be read');
    expect(line).not.toContain('skews nothing');
  });

  it('describes no bias over an empty sample when every proxy asked failed', () => {
    const line = selectionBiasLine(w({ proxiesRead: 0, proxiesFailed: refused }));
    expect(line).toBe(
      'Every proxy that was asked failed to answer (prod/checkout-7f9 (FORBIDDEN), ' +
        'prod/orders-1ab (FORBIDDEN), prod/carts-9cd (TIMEOUT)), so there is no sample and no share ' +
        'below describes the mesh.'
    );
  });
});

describe('timedRequests', () => {
  it('sums the per-bucket sample counts, which is the n behind the percentiles', () => {
    expect(timedRequests([{ samples: 3 }, { samples: 0 }, { samples: 11 }])).toBe(14);
  });

  it('is 0 for no buckets, and never reads a request count', () => {
    expect(timedRequests(undefined)).toBe(0);
    expect(timedRequests([])).toBe(0);
  });
});

describe('timedCaption', () => {
  it('names both numbers when some HTTP records carried no duration', () => {
    expect(timedCaption(900, 1136)).toBe('900 of 1,136 HTTP records carried a duration');
  });

  it('does not print a fraction when they agree', () => {
    expect(timedCaption(1136, 1136)).toBe('Every one of 1,136 HTTP records carried a duration');
  });

  it('never divides by zero', () => {
    expect(timedCaption(0, 0)).toBe('No HTTP record was read — TCP records excluded');
  });
});
