/**
 * One request classifier for Traces and Ingress & Traffic, so a scanner's 403 is a security
 * refusal on both tabs and never an application error. First match wins, in this order:
 *
 *   direct-or-tls     no filter chain, or (at the edge) a Host that is absent, an address, or
 *                     admitted by no Gateway and no route
 *   security-refused  an AuthorizationPolicy refused it (`rbac_access_denied…`)
 *   probe             a `healthz.` host, or a liveness path (`POLL_RULES`) that succeeded, when `polls`
 *   platform          a Kyma system host prefix, or a route into a system namespace
 *   egress-declared   outbound to an external address the egress registry names
 *   egress-undeclared outbound to an external address no source names, the policies read
 *   egress-unverified the same with the NetworkPolicy list unread: unknown, never "undeclared"
 *   app               everything else
 *
 * `edge.classifyEdgeRecord` maps these back to the Ingress tab's own names, so its counts do not
 * move. An app error is `app` with a 5xx or an upstream-failure flag on any hop of the journey.
 */
import destinationNamesModule from '../destination-names.js';
const { nameOf } = destinationNamesModule;

/**
 * Request paths that are a client or probe asking "are you alive", not work. One browser tab left
 * open on a Streamlit app answers `/_stcore/health` and `/_stcore/host-config` every few seconds;
 * measured on platformsbx they were two thirds of 3,000 lines and every kept slot, so the newest
 * 200 journeys held no request anyone made on purpose.
 *
 * Path only: `user_agent` is dropped at parse time (it can identify a customer's device), so
 * "kube-probe/" cannot be used. `/_stcore/stream` is deliberately absent — it is the user's
 * session socket, and its failures are the finding, not noise. A poll that failed is never hidden
 * (see `hiddenAs`): a failing health check is exactly what an operator opened this tab to see.
 */
const POLL_RULES = [
  ['Streamlit health', /^\/_stcore\/(?:health|host-config)$/],
  ['Health check', /^\/(?:healthz?|livez|readyz|ready|live|liveness|readiness|ping|healthcheck)\/?$/],
  ['Istio readiness', /^\/(?:healthz\/ready|app-health\/[^/]+\/(?:livez|readyz|startupz))$/],
  ['Spring Actuator', /^\/actuator\/(?:health|info|prometheus)(?:\/.*)?$/],
  ['Quarkus health', /^\/q\/(?:health|metrics)(?:\/.*)?$/],
  ['Metrics scrape', /^\/(?:metrics|stats\/prometheus)\/?$/]
];

/** Which poll a request path is, or null. The query string and case do not change the answer. */
function pollOf(path) {
  if (!path) return null;
  const bare = String(path).split('?')[0].toLowerCase();
  const rule = POLL_RULES.find(([, re]) => re.test(bare));
  return rule ? rule[0] : null;
}

const SYSTEM_NAMESPACES = new Set(['kyma-system', 'istio-system', 'compass-system', 'kcp-system', 'kube-system']);
/** Platform hosts a stock Kyma cluster serves for itself (tunnels, the application connector). */
const PLATFORM_HOST_PREFIXES = ['cp.', 'healthcheck.cp.', 'gateway.', 'compass-', 'connectivity-'];
/** Timeouts and upstream failures: the app, or the path to it, did not answer. */
const APP_FAILURE_FLAGS = new Set(['UT', 'UF', 'URX', 'UH', 'NR']);
/** Classes the Endpoints table leaves out by default: nobody's work, so nobody's latency. */
const NOISE_CLASSES = new Set(['probe', 'security-refused', 'direct-or-tls']);

function hostOf(authority) {
  const s = String(authority || '').trim().toLowerCase();
  if (!s) return null;
  const v6 = /^\[(.+)\](?::\d+)?$/.exec(s);
  if (v6) return `[${v6[1]}]`;
  const cut = s.indexOf(':');
  if (cut > 0 && cut === s.lastIndexOf(':') && /^\d+$/.test(s.slice(cut + 1))) return s.slice(0, cut);
  return s;
}

function isAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[.+\]$/.test(host);
}

/** A Gateway server host (`ns/host` allowed) or a route host admitting `host`, one label deep for `*.`. */
function admits(pattern, host) {
  // `buildAddressIndex` hands over `{host, name, namespace, ...}` rows; a string pattern is fine too.
  const raw = pattern && typeof pattern === 'object' ? pattern.host : pattern;
  const p = String(raw || '').toLowerCase();
  const bare = p.includes('/') ? p.slice(p.indexOf('/') + 1) : p;
  if (bare === '*' || bare === host) return true;
  return bare.startsWith('*.') && host.endsWith(bare.slice(1));
}

/** Route hosts in APIRule v2 may be short names the controller prefixes to the gateway domain. */
function routeAdmits(routeHost, host) {
  if (admits(routeHost, host)) return true;
  return !routeHost.includes('.') && !routeHost.includes('*') && host.startsWith(`${routeHost}.`);
}

const flagsOf = v => String(v || '').split(/[,\s]+/).filter(Boolean);
const failed = r => Number(r.code) >= 500 || flagsOf(r.responseFlags).some(f => APP_FAILURE_FLAGS.has(f));
/**
 * A probe answer that is not the honest "alive": a 4xx is neither `failed()`'s 5xx nor an
 * `APP_FAILURE_FLAGS` flag, but a health check erroring or being refused is still not the
 * probe succeeding, and must not be hidden in the probe bucket `NOISE_CLASSES` drops by
 * default. Wider than `failed()` on purpose — `failed()` also gates `classifyJourney`'s
 * `appError`, where a refused 4xx is deliberately not an app error (see request-class.test.js).
 */
const probeFailed = r => failed(r) || Number(r.code) >= 400;

/**
 * The class of one record or hop.
 *
 * @param {object} r access-log record or Traces hop (`authority`, `path`, `code`, `responseCodeDetails`, `responseFlags`)
 * @param {object} ctx
 * @param {object} [ctx.registry]     `buildNameIndex` output; its NetworkPolicy read decides undeclared vs unverified
 * @param {object[]} [ctx.routes]     `buildRouteIndex` entries
 * @param {object[]} [ctx.gatewayHosts] Gateway server host patterns
 * @param {'edge'|'inbound'|'outbound'} [ctx.direction] the Host rules apply at the edge only
 * @param {object} [ctx.upstream]     `{kind, ip}` of an outbound record's destination
 * @param {object} [ctx.caller]       `{namespace, name}` of the proxy that opened it (telemetry naming)
 * @param {boolean} [ctx.polls]       count liveness paths as probes (false keeps the Ingress rule)
 * @param {boolean} [ctx.hostsUnknown] the Gateways and every route source went unread, so no host can be judged unadmitted
 */
function classify(r, { registry = null, routes = [], gatewayHosts = [], direction = 'edge', upstream = null, caller = null, polls = true, hostsUnknown = false } = {}) {
  const details = String(r.responseCodeDetails || '');
  if (details.includes('filter_chain_not_found')) return 'direct-or-tls';
  const host = hostOf(r.authority);
  const hitRoutes = host ? routes.filter(x => routeAdmits(x.host, host)) : [];
  if (direction === 'edge') {
    if (!host || isAddress(host) || host === 'localhost') return 'direct-or-tls';
    // Unread is not empty: every host would class direct-IP and the app counts read a confident 0.
    if (!hostsUnknown && !gatewayHosts.some(g => admits(g, host)) && !hitRoutes.length) return 'direct-or-tls';
  }
  if (details.startsWith('rbac_access_denied')) return 'security-refused';
  if (host && host.startsWith('healthz.')) return 'probe';
  // A poll that failed is the finding, not noise (see POLL_RULES).
  if (polls && pollOf(r.path) && !probeFailed(r)) return 'probe';
  if (host && PLATFORM_HOST_PREFIXES.some(p => host.startsWith(p))) return 'platform';
  // Most specific route decides: a wildcard system route must not swallow an app's own host.
  const specific = hitRoutes.filter(x => x.host !== '*').sort((a, b) => b.host.length - a.host.length)[0];
  if (specific && SYSTEM_NAMESPACES.has(specific.namespace)) return 'platform';
  if (direction === 'outbound' && upstream && upstream.kind === 'external' && upstream.ip) {
    if (nameOf(registry, upstream.ip, { caller })) return 'egress-declared';
    return registry && registry.sources && registry.sources.networkPolicies === 'ok' ? 'egress-undeclared' : 'egress-unverified';
  }
  return 'app';
}

/** A Traces hop's direction: the gateway's is the edge; a sidecar's follows its upstream cluster. */
function directionOfHop(h) {
  if (h.role === 'ingress') return 'edge';
  return h.to && h.to.direction === 'inbound' ? 'inbound' : 'outbound';
}

/** A journey's class, from its edge hop when a gateway logged it, else its first hop. */
function classifyJourney(trace, ctx) {
  const hops = (trace && trace.hops) || [];
  const first = hops.find(h => h.role === 'ingress') || hops[0];
  if (!first) return { class: 'app', appError: false };
  const cls = classify(first, {
    ...ctx,
    direction: directionOfHop(first),
    upstream: first.to || null,
    caller: first.observedBy ? { namespace: first.observedBy.namespace, name: first.observedBy.pod } : null
  });
  return { class: cls, appError: cls === 'app' && hops.some(failed) };
}

export default {
  classify,
  classifyJourney,
  directionOfHop,
  pollOf,
  POLL_RULES,
  NOISE_CLASSES,
  APP_FAILURE_FLAGS,
  SYSTEM_NAMESPACES,
  PLATFORM_HOST_PREFIXES,
  hostOf,
  isAddress,
  admits,
  routeAdmits
};
