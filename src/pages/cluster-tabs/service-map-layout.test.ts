/**
 * Traces → Service map and Endpoints: node columns, edge geometry, and the words rates print with.
 */
import { describe, expect, it } from 'vitest';
import type { ServiceMapEdge, ServiceMapNode, Trace, TraceEndpointStat } from '../../api';
import { codeBreakdown, edgeLabel, labelWidth, endpointHeadline, isFailing, mapHeadline, rateTone, edgeTone, edgeWidth, edgesOf, endpointDrill, fitName, GAP_X, latencyTag, layoutServiceMap, NODE_W, p95Text, pct } from './service-map-layout';

const node = (id: string, kind: ServiceMapNode['kind'] = 'workload'): ServiceMapNode => ({ id, kind, workloadKind: 'Deployment', name: id, namespace: 'shop' });
const edge = (from: string, to: string, over: Partial<ServiceMapEdge> = {}): ServiceMapEdge => ({
  from,
  to,
  calls: 10,
  errors: 0,
  errorRate: 0,
  p50Ms: 1,
  p95Ms: null,
  samples: 10,
  codes: [],
  protocol: 'http',
  observedBy: 'both',
  lastSeen: null,
  ...over
});

describe('service map layout', () => {
  const nodes = [node('clients', 'clients'), node('gw', 'gateway'), node('approuter'), node('srv'), node('ext:hana:443', 'external')];
  const edges = [edge('clients', 'gw'), edge('gw', 'approuter'), edge('approuter', 'srv'), edge('srv', 'ext:hana:443'), edge('clients', 'srv', { calls: 3 })];
  const { placed, drawn, width } = layoutServiceMap(nodes, edges);
  const colOf = (id: string) => placed.find(p => p.node.id === id)!.col;

  it('reads left to right from the callers nobody calls', () => {
    expect(['clients', 'gw', 'approuter'].map(colOf)).toEqual([0, 1, 2]);
    expect(colOf('srv')).toBe(1); // shortest distance: clients call srv directly too
  });

  it('pushes every destination outside the cluster to the last column', () => {
    expect(colOf('ext:hana:443')).toBe(3);
    expect(width).toBe(4 * NODE_W + 3 * GAP_X);
  });

  it('draws a backwards edge as a loop, a forward one as a curve', () => {
    const back = drawn.find(d => d.id === 'approuter→srv')!;
    expect(back.loop).toBe(true);
    expect(drawn.find(d => d.id === 'gw→approuter')!.loop).toBe(false);
  });

  it('places a cycle with no outside caller, deterministically', () => {
    const a = layoutServiceMap([node('b'), node('a')], [edge('a', 'b'), edge('b', 'a')]);
    const b = layoutServiceMap([node('a'), node('b')], [edge('b', 'a'), edge('a', 'b')]);
    expect(a.placed.map(p => `${p.node.id}@${p.col}`).sort()).toEqual(b.placed.map(p => `${p.node.id}@${p.col}`).sort());
    expect(a.placed).toHaveLength(2);
  });

  it('draws a same-column call as an arc beside the column, not through the node below', () => {
    // gw calls a and b; a calls b: a and b share column 1.
    const l = layoutServiceMap([node('gw', 'gateway'), node('a'), node('b')], [edge('gw', 'a', { calls: 5 }), edge('gw', 'b'), edge('a', 'b')]);
    const ab = l.drawn.find(d => d.id === 'a→b')!;
    const col1 = l.placed.find(p => p.node.id === 'a')!;
    expect(ab.side).toBe(true);
    expect(ab.labelX).toBeGreaterThan(col1.x + NODE_W);
    expect(l.height).toBe(2 * 52 + 22); // no room reserved beneath: nothing loops under
  });

  it('keeps a long same-column label inside the canvas and clear of the column, even in the last column', () => {
    // No sink column: a and c are the deepest column, and a busier b sits between them.
    const l = layoutServiceMap(
      [node('gw', 'gateway'), node('a'), node('b'), node('c')],
      [edge('gw', 'b', { calls: 900 }), edge('gw', 'a', { calls: 500 }), edge('gw', 'c'), edge('a', 'c', { calls: 1234, errors: 148, errorRate: 0.12, p95Ms: 850, samples: 40 })]
    );
    const ac = l.drawn.find(d => d.id === 'a→c')!;
    const col = l.placed.find(p => p.node.id === 'a')!;
    const label = edgeLabel(ac.edge, n => `${n}ms`, ac.labelRoom);
    expect(label).toBe('1,234 · p95 850ms · 12% err');
    expect(ac.labelX).toBeGreaterThan(col.x + NODE_W);
    expect(ac.labelX + labelWidth(label)).toBeLessThanOrEqual(l.width);
  });

  it('drops the latency, never the failure share, when a mid-map side label would reach the next column', () => {
    const e = edge('a', 'b', { calls: 1234, errors: 148, errorRate: 0.12, p95Ms: 850, samples: 40 });
    expect(edgeLabel(e, n => `${n}ms`, 120)).toBe('1,234 · 12% err');
    expect(edgeLabel(e, n => `${n}ms`)).toBe('1,234 · p95 850ms · 12% err');
  });

  it('skips an edge whose end is not a node rather than drawing to nowhere', () => {
    expect(layoutServiceMap([node('a')], [edge('a', 'ghost')]).drawn).toHaveLength(0);
  });
});

describe('edge and number words', () => {
  it('tones by failure share', () => {
    expect(edgeTone({ errors: 0, errorRate: 0 })).toBe('neutral');
    expect(edgeTone({ errors: 1, errorRate: 0.01 })).toBe('warn');
    expect(edgeTone({ errors: 5, errorRate: 0.05 })).toBe('bad');
  });

  it('scales width on a log scale within bounds', () => {
    expect(edgeWidth(1, 1000)).toBe(1.25);
    expect(edgeWidth(1000, 1000)).toBeCloseTo(4);
    expect(edgeWidth(5, 1)).toBe(1.25);
  });

  it('never rounds a non-zero failure share to 0%', () => {
    expect(pct(0.004)).toBe('<1%');
    expect(pct(0)).toBe('0%');
    expect(pct(null)).toBe('—');
    expect(pct(1)).toBe('100%');
  });

  it('says how few samples there were instead of printing a p95', () => {
    expect(p95Text(null, 3, n => `${n}ms`)).toBe('n=3');
    expect(p95Text(12, 40, n => `${n}ms`)).toBe('12ms');
    expect(p95Text(null, 0, n => `${n}ms`)).toBe('—');
  });

  it('puts latency on the arrow: p95 when there is one, p50 when there is not, nothing without durations', () => {
    const f = (n: number) => `${n}ms`;
    expect(latencyTag({ p50Ms: 3, p95Ms: 12 }, f)).toBe(' · p95 12ms');
    expect(latencyTag({ p50Ms: 3, p95Ms: null }, f)).toBe(' · p50 3ms');
    expect(latencyTag({ p50Ms: null, p95Ms: null }, f)).toBe('');
  });

  it('cuts a long name in the middle', () => {
    expect(fitName('applecare-responder-approuter', 20)).toMatch(/^applecare-r.*ter$/);
    expect(fitName('applecare-responder-approuter', 20)).toHaveLength(20);
    expect(fitName('srv')).toBe('srv');
  });

  it('focuses the edges of one node', () => {
    const es = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    expect(edgesOf(es, 'b').map(e => e.to)).toEqual(['b', 'c']);
    expect(edgesOf(es, null)).toHaveLength(3);
  });
});

describe('endpoint drill-down', () => {
  const ep = { path: '/orders/{id}/items', host: 'shop', sampleTraceId: 't9' } as TraceEndpointStat;
  it('opens the sample journey when the table holds it', () => {
    expect(endpointDrill(ep, [{ traceId: 't9' } as Trace])).toEqual({ selectId: 't9', fetchId: null, search: '/orders/' });
  });
  it('fetches the sample when the cap dropped it, with a path-prefix search as the fallback', () => {
    expect(endpointDrill(ep, [])).toEqual({ selectId: null, fetchId: 't9', search: '/orders/' });
    expect(endpointDrill({ ...ep, path: '{id}' }, []).search).toBe('shop');
  });
});

describe('headline tiles', () => {
  const ep = (path: string, over: Partial<TraceEndpointStat> = {}): TraceEndpointStat =>
    ({ method: 'GET', host: 'h', path, service: null, journeys: 10, errors: 0, errorRate: 0, p50Ms: 5, p95Ms: null, samples: 10, codes: [], lastSeen: null, sampleTraceId: null, ...over }) as TraceEndpointStat;

  it('uses the same 5% line for tone and for "failing"', () => {
    expect(rateTone(0)).toBe('neutral');
    expect(rateTone(0.049)).toBe('warn');
    expect(rateTone(0.05)).toBe('bad');
    expect(isFailing({ errorRate: 0.049 })).toBe(false);
    expect(isFailing({ errorRate: null })).toBe(false);
  });

  it('ranks the slowest endpoint by p95 when any has one, so one slow request never outranks a tail', () => {
    const rows = [ep('/one', { p50Ms: 9000, samples: 1 }), ep('/measured', { p95Ms: 40, samples: 30 })];
    expect(endpointHeadline(rows, 2).slowest).toMatchObject({ ms: 40, which: 'p95' });
    expect(endpointHeadline([ep('/a', { p50Ms: 3 }), ep('/b', { p50Ms: 7 })], 2).slowest).toMatchObject({ ms: 7, which: 'p50' });
  });

  it('names the worst failing and the busiest endpoint', () => {
    const h = endpointHeadline([ep('/busy', { journeys: 300 }), ep('/half', { errors: 5, errorRate: 0.5 }), ep('/all', { errors: 3, journeys: 3, errorRate: 1 })], 3);
    expect(h.failing).toBe(2);
    expect(h.worst!.path).toBe('/all');
    expect(h.busiest!.path).toBe('/busy');
    expect(endpointHeadline([], 0)).toMatchObject({ endpoints: 0, failing: 0, worst: null, slowest: null, busiest: null });
  });

  it('sums the map without counting a caller outside the cluster as a workload', () => {
    const nodes = [node('clients', 'clients'), node('gw', 'gateway'), node('a'), node('ext:x', 'external')];
    const h = mapHeadline(nodes, [edge('gw', 'a', { calls: 100, errors: 97, errorRate: 0.97, p95Ms: 8 }), edge('a', 'ext:x', { calls: 2, p50Ms: 5000 })]);
    expect(h).toMatchObject({ workloads: 2, calls: 102, failingEdges: 1, failedCalls: 97, destinations: 1 });
    expect(h.slowest).toMatchObject({ ms: 8, which: 'p95' });
  });
});

describe('edge label placement', () => {
  type Box = { x: number; y: number; w: number; h: number };
  const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  /** Every label clear of every node box and every other label, and inside the extent. */
  const clean = (l: ReturnType<typeof layoutServiceMap>) => {
    const nodeBoxes = l.placed.map(p => ({ x: p.x, y: p.y, w: NODE_W, h: 52 }));
    const faults: string[] = [];
    l.drawn.forEach((d, i) => {
      const b = d.labelBox;
      nodeBoxes.forEach((n, j) => hit(b, n) && faults.push(`${d.id} covers ${l.placed[j]!.node.id}`));
      l.drawn.slice(i + 1).forEach(o => hit(b, o.labelBox) && faults.push(`${d.id} overlaps ${o.id}`));
      const e = l.extent;
      if (b.x < e.x || b.y < e.y || b.x + b.w > e.x + e.width || b.y + b.h > e.y + e.height) faults.push(`${d.id} outside the extent`);
    });
    return faults;
  };

  it('never centres a long forward label on the node in the column it passes', () => {
    // clients -> ext spans column 1, where gw sits in the same row.
    const l = layoutServiceMap([node('clients', 'clients'), node('gw', 'gateway'), node('ext:x', 'external')], [edge('clients', 'gw'), edge('gw', 'ext:x'), edge('clients', 'ext:x')]);
    expect(clean(l)).toEqual([]);
  });

  it('stacks two same-column arcs with one midpoint instead of drawing one label on the other', () => {
    const l = layoutServiceMap([node('gw', 'gateway'), node('a'), node('b'), node('c')], [edge('gw', 'a', { calls: 30 }), edge('gw', 'b', { calls: 20 }), edge('gw', 'c'), edge('a', 'c'), edge('c', 'a')]);
    expect(clean(l)).toEqual([]);
  });

  it('keeps a last-column label wider than the old 200px allowance inside the extent', () => {
    const wide = edge('a', 'c', { calls: 12345678, errors: 1234567, errorRate: 0.1, p95Ms: 123456, samples: 40 });
    const l = layoutServiceMap([node('gw', 'gateway'), node('a'), node('b'), node('c')], [edge('gw', 'b', { calls: 900 }), edge('gw', 'a', { calls: 500 }), edge('gw', 'c'), wide]);
    expect(labelWidth(l.drawn.find(d => d.id === 'a→c')!.label)).toBeGreaterThan(200);
    expect(clean(l)).toEqual([]);
  });

  it('separates loops beneath the nodes that share a dip', () => {
    const l = layoutServiceMap([node('gw', 'gateway'), node('a'), node('b')], [edge('gw', 'a'), edge('a', 'b'), edge('b', 'gw'), edge('b', 'a'), edge('a', 'gw')]);
    expect(clean(l)).toEqual([]);
  });

  it('holds on the five-party fixture above', () => {
    const nodes = [node('clients', 'clients'), node('gw', 'gateway'), node('approuter'), node('srv'), node('ext:hana:443', 'external')];
    const edges = [edge('clients', 'gw'), edge('gw', 'approuter'), edge('approuter', 'srv'), edge('srv', 'ext:hana:443'), edge('clients', 'srv', { calls: 3 })];
    expect(clean(layoutServiceMap(nodes, edges))).toEqual([]);
  });
});

describe('status breakdown', () => {
  it('counts calls, and names the calls the listed codes leave out', () => {
    const e = edge('a', 'b', { calls: 50, codes: [{ code: 200, count: 40 }, { code: 503, count: 3 }] });
    expect(codeBreakdown(e)).toBe('Calls by status: 200 ×40 · 503 ×3 · 7 other or no status');
  });
  it('says nothing is missing when the codes cover every call, and prints code 0 as no response', () => {
    expect(codeBreakdown(edge('a', 'b', { calls: 4, codes: [{ code: 200, count: 3 }, { code: 0, count: 1 }] }))).toBe('Calls by status: 200 ×3 · no response ×1');
  });
  it('is null for a TCP edge, which has no status to break down', () => {
    expect(codeBreakdown(edge('a', 'b', { protocol: 'tcp', codes: [] }))).toBeNull();
  });
});
