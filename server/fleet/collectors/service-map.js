/**
 * Two aggregations over the Traces window: **endpoints** (what was called, how often, how well) and
 * the **service map** (who called whom).
 *
 * ## Endpoints are built from journeys, the map from lines
 *
 * An endpoint is a property of a request — its method, host and path — and a journey carries exactly
 * one, so the endpoint table groups the journeys the Traces filters kept (all of them, not only the
 * 200 the table shows).
 *
 * A call between two workloads is a property of one hop, and many hops belong to no journey at all:
 * a sidecar's egress to a database is a TCP line with no `traceparent` and no `x-request-id`, so
 * stitching drops it as uncorrelated. Building the map from journeys would lose exactly the edge an
 * operator opens it for (srv → HANA), so it is built from every parsed line instead.
 *
 * ## One call, two witnesses
 *
 * A call from A to B is logged twice when both sidecars were read: once by A's proxy as outbound
 * and once by B's as inbound. Adding the two double-counts; de-duplicating by request id collapses
 * two real calls in one journey into one. So each side counts on its own, and an edge publishes the
 * side that saw more (`observedBy` says which, or `both`). The two sides only disagree when one
 * proxy's tail reached further back than the other's.
 *
 * ## Nodes are workloads, by evidence
 *
 * A Pod resolves to its owner: a ReplicaSet to its Deployment by removing the `pod-template-hash`
 * label's value from its name — the label, never a guessed suffix — and a StatefulSet, DaemonSet or
 * Job to itself. A pod with no owner is its own node. External peers are never named by client
 * address: every inbound caller from outside the cluster is one "External clients" node, because a
 * client IP identifies a person's network and no question here needs it. External *destinations*
 * (egress) keep their address and port, since "which host does srv call" is the question.
 */

import trafficModule from './traffic.js';
const { resolveAddress, parseUpstreamCluster, classOf, isIngressProxy } = trafficModule;
import podOwnerModule from './pod-owner.js';
const { ownerOf } = podOwnerModule;

const MAX_ENDPOINTS = 100;
const MAX_EDGES = 80;
/** Below this many samples a 95th percentile is one or two requests, not a distribution. */
const MIN_P95_SAMPLES = 20;

/**
 * Whether one line is a failed call. An HTTP line fails on its status; a TCP line (no method —
 * a database or TLS passthrough) always logs status 0, which is not a failure, so it fails only
 * when Envoy set a response flag (UF, UH, UT…).
 */
function failed(r) {
  if (r.method) return classOf(Number(r.code)) !== 'ok';
  return !!(r.responseFlags && r.responseFlags !== '-');
}

/** Nearest-rank percentile over finite numbers, or null when there are none. */
function percentile(values, p) {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(Math.max(rank, 1), xs.length) - 1];
}

function latency(durations) {
  const n = durations.filter(v => Number.isFinite(v)).length;
  return {
    p50Ms: percentile(durations, 50),
    p95Ms: n >= MIN_P95_SAMPLES ? percentile(durations, 95) : null,
    samples: n
  };
}

function topCodes(counter, limit = 4) {
  return [...counter]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code - b.code)
    .slice(0, limit);
}

/* --------------------------------------------------------------------------------- endpoints */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path with its identifiers folded, so `/orders/1041` and `/orders/1042` are one endpoint.
 * A segment is an identifier when it is all digits, a UUID, 12+ hex characters, or 20+ characters
 * mixing letters and digits (an opaque token or hash). Words stay words.
 */
function normalizePath(path) {
  if (!path) return null;
  const bare = String(path).split('?')[0];
  return (
    bare
      .split('/')
      .map(seg => {
        if (!seg) return seg;
        if (/^\d+$/.test(seg) || UUID.test(seg) || /^[0-9a-f]{12,}$/i.test(seg)) return '{id}';
        if (seg.length >= 20 && /\d/.test(seg) && /[a-z]/i.test(seg)) return '{id}';
        // A bundler's content hash between name and extension: `index.C8X8rNzw.css`, `x.D-Dx88BQ.js`.
        const hashed = /^[\w-]+\.([\w-]{8,})\.[a-z0-9]{1,5}$/i.exec(seg);
        if (hashed && /\d/.test(hashed[1]) && /[a-z]/i.test(hashed[1])) return '{id}';
        return seg;
      })
      .join('/') || '/'
  );
}

/**
 * The workload that served a journey's entry: the first sidecar in it that is not a gateway, or,
 * when no such sidecar was read, what the ingress gateway forwarded to (a pod's workload, or the
 * Service Envoy named). Null when the entry went nowhere this read resolves.
 */
function serviceOf(t, workloads) {
  const hops = t.hops || [];
  if (!workloads) return null;
  for (const h of hops) {
    const w = h.observedBy && workloads.get(`${h.observedBy.namespace}/${h.observedBy.pod}`);
    if (w && !w.gateway) return { kind: w.kind, name: w.name, namespace: w.namespace };
  }
  const to = hops[0] && hops[0].role === 'ingress' ? hops[0].to : null;
  if (!to || !to.namespace || !to.name) return null;
  if (to.kind === 'Pod') {
    const w = workloads.get(`${to.namespace}/${to.name}`);
    return w && !w.gateway ? { kind: w.kind, name: w.name, namespace: w.namespace } : null;
  }
  return to.kind === 'Service' ? { kind: 'Service', name: to.name, namespace: to.namespace } : null;
}

function endpointsOf(traces, workloads = null) {
  const groups = new Map();
  for (const t of traces) {
    const path = normalizePath(t.path);
    const key = `${t.method || '-'} ${t.authority || '-'} ${path || '-'}`;
    const g = groups.get(key) || {
      method: t.method || null,
      host: t.authority || null,
      path,
      service: serviceOf(t, workloads),
      journeys: 0,
      errors: 0,
      durations: [],
      codes: new Map(),
      lastSeen: null,
      sampleTraceId: null
    };
    g.journeys += 1;
    if (t.hasError) g.errors += 1;
    g.durations.push(t.totalDurationMs);
    const code = t.finalStatus;
    if (code !== null && code !== undefined) g.codes.set(code, (g.codes.get(code) || 0) + 1);
    if (t.startTime && (!g.lastSeen || t.startTime > g.lastSeen)) {
      g.lastSeen = t.startTime;
      g.sampleTraceId = t.traceId;
    }
    groups.set(key, g);
  }
  const all = [...groups.values()]
    .map(g => ({
      method: g.method,
      host: g.host,
      path: g.path,
      service: g.service,
      journeys: g.journeys,
      errors: g.errors,
      errorRate: g.journeys ? g.errors / g.journeys : null,
      ...latency(g.durations),
      codes: topCodes(g.codes),
      lastSeen: g.lastSeen,
      sampleTraceId: g.sampleTraceId
    }))
    .sort((a, b) => b.journeys - a.journeys || String(a.path).localeCompare(String(b.path)));
  return { endpoints: all.slice(0, MAX_ENDPOINTS), endpointsFound: all.length };
}

/* ------------------------------------------------------------------------------- service map */

/** `ns/pod` → the workload that owns it, from ownerReferences and the pod-template-hash label. */
function workloadIndex(pods) {
  const out = new Map();
  for (const p of pods || []) {
    const meta = p.metadata || {};
    const { kind, name } = ownerOf(p);
    out.set(`${meta.namespace}/${meta.name}`, {
      kind,
      name,
      namespace: meta.namespace,
      gateway: isIngressProxy(p)
    });
  }
  return out;
}

function workloadNode(w) {
  return {
    id: `wl:${w.namespace}/${w.kind}/${w.name}`,
    kind: w.gateway ? 'gateway' : 'workload',
    workloadKind: w.kind,
    name: w.name,
    namespace: w.namespace
  };
}

const CLIENTS = { id: 'clients', kind: 'clients', workloadKind: null, name: 'External clients', namespace: null };
/**
 * A caller inside the mesh that the read cannot name. An inbound line whose SNI is Istio's
 * `outbound_.<port>_._.<host>` arrived over sidecar mTLS, so the caller is in the mesh — but its
 * peer address is X-Forwarded-For's client, and a caller that forwards neither x-request-id nor
 * traceparent (measured: approuter → srv on platformsbx) leaves no line to join it to.
 */
const MESH = { id: 'mesh', kind: 'mesh', workloadKind: null, name: 'In-mesh caller (unnamed)', namespace: null };
const fromMesh = r => /^outbound_\./.test(String(r.requestedServerName || ''));

/** A resolved address as a map node. `side` decides how an external peer is named. */
function nodeOfAddress(addr, workloads, side) {
  if (!addr) return null;
  if (addr.kind === 'Pod') {
    const w = workloads.get(`${addr.namespace}/${addr.name}`);
    return w ? workloadNode(w) : workloadNode({ kind: 'Pod', name: addr.name, namespace: addr.namespace });
  }
  if (addr.kind === 'Service') {
    return { id: `svc:${addr.namespace}/${addr.name}`, kind: 'service', workloadKind: 'Service', name: addr.name, namespace: addr.namespace };
  }
  if (addr.kind === 'Node') {
    return { id: 'nodes', kind: 'nodes', workloadKind: null, name: 'Nodes (kubelet, host network)', namespace: null };
  }
  if (addr.kind === 'external') {
    if (side === 'caller') return CLIENTS;
    const name = addr.port ? `${addr.ip}:${addr.port}` : addr.ip;
    return { id: `ext:${name}`, kind: 'external', workloadKind: null, name, namespace: null };
  }
  // A caller no Pod, Service or Node claims is named by X-Forwarded-For on an inbound sidecar — a
  // client's own (or forged) address. It joins the clients node; only a callee keeps its address.
  if (side === 'caller') return CLIENTS;
  return { id: `unresolved:${addr.ip}`, kind: 'unresolved', workloadKind: null, name: addr.ip, namespace: null };
}

/** Where a line's request went, as a node: the chosen upstream pod first, the named Service second. */
function destinationNode(record, index, workloads) {
  const host = resolveAddress(index, record.upstreamHost);
  if (host && host.kind !== 'unresolved') return nodeOfAddress(host, workloads, 'callee');
  const cluster = parseUpstreamCluster(record.upstreamCluster, index);
  if (cluster && cluster.service) return nodeOfAddress({ kind: 'Service', ...cluster.service }, workloads, 'callee');
  if (host) return nodeOfAddress(host, workloads, 'callee');
  if (cluster && cluster.fqdn) {
    return { id: `ext:${cluster.fqdn}`, kind: 'external', workloadKind: null, name: cluster.fqdn, namespace: null };
  }
  return null;
}

/**
 * Every edge the window's lines witness, each counted from the side that saw more of it.
 *
 * @param keep a predicate over a line: the Traces poll filter, so the map and the table agree on
 *   what counts as traffic.
 */
function serviceMapOf(records, { index, workloads, namespaces = null, keep = () => true, traceIdOf = null }) {
  const nodes = new Map();
  const edges = new Map();
  const side = () => ({ calls: 0, errors: 0, durations: [], codes: new Map(), lastSeen: null, tcp: 0 });

  const witness = (from, to, which, r) => {
    if (!from || !to || from.id === to.id) return;
    nodes.set(from.id, from);
    nodes.set(to.id, to);
    const key = `${from.id}→${to.id}`;
    const e = edges.get(key) || { from: from.id, to: to.id, caller: side(), callee: side() };
    const s = e[which];
    s.calls += 1;
    const tid = traceIdOf ? traceIdOf(r) : null;
    if (tid) {
      e.traces = e.traces || new Map();
      if (!e.traces.has(tid) || (r.startTime && r.startTime > e.traces.get(tid))) e.traces.set(tid, r.startTime || '');
    }
    const code = Number(r.code);
    if (failed(r)) s.errors += 1;
    if (r.method && Number.isFinite(code)) s.codes.set(code, (s.codes.get(code) || 0) + 1);
    if (r.duration !== null && r.duration !== undefined && Number.isFinite(Number(r.duration))) s.durations.push(Number(r.duration));
    if (!r.method) s.tcp += 1;
    if (r.startTime && (!s.lastSeen || r.startTime > s.lastSeen)) s.lastSeen = r.startTime;
    edges.set(key, e);
  };

  /*
    An inbound sidecar reports the ORIGINAL client as its peer when the gateway forwards
    X-Forwarded-For (measured: approuter's inbound lines named a public IP on calls the gateway
    had just logged). So an inbound line from outside the cluster is attributed to the gateway that
    logged the same x-request-id, and stays "External clients" only when no gateway line matches —
    the hop before it was not in this read.
  */
  const viaGateway = new Map();
  for (const r of records) {
    const w = workloads.get(`${r.proxy.namespace}/${r.proxy.pod}`);
    if (w && w.gateway && r.requestId) viaGateway.set(r.requestId, workloadNode(w));
  }

  for (const r of records) {
    if (!keep(r)) continue;
    const self = workloads.get(`${r.proxy.namespace}/${r.proxy.pod}`);
    if (!self) continue;
    const me = workloadNode(self);
    const cluster = parseUpstreamCluster(r.upstreamCluster, index);
    const inbound = cluster && cluster.direction === 'inbound';
    if (inbound) {
      let caller = nodeOfAddress(resolveAddress(index, r.downstreamRemote), workloads, 'caller');
      if (caller && caller.kind === 'clients' && r.requestId && viaGateway.has(r.requestId)) caller = viaGateway.get(r.requestId);
      else if (caller && caller.kind === 'clients' && fromMesh(r)) caller = MESH;
      witness(caller, me, 'callee', r);
      continue;
    }
    // A gateway's line is two calls: the client's to the gateway, and the gateway's onwards.
    if (self.gateway) witness(nodeOfAddress(resolveAddress(index, r.downstreamRemote), workloads, 'caller'), me, 'callee', r);
    witness(me, destinationNode(r, index, workloads), 'caller', r);
  }

  const scope = namespaces ? new Set(namespaces) : null;
  const all = [...edges.values()]
    .filter(e => !scope || scope.has(nodes.get(e.from).namespace) || scope.has(nodes.get(e.to).namespace))
    .map(e => {
      const pick = e.callee.calls >= e.caller.calls ? e.callee : e.caller;
      const s = pick;
      return {
        from: e.from,
        to: e.to,
        calls: s.calls,
        errors: s.errors,
        errorRate: s.calls ? s.errors / s.calls : null,
        ...latency(s.durations),
        codes: topCodes(s.codes),
        /** Connections Envoy logged with no HTTP method: TCP or TLS passthrough, e.g. a database. */
        protocol: s.tcp === s.calls ? 'tcp' : s.tcp === 0 ? 'http' : 'mixed',
        observedBy: e.caller.calls && e.callee.calls ? 'both' : e.caller.calls ? 'caller' : 'callee',
        lastSeen: s.lastSeen,
        traceIds: e.traces ? [...e.traces].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, 10).map(([id]) => id) : [],
        traceIdsFound: e.traces ? e.traces.size : 0
      };
    })
    .sort((a, b) => b.calls - a.calls || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const kept = all.slice(0, MAX_EDGES);
  const used = new Set(kept.flatMap(e => [e.from, e.to]));
  return {
    nodes: [...nodes.values()].filter(n => used.has(n.id)).sort((a, b) => a.id.localeCompare(b.id)),
    edges: kept,
    edgesFound: all.length
  };
}

export default {
  failed,
  percentile,
  latency,
  topCodes,
  workloadNode,
  destinationNode,
  normalizePath,
  endpointsOf,
  workloadIndex,
  serviceMapOf,
  MAX_ENDPOINTS,
  MAX_EDGES,
  MIN_P95_SAMPLES
};
