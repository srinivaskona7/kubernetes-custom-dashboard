/**
 * Traces → the journey waterfall and the Outbound sub-tab's words.
 */
import { describe, expect, it } from 'vitest';
import type { Trace, TraceHop, TraceOutboundRow } from '../../api';
import { barOf, hopFill, journeyBreakdown, linkNote, ticksOf, transitBar, upstreamShare } from './waterfall';
import { byteText, linkSummary, outboundHeadline } from './outbound-view';

const hop = (over: Partial<TraceHop>): TraceHop => ({ durationMs: null, upstreamMs: null, proxyOverheadMs: null, transitMs: null, offsetMs: 0, ...over }) as TraceHop;
const trace = (hops: TraceHop[], over: Partial<Trace> = {}) => ({ hops, nestingAnomaly: false, correlatedBy: 'traceparent' as const, ...over });

describe('journey breakdown', () => {
  it('splits the edge duration into between-hops, innermost proxy and app, summing exactly', () => {
    const b = journeyBreakdown(trace([hop({ durationMs: 50, transitMs: 8 }), hop({ durationMs: 42, upstreamMs: 39, proxyOverheadMs: 3 })])).value!;
    expect(b).toMatchObject({ totalMs: 50, betweenMs: 8, proxyMs: 3, appMs: 39, derived: false });
    expect(b.betweenMs + b.proxyMs + b.appMs).toBe(b.totalMs);
  });

  it('marks a split over duration-ordered hops as derived', () => {
    expect(journeyBreakdown(trace([hop({ durationMs: 5, transitMs: 1 }), hop({ durationMs: 4, upstreamMs: 3, proxyOverheadMs: 1 })], { correlatedBy: 'request-id' })).value!.derived).toBe(true);
    expect(journeyBreakdown(trace([hop({ durationMs: 4, upstreamMs: 3, proxyOverheadMs: 1 })], { correlatedBy: 'request-id' })).value!.derived).toBe(false);
  });

  it('refuses a partial split rather than publishing one that reads as whole', () => {
    expect(journeyBreakdown(trace([hop({ durationMs: 5, transitMs: 1 }), hop({ durationMs: 4 })])).value).toBeNull();
    expect(journeyBreakdown(trace([hop({ durationMs: 5 }), hop({ durationMs: 4, upstreamMs: 3, proxyOverheadMs: 1 })])).reason).toMatch(/transit/);
    expect(journeyBreakdown(trace([hop({ durationMs: 4, upstreamMs: 3, proxyOverheadMs: 1 })], { nestingAnomaly: true })).reason).toMatch(/do not nest/);
    expect(journeyBreakdown(trace([])).value).toBeNull();
  });
});

describe('waterfall geometry', () => {
  it('clips an interval that outlives the journey, and says so', () => {
    expect(barOf(11, 5138, 200)).toMatchObject({ clipped: true });
    expect(barOf(11, 5138, 200)!.left + barOf(11, 5138, 200)!.width).toBeLessThanOrEqual(100);
    expect(barOf(0, 100, 200)).toEqual({ left: 0, width: 50, clipped: false, early: false });
    // Skew: starts 20ms before the zero, lasts 60ms — drawn from 0 to 40ms, never to 60ms.
    expect(barOf(-20, 60, 200)).toEqual({ left: 0, width: 20, clipped: false, early: true });
  });

  it('draws nothing without a start, a length or a span', () => {
    expect(barOf(null, 5, 10)).toBeNull();
    expect(barOf(0, null, 10)).toBeNull();
    expect(barOf(0, 5, 0)).toBeNull();
  });

  it('gives the upstream share of a hop only when it was logged', () => {
    expect(upstreamShare({ durationMs: 40, upstreamMs: 30 })).toBe(75);
    expect(upstreamShare({ durationMs: 40, upstreamMs: null })).toBeNull();
    expect(upstreamShare({ durationMs: 0, upstreamMs: 0 })).toBeNull();
  });

  it('ticks at the start, the middle and the end', () => {
    expect(ticksOf(200).map(t => t[1])).toEqual([0, 100, 200]);
    expect(ticksOf(0)).toEqual([]);
  });

  it('says how crowded an inferred link was', () => {
    expect(linkNote({ candidates: 1 })).toBe('inferred');
    expect(linkNote({ candidates: 3 })).toBe('inferred · 3 in flight');
  });
});

describe('hop fill and transit', () => {
  it('ingress and sidecar share the ok tone; a failure is bad', () => {
    expect(hopFill(hop({ codeClass: 'ok', role: 'ingress' } as Partial<TraceHop>))).toEqual({ solid: 'bg-ok', outline: 'border-ok bg-ok/20' });
    expect(hopFill(hop({ codeClass: 'server', role: 'sidecar' } as Partial<TraceHop>))).toEqual({ solid: 'bg-bad', outline: 'border-bad bg-bad/20' });
  });
  it('transit sits at the end of the caller bar, sized from transitMs', () => {
    expect(transitBar(hop({ offsetMs: 0, durationMs: 100, transitMs: 10 }), 100)).toEqual({ left: 90, width: 10, label: 'transit 10ms' });
  });
  it('no transit when not derivable, never a 0 width bar', () => {
    expect(transitBar(hop({ offsetMs: 0, durationMs: 100, transitMs: null }), 100)).toBeNull();
    expect(transitBar(hop({ offsetMs: 0, durationMs: 100, transitMs: 0 }), 100)).toEqual({ left: 99.2, width: 0.8, label: 'transit 0ms' });
  });
});

describe('outbound words', () => {
  const row = (over: Partial<TraceOutboundRow>): TraceOutboundRow =>
    ({ from: { id: 'wl:a', kind: 'workload', name: 'a', namespace: 'n' }, to: { id: 'ext:x', kind: 'external', name: 'x', namespace: null }, connections: 2, errors: 0, errorRate: 0, exact: 0, inferred: 2, unlinked: 0, crowded: 0, ...over }) as TraceOutboundRow;

  it('never prints an unknown byte count as 0', () => {
    expect(byteText(null)).toBe('—');
    expect(byteText(0)).toBe('0 B');
    expect(byteText(7752)).toBe('7.6 KiB');
  });

  it('sums the headline without double-counting a destination two workloads call', () => {
    const h = outboundHeadline([row({}), row({ from: { id: 'wl:b', kind: 'workload', name: 'b', namespace: 'n' }, errors: 1, errorRate: 0.5, unlinked: 1, inferred: 1 }), row({ to: { id: 'svc:n/db', kind: 'service', name: 'db', namespace: 'n' }, exact: 2, inferred: 0 })]);
    expect(h).toMatchObject({ workloads: 2, destinations: 2, external: 1, connections: 6, failing: 1, linked: 5, headerless: 4 });
  });

  it('names each kind of link', () => {
    expect(linkSummary({ exact: 0, inferred: 2, unlinked: 1, crowded: 1 })).toBe('2 inferred (1 crowded) · 1 no request');
    expect(linkSummary({ exact: 0, inferred: 0, unlinked: 0, crowded: 0 })).toBe('—');
  });
});
