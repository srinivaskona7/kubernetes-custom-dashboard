/**
 * The model behind **Distributed Traces → Service map** and **Endpoints**: where each node sits,
 * how each edge is drawn, and the words a rate or a percentile is printed with.
 *
 * Columns, not a force layout, for the reason `pages/helm/flow-layout.ts` gives: the same payload
 * must draw the same picture twice. A node's column is its shortest distance from a caller nobody
 * calls (External clients, then the ingress gateway), so a request reads left to right; every
 * destination outside the cluster is pushed to the last column, because "where does this leave the
 * cluster" is the question those nodes answer. An edge that runs backwards or within a column is
 * drawn as a loop under the nodes rather than through them.
 *
 * Pure `.ts`: the fleet-ui vitest suite runs in the node environment with no DOM.
 */

import type { ServiceMapEdge, ServiceMapNode, Trace, TraceEndpointStat } from '../../api';
import { ms } from './traces-view';

export const NODE_W = 208;
export const NODE_H = 52;
export const GAP_X = 184;
const GAP_Y = 22;
/** Room under the lowest node for loops drawn beneath it. */
const LOOP_ROOM = 36;
/** How far a forward edge's label is lifted off its line: half the 18px label box plus 2px. */
const LABEL_LIFT = 11;
/** How far a same-column arc bulges into the gap to its right. */
const SIDE_ARC = 96;
/** A same-column arc's label starts this far right of the column, clear of the nodes it passes. */
const SIDE_LABEL_INSET = 10;
/** A label box's height, and the step a colliding label moves by: one box and 2px. */
const LABEL_H = 18;
const LABEL_STEP = LABEL_H + 2;
/** A forward label is cut to its gap less this, so it clears the nodes either side. */
const GAP_PAD = 12;

const SINKS = new Set<ServiceMapNode['kind']>(['external', 'nodes', 'unresolved']);

export interface PlacedNode {
  node: ServiceMapNode;
  col: number;
  x: number;
  y: number;
}

export interface DrawnEdge {
  edge: ServiceMapEdge;
  id: string;
  d: string;
  labelX: number;
  labelY: number;
  /** Not a left-to-right curve: the callee is not to the right of its caller. */
  loop: boolean;
  /** A same-column arc to the right of the column, rather than a loop beneath every node. */
  side?: boolean;
  /**
   * How wide the label may grow before it reaches the next column: a forward label's gap, or a
   * side arc's (anchored at its left edge, `labelX`). Unset for a side arc in the last column,
   * where the extent grows to hold the label.
   */
  labelRoom?: number;
}

/** A label's drawn box, in the map's coordinates. */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An edge with its label placed: the text it prints and the box it prints in. */
export interface LabelledEdge extends DrawnEdge {
  label: string;
  labelBox: LabelBox;
}

/** Everything drawn, nodes and labels: the viewBox. `x`/`y` go negative when a label lifts above the first row. */
export interface Extent {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const edgeId =(e: Pick<ServiceMapEdge, 'from' | 'to'>): string => `${e.from}→${e.to}`;

function columns(nodes: readonly ServiceMapNode[], edges: readonly ServiceMapEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  const next = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) {
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  const bfs = (roots: string[]) => {
    const queue = roots.filter(r => !out.has(r));
    for (const r of queue) out.set(r, 0);
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      for (const to of next.get(at) ?? []) {
        if (out.has(to)) continue;
        out.set(to, out.get(at)! + 1);
        queue.push(to);
      }
    }
  };
  // Clients first, so a gateway they call lands one column in rather than tying with them.
  const byId = (a: ServiceMapNode, b: ServiceMapNode) => a.id.localeCompare(b.id);
  const roots = [...nodes].filter(n => (incoming.get(n.id) ?? 0) === 0).sort((a, b) => Number(b.kind === 'clients') - Number(a.kind === 'clients') || byId(a, b));
  bfs(roots.map(n => n.id));
  // A cycle with no caller outside it has no root; start it from its first node, deterministically.
  for (const n of [...nodes].sort(byId)) if (!out.has(n.id)) bfs([n.id]);

  const inner = nodes.filter(n => !SINKS.has(n.kind)).map(n => out.get(n.id)!);
  const last = inner.length ? Math.max(...inner) + 1 : 0;
  for (const n of nodes) if (SINKS.has(n.kind)) out.set(n.id, last);
  return out;
}

export function layoutServiceMap(
  nodes: readonly ServiceMapNode[],
  edges: readonly ServiceMapEdge[],
  fmt: (n: number) => string = ms
): { placed: PlacedNode[]; drawn: LabelledEdge[]; width: number; height: number; extent: Extent } {
  const col = columns(nodes, edges);
  const traffic = new Map<string, number>();
  for (const e of edges) {
    traffic.set(e.from, (traffic.get(e.from) ?? 0) + e.calls);
    traffic.set(e.to, (traffic.get(e.to) ?? 0) + e.calls);
  }
  const byCol = new Map<number, ServiceMapNode[]>();
  for (const n of nodes) byCol.set(col.get(n.id)!, [...(byCol.get(col.get(n.id)!) ?? []), n]);

  const placed: PlacedNode[] = [];
  let rows = 0;
  for (const [c, list] of [...byCol].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (traffic.get(b.id) ?? 0) - (traffic.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    rows = Math.max(rows, list.length);
    list.forEach((node, i) => placed.push({ node, col: c, x: c * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) }));
  }
  const at = new Map(placed.map(p => [p.node.id, p]));
  const cols = byCol.size ? Math.max(...byCol.keys()) + 1 : 0;
  const bottom = rows * (NODE_H + GAP_Y) - GAP_Y;

  const drawn: DrawnEdge[] = [];
  for (const edge of edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (!a || !b) continue;
    if (b.col > a.col) {
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      // The label sits just above the curve's midpoint, so the line stays visible beneath it.
      drawn.push({ edge, id: edgeId(edge), d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`, labelX: mid, labelY: (y1 + y2) / 2 - LABEL_LIFT, loop: false });
    } else if (b.col === a.col) {
      // Same column: an arc out to the right of the column, so it never crosses the nodes between.
      const x = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const y2 = b.y + NODE_H / 2;
      const bulge = x + SIDE_ARC;
      // The label starts just right of the column, never centred on it, so no node covers its start.
      drawn.push({
        edge,
        id: edgeId(edge),
        d: `M ${x} ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, ${x + 2} ${y2}`,
        labelX: x + SIDE_LABEL_INSET,
        labelY: (y1 + y2) / 2,
        loop: true,
        side: true,
        ...(a.col < cols - 1 ? { labelRoom: GAP_X - SIDE_LABEL_INSET - 6 } : {})
      });
    } else {
      const x1 = a.x + NODE_W / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y + NODE_H;
      const dip = bottom + LOOP_ROOM - 8;
      drawn.push({ edge, id: edgeId(edge), d: `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`, labelX: (x1 + x2) / 2, labelY: dip - 6, loop: true });
    }
  }
  const loops = drawn.some(e => e.loop && !e.side);
  const labelled = placeLabels(drawn, placed, at, fmt);
  // The extent is every node and every label: nothing is drawn outside it, so a viewBox of it never clips.
  const boxes = labelled.map(d => d.labelBox);
  const x = Math.min(0, ...boxes.map(b => b.x));
  const y = Math.min(0, ...boxes.map(b => b.y));
  const right = Math.max(cols * (NODE_W + GAP_X) - GAP_X, 0, ...boxes.map(b => b.x + b.w));
  const low = Math.max(bottom + (loops ? LOOP_ROOM : 0), 0, ...boxes.map(b => b.y + b.h));
  return { placed, drawn: labelled, width: right, height: low, extent: { x, y, width: right - x, height: low - y } };
}

/** Where a cubic's x reaches `x`: the curves here run monotonically left to right, so bisect `t`. */
function curveYAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const mid = (x1 + x2) / 2;
  const at = (t: number, a: number, b: number, c: number, d: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const t = (lo + hi) / 2;
    if (at(t, x1, mid, mid, x2) < x) lo = t;
    else hi = t;
  }
  return at((lo + hi) / 2, y1, y1, y2, y2);
}

const overlaps = (a: LabelBox, b: LabelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Every label gets a box clear of every node and every other label. The busiest arrow chooses
 * first. A forward label sits in one of the gaps its curve crosses, never on a column it passes,
 * and is cut to fit that gap. A label that collides steps up or down in whole label heights;
 * a loop's label only steps down, since everything above it is nodes.
 */
function placeLabels(drawn: DrawnEdge[], placed: PlacedNode[], at: Map<string, PlacedNode>, fmt: (n: number) => string): LabelledEdge[] {
  const nodes = placed.map(p => ({ x: p.x - 2, y: p.y - 2, w: NODE_W + 4, h: NODE_H + 4 }));
  const taken: LabelBox[] = [];
  const out = new Map<DrawnEdge, LabelledEdge>();
  const order = [...drawn].sort((a, b) => b.edge.calls - a.edge.calls || a.id.localeCompare(b.id));
  const steps = 2 * (drawn.length + placed.length) + 4;
  const free = (b: LabelBox) => !nodes.some(n => overlaps(b, n)) && !taken.some(t => overlaps(b, t));
  for (const d of order) {
    const a = at.get(d.edge.from)!;
    const b = at.get(d.edge.to)!;
    // Anchors: [left of the box when `left`, else its centre; the box's vertical centre; room].
    let anchors: { x: number; y: number; left: boolean; room?: number }[];
    let dys: number[];
    if (!d.loop) {
      const x1 = a.x + NODE_W;
      const x2 = b.x;
      const y1 = a.y + NODE_H / 2;
      const y2 = b.y + NODE_H / 2;
      const gaps = Array.from({ length: b.col - a.col }, (_, i) => (a.col + i) * (NODE_W + GAP_X) + NODE_W + GAP_X / 2);
      const centre = (x1 + x2) / 2;
      gaps.sort((p, q) => Math.abs(p - centre) - Math.abs(q - centre) || p - q);
      anchors = gaps.map(g => ({ x: g, y: curveYAt(x1, y1, x2, y2, g) - LABEL_LIFT, left: false, room: GAP_X - GAP_PAD }));
      dys = Array.from({ length: steps }, (_, i) => (i % 2 ? 1 : -1) * Math.ceil(i / 2) * LABEL_STEP);
    } else if (d.side) {
      anchors = [{ x: d.labelX, y: d.labelY, left: true, room: d.labelRoom }];
      dys = Array.from({ length: steps }, (_, i) => (i % 2 ? 1 : -1) * Math.ceil(i / 2) * LABEL_STEP);
    } else {
      anchors = [{ x: d.labelX, y: d.labelY, left: false }];
      dys = Array.from({ length: steps }, (_, i) => i * LABEL_STEP);
    }
    let chosen: LabelledEdge | null = null;
    for (const dy of dys) {
      for (const an of anchors) {
        const label = edgeLabel(d.edge, fmt, an.room);
        const w = labelWidth(label);
        const box = { x: an.left ? an.x : an.x - w / 2, y: an.y + dy - LABEL_H / 2, w, h: LABEL_H };
        if (!free(box)) continue;
        chosen = { ...d, label, labelBox: box, labelX: an.left ? box.x : box.x + w / 2, labelY: an.y + dy, ...(an.room !== undefined ? { labelRoom: an.room } : {}) };
        break;
      }
      if (chosen) break;
    }
    // Unreachable in practice: the last steps clear every node row. Keep the first anchor rather than drop a label.
    if (!chosen) {
      const an = anchors[0]!;
      const label = edgeLabel(d.edge, fmt, an.room);
      const w = labelWidth(label);
      chosen = { ...d, label, labelBox: { x: an.left ? an.x : an.x - w / 2, y: an.y - LABEL_H / 2, w, h: LABEL_H } };
    }
    taken.push(chosen.labelBox);
    out.set(d, chosen);
  }
  return drawn.map(d => out.get(d)!);
}

/**
 * The status line under a picked arrow. The server counts codes per call (per access-log line),
 * HTTP lines only, and sends the four commonest; the rest of the calls are named, not dropped.
 * Null when no call carried a status, as a TCP connection never does.
 */
export function codeBreakdown(e: Pick<ServiceMapEdge, 'calls' | 'codes'>): string | null {
  if (!e.codes.length) return null;
  const listed = e.codes.reduce((n, c) => n + c.count, 0);
  const rest = e.calls - listed;
  const parts = e.codes.map(c => `${c.code === 0 ? 'no response' : c.code} ×${c.count.toLocaleString('en-US')}`);
  if (rest > 0) parts.push(`${rest.toLocaleString('en-US')} other or no status`);
  return `Calls by status: ${parts.join(' · ')}`;
}

export type EdgeTone = 'bad' | 'warn' | 'neutral';

/** Red at 5% failing or more, amber below it, neutral when nothing failed. */
export function edgeTone(e: Pick<ServiceMapEdge, 'errors' | 'errorRate'>): EdgeTone {
  if (!e.errors || e.errorRate === null) return 'neutral';
  return e.errorRate >= 0.05 ? 'bad' : 'warn';
}

/** Stroke width from call volume on a log scale, so one busy edge does not flatten the rest to hairlines. */
export function edgeWidth(calls: number, maxCalls: number): number {
  if (calls <= 0 || maxCalls <= 1) return 1.25;
  return 1.25 + 2.75 * (Math.log10(calls) / Math.log10(maxCalls));
}

export function nodeKindLabel(n: ServiceMapNode): string {
  switch (n.kind) {
    case 'gateway':
      return 'Ingress gateway';
    case 'clients':
      return 'Outside the cluster';
    case 'external':
      return 'External destination';
    case 'nodes':
      return 'Node network';
    case 'unresolved':
      return 'Unresolved address';
    case 'mesh':
      return 'Inside the mesh';
    default:
      return n.workloadKind ?? 'Workload';
  }
}

/** A name that fits a node: the middle is cut, because both a prefix and a hash suffix identify. */
export function fitName(name: string, max = 26): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) * 0.6);
  return `${name.slice(0, head)}…${name.slice(name.length - (max - 1 - head))}`;
}

/** A failure share as a column reads it. A non-zero rate never rounds to "0%". */
export function pct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  if (rate === 0) return '0%';
  if (rate < 0.01) return '<1%';
  return `${Math.round(rate * 100)}%`;
}

/** A 95th percentile needs a distribution; below `MIN_P95_SAMPLES` on the server it is null. */
export function p95Text(p95Ms: number | null, samples: number, fmt: (n: number) => string): string {
  if (p95Ms !== null) return fmt(p95Ms);
  return samples > 0 ? `n=${samples}` : '—';
}

/**
 * The latency an arrow prints: p95 when there are enough samples for one, p50 otherwise, nothing
 * when no call carried a duration. `fmt` is the tab's own `ms()`.
 */
export function latencyTag(e: Pick<ServiceMapEdge, 'p50Ms' | 'p95Ms'>, fmt: (n: number) => string): string {
  if (e.p95Ms !== null) return ` · p95 ${fmt(e.p95Ms)}`;
  if (e.p50Ms !== null) return ` · p50 ${fmt(e.p50Ms)}`;
  return '';
}

/** The label's drawn width at 11px monospace, padding included. */
export const labelWidth = (label: string): number => label.length * 6.4 + 12;

/**
 * An arrow's label: calls, latency, failure share. When it would outgrow `room` the latency goes
 * first (it is in the tooltip); calls and the failure share never do.
 */
export function edgeLabel(e: ServiceMapEdge, fmt: (n: number) => string, room?: number): string {
  const tail = e.errors ? ` · ${pct(e.errorRate)} err` : '';
  const full = `${e.calls.toLocaleString('en-US')}${latencyTag(e, fmt)}${tail}`;
  return room !== undefined && labelWidth(full) > room ? `${e.calls.toLocaleString('en-US')}${tail}` : full;
}

export interface EndpointDrill {
  /** The newest journey, when the Journeys table holds it. */
  selectId: string | null;
  /** The newest journey, when it is older than the table's 200: fetched from the detail route. */
  fetchId: string | null;
  /** The fallback when neither opens: the path up to its first folded identifier. */
  search: string;
}

/** Where a click on an endpoint goes. */
export function endpointDrill(ep: TraceEndpointStat, traces: readonly Trace[]): EndpointDrill {
  const kept = ep.sampleTraceId ? traces.find(t => t.traceId === ep.sampleTraceId) : undefined;
  const prefix = (ep.path ?? '').split('{id}')[0] ?? '';
  return {
    selectId: kept ? kept.traceId : null,
    fetchId: kept ? null : ep.sampleTraceId,
    search: prefix || (ep.host ?? '')
  };
}

/** Edges touching one node, or every edge when none is focused. */
export function edgesOf(edges: readonly ServiceMapEdge[], focus: string | null): ServiceMapEdge[] {
  return focus ? edges.filter(e => e.from === focus || e.to === focus) : [...edges];
}

/** A failure share as a tone: the same 5% line the map's arrows use. */
export function rateTone(rate: number | null | undefined): 'bad' | 'warn' | 'neutral' {
  if (!rate) return 'neutral';
  return rate >= 0.05 ? 'bad' : 'warn';
}

/** Error-rate text tone for a table cell, on the same 5% line. */
export const TONE_TEXT = { bad: 'text-bad', warn: 'text-warn', neutral: '' } as const;

/** Failing means 5% or more of the calls or journeys failed: the line `rateTone` draws red. */
export const isFailing = (x: { errorRate: number | null }): boolean => (x.errorRate ?? 0) >= 0.05;

export interface EndpointHeadline {
  endpoints: number;
  failing: number;
  worst: TraceEndpointStat | null;
  slowest: { ep: TraceEndpointStat; ms: number; which: 'p95' | 'p50' } | null;
  busiest: TraceEndpointStat | null;
}

/**
 * The four numbers an operator opens Endpoints for. The slowest ranks by p95 where there is one,
 * and falls back to p50 only when no endpoint has enough samples for a p95, so a single slow
 * request never outranks a measured tail.
 */
export function endpointHeadline(rows: readonly TraceEndpointStat[], found: number): EndpointHeadline {
  const failingRows = rows.filter(isFailing);
  const worst = [...failingRows].sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0) || b.journeys - a.journeys)[0] ?? null;
  const withP95 = rows.filter(r => r.p95Ms !== null);
  const pool = withP95.length ? withP95.map(ep => ({ ep, ms: ep.p95Ms!, which: 'p95' as const })) : rows.filter(r => r.p50Ms !== null).map(ep => ({ ep, ms: ep.p50Ms!, which: 'p50' as const }));
  const slowest = pool.sort((a, b) => b.ms - a.ms)[0] ?? null;
  const busiest = [...rows].sort((a, b) => b.journeys - a.journeys)[0] ?? null;
  return { endpoints: found, failing: failingRows.length, worst, slowest, busiest };
}

export interface MapHeadline {
  workloads: number;
  calls: number;
  failingEdges: number;
  failedCalls: number;
  slowest: { edge: ServiceMapEdge; ms: number; which: 'p95' | 'p50' } | null;
  destinations: number;
}

/** The map's headline: who is in it, how much moved, what failed, what was slow, what left. */
export function mapHeadline(nodes: readonly ServiceMapNode[], edges: readonly ServiceMapEdge[]): MapHeadline {
  const withP95 = edges.filter(e => e.p95Ms !== null);
  const pool = withP95.length ? withP95.map(edge => ({ edge, ms: edge.p95Ms!, which: 'p95' as const })) : edges.filter(e => e.p50Ms !== null).map(edge => ({ edge, ms: edge.p50Ms!, which: 'p50' as const }));
  return {
    workloads: nodes.filter(n => n.kind === 'workload' || n.kind === 'gateway').length,
    calls: edges.reduce((n, e) => n + e.calls, 0),
    failingEdges: edges.filter(isFailing).length,
    failedCalls: edges.reduce((n, e) => n + e.errors, 0),
    slowest: pool.sort((a, b) => b.ms - a.ms)[0] ?? null,
    destinations: nodes.filter(n => n.kind === 'external').length
  };
}
