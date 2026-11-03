/**
 * The path one journey took, edge to BTP, for the Traces Path view.
 *
 * Inside one journey hops are linked exactly (a shared correlator). The approuter does not forward
 * x-request-id, so its call to srv is a second journey; that journey's first hop is an outbound
 * line on the approuter pod, and it is joined to the request the same pod was serving when it
 * started — inferred, innermost wins, `candidates` counts all in flight (outbound.js does the same
 * for TCP egress). Externals come from the journey's own outbound items plus those of joined
 * children: a TCP passthrough's duration is how long the connection stayed open, never a latency,
 * so an external node carries `openForMs` and no `durationMs`.
 *
 * A joined child is drawn without its first hop: that hop is the parent's own pod calling out, and
 * the parent hop already stands for it, so the approuter appears once. The edge from the parent hop
 * into the child is the inference, and says so.
 *
 * Nothing here copies a hop's `from` or a line's downstream address: no client IP enters a path.
 */

import outboundModule from './outbound.js';
const { inFlightAt } = outboundModule;

const MAX_DEPTH = 4;
const msOf = iso => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const key = o => `${o.namespace}/${o.pod}`;

/** Per pod, its inbound sidecar hops as `{start, end, trace, seq}` for `inFlightAt`. */
function inboundIndex(traces) {
  const byPod = new Map();
  for (const t of traces) for (const h of t.hops) {
    if (h.role !== 'sidecar' || !h.to || h.to.direction !== 'inbound' || !h.observedBy) continue;
    const start = msOf(h.startTime);
    if (start === null || h.durationMs === null || h.durationMs === undefined) continue;
    const list = byPod.get(key(h.observedBy)) || [];
    list.push({ start, end: start + h.durationMs, trace: t, seq: h.seq });
    byPod.set(key(h.observedBy), list);
  }
  return byPod;
}

/**
 * Journeys that begin with an outbound sidecar line, joined to the request their pod was serving
 * when they started. Zero in flight is no link; another pod's request is never a candidate.
 */
function linkJourneys(traces) {
  const flights = inboundIndex(traces);
  const links = new Map();
  for (const t of traces) {
    const first = t.hops[0];
    if (!first || first.role !== 'sidecar' || !first.to || first.to.direction !== 'outbound' || !first.observedBy) continue;
    const start = msOf(first.startTime);
    if (start === null) continue;
    const hits = inFlightAt(flights.get(key(first.observedBy)), start).filter(x => x.trace.traceId !== t.traceId);
    if (!hits.length) continue;
    links.set(t.traceId, { parentTraceId: hits[0].trace.traceId, parentSeq: hits[0].seq, candidates: hits.length });
  }
  return links;
}

function hopNode(t, h) {
  return {
    id: `${t.traceId}#${h.seq}`,
    kind: h.role === 'ingress' ? 'gateway' : 'workload',
    label: h.observedBy.pod,
    namespace: h.observedBy.namespace,
    pod: h.observedBy.pod,
    traceId: t.traceId,
    seq: h.seq,
    method: h.method || null,
    path: h.path || null,
    code: h.code,
    codeClass: h.codeClass,
    durationMs: h.durationMs,
    upstreamMs: h.upstreamMs,
    proxyOverheadMs: h.proxyOverheadMs,
    flags: (h.flagDetails || []).map(f => f.flag)
  };
}

function externalNode(id, o, origin) {
  const d = o.to && o.to.destination;
  const ip = o.to && /^(\d{1,3}(?:\.\d{1,3}){3})/.exec(o.to.name || '');
  return {
    id,
    kind: 'external',
    label: d ? d.display : (ip ? ip[1] : o.to.name),
    namespace: null,
    pod: null,
    destination: d || null,
    undeclared: !d,
    ip: ip ? ip[1] : null,
    seen: true,
    openedAtMs: o.offsetMs === null || o.offsetMs === undefined ? null : o.offsetMs + origin,
    openForMs: o.durationMs ?? null,
    bytesSent: o.bytesSent ?? null,
    bytesReceived: o.bytesReceived ?? null,
    protocol: o.protocol || null,
    failed: Boolean(o.failed),
    reason: null
  };
}

/**
 * One journey's nodes and edges, its joined children drawn inside it.
 * @param entry set when this journey is a joined child: `{id, candidates}`, the parent hop that
 *   stands for this journey's first hop, and how many requests the join chose between.
 */
function pathOf(trace, ctx, depth = 0, origin = 0, into = { nodes: [], edges: [] }, entry = null) {
  const { nodes, edges } = into;
  const drawn = ctx.drawn || (ctx.drawn = new Set());
  drawn.add(trace.traceId);
  const hopIds = new Map();
  // The first edge out of the parent hop is the join itself: inferred, never exact.
  const link = (from, to, transitMs) => (entry && from === entry.id
    ? { from, to, link: 'inferred', candidates: entry.candidates, transitMs: null }
    : { from, to, link: 'exact', candidates: 1, transitMs });

  let prev = null;
  if (depth === 0 && trace.hops[0] && trace.hops[0].role === 'ingress') {
    const edgeNode = { id: 'edge', kind: 'edge', label: 'Load balancer', namespace: null, pod: null, reason: null };
    if (ctx.edge) edgeNode.edge = ctx.edge;
    nodes.push(edgeNode);
    prev = 'edge';
  }
  trace.hops.forEach((h, i) => {
    if (i === 0 && entry) {
      hopIds.set(h.seq, entry.id);
      return;
    }
    const n = hopNode(trace, h);
    nodes.push(n);
    hopIds.set(h.seq, n.id);
    const before = i === 0 ? prev : hopIds.get(trace.hops[i - 1].seq);
    if (before) edges.push(link(before, n.id, i === 0 ? null : trace.hops[i - 1].transitMs ?? null));
  });

  // Children: journeys joined to one of this journey's hops by time.
  const traceStart = msOf(trace.hops[0] && trace.hops[0].startTime);
  for (const child of ctx.childrenOf.get(trace.traceId) || []) {
    if (depth + 1 >= MAX_DEPTH) break;
    if (drawn.has(child.traceId)) continue;
    const joined = ctx.links.get(child.traceId);
    const at = hopIds.get(joined.parentSeq);
    if (!at) continue;
    const childStart = msOf(child.hops[0].startTime);
    const childOrigin = origin + (childStart !== null && traceStart !== null ? childStart - traceStart : 0);
    pathOf(child, ctx, depth + 1, childOrigin, into, { id: at, candidates: joined.candidates });
  }

  // Externals opened while this journey ran, attached to the last hop of this journey.
  const lastId = trace.hops.length ? hopIds.get(trace.hops[trace.hops.length - 1].seq) : null;
  (trace.outbound || []).forEach((o, i) => {
    const id = `${trace.traceId}>ext${i}`;
    nodes.push(externalNode(id, o, origin));
    if (lastId) edges.push({ from: lastId, to: id, link: 'inferred', candidates: o.candidates ?? 0, transitMs: null });
  });

  // A callee that no read proxy stands for.
  const last = trace.hops[trace.hops.length - 1];
  if (last && lastId && last.to && last.to.kind !== 'external' && last.to.direction === 'outbound' && !(ctx.childrenOf.get(trace.traceId) || []).length) {
    const ns = last.to.namespace;
    const readInNs = [...ctx.proxiesRead].some(k => k.startsWith(`${ns}/`));
    const id = `${trace.traceId}>nr`;
    nodes.push({ id, kind: 'notRead', label: last.to.name, namespace: ns, pod: null, reason: readInNs ? 'no line in this window' : `no proxy in ${ns} was read` });
    edges.push(link(lastId, id, null));
  }
  return into;
}

/** Declared BTP destinations of the path's namespaces that opened no connection: pooled, no line. */
function addDeclared(path, declared) {
  const seen = new Set(path.nodes.filter(n => n.kind === 'external').map(n => n.label));
  const namespaces = [...new Set(path.nodes.filter(n => n.kind === 'workload').map(n => n.namespace))];
  const anchor = [...path.nodes].reverse().find(n => n.kind === 'workload');
  for (const ns of namespaces) for (const d of declared.get(ns) || []) {
    if (seen.has(d.display)) continue;
    seen.add(d.display);
    const id = `declared:${ns}:${d.display}`;
    path.nodes.push({ id, kind: 'external', label: d.display, namespace: null, pod: null, destination: null, undeclared: false, ip: null, seen: false, openedAtMs: null, openForMs: null, bytesSent: null, bytesReceived: null, protocol: null, failed: false, reason: `declared by NetworkPolicy ${d.namespace}/${d.policyName}; connection reused, no line in this window` });
    if (anchor) path.edges.push({ from: anchor.id, to: id, link: 'inferred', candidates: 0, transitMs: null });
  }
}

/**
 * Paths for every journey in `traces` (the kept ones and the detail samples), keyed by traceId.
 * Children are drawn inside their parent; a child keeps its own path as well.
 */
function buildPaths(traces, { proxiesRead, declared, edge = null }) {
  const byId = new Map(traces.map(t => [t.traceId, t]));
  const links = linkJourneys(traces);
  const childrenOf = new Map();
  for (const [child, l] of links) {
    const c = byId.get(child);
    if (!c) continue;
    const list = childrenOf.get(l.parentTraceId) || [];
    list.push(c);
    childrenOf.set(l.parentTraceId, list);
  }
  const out = new Map();
  for (const t of traces) {
    if (!t.hops.length) {
      out.set(t.traceId, { path: null, pathReason: 'no hop of this journey was in the window' });
      continue;
    }
    const path = pathOf(t, { byId, links, childrenOf, proxiesRead, edge }, 0, 0, { nodes: [], edges: [] });
    addDeclared(path, declared);
    out.set(t.traceId, { path, pathReason: null });
  }
  return out;
}

export default { linkJourneys, pathOf, buildPaths, MAX_DEPTH };
