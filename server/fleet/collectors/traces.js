/**
 * Distributed traces — multi-hop request journeys stitched from Envoy access logs.
 *
 * ## What this can and cannot be
 *
 * There is no trace store in this console and no span export to read. What there is, on every
 * meshed pod, is an `istio-proxy` access log where **each hop of a request writes its own line**.
 * Stitching those lines back together by a shared correlation id reconstructs the journey — who
 * called whom, how long each leg took, and which hop is the one that actually failed. That is the
 * whole mechanism, and it decides every limitation below.
 *
 * ### The correlator is the entire feature, and there are three of them
 *
 *   - **`traceparent`** (W3C) is the best one: it carries a trace id *and* a span id, so hops can
 *     be nested rather than merely ordered. It is only in the log if the mesh's access-log format
 *     asks for it — a typical `stdout-json` format does **not** — and Envoy only populates it
 *     when tracing is enabled on the mesh. `enableTracing: false` on the Istio module CR governs
 *     that regardless of the sampling rate, which is a configuration this fleet has already been
 *     bitten by.
 *   - **`x-b3-*`** (Zipkin) is the same idea in Istio's older headers, accepted for the same reason.
 *   - **`x-request-id`** always works. Envoy mints it at the edge and propagates it to every hop
 *     whether or not tracing is on. It carries no span id, so hops are ordered by time and nesting
 *     is *inferred* from duration — which is why a trace stitched this way says so on the wire.
 *
 * So `correlation.source` is reported, never assumed, and `correlation.traceparentLines: 0`
 * alongside a populated `requestIdLines` is a **configuration finding** ("this mesh does not log
 * traceparent"), not an empty result. Those two states render differently, because the operator
 * action is different: one is a log-format change, the other is nothing.
 *
 * ### One-line traces are the normal case, not a bug
 *
 * A request only produces multiple lines if multiple proxies handled it *and* this read happened
 * to tail all of them. A pod outside the ten this read can afford, a namespace without sidecar
 * injection, or a hop whose line has already scrolled past the tail all yield a trace that looks
 * single-hop. `hopCount` is therefore "hops this window saw", and `window` publishes exactly which
 * proxies contributed so that number can be read honestly. It is never presented as the topology.
 *
 * ### Timing
 *
 * `durationMs` is Envoy's own measurement per hop and is trustworthy. Everything *derived* from
 * two hops is not equally so: `transitMs` (a caller's duration minus its callee's — the time that
 * went into the network and the proxies rather than into the app) is only meaningful when the hops
 * are properly nested, and a callee reporting a longer duration than its caller means clock skew
 * between nodes or two unrelated requests sharing an id. That case sets `nestingAnomaly` and
 * publishes `null` rather than a negative number dressed up as a measurement.
 */

import k8sModule from '../k8s.js';
const { list, text } = k8sModule;
import safeListModule from './safe-list.js';
const { safeList, requiredList, unavailableLabels, truncatedLabels } = safeListModule;
import trafficModule from './traffic.js';
const {
  readProxyLogs,
  readProxiesEarly,
  discoverProxyPods,
  windowReadAt,
  selectProxies,
  registryOf,
  routeBackendSelectors,
  buildIndex,
  resolveAddress,
  parseUpstreamCluster,
  decodeResponseFlag,
  meshProviders,
  accessLogVerdict,
  isIngressProxy,
  classOf,
  clean
} = trafficModule;
import serviceMapModule from './service-map.js';
const { endpointsOf, serviceMapOf, workloadIndex } = serviceMapModule;
import outboundModule from './outbound.js';
const { outboundOf } = outboundModule;
import destinationNamesModule from '../destination-names.js';
const { nameServiceMap, nameNodeRefs, nameEndpointHosts, nameHopEndpoints, namedDestinations } = destinationNamesModule;
import journeyPathModule from './journey-path.js';
const { buildPaths } = journeyPathModule;
import edgeModule from './edge.js';
const { edgeMetaOf, ingressLabelsOf } = edgeModule;
import requestClassModule from './request-class.js';
const { POLL_RULES, pollOf, classifyJourney, NOISE_CLASSES } = requestClassModule;

const TELEMETRY_GROUP = 'telemetry.istio.io';
const NETWORKING_GROUP = 'networking.istio.io';
const DISCOVERY_GROUP = 'discovery.k8s.io';
const ISTIO_VERSION = 'v1';
const MESH_CONFIGMAP = { namespace: 'istio-system', name: 'istio' };

/**
 * 500 lines rather than the 300 the Traffic tab tails.
 *
 * Stitching needs *both ends* of a call in the same window: at 300 lines a busy ingress gateway's
 * tail covers a shorter wall-clock span than a quiet sidecar's, so the gateway's half of a journey
 * is already gone while the sidecar still holds its half — which presents as a one-hop trace, the
 * one failure mode that is indistinguishable from a healthy single-proxy request.
 */
const DEFAULT_TAIL_LINES = 500;
const MAX_TAIL_LINES = 1000;
const MAX_PODS = 12;

/** Bounds on what goes over the wire. A window can hold far more traces than a table can show. */
const MAX_TRACES = 200;
const MAX_HOPS = 20;

/**
 * The 200 the table keeps: work first, then the newest noise. Newest-first over everything let
 * scanner handshakes fill every slot (platform-sbx: 188 direct-or-tls + 12 refused + 0 app), so the
 * app journeys an operator came for were cut before the table saw them. Order stays newest-first.
 */
function capJourneys(journeys, max, noise) {
  if (journeys.length <= max) return journeys.slice();
  const work = journeys.filter(t => !noise.has(t.class));
  const keep = new Set(work.slice(0, max));
  for (const t of journeys) {
    if (keep.size >= max) break;
    if (noise.has(t.class)) keep.add(t);
  }
  return journeys.filter(t => keep.has(t));
}

/** "Slow" for the list filter. An arbitrary line, so it is published rather than hardcoded in the UI. */
const SLOW_MS = 500;

/** A DNS-1123 label, the only shape a namespace can have. Anything else in `?namespace=` is dropped. */
const NAMESPACE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `?namespace=a,b` as a sorted list of valid names, or null for "every namespace". */
function namespacesOf(raw) {
  if (!raw) return null;
  const names = [...new Set(String(raw).split(',').map(s => s.trim()).filter(n => NAMESPACE_LABEL.test(n)))].sort();
  return names.length ? names : null;
}

/** True when any hop was logged in, came from, or went to one of `namespaces`. */
function touches(trace, namespaces) {
  const set = new Set(namespaces);
  return trace.hops.some(
    h =>
      set.has(h.observedBy && h.observedBy.namespace) ||
      set.has(h.from && h.from.namespace) ||
      set.has(h.to && h.to.namespace)
  );
}

/**
 * Why a journey is left out of the table, or null to keep it. Evaluated BEFORE the `MAX_TRACES`
 * cap, which is the point: filtering after the cap would hand back 200 slots of which 190 were
 * already spent on polls.
 */
function hiddenAs(trace, { namespaces, showPolls }) {
  if (namespaces && !touches(trace, namespaces)) return 'outside';
  if (!showPolls && trace.poll && !trace.hasError) return 'poll';
  return null;
}

/** `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`, per the W3C Trace Context spec. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/** A 32- or 16-hex-digit B3 trace id. Istio emits both widths. */
const B3_ID = /^[0-9a-f]{16}(?:[0-9a-f]{16})?$/i;

/**
 * One `traceparent` header value, or null.
 *
 * Strict on purpose: a malformed value is not half-usable. `00000…0` is rejected as well as
 * unparseable input, because an all-zero trace id is what a client sends when it wants to say "no
 * trace", and grouping every such request together would stitch unrelated journeys into one.
 */
function parseTraceparent(raw) {
  const value = clean(raw);
  if (!value) return null;
  const m = TRACEPARENT.exec(value);
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return {
    version: version.toLowerCase(),
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    // The low bit of the flags byte is `sampled`. Reported because an unsampled request is one a
    // trace backend will not have either — it explains an absence rather than leaving it a mystery.
    sampled: (parseInt(flags, 16) & 0x01) === 1
  };
}

/**
 * Which correlator this line offers, best first.
 *
 * Deliberately not "whichever is present": mixing correlators inside one window would group the
 * same request under two different ids, so the *collection* picks one source and every line is read
 * under it. This returns the candidates and `stitch` decides.
 */
function correlatorsOf(record) {
  const tp = parseTraceparent(record.traceparent);
  const b3Trace = clean(record.b3TraceId);
  const b3 = b3Trace && B3_ID.test(b3Trace) && !/^0+$/.test(b3Trace)
    ? {
        traceId: b3Trace.toLowerCase(),
        spanId: (clean(record.b3SpanId) || '').toLowerCase() || null,
        parentSpanId: (clean(record.b3ParentSpanId) || '').toLowerCase() || null
      }
    : null;
  const requestId = clean(record.requestId);
  return {
    traceparent: tp ? { traceId: tp.traceId, spanId: tp.spanId, parentSpanId: null, sampled: tp.sampled } : null,
    b3,
    requestId: requestId ? { traceId: requestId, spanId: null, parentSpanId: null } : null
  };
}

/**
 * Which correlator the window as a whole can be stitched by, and the counts behind that choice.
 *
 * The counts are the point. "0 of 412 lines carry traceparent" is a sentence about the mesh's
 * log format that the tab can act on; a bare `source: 'request-id'` is not.
 */
function correlationCoverage(records) {
  let traceparentLines = 0;
  let b3Lines = 0;
  let requestIdLines = 0;
  let uncorrelatedLines = 0;
  let sampledLines = 0;

  for (const r of records) {
    const c = correlatorsOf(r);
    if (c.traceparent) {
      traceparentLines += 1;
      if (c.traceparent.sampled) sampledLines += 1;
    }
    if (c.b3) b3Lines += 1;
    if (c.requestId) requestIdLines += 1;
    if (!c.traceparent && !c.b3 && !c.requestId) uncorrelatedLines += 1;
  }

  // Majority, not mere presence: one client sending its own traceparent into a mesh that does not
  // log one must not switch the whole window onto a correlator 99% of its lines lack.
  const half = records.length / 2;
  const source = traceparentLines > half ? 'traceparent' : b3Lines > half ? 'b3' : requestIdLines > 0 ? 'request-id' : null;

  return {
    source,
    traceparentLines,
    b3Lines,
    requestIdLines,
    uncorrelatedLines,
    sampledLines,
    /**
     * True when the log format carries no `traceparent` at all while still carrying requests.
     *
     * A configuration finding rather than an absence: the mesh's access-log format has to name the
     * header before Envoy writes it, and a typical `stdout-json` does not. Distinct from "no
     * requests", which is what a bare zero would say.
     */
     traceparentAbsent: records.length > 0 && traceparentLines === 0,
    /** True when hop nesting is inferred from duration because no span id was available. */
    nestingInferred: source === 'request-id' || source === null
  };
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function msOf(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Where a hop sent the request: the upstream cluster's FQDN if it named one, else the address. */
function destinationOf(record, index) {
  const cluster = parseUpstreamCluster(record.upstreamCluster, index);
  const address = resolveAddress(index, record.upstreamHost);
  if (cluster && cluster.service) {
    return {
      kind: 'Service',
      name: cluster.service.name,
      namespace: cluster.service.namespace,
      ip: address ? address.ip : null,
      port: cluster.port,
      direction: cluster.direction,
      fqdn: cluster.fqdn,
      evidence: cluster.service.evidence
    };
  }
  if (address) {
    return {
      kind: address.kind,
      name: address.name,
      namespace: address.namespace,
      ip: address.ip,
      port: address.port,
      direction: cluster ? cluster.direction : null,
      fqdn: cluster ? cluster.fqdn : null,
      evidence: address.evidence
    };
  }
  if (cluster) {
    return {
      kind: 'unresolved',
      name: cluster.fqdn || cluster.raw,
      namespace: null,
      ip: null,
      port: cluster.port,
      direction: cluster.direction,
      fqdn: cluster.fqdn,
      evidence: 'Envoy named an upstream cluster, but no Service in this read matches its FQDN.'
    };
  }
  /*
    No upstream at all. This is a real and common state, not a gap: a 403 from an
    AuthorizationPolicy, a 404 with `NR`, and a listener rejection are all answered by the proxy
    itself and never reach a workload. Saying "not routed" is the finding.
  */
  return null;
}

/** One access-log line as one hop of a journey. */
function hopOf(record, index, ingressKeys) {
  const key = `${record.proxy.namespace}/${record.proxy.pod}`;
  const duration = finite(record.duration);
  const upstreamMs = finite(record.upstreamMs);
  return {
    observedBy: { pod: record.proxy.pod, namespace: record.proxy.namespace },
    /** Which tier reported the line. The ingress hop is the one whose status the client saw. */
    role: ingressKeys.has(key) ? 'ingress' : 'sidecar',
    startTime: record.startTime || null,
    method: record.method,
    path: record.path,
    authority: record.authority,
    protocol: record.protocol,
    routeName: record.routeName,
    code: record.code,
    codeClass: classOf(record.code),
    durationMs: duration,
    /** From `x-envoy-upstream-service-time`: the part of `durationMs` the upstream itself spent. */
    upstreamMs,
    /**
     * `durationMs - upstreamMs` — the proxy's own work plus the downstream leg.
     *
     * Null when either input is missing, and null rather than 0 when the subtraction goes negative:
     * the two values are measured at different points and a negative remainder is a measurement
     * artefact, not a discovery about the proxy.
     */
    proxyOverheadMs: duration !== null && upstreamMs !== null && duration >= upstreamMs ? duration - upstreamMs : null,
    responseFlags: record.responseFlags,
    flagDetails: (record.responseFlags ? String(record.responseFlags).split(/[,\s]+/).filter(Boolean) : [])
      .map(f => decodeResponseFlag(f, [record.responseCodeDetails, record.terminationDetails].filter(Boolean)))
      .filter(Boolean),
    responseCodeDetails: record.responseCodeDetails,
    terminationDetails: record.terminationDetails,
    from: callerOf(resolveAddress(index, record.downstreamRemote)),
    to: destinationOf(record, index),
    bytesSent: record.bytesSent,
    bytesReceived: record.bytesReceived
  };
}

/**
 * The calling side of a hop, with a client's address removed. A peer no Pod, Service or Node claims
 * is a browser behind the gateway, or whatever X-Forwarded-For named on an inbound sidecar: its IP
 * is personal data and never leaves the collector. The kind stays, so the hop still says "outside".
 */
function callerOf(addr) {
  if (!addr || (addr.kind !== 'external' && addr.kind !== 'unresolved')) return addr;
  return { ...addr, ip: null, port: null, name: addr.kind === 'external' ? 'External client' : 'Unresolved caller', evidence: `${addr.evidence ? `${addr.evidence}; ` : ''}the client address is not reported` };
}

/**
 * Group the window's lines into traces and order each one's hops.
 *
 * Ordering is by start time, then by duration descending — a caller and its callee routinely share
 * a millisecond-granularity start stamp, and of two hops that started in the same millisecond the
 * one that lasted longer is the one that contains the other.
 */
function stitch(records, index, { ingressKeys, source, maxTraces = MAX_TRACES, maxHops = MAX_HOPS } = {}) {
  const groups = new Map();
  let uncorrelated = 0;

  for (const r of records) {
    const c = correlatorsOf(r);
    const pickForSource =
      source === 'traceparent' ? c.traceparent : source === 'b3' ? c.b3 : source === 'request-id' ? c.requestId : null;
    // Falling back within a line, not across the window: a mesh that logs traceparent on its
    // gateway and not on its sidecars would otherwise drop half of every journey.
    const chosen = pickForSource || c.traceparent || c.b3 || c.requestId;
    if (!chosen) {
      uncorrelated += 1;
      continue;
    }
    const entry = groups.get(chosen.traceId) || { traceId: chosen.traceId, records: [], spanIds: new Set() };
    entry.records.push({ record: r, span: chosen });
    if (chosen.spanId) entry.spanIds.add(chosen.spanId);
    groups.set(chosen.traceId, entry);
  }

  const traces = [];
  for (const group of groups.values()) {
    const sorted = [...group.records].sort((a, b) => {
      const at = msOf(a.record.startTime);
      const bt = msOf(b.record.startTime);
      if (at !== null && bt !== null && at !== bt) return at - bt;
      const ad = finite(a.record.duration);
      const bd = finite(b.record.duration);
      if (ad !== null && bd !== null && ad !== bd) return bd - ad;
      return 0;
    });

    const kept = sorted.slice(0, maxHops);
    const hops = kept.map(({ record, span }) => ({
      ...hopOf(record, index, ingressKeys),
      spanId: span.spanId || null,
      parentSpanId: span.parentSpanId || null
    }));

    const starts = hops.map(h => msOf(h.startTime)).filter(t => t !== null);
    const origin = starts.length ? Math.min(...starts) : null;
    let nestingAnomaly = false;
    hops.forEach((hop, i) => {
      const start = msOf(hop.startTime);
      hop.seq = i + 1;
      hop.offsetMs = origin !== null && start !== null ? start - origin : null;
      const next = hops[i + 1];
      if (!next || hop.durationMs === null || next.durationMs === null) {
        hop.transitMs = null;
        return;
      }
      const gap = hop.durationMs - next.durationMs;
      if (gap < 0) {
        // The callee claims to have taken longer than its caller. Clock skew between nodes, or two
        // unrelated requests sharing a correlation id. Either way there is no transit time here.
        hop.transitMs = null;
        nestingAnomaly = true;
        return;
      }
      hop.transitMs = gap;
    });

    // The hop whose status code the client actually received: the ingress gateway when one is in
    // the window, otherwise the outermost hop we have.
    const entryHop = hops.find(h => h.role === 'ingress') || hops[0] || null;
    const worst = hops.reduce((acc, h) => (h.codeClass !== 'ok' && acc === null ? h : acc), null);
    const errorHop = worst ? hops.indexOf(worst) + 1 : null;
    const requestIds = [...new Set(kept.map(({ record }) => clean(record.requestId)).filter(Boolean))];

    traces.push({
      traceId: group.traceId,
      /** Which header this trace was grouped by — `request-id` means the nesting is inferred. */
      correlatedBy:
        source === 'traceparent' && group.spanIds.size ? 'traceparent' : group.spanIds.size ? 'b3' : 'request-id',
      requestId: requestIds[0] || null,
      requestIds: requestIds.length > 1 ? requestIds : null,
      startTime: entryHop ? entryHop.startTime : null,
      method: entryHop ? entryHop.method : null,
      path: entryHop ? entryHop.path : null,
      authority: entryHop ? entryHop.authority : null,
      /** The client-visible status. Not the worst status in the trace — those are different facts. */
      finalStatus: entryHop ? entryHop.code : null,
      finalStatusClass: entryHop ? entryHop.codeClass : null,
      worstStatus: worst ? worst.code : null,
      /** Which hop, 1-based, first went wrong. The root-cause pointer the waterfall highlights. */
      errorHop,
      hasError: hops.some(h => h.codeClass !== 'ok'),
      totalDurationMs: entryHop ? entryHop.durationMs : null,
      /** Hops THIS WINDOW SAW. Never the request's real topology — see the module note. */
      hopCount: hops.length,
      hopsDropped: Math.max(0, sorted.length - kept.length),
      entryRole: entryHop ? entryHop.role : null,
      /** True when hop durations do not nest, so no transit time is published for this trace. */
      nestingAnomaly,
      flags: [...new Set(hops.flatMap(h => h.flagDetails.map(f => f.flag)))],
      /** Which liveness poll this journey is (`POLL_RULES`), or null for a request made on purpose. */
      poll: pollOf(entryHop ? entryHop.path : null),
      hops
    });
  }

  traces.sort((a, b) => {
    const at = msOf(a.startTime);
    const bt = msOf(b.startTime);
    if (at !== null && bt !== null && at !== bt) return bt - at;
    return String(a.traceId).localeCompare(String(b.traceId));
  });

  return { traces: traces.slice(0, maxTraces), tracesFound: traces.length, uncorrelated };
}

/**
 * One trace out of an already-collected window.
 *
 * A pure function over the payload rather than its own read: the detail route shares the list
 * route's cache entry, so opening a trace costs nothing and — more importantly — shows the same
 * window the row came from. A second read would tail a different window and could legitimately not
 * contain the trace the operator just clicked.
 */
/** The list response: everything but the journeys carried only for the detail route. */
function listView(data) {
  const { endpointSamples: _samples, ...rest } = data;
  return rest;
}

function pickTrace(data, traceId) {
  const wanted = String(traceId || '').toLowerCase();
  const match = t => String(t.traceId).toLowerCase() === wanted;
  const hit = (data.traces || []).find(match) || (data.endpointSamples || []).find(match) || null;
  return {
    ...listView(data),
    traces: hit ? [hit] : [],
    trace: hit,
    requestedTraceId: traceId || null,
    /**
     * Why there is no trace. `NOT_IN_WINDOW` is not an error: a log tail moves, and a trace that
     * has scrolled out is the expected end of every trace's life here. The UI says so instead of
     * rendering an empty waterfall.
     */
    notFoundReason: hit ? null : 'NOT_IN_WINDOW'
  };
}

async function collect({
  cluster,
  token,
  namespace,
  polls,
  tailLines,
  maxPods,
  sinceSeconds,
  listFn = list,
  textFn = text,
  logShare = null,
  registryShare = null,
  maxLogAgeMs = 0
}) {
  const baseCtx = { cluster, token };
  const lines = Math.min(Math.max(Number(tailLines) || DEFAULT_TAIL_LINES, 1), MAX_TAIL_LINES);
  const podBudget = Math.min(Math.max(Number(maxPods) || MAX_PODS, 1), MAX_PODS);
  const sinceRaw = Number(sinceSeconds);
  const since = Number.isFinite(sinceRaw) && sinceRaw >= 1 ? Math.floor(sinceRaw) : null;
  const namespaces = namespacesOf(namespace);
  const showPolls = polls === 'show';

  // The egress registry (names, routes, Gateway hosts) comes from the router's share, one build per
  // cluster and credential for both tabs; each read in it is a safeList, so a refused one leaves
  // its addresses bare and is listed as unavailable, never failing the route.
  // Tail-critical reads first, then the proxy discovery, then the rest: the Traffic tab's order and
  // reason (see readProxiesEarly in traffic.js).
  const telemetriesRead = safeList(listFn, baseCtx, `/apis/${TELEMETRY_GROUP}/${ISTIO_VERSION}/telemetries`, 'telemetries');
  const podsRead = requiredList('pods', () => listFn({ ...baseCtx, path: '/api/v1/pods?limit=2000' }));
  const meshConfigRead = safeList(
    listFn,
    baseCtx,
    `/api/v1/namespaces/${MESH_CONFIGMAP.namespace}/configmaps?fieldSelector=metadata.name%3D${MESH_CONFIGMAP.name}`,
    'istio-mesh-config'
  );
  const skipReads = Promise.all([telemetriesRead, meshConfigRead]).then(([t, m]) => {
    const verdict = accessLogVerdict(t, meshProviders(m));
    return verdict.state === 'on' && verdict.readable === false;
  });
  // Scoped before the pod budget, not after: the budget otherwise spends its twelve reads on the
  // first proxies cluster-wide, and on a live cluster skipped 29 of 41 — including the namespace asked for.
  const registryRead = registryOf({ registryShare, listFn, baseCtx, maxAgeMs: maxLogAgeMs ? undefined : 0 });
  const proxyReads = readProxiesEarly({
    podsRead,
    discovery: discoverProxyPods(listFn, baseCtx),
    skipReads,
    backends: registryRead.then(reg => routeBackendSelectors(reg.routes, reg.reads.services)).catch(() => null),
    select: (items, backends) =>
      selectProxies(items, { namespaces: namespaces || undefined, keepIngress: true, maxPods: podBudget, backends }),
    read: proxies =>
      readProxyLogs({ baseCtx, proxies, textFn, tailLines: lines, sinceSeconds: since, logShare, maxLogAgeMs })
  });

  const [telemetries, pods, services, endpointslices, nodes, gateways, meshConfig, registry, proxyRead] = await Promise.all([
    telemetriesRead,
    podsRead,
    safeList(listFn, baseCtx, '/api/v1/services?limit=2000', 'services'),
    safeList(listFn, baseCtx, `/apis/${DISCOVERY_GROUP}/v1/endpointslices?limit=2000`, 'endpointslices'),
    safeList(listFn, baseCtx, '/api/v1/nodes', 'nodes'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/gateways`, 'istio-gateways'),
    meshConfigRead,
    registryRead,
    proxyReads
  ]);
  const names = registry.names;
  const nameReads = registry.reads.nameReads;

  const mesh = meshProviders(meshConfig);
  const accessLog = accessLogVerdict(telemetries, mesh);
  const index = buildIndex({ pods, services, endpointslices, nodes, gateways });

  const { selected, skipped, candidates } = proxyRead.selection;
  // The scope control's options: every namespace with a running sidecar, whether or not it was read.
  const meshCounts = new Map();
  for (const p of selectProxies(pods.items, { maxPods: Infinity }).selected) {
    if (isIngressProxy(p)) continue;
    meshCounts.set(p.metadata.namespace, (meshCounts.get(p.metadata.namespace) || 0) + 1);
  }
  const meshNamespaces = [...meshCounts]
    .map(([ns, proxies]) => ({ namespace: ns, proxies }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));

  // Same guard as the Traffic tab, and for the same reason: reading ten proxies whose logs provably
  // go somewhere else produces an empty window that looks like a quiet cluster.
  const readsSkipped = accessLog.state === 'on' && accessLog.readable === false;
  const reads = readsSkipped ? [] : proxyRead.reads;

  const records = reads.flatMap(r => r.requests);
  const ingressKeys = new Set(
    selected.filter(isIngressProxy).map(p => `${p.metadata.namespace}/${p.metadata.name}`)
  );

  const correlation = correlationCoverage(records);
  const stitched = stitch(records, index, {
    ingressKeys,
    source: correlation.source,
    maxTraces: Infinity
  });
  const { uncorrelated } = stitched;
  // One class per journey, from its first hop (request-class.js); Ingress & Traffic uses the same rules.
  // Traffic's rule (edgeBlocks): the Gateways unread and either route source unread leaves hosts unjudgeable.
  const reg = registry.reads;
  const hostsUnknown = Boolean(reg.gateways.unavailable && [reg.virtualservices, reg.ingresses, reg.httproutes].some(r => r.unavailable));
  const classCtx = { registry: names, routes: registry.routes, gatewayHosts: registry.gatewayHosts, hostsUnknown };
  for (const t of stitched.traces) Object.assign(t, classifyJourney(t, classCtx));
  const pollsHidden = new Map();
  let outsideNamespace = 0;
  const matching = stitched.traces.filter(t => {
    const why = hiddenAs(t, { namespaces, showPolls });
    if (why === 'outside') outsideNamespace += 1;
    if (why === 'poll') pollsHidden.set(t.poll, (pollsHidden.get(t.poll) || 0) + 1);
    return why === null;
  });
  const traces = capJourneys(matching, MAX_TRACES, NOISE_CLASSES);
  const tracesFound = matching.length;
  // Both over everything the filters kept, never over the capped 200: the cap keeps work ahead of
  // noise and the newest of each, so a rate over it is a rate over a skewed, recent slice.
  const workloads = workloadIndex(pods.items);
  /*
    Endpoints leave out journeys that were nobody's work — probes, policy refusals, direct-IP and
    TLS rejections — so p50 and p95 are app latency. `endpointsAll` keeps them for the UI's
    "Include N filtered" control, and `endpointsFiltered` says what was left out.
  */
  const worked = matching.filter(t => !NOISE_CLASSES.has(t.class));
  const endpoints = endpointsOf(worked, workloads);
  const endpointsAll = endpointsOf(matching, workloads);
  const filteredBy = new Map();
  for (const t of matching) if (NOISE_CLASSES.has(t.class)) filteredBy.set(t.class, (filteredBy.get(t.class) || 0) + 1);
  /*
    An endpoint row opens its newest journey, and on a busy window that journey is often older than
    the 200 the table keeps (measured: one browser's 401 stream filled every slot). Those journeys
    ride along for the detail route only; `listView` strips them from the list response.
  */
  const kept = new Set(traces.map(t => t.traceId));
  const byTraceId = new Map(matching.map(t => [t.traceId, t]));
  const endpointSamples = [...new Set([...endpoints.endpoints, ...endpointsAll.endpoints].map(e => e.sampleTraceId))]
    .filter(tid => tid && !kept.has(tid) && byTraceId.has(tid))
    .map(tid => byTraceId.get(tid));
  /*
    Outbound: every call a workload's sidecar logged on its way out. A line with no correlator (a
    TLS passthrough to a database) is linked to the request its pod was serving when the connection
    opened — inferred, with the number of candidates — and the journeys it links to carry it.
  */
  const linkable = new Set([...kept, ...endpointSamples.map(t => t.traceId)]);
  const traceIdsOf = r => {
    const c = correlatorsOf(r);
    return [c.traceparent, c.b3, c.requestId].filter(Boolean).map(x => x.traceId);
  };
  const serviceMap = serviceMapOf(records, {
    index,
    workloads,
    namespaces,
    keep: r => showPolls || !(pollOf(r.path) && classOf(r.code) === 'ok'),
    traceIdOf: r => traceIdsOf(r).find(id => linkable.has(id)) || null
  });
  const { outbound, perTrace } = outboundOf(records, {
    index,
    workloads,
    traces: stitched.traces,
    kept: linkable,
    namespaces,
    keep: r => showPolls || !(pollOf(r.path) && classOf(r.code) === 'ok'),
    correlated: r => {
      const ids = traceIdsOf(r);
      return ids.length ? ids : false;
    }
  });
  // Every stitched journey, not only the kept ones: a joined child the filters left out still
  // brings its externals into its parent's path. Hops are named once here, for all of them.
  for (const t of stitched.traces) {
    const slot = perTrace.get(t.traceId);
    t.outbound = slot ? slot.items : [];
    t.outboundDropped = slot ? slot.dropped : 0;
    nameNodeRefs(t.outbound, names);
  }
  nameHopEndpoints(stitched.traces, names);

  // The path each kept journey took (journey-path.js). Built over every stitched journey so a
  // child the filters left out still joins its parent; only kept journeys carry the result.
  // A declared destination is one a NetworkPolicy annotation names, keyed by that policy's namespace.
  const declared = new Map();
  for (const d of namedDestinations(names)) {
    if (d.source !== 'networkpolicy' && d.source !== 'networkpolicy-prose') continue;
    for (const o of d.objects) {
      const m = /^NetworkPolicy ([^/]+)\/(.+)$/.exec(o);
      if (!m) continue;
      const list = declared.get(m[1]) || [];
      if (!list.some(x => x.display === d.display)) list.push({ display: d.display, namespace: m[1], policyName: m[2] });
      declared.set(m[1], list);
    }
  }
  const readKeys = new Set(reads.filter(r => !r.failed).map(r => `${r.proxy.namespace}/${r.proxy.pod}`));
  // Reuses the same `services`/`gateways` reads made above for this request; no second read of
  // either. Gateway timing stays unavailable — the load balancer writes no access log.
  const edgeMeta = edgeMetaOf({ services, gateways, gatewayLabels: ingressLabelsOf(pods) });
  const paths = buildPaths(stitched.traces, { proxiesRead: readKeys, declared, edge: edgeMeta });
  // `journeyPath`, never `path`: a journey's `path` is already its request's URL path.
  for (const t of [...traces, ...endpointSamples]) {
    const p = paths.get(t.traceId);
    t.journeyPath = p ? p.path : null;
    t.pathReason = p ? p.pathReason : 'not built';
  }
  nameServiceMap(serviceMap, names);
  nameNodeRefs(outbound.rows, names);
  nameEndpointHosts(endpoints.endpoints, names);
  nameEndpointHosts(endpointsAll.endpoints, names);
  const classCounts = {};
  for (const t of traces) classCounts[t.class] = (classCounts[t.class] || 0) + 1;

  const multiHop = traces.filter(t => t.hopCount > 1).length;
  const stamps = records.map(r => r.startTime).filter(Boolean).sort();

  return {
    cluster: {
      id: cluster.id,
      displayName: cluster.displayName || cluster.id,
      env: cluster.env || 'unknown'
    },
    /** Why there may be nothing to read at all. Same verdict object the Traffic tab renders. */
    accessLog,
    correlation: {
      ...correlation,
      multiHopTraces: multiHop,
      singleHopTraces: traces.length - multiHop,
      uncorrelatedLines: uncorrelated
    },
    window: {
      proxiesRead: reads.filter(r => !r.failed).length,
      readsSkipped,
      proxiesFailed: reads
        .filter(r => r.failed)
        .map(r => ({ pod: r.proxy.pod, namespace: r.proxy.namespace, reason: r.reason, detail: r.detail || null })),
      proxyCandidates: candidates,
      proxiesSkipped: skipped,
      /** Which proxies contributed lines. The honest denominator for every `hopCount` above. */
      proxies: reads
        .filter(r => !r.failed)
        .map(r => ({
          pod: r.proxy.pod,
          namespace: r.proxy.namespace,
          role: ingressKeys.has(`${r.proxy.namespace}/${r.proxy.pod}`) ? 'ingress' : 'sidecar',
          lines: r.read,
          parsed: r.requests.length,
          truncated: r.truncated
        })),
      tailLines: lines,
      namespace: namespaces ? namespaces.join(',') : null,
      /** The scope as a list; null reads every namespace. Ingress gateways are read either way. */
      namespaces,
      meshNamespaces,
      sinceSeconds: since,
      linesRead: reads.reduce((n, r) => n + r.read, 0),
      requestsParsed: records.length,
      linesUnparsed: reads.reduce((n, r) => n + r.unparsed, 0),
      truncatedProxies: reads.filter(r => r.truncated).length,
      oldest: stamps[0] || null,
      newest: stamps[stamps.length - 1] || null
    },
    summary: {
      /** When this window was actually read — cached inside the payload it stamps, so a served
       *  copy still reports the time it was collected, never the time it was served. */
      readAt: new Date().toISOString(),
      traces: traces.length,
      /** Journeys that passed the scope and poll filters, before the `MAX_TRACES` ceiling. */
      tracesFound,
      /** Every journey the window stitched, before any filter. */
      journeysSeen: stitched.tracesFound,
      /** Successful liveness polls left out; failing ones always stay. Zero when `polls=show`. */
      pollsHidden: [...pollsHidden.values()].reduce((n, c) => n + c, 0),
      pollsHiddenBy: [...pollsHidden].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      pollsShown: showPolls,
      /** Journeys that never touched the selected namespaces. Zero when no scope is set. */
      outsideNamespace,
      multiHop,
      errorTraces: traces.filter(t => t.hasError).length,
      /** App journeys with a 5xx or an upstream failure: never a refusal, a probe or a scanner. */
      appErrorTraces: traces.filter(t => t.appError).length,
      /**
       * Kept journeys per request class (request-class.js). Over the capped set, which keeps work
       * ahead of noise (`capJourneys`), so a noise count here can undercount the window.
       */
      classCounts,
      slowTraces: traces.filter(t => t.totalDurationMs !== null && t.totalDurationMs >= SLOW_MS).length,
      slowThresholdMs: SLOW_MS,
      hops: traces.reduce((n, t) => n + t.hopCount, 0),
      unavailable: unavailableLabels([telemetries, services, endpointslices, nodes, gateways, meshConfig, registry.reads.virtualservices, registry.reads.ingresses, registry.reads.httproutes, ...nameReads]),
      truncated: truncatedLabels([pods, services, endpointslices, nodes, gateways, registry.reads.virtualservices, registry.reads.ingresses, registry.reads.httproutes, ...nameReads])
    },
    /** One row per method + host + normalised path, over the kept journeys that were someone's work. */
    endpoints,
    /** The same over every kept journey, probes, refusals and direct-IP dials included. */
    endpointsAll,
    /** What `endpoints` left out, by class. */
    endpointsFiltered: {
      journeys: matching.length - worked.length,
      byClass: [...filteredBy].map(([c, count]) => ({ class: c, count })).sort((a, b) => b.count - a.count || a.class.localeCompare(b.class))
    },
    /** Workload-to-workload calls from every parsed line, correlated or not. See service-map.js. */
    serviceMap,
    /** Per workload and destination, every outbound call; see outbound.js for the two link kinds. */
    outbound,
    traces,
    endpointSamples,
    collectedAt: windowReadAt(reads)
  };
}

export default {
  pollOf,
  namespacesOf,
  hiddenAs,
  POLL_RULES,
  collect,
  pickTrace,
  // Exported for the tests: each is a decision a live cluster can only confirm, never specify.
  parseTraceparent,
  correlatorsOf,
  correlationCoverage,
  destinationOf,
  hopOf,
  stitch,
  DEFAULT_TAIL_LINES,
  MAX_TAIL_LINES,
  MAX_PODS,
  MAX_TRACES,
  capJourneys,
  listView,
  SLOW_MS
};
