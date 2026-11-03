/**
 * Traces → **Outbound**: every call a workload's own sidecar logged on its way out, grouped by
 * workload and destination, and — where the line itself cannot say — which request was running
 * when the connection opened.
 *
 * ## Two kinds of link, never mixed
 *
 * An outbound line that carries a correlator (traceparent, b3, x-request-id) is already a hop of a
 * journey: its link is **exact**. A TLS passthrough to a database or an external API is a TCP line
 * with no header at all (measured: srv → 3.214.110.153:443 on platformsbx, `PassthroughCluster`,
 * status 0, no request id), so nothing in the line names the request that caused it. Its link is
 * **inferred** from time: the inbound requests the same pod was serving when the connection
 * opened. That is a guess, and the wire says so — `candidates` is how many requests were in flight,
 * and a link with more than one candidate names the one that started last, the innermost.
 *
 * Two limits the operator has to be told, not shielded from:
 * - A pooled connection opens once and serves many requests. Only the request that was running when
 *   it *opened* is linked; the rest leave no trace in the proxy log.
 * - A long-lived inbound stream (a websocket) is in flight for minutes and so is a candidate for
 *   everything that opens during it. `candidates` exposes that; it is never hidden.
 *
 * Gateways are left out: a gateway's outbound line is the ingress route itself, already a journey.
 */

import trafficModule from './traffic.js';
const { parseUpstreamCluster } = trafficModule;
import serviceMapModule from './service-map.js';
const { failed, latency, destinationNode, workloadNode } = serviceMapModule;

const MAX_OUTBOUND_ROWS = 100;
/** Inferred outbound connections attached to one journey. The rest are counted, not listed. */
const MAX_OUTBOUND_PER_TRACE = 8;

const msOf = iso => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const num = v => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);

/** The earliest hop start of a journey, the zero its hops' `offsetMs` are measured from. */
function originOf(t) {
  const starts = t.hops.map(h => msOf(h.startTime)).filter(v => v !== null);
  return starts.length ? Math.min(...starts) : null;
}

/**
 * Per pod, the inbound requests it served: `[start, end]`, from the journeys' inbound sidecar hops.
 * Every stitched journey counts, hidden polls included, because a poll that was in flight is still
 * a candidate — dropping it would make a crowded window look like a certain link.
 */
function inFlightIndex(traces) {
  const byPod = new Map();
  for (const t of traces) {
    for (const h of t.hops) {
      if (h.role !== 'sidecar' || !h.to || h.to.direction !== 'inbound') continue;
      const start = msOf(h.startTime);
      const d = num(h.durationMs);
      if (start === null || d === null) continue;
      const key = `${h.observedBy.namespace}/${h.observedBy.pod}`;
      const list = byPod.get(key) || [];
      list.push({ start, end: start + d, trace: t });
      byPod.set(key, list);
    }
  }
  return byPod;
}

/** The inbound requests a pod was serving at `at`, innermost (latest start) first. */
function inFlightAt(list, at) {
  return (list || []).filter(x => x.start <= at && at <= x.end).sort((a, b) => b.start - a.start || a.trace.traceId.localeCompare(b.trace.traceId));
}

const nodeRef = n => ({ id: n.id, kind: n.kind, name: n.name, namespace: n.namespace });

/**
 * @param records every parsed line of the window.
 * @param traces every stitched journey, before any filter: the in-flight index.
 * @param kept the trace ids a link may name (the ones the list or the detail route can open).
 * @param namespaces the scope; a row is kept when its caller is in it.
 * @param keep the Traces poll filter over a line, so this table and the map count the same traffic.
 * @param correlated whether a line carries a correlator (truthy), optionally the trace ids it names,
 *   tried in order to name the journey an exact line belongs to. Built from traces.js's `correlatorsOf`, passed in
 *   so this module does not require the collector that requires it.
 * @returns `{ outbound: {rows, rowsFound, connections, unrouted}, perTrace: Map<traceId, {items, dropped}> }`
 */
function outboundOf(records, { index, workloads, traces, kept = new Set(), namespaces = null, keep = () => true, correlated = () => false }) {
  const flights = inFlightIndex(traces);
  const scope = namespaces ? new Set(namespaces) : null;
  const rows = new Map();
  const perTrace = new Map();
  let unrouted = 0;
  const byId = new Map(traces.map(t => [t.traceId, t]));

  for (const r of records) {
    if (!keep(r)) continue;
    const pod = `${r.proxy.namespace}/${r.proxy.pod}`;
    const self = workloads.get(pod);
    if (!self || self.gateway) continue;
    const cluster = parseUpstreamCluster(r.upstreamCluster, index);
    if (cluster && cluster.direction === 'inbound') continue;
    // An inbound call to a port no Service declares: parseUpstreamCluster cannot read the name.
    if (/^InboundPassthroughCluster/.test(r.upstreamCluster || '')) continue;
    if (scope && !scope.has(self.namespace)) continue;
    const to = destinationNode(r, index, workloads);
    if (!to) {
      // Answered by the proxy itself (NR, a local 403): an outbound attempt with no destination.
      unrouted += 1;
      continue;
    }
    const from = workloadNode(self);
    if (from.id === to.id) continue;
    const key = `${from.id}→${to.id}`;
    const row = rows.get(key) || {
      from: nodeRef(from),
      to: nodeRef(to),
      connections: 0,
      errors: 0,
      durations: [],
      tcp: 0,
      bytesSent: 0,
      bytesReceived: 0,
      bytesUnknown: 0,
      lastSeen: null,
      exact: 0,
      inferred: 0,
      unlinked: 0,
      crowded: 0,
      sample: null
    };
    row.connections += 1;
    if (failed(r)) row.errors += 1;
    const d = num(r.duration);
    if (d !== null) row.durations.push(d);
    if (!r.method) row.tcp += 1;
    const sent = num(r.bytesSent);
    const received = num(r.bytesReceived);
    if (sent === null || received === null) row.bytesUnknown += 1;
    row.bytesSent += sent || 0;
    row.bytesReceived += received || 0;
    if (r.startTime && (!row.lastSeen || r.startTime > row.lastSeen)) row.lastSeen = r.startTime;

    const ids = correlated(r);
    if (ids) {
      row.exact += 1;
      const t = Array.isArray(ids) ? ids.map(id => byId.get(id)).find(x => x && kept.has(x.traceId)) : null;
      // An exact link outranks an inferred one as the row's sample.
      if (t && (!row.sample || row.sample.link !== 'exact' || r.startTime > row.sample.startTime)) {
        row.sample = { traceId: t.traceId, method: t.method, path: t.path, link: 'exact', candidates: 1, startTime: r.startTime };
      }
    } else {
      const start = msOf(r.startTime);
      const hits = start === null ? [] : inFlightAt(flights.get(pod), start);
      if (!hits.length) {
        row.unlinked += 1;
      } else {
        row.inferred += 1;
        if (hits.length > 1) row.crowded += 1;
        const t = hits[0].trace;
        if (kept.has(t.traceId)) {
          if (!row.sample || (row.sample.link !== 'exact' && r.startTime > row.sample.startTime)) {
            row.sample = { traceId: t.traceId, method: t.method, path: t.path, link: 'inferred', candidates: hits.length, startTime: r.startTime };
          }
          // The hops' own zero, the earliest hop start (as stitch measures offsetMs), not the entry
          // hop's: a sidecar clock a few ms ahead of the gateway's would misplace the bar.
          const origin = originOf(t);
          const slot = perTrace.get(t.traceId) || { items: [], dropped: 0 };
          const item = {
            from: nodeRef(from),
            to: nodeRef(to),
            pod: r.proxy.pod,
            startTime: r.startTime,
            offsetMs: origin !== null ? start - origin : null,
            durationMs: d,
            protocol: r.method ? 'http' : 'tcp',
            code: num(r.code),
            failed: failed(r),
            bytesSent: sent,
            bytesReceived: received,
            link: 'inferred',
            candidates: hits.length
          };
          if (slot.items.length < MAX_OUTBOUND_PER_TRACE) slot.items.push(item);
          else slot.dropped += 1;
          perTrace.set(t.traceId, slot);
        }
      }
    }
    rows.set(key, row);
  }

  const all = [...rows.values()]
    .map(({ durations, tcp, ...row }) => ({
      ...row,
      errorRate: row.connections ? row.errors / row.connections : null,
      ...latency(durations),
      protocol: tcp === row.connections ? 'tcp' : tcp === 0 ? 'http' : 'mixed',
      // A byte total over lines that did not all log bytes is a floor, and says so.
      bytesSent: row.bytesUnknown === row.connections ? null : row.bytesSent,
      bytesReceived: row.bytesUnknown === row.connections ? null : row.bytesReceived
    }))
    .sort((a, b) => b.connections - a.connections || a.from.id.localeCompare(b.from.id) || a.to.id.localeCompare(b.to.id));
  for (const slot of perTrace.values()) slot.items.sort((a, b) => (a.offsetMs ?? Infinity) - (b.offsetMs ?? Infinity));

  return {
    outbound: {
      rows: all.slice(0, MAX_OUTBOUND_ROWS),
      rowsFound: all.length,
      connections: all.reduce((n, r) => n + r.connections, 0),
      /** Failure count across every grouped destination, including groups beyond the row display cap. */
      errors: all.reduce((n, r) => n + r.errors, 0),
      /** Outbound attempts the proxy answered itself: no destination to group them under. */
      unrouted
    },
    perTrace
  };
}

export default { outboundOf, inFlightAt, MAX_OUTBOUND_ROWS, MAX_OUTBOUND_PER_TRACE };
