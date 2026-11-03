/**
 * Istio traffic errors — HTTP 4xx/5xx attributed to a proxy, a route and a workload.
 *
 * ## Why this reads logs and not metrics
 *
 * The honest way to count HTTP errors in a mesh is `istio_requests_total`, and this console
 * cannot reach it. Scraping a Prometheus or an Envoy admin port through the API server needs
 * `services/proxy` or `pods/proxy`, and both grants were **deliberately refused** during the
 * RBAC audit: a proxy grant is arbitrary HTTP GET to any port of any workload, so its blast
 * radius is not the object it names. See `fleet-dashboard-rbac.yaml`.
 *
 * So the source is Envoy's own access log, read through `pods/log` — a grant this console
 * already holds and already isolates. That choice has consequences this module states rather
 * than hides:
 *
 *   - It is a **window**, not a total. Every number here describes the lines that were read,
 *     and `window` says exactly how many pods, how many lines and how far back that was.
 *     Nothing on this tab is a rate, because a tail of N lines has no denominator.
 *   - It only works when **access logging is enabled**. That is a Telemetry CR decision, so
 *     the CRs are read FIRST and their verdict is returned even when no log is read at all.
 *     An operator seeing zero errors must be able to tell "nothing is failing" from "nothing
 *     is being logged".
 *   - It only works when the log is **JSON**. Kyma's `stdout-json` provider emits one JSON
 *     object per request; Envoy's default text format is positional and regexing it into
 *     structure produces plausible wrong attribution, which is worse than none. A non-JSON
 *     line is counted as `unparsed` and never guessed at.
 *
 * ## Attribution never guesses
 *
 * An IP becomes a Pod because a Pod reports that `podIP`, a Service because it reports that
 * `clusterIP`, or an endpoint because an EndpointSlice lists that address with a `targetRef`.
 * A hostname becomes a Service because `upstream_cluster` carries its FQDN, which Envoy built
 * from the config — not because two names look alike. Anything that resolves to nothing is
 * reported as `external` or `unresolved`, and both are useful answers.
 *
 * ## Read-only, and log data is not metadata
 *
 * Access log lines are application data: a path can carry a token in a query string and a
 * `user_agent` can carry a customer's device. `redactUrl` strips credential-shaped query
 * values and control characters before anything is serialized, cached or logged, and the raw
 * line is never returned.
 */
import YAML from 'yaml';
import k8sModule from '../k8s.js';
const { list, text, METADATA_ONLY } = k8sModule;
import edge from './edge.js';
import refusalsModule from './refusals.js';
const { refusalsOf } = refusalsModule;
import podOwnerModule from './pod-owner.js';
const { ownerOf } = podOwnerModule;
import destinationNamesModule from '../destination-names.js';
const { readNameSources, finishNameIndex, nameOf, namedDestinations, isTelemetryExporter, nameFailureGroups } = destinationNamesModule;
import safeListModule from './safe-list.js';
const { safeList, requiredList, unavailableLabels, truncatedLabels } = safeListModule;

const TELEMETRY_GROUP = 'telemetry.istio.io';
const NETWORKING_GROUP = 'networking.istio.io';
const ISTIO_VERSION = 'v1';
const DISCOVERY_GROUP = 'discovery.k8s.io';
const APIGATEWAY_GROUP = 'gateway.kyma-project.io';
/*
  v2 only. `v1beta1` has been unreconciled since the Aug/Sep 2026 API Gateway release — the objects
  are still served for compatibility and their status never advances, so reading v1beta1 would hand
  back rules that look published and route nothing. A v1beta1 object converted in place answers on
  v2 with `spec.host` instead of `spec.hosts`, which `buildRouteIndex` handles.
*/
const APIRULE_VERSION = 'v2';

/** The sidecar whose log this reads. Kyma injects it under exactly this name. */
const PROXY_CONTAINER = 'istio-proxy';

/**
 * The bound on one request.
 *
 * A tab an operator opens deliberately may read more than a fleet sweep, but not without a
 * ceiling: 10 pods x 300 lines x a 512 KB cap is the worst case, and every one of those three
 * numbers is reported back so a truncated window cannot read as a complete one.
 */
const MAX_PODS = 10;
const DEFAULT_TAIL_LINES = 300;
const MAX_TAIL_LINES = 1000;
const LOG_LIMIT_BYTES = 512_000;
/** Re-reads allowed when a proxy's tail overflows LOG_LIMIT_BYTES (see readProxyLogs). */
const MAX_LOG_REFITS = 2;
const LOG_TIMEOUT_MS = 20_000;
/**
 * The fewest lines a shared read tails: the Traces tab's default. Traffic asks for 300 and is
 * handed the newest 300 of it, so opening either tab after the other finds its tail already read.
 */
const SHARED_READ_LINES = 500;

/** How many distinct request ids to keep per error group, for the log deep link. */
const SAMPLES_PER_GROUP = 3;

/**
 * Ceilings on the ingress tables.
 *
 * A window of 10000 lines can carry thousands of distinct client addresses — the live cluster this
 * was built against had 191 in 400 lines — and a payload that grows with the traffic is a payload
 * that eventually breaks the tab it feeds. Each list is cut at its ceiling and says so, the same
 * way `truncated` says so for a paged list read.
 */
const MAX_INGRESS_HOSTS = 200;
const MAX_INGRESS_CLIENTS = 200;
const MAX_LISTENER_REJECTIONS = 50;
/** Distinct paths and codes kept per host row, for the drawer. */
const PER_HOST_SAMPLES = 6;

/**
 * The shortest per-proxy log span a per-second figure may be computed over.
 *
 * `count / span` is only a rate when the span is long enough for the count to mean something. Two
 * requests half a second apart is 4/s, and it is not: it is two requests. Below this the figure is
 * suppressed and the reason is carried instead, because a suppressed number an operator can see
 * the reason for is better than a confident one they cannot check.
 */
const MIN_RATE_SPAN_SECONDS = 30;

/** Query-string keys whose VALUE is a credential. Matched loosely on purpose. */
const SECRET_QUERY_KEY = /(token|secret|password|passwd|pwd|key|code|assertion|signature|sig|auth|session|cookie|bearer|credential)/i;

/** Longest string this module will echo back from a log line. */
const MAX_FIELD = 300;

/* ------------------------------------------------------------------ redaction */

/**
 * Strip control characters and cap length.
 *
 * Control sequences matter because these strings are attacker-influenced — a `path` is
 * whatever was requested — and a terminal escape or a stray `\r` rendered into an operator's
 * console is an injection surface, not a cosmetic issue. Everything outside printable ASCII
 * and common Unicode is dropped rather than escaped, because this is a display string and
 * nothing downstream needs to round-trip it.
 */
function clean(value) {
  if (value === null || value === undefined) return null;
  // A code-point walk rather than a character class: writing control characters into a regex
  // literal means writing them into this file, and a source file carrying a raw ESC or a raw
  // U+2028 is its own hazard. Comparing numbers keeps the source printable.
  let out = '';
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    // U+2028/29 are line terminators to a JS parser, so they can break a consumer that
    // interpolates this string; U+200b-200f and U+2066-2069 are invisible and reorder text.
    const invisible =
      cp === 0x2028 ||
      cp === 0x2029 ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x2066 && cp <= 0x2069);
    if (!control && !invisible) out += ch;
  }
  const s = out.trim();
  if (!s) return null;
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

/**
 * A request target with credential-shaped query values replaced.
 *
 * Keeps the key, drops the value: `?code=REDACTED` still tells an operator that an OAuth
 * callback failed, which is most of why they opened this tab, while `?code=4/0AX4…` is a
 * live authorization code sitting in a dashboard. The path itself is kept in full — it is
 * the route, and redacting it would remove the finding.
 */
function redactUrl(raw) {
  const value = clean(raw);
  if (!value) return null;
  const cut = value.indexOf('?');
  if (cut === -1) return value;
  const path = value.slice(0, cut);
  const query = value.slice(cut + 1);
  const parts = query.split('&').map(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const key = pair.slice(0, eq);
    return SECRET_QUERY_KEY.test(key) ? `${key}=REDACTED` : pair;
  });
  return `${path}?${parts.join('&')}`;
}

/* ------------------------------------------------------- mesh access-log providers */

/**
 * A Telemetry CR names a provider; it does not say what that provider DOES.
 *
 * `spec.accessLogging[].providers[].name` is a reference into `meshConfig.extensionProviders`,
 * which lives in the `istio` ConfigMap. Two of the four providers Kyma ships are access-log
 * providers and they could not be more different in what they mean for this tab:
 *
 *   stdout-json   envoyFileAccessLog, path /dev/stdout    -> the sidecar writes it, `pods/log`
 *                                                            reads it, this tab works
 *   kyma-logs     envoyOtelAls, telemetry-otlp-logs:4317  -> the sidecar streams it to the
 *                                                            OTLP gateway and writes NOTHING
 *                                                            to stdout
 *
 * That difference is the whole reason this lookup exists. Before it, the verdict said `on` for
 * both and the tab tailed stdout either way — so a mesh switched to `kyma-logs` produced a
 * screen of confident zeros: "0 server errors", "No 4xx, 5xx or unanswered connection in the
 * window that was read". Nothing was failing to be read; there was simply nothing there, and
 * the tab could not tell the operator which of the two it was seeing. Same family as
 * `safe-list`'s 403-as-zero, one layer up.
 *
 * Resolution failures are never guessed. A provider absent from the mesh config, a mesh config
 * that could not be read, an implementation key nobody here recognises — each reports itself
 * and leaves `readable` null, which callers must treat as "read the log and find out", never
 * as "skip it".
 */
const MESH_CONFIGMAP = { namespace: 'istio-system', name: 'istio', key: 'mesh' };

/**
 * Access-log implementations, by their `extensionProviders` key.
 *
 * `envoyFileAccessLog` is the only one that lands anywhere `pods/log` can reach, and only when
 * its path is a standard stream. Everything else is a network sink: the bytes leave the proxy
 * over gRPC and never touch the container's stdout.
 */
const ACCESS_LOG_IMPLEMENTATIONS = {
  envoyFileAccessLog: 'file',
  envoyOtelAls: 'otlp',
  envoyHttpAls: 'grpc',
  envoyTcpAls: 'grpc'
};

/** Implementation keys that are real providers but not access-log ones. Named, not guessed. */
const NON_ACCESS_LOG_IMPLEMENTATIONS = new Set([
  'opentelemetry', 'prometheus', 'zipkin', 'datadog', 'skywalking', 'lightstep', 'stackdriver'
]);

/** Paths `pods/log` can actually return. Envoy's default when `path` is omitted is stdout. */
const READABLE_LOG_PATHS = new Set(['/dev/stdout', '/dev/stderr']);

/**
 * Which field vocabulary a file provider's JSON will use.
 *
 * Kyma's two log formats do not share a single key: `stdout-json` emits Envoy's own
 * `response_code`, while `kyma-logs` emits the OpenTelemetry semantic convention
 * `http.response.status_code`. `logFormat.labels` is arbitrary, so an operator can put either
 * set behind either provider — which is why this is sniffed from the labels actually declared
 * rather than assumed from the provider's name.
 */
function fieldVocabulary(labels) {
  if (!labels || typeof labels !== 'object') return null;
  const keys = Object.keys(labels);
  if (!keys.length) return null;
  if (keys.some(k => OTEL_FIELD_MARKERS.has(k))) return 'otel';
  if (keys.some(k => ENVOY_FIELD_MARKERS.has(k))) return 'envoy';
  return 'custom';
}

const OTEL_FIELD_MARKERS = new Set([
  'http.response.status_code', 'http.request.method', 'url.path', 'server.address'
]);
const ENVOY_FIELD_MARKERS = new Set(['response_code', 'method', 'path', 'authority']);

/**
 * One `extensionProviders` entry into what it means here.
 *
 * `readable` is deliberately three-valued. `false` is a positive finding — we resolved the
 * provider and it demonstrably ships elsewhere — while `null` means we could not tell, and the
 * two must not collapse, because only `false` is safe to act on by skipping the log read.
 */
function classifyProvider(entry) {
  const name = clean(entry && entry.name);
  if (!name) return null;

  const implKey = Object.keys(entry).find(k => k !== 'name' && ACCESS_LOG_IMPLEMENTATIONS[k]);
  if (implKey) {
    const impl = entry[implKey] || {};
    const kind = ACCESS_LOG_IMPLEMENTATIONS[implKey];
    if (kind === 'file') {
      // Envoy defaults an omitted `path` to stdout, so absent is readable, not unknown.
      const path = clean(impl.path) || '/dev/stdout';
      return {
        name,
        kind,
        implementation: implKey,
        readable: READABLE_LOG_PATHS.has(path),
        destination: path,
        fields: fieldVocabulary(impl.logFormat && impl.logFormat.labels)
      };
    }
    const service = clean(impl.service);
    const port = Number.isFinite(Number(impl.port)) ? Number(impl.port) : null;
    return {
      name,
      kind,
      implementation: implKey,
      readable: false,
      destination: service ? (port ? `${service}:${port}` : service) : null,
      fields: fieldVocabulary(impl.logFormat && impl.logFormat.labels)
    };
  }

  const otherKey = Object.keys(entry).find(k => k !== 'name' && NON_ACCESS_LOG_IMPLEMENTATIONS.has(k));
  if (otherKey) {
    return { name, kind: 'not-access-log', implementation: otherKey, readable: false, destination: null, fields: null };
  }

  // An implementation this build has never heard of. Saying "unreadable" would be a guess that
  // silently hides traffic; saying "readable" would be a guess that reports a false zero.
  return { name, kind: 'unknown', implementation: Object.keys(entry).find(k => k !== 'name') || null, readable: null, destination: null, fields: null };
}

/**
 * The mesh's access-log providers, by name, from the `istio` ConfigMap.
 *
 * Read as a one-item list with a field selector rather than a GET, so it flows through
 * `safeList` and inherits the same unavailable-vs-true-zero split as every other read here.
 */
function meshProviders(configmaps) {
  if (!configmaps || configmaps.unavailable) {
    return {
      byName: Object.create(null),
      unavailable: true,
      reason: (configmaps && configmaps.reason) || 'UPSTREAM',
      detail: (configmaps && configmaps.detail) || null
    };
  }
  const cm = (configmaps.items || []).find(c => c && c.metadata && c.metadata.name === MESH_CONFIGMAP.name);
  const raw = cm && cm.data && cm.data[MESH_CONFIGMAP.key];
  if (!raw) {
    // The ConfigMap read succeeded and the key is not there. A true zero, not an outage — but
    // it still means no provider can be resolved, so callers must not skip the log read.
    return { byName: Object.create(null), unavailable: false, reason: null, detail: null, absent: true };
  }
  let mesh;
  try {
    mesh = YAML.parse(String(raw));
  } catch (err) {
    return { byName: Object.create(null), unavailable: true, reason: 'UPSTREAM', detail: clean(err && err.message) };
  }
  /*
    `Object.create(null)`, not `{}`: provider names come from cluster YAML, and a lookup of
    `mesh.byName['constructor']` against a plain object returns `Object.prototype.constructor` —
    a truthy non-provider that `accessLogVerdict` would then treat as a resolved entry with
    `readable: undefined`, skipping the log read on a provider that does not exist.

    `Array.isArray`, not `|| []`: `extensionProviders: {}` is valid YAML, parses to a truthy
    non-iterable, and `for...of` throws a TypeError from OUTSIDE the parse try — which escaped
    `collect` entirely and 500'd the whole tab, losing the pod and service reads that succeeded.
    Every other failure in this module degrades; this one aborted, on untrusted input.
  */
  const byName = Object.create(null);
  const entries = Array.isArray(mesh && mesh.extensionProviders) ? mesh.extensionProviders : [];
  for (const entry of entries) {
    const resolved = classifyProvider(entry);
    if (resolved) byName[resolved.name] = resolved;
  }
  return { byName, unavailable: false, reason: null, detail: null, absent: false };
}

/* ------------------------------------------------------------------ telemetry verdict */

/**
 * Whether Envoy is writing access logs at all, where that was decided, and — since the mesh can
 * ship them straight to an OTLP gateway — whether any of it lands where this tab can read it.
 *
 * A Telemetry CR in the mesh root namespace (`istio-system`) applies mesh-wide; one in any
 * other namespace applies to that namespace. `spec.accessLogging` with no `disabled: true`
 * entry and at least one provider is what turns the log on. Reported as a verdict object
 * rather than a boolean so the UI can name the CR that decided it.
 */
function accessLogVerdict(telemetries, mesh = null, rootNamespace = 'istio-system') {
  if (telemetries.unavailable) {
    return {
      state: 'unknown',
      reason: telemetries.reason,
      detail: telemetries.detail,
      providers: [],
      // Same shape on every branch, so the UI never has to test for the field's existence.
      // `readable: null` is "we could not tell", which is the only honest answer when the CRs
      // that decide it could not be read.
      providerDetail: [],
      recordedElsewhere: false,
      readable: null,
      unresolvedProviders: [],
      meshUnavailable: Boolean(mesh && mesh.unavailable),
      decidedBy: [],
      why: 'The Telemetry CRs could not be read, so whether Envoy writes an access log is unknown. The lines below, if any, are whatever the proxies happened to emit.'
    };
  }

  const enabling = [];
  const disabling = [];
  for (const t of telemetries.items) {
    const entries = (t.spec && t.spec.accessLogging) || [];
    if (!entries.length) continue;
    const ref = {
      name: t.metadata.name,
      namespace: t.metadata.namespace,
      scope: t.metadata.namespace === rootNamespace ? 'mesh' : 'namespace',
      providers: entries.flatMap(e => (e.providers || []).map(p => p.name).filter(Boolean)),
      // A selector means it does not apply to every workload in its scope, and saying "on"
      // without saying that would overstate the coverage.
      selector: t.spec.selector ? t.spec.selector.matchLabels || {} : null
    };
    if (entries.some(e => e.disabled === true)) disabling.push(ref);
    else enabling.push(ref);
  }

  if (!enabling.length) {
    return {
      state: 'off',
      reason: null,
      detail: null,
      providers: [],
      providerDetail: [],
      recordedElsewhere: false,
      // Nothing is written, so nothing is readable. `state` is what distinguishes this from
      // "written, but streamed somewhere this tab cannot follow".
      readable: false,
      unresolvedProviders: [],
      meshUnavailable: Boolean(mesh && mesh.unavailable),
      decidedBy: disabling,
      why: disabling.length
        ? 'Every Telemetry CR that mentions access logging disables it, so Envoy writes no request lines and this tab has nothing to read.'
        : 'No Telemetry CR enables access logging, so Envoy writes no request lines. This tab reads Envoy’s access log, so it cannot show traffic errors until a Telemetry CR turns it on.'
    };
  }

  const providers = [...new Set(enabling.flatMap(e => e.providers))];
  const meshWide = enabling.some(e => e.scope === 'mesh' && !e.selector);

  // An enabling entry that names NO provider falls back to Istio's default file access log,
  // which goes to stdout — so it counts as readable rather than as an unresolved name.
  const usesDefaultProvider = enabling.some(e => !e.providers.length);
  const resolved = providers.map(name => (mesh && mesh.byName[name]) || null);
  const providerDetail = providers.map((name, i) => resolved[i] || {
    name,
    kind: 'unresolved',
    implementation: null,
    readable: null,
    destination: null,
    fields: null
  });
  const unresolvedProviders = providerDetail.filter(p => p.kind === 'unresolved').map(p => p.name);

  // Three-valued, and the middle value is the one that matters. `false` requires that every
  // named provider resolved and none of them writes to a stream `pods/log` can read — only
  // then is a zero on this tab a statement about the mesh rather than about the reader.
  const anyReadable = usesDefaultProvider || providerDetail.some(p => p.readable === true);
  const anyUnknown = providerDetail.some(p => p.readable === null);
  const readable = anyReadable ? true : (anyUnknown ? null : false);

  const shipsTo = providerDetail
    .filter(p => p.readable === false && p.destination)
    .map(p => `${p.name} → ${p.destination}`);

  /*
    `why` composes; it does not switch.

    The first draft replaced the whole sentence when readability was in doubt, and the scope
    clause — "on for some workloads only, so a workload missing from this tab may simply not be
    logging" — vanished on every cluster whose mesh ConfigMap could not be read. Two independent
    facts about the same verdict: WHICH workloads log, and WHETHER their log lands where this
    tab reads. Losing either one to the other is how a caveat starts hiding a finding.
  */
  const base = meshWide
    ? `Access logging is on mesh-wide via provider ${providers.join(', ') || 'unnamed'}.`
    : 'Access logging is on for some workloads only (namespace- or selector-scoped), so a workload missing from this tab may simply not be logging.';

  let caveat = '';
  if (readable === false) {
    /*
      Two different reasons produce `readable: false`, and saying the wrong one is worse than
      saying nothing. A network sink (`envoyOtelAls`) means the requests ARE recorded, just not
      here — "query the destination" is good advice. A `not-access-log` provider (naming
      `kyma-traces` under `accessLogging`, say) means nothing is recorded ANYWHERE and there is
      no destination to query; `destination` is null, so the old wording pointed the operator at
      an em-dash and told them their requests were safe.
    */
    const misuse = providerDetail.filter(p => p.kind === 'not-access-log');
    const sinks = providerDetail.filter(p => p.kind !== 'not-access-log');
    if (misuse.length && !sinks.length) {
      caveat = ` But ${misuse.map(p => p.name).join(', ')} ${misuse.length === 1 ? 'is' : 'are'} declared for tracing or metrics, not for access logging, so Envoy writes no request line at all — nothing is being recorded here or anywhere else. Name an access-log provider such as stdout-json.`;
    } else {
      const also = misuse.length
        ? ` (${misuse.map(p => p.name).join(', ')} ${misuse.length === 1 ? 'is' : 'are'} not an access-log provider at all, so ${misuse.length === 1 ? 'it records' : 'they record'} nothing)`
        : '';
      caveat = ` But ${sinks.length === 1 ? 'that provider streams' : 'those providers stream'} the log off the proxy instead of writing it to stdout${shipsTo.length ? ` (${shipsTo.join('; ')})` : ''}${also}. This tab reads the sidecar's stdout through pods/log, so it cannot see these requests — a zero here is not a statement that nothing is failing. Query the destination, or name a stdout provider such as stdout-json alongside it.`;
    }
  } else if (readable === null) {
    /*
      When the mesh ConfigMap itself could not be read, EVERY provider lands in
      `unresolvedProviders` — but "kyma-logs is not declared in the mesh config" is then a claim
      about a file nobody opened. The UI printed that sentence directly above its own "the mesh
      ConfigMap could not be read" note, contradicting itself on the one cluster shape where the
      operator most needs the explanation.
    */
    const meshUnread = Boolean(mesh && (mesh.unavailable || mesh.absent));
    const which = meshUnread
      ? `the mesh ConfigMap ${MESH_CONFIGMAP.namespace}/${MESH_CONFIGMAP.name} could not be read, so no provider could be resolved`
      : unresolvedProviders.length
        ? `${unresolvedProviders.join(', ')} ${unresolvedProviders.length === 1 ? 'is' : 'are'} not declared in the mesh config`
        : 'this build does not recognise how it is implemented';
    caveat = ` Whether that reaches the stdout this tab reads is unknown, because ${which}, so the window below is whatever the proxies actually emitted.`;
  }

  return {
    state: 'on',
    reason: null,
    detail: null,
    providers,
    providerDetail,
    readable,
    unresolvedProviders,
    /*
      Is the log being written SOMEWHERE this tab cannot follow, or nowhere at all?
      Both give `readable: false`, and the UI must not tell an operator "your requests are being
      recorded, open the destination" when every named provider is a tracing sink that records
      nothing. Only a provider with a real destination counts as recorded elsewhere.
    */
    recordedElsewhere: providerDetail.some(p => p.readable === false && p.kind !== 'not-access-log' && p.destination),
    meshUnavailable: Boolean(mesh && mesh.unavailable),
    decidedBy: enabling.concat(disabling),
    scope: meshWide ? 'mesh' : 'partial',
    why: base + caveat
  };
}

/* ------------------------------------------------------------------ address resolution */

/**
 * An index from address to the object that reports it.
 *
 * Built once and consulted per log line, because a 300-line window across ten pods asks the
 * same question thousands of times. Every entry records WHICH field proved it, so a resolved
 * row can show its evidence the way the Helm graph does.
 */
function buildIndex({ pods, services, endpointslices, nodes, gateways }) {
  const byIp = new Map();
  const byFqdn = new Map();

  if (!pods.unavailable) {
    for (const p of pods.items) {
      const ip = p.status && p.status.podIP;
      if (!ip) continue;
      byIp.set(ip, {
        kind: 'Pod',
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        node: (p.spec && p.spec.nodeName) || null,
        evidence: 'status.podIP'
      });
    }
  }

  if (!services.unavailable) {
    for (const s of services.items) {
      const fqdn = `${s.metadata.name}.${s.metadata.namespace}.svc.cluster.local`;
      byFqdn.set(fqdn, {
        kind: 'Service',
        name: s.metadata.name,
        namespace: s.metadata.namespace,
        evidence: 'upstream_cluster FQDN matches this Service’s name and namespace'
      });
      const ip = s.spec && s.spec.clusterIP;
      // A headless Service has clusterIP "None", which is not an address.
      if (ip && ip !== 'None' && !byIp.has(ip)) {
        byIp.set(ip, {
          kind: 'Service',
          name: s.metadata.name,
          namespace: s.metadata.namespace,
          evidence: 'spec.clusterIP'
        });
      }
    }
  }

  // EndpointSlices resolve an address a Pod list could not: one behind a Service whose pod
  // this reader cannot see, or one that has already been replaced.
  if (!endpointslices.unavailable) {
    for (const slice of endpointslices.items) {
      const owner = ((slice.metadata.labels || {})['kubernetes.io/service-name']) || null;
      for (const ep of slice.endpoints || []) {
        for (const address of ep.addresses || []) {
          if (byIp.has(address)) continue;
          const ref = ep.targetRef || {};
          byIp.set(address, {
            kind: ref.kind || 'Endpoint',
            name: ref.name || address,
            namespace: ref.namespace || slice.metadata.namespace,
            service: owner,
            evidence: `EndpointSlice ${slice.metadata.name} lists this address`
          });
        }
      }
    }
  }

  if (!nodes.unavailable) {
    for (const n of nodes.items) {
      for (const a of (n.status && n.status.addresses) || []) {
        if (!a.address || byIp.has(a.address)) continue;
        byIp.set(a.address, {
          kind: 'Node',
          name: n.metadata.name,
          namespace: null,
          evidence: `status.addresses[type=${a.type}]`
        });
      }
    }
  }

  return { byIp, byFqdn, gatewayHosts: gatewayHostsOf(gateways) };
}

/*
  Gateways resolve a HOST, not an address: an authority the log reports can be matched to the
  Gateway that admits it, which is what tells an operator where a 404 was routed.
*/
function gatewayHostsOf(gateways) {
  const gatewayHosts = [];
  if (!gateways || gateways.unavailable) return gatewayHosts;
  for (const g of gateways.items || []) {
    for (const server of (g.spec && g.spec.servers) || []) {
      for (const host of server.hosts || []) {
        gatewayHosts.push({
          host,
          name: g.metadata.name,
          namespace: g.metadata.namespace,
          port: (server.port && server.port.number) || null,
          evidence: `Gateway ${g.metadata.namespace}/${g.metadata.name} server host ${host}`
        });
      }
    }
  }
  return gatewayHosts;
}

/**
 * The egress registry: who an address is (`names`), which routes publish which hosts to which
 * Services (`routes`), and which hosts the Gateways admit (`gatewayHosts`). Every read is a
 * safeList, so a refusal is `unavailable` in `reads` and the collector folds it into its own
 * completeness. Paths match the collectors' own reads, so the k8s list cache serves either.
 */
async function readRegistry({ listFn, baseCtx }) {
  const [services, gateways, virtualservices, apirules, nameReads] = await Promise.all([
    safeList(listFn, baseCtx, '/api/v1/services?limit=2000', 'services'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/gateways`, 'istio-gateways'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/virtualservices?limit=2000`, 'virtualservices'),
    safeList(listFn, baseCtx, `/apis/${APIGATEWAY_GROUP}/${APIRULE_VERSION}/apirules?limit=2000`, 'apirules'),
    readNameSources({ listFn, baseCtx, safeList, metadataAccept: METADATA_ONLY })
  ]);
  return {
    names: await finishNameIndex(nameReads, services),
    routes: buildRouteIndex({ virtualservices, apirules }),
    gatewayHosts: gatewayHostsOf(gateways),
    reads: { services, gateways, virtualservices, apirules, nameReads }
  };
}

/** The registry through the router's share when there is one (credential-scoped, 60s), else read now. */
function registryOf({ registryShare = null, listFn, baseCtx, maxAgeMs }) {
  const build = () => readRegistry({ listFn, baseCtx });
  return registryShare ? registryShare.get(baseCtx, build, maxAgeMs === undefined ? undefined : { maxAgeMs }) : build();
}

/** Split `IP:port`, tolerating IPv6 in brackets and a bare address. */
function splitHostPort(value) {
  const s = clean(value);
  if (!s) return { ip: null, port: null };
  const v6 = /^\[(.+)\]:(\d+)$/.exec(s);
  if (v6) return { ip: v6[1], port: Number(v6[2]) };
  const cut = s.lastIndexOf(':');
  if (cut === -1) return { ip: s, port: null };
  const port = Number(s.slice(cut + 1));
  return { ip: s.slice(0, cut), port: Number.isFinite(port) ? port : null };
}

/**
 * Resolve one address, saying plainly when it resolves to nothing.
 *
 * `external` and `unresolved` are different answers and both are wanted: a public client IP
 * on an ingress gateway is expected and healthy, while an in-cluster address that matches no
 * Pod, Service, endpoint or Node means the reader is missing a namespace or the object is
 * already gone.
 */
function resolveAddress(index, raw) {
  const { ip, port } = splitHostPort(raw);
  if (!ip) return null;
  const hit = index.byIp.get(ip);
  if (hit) return { ip, port, ...hit };
  return {
    ip,
    port,
    kind: isPrivate(ip) ? 'unresolved' : 'external',
    name: ip,
    namespace: null,
    evidence: isPrivate(ip)
      ? 'No Pod, Service, EndpointSlice or Node reports this address — it may be in a namespace this reader cannot list, or already gone.'
      : 'Not a cluster address: no Pod, Service or Node reports it, and it is outside the private ranges.'
  };
}

/** RFC1918 + the CGNAT range Gardener shoots use for pods, plus IPv6 ULA. */
function isPrivate(ip) {
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^f[cd]/i.test(ip) || ip === '::1') return true;
  return false;
}

/**
 * `outbound|8080|subset|reviews.default.svc.cluster.local` — Envoy's own name for where it
 * sent the request. Parsed rather than displayed raw because the FQDN inside it is the one
 * field that names a Service by evidence.
 */
function parseUpstreamCluster(raw, index) {
  const value = clean(raw);
  if (!value) return null;
  const trimmed = value.replace(/;+$/, '');
  const parts = trimmed.split('|');
  if (parts.length < 4) {
    return { raw: trimmed, direction: null, port: null, subset: null, fqdn: null, service: null };
  }
  const [direction, port, subset, fqdn] = parts;
  return {
    raw: trimmed,
    direction: direction || null,
    port: Number(port) || null,
    subset: subset || null,
    fqdn: fqdn || null,
    service: fqdn ? index.byFqdn.get(fqdn) || null : null
  };
}

/** The Gateway whose server host admits this authority, by longest wildcard match. */
function matchGateway(index, authority) {
  const host = (clean(authority) || '').split(':')[0].toLowerCase();
  if (!host) return null;
  let best = null;
  for (const g of index.gatewayHosts) {
    const pattern = g.host.toLowerCase();
    const bare = pattern.includes('/') ? pattern.slice(pattern.indexOf('/') + 1) : pattern;
    const ok = bare === '*' || bare === host || (bare.startsWith('*.') && host.endsWith(bare.slice(1)));
    if (!ok) continue;
    if (!best || bare.length > best.matched.length) best = { ...g, matched: bare };
  }
  return best;
}

/* ------------------------------------------------------------------- host grouping */

/**
 * Which domains are "ours", derived from the cluster rather than written down.
 *
 * The temptation here is a literal — bucket `*.apple.com` as corporate, `*.kyma.ondemand.com` as
 * platform, done. It is wrong twice over. This console bakes in no cluster identity anywhere (see
 * `no-fixture-path.test.js`), and the Kyma domain is *per shoot*: the cluster this was built
 * against serves `*.c-9d0a141.kyma.ondemand.com`, so a literal `*.kyma.ondemand.com` matches every
 * Kyma cluster in the estate and is nobody's actual domain. Both literals would ship green and be
 * wrong on the next cluster onboarded.
 *
 * So the buckets come from evidence:
 *
 *   declared   an Istio `Gateway` in this cluster declares a server host that admits it
 *   infra      it carries one of the named platform markers below — health probes and tunnels
 *   address    the Host header is a bare IP: something addressed the load balancer directly
 *   corporate  it ends in a suffix the operator configured, and only then
 *   none       Envoy recorded no authority at all, which is every TCP record
 *   other      none of the above — an unrecognised name arriving at this cluster's ingress
 *
 * `corporate` is the one bucket a cluster cannot prove for itself, so it is configuration and not
 * a guess: `FLEET_CORPORATE_DOMAIN_SUFFIXES`, comma-separated, empty by default. With nothing
 * configured the bucket simply never fills, which is the correct behaviour for a fleet whose
 * domains this deployment has not been told about.
 */

/**
 * Hostname markers for cluster plumbing rather than a published service.
 *
 * A named, documented list — not a heuristic. Each entry is a host a stock Kyma cluster serves for
 * its own health checking or tunnelling, and the reason the distinction earns its place is volume:
 * on the live cluster 140 of 400 ingress lines were `healthz.`, so a headline "sampled requests"
 * that pools them is 35% probe traffic and an error share computed over them is meaningless.
 */
const INFRA_HOST_PREFIXES = [
  'healthz.',        // Kyma's own ingress liveness host
  'healthcheck.',    // connectivity-proxy tunnel health
  'cp.',             // connectivity-proxy tunnel
  'kiali.',
  'grafana.',
  'tracing.',
  'jaeger.'
];
const INFRA_HOST_SUBSTRINGS = ['connectivity-proxy'];
const INFRA_HOST_EXACT = new Set(['localhost', 'kubernetes.default.svc']);

/** The bucket key for a record that carried no Host header at all. Printable on purpose. */
const NO_HOST_KEY = '(no host header)';

/**
 * A comma-separated suffix list into a normalised one.
 *
 * Takes the raw string rather than reading `process.env` itself, so the classifier stays pure and
 * the test can state the configuration instead of mutating the environment. A leading `*.` is
 * accepted because that is how an operator writes a domain, and a bare label with no dot is
 * rejected: `com` as a "corporate suffix" would bucket most of the internet.
 */
function corporateSuffixes(raw) {
  const seen = new Set();
  for (const part of String(raw || '').split(',')) {
    const cleaned = clean(part);
    if (!cleaned) continue;
    const suffix = cleaned.replace(/^\*?\./, '').toLowerCase();
    if (!suffix.includes('.')) continue;
    seen.add(suffix);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

/**
 * The authority, lowercased and with a trailing numeric port removed.
 *
 * The port is dropped because `example.com` and `example.com:80` are one host asked for twice, and
 * splitting them doubles every row in the table.
 *
 * It is dropped only when the string is shaped like `host:port` — a bracketed literal, or exactly
 * one colon with digits after it. "Numeric after the last colon" is not enough on its own:
 * `2001:db8::1` ends in a numeric group, so that test turned an unbracketed IPv6 address into
 * `2001:db8:`, a key that groups with nothing and prints as a truncated address.
 */
function hostKeyOf(authority) {
  const s = clean(authority);
  if (!s) return null;
  const v6 = /^\[(.+)\](?::\d+)?$/.exec(s);
  if (v6) return `[${v6[1].toLowerCase()}]`;
  const cut = s.indexOf(':');
  if (cut > 0 && cut === s.lastIndexOf(':') && /^\d+$/.test(s.slice(cut + 1))) return s.slice(0, cut).toLowerCase();
  return s.toLowerCase();
}

/** A Host header that is an address rather than a name — somebody dialled the load balancer. */
function isBareAddress(host) {
  if (!host) return false;
  if (/^\[.+\]$/.test(host)) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isInfraHost(host) {
  if (INFRA_HOST_EXACT.has(host)) return true;
  if (INFRA_HOST_PREFIXES.some(p => host.startsWith(p))) return true;
  return INFRA_HOST_SUBSTRINGS.some(s => host.includes(s));
}

/**
 * One host into its bucket, with the evidence that put it there.
 *
 * Precedence is deliberate and not alphabetical. `infra` beats `declared` because a health-probe
 * host is also admitted by the wildcard Gateway, and calling it a declared service hides exactly
 * the traffic an operator wants excluded. `corporate` beats `infra` because an operator who
 * configured a suffix has said that domain matters to them.
 */
function classifyHost(host, { gatewayHosts = [], corporate = [] } = {}) {
  if (!host) return { group: 'none', declaredBy: null, matchedSuffix: null };
  const h = host.toLowerCase();
  const declaredBy = matchGateway({ gatewayHosts }, h);
  if (isBareAddress(h)) return { group: 'address', declaredBy, matchedSuffix: null };
  const suffix = corporate.find(s => h === s || h.endsWith(`.${s}`)) || null;
  if (suffix) return { group: 'corporate', declaredBy, matchedSuffix: suffix };
  if (isInfraHost(h)) return { group: 'infra', declaredBy, matchedSuffix: null };
  if (declaredBy) return { group: 'declared', declaredBy, matchedSuffix: null };
  return { group: 'other', declaredBy: null, matchedSuffix: null };
}

/* ------------------------------------------------------------------ route resolution */

/**
 * Which object publishes a host — the answer to "who is supposed to be serving this?".
 *
 * Built from the two objects that declare an ingress host in Kyma: an Istio `VirtualService` and an
 * API Gateway `APIRule`. Kyma's API Gateway controller *writes* the VirtualService behind an
 * APIRule, so a host commonly resolves to both, and both are reported rather than one being
 * preferred — an operator debugging a 404 wants to know the APIRule exists AND that a
 * VirtualService was generated from it.
 *
 * Read as objects, never as controller logs. A controller's log is free-form operator prose; its
 * objects are a contract, and `spec.hosts` is the field that names the host by declaration rather
 * than by resemblance.
 */
/** `srv`, `srv.shop`, `srv.shop.svc.cluster.local` → a Service reference; the route's namespace is the default. */
function serviceRefOf(host, namespace) {
  const h = clean(host);
  if (!h) return null;
  const parts = h.toLowerCase().split('.');
  return { name: parts[0], namespace: parts.length > 1 ? parts[1] : namespace };
}

const pushRef = (out, ref) => {
  if (ref && !out.some(o => o.name === ref.name && o.namespace === ref.namespace)) out.push(ref);
};

/** The Services a VirtualService routes to, across its http, tcp and tls rules. */
function vsBackends(vs) {
  const out = [];
  for (const kind of ['http', 'tcp', 'tls']) {
    for (const rule of (vs.spec && vs.spec[kind]) || []) {
      for (const r of (rule && rule.route) || []) pushRef(out, serviceRefOf(r && r.destination && r.destination.host, vs.metadata.namespace));
    }
  }
  return out;
}

/** An APIRule v2's Service, and each rule's own override. */
function apiRuleBackends(rule) {
  const spec = rule.spec || {};
  const out = [];
  for (const s of [spec.service, ...(spec.rules || []).map(r => r && r.service)]) {
    if (!s || !s.name) continue;
    pushRef(out, { name: String(s.name).toLowerCase(), namespace: s.namespace || rule.metadata.namespace });
  }
  return out;
}

function buildRouteIndex({ virtualservices, apirules }) {
  const entries = [];

  if (virtualservices && !virtualservices.unavailable) {
    for (const vs of virtualservices.items || []) {
      if (!vs || !vs.metadata) continue;
      const backends = vsBackends(vs);
      for (const host of (vs.spec && vs.spec.hosts) || []) {
        const h = clean(host);
        if (!h) continue;
        entries.push({
          host: h.toLowerCase(),
          kind: 'VirtualService',
          name: vs.metadata.name,
          namespace: vs.metadata.namespace,
          evidence: `VirtualService ${vs.metadata.namespace}/${vs.metadata.name} lists ${h} in spec.hosts`,
          backends
        });
      }
    }
  }

  if (apirules && !apirules.unavailable) {
    for (const rule of apirules.items || []) {
      if (!rule || !rule.metadata) continue;
      const spec = rule.spec || {};
      // v2 carries `spec.hosts`; a v1beta1 object converted in place still answers on `spec.host`.
      const hosts = Array.isArray(spec.hosts) ? spec.hosts : spec.host ? [spec.host] : [];
      const backends = apiRuleBackends(rule);
      for (const host of hosts) {
        const h = clean(host);
        if (!h) continue;
        entries.push({
          host: h.toLowerCase(),
          kind: 'APIRule',
          name: rule.metadata.name,
          namespace: rule.metadata.namespace,
          evidence: `APIRule ${rule.metadata.namespace}/${rule.metadata.name} publishes ${h}`,
          backends
        });
      }
    }
  }

  return entries;
}

/** The pod selectors of every Service a route sends to. A Service with no selector backs no pod. */
function routeBackendSelectors(routes, services) {
  if (!services || services.unavailable) return [];
  const byKey = new Map((services.items || []).filter(s => s && s.metadata).map(s => [`${s.metadata.namespace}/${s.metadata.name}`, s]));
  const out = new Map();
  for (const r of routes || []) {
    for (const b of r.backends || []) {
      const s = byKey.get(`${b.namespace}/${b.name}`);
      const selector = s && s.spec && s.spec.selector;
      if (selector && Object.keys(selector).length) out.set(`${b.namespace}/${b.name}`, { namespace: b.namespace, selector });
    }
  }
  return [...out.values()];
}

/** Every declared route admitting this host, most specific first. Wildcards match one way only. */
function matchRoutes(routes, host, limit = 4) {
  const h = (clean(host) || '').split(':')[0].toLowerCase();
  if (!h) return [];
  const hits = [];
  for (const r of routes) {
    const p = r.host;
    const ok = p === '*' || p === h || (p.startsWith('*.') && h.endsWith(p.slice(1)));
    if (ok) hits.push({ kind: r.kind, name: r.name, namespace: r.namespace, evidence: r.evidence, matched: p });
  }
  return hits
    .sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        a.kind.localeCompare(b.kind) ||
        `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
    )
    .slice(0, limit);
}

/* ------------------------------------------------------------- Envoy response flags */

/**
 * Every `%RESPONSE_FLAGS%` code Envoy emits, in an operator's words.
 *
 * The tab shipped with six of these in one tooltip, and six is the wrong number in a specific way:
 * the flag an operator most often meets on a Kyma ingress is `NR`, and the four-code version
 * decoded it as "no route matched — check the VirtualService". On the live cluster every one of the
 * 114 `NR` lines was `response_code: 0` with `response_code_details: filter_chain_not_found`, which
 * is the **TCP** half of `NR`: no listener accepted the connection, so nothing was routed because
 * nothing was admitted. Sending an operator to look at their VirtualService for that is sending
 * them to the wrong object, so `decodeResponseFlag` resolves it against the code details.
 *
 * `Object.create(null)`, because the key comes from cluster data: a log line carrying
 * `response_flags: "constructor"` against a plain object would return a function and decode as a
 * known flag.
 */
const RESPONSE_FLAGS = Object.assign(Object.create(null), {
  UH: { name: 'NoHealthyUpstream', meaning: 'No healthy host was left in the upstream cluster, so Envoy answered 503 itself. The upstream pods are failing their health checks, or there are none.' },
  UF: { name: 'UpstreamConnectionFailure', meaning: 'Envoy could not open a connection to the upstream and answered 503 itself. The request never reached the workload.' },
  UO: { name: 'UpstreamOverflow', meaning: 'A circuit breaker was open, so the request was shed with 503 before it was sent.' },
  NR: { name: 'NoRouteFound', meaning: 'No route matched the request — check the VirtualService or APIRule host and path.' },
  URX: { name: 'UpstreamRetryLimitExceeded', meaning: 'The retry limit (HTTP) or the maximum connect attempts (TCP) was reached.' },
  NC: { name: 'NoClusterFound', meaning: 'The route named an upstream cluster that does not exist in this proxy’s configuration.' },
  DT: { name: 'DurationTimeout', meaning: 'The request or connection outlived its configured maximum duration.' },
  DC: { name: 'DownstreamConnectionTermination', meaning: 'The client hung up before Envoy finished — a cancelled request, a closed tab, or a client timeout shorter than the server’s.' },
  LH: { name: 'FailedLocalHealthCheck', meaning: 'The local service failed its health check request, so Envoy answered 503.' },
  UT: { name: 'UpstreamRequestTimeout', meaning: 'The upstream did not answer in time, so Envoy answered 504. HTTP only — it is not a TCP flag.' },
  LR: { name: 'LocalReset', meaning: 'Envoy reset the connection locally and answered 503.' },
  UR: { name: 'UpstreamRemoteReset', meaning: 'The upstream reset the connection, so Envoy answered 503.' },
  UC: { name: 'UpstreamConnectionTermination', meaning: 'The upstream closed the connection mid-request, so Envoy answered 503. Often a keep-alive the upstream retires sooner than Envoy expects.' },
  DI: { name: 'DelayInjected', meaning: 'A fault-injection rule delayed this request deliberately.' },
  FI: { name: 'FaultInjected', meaning: 'A fault-injection rule aborted this request deliberately, with the code the rule specifies.' },
  RL: { name: 'RateLimited', meaning: 'The local HTTP rate-limit filter rejected the request with 429.' },
  UAEX: { name: 'UnauthorizedExternalService', meaning: 'The external authorization service denied the request.' },
  RLSE: { name: 'RateLimitServiceError', meaning: 'The rate-limit service itself errored, so the request was rejected.' },
  IH: { name: 'InvalidEnvoyRequestHeaders', meaning: 'A strictly-checked header carried an invalid value, so Envoy answered 400.' },
  SI: { name: 'StreamIdleTimeout', meaning: 'The stream sat idle past its timeout and was closed with 408 or 504.' },
  DPE: { name: 'DownstreamProtocolError', meaning: 'The client sent something Envoy could not parse as HTTP — a protocol mismatch, or plaintext arriving on a TLS port.' },
  UPE: { name: 'UpstreamProtocolError', meaning: 'The upstream response was not valid HTTP.' },
  UMSDR: { name: 'UpstreamMaxStreamDurationReached', meaning: 'The upstream request reached its maximum stream duration and was closed.' },
  RFCF: { name: 'ResponseFromCacheFilter', meaning: 'An Envoy cache filter served this response; it never reached an upstream.' },
  NFCF: { name: 'NoFilterConfigFound', meaning: 'A filter’s configuration did not arrive within the warming deadline, so the request was dropped.' },
  OM: { name: 'OverloadManagerTerminated', meaning: 'The Overload Manager shed this request to protect the proxy.' },
  DF: { name: 'DnsResolutionFailed', meaning: 'DNS resolution for the upstream failed.' },
  DO: { name: 'DropOverload', meaning: 'A drop_overloads rule shed this request with 503.' },
  DR: { name: 'DownstreamRemoteReset', meaning: 'The client reset or refused the HTTP/2 stream.' },
  UDO: { name: 'UnconditionalDropOverload', meaning: 'drop_overloads is set to 100%, so every request is shed with 503.' }
});

/** The `NR` an operator meets on an ingress gateway, which is not the one the short list decodes. */
const NR_FILTER_CHAIN = {
  name: 'NoRouteFound (no matching filter chain)',
  meaning:
    'No TLS or port listener accepted this connection, so nothing was routed because nothing was admitted. The SNI the client offered matched no Gateway server host, or it connected on a port no Gateway declares. Look at the Gateway, not at the VirtualService.'
};

/*
  Envoy puts more than one verdict on a single request, and it joins them with a COMMA:
  `UF,URX` means "could not connect to the upstream, and gave up after retrying". Measured on
  platformsbx, 38 of 7,388 access-log lines carried exactly that pair, and no observed value
  contained whitespace.

  Splitting on whitespace alone therefore does not fail loudly — it invents a flag literally named
  `UF,URX`, which decodes as unknown, so a hard backend-down verdict renders as an unrecognised
  grey row instead of two known red ones. Comma is what actually occurs; whitespace is kept in the
  pattern because it costs nothing and guards a format change.

  `-` never reaches here: the parser maps it to null on the way in.
*/
function splitFlags(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .filter(Boolean);
}

/**
 * One flag code into its name and meaning, resolved against the code details where that changes
 * the answer. Returns a row for an unknown code too — saying "Envoy said UUU and we do not decode
 * it" is a better answer than dropping the row and under-reporting the window.
 */
function decodeResponseFlag(flag, details = []) {
  const code = clean(flag);
  if (!code) return null;
  if (code === 'NR' && (details || []).some(d => String(d).includes('filter_chain_not_found'))) {
    return { flag: code, ...NR_FILTER_CHAIN, known: true };
  }
  const known = RESPONSE_FLAGS[code];
  if (!known) {
    return {
      flag: code,
      name: null,
      meaning: 'Envoy emitted a response flag this console has no decode for. Its own documentation lists the full set.',
      known: false
    };
  }
  return { flag: code, ...known, known: true };
}

/* ------------------------------------------------------------------ log parsing */

/**
 * One access-log line into a request, or null.
 *
 * Returns null for anything that is not a JSON object carrying a numeric status code: Envoy
 * also writes its own startup and xDS chatter to the same stream, and a proxy configured with
 * the default text format writes positional lines this deliberately refuses to guess at.
 *
 * ## Two vocabularies, because Kyma ships two log formats
 *
 * `stdout-json` labels a request the way Envoy always has — `response_code`, `method`, `path`.
 * `kyma-logs` labels the same request with OpenTelemetry semantic conventions —
 * `http.response.status_code`, `http.request.method`, `url.path`. The label map on either
 * provider is free-form, so an operator migrating from one to the other can perfectly well
 * point a stdout provider at the OTel names; when they do, every line used to fall through to
 * `null` and land in `linesUnparsed`, and the tab reported zero errors out of a full window.
 *
 * So each field is looked up under both names, Envoy's first because it is what the default
 * Kyma mesh emits. Fields with no OTel counterpart — `response_flags`, `response_code_details`,
 * `upstream_cluster` — simply stay null under the OTel vocabulary rather than being
 * reconstructed from something that merely looks similar; a null upstream renders as "not
 * routed", which is true, while a guessed one would put a real workload's name on the wrong
 * request. `parseUpstreamCluster` is the one thing attribution cannot do without, which is why
 * an OTel-labelled line resolves its destination by address and not by FQDN.
 */
/**
 * The first of two field names that carries a real value.
 *
 * The emptiness test applies to BOTH names, and that symmetry is load-bearing. The first draft
 * guarded only the Envoy key and returned `d[otelKey]` unchecked — so a line carrying
 * `"http.response.status_code": ""` (or null) reached `Number('')`, which is `0`, which is finite,
 * which `classOf` reads as the `no-response` class. Junk minted a fabricated "connection Envoy
 * never answered" finding, in the exact class an operator opens this tab to triage, while the
 * identical line spelled `"response_code": ""` was correctly discarded as unparsed. Two
 * vocabularies must never disagree about the same input.
 */
function empty(v) {
  return v === undefined || v === null || v === '';
}

function pick(d, envoyKey, otelKey) {
  const v = d[envoyKey];
  if (!empty(v)) return v;
  if (otelKey === undefined) return undefined;
  const o = d[otelKey];
  return empty(o) ? undefined : o;
}

function parseAccessLine(line) {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  let d;
  try {
    d = JSON.parse(s);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const code = Number(pick(d, 'response_code', 'http.response.status_code'));
  if (!Number.isFinite(code)) return null;

  // OTel splits the request target: `url.path` carries no query string, `url.query` holds it.
  // Envoy's `path` carries both, and `redactUrl` only strips credentials after a `?` — so the
  // two halves are rejoined BEFORE redaction, or a token in `url.query` would go out in clear.
  const otelPath = clean(d['url.path']);
  const otelQuery = clean(d['url.query']);
  const target = clean(d.path) || (otelPath ? (otelQuery ? `${otelPath}?${otelQuery}` : otelPath) : null);

  const duration = Number(pick(d, 'duration', 'http.request.duration'));
  const bytesSent = Number(pick(d, 'bytes_sent', 'http.response.size'));
  const bytesReceived = Number(pick(d, 'bytes_received', 'http.request.size'));

  /*
    `upstream_service_time` is `x-envoy-upstream-service-time`, so it is a **response header value**
    and arrives as a JSON *string* — `"12"` — while `duration` beside it is a JSON number. It is the
    time the upstream itself spent, where `duration` is the whole request including this proxy's own
    work and the downstream leg; the difference between them is the only measurement here that
    separates "the app is slow" from "the mesh is slow".

    `pick` returns undefined for `""` and `null` alike, so `Number(undefined)` is NaN and the guard
    below keeps it null. That symmetry is the point: 175 of 400 live lines carry no value at all —
    locally-generated 403s and connections that never reached an upstream — and a missing upstream
    hop is a real state, not a measured zero. Same pin as the OTel duration case.
  */
  const upstreamServiceTime = Number(pick(d, 'upstream_service_time'));

  // Envoy writes a literal `-` for an unset string in some builds, and `null` in others. Both mean
  // "not recorded", and collapsing only one of them would make the two look like different facts.
  const dash = v => (v === '-' ? null : v);

  const termination = clean(d.connection_termination_details);
  /*
    Kyma's stock mesh maps `upstream_transport_failure_reason` to `%CONNECTION_TERMINATION_DETAILS%`
    — verified live against the `istio` ConfigMap — so on that mesh the two labels carry the
    identical string and the real transport-failure reason is never emitted at all. Reporting it
    twice put the same words under a heading that promises something else ("the connection to the
    upstream itself failed"), so a value equal to the termination details is dropped rather than
    relabelled. A mesh that maps the field correctly still reports it.
  */
  const transport = clean(d.upstream_transport_failure_reason);

  return {
    code,
    method: clean(pick(d, 'method', 'http.request.method')),
    path: redactUrl(target),
    authority: clean(pick(d, 'authority', 'server.address')),
    protocol: clean(pick(d, 'protocol', 'network.protocol.name')),
    startTime: clean(d.start_time),
    duration: Number.isFinite(duration) ? duration : null,
    /** Milliseconds the upstream spent, from `x-envoy-upstream-service-time`. Null is a real state. */
    upstreamMs: Number.isFinite(upstreamServiceTime) ? upstreamServiceTime : null,
    responseFlags: clean(d.response_flags) === '-' ? null : clean(d.response_flags),
    responseCodeDetails: clean(d.response_code_details),
    terminationDetails: termination,
    transportFailure: transport && transport !== termination ? transport : null,
    /**
     * The SNI the client offered, from `%REQUESTED_SERVER_NAME%`.
     *
     * The one field that survives a connection Envoy rejected before it parsed a request: on the
     * live cluster every `filter_chain_not_found` line has a null `authority` and a populated SNI,
     * so without this a listener rejection is an anonymous row.
     */
    requestedServerName: clean(dash(d.requested_server_name)),
    /** The Envoy route that matched, from `%ROUTE_NAME%`. Null on a listener-level rejection. */
    routeName: clean(dash(d.route_name)),
    requestId: clean(pick(d, 'request_id', 'http.request.header.x-request-id')),
    /*
      The three correlation headers, RAW and unvalidated — `traces.js` owns the parsing.

      All three are *request header* values, so they are present only when the mesh's access-log
      format asks for them: Kyma's stock `stdout-json` emits `request_id` and does NOT emit
      `traceparent`. An absent field here therefore means "this log format does not carry it",
      which is a different statement from "the request had no trace", and only the caller that
      knows which correlators it looked for can tell them apart. So they are surfaced as-is and
      never defaulted.

      `request_id` is the one that always works: Envoy generates `x-request-id` at the edge and
      propagates it to every hop whether or not tracing is enabled. `traceparent` needs the mesh
      to have tracing on — see `enableTracing` in the Istio module CR, which governs regardless of
      sampling rate.
    */
    traceparent: clean(dash(pick(d, 'traceparent', 'http.request.header.traceparent'))),
    b3TraceId: clean(dash(pick(d, 'x_b3_traceid', 'http.request.header.x-b3-traceid'))),
    b3SpanId: clean(dash(pick(d, 'x_b3_spanid', 'http.request.header.x-b3-spanid'))),
    b3ParentSpanId: clean(dash(pick(d, 'x_b3_parentspanid', 'http.request.header.x-b3-parentspanid'))),
    upstreamCluster: d.upstream_cluster,
    upstreamHost: d.upstream_host,
    downstreamRemote: pick(d, 'downstream_remote_address', 'client.address'),
    downstreamLocal: d.downstream_local_address,
    // Deliberately NOT returned to the browser: user_agent and x_forwarded_for identify a
    // person and their network path, and no question on this tab needs them. Both have OTel
    // spellings too (`user_agent.original`, `http.request.header.x-forwarded-for`) and both
    // are left unread for the same reason.
    bytesSent: Number.isFinite(bytesSent) ? bytesSent : null,
    bytesReceived: Number.isFinite(bytesReceived) ? bytesReceived : null
  };
}

/** 4xx, 5xx, or the 0 Envoy writes when there was no HTTP response at all. */
function classOf(code) {
  if (code === 0) return 'no-response';
  if (code >= 500) return 'server';
  if (code >= 400) return 'client';
  return 'ok';
}

/**
 * Whether this pod is an ingress gateway — the tier that sees north-south traffic.
 *
 * Both a label match and a name match, because either alone is wrong somewhere. The label
 * `app: istio-ingressgateway` is what Istio's own chart sets and is the authoritative signal, but a
 * cluster running a second gateway Deployment (a mesh with an internal and an external gateway, or
 * a Kyma cluster with `apple-gateway-mtls` alongside `kyma-gateway`) names it something else and
 * still labels it `istio: ingressgateway`. The name pattern catches the rest. A false positive
 * costs one extra pod in an ingress-scoped view; a false negative empties the whole screen.
 */
function isIngressProxy(pod) {
  const meta = (pod && pod.metadata) || {};
  const labels = meta.labels || {};
  if (labels.app === 'istio-ingressgateway' || labels.istio === 'ingressgateway') return true;
  return /ingressgateway|istio-ingress/.test(meta.name || '');
}

/**
 * Which proxies to read, worst-affected first, and which were skipped.
 *
 * Tiers, in order: ingress gateways, the only proxy that sees north-south traffic, so a 502 a
 * user reported is there and nowhere else; pods backing a route (`backends`, the selectors of the
 * Services a VirtualService or APIRule sends to), so the apps the edge serves are sampled; other
 * gateway-named pods; then the rest. Inside a tier, one pod per owning workload before any
 * workload gets a second, so four replicas of one chatty Deployment cannot fill the budget; then
 * restarts; then name, so the choice is deterministic — an operator comparing two reads should
 * not get a different sample because the API server returned a different order.
 */
function selectProxies(pods, { namespace, namespaces, keepIngress = false, maxPods, backends = null }) {
  const candidates = pods.filter(p => {
    // Both lists, because Istio's **native sidecar** mode injects `istio-proxy` as an init
    // container with `restartPolicy: Always`. Checking `spec.containers` alone found 3 proxies
    // on a cluster running 38 — measured on platformsbx, where 35 pods are native-sidecar and
    // every one of them was invisible to this tab. `mesh.js` carries the same canary.
    const containers = [...((p.spec && p.spec.containers) || []), ...((p.spec && p.spec.initContainers) || [])];
    if (!containers.some(c => c.name === PROXY_CONTAINER)) return false;
    // `namespaces` is the Traces tab's scope; `keepIngress` keeps the edge gateways inside it,
    // because a journey's first hop is logged by a gateway in istio-system, not by the namespace.
    const ns = p.metadata.namespace;
    const inScope = (!namespace || ns === namespace) && (!namespaces || namespaces.includes(ns));
    if (!inScope && !(keepIngress && isIngressProxy(p))) return false;
    // A pod that never started has no access log, and asking for one costs a round trip.
    return (p.status && p.status.phase) === 'Running';
  });

  const backed = p =>
    (backends || []).some(
      b => b.namespace === p.metadata.namespace && Object.entries(b.selector).every(([k, v]) => (p.metadata.labels || {})[k] === v)
    );
  const tierOf = new Map(
    candidates.map(p => [p, isIngressProxy(p) ? 0 : backed(p) ? 1 : /gateway/.test(p.metadata.name || '') ? 2 : 3])
  );
  const restarts = p =>
    ((p.status && p.status.containerStatuses) || []).reduce((n, cs) => n + (cs.restartCount || 0), 0);
  const byName = (a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`);

  const first = [...candidates].sort((a, b) => tierOf.get(a) - tierOf.get(b) || restarts(b) - restarts(a) || byName(a, b));
  const ordinal = new Map();
  const seen = new Map();
  for (const p of first) {
    const o = ownerOf(p);
    const k = `${tierOf.get(p)}|${p.metadata.namespace}/${o.kind}/${o.name}`;
    ordinal.set(p, seen.get(k) || 0);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const sorted = first.sort(
    (a, b) => tierOf.get(a) - tierOf.get(b) || ordinal.get(a) - ordinal.get(b) || restarts(b) - restarts(a) || byName(a, b)
  );

  return {
    selected: sorted.slice(0, maxPods),
    skipped: Math.max(0, sorted.length - maxPods),
    candidates: sorted.length
  };
}

/* ------------------------------------------------------------------ aggregation */

/** Group key: the same failure, whoever reported it. */
function groupKey(r) {
  return [r.code, r.method || '-', r.authority || '-', r.path || '-', r.upstream || '-'].join(' ');
}

function aggregate(requests, index) {
  const groups = new Map();
  for (const r of requests) {
    const upstream = parseUpstreamCluster(r.upstreamCluster, index);
    const row = { ...r, upstream: upstream ? upstream.raw : null };
    const key = groupKey(row);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        code: r.code,
        class: classOf(r.code),
        method: r.method,
        path: r.path,
        authority: r.authority,
        protocol: r.protocol,
        count: 0,
        firstSeen: r.startTime,
        lastSeen: r.startTime,
        responseFlags: new Set(),
        responseCodeDetails: new Set(),
        transportFailures: new Set(),
        durations: [],
        upstream,
        gateway: matchGateway(index, r.authority),
        destination: resolveAddress(index, r.upstreamHost),
        sources: new Map(),
        proxies: new Map(),
        samples: []
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (r.startTime) {
      if (!g.firstSeen || r.startTime < g.firstSeen) g.firstSeen = r.startTime;
      if (!g.lastSeen || r.startTime > g.lastSeen) g.lastSeen = r.startTime;
    }
    for (const f of splitFlags(r.responseFlags)) g.responseFlags.add(f);
    if (r.responseCodeDetails) g.responseCodeDetails.add(r.responseCodeDetails);
    if (r.transportFailure) g.transportFailures.add(r.transportFailure);
    if (r.duration !== null) g.durations.push(r.duration);

    const source = resolveAddress(index, r.downstreamRemote);
    if (source) {
      // External and unresolved peers fold into one address-free source each (D1): see `aggregateClients`.
      const folded = FOLDED_PEERS[source.kind];
      const sk = folded ? source.kind : `${source.kind}/${source.namespace || '-'}/${source.name}`;
      const existing = g.sources.get(sk);
      if (existing) existing.count += 1;
      else g.sources.set(sk, folded
        ? { ip: null, port: null, kind: source.kind, name: folded.name, namespace: null, evidence: folded.evidence, count: 1, peers: new Set() }
        : { ...source, count: 1 });
      if (folded) g.sources.get(sk).peers.add(source.ip);
    }

    const pk = `${r.proxy.namespace}/${r.proxy.pod}`;
    const seen = g.proxies.get(pk);
    if (seen) seen.count += 1;
    else g.proxies.set(pk, { ...r.proxy, count: 1 });

    if (r.requestId && g.samples.length < SAMPLES_PER_GROUP) g.samples.push(r.requestId);
  }

  return [...groups.values()]
    .map(g => ({
      key: g.key,
      code: g.code,
      class: g.class,
      method: g.method,
      path: g.path,
      authority: g.authority,
      protocol: g.protocol,
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      responseFlags: [...g.responseFlags],
      responseCodeDetails: [...g.responseCodeDetails],
      transportFailures: [...g.transportFailures],
      p50Ms: median(g.durations),
      maxMs: g.durations.length ? Math.max(...g.durations) : null,
      upstream: g.upstream,
      gateway: g.gateway,
      destination: g.destination,
      sources: [...g.sources.values()]
        .map(({ peers, ...src }) => (peers ? { ...src, distinct: peers.size } : src))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      bucket: edge.errorBucket({ code: g.code, responseCodeDetails: [...g.responseCodeDetails], responseFlags: [...g.responseFlags] }),
      proxies: [...g.proxies.values()].sort((a, b) => b.count - a.count),
      samples: g.samples
    }))
    // Server errors before client errors before no-response, then by volume: a single 503 is
    // a bigger finding than fifty 404s from a scanner, and sorting purely by count buries it.
    .sort(
      (a, b) =>
        classRank(a.class) - classRank(b.class) || b.count - a.count || a.key.localeCompare(b.key)
    );
}

function classRank(c) {
  return c === 'server' ? 0 : c === 'client' ? 1 : c === 'no-response' ? 2 : 3;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/* ------------------------------------------------------------ latency aggregation */

/**
 * Nearest-rank percentile over a raw duration list.
 *
 * Nearest-rank rather than interpolated because the input is a set of observed request
 * durations, and every value this returns is therefore a duration that a real request actually
 * took. An interpolated p95 invents a millisecond figure no request reported, which is fine for
 * a smooth distribution and misleading for the 20-sample windows this collector often has.
 *
 * `sorted` must already be ascending — the caller sorts once and asks for three percentiles.
 *
 * @param {number[]} sorted ascending durations
 * @param {number} p 0..1
 * @returns {number|null}
 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Percentiles over one bucket's durations.
 *
 * `samples` is returned alongside them and is not decoration: a p99 over 4 observations is a
 * different claim from a p99 over 4000, and the caller has no other way to tell. Percentiles are
 * computed from the raw list, never by averaging percentiles that were already aggregated per
 * proxy — that is the classic way to produce a plausible wrong number here.
 */
function latencyOf(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null
  };
}

/**
 * Whether a parsed access-log record describes an HTTP request at all.
 *
 * Envoy writes two kinds of access-log line and Kyma's `stdout-json` provider emits both onto the
 * same stream. The HTTP log always carries `:method`. The **TCP** log — every database
 * connection, every non-HTTP upstream, every long-lived stream — carries no method, no authority
 * and no path, and its `duration` is the **lifetime of the connection**, not the latency of a
 * request.
 *
 * Measured on platform-sbx: of 1731 records in one window, **919 were TCP**. Pooling them into an
 * HTTP latency table produced a p95 of 120 seconds and a p99 of 210 seconds, describing idle
 * connections that were behaving perfectly. 152 of them were to `polls-postgres` at a p50 of 2 ms,
 * which is a healthy database and not a slow route.
 *
 * A missing method is the discriminator, and it is exact rather than heuristic: the field is
 * either in the log schema Envoy used or it is not.
 */
function isHttpRecord(r) {
  return Boolean(r.method);
}

/** The bucket key for a record whose upstream resolved to no Service. */
const UNRESOLVED_KEY = '(unresolved)';

/**
 * Every record in the window grouped three ways: per destination service, per route, and — kept
 * apart on purpose — per service for the non-HTTP connections.
 *
 * ## Why this exists next to `aggregate` rather than inside it
 *
 * `aggregate` answers "what is failing", so it is handed `errors` only. Latency is a question
 * about *all* traffic — a service whose successful requests take four seconds has no error to
 * group — and the durations for those successful requests were already being parsed and then
 * dropped. This reads the same list `aggregate` never sees, at no extra cost.
 *
 * ## HTTP and TCP are never pooled
 *
 * See `isHttpRecord`. Percentiles under `services` and `routes` are computed over HTTP requests
 * only. TCP records are not discarded — a connection alive for seven minutes is worth seeing —
 * they go to `connections`, where the same percentile fields mean connection lifetime and the UI
 * labels them as such.
 *
 * ## What a "service" is here
 *
 * `upstream_cluster` carries the destination FQDN that Envoy built from its own config, and
 * `parseUpstreamCluster` resolves it to a real Service. A record whose upstream resolves to
 * nothing is bucketed under `null` and counted, rather than guessed at or silently dropped:
 * "we could not attribute 40% of this window" is itself an answer an operator needs.
 *
 * ## What these numbers are not
 *
 * Not rates. Each bucket carries `requests`, a count over the lines that were read, and the
 * caller pairs it with `window` — which says how many proxies, how many lines and how wide a span
 * that was. There is no denominator here and none is implied.
 *
 * @param {object[]} records every parsed record in the window, errors and successes alike
 * @param {object} index the resolver built by `buildIndex`
 */
function aggregateLatency(records, index) {
  const services = new Map();
  const routes = new Map();
  const connections = new Map();
  let unresolvedRequests = 0;
  let httpRequests = 0;
  let connectionRecords = 0;

  const bump = (bucket, seed, r, cls) => {
    let b = bucket.get(seed.key);
    if (!b) {
      b = { ...seed, requests: 0, errors: 0, server: 0, client: 0, noResponse: 0, durations: [], lastSeen: null };
      bucket.set(seed.key, b);
    }
    b.requests += 1;
    if (cls !== 'ok') b.errors += 1;
    if (cls === 'server') b.server += 1;
    else if (cls === 'client') b.client += 1;
    else if (cls === 'no-response') b.noResponse += 1;
    if (r.duration !== null) b.durations.push(r.duration);
    if (r.startTime && (!b.lastSeen || r.startTime > b.lastSeen)) b.lastSeen = r.startTime;
    return b;
  };

  for (const r of records) {
    const upstream = parseUpstreamCluster(r.upstreamCluster, index);
    const svc = upstream && upstream.service ? upstream.service : null;
    const svcKey = svc ? `${svc.namespace || '-'}/${svc.name}` : UNRESOLVED_KEY;

    if (!isHttpRecord(r)) {
      connectionRecords += 1;
      // A TCP record's code is 0 by construction, which `classOf` calls `no-response`. That
      // classification is about HTTP and does not apply, so connections are bumped as `ok` and
      // the class counters on this bucket stay at zero rather than reporting every healthy
      // database connection as a failure.
      bump(connections, { key: svcKey, service: svc }, r, 'ok');
      continue;
    }

    httpRequests += 1;
    if (!svc) unresolvedRequests += 1;
    const cls = classOf(r.code);

    bump(services, { key: svcKey, service: svc }, r, cls);
    // A route is the method, the authority the client asked for, and the path as sent. `path` is
    // already redacted by `parseAccessLine`, so no credential-shaped query value reaches this map.
    bump(
      routes,
      {
        key: `${r.method} ${r.authority || '-'} ${r.path || '-'} ${svcKey}`,
        method: r.method,
        authority: r.authority,
        path: r.path,
        service: svc
      },
      r,
      cls
    );
  }

  const finish = b => {
    const { durations, ...rest } = b;
    return {
      ...rest,
      ...latencyOf(durations),
      // A share of the window, spelled as one. Deliberately not named a rate.
      errorShare: b.requests ? b.errors / b.requests : null
    };
  };

  // Slowest first on p95, because that is the column an operator opens this for. A bucket with no
  // duration data at all sorts last rather than as zero.
  const byP95 = (a, b) =>
    (b.p95Ms ?? -1) - (a.p95Ms ?? -1) || b.requests - a.requests || String(a.key).localeCompare(String(b.key));

  return {
    services: [...services.values()].map(finish).sort(byP95),
    routes: [...routes.values()].map(finish).sort(byP95),
    connections: [...connections.values()].map(finish).sort(byP95),
    unresolvedRequests,
    httpRequests,
    connectionRecords
  };
}

/* ------------------------------------------------------------- ingress aggregation */

/**
 * The response family, with 3xx kept apart from 2xx.
 *
 * `classOf` above answers "is this a failure" and folds every success together, which is the right
 * question for the error table and the wrong one for a host row: a host answering 97% 302 is an
 * auth redirect loop or a working SSO hop, and either way an operator needs to see the redirects
 * rather than have them counted as healthy 2xx. `classOf` is left exactly as it is — it is pinned
 * by tests and read by three call sites — and this sits beside it.
 */
function httpFamily(code) {
  if (code === 0) return 'noResponse';
  if (code >= 500) return 'server';
  if (code >= 400) return 'client';
  if (code >= 300) return 'redirect';
  return 'ok';
}

/** The port a connection arrived on, from `downstream_local_address`. */
function localPortOf(record) {
  const { port } = splitHostPort(record.downstreamLocal);
  return Number.isFinite(port) ? port : null;
}

/** A counting map into a sorted, capped list. One shape for every "top N by count" on this page. */
function topCounts(map, limit) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

function bump(map, key, by = 1) {
  if (key === null || key === undefined) return;
  map.set(key, (map.get(key) || 0) + by);
}

/**
 * A byte total, or `null` when not one line recorded the field.
 *
 * A sum of nothing is 0, and 0 is a real answer here: `bytes_received` is genuinely 0 on all 400
 * lines of a live ingress window, because health probes and plain GETs carry no request body. So
 * the sum on its own cannot tell "this build's log format omits the field" from "the field was
 * logged and was zero" — and those are different answers, which is the one distinction this tab
 * exists to keep. The caller counts the lines that carried a value; this turns "none of them" into
 * an em-dash rather than a confident zero.
 */
function byteTotal(sum, samples) {
  return samples ? sum : null;
}

/**
 * Requests per second, computed per proxy over that proxy's own log span and then summed.
 *
 * ## Why not `total / (newest − oldest)`
 *
 * Because the proxies are not one clock. A 1000-line tail from a busy ingress gateway covers the
 * last ninety seconds; the same tail from an idle sidecar covers the last ten hours. Pooling them
 * divides the busy proxy's requests by the idle proxy's span, and the answer understates the
 * ingress tier by two orders of magnitude — measured at 0.03/s against a gateway actually serving
 * several requests a second. Each proxy's `count / span` is a real observation about that proxy;
 * summing those observations is the honest total.
 *
 * ## Why it can come back null
 *
 * `count / span` stops being a rate when the span is short: two requests 400 ms apart is not 5/s.
 * Below `MIN_RATE_SPAN_SECONDS` on **any** contributing proxy the figure is suppressed and the
 * reason is returned in its place, because this console's whole position on the access-log window
 * is that a number it cannot stand behind is worse than an em-dash. Only records carrying a
 * `start_time` count toward the numerator, so the numerator and the denominator describe the same
 * lines.
 */
function spanWeightedRate(records, { minSpanSeconds = MIN_RATE_SPAN_SECONDS } = {}) {
  const byProxy = new Map();
  for (const r of records) {
    const key = `${r.proxy.namespace}/${r.proxy.pod}`;
    let p = byProxy.get(key);
    if (!p) {
      p = { proxy: key, records: 0, timed: 0, oldest: null, newest: null };
      byProxy.set(key, p);
    }
    p.records += 1;
    if (!r.startTime) continue;
    p.timed += 1;
    if (!p.oldest || r.startTime < p.oldest) p.oldest = r.startTime;
    if (!p.newest || r.startTime > p.newest) p.newest = r.startTime;
  }

  const contributors = [];
  let total = 0;
  let usable = 0;
  let shortest = null;

  for (const p of byProxy.values()) {
    const ms = p.oldest && p.newest ? Date.parse(p.newest) - Date.parse(p.oldest) : NaN;
    const spanSeconds = Number.isFinite(ms) ? Math.round((ms / 1000) * 10) / 10 : null;
    const entry = { proxy: p.proxy, records: p.records, timed: p.timed, spanSeconds, perSecond: null };
    if (spanSeconds !== null && spanSeconds > 0) {
      entry.perSecond = Math.round((p.timed / spanSeconds) * 100) / 100;
      total += p.timed / spanSeconds;
      usable += 1;
      if (shortest === null || spanSeconds < shortest) shortest = spanSeconds;
    }
    contributors.push(entry);
  }

  contributors.sort((a, b) => (b.perSecond ?? -1) - (a.perSecond ?? -1) || a.proxy.localeCompare(b.proxy));

  if (!usable) {
    return {
      perSecond: null,
      contributors,
      shortestSpanSeconds: null,
      suppressed: true,
      why: 'No proxy returned two timestamped lines, so there is no span to divide by.'
    };
  }
  if (shortest !== null && shortest < minSpanSeconds) {
    return {
      perSecond: null,
      contributors,
      shortestSpanSeconds: shortest,
      suppressed: true,
      why: `One proxy's window spans only ${shortest}s, which is too short for count ÷ span to mean a rate. Read a wider tail.`
    };
  }
  return {
    perSecond: Math.round(total * 100) / 100,
    contributors,
    shortestSpanSeconds: shortest,
    suppressed: false,
    why: `Each proxy's own timestamped lines divided by its own span, then summed across ${usable} ${usable === 1 ? 'proxy' : 'proxies'}. An observation over the window that was read, not a cluster total.`
  };
}

/**
 * Every request in the window grouped by the Host header the client sent.
 *
 * This is the question the ingress tier exists to answer and the one the error table cannot: "which
 * of my published domains is being hit, by whom, and how is it answering". Grouping is on the
 * authority with its port removed, so `shop.example.com` and `shop.example.com:443` are one row;
 * a record with no authority at all — every TCP connection, and every connection rejected before a
 * request line was parsed — gets its own printable bucket rather than being dropped, because
 * "38% of this window carried no Host header" is itself the finding on a cluster failing SNI.
 */
function aggregateHosts(records, index, { corporate = [], routes = [], maxHosts = MAX_INGRESS_HOSTS } = {}) {
  const buckets = new Map();

  for (const r of records) {
    const host = hostKeyOf(r.authority);
    const key = host || NO_HOST_KEY;
    let b = buckets.get(key);
    if (!b) {
      const cls = classifyHost(host, { gatewayHosts: index.gatewayHosts, corporate });
      b = {
        key,
        host,
        group: cls.group,
        matchedSuffix: cls.matchedSuffix,
        gateway: cls.declaredBy
          ? {
              name: cls.declaredBy.name,
              namespace: cls.declaredBy.namespace,
              host: cls.declaredBy.host,
              port: cls.declaredBy.port,
              evidence: cls.declaredBy.evidence
            }
          : null,
        servedBy: host ? matchRoutes(routes, host) : [],
        requests: 0,
        httpRequests: 0,
        connections: 0,
        ok: 0,
        redirect: 0,
        client: 0,
        server: 0,
        noResponse: 0,
        durations: [],
        upstreamMs: [],
        overheads: [],
        codes: new Map(),
        methods: new Set(),
        paths: new Map(),
        flags: new Set(),
        details: new Set(),
        clients: new Set(),
        externalClients: new Set(),
        sni: new Set(),
        ports: new Map(),
        proxies: new Set(),
        bytesSent: 0,
        bytesReceived: 0,
        bytesSentSamples: 0,
        bytesReceivedSamples: 0,
        firstSeen: null,
        lastSeen: null
      };
      buckets.set(key, b);
    }

    b.requests += 1;
    /*
      The response family is an HTTP statement, so only HTTP records may be counted into one.

      A raw TCP connection carries no response code — Envoy logs it as `0` — and `httpFamily(0)` is
      `noResponse`. Counting the whole scoped window here therefore filed every healthy database
      connection under this host's **no-response** column and pushed it into `errorShare`, which is
      exactly the inflated figure a share must never print. `aggregateLatency` already guards the
      same records the same way (it bumps connections as `ok`), and the cluster-wide ingress summary
      counts families over `http` only; this row-level count was the one place that did not.

      `requests` stays a record count — it is what the Hosts table is documented to show, and the
      HTTP/TCP split is published beside it rather than folded into it.
    */
    if (isHttpRecord(r)) {
      b.httpRequests += 1;
      b[httpFamily(r.code)] += 1;
    } else {
      b.connections += 1;
    }
    bump(b.codes, r.code);
    if (r.method) b.methods.add(r.method);
    if (r.path) bump(b.paths, r.path);
    for (const f of splitFlags(r.responseFlags)) b.flags.add(f);
    if (r.responseCodeDetails) b.details.add(r.responseCodeDetails);
    if (r.requestedServerName) b.sni.add(r.requestedServerName);
    bump(b.ports, localPortOf(r));
    b.proxies.add(`${r.proxy.namespace}/${r.proxy.pod}`);
    if (r.duration !== null) b.durations.push(r.duration);
    if (r.upstreamMs !== null) b.upstreamMs.push(r.upstreamMs);
    // Only where both halves exist. A missing upstream time means the request never reached an
    // upstream, so `duration − 0` would report the whole rejection as this proxy's overhead.
    if (r.duration !== null && r.upstreamMs !== null) b.overheads.push(Math.max(0, r.duration - r.upstreamMs));
    if (r.bytesSent !== null) { b.bytesSent += r.bytesSent; b.bytesSentSamples += 1; }
    if (r.bytesReceived !== null) { b.bytesReceived += r.bytesReceived; b.bytesReceivedSamples += 1; }
    if (r.startTime) {
      if (!b.firstSeen || r.startTime < b.firstSeen) b.firstSeen = r.startTime;
      if (!b.lastSeen || r.startTime > b.lastSeen) b.lastSeen = r.startTime;
    }

    const source = resolveAddress(index, r.downstreamRemote);
    if (source) {
      b.clients.add(source.ip);
      if (source.kind === 'external') b.externalClients.add(source.ip);
    }
  }

  const rows = [...buckets.values()]
    .map(b => ({
      key: b.key,
      host: b.host,
      group: b.group,
      matchedSuffix: b.matchedSuffix,
      gateway: b.gateway,
      servedBy: b.servedBy,
      requests: b.requests,
      /** The HTTP subset of `requests` — the denominator every family count below belongs to. */
      httpRequests: b.httpRequests,
      /** Records with no request line: raw TCP, and connections rejected before one was parsed. */
      connections: b.connections,
      ok: b.ok,
      redirect: b.redirect,
      client: b.client,
      server: b.server,
      noResponse: b.noResponse,
      /*
        A share of this host's own **HTTP** records in the window that was read. Deliberately not a
        rate, and deliberately not over `requests`: a host whose window is mostly TCP connections
        would otherwise have its error share diluted by records that can never carry a status code.
        `null` when nothing HTTP was read for this host — there is no share to state, and 0 would
        read as "no errors".
      */
      errorShare: b.httpRequests ? (b.client + b.server + b.noResponse) / b.httpRequests : null,
      total: latencyOf(b.durations),
      upstream: latencyOf(b.upstreamMs),
      /** Median of `duration − upstream_service_time`: this proxy's own work plus the client leg. */
      overheadMs: median(b.overheads),
      methods: [...b.methods].sort(),
      paths: topCounts(b.paths, PER_HOST_SAMPLES).map(p => ({ path: p.key, count: p.count })),
      codes: topCounts(b.codes, PER_HOST_SAMPLES).map(c => ({ code: c.key, class: classOf(c.key), count: c.count })),
      flags: [...b.flags].sort(),
      details: [...b.details].sort().slice(0, PER_HOST_SAMPLES),
      clients: b.clients.size,
      externalClients: b.externalClients.size,
      sni: b.sni.size,
      ports: topCounts(b.ports, 6).map(p => ({ port: p.key, count: p.count })),
      bytesSent: byteTotal(b.bytesSent, b.bytesSentSamples),
      bytesReceived: byteTotal(b.bytesReceived, b.bytesReceivedSamples),
      proxies: [...b.proxies].sort(),
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen
    }))
    .sort((a, b) => b.requests - a.requests || String(a.key).localeCompare(String(b.key)));

  /*
    Everything after `truncated` is counted over the **full** row list, before the cap.

    The cap exists so a cluster with thousands of hosts does not ship thousands of rows. But a tile
    computed over `rows.slice()` and printed beside a total that was not reads as a real difference
    between two facts about the cluster. With 250 hosts and a cap of 200, a "named hosts" tile fed
    from the sliced list says 200 while `total` says 250, and the caption then invents 50 records that
    carried no Host header. The cap is a transport decision; it must not reach the arithmetic.
  */
  const groups = new Map();
  for (const r of rows) groups.set(r.group, (groups.get(r.group) || 0) + r.requests);

  return {
    rows: rows.slice(0, maxHosts),
    total: rows.length,
    truncated: rows.length > maxHosts,
    /** Distinct hosts that actually named something, over every bucket rather than the listed ones. */
    namedTotal: rows.filter(r => r.host).length,
    /**
     * Records in the no-Host-header bucket — a **record** count, not a bucket count.
     *
     * `total − namedTotal` answers a different question and is always 0 or 1, because every
     * authority-less record collapses into the single `NO_HOST_KEY` bucket above. On the live cluster
     * that difference was 1 while this number was 340, so a tile fed from the subtraction reported
     * 23% of the window as one stray record.
     */
    unnamedRequests: rows.find(r => !r.host)?.requests ?? 0,
    /** Requests per group over every bucket, so a share of these sums to the records denominator. */
    groups: [...groups.entries()]
      .map(([group, requests]) => ({ group, requests, hosts: rows.filter(r => r.group === group).length }))
      .sort((a, b) => b.requests - a.requests || a.group.localeCompare(b.group))
  };
}

/**
 * Every request grouped by the address that sent it.
 *
 * ## "Client IP" is the peer, and the row says so
 *
 * `downstream_remote_address` is the *immediate* peer. Behind a corporate load balancer that is the
 * load balancer, not the person. The real originator would be `x-forwarded-for`, which this module
 * deliberately never reads — it identifies a person and their network path, and the RBAC audit's
 * whole argument about this tab is that a log line is application data. So the column is the peer,
 * labelled as the peer, and nothing here resurrects XFF to "fix" that.
 *
 * ## Why it earns a screen
 *
 * On the live cluster this surfaced 53 `CONNECT checkip.amazonaws.com:443` attempts answered 403 —
 * somebody probing the gateway as an open forward proxy — sitting in a window nothing else on the
 * console groups by origin. `connects` counts exactly that.
 */
function aggregateClients(records, index, { maxClients = MAX_INGRESS_CLIENTS } = {}) {
  const buckets = new Map();

  for (const r of records) {
    const peer = resolveAddress(index, r.downstreamRemote);
    if (!peer) continue;
    let b = buckets.get(peer.ip);
    if (!b) {
      b = {
        key: peer.ip,
        ip: peer.ip,
        kind: peer.kind,
        name: peer.name,
        namespace: peer.namespace ?? null,
        external: peer.kind === 'external',
        evidence: peer.evidence,
        requests: 0,
        ok: 0,
        redirect: 0,
        client: 0,
        server: 0,
        noResponse: 0,
        connects: 0,
        hosts: new Map(),
        codes: new Map(),
        methods: new Set(),
        bytesSent: 0,
        bytesReceived: 0,
        bytesSentSamples: 0,
        bytesReceivedSamples: 0,
        firstSeen: null,
        lastSeen: null
      };
      buckets.set(peer.ip, b);
    }
    b.requests += 1;
    b[httpFamily(r.code)] += 1;
    if (r.method === 'CONNECT') b.connects += 1;
    if (r.method) b.methods.add(r.method);
    bump(b.codes, r.code);
    bump(b.hosts, hostKeyOf(r.authority) || NO_HOST_KEY);
    if (r.bytesSent !== null) { b.bytesSent += r.bytesSent; b.bytesSentSamples += 1; }
    if (r.bytesReceived !== null) { b.bytesReceived += r.bytesReceived; b.bytesReceivedSamples += 1; }
    if (r.startTime) {
      if (!b.firstSeen || r.startTime < b.firstSeen) b.firstSeen = r.startTime;
      if (!b.lastSeen || r.startTime > b.lastSeen) b.lastSeen = r.startTime;
    }
  }

  /*
    Client addresses never leave this function (D1, 2026-09-26). An internal peer is a cluster
    object and keeps its row; every external peer folds into one `External clients` row, and every
    private address matching no object (an internal NLB, peering or VPN client) into one
    `Unresolved private addresses` row, each with a `distinct` saying how many addresses it stands for. The per-peer counts below are taken first,
    so they still describe every peer.
  */
  const perPeer = [...buckets.values()].map(b => ({
    external: b.external,
    requests: b.requests,
    connects: b.connects,
    rejected: b.requests > 0 && b.client + b.server + b.noResponse === b.requests
  }));
  const kept = [...buckets.values()].filter(b => !FOLDED_PEERS[b.kind]);
  for (const kind of Object.keys(FOLDED_PEERS)) {
    const peers = [...buckets.values()].filter(b => b.kind === kind);
    if (peers.length) kept.push(mergeFoldedPeers(kind, peers));
  }

  const rows = kept
    .map(b => ({
      key: b.key,
      ip: b.ip,
      distinct: b.distinct ?? 1,
      kind: b.kind,
      name: b.name,
      namespace: b.namespace,
      external: b.external,
      evidence: b.evidence,
      requests: b.requests,
      ok: b.ok,
      redirect: b.redirect,
      client: b.client,
      server: b.server,
      noResponse: b.noResponse,
      errorShare: b.requests ? (b.client + b.server + b.noResponse) / b.requests : null,
      connects: b.connects,
      hosts: b.hosts.size,
      topHosts: topCounts(b.hosts, 3).map(h => ({ host: h.key, count: h.count })),
      codes: topCounts(b.codes, 5).map(c => ({ code: c.key, class: classOf(c.key), count: c.count })),
      methods: [...b.methods].sort(),
      bytesSent: byteTotal(b.bytesSent, b.bytesSentSamples),
      bytesReceived: byteTotal(b.bytesReceived, b.bytesReceivedSamples),
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen
    }))
    .sort((a, b) => b.requests - a.requests || String(a.ip ?? '').localeCompare(String(b.ip ?? '')));

  /*
    As in `aggregateHosts`: the three counts below are over the full list, not the listed one.

    The cap sorts by request volume, so the rows it drops are the *quietest* peers — which is exactly
    where a scanner lives. Counting "peers sending CONNECT" over the listed rows therefore reads a
    confident 0 for the one signal this screen exists to surface.
  */
  return {
    rows: rows.slice(0, maxClients),
    /** Distinct peers, every one counted, though external peers share a row. */
    total: perPeer.length,
    truncated: rows.length > maxClients,
    /** Peers matching no Pod, Service, endpoint or Node — over every peer seen. */
    externalTotal: perPeer.filter(r => r.external).length,
    /** Peers that sent at least one HTTP CONNECT. */
    connectingTotal: perPeer.filter(r => r.connects > 0).length,
    /** Peers where every record read was a 4xx, a 5xx or unanswered. */
    fullyRejectedTotal: perPeer.filter(r => r.rejected).length
  };
}

/**
 * Peer kinds whose address is a client's, never a cluster object's: each folds into one row with no
 * address. `unresolved` is a private address that matched no Pod, Service, endpoint or Node.
 */
const FOLDED_PEERS = {
  external: { name: 'External clients', evidence: 'Addresses outside the cluster, counted and never listed: client addresses are not published.' },
  unresolved: { name: 'Unresolved private addresses', evidence: 'Private addresses matching no cluster object, counted and never listed: client addresses are not published.' }
};

/** Fold one kind's peer buckets into one row that carries no address. */
function mergeFoldedPeers(kind, buckets) {
  const m = {
    key: kind,
    ip: null,
    kind,
    name: FOLDED_PEERS[kind].name,
    namespace: null,
    external: kind === 'external',
    evidence: FOLDED_PEERS[kind].evidence,
    distinct: buckets.length,
    requests: 0, ok: 0, redirect: 0, client: 0, server: 0, noResponse: 0, connects: 0,
    hosts: new Map(), codes: new Map(), methods: new Set(),
    bytesSent: 0, bytesReceived: 0, bytesSentSamples: 0, bytesReceivedSamples: 0,
    firstSeen: null, lastSeen: null
  };
  for (const b of buckets) {
    for (const k of ['requests', 'ok', 'redirect', 'client', 'server', 'noResponse', 'connects', 'bytesSent', 'bytesReceived', 'bytesSentSamples', 'bytesReceivedSamples']) m[k] += b[k];
    for (const [k, v] of b.hosts) bump(m.hosts, k, v);
    for (const [k, v] of b.codes) bump(m.codes, k, v);
    for (const x of b.methods) m.methods.add(x);
    if (b.firstSeen && (!m.firstSeen || b.firstSeen < m.firstSeen)) m.firstSeen = b.firstSeen;
    if (b.lastSeen && (!m.lastSeen || b.lastSeen > m.lastSeen)) m.lastSeen = b.lastSeen;
  }
  return m;
}

/**
 * The response-flag distribution, decoded.
 *
 * Envoy may write several flags on one line, space-separated, so a line contributes to each of
 * them. The code details are carried alongside because they are what makes `NR` decodable — see
 * `decodeResponseFlag`.
 */
function aggregateFlags(records) {
  const buckets = new Map();
  for (const r of records) {
    if (!r.responseFlags) continue;
    for (const flag of splitFlags(r.responseFlags)) {
      let b = buckets.get(flag);
      if (!b) {
        b = { flag, count: 0, codes: new Map(), details: new Set(), hosts: new Set(), lastSeen: null };
        buckets.set(flag, b);
      }
      b.count += 1;
      bump(b.codes, r.code);
      if (r.responseCodeDetails) b.details.add(r.responseCodeDetails);
      b.hosts.add(hostKeyOf(r.authority) || NO_HOST_KEY);
      if (r.startTime && (!b.lastSeen || r.startTime > b.lastSeen)) b.lastSeen = r.startTime;
    }
  }
  return [...buckets.values()]
    .map(b => {
      const details = [...b.details].sort();
      const decoded = decodeResponseFlag(b.flag, details);
      return {
        flag: b.flag,
        name: decoded ? decoded.name : null,
        meaning: decoded ? decoded.meaning : null,
        known: decoded ? decoded.known : false,
        count: b.count,
        codes: topCounts(b.codes, 5).map(c => ({ code: c.key, class: classOf(c.key), count: c.count })),
        details: details.slice(0, 5),
        hosts: b.hosts.size,
        lastSeen: b.lastSeen
      };
    })
    .sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag));
}

/**
 * What arrived on each listener port, and what was turned away before it was routed.
 *
 * The port comes from `downstream_local_address`, which is the socket Envoy accepted on — evidence,
 * not inference from the scheme. `rejections` are the connections that never got a filter chain:
 * `response_code: 0` with `filter_chain_not_found`, which on the live cluster was 326 lines and the
 * single largest failure bucket. Those carry no authority at all, so they are grouped by the SNI
 * the client offered, which is the only identity they have.
 */
function aggregateListeners(records, { maxRejections = MAX_LISTENER_REJECTIONS } = {}) {
  const ports = new Map();
  const rejections = new Map();

  for (const r of records) {
    const port = localPortOf(r);
    const key = port === null ? '(unrecorded)' : String(port);
    let p = ports.get(key);
    if (!p) {
      p = {
        key,
        port,
        requests: 0,
        rejected: 0,
        protocols: new Set(),
        sni: new Set(),
        hosts: new Set(),
        codes: new Map(),
        http: 0,
        tcp: 0
      };
      ports.set(key, p);
    }
    p.requests += 1;
    if (isHttpRecord(r)) p.http += 1;
    else p.tcp += 1;
    if (r.protocol) p.protocols.add(r.protocol);
    if (r.requestedServerName) p.sni.add(r.requestedServerName);
    const host = hostKeyOf(r.authority);
    if (host) p.hosts.add(host);
    bump(p.codes, r.code);

    const noFilterChain = r.code === 0 && String(r.responseCodeDetails || '').includes('filter_chain_not_found');
    if (!noFilterChain) continue;
    p.rejected += 1;
    const sni = r.requestedServerName || '(no SNI offered)';
    const rk = `${sni}|${key}`;
    let x = rejections.get(rk);
    if (!x) {
      x = { key: rk, sni: r.requestedServerName, port, count: 0, clients: new Set(), firstSeen: null, lastSeen: null };
      rejections.set(rk, x);
    }
    x.count += 1;
    const { ip } = splitHostPort(r.downstreamRemote);
    if (ip) x.clients.add(ip);
    if (r.startTime) {
      if (!x.firstSeen || r.startTime < x.firstSeen) x.firstSeen = r.startTime;
      if (!x.lastSeen || r.startTime > x.lastSeen) x.lastSeen = r.startTime;
    }
  }

  const portRows = [...ports.values()]
    .map(p => ({
      key: p.key,
      port: p.port,
      requests: p.requests,
      rejected: p.rejected,
      http: p.http,
      tcp: p.tcp,
      protocols: [...p.protocols].sort(),
      sni: p.sni.size,
      hosts: p.hosts.size,
      codes: topCounts(p.codes, 5).map(c => ({ code: c.key, class: classOf(c.key), count: c.count }))
    }))
    .sort((a, b) => b.requests - a.requests || String(a.key).localeCompare(String(b.key)));

  const rejectionRows = [...rejections.values()]
    .map(x => ({
      key: x.key,
      sni: x.sni,
      port: x.port,
      count: x.count,
      clients: x.clients.size,
      firstSeen: x.firstSeen,
      lastSeen: x.lastSeen
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    ports: portRows,
    rejections: rejectionRows.slice(0, maxRejections),
    rejectionsTotal: rejectionRows.length,
    rejectionsTruncated: rejectionRows.length > maxRejections
  };
}

/**
 * The Gateway servers this cluster declares: port, protocol, TLS mode and admitted hosts.
 *
 * `credentialName` is a **Secret name**, which is exactly as far as this console goes: the name is
 * the finding an operator needs ("that Gateway points at a Secret that does not exist"), and the
 * value is never read, here or anywhere in `server/fleet`.
 */
function ingressGatewayRows(gateways) {
  if (!gateways || gateways.unavailable) return [];
  const rows = [];
  for (const g of gateways.items || []) {
    if (!g || !g.metadata) continue;
    const servers = (g.spec && g.spec.servers) || [];
    for (const [i, s] of servers.entries()) {
      const port = s.port || {};
      const tls = s.tls || null;
      rows.push({
        key: `${g.metadata.namespace}/${g.metadata.name}#${clean(port.name) || port.number || i}`,
        name: g.metadata.name,
        namespace: g.metadata.namespace,
        selector: (g.spec && g.spec.selector) || null,
        port: Number.isFinite(Number(port.number)) ? Number(port.number) : null,
        portName: clean(port.name),
        protocol: clean(port.protocol),
        tlsMode: tls ? clean(tls.mode) : null,
        credentialName: tls ? clean(tls.credentialName) : null,
        minProtocolVersion: tls ? clean(tls.minProtocolVersion) : null,
        httpsRedirect: Boolean(tls && tls.httpsRedirect === true),
        hosts: (s.hosts || []).map(clean).filter(Boolean)
      });
    }
  }
  return rows.sort(
    (a, b) => (a.port ?? 0) - (b.port ?? 0) || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
  );
}

/**
 * The ingress tier as objects: how many gateway pods are up, what Service fronts them, and whether
 * the autoscaler or the disruption budget is the thing standing between it and a bad afternoon.
 *
 * The pod half costs nothing — the pod list was already read for proxy selection. The Service is
 * picked out of the cluster-wide Service read the resolver already needs. Only the HPA and the PDB
 * are new, and both are namespace-scoped reads of a handful of objects.
 */
function ingressTier({ pods, services, hpas, pdbs }) {
  const podItems = pods && !pods.unavailable ? pods.items || [] : [];
  const ingressPods = podItems.filter(isIngressProxy);
  const ready = ingressPods.filter(p =>
    (((p.status || {}).conditions) || []).some(c => c.type === 'Ready' && c.status === 'True')
  ).length;
  const restarts = ingressPods.reduce(
    (n, p) => n + (((p.status || {}).containerStatuses) || []).reduce((m, cs) => m + (cs.restartCount || 0), 0),
    0
  );
  const namespaces = [...new Set(ingressPods.map(p => p.metadata.namespace))].sort();

  const svc =
    services && !services.unavailable
      ? (services.items || []).find(s => {
          const sel = (s.spec && s.spec.selector) || {};
          if (sel.istio === 'ingressgateway' || sel.app === 'istio-ingressgateway') return true;
          return /ingressgateway/.test((s.metadata && s.metadata.name) || '');
        }) || null
      : null;

  const hpa =
    hpas && !hpas.unavailable
      ? (hpas.items || []).find(h => {
          const target = ((h.spec || {}).scaleTargetRef || {}).name || '';
          return /ingressgateway|istio-ingress/.test(target) || /ingressgateway/.test(h.metadata.name || '');
        }) || null
      : null;

  const pdb =
    pdbs && !pdbs.unavailable
      ? (pdbs.items || []).find(p => /ingressgateway|istio-ingress/.test((p.metadata && p.metadata.name) || '')) || null
      : null;

  return {
    pods: {
      total: ingressPods.length,
      running: ingressPods.filter(p => ((p.status || {}).phase) === 'Running').length,
      ready,
      restarts,
      namespaces,
      names: ingressPods.map(p => `${p.metadata.namespace}/${p.metadata.name}`).sort()
    },
    service: svc
      ? {
          name: svc.metadata.name,
          namespace: svc.metadata.namespace,
          type: clean((svc.spec || {}).type),
          clusterIP: clean((svc.spec || {}).clusterIP),
          /** The load balancer the provider handed back — a hostname on AWS, an address elsewhere. */
          endpoints: ((((svc.status || {}).loadBalancer) || {}).ingress || [])
            .map(i => clean(i.hostname) || clean(i.ip))
            .filter(Boolean),
          ports: ((svc.spec || {}).ports || []).map(p => ({
            name: clean(p.name),
            port: Number.isFinite(Number(p.port)) ? Number(p.port) : null,
            targetPort: p.targetPort === undefined ? null : clean(String(p.targetPort)),
            nodePort: Number.isFinite(Number(p.nodePort)) ? Number(p.nodePort) : null,
            protocol: clean(p.protocol)
          }))
        }
      : null,
    hpa: hpa
      ? {
          name: hpa.metadata.name,
          namespace: hpa.metadata.namespace,
          target: clean(((hpa.spec || {}).scaleTargetRef || {}).name),
          min: Number.isFinite(Number((hpa.spec || {}).minReplicas)) ? Number(hpa.spec.minReplicas) : null,
          max: Number.isFinite(Number((hpa.spec || {}).maxReplicas)) ? Number(hpa.spec.maxReplicas) : null,
          current: Number.isFinite(Number((hpa.status || {}).currentReplicas)) ? Number(hpa.status.currentReplicas) : null,
          desired: Number.isFinite(Number((hpa.status || {}).desiredReplicas)) ? Number(hpa.status.desiredReplicas) : null,
          /** True only when both numbers are known. An unknown ceiling is not a ceiling reached. */
          atCeiling:
            Number.isFinite(Number((hpa.status || {}).currentReplicas)) &&
            Number.isFinite(Number((hpa.spec || {}).maxReplicas)) &&
            Number(hpa.status.currentReplicas) >= Number(hpa.spec.maxReplicas),
          conditions: ((hpa.status || {}).conditions || [])
            .filter(c => c.status === 'True' || c.type === 'ScalingLimited')
            .map(c => ({ type: clean(c.type), status: clean(c.status), reason: clean(c.reason), message: clean(c.message) }))
        }
      : null,
    pdb: pdb
      ? {
          name: pdb.metadata.name,
          namespace: pdb.metadata.namespace,
          minAvailable: (pdb.spec || {}).minAvailable === undefined ? null : clean(String(pdb.spec.minAvailable)),
          maxUnavailable: (pdb.spec || {}).maxUnavailable === undefined ? null : clean(String(pdb.spec.maxUnavailable)),
          currentHealthy: Number.isFinite(Number((pdb.status || {}).currentHealthy)) ? Number(pdb.status.currentHealthy) : null,
          desiredHealthy: Number.isFinite(Number((pdb.status || {}).desiredHealthy)) ? Number(pdb.status.desiredHealthy) : null,
          disruptionsAllowed: Number.isFinite(Number((pdb.status || {}).disruptionsAllowed))
            ? Number(pdb.status.disruptionsAllowed)
            : null,
          expectedPods: Number.isFinite(Number((pdb.status || {}).expectedPods)) ? Number(pdb.status.expectedPods) : null
        }
      : null
  };
}

/**
 * The whole ingress block, from the same window every other number on this tab describes.
 *
 * ## Ingress-scoped means ingress-scoped
 *
 * Only records from proxies `isIngressProxy` recognises feed this. There is no fallback to the
 * whole mesh when no ingress proxy was read — a mesh-wide number under a heading that says ingress
 * is the same class of lie as a `0` from a 403 — so `scope` says `none` and every count under it
 * reads as not-measured. On a cluster with no gateway at all, that is the correct screen.
 *
 * ## No second read, and no second cache
 *
 * Everything here is computed from `requests`, which `collect` already has in hand because the
 * error groups and the latency buckets both parsed it. A dedicated ingress scrape would double the
 * pod-log cost and, worse, produce a *different window*, so the two screens would disagree about
 * the same cluster. A memo inside this function would be invisible to `cache.invalidate` and the
 * Refresh control would hand back a copy it had already shown. Neither is added.
 */
function aggregateIngress({
  records,
  index,
  ingressKeys,
  corporate = [],
  routes = [],
  gateways = null,
  tier = null,
  config = null
}) {
  const scoped = records.filter(r => ingressKeys.has(`${r.proxy.namespace}/${r.proxy.pod}`));
  const http = scoped.filter(isHttpRecord);

  const durations = [];
  const upstreamMs = [];
  const overheads = [];
  const ports = new Map();
  const byCode = new Map();
  let bytesSent = 0;
  let bytesReceived = 0;
  let bytesSentSamples = 0;
  let bytesReceivedSamples = 0;
  const family = { ok: 0, redirect: 0, client: 0, server: 0, noResponse: 0 };

  for (const r of http) {
    family[httpFamily(r.code)] += 1;
    bump(byCode, r.code);
    bump(ports, localPortOf(r));
    if (r.duration !== null) durations.push(r.duration);
    if (r.upstreamMs !== null) upstreamMs.push(r.upstreamMs);
    if (r.duration !== null && r.upstreamMs !== null) overheads.push(Math.max(0, r.duration - r.upstreamMs));
    if (r.bytesSent !== null) {
      bytesSent += r.bytesSent;
      bytesSentSamples += 1;
    }
    if (r.bytesReceived !== null) {
      bytesReceived += r.bytesReceived;
      bytesReceivedSamples += 1;
    }
  }

  const hosts = aggregateHosts(scoped, index, { corporate, routes });
  const clients = aggregateClients(scoped, index);
  const listeners = aggregateListeners(scoped);
  const errors = family.client + family.server + family.noResponse;

  return {
    scope: ingressKeys.size ? 'ingress' : 'none',
    summary: {
      ingressProxies: ingressKeys.size,
      records: scoped.length,
      requests: http.length,
      connections: scoped.length - http.length,
      ...family,
      errors,
      /** A share of the ingress records in this window. Deliberately not named a rate. */
      errorShare: http.length ? errors / http.length : null,
      hosts: hosts.namedTotal,
      hostsIncludingUnnamed: hosts.total,
      /**
       * Records whose line carried no Host header, as a record count.
       *
       * Published rather than left to the UI to subtract, because `hostsIncludingUnnamed − hosts` is
       * a difference of two *bucket* counts and every authority-less record shares one bucket.
       */
      unnamedRequests: hosts.unnamedRequests,
      clients: clients.total,
      externalClients: clients.externalTotal,
      /** Peers that sent at least one CONNECT, and peers that got nothing but errors. Both uncapped. */
      clientsConnecting: clients.connectingTotal,
      clientsFullyRejected: clients.fullyRejectedTotal,
      bytesSent: byteTotal(bytesSent, bytesSentSamples),
      bytesReceived: byteTotal(bytesReceived, bytesReceivedSamples),
      total: latencyOf(durations),
      upstream: latencyOf(upstreamMs),
      overheadMs: median(overheads),
      ports: topCounts(ports, 6).map(p => ({ port: p.key, count: p.count })),
      byCode: topCounts(byCode, 24).map(c => ({ code: c.key, class: classOf(c.key), count: c.count })),
      /*
        Over `http`, not `scoped`. The tile reading this is labelled "sampled requests/s", and
        `scoped` also holds raw TCP connections and TLS handshakes Envoy rejected before parsing a
        request line — on the live cluster 1471 records against 1136 requests, publishing 0.07/s where
        the request rate was 0.054/s. A rate whose numerator is not the thing its label names is
        wrong by however much non-HTTP traffic the gateway happens to be carrying.
      */
      rate: spanWeightedRate(http),
      /** Which suffixes were configured, so the UI can say "none configured" rather than "none matched". */
      corporateSuffixes: corporate
    },
    groups: hosts.groups,
    hosts: hosts.rows,
    hostsTotal: hosts.total,
    hostsTruncated: hosts.truncated,
    clients: clients.rows,
    clientsTotal: clients.total,
    clientsTruncated: clients.truncated,
    flags: aggregateFlags(scoped),
    listeners: listeners.ports,
    rejections: listeners.rejections,
    rejectionsTotal: listeners.rejectionsTotal,
    rejectionsTruncated: listeners.rejectionsTruncated,
    gateways: gateways || [],
    tier: tier || null,
    ...(config ? edgeBlocks({ scoped, index, routes, gatewayRows: gateways || [], hosts, config }) : {})
  };
}

/**
 * Everything the edge restructure added (docs/superpowers/specs/2026-09-26-ingress-traffic-plan.md,
 * "Wire contract"): traffic classes, the app headline, the host chain, the config the edge is
 * built from, the network path and the attention list. Host rows gain `edgeClass`, `chain` and,
 * for a bare-address host, the name the index gives it.
 */
function edgeBlocks({ scoped, index, routes, gatewayRows, hosts, config }) {
  const edgeRead = edge.edgeClasses(scoped, { gatewayHosts: index.gatewayHosts || [], routes });
  const { classes, classOf } = edgeRead;
  /* With both the Gateways and the routes unread, no host can be told app from direct-ip: every
     one would class direct-ip and the app headline would read a confident 0. */
  const app = config.gatewaysUnavailable && config.routesUnavailable ? null : edgeRead.app;
  const certificates = edge.certificateRows(config.certificates, gatewayRows, config.now);
  const dnsEntries = edge.dnsEntryRows(config.dnsentries);
  const envoyFilters = edge.envoyFilterRows(config.envoyfilters, edge.istioVersionOf(config.pods));
  const access = edge.accessControl({
    records: scoped,
    classOf,
    resolvePeer: r => resolveAddress(index, r.downstreamRemote),
    gatewayLabels: { istio: 'ingressgateway' },
    gatewayNamespace: 'istio-system',
    authorizationPolicies: config.authorizationpolicies,
    peerAuthentications: config.peerauthentications,
    envoyFilters
  });

  const byHost = new Map();
  for (const r of scoped) {
    const k = hostKeyOf(r.authority) || NO_HOST_KEY;
    const list = byHost.get(k) || [];
    list.push(r);
    byHost.set(k, list);
  }
  for (const row of hosts.rows) {
    row.edgeClass = edge.hostClass(byHost.get(row.key) || [], classOf);
    row.chain = edge.hostChain(row.host, { gatewayRows, certificates, dnsEntries, gatewaysUnavailable: Boolean(config.gatewaysUnavailable) });
    if (row.host && isBareAddress(row.host)) {
      const n = nameOf(config.nameIndex, row.host, { ranges: false });
      if (n) row.destination = n;
    }
  }

  const lbDns = (config.nameIndex && config.nameIndex.lb && config.nameIndex.lb.dns) || [];
  return {
    classes,
    app,
    certificates,
    dnsEntries,
    access,
    envoyFilters,
    // A failed Services read is unknown, not "no load balancer": null takes the UI's read-gap branch.
    lb: config.nameIndex && !(config.services && config.services.unavailable) ? config.nameIndex.lb : null,
    path: edge.networkPath({
      shootInfo: config.shootInfo,
      services: config.services,
      pods: config.pods,
      nodes: config.nodes,
      dnsEntries,
      envoyFilters,
      access,
      gatewayRows,
      routes,
      gatewaysUnavailable: Boolean(config.gatewaysUnavailable),
      routesUnavailable: Boolean(config.routesUnavailable),
      meshConfig: config.meshConfig,
      serviceEntries: config.serviceentries,
      lbDns,
      destinations: namedDestinations(config.nameIndex),
      destinationSources: (config.nameIndex && config.nameIndex.sources) || null,
      observed: config.observed
    }),
    attention: edge.attentionOf({ certificates, app, hosts: hosts.rows, routes, access, envoyFilters, gatewayRows })
  };
}

/* ------------------------------------------------------------------ collect */

/**
 * @param {object} ctx
 * @param {object} ctx.cluster
 * @param {string} ctx.token
 * @param {string} [ctx.namespace]    restrict the proxies read to one namespace
 * @param {number} [ctx.tailLines]
 * @param {number} [ctx.maxPods]
 * @param {number} [ctx.sinceSeconds]
 * @param {typeof list} [ctx.listFn]
 * @param {typeof text} [ctx.textFn]
 */
/**
 * Tail the `istio-proxy` access log of each selected pod, in parallel, and parse what comes back.
 *
 * Extracted from `collect` because `traces.js` needs the identical read — the same container, the
 * same byte ceiling, the same per-proxy failure vocabulary — and a second copy of this loop is how
 * the two tabs would start disagreeing about what "the window" means. Every field the caller
 * reports in its `window` block is derived from what this returns.
 *
 * One unreadable proxy is never an unreadable tab: it comes back `failed` with a named reason and
 * an empty `requests` array, so the caller counts it rather than folding it into "nothing found".
 *
 * @returns {Promise<{proxy: object, requests: object[], read: number, unparsed: number,
 *   truncated: boolean, failed: boolean, reason: string|null, detail?: string|null}[]>}
 */
async function readProxyLogs({
  baseCtx,
  proxies,
  textFn,
  tailLines,
  sinceSeconds = null,
  container = PROXY_CONTAINER,
  logShare = null,
  maxLogAgeMs = 0
}) {
  return Promise.all(
    proxies.map(async p => {
      const proxy = { pod: p.metadata.name, namespace: p.metadata.namespace, container };
      const read = async tail => {
        const params = new URLSearchParams({
          container,
          tailLines: String(tail),
          limitBytes: String(LOG_LIMIT_BYTES),
          timestamps: 'false'
        });
        if (sinceSeconds) params.set('sinceSeconds', String(sinceSeconds));
        const body = await textFn({
          ...baseCtx,
          path: `/api/v1/namespaces/${encodeURIComponent(p.metadata.namespace)}/pods/${encodeURIComponent(p.metadata.name)}/log?${params}`,
          timeoutMs: LOG_TIMEOUT_MS
        });
        return String(body || '');
      };
      const fetchTail = wanted => fetchCappedTail(read, wanted);
      try {
        /*
          Through the shared read when the router supplied one (see proxy-log-share.js). It reads
          at least SHARED_READ_LINES so the other route's default fits inside it, and hands this
          caller the newest `tailLines` of that — the same lines a direct read returns.
        */
        const got = logShare
          ? await logShare.read({
            baseCtx,
            namespace: proxy.namespace,
            pod: proxy.pod,
            container,
            sinceSeconds,
            tail: tailLines,
            readTail: Math.min(Math.max(tailLines, SHARED_READ_LINES), MAX_TAIL_LINES),
            maxAgeMs: maxLogAgeMs,
            fetch: fetchTail
          })
          : { ...(await fetchTail(tailLines)), at: Date.now() };
        const { raw, tail, byteCapped } = got;
        const split = raw.length ? raw.replace(/\n$/, '').split('\n') : [];
        const requests = [];
        let unparsed = 0;
        for (const line of split) {
          if (!line.trim()) continue;
          const parsed = parseAccessLine(line);
          if (parsed) requests.push({ ...parsed, proxy });
          else unparsed += 1;
        }
        return {
          proxy,
          requests,
          read: split.length,
          unparsed,
          // The tail came back full, or was shortened to fit the byte ceiling: older lines exist
          // that this window never saw.
          truncated: split.length >= tail || tail < tailLines || byteCapped,
          tailLines: tail,
          byteCapped,
          // When these bytes left the kubelet; older than now when the read was shared.
          readAt: got.at,
          failed: false,
          reason: null
        };
      } catch (err) {
        return {
          proxy,
          requests: [],
          read: 0,
          unparsed: 0,
          truncated: false,
          failed: true,
          reason: err && err.status === 403 ? 'FORBIDDEN' : 'UPSTREAM',
          detail: clean(err && err.message)
        };
      }
    })
  );
}

const fullBody = body => Buffer.byteLength(body, 'utf8') >= LOG_LIMIT_BYTES;

/**
 * Close a byte-capped tail with a read of only the lines it is missing.
 *
 * Pod logs come back uncompressed (gzip is ignored on the log subresource), so on a slow link the
 * cost of a read is its bytes. A tail a little over the ceiling used to be re-read almost whole:
 * the approuter sidecar's 500 lines weighed ~540 KB, and the refit fetched 460 KB it largely held
 * already, 12 s on the Ingress tab's critical path (platformsbx, 2026-09-28). Instead, read the
 * newest `missing + GAP_MARGIN_LINES` lines and join them where the capped body's last complete
 * lines reappear. The margin absorbs lines written between the two reads.
 *
 * Returns null, sending the caller to the refit, whenever the join cannot be proven: the gap is
 * more than a quarter of the tail (stitching would carry the window well past the byte budget),
 * the gap read failed or was itself capped, or the anchor lines appear other than exactly once.
 */
const GAP_MARGIN_LINES = 64;
const GAP_MAX_SHARE = 0.25;
const GAP_ANCHOR_LINES = 3;
async function closeGap(read, raw, wanted) {
  const head = raw.split('\n').slice(0, -1); // the last piece is cut mid-line
  const missing = wanted - head.length;
  if (head.length < GAP_ANCHOR_LINES || missing < 1 || missing > wanted * GAP_MAX_SHARE) return null;
  let gapRaw;
  try {
    gapRaw = await read(missing + GAP_MARGIN_LINES);
  } catch {
    return null;
  }
  if (fullBody(gapRaw)) return null;
  const gap = gapRaw.replace(/\n$/, '').split('\n');
  const anchor = head.slice(-GAP_ANCHOR_LINES);
  const found = [];
  for (let end = GAP_ANCHOR_LINES - 1; end < gap.length; end++) {
    const start = end - GAP_ANCHOR_LINES + 1;
    if (anchor.every((line, k) => gap[start + k] === line)) found.push(end);
  }
  if (found.length !== 1) return null;
  const lines = head.concat(gap.slice(found[0] + 1)).slice(-wanted);
  return `${lines.join('\n')}\n`;
}

/**
 * Read a proxy's newest `wanted` lines under LOG_LIMIT_BYTES. `read(tail)` returns one kubelet
 * body for `tailLines=tail`.
 *
 * The kubelet applies `limitBytes` from the START of the tail, not the end: a gateway whose
 * 1000 lines weigh 1.1 MB came back as its oldest 459, half an hour behind the sidecars
 * read beside it, so no request id matched across the two and every gateway→approuter call
 * read as "External clients" (measured on platformsbx, 2026-09-25). When a body reaches the
 * ceiling, first try to close the small gap (closeGap); failing that, re-read with the tail the
 * ceiling holds, so the window always ends at "now".
 *
 * @returns {Promise<{raw: string, tail: number, byteCapped: boolean}>}
 */
async function fetchCappedTail(read, wanted) {
  let tail = wanted;
  let raw = await read(tail);
  if (fullBody(raw)) {
    const stitched = await closeGap(read, raw, wanted);
    if (stitched !== null) return { raw: stitched, tail: wanted, byteCapped: false };
  }
  let refits = 0;
  while (fullBody(raw) && refits < MAX_LOG_REFITS) {
    const whole = raw.split('\n').length - 1; // the last piece is cut mid-line
    const fits = Math.floor(Math.max(whole, 1) * 0.9);
    if (fits < 1 || fits >= tail) break;
    // A re-read that fails keeps the body already in hand: capped, but real, and flagged so.
    let next;
    try {
      next = await read(fits);
    } catch {
      break;
    }
    tail = fits;
    raw = next;
    refits += 1;
  }
  return { raw, tail, byteCapped: fullBody(raw) };
}

/**
 * The two label selectors that find every proxy without the cluster-wide pod list.
 *
 * Istio's injector labels every pod it gives a sidecar `security.istio.io/tlsMode` (classic and
 * native sidecars alike), and every gateway and istiod carries `istio`. On platformsbx the two
 * cover all 41 `istio-proxy` pods in 0.9 MB, against 1.8 MB for all 120 pods (2026-09-26).
 */
const PROXY_DISCOVERY_PATHS = [
  '/api/v1/pods?limit=2000&labelSelector=security.istio.io%2FtlsMode',
  '/api/v1/pods?limit=2000&labelSelector=istio'
];

/** Proxy pods from the two selector reads, or null when either failed: then only the full list decides. */
async function discoverProxyPods(listFn, baseCtx) {
  try {
    const lists = await Promise.all(PROXY_DISCOVERY_PATHS.map(path => listFn({ ...baseCtx, path })));
    const seen = new Map();
    for (const p of lists.flat()) {
      if (p && p.metadata) seen.set(`${p.metadata.namespace}/${p.metadata.name}`, p);
    }
    return [...seen.values()];
  } catch {
    return null;
  }
}

/**
 * Tail the proxies without waiting for the cluster-wide pod list.
 *
 * The full pod list stays: it names every pod IP the access log mentions, and 14 of platformsbx's
 * 120 pods sit behind no Service and run no sidecar, so nothing else names them. But it is the
 * slowest list either route makes (2.6s alone, 6-10s beside the other reads), and the log reads
 * used to queue behind it. Now:
 *
 *   1. the two selector reads find the proxies, and their tails start at once;
 *   2. when the full list lands, the selection is made from IT, exactly as before;
 *   3. any proxy that selection wants and step 1 did not read is read then.
 *
 * So the answer is the one the full list alone gives; the selector reads only decide how early the
 * tails start. Reads for a proxy the final selection dropped are discarded.
 *
 * @param {object} args
 * @param {Promise<{items: object[]}>} args.podsRead     the full pod list
 * @param {Promise<object[]|null>} args.discovery        `discoverProxyPods`
 * @param {Promise<boolean>} args.skipReads              true when the access log provably is not on stdout
 * @param {(pods: object[]) => {selected: object[], skipped: number, candidates: number}} args.select
 * @param {(proxies: object[]) => Promise<object[]>} args.read   `readProxyLogs` for these proxies
 * @param {Promise<object[]|null>} [args.backends] route-backend selectors for the final selection;
 *   the early guess never waits for them, and a rejection selects without them
 */
async function readProxiesEarly({ podsRead, discovery, skipReads, select, read, backends = Promise.resolve(null) }) {
  const keyOf = p => `${p.metadata.namespace}/${p.metadata.name}`;
  // The guess is known as soon as discovery lands, long before its tails do; the late reads start
  // from it, so they never queue behind the slowest early tail (a 10s gateway log on platformsbx
  // made a cold /traces 17s where the slower of the two waves was 11s, 2026-09-27).
  const guessed = (async () => {
    const [found, skip] = await Promise.all([discovery, skipReads]);
    return skip || !found ? [] : select(found, null).selected;
  })();
  const early = guessed.then(async guess => {
    const reads = guess.length ? await read(guess) : [];
    return new Map(reads.map((r, i) => [keyOf(guess[i]), r]));
  });
  // `early` never rejects (discovery and read both absorb their failures), but a rejected
  // `podsRead` returns before awaiting it; the catch keeps that from surfacing as unhandled.
  early.catch(() => {});

  const pods = await podsRead;
  const selection = select(pods.items, await Promise.resolve(backends).catch(() => null));
  if (await skipReads) return { selection, reads: [] };
  const inEarly = new Set((await guessed).map(keyOf));
  const missing = selection.selected.filter(p => !inEarly.has(keyOf(p)));
  const [done, late] = await Promise.all([early, missing.length ? read(missing) : []]);
  missing.forEach((p, i) => done.set(keyOf(p), late[i]));
  return { selection, reads: selection.selected.map(p => done.get(keyOf(p))) };
}

/** The oldest log read behind a window, so a shared tail never dates the answer as fresh. */
function windowReadAt(reads) {
  const stamps = reads.map(r => r && r.readAt).filter(Number.isFinite);
  return new Date(stamps.length ? Math.min(...stamps) : Date.now()).toISOString();
}

async function collect({
  cluster,
  token,
  namespace,
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
  /*
    `sinceSeconds` used to reach the API server as whatever arrived. `Math.max(1, Number(x))` looks
    like a clamp and is not one: `Math.max(1, NaN)` is `NaN`, so `?sinceSeconds=abc` sent the
    literal string `NaN` and the API server rejected the whole log read — every proxy failed, and
    the tab reported a cluster-wide read failure for a bad query string. Clamped like `tailLines`:
    a value that is not a finite number ≥ 1 means "no window restriction", which is the default.
  */
  const sinceRaw = Number(sinceSeconds);
  const since = Number.isFinite(sinceRaw) && sinceRaw >= 1 ? Math.floor(sinceRaw) : null;

  /*
    The three reads the log tails depend on go out first, then the two selector reads that find the
    proxies, then everything else: the per-cluster gate is first come, first served, so this order
    is what lets the tails start while the rest of the config is still arriving. See readProxiesEarly.
  */
  const telemetriesRead = safeList(listFn, baseCtx, `/apis/${TELEMETRY_GROUP}/${ISTIO_VERSION}/telemetries`, 'telemetries');
  const podsRead = requiredList('pods', () => listFn({ ...baseCtx, path: '/api/v1/pods?limit=2000' }));
  // One ConfigMap, fetched as a one-item list with a field selector so it flows through the
  // same safeList degradation as every other read. This is the lookup that tells a provider
  // writing to stdout apart from one streaming to an OTLP gateway.
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
  const registryRead = registryOf({ registryShare, listFn, baseCtx, maxAgeMs: maxLogAgeMs ? undefined : 0 });
  const proxyReads = readProxiesEarly({
    podsRead,
    discovery: discoverProxyPods(listFn, baseCtx),
    skipReads,
    backends: registryRead.then(reg => routeBackendSelectors(reg.routes, reg.reads.services)).catch(() => null),
    select: (items, backends) => selectProxies(items, { namespace, maxPods: podBudget, backends }),
    read: proxies =>
      readProxyLogs({ baseCtx, proxies, textFn, tailLines: lines, sinceSeconds: since, logShare, maxLogAgeMs })
  });

  const [
    telemetries,
    pods,
    services,
    endpointslices,
    nodes,
    gateways,
    meshConfig,
    virtualservices,
    apirules,
    hpas,
    pdbs,
    certificates,
    dnsentries,
    authorizationpolicies,
    peerauthentications,
    envoyfilters,
    serviceentries,
    shootInfo,
    registry,
    proxyRead
  ] = await Promise.all([
    telemetriesRead,
    podsRead,
    safeList(listFn, baseCtx, '/api/v1/services?limit=2000', 'services'),
    safeList(listFn, baseCtx, `/apis/${DISCOVERY_GROUP}/v1/endpointslices?limit=2000`, 'endpointslices'),
    safeList(listFn, baseCtx, '/api/v1/nodes', 'nodes'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/gateways`, 'istio-gateways'),
    meshConfigRead,
    // The two objects that declare an ingress host. Both feed `buildRouteIndex`, which answers
    // "who is supposed to be serving this host" on every row of the Hosts table.
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/virtualservices?limit=2000`, 'virtualservices'),
    safeList(listFn, baseCtx, `/apis/${APIGATEWAY_GROUP}/${APIRULE_VERSION}/apirules?limit=2000`, 'apirules'),
    /*
      Cluster-wide, not `istio-system`-scoped. Scoping to the Istio namespace would be a smaller
      read and would introduce a blind spot the screen could not report: a cluster running a second
      gateway deployment in its own namespace would show gateway pods with no autoscaler and no
      disruption budget, which reads as "none configured" rather than "not looked for". Both Kinds
      hold a handful of tiny objects per cluster and `autoscaling.js`/`policy.js` already read them
      cluster-wide, so the honest read is also the cheap one.
    */
    safeList(listFn, baseCtx, '/apis/autoscaling/v2/horizontalpodautoscalers?limit=500', 'ingress-hpa'),
    safeList(listFn, baseCtx, '/apis/policy/v1/poddisruptionbudgets?limit=500', 'ingress-pdb'),
    /*
      The config the edge is built from. Each is a handful of small objects per cluster, read once
      per /traffic-errors fill (the k8s list cache and the 15s route cache sit in front of it).
    */
    safeList(listFn, baseCtx, '/apis/cert.gardener.cloud/v1alpha1/certificates?limit=500', 'certificates'),
    safeList(listFn, baseCtx, '/apis/dns.gardener.cloud/v1alpha1/dnsentries?limit=500', 'dnsentries'),
    safeList(listFn, baseCtx, '/apis/security.istio.io/v1/authorizationpolicies?limit=500', 'authorizationpolicies'),
    safeList(listFn, baseCtx, '/apis/security.istio.io/v1/peerauthentications?limit=500', 'peerauthentications'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/v1alpha3/envoyfilters?limit=500`, 'envoyfilters'),
    safeList(listFn, baseCtx, `/apis/${NETWORKING_GROUP}/${ISTIO_VERSION}/serviceentries?limit=500`, 'serviceentries'),
    // Gardener's facts about the shoot: provider, region, CIDRs, and the NAT addresses egress leaves by.
    safeList(listFn, baseCtx, '/api/v1/namespaces/kube-system/configmaps?fieldSelector=metadata.name%3Dshoot-info', 'shoot-info'),
    registryRead,
    proxyReads
  ]);
  const nameIndex = registry.names;
  const nameReads = registry.reads.nameReads;

  const mesh = meshProviders(meshConfig);
  const accessLog = accessLogVerdict(telemetries, mesh);
  const index = buildIndex({ pods, services, endpointslices, nodes, gateways });
  const routes = buildRouteIndex({ virtualservices, apirules });
  const corporate = corporateSuffixes(process.env.FLEET_CORPORATE_DOMAIN_SUFFIXES);

  const { selected, skipped, candidates } = proxyRead.selection;

  /*
    Read the proxies unless we have PROVEN there is nothing on their stdout to read.

    The guard needs BOTH halves. `readable === false` is deliberately narrow — every enabling
    Telemetry CR named a provider, every name resolved in the mesh config, and not one writes to
    a stream. `null` (unreadable mesh config, a provider the CR names that the mesh does not
    declare, an implementation key this build does not know) always reads, because a wrong skip
    costs a screen of zeros and a wrong read costs four seconds.

    `state === 'on'` is the half that is easy to drop and was: the `off` verdict also reports
    `readable: false`, and skipping on that alone stopped reading whenever no Telemetry CR
    enabled logging. That is not the same statement. `meshConfig.accessLogFile` turns the access
    log on mesh-wide with no Telemetry CR in sight, so "no CR enables it" is evidence about the
    CRs, not about the proxies. Only the `on` branch has actually resolved a provider and can
    say where its bytes go.

    Skipping is not an optimisation dressed up as correctness: ten pod-log reads against an
    empty stream produce exactly the "0 errors" the verdict has just finished explaining is
    meaningless, and `window` would report a 10-proxy 3000-line read as evidence for it.
  */
  const readsSkipped = accessLog.state === 'on' && accessLog.readable === false;
  // Already read, from the start of this collection; see readProxiesEarly.
  const reads = readsSkipped ? [] : proxyRead.reads;

  const requests = reads.flatMap(r => r.requests);
  const errors = requests.filter(r => classOf(r.code) !== 'ok');
  const groups = nameFailureGroups(aggregate(errors, index), nameIndex);

  /*
    Which of the proxies that were read are the ingress tier — the set the whole ingress block is
    scoped to. Built from the pods actually read and successfully read: an ingress gateway that was
    selected and then answered 403 contributes no records, so counting it as a contributor would
    describe the window as wider than it is. The ones that dropped out are named rather than
    subtracted silently, because "2 of 3 gateway pods" changes how an operator reads every number
    underneath it.
  */
  const ingressSelected = selected
    .filter(isIngressProxy)
    .map(p => `${p.metadata.namespace}/${p.metadata.name}`);
  const ingressKeys = new Set(
    reads
      .filter(r => !r.failed && ingressSelected.includes(`${r.proxy.namespace}/${r.proxy.pod}`))
      .map(r => `${r.proxy.namespace}/${r.proxy.pod}`)
  );
  const ingressUnread = ingressSelected.filter(k => !ingressKeys.has(k)).sort();

  // A group read only on the ingress gateways gets its edge class, so scanners leave "App failed".
  for (const g of groups) {
    if (!g.proxies.length || !g.proxies.every(p => ingressKeys.has(`${p.namespace}/${p.pod}`))) continue;
    g.edgeClass = edge.classifyEdgeRecord({ authority: g.authority, responseCodeDetails: g.responseCodeDetails[0] || '' }, { gatewayHosts: index.gatewayHosts || [], routes });
    g.bucket = edge.errorBucket(g, g.edgeClass);
  }

  const byCode = new Map();
  for (const r of requests) {
    const entry = byCode.get(r.code) || { code: r.code, class: classOf(r.code), count: 0 };
    entry.count += 1;
    byCode.set(r.code, entry);
  }

  const stamps = requests.map(r => r.startTime).filter(Boolean).sort();

  return {
    cluster: {
      id: cluster.id,
      displayName: cluster.displayName || cluster.id,
      env: cluster.env || 'unknown'
    },
    accessLog,
    window: {
      proxiesRead: reads.filter(r => !r.failed).length,
      // True when the tab deliberately read nothing because `accessLog.readable` is false.
      // Without this the window reads identically to a read that found an empty log, and the
      // UI would have to infer the difference from a zero — the exact inference this tab exists
      // to make unnecessary.
      readsSkipped,
      proxiesFailed: reads.filter(r => r.failed).map(r => ({
        pod: r.proxy.pod,
        namespace: r.proxy.namespace,
        reason: r.reason,
        detail: r.detail || null
      })),
      proxyCandidates: candidates,
      proxiesSkipped: skipped,
      tailLines: lines,
      namespace: namespace || null,
      sinceSeconds: since,
      linesRead: reads.reduce((n, r) => n + r.read, 0),
      requestsParsed: requests.length,
      linesUnparsed: reads.reduce((n, r) => n + r.unparsed, 0),
      truncatedProxies: reads.filter(r => r.truncated).length,
      oldest: stamps[0] || null,
      newest: stamps[stamps.length - 1] || null
    },
    summary: {
      requests: requests.length,
      errors: errors.length,
      server: errors.filter(r => classOf(r.code) === 'server').length,
      client: errors.filter(r => classOf(r.code) === 'client').length,
      noResponse: errors.filter(r => classOf(r.code) === 'no-response').length,
      groups: groups.length,
      byCode: [...byCode.values()].sort((a, b) => b.count - a.count),
      unavailable: unavailableLabels([
        telemetries,
        services,
        endpointslices,
        nodes,
        gateways,
        meshConfig,
        virtualservices,
        apirules,
        hpas,
        pdbs,
        certificates,
        dnsentries,
        authorizationpolicies,
        peerauthentications,
        envoyfilters,
        serviceentries,
        shootInfo,
        ...nameReads
      ]),
      truncated: truncatedLabels([
        pods,
        services,
        endpointslices,
        nodes,
        gateways,
        virtualservices,
        apirules,
        hpas,
        pdbs,
        certificates,
        dnsentries,
        authorizationpolicies,
        peerauthentications,
        envoyfilters,
        serviceentries,
        ...nameReads
      ])
    },
    errors: groups,
    // All traffic in the same window, grouped for latency rather than for failure. Free: the
    // durations were already parsed and then dropped. See `aggregateLatency`.
    latency: aggregateLatency(requests, index),
    // The same window again, scoped to the ingress tier and grouped by the things only the edge
    // sees: the Host header a client sent, the listener it arrived on, the peer that sent it.
    ingress: {
      ...aggregateIngress({
        records: requests,
        index,
        ingressKeys,
        corporate,
        routes,
        gateways: ingressGatewayRows(gateways),
        tier: ingressTier({ pods, services, hpas, pdbs }),
        config: {
          certificates,
          dnsentries,
          authorizationpolicies,
          peerauthentications,
          envoyfilters,
          serviceentries,
          shootInfo,
          services,
          pods,
          nodes,
          meshConfig,
          nameIndex,
          gatewaysUnavailable: Boolean(gateways && gateways.unavailable),
          routesUnavailable: Boolean(virtualservices.unavailable || apirules.unavailable),
          observed: edge.observedEgress(requests, { ingressKeys, isPrivate, splitHostPort, nameOf, isTelemetryExporter, nameIndex })
        }
      }),
      ingressProxiesSelected: ingressSelected.length,
      /** Gateway pods this read chose and did not get — a 403 or a timeout, already named above. */
      ingressProxiesUnread: ingressUnread,
      /** Every request a proxy refused, edge and sidecars, with the policy that decided it (refusals.js). */
      refused: refusalsOf(requests, {
        gatewayKeys: ingressKeys,
        podLabels: new Map(((pods && pods.items) || []).map(p => [`${p.metadata.namespace}/${p.metadata.name}`, p.metadata.labels || {}])),
        authorizationPolicies: authorizationpolicies,
        classOf: r => edge.classifyEdgeRecord(r, { gatewayHosts: index.gatewayHosts || [], routes })
      }),
      /** Which declaring objects were readable. A missing APIRule read is why a host says "not declared". */
      routesFrom: {
        virtualservices: virtualservices.unavailable ? null : (virtualservices.items || []).length,
        apirules: apirules.unavailable ? null : (apirules.items || []).length
      }
    },
    collectedAt: windowReadAt(reads)
  };
}

export default {
  collect,
  // Exported for the tests: each is a decision worth pinning independently of a live cluster.
  accessLogVerdict,
  classifyProvider,
  meshProviders,
  parseAccessLine,
  readProxyLogs,
  fetchCappedTail,
  readProxiesEarly,
  discoverProxyPods,
  windowReadAt,
  PROXY_DISCOVERY_PATHS,
  SHARED_READ_LINES,
  LOG_LIMIT_BYTES,
  parseUpstreamCluster,
  buildIndex,
  resolveAddress,
  matchGateway,
  selectProxies,
  gatewayHostsOf,
  readRegistry,
  registryOf,
  aggregate,
  aggregateLatency,
  isHttpRecord,
  latencyOf,
  percentile,
  redactUrl,
  clean,
  classOf,
  isPrivate,
  // The ingress block. Each of these is a grouping decision the live cluster can only confirm,
  // never specify — so each is pinned by a test that feeds it hand-written lines.
  isIngressProxy,
  httpFamily,
  corporateSuffixes,
  hostKeyOf,
  classifyHost,
  buildRouteIndex,
  routeBackendSelectors,
  matchRoutes,
  decodeResponseFlag,
  spanWeightedRate,
  aggregateHosts,
  aggregateClients,
  aggregateFlags,
  aggregateListeners,
  ingressGatewayRows,
  ingressTier,
  aggregateIngress,
  NO_HOST_KEY,
  MIN_RATE_SPAN_SECONDS,
  MAX_INGRESS_HOSTS,
  MAX_INGRESS_CLIENTS,
  MAX_LISTENER_REJECTIONS,
  MAX_PODS,
  DEFAULT_TAIL_LINES,
  MAX_TAIL_LINES
};
