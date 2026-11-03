import { describe, expect, it } from 'vitest';
import type { ServiceMapEdge, Trace } from '../../api';
import { edgeJourneys, edgesForTrace, failingNodes, matchesServiceMapOutcome } from './service-map-drill';

const edge = (over: Partial<ServiceMapEdge>): ServiceMapEdge => ({ from: 'a', to: 'b', calls: 10, errors: 0, errorRate: 0, p50Ms: 1, p95Ms: 2, samples: 10, codes: [], protocol: 'http', observedBy: 'both', lastSeen: null, traceIds: [], traceIdsFound: 0, ...over });

describe('service map drill', () => {
  it('lists the journeys the table holds and counts the rest', () => {
    const traces = [{ traceId: 't1' }, { traceId: 't2' }] as Trace[];
    const r = edgeJourneys(edge({ traceIds: ['t2', 't9'], traceIdsFound: 5 }), traces);
    expect(r.openable.map(t => t.traceId)).toEqual(['t2']);
    expect(r.elsewhere).toBe(4);
  });
  it('a node is failing when any of its arrows fails at 5% or more', () => {
    const s = failingNodes({ nodes: [], edges: [edge({ from: 'a', to: 'b', errorRate: 0.2, errors: 2 }), edge({ from: 'c', to: 'd', errorRate: 0.01, errors: 1 })] } as never);
    expect([...s].sort()).toEqual(['a', 'b']);
  });
  it('an edge without traceIds (an older server) offers nothing, never a 0 count', () => {
    const r = edgeJourneys(edge({ traceIds: undefined, traceIdsFound: undefined }), []);
    expect(r).toEqual({ openable: [], elsewhere: null });
  });
  it('finds only service calls carrying the selected request correlation id', () => {
    const edges = [edge({ from: 'gateway', to: 'srv', traceIds: ['t1'] }), edge({ from: 'srv', to: 'db', traceIds: ['t1', 't2'] }), edge({ from: 'srv', to: 'idp', traceIds: undefined })];
    expect(edgesForTrace('t1', edges)).toEqual(['gateway→srv', 'srv→db']);
    expect(edgesForTrace('missing', edges)).toEqual([]);
    expect(edgesForTrace(null, edges)).toEqual([]);
  });
  it('keeps only wholly healthy arrows in the healthy view', () => {
    expect(matchesServiceMapOutcome(edge({ errors: 0 }), 'healthy')).toBe(true);
    expect(matchesServiceMapOutcome(edge({ errors: 1, errorRate: 0.01 }), 'healthy')).toBe(false);
    expect(matchesServiceMapOutcome(edge({ errors: 1, errorRate: 0.05 }), 'failing')).toBe(true);
    expect(matchesServiceMapOutcome(edge({ errors: 1, errorRate: 0.01 }), 'failing')).toBe(false);
  });
});
