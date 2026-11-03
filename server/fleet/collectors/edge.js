/**
 * The edge, classified: what each ingress-gateway record *was*, before anything is counted.
 *
 * ## Why classify first
 *
 * Measured on a live cluster: of 303 HTTP requests the gateways logged, 238 were the `healthz.`
 * probe, 58 were refused by an IP-allowlist AuthorizationPolicy, 155 more connections never got
 * past TLS, and **5** were application traffic. An error share over all of them (20.5 %) was
 * the allowlist rejecting scanners, and the headline p95 of 1 ms was the probe. Neither answered
 * "are my apps OK at the edge". So every record gets exactly one class, first match wins:
 *
 *   tls-rejected    no filter chain accepted the connection (`filter_chain_not_found`)
 *   direct-ip       Host is an address, loopback, missing, or admitted by no Gateway and no route
 *   policy-blocked  an AuthorizationPolicy refused it (`rbac_access_denied*`)
 *   probe           the platform's own health probe (`healthz.`)
 *   platform        routed to a system namespace
 *   app             everything else: published application traffic
 *
 * Counts are over the sample the Traffic tab read. Nothing here is a rate or a total.
 *
 * Also here: the config the edge is built from — cert-manager Certificates, AuthorizationPolicies,
 * PeerAuthentications, EnvoyFilters — each joined to the Gateway servers, and the attention list
 * derived from all of it. Every join is by declared name, never by resemblance.
 */

import requestClassModule from './request-class.js';
const { classify, hostOf, isAddress, admits, routeAdmits } = requestClassModule;

const CLASS_ORDER = ['tls-rejected', 'direct-ip', 'policy-blocked', 'probe', 'platform', 'app'];
/** p95 below this many samples is a statement about a handful of requests; it is withheld. */
const MIN_P95_SAMPLES = 20;
/*
  cert-manager renews on its own at `status.renewalTime` (by default two thirds into the
  certificate's life), so a certificate 39 days from expiry is steady state, not a warning. A
  certificate is a finding only when its renewal time has passed without a new one, or it is inside
  the last week. Without a renewal time the warning falls back to the same 30 days.
*/
const CERT_CRITICAL_DAYS = 7;
const CERT_WARNING_DAYS = 30;
const MAX_ATTENTION = 40;
const MAX_REGEX_SOURCE = 200;

const DAY_MS = 86_400_000;

function detailsOf(r) {
  return String(r.responseCodeDetails || '');
}

/**
 * The class of one record. `ctx.gatewayHosts` are Gateway server host patterns, `ctx.routes` the
 * `buildRouteIndex` entries. `request-class.js` decides; this maps its names back to the Ingress
 * tab's own, and leaves liveness paths to the `healthz.` host rule, so the edge counts do not move.
 */
function classifyEdgeRecord(r, { gatewayHosts = [], routes = [] } = {}) {
  const c = classify(r, { gatewayHosts, routes, direction: 'edge', polls: false });
  if (c === 'direct-or-tls') return detailsOf(r).includes('filter_chain_not_found') ? 'tls-rejected' : 'direct-ip';
  if (c === 'security-refused') return 'policy-blocked';
  return c;
}

function nearestRank(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

/**
 * Class breakdown and the app-traffic headline.
 *
 * @param {object[]} records ingress-scoped records
 * @returns {{classes: object, app: object, classOf: (r: object) => string}}
 */
function edgeClasses(records, ctx) {
  const memo = new Map();
  const classOf = r => {
    if (!memo.has(r)) memo.set(r, classifyEdgeRecord(r, ctx));
    return memo.get(r);
  };
  const rows = new Map(CLASS_ORDER.map(k => [k, { key: k, records: 0, requests: 0, codes: new Map() }]));
  const app = { requests: 0, errors: 0, server: 0, client: 0, notFound: 0, durations: [], hosts: new Map() };

  for (const r of records) {
    const c = classOf(r);
    const row = rows.get(c);
    row.records += 1;
    if (r.method) {
      row.requests += 1;
      bump(row.codes, r.code);
    }
    if (c !== 'app' || !r.method) continue;
    app.requests += 1;
    const code = Number(r.code);
    const failed = code === 0 || code >= 400;
    if (failed) app.errors += 1;
    if (code >= 500) app.server += 1;
    else if (code >= 400) app.client += 1;
    if (code === 404) app.notFound += 1;
    const d = r.upstreamMs !== null && r.upstreamMs !== undefined ? r.upstreamMs : r.duration;
    if (d !== null && d !== undefined && Number.isFinite(Number(d))) app.durations.push(Number(d));
    const host = hostOf(r.authority) || '(no host header)';
    const h = app.hosts.get(host) || { host, requests: 0, errors: 0, server: 0, notFound: 0 };
    h.requests += 1;
    if (failed) h.errors += 1;
    if (code >= 500) h.server += 1;
    if (code === 404) h.notFound += 1;
    app.hosts.set(host, h);
  }

  const sorted = app.durations.sort((a, b) => a - b);
  const enough = sorted.length >= MIN_P95_SAMPLES;
  return {
    classOf,
    classes: {
      rows: [...rows.values()].map(r => ({
        key: r.key,
        records: r.records,
        requests: r.requests,
        codes: [...r.codes].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code)
      })),
      total: records.length
    },
    app: {
      requests: app.requests,
      errors: app.errors,
      server: app.server,
      client: app.client,
      notFound: app.notFound,
      samples: sorted.length,
      minSamples: MIN_P95_SAMPLES,
      /** Upstream service time where logged, else the whole request: the app's share of latency. */
      p50Ms: sorted.length ? nearestRank(sorted, 0.5) : null,
      p95Ms: enough ? nearestRank(sorted, 0.95) : null,
      hosts: [...app.hosts.values()].sort((a, b) => b.server - a.server || b.errors - a.errors || b.requests - a.requests || a.host.localeCompare(b.host))
    }
  };
}

/** The class a host row gets: the class of most of its records. */
function hostClass(records, classOf) {
  const counts = new Map();
  for (const r of records) bump(counts, classOf(r));
  let best = null;
  for (const k of CLASS_ORDER) if (counts.has(k) && (!best || counts.get(k) > counts.get(best))) best = k;
  return best;
}

/* ------------------------------------------------------------------ config objects */

function daysLeft(iso, now) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.floor((t - now) / DAY_MS) : null;
}

function readyOf(obj) {
  const st = (obj && obj.status) || {};
  const c = (st.conditions || []).find(x => x.type === 'Ready');
  return c ? c.status === 'True' : null;
}

/** cert-manager Certificates, joined to the Gateway servers whose `credentialName` is their Secret. */
function certificateRows(certificates, gatewayRows, now = Date.now()) {
  if (!certificates || certificates.unavailable) {
    return { items: [], unavailable: Boolean(certificates && certificates.unavailable), reason: (certificates && certificates.reason) || null };
  }
  const items = (certificates.items || []).map(c => {
    const spec = c.spec || {};
    const secretName = spec.secretName || null;
    const st = c.status || {};
    const expires = st.notAfter || null;
    const renewal = Date.parse(st.renewalTime || '');
    return {
      namespace: c.metadata.namespace,
      name: c.metadata.name,
      secretName,
      commonName: spec.commonName || null,
      dnsNames: spec.dnsNames || [],
      expires,
      daysLeft: daysLeft(expires, now),
      ready: readyOf(c),
      renewalDate: st.renewalTime || null,
      /** True once the renewal time passed and the same certificate is still in place. */
      renewalOverdue: Number.isFinite(renewal) ? renewal < now : null,
      issuer: (spec.issuerRef && spec.issuerRef.name) || null,
      usedBy: gatewayRows.filter(g => g.credentialName && g.credentialName === secretName).map(g => g.key)
    };
  });
  items.sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.name.localeCompare(b.name));
  return { items, unavailable: false, reason: null };
}

/** Gateway server → Certificate for one host. `null` parts are gaps, not zeros. */
function hostChain(host, { gatewayRows, certificates, gatewaysUnavailable = false }) {
  if (!host || isAddress(host)) return null;
  const servers = gatewayRows
    .filter(g => g.hosts.some(h => admits(h, host)))
    .map(g => {
      // `undefined` when the Certificate read failed: the missing certificate is unknown, not a gap.
      const cert = !g.credentialName ? null : certificates.unavailable ? undefined : certificates.items.find(c => c.secretName === g.credentialName) || null;
      return {
        gateway: `${g.namespace}/${g.name}`,
        key: g.key,
        port: g.port,
        tlsMode: g.tlsMode,
        credentialName: g.credentialName,
        certificate: cert === undefined ? undefined : cert ? { namespace: cert.namespace, name: cert.name, expires: cert.expires, daysLeft: cert.daysLeft, ready: cert.ready } : null
      };
    });
  return {
    /** `undefined` on the wire is absent: the Gateway read failed, so the gap is unknown. */
    servers: gatewaysUnavailable ? undefined : servers
  };
}

function labelsMatch(selector, labels) {
  const m = (selector && selector.matchLabels) || {};
  return Object.entries(m).every(([k, v]) => labels[k] === v);
}

/** The Istio version istiod runs, from its image tag. `null` when it cannot be read. */
function istioVersionOf(pods) {
  if (!pods || pods.unavailable) return null;
  for (const p of pods.items || []) {
    const labels = (p.metadata && p.metadata.labels) || {};
    if (labels.app !== 'istiod') continue;
    for (const c of (p.spec && p.spec.containers) || []) {
      const m = /:(\d+\.\d+\.\d+)/.exec(c.image || '');
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Whether each EnvoyFilter can apply to the proxies running now. A `proxyVersion` match is a regex
 * Istio tests against the proxy's version; one that cannot match the running version never loads.
 */
function envoyFilterRows(envoyfilters, istioVersion) {
  if (!envoyfilters || envoyfilters.unavailable) {
    return { istioVersion, items: [], dead: 0, unavailable: Boolean(envoyfilters && envoyfilters.unavailable), reason: (envoyfilters && envoyfilters.reason) || null };
  }
  const items = (envoyfilters.items || []).map(f => {
    const patches = ((f.spec || {}).configPatches) || [];
    const versions = [...new Set(patches.map(p => (((p || {}).match || {}).proxy || {}).proxyVersion).filter(Boolean))];
    let applies = true;
    if (versions.length) {
      if (!istioVersion) applies = null;
      else {
        applies = versions.some(v => {
          if (String(v).length > MAX_REGEX_SOURCE) return false;
          try { return new RegExp(v).test(istioVersion); } catch { return false; }
        });
      }
    }
    return {
      namespace: f.metadata.namespace,
      name: f.metadata.name,
      proxyVersion: versions.length ? versions.join(' | ') : null,
      workloadSelector: ((f.spec || {}).workloadSelector || {}).labels || null,
      applies,
      proxyProtocol: JSON.stringify(f.spec || {}).includes('proxy_protocol')
    };
  });
  items.sort((a, b) => Number(a.applies !== false) - Number(b.applies !== false) || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
  return { istioVersion, items, dead: items.filter(i => i.applies === false).length, unavailable: false, reason: null };
}

/** `rbac_access_denied_matched_policy[ns[istio-system]-policy[deny-x]-rule[0]]` → the policy, or 'none'. */
function deniedPolicyOf(details) {
  const m = /^rbac_access_denied_matched_policy\[(.*)\]$/.exec(details);
  if (!m) return null;
  if (m[1] === 'none') return 'none';
  const ns = /ns\[([^\]]+)\]/.exec(m[1]);
  const pol = /policy\[([^\]]+)\]/.exec(m[1]);
  return ns && pol ? `${ns[1]}/${pol[1]}` : m[1];
}

/**
 * The LB Service fronting the ingress workload, already-read (`services`), never a second Service
 * lookup. `hostname` is a DNS name; when the Service was only given an IP that fact is said in
 * words (`addressOnly`), the IP itself is never returned. `sourceRangesCount` is the length of
 * `loadBalancerSourceRanges` read, 0 only when the field was really read and is empty.
 */
function lbServiceOf(services, gatewayLabels) {
  if (!services || services.unavailable) return null;
  const svc = (services.items || []).find(s => labelsMatch({ matchLabels: (s.spec || {}).selector }, gatewayLabels || {}) && (s.spec || {}).type === 'LoadBalancer');
  if (!svc) return null;
  const ingress = ((svc.status || {}).loadBalancer || {}).ingress || [];
  const hostname = ingress.map(i => i.hostname).find(Boolean) || null;
  const addressOnly = !hostname && ingress.some(i => i.ip);
  const ranges = (svc.spec || {}).loadBalancerSourceRanges;
  return {
    type: (svc.spec || {}).type || null,
    hostname,
    addressOnly,
    externalTrafficPolicy: (svc.spec || {}).externalTrafficPolicy || null,
    // The Service was read successfully: an absent key and a present-but-empty array are both
    // "no source ranges configured", i.e. 0. `null` is reserved for `!svc`/`services.unavailable`.
    sourceRangesCount: Array.isArray(ranges) ? ranges.length : 0
  };
}

/**
 * The Gateways that select the ingress workload, already-read (`gateways`): their hosts, TLS mode
 * and `credentialName` (a name only, never the Secret's contents). A Gateway with no selector, or
 * an empty one, does not vacuously match every workload — mirrors `accessControl()`'s `applies()`.
 */
function gatewaysOf(gateways, gatewayLabels) {
  if (!gateways || gateways.unavailable) return null;
  return (gateways.items || [])
    .filter(g => {
      const sel = (g.spec || {}).selector;
      return sel && Object.keys(sel).length > 0 && labelsMatch({ matchLabels: sel }, gatewayLabels || {});
    })
    .map(g => ({
      namespace: g.metadata.namespace,
      name: g.metadata.name,
      servers: ((g.spec || {}).servers || []).map(s => ({
        hosts: s.hosts || [],
        tlsMode: ((s.tls || {}).mode) || null,
        credentialName: ((s.tls || {}).credentialName) || null
      }))
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

/** Istio's chart labels on the ingress gateway pod: the fallback when no gateway pod was read. */
const INGRESS_CHART_LABELS = Object.freeze({ app: 'istio-ingressgateway', istio: 'ingressgateway' });

/**
 * The ingress gateway pod's own labels, from the pods list already read. A Service or Gateway
 * selects on a subset of them, and often on both chart keys: matching against `{istio}` alone
 * found no LB Service and dropped a Gateway selecting on `app` too.
 */
function ingressLabelsOf(pods) {
  const pod = ((pods && pods.items) || []).find(p => ((p.metadata || {}).labels || {}).istio === 'ingressgateway');
  return pod ? pod.metadata.labels : { ...INGRESS_CHART_LABELS };
}

/** The Edge node's facts, from reads the Traces collector already makes for the same request. */
function edgeMetaOf({ services, gateways, gatewayLabels }) {
  return { lb: lbServiceOf(services, gatewayLabels), gateways: gatewaysOf(gateways, gatewayLabels) };
}

/**
 * Who may reach the edge, and how much was refused. Peer addresses are counted here and never
 * published: `peers` is numbers only (D1, 2026-09-26).
 */
function accessControl({ records, classOf, resolvePeer, gatewayLabels, gatewayNamespace, authorizationPolicies, peerAuthentications, envoyFilters }) {
  const applies = p => {
    const ns = p.metadata.namespace;
    const sel = (p.spec || {}).selector;
    return (ns === gatewayNamespace || ns === 'istio-system') && labelsMatch(sel, gatewayLabels || {});
  };
  const deniedBy = new Map();
  const deniedByHost = new Map();
  let deniedTotal = 0;
  const peers = new Map();
  for (const r of records) {
    const d = detailsOf(r);
    const denied = d.startsWith('rbac_access_denied');
    if (denied) {
      deniedTotal += 1;
      bump(deniedBy, deniedPolicyOf(d) || 'none');
      bump(deniedByHost, hostOf(r.authority) || '(no host header)');
    }
    const peer = resolvePeer(r);
    if (!peer || !peer.ip) continue;
    const p = peers.get(peer.ip) || { external: peer.kind === 'external', passed: 0, denied: 0, tls: 0 };
    if (classOf(r) === 'tls-rejected') p.tls += 1;
    else if (denied) p.denied += 1;
    else p.passed += 1;
    peers.set(peer.ip, p);
  }
  const all = [...peers.values()];
  const ext = all.filter(p => p.external);

  const aps = authorizationPolicies && !authorizationPolicies.unavailable ? authorizationPolicies.items || [] : [];
  const gatewayPolicies = aps.filter(applies);
  const allowCount = gatewayPolicies.filter(p => ((p.spec || {}).action || 'ALLOW') === 'ALLOW').length;
  const policies = gatewayPolicies.map(p => {
    const spec = p.spec || {};
    const action = spec.action || 'ALLOW';
    const rules = spec.rules || [];
    const blocks = rules.flatMap(r => (r.from || []).flatMap(f => [...(((f || {}).source || {}).remoteIpBlocks || []), ...(((f || {}).source || {}).ipBlocks || [])]));
    const key = `${p.metadata.namespace}/${p.metadata.name}`;
    // An ALLOW policy denies by *not matching*, which Envoy logs as `[none]`; it can be attributed
    // to this policy only when it is the one ALLOW policy on the gateway.
    const denied = action === 'ALLOW' ? (allowCount === 1 ? deniedBy.get('none') || 0 : null) : deniedBy.get(key) || 0;
    return {
      namespace: p.metadata.namespace,
      name: p.metadata.name,
      action,
      selector: (spec.selector && spec.selector.matchLabels) || null,
      /** A count: the blocks themselves are the allowlist, and that is a list of client networks. */
      remoteIpBlocks: blocks.length,
      rules: rules.length,
      denied
    };
  });

  const pas = peerAuthentications && !peerAuthentications.unavailable ? peerAuthentications.items || [] : [];
  return {
    policies,
    deniedTotal,
    deniedByHost: [...deniedByHost].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)).slice(0, 20),
    peers: {
      distinct: all.length,
      internal: all.length - ext.length,
      external: ext.length,
      externalAllowed: ext.filter(p => p.passed > 0).length,
      externalBlockedOnly: ext.filter(p => p.passed === 0 && p.denied > 0).length,
      externalTlsOnly: ext.filter(p => p.passed === 0 && p.denied === 0 && p.tls > 0).length
    },
    proxyProtocol: envoyFilters.unavailable ? null : envoyFilters.items.some(f => f.proxyProtocol && labelsMatch({ matchLabels: f.workloadSelector || {} }, gatewayLabels || {})),
    peerAuthentications: pas
      .map(p => ({
        namespace: p.metadata.namespace,
        name: p.metadata.name,
        mode: (((p.spec || {}).mtls) || {}).mode || 'UNSET',
        selector: ((p.spec || {}).selector || {}).matchLabels || null
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
    unavailable: {
      authorizationPolicies: Boolean(authorizationPolicies && authorizationPolicies.unavailable),
      peerAuthentications: Boolean(peerAuthentications && peerAuthentications.unavailable)
    }
  };
}

/** A failing group's bucket: what failed versus what was refused. */
function errorBucket(g, edgeClass = null) {
  const details = g.responseCodeDetails || [];
  if (details.some(d => String(d).includes('filter_chain_not_found'))) return 'tls-rejected';
  if (details.some(d => String(d).startsWith('rbac_access_denied'))) return 'policy-blocked';
  // An ingress-gateway group whose Host no Gateway or route admits is a scanner dialling the LB
  // (400 missing_host_header, codec errors): never "App failed", never "Not routed".
  if (edgeClass === 'direct-ip') return 'direct-ip';
  if (Number(g.code) === 404 || (g.responseFlags || []).includes('NR')) return 'not-routed';
  /*
    Code 0 with no flag and no detail is a TCP connection Envoy logged with no HTTP status — on a
    live cluster, a telemetry collector's hundreds of healthy exports to its backend. Nothing says it
    failed, so it gets no bucket (the UI lists it as unclassified) rather than "App failed".
  */
  if (!Number(g.code) && !(g.responseFlags || []).length && !details.length) return null;
  return 'app-failed';
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

/**
 * The attention list: only rows that exist, most severe first. Each names the sub-tab that shows it.
 */
function attentionOf({ certificates, app, hosts, routes, access, envoyFilters, gatewayRows }) {
  const out = [];
  for (const c of certificates.items) {
    if (c.ready === false) {
      out.push({ severity: 'critical', kind: 'cert-expiry', title: `Certificate ${c.name} is not Ready`, detail: `${c.namespace}/${c.name}${c.usedBy.length ? `, used by ${c.usedBy.length} Gateway server(s)` : ''}`, section: 'listeners', ref: `${c.namespace}/${c.name}` });
      continue;
    }
    if (c.daysLeft === null) continue;
    const critical = c.daysLeft < CERT_CRITICAL_DAYS;
    const due = c.renewalOverdue === null ? c.daysLeft < CERT_WARNING_DAYS : c.renewalOverdue;
    if (!critical && !due) continue;
    out.push({
      severity: critical ? 'critical' : 'warning',
      kind: 'cert-expiry',
      title: c.renewalOverdue && !critical ? `Certificate ${c.name} missed its renewal` : `Certificate ${c.name} expires in ${c.daysLeft} days`,
      detail: `${c.commonName || c.dnsNames[0] || c.secretName || c.name}, expires ${c.expires}${c.renewalDate ? `, renewal was due ${c.renewalDate}` : ''}${c.usedBy.length ? `; terminates ${c.usedBy.length} Gateway server(s)` : ''}; issuer ${c.issuer || 'unknown'}`,
      section: 'listeners',
      ref: `${c.namespace}/${c.name}`
    });
  }
  for (const h of app ? app.hosts : []) {
    if (h.server > 0) out.push({ severity: 'critical', kind: 'app-5xx', title: `${h.host}: ${h.server} server error(s)`, detail: `${h.server} of ${h.requests} app requests in the sample answered 5xx`, section: 'failures', ref: h.host });
    else if (h.notFound > 0) out.push({ severity: 'warning', kind: 'app-404', title: `${h.host}: ${h.notFound} not found`, detail: `${h.notFound} of ${h.requests} app requests in the sample answered 404`, section: 'failures', ref: h.host });
  }
  // An Ingress or HTTPRoute publishes a host on purpose; a VirtualService host is often mesh-internal.
  const seen = new Set(hosts.map(h => h.host).filter(Boolean));
  for (const r of routes) {
    if ((r.kind !== 'Ingress' && r.kind !== 'HTTPRoute') || r.host.includes('*')) continue;
    const hit = [...seen].some(h => routeAdmits(r.host, h));
    if (!hit) out.push({ severity: 'info', kind: 'idle-host', title: `${r.host}: no traffic in the sample`, detail: `Published by ${r.kind} ${r.namespace}/${r.name}; nothing reached it in the lines read`, section: 'hosts', ref: r.host });
  }
  for (const p of access.peerAuthentications) {
    if (p.mode === 'PERMISSIVE') out.push({ severity: 'warning', kind: 'permissive-mtls', title: `PeerAuthentication ${p.namespace}/${p.name} is PERMISSIVE`, detail: `Plaintext is accepted${p.selector ? ` for ${Object.entries(p.selector).map(([k, v]) => `${k}=${v}`).join(', ')}` : ` in namespace ${p.namespace}`}`, section: 'listeners', ref: `${p.namespace}/${p.name}` });
  }
  if (envoyFilters.dead) {
    out.push({ severity: 'warning', kind: 'dead-envoyfilter', title: `${envoyFilters.dead} EnvoyFilter(s) can never apply`, detail: `Their proxyVersion match cannot match the running Istio ${envoyFilters.istioVersion}; they are config that loads nowhere`, section: 'gateway', ref: null });
  }
  if (!certificates.unavailable) {
    const managed = new Set(certificates.items.map(c => c.secretName));
    for (const cred of [...new Set(gatewayRows.map(g => g.credentialName).filter(Boolean))]) {
      if (!managed.has(cred)) out.push({ severity: 'info', kind: 'join-gap', title: `No Certificate manages Secret ${cred}`, detail: 'A Gateway terminates TLS with it; its expiry cannot be read without the Secret value, which this console never reads', section: 'listeners', ref: cred });
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, MAX_ATTENTION);
}

/* ------------------------------------------------------------------ network path */

const REGION_LABELS = ['topology.kubernetes.io/region', 'failure-domain.beta.kubernetes.io/region'];
const ZONE_LABELS = ['topology.kubernetes.io/zone', 'failure-domain.beta.kubernetes.io/zone'];

function labelOf(node, keys) {
  const labels = (node.metadata && node.metadata.labels) || {};
  for (const k of keys) if (labels[k]) return labels[k];
  return null;
}

/**
 * The cluster's provider, region and zones, from the Nodes every conformant cluster has. The
 * provider is the `spec.providerID` scheme the cloud controller wrote (`aws://`, `azure://`,
 * `gce://`, `kind://`); the region and zones are the well-known topology labels. A fact no Node
 * states is `null`, never a default.
 */
function clusterFactsOf(nodes) {
  if (!nodes || nodes.unavailable) {
    return { provider: null, region: null, zones: [], unavailable: Boolean(nodes && nodes.unavailable), reason: (nodes && nodes.reason) || null };
  }
  const items = nodes.items || [];
  const schemes = new Map();
  for (const n of items) {
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String((n.spec && n.spec.providerID) || ''));
    if (m) bump(schemes, m[1].toLowerCase());
  }
  const provider = [...schemes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const regions = [...new Set(items.map(n => labelOf(n, REGION_LABELS)).filter(Boolean))].sort();
  return {
    provider: provider ? provider[0] : null,
    region: regions.length ? regions.join(', ') : null,
    zones: [...new Set(items.map(n => labelOf(n, ZONE_LABELS)).filter(Boolean))].sort(),
    unavailable: false,
    reason: null
  };
}

const ANNOTATION_PROXY_PROTOCOL = 'service.beta.kubernetes.io/aws-load-balancer-proxy-protocol';
const ANNOTATION_IDLE_TIMEOUT = 'service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout';
const ANNOTATION_LB_TYPE = 'service.beta.kubernetes.io/aws-load-balancer-type';

/** What kind of AWS load balancer the annotations ask for. Classic is the in-tree default. */
function awsLbKind(annotations, provider) {
  if (provider !== 'aws') return null;
  const t = String(annotations[ANNOTATION_LB_TYPE] || '').toLowerCase();
  if (t === 'nlb' || t === 'external') return 'Network Load Balancer';
  return 'Classic Load Balancer';
}

function isReadyPod(p) {
  return (((p.status || {}).conditions) || []).some(c => c.type === 'Ready' && c.status === 'True');
}

/** `outboundTrafficPolicy.mode` from the mesh config text; the Istio default when unset. */
function outboundPolicyOf(meshConfig) {
  const cm = meshConfig && !meshConfig.unavailable ? (meshConfig.items || [])[0] : null;
  const text = cm && cm.data && cm.data.mesh;
  if (typeof text !== 'string') return null;
  const m = /outboundTrafficPolicy:\s*\n\s+mode:\s*([A-Z_]+)/.exec(text) || /outboundTrafficPolicy:\s*\{\s*mode:\s*([A-Z_]+)/.exec(text);
  return m ? m[1] : 'ALLOW_ANY';
}

/**
 * The route a request takes into the cluster and the one a connection takes out, hop by hop, from
 * the objects that declare each hop. Nothing is drawn that no object states: a hop whose read
 * failed is `null` or `unavailable`, never a default.
 */
function networkPath({ services, pods, nodes, envoyFilters, access, gatewayRows, routes, gatewaysUnavailable = false, routesUnavailable = false, meshConfig, serviceEntries, lbDns = [], destinations = [], destinationSources = null, observed = null }) {
  const info = clusterFactsOf(nodes);
  const podItems = pods && !pods.unavailable ? pods.items || [] : [];
  const nodeItems = nodes && !nodes.unavailable ? nodes.items || [] : [];
  const zoneOf = new Map(nodeItems.map(n => [n.metadata.name, ((n.metadata.labels || {})['topology.kubernetes.io/zone']) || null]));
  const gw = podItems.filter(p => ((p.metadata.labels || {}).istio) === 'ingressgateway');
  const gwNodes = [...new Set(gw.map(p => (p.spec || {}).nodeName).filter(Boolean))];
  const lbs = services && !services.unavailable
    ? (services.items || []).filter(s => (s.spec || {}).type === 'LoadBalancer' && ((s.spec || {}).selector || {}).istio === 'ingressgateway')
    : [];

  return {
    cluster: info,
    ingress: {
      loadBalancers: lbs.map(s => {
        const a = s.metadata.annotations || {};
        const ingress = ((s.status || {}).loadBalancer || {}).ingress || [];
        const hostnames = ingress.map(i => i.hostname).filter(Boolean);
        const resolved = lbDns.filter(d => hostnames.includes(d.hostname));
        const idle = Number(a[ANNOTATION_IDLE_TIMEOUT]);
        return {
          service: `${s.metadata.namespace}/${s.metadata.name}`,
          kind: awsLbKind(a, info.provider),
          hostnames,
          ips: ingress.map(i => i.ip).filter(Boolean),
          resolvedIps: [...new Set(resolved.flatMap(d => d.ips || []))],
          resolvedAt: (resolved.find(d => d.resolvedAt) || {}).resolvedAt || null,
          dnsError: (resolved.find(d => d.error) || {}).error || null,
          proxyProtocol: a[ANNOTATION_PROXY_PROTOCOL] === '*' || a[ANNOTATION_PROXY_PROTOCOL] === 'true',
          idleTimeoutSeconds: Number.isFinite(idle) && a[ANNOTATION_IDLE_TIMEOUT] !== undefined ? idle : null,
          externalTrafficPolicy: (s.spec || {}).externalTrafficPolicy || null,
          ports: ((s.spec || {}).ports || []).map(p => ({ name: p.name || null, port: p.port, targetPort: p.targetPort ?? null, nodePort: p.nodePort ?? null, protocol: p.protocol || 'TCP' }))
        };
      }),
      servicesUnavailable: Boolean(services && services.unavailable),
      gatewayPods: pods && pods.unavailable ? null : {
        total: gw.length,
        ready: gw.filter(isReadyPod).length,
        nodes: gwNodes.length,
        zones: [...new Set(gwNodes.map(n => zoneOf.get(n)).filter(Boolean))].sort()
      },
      nodes: nodes && nodes.unavailable ? null : { total: nodeItems.length, zones: [...new Set([...zoneOf.values()].filter(Boolean))].sort() },
      proxyProtocolFilter: access.proxyProtocol,
      policies: access.unavailable.authorizationPolicies ? null : access.policies.map(p => ({ namespace: p.namespace, name: p.name, action: p.action })),
      servers: gatewaysUnavailable ? null : gatewayRows.length,
      tlsServers: gatewaysUnavailable ? null : gatewayRows.filter(g => g.tlsMode).length,
      routes: routesUnavailable ? null : routes.length
    },
    egress: {
      egressGateway: pods && pods.unavailable ? null : podItems.some(p => ((p.metadata.labels || {}).istio) === 'egressgateway'),
      serviceEntries: !serviceEntries || serviceEntries.unavailable ? null : (serviceEntries.items || []).length,
      outboundPolicy: outboundPolicyOf(meshConfig),
      destinations,
      /** Which naming sources read: a failed NetworkPolicy read is why the list is short, not a clean cluster. */
      destinationSources,
      observed
    },
    envoyFilters: { istioVersion: envoyFilters.istioVersion }
  };
}

/**
 * External upstreams the sidecars in the sample connected to, with the name the index gives each.
 * `null` when no sidecar outside the ingress tier was read, so "none observed" is never a guess.
 */
function observedEgress(records, { ingressKeys, isPrivate, splitHostPort, nameOf, nameIndex, maxRows = 25 }) {
  const out = records.filter(r => !ingressKeys.has(`${r.proxy.namespace}/${r.proxy.pod}`));
  if (!out.length) return null;
  const byIp = new Map();
  for (const r of out) {
    const { ip } = splitHostPort(r.upstreamHost);
    if (!ip || isPrivate(ip) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    const row = byIp.get(ip) || { ip, requests: 0, callers: new Set() };
    row.requests += 1;
    row.callers.add(`${r.proxy.namespace}/${r.proxy.pod}`);
    byIp.set(ip, row);
  }
  return [...byIp.values()]
    .map(r => {
      const callers = [...r.callers].sort();
      const n = nameOf(nameIndex, r.ip);
      return { ip: r.ip, display: n ? n.display : null, source: n ? n.source : null, requests: r.requests, callers: callers.slice(0, 5), callersTotal: callers.length };
    })
    .sort((a, b) => b.requests - a.requests || a.ip.localeCompare(b.ip))
    .slice(0, maxRows);
}

export default {
  CLASS_ORDER,
  MIN_P95_SAMPLES,
  CERT_CRITICAL_DAYS,
  CERT_WARNING_DAYS,
  classifyEdgeRecord,
  edgeClasses,
  hostClass,
  certificateRows,
  hostChain,
  istioVersionOf,
  envoyFilterRows,
  deniedPolicyOf,
  accessControl,
  errorBucket,
  attentionOf,
  routeAdmits,
  clusterFactsOf,
  outboundPolicyOf,
  networkPath,
  edgeMetaOf,
  ingressLabelsOf,
  observedEgress
};
