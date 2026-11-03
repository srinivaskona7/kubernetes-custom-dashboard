/**
 * Every request a proxy answered itself with a refusal, grouped, with the AuthorizationPolicy that
 * decided it. Built for tuning allowlists: which hosts and paths scanners try, which policy turned
 * them away. Client addresses are counted, never published.
 *
 * Envoy logs a DENY by name (`matched_policy[ns[..]-policy[..]-rule[n]]`) and an ALLOW miss as
 * `matched_policy[none]`. For a miss every ALLOW policy whose selector covers the workload is listed
 * with `policyInferred: true`: the log does not say which one would have admitted the request.
 */

import edgeModule from './edge.js';
const { deniedPolicyOf } = edgeModule;

const MAX_ROWS = 100;

const REASONS = [
  [/^rbac_access_denied_matched_policy\[none\]/, 'No ALLOW rule matched this request'],
  [/^rbac_access_denied_matched_policy/, 'A DENY rule matched this request'],
  [/^rbac_access_denied/, 'Refused by an AuthorizationPolicy'],
  [/filter_chain_not_found/, 'TLS refused before HTTP: the client offered no server name this gateway serves'],
  [/missing_host_header/, 'No Host header: a client dialled the address, not a name'],
  [/route_not_found/, 'No route for this host and path'],
  [/cluster_not_found/, 'The route names a backend that does not exist'],
  [/^ext_authz/, 'The external authorizer refused it']
];

function reasonOf(details, code, flags) {
  for (const d of details) for (const [re, words] of REASONS) if (re.test(d)) return words;
  if (flags.includes('NR')) return 'No route for this host and path';
  if (flags.includes('UAEX')) return 'The external authorizer refused it';
  return `Answered ${code || 'without a status'} by the proxy, not by a workload`;
}

/**
 * Answered by the proxy itself: no upstream, and a 4xx, or a code 0 with a detail saying why, or a
 * proxy-originated 5xx (e.g. `cluster_not_found`) that never reached a workload.
 */
function isRefusal(r) {
  const upstream = r.upstreamHost && r.upstreamHost !== '-' ? r.upstreamHost : null;
  if (upstream) return false;
  const code = Number(r.code) || 0;
  if (code >= 400 && code < 500) return true;
  if (code >= 500) return Boolean(r.responseCodeDetails) && r.responseCodeDetails !== 'via_upstream';
  return code === 0 && Boolean(r.responseCodeDetails) && r.responseCodeDetails !== 'via_upstream';
}

/** A policy in the root namespace (istio-system) applies mesh-wide; any other to its own namespace. */
function selects(policy, namespace, labels) {
  const ns = policy.metadata.namespace;
  const m = ((policy.spec || {}).selector || {}).matchLabels;
  if (ns !== namespace && ns !== 'istio-system') return false;
  if (!m) return true;
  return Object.entries(m).every(([k, v]) => (labels || {})[k] === v);
}

function rulesOf(policy) {
  return ((policy.spec || {}).rules || []).map(rule => {
    const ops = (rule.to || []).map(t => (t && t.operation) || {});
    const srcs = (rule.from || []).map(f => (f && f.source) || {});
    const all = (list, key) => [...new Set(list.flatMap(x => x[key] || []))];
    return {
      paths: all(ops, 'paths'),
      methods: all(ops, 'methods'),
      hosts: all(ops, 'hosts'),
      principals: all(srcs, 'principals'),
      ipBlocks: srcs.reduce((n, s) => n + (s.remoteIpBlocks || []).length + (s.ipBlocks || []).length, 0)
    };
  });
}

/** `rbac` is the first `rbac_access_denied*` detail of the record, or undefined when it has none. */
function decisionOf(r, rbac, ctx) {
  const aps = ctx.authorizationPolicies;
  if (!aps || aps.unavailable) return null;
  if (!rbac) return [];
  const labels = ctx.podLabels.get(`${r.proxy.namespace}/${r.proxy.pod}`) || {};
  const summary = (p, decidedBy) => ({ namespace: p.metadata.namespace, name: p.metadata.name, action: (p.spec || {}).action || 'ALLOW', policyInferred: decidedBy === 'inferred', decidedBy, rules: rulesOf(p) });
  const named = deniedPolicyOf(rbac);
  if (named && named !== 'none') {
    const hit = (aps.items || []).find(p => `${p.metadata.namespace}/${p.metadata.name}` === named);
    return hit
      ? [summary(hit, 'named')]
      : [{ namespace: named.split('/')[0], name: named.split('/')[1] || named, action: 'DENY', policyInferred: false, decidedBy: 'named', rules: [] }];
  }
  // `[none]`: no ALLOW matched. When exactly one ALLOW policy selects this proxy, it is the only
  // one that could have refused the request — determined by elimination, not inferred.
  const allowing = (aps.items || [])
    .filter(p => ((p.spec || {}).action || 'ALLOW') === 'ALLOW' && selects(p, r.proxy.namespace, labels))
    .sort((a, b) => a.metadata.namespace.localeCompare(b.metadata.namespace) || a.metadata.name.localeCompare(b.metadata.name));
  if (allowing.length === 1) return [summary(allowing[0], 'elimination')];
  return allowing.map(p => summary(p, 'inferred'));
}

function refusalsOf(records, ctx) {
  const max = ctx.max || MAX_ROWS;
  const groups = new Map();
  // What decided a refusal depends on the proxy and its first rbac detail alone, so a scanner's
  // thousand requests are decided once, not once each.
  const decisions = new Map();
  let requests = 0;
  for (const r of records) {
    if (!isRefusal(r)) continue;
    requests += 1;
    const gateway = ctx.gatewayKeys.has(`${r.proxy.namespace}/${r.proxy.pod}`);
    const details = String(r.responseCodeDetails || '').split(',').map(s => s.trim()).filter(Boolean);
    const flags = String(r.responseFlags || '').split(/[,\s]+/).filter(f => f && f !== '-');
    const rbac = details.find(d => d.startsWith('rbac_access_denied'));
    const decisionId = `${r.proxy.namespace}/${r.proxy.pod}|${rbac}`;
    let decision = decisions.get(decisionId);
    if (!decision) {
      const list = decisionOf(r, rbac, ctx);
      decision = { decidedBy: list, key: list === null ? '?' : list.map(p => `${p.namespace}/${p.name}`).join('+') };
      decisions.set(decisionId, decision);
    }
    const { decidedBy, key: decisionKey } = decision;
    const key = [gateway ? 'edge' : r.proxy.namespace, r.authority, r.method, r.path, r.code, details.join('|'), decisionKey].join('\u0001');
    const g = groups.get(key) || {
      tier: gateway ? 'edge' : 'sidecar',
      namespace: r.proxy.namespace,
      method: r.method || null,
      authority: r.authority || null,
      path: r.path || null,
      edgeClass: gateway ? ctx.classOf(r) : null,
      code: Number(r.code) || 0,
      responseCodeDetails: details,
      responseFlags: flags,
      reason: reasonOf(details, Number(r.code) || 0, flags),
      tlsBeforeHttp: details.some(d => d.includes('filter_chain_not_found')),
      decidedBy,
      firstSeen: null,
      lastSeen: null,
      count: 0,
      peers: new Set()
    };
    g.count += 1;
    if (r.downstreamRemote) g.peers.add(String(r.downstreamRemote).replace(/:\d+$/, ''));
    if (r.startTime && (!g.firstSeen || r.startTime < g.firstSeen)) g.firstSeen = r.startTime;
    if (r.startTime && (!g.lastSeen || r.startTime > g.lastSeen)) g.lastSeen = r.startTime;
    groups.set(key, g);
  }
  const all = [...groups.values()]
    .map(({ peers, ...g }) => ({ ...g, clients: peers.size }))
    .sort((a, b) => b.count - a.count || String(a.authority).localeCompare(String(b.authority)) || String(a.path).localeCompare(String(b.path)));
  return {
    rows: all.slice(0, max),
    rowsFound: all.length,
    requests,
    policiesUnavailable: Boolean(!ctx.authorizationPolicies || ctx.authorizationPolicies.unavailable)
  };
}

export default { refusalsOf, isRefusal, reasonOf, MAX_ROWS };
