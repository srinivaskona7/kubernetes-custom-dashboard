/**
 * Names for the external addresses an access log reports, each with the object that named it.
 *
 * ## Why this exists
 *
 * An egress line through TLS passthrough carries an IP and nothing else: `requested_server_name`
 * and `authority` are null in many access-log formats, so the Traces map drew `18.213.242.208:443`
 * where an operator needed the service's name. Forward DNS is no answer — one shared SaaS load
 * balancer IP serves many hostnames, and ELB addresses rotate. The cluster already says who these
 * addresses are, in three places, and this module reads only those:
 *
 *   networkpolicy   operators annotate their egress NetworkPolicies with the IPs each allowed
 *                   service resolves to (`idp-us10: "3.214.110.153, ..."`), or describe them in
 *                   prose.
 *   networkpolicy-ipblock  the egress rules themselves: `spec.egress[].to[].ipBlock`. A `/32`
 *                   names that address; a wider block names what falls inside it (longest
 *                   prefix first, `except` honoured); `0.0.0.0/0` declares nothing and names nothing.
 *   ingress-lb      this cluster's own ingress load balancer: `status.loadBalancer.ingress[]`,
 *                   an IP there or a hostname resolved by DNS and cached. Clients that address
 *                   the LB by IP land in the Host header as that IP.
 *
 * An address none of them name stays a bare address. Every name carries `source`, the objects it
 * came from, and every other name the same address was given, so a reader can check it.
 *
 * Read-only: every input is a list the collectors already hold, plus a DNS query for a hostname
 * the cluster itself published.
 */
import dns from 'node:dns';

/** An IPv4 address, optionally `/32`. Any other prefix is a range, and a range names no host. */
const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})(\/\d{1,2})?\b/g;

/** Annotations that carry IPs for another reason: the applied spec's own ipBlocks. */
const IGNORED_ANNOTATIONS = new Set(['kubectl.kubernetes.io/last-applied-configuration']);

/** How long a resolved load-balancer hostname is trusted. ELB addresses rotate, slowly. */
const LB_DNS_TTL_MS = 5 * 60_000;
const LB_DNS_TIMEOUT_MS = 2_000;
/** A Service publishes a handful of LB entries; more than this is not a load balancer. */
const MAX_LB_HOSTNAMES = 4;
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * A readable name for an annotation key. Only the Kubernetes API server is given a name of ours;
 * every other key is the operator's word and is shown as written. The key itself always travels
 * with it as `key`.
 */
function displayOf(key) {
  const k = String(key || '').replace(/^.*\//, '');
  if (!/^apiserver/i.test(k)) return k;
  const apiserver = /^apiserver-(.+)$/i.exec(k);
  return apiserver ? `Kubernetes API server (${apiserver[1]})` : 'Kubernetes API server';
}

function validIp(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

/** An IPv4 CIDR with host bits masked, or null. Arithmetic, not bitwise: `1 << 31` is negative. */
function parseCidr(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!m || !validIp(m[1])) return null;
  const bits = Number(m[2]);
  if (bits > 32) return null;
  const size = 2 ** (32 - bits);
  const base = Math.floor(ipv4ToInt(m[1]) / size) * size;
  return { cidr: `${m[1]}/${bits}`, bits, base, size };
}

const inCidr = (c, n) => n >= c.base && n < c.base + c.size;

/** Allow-all declares no destination, so it names nothing. */
const ALLOW_ALL = new Set(['0.0.0.0/0', '::/0']);

/** Every `spec.egress[].to[].ipBlock` of one policy. */
function egressBlocks(policy) {
  const out = [];
  for (const rule of ((policy && policy.spec) || {}).egress || []) {
    for (const peer of (rule && rule.to) || []) {
      const b = peer && peer.ipBlock;
      if (b && typeof b.cidr === 'string') out.push({ cidr: b.cidr.trim(), except: Array.isArray(b.except) ? b.except : [] });
    }
  }
  return out;
}

const policyKey = p => `${((p && p.metadata) || {}).namespace}/${((p && p.metadata) || {}).name}`;

/**
 * The single IPs in one annotation value, and the label its own text gives them.
 *
 * Three shapes are live: `"a, b, c"`, `"hana-ips:a,b"` and prose (`"External API — AWS NLB IPs of
 * api.c-9d0a141...: a, b, c"`). The text before the first IP is the label when it reads as a
 * sentence; a bare token (`hana-ips`) is a qualifier and the key stays the label.
 */
function parseAnnotation(key, value) {
  if (IGNORED_ANNOTATIONS.has(key)) return null;
  const v = String(value || '');
  if (!v || v.trimStart().startsWith('{')) return null;
  const ips = [];
  let first = -1;
  for (const m of v.matchAll(IPV4)) {
    if (m[2] && m[2] !== '/32') continue;
    if (!validIp(m[1])) continue;
    if (first === -1) first = m.index;
    ips.push(m[1]);
  }
  if (!ips.length) return null;
  const lead = v.slice(0, first).replace(/[\s:;,]+$/, '').trim();
  const prose = /\s/.test(lead);
  return {
    ips: [...new Set(ips)],
    label: prose ? lead : key.replace(/^.*\//, ''),
    display: prose ? lead : displayOf(key),
    qualifier: prose || !lead ? null : lead,
    form: prose ? 'prose' : 'keyed'
  };
}

/** Precedence when two sources name one address. The cluster's own LB is the most specific. */
const RANK = { 'ingress-lb': 0, networkpolicy: 1, 'networkpolicy-ipblock': 2, 'networkpolicy-prose': 3 };

function add(byIp, ip, name) {
  const list = byIp.get(ip) || [];
  const same = list.find(n => n.source === name.source && n.label === name.label);
  if (same) {
    for (const o of name.objects) if (!same.objects.includes(o)) same.objects.push(o);
  } else {
    list.push({ ...name, objects: [...name.objects] });
  }
  byIp.set(ip, list);
}

/**
 * Resolve the ingress LB's hostnames, cached per hostname. A failure is cached too, for the same
 * TTL, so a resolver outage costs one timeout per five minutes rather than one per request.
 */
const lbCache = new Map();
/*
  Only a cloud provider's load-balancer name is resolved. The hostname is read from a Service status
  anyone with write access to that cluster can set, and srv resolves it with the hub's own resolver:
  an internal name (`*.svc.cluster.local`, `*.internal`, a split-horizon corporate zone) would publish
  the hub's private DNS answers to every viewer. AWS is the provider that reports hostnames.
*/
const PROVIDER_LB_SUFFIX = /\.elb\.amazonaws\.com(\.cn)?$|\.elb\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i;
function isProviderLbHostname(h) {
  const s = String(h || '');
  return DNS_NAME.test(s) && PROVIDER_LB_SUFFIX.test(s);
}
async function resolveLbHostnames(hostnames, { resolve4 = dns.promises.resolve4, now = Date.now, ttlMs = LB_DNS_TTL_MS, timeoutMs = LB_DNS_TIMEOUT_MS } = {}) {
  const valid = [...new Set((hostnames || []).filter(h => DNS_NAME.test(String(h || ''))))].slice(0, MAX_LB_HOSTNAMES);
  return Promise.all(
    valid.map(async hostname => {
      if (!isProviderLbHostname(hostname)) return { hostname, ips: [], resolvedAt: null, error: 'NOT_A_PROVIDER_LB' };
      const hit = lbCache.get(hostname);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      let value;
      try {
        let timer;
        const ips = await Promise.race([
          resolve4(hostname),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs); })
        ]).finally(() => clearTimeout(timer));
        value = { hostname, ips: [...ips].filter(validIp).sort(), resolvedAt: new Date(now()).toISOString(), error: null };
      } catch (err) {
        value = { hostname, ips: [], resolvedAt: new Date(now()).toISOString(), error: String((err && err.code) || (err && err.message) || err).slice(0, 80) };
      }
      lbCache.set(hostname, { at: now(), value });
      return value;
    })
  );
}

/** The ingress gateway Services' load-balancer entries: IPs as given, hostnames to resolve. */
function lbEntries(services) {
  if (!services || services.unavailable) return { ips: [], hostnames: [], services: [] };
  const ips = [];
  const hostnames = [];
  const names = [];
  for (const s of services.items || []) {
    const sel = (s.spec && s.spec.selector) || {};
    const gateway = sel.istio === 'ingressgateway' || sel.app === 'istio-ingressgateway' || /ingressgateway/.test((s.metadata && s.metadata.name) || '');
    if (!gateway || (s.spec || {}).type !== 'LoadBalancer') continue;
    names.push(`${s.metadata.namespace}/${s.metadata.name}`);
    for (const i of ((s.status || {}).loadBalancer || {}).ingress || []) {
      if (i.ip && validIp(i.ip)) ips.push({ ip: i.ip, service: `${s.metadata.namespace}/${s.metadata.name}` });
      if (i.hostname) hostnames.push({ hostname: i.hostname, service: `${s.metadata.namespace}/${s.metadata.name}` });
    }
  }
  return { ips, hostnames, services: names };
}

/**
 * Build the index.
 *
 * @param {object} args
 * @param {object} [args.networkPolicies] a safeList result, full objects: ipBlocks live in `spec.egress`
 * @param {object} [args.services]        a safeList result; the ingress gateway's LB is read from it
 * @param {object[]} [args.lbDns]         `resolveLbHostnames` output
 */
function buildNameIndex({ networkPolicies = null, services = null, lbDns = [] } = {}) {
  const byIp = new Map();

  if (networkPolicies && !networkPolicies.unavailable) {
    for (const np of networkPolicies.items || []) {
      const meta = (np && np.metadata) || {};
      const object = `NetworkPolicy ${meta.namespace}/${meta.name}`;
      for (const [key, value] of Object.entries(meta.annotations || {})) {
        const parsed = parseAnnotation(key, value);
        if (!parsed) continue;
        const source = parsed.form === 'prose' ? 'networkpolicy-prose' : 'networkpolicy';
        for (const ip of parsed.ips) {
          add(byIp, ip, { label: parsed.label, display: parsed.display, key, qualifier: parsed.qualifier, source, objects: [object], namespace: meta.namespace || null, policyName: meta.name || null, cidr: null });
        }
      }
    }
  }

  const ranges = [];
  if (networkPolicies && !networkPolicies.unavailable) {
    const policies = [...(networkPolicies.items || [])].sort((a, b) => policyKey(a).localeCompare(policyKey(b)));
    for (const policy of policies) {
      const meta = (policy && policy.metadata) || {};
      const object = `NetworkPolicy ${meta.namespace}/${meta.name}`;
      const fallback = `Egress allowed by ${meta.namespace}/${meta.name}`;
      for (const block of egressBlocks(policy)) {
        if (ALLOW_ALL.has(block.cidr)) continue;
        const c = parseCidr(block.cidr);
        if (!c || c.bits === 0) continue;
        const who = { namespace: meta.namespace || null, policyName: meta.name || null, cidr: c.cidr };
        if (c.bits === 32) {
          const ip = c.cidr.slice(0, -3);
          const annotated = (byIp.get(ip) || []).find(n => n.source === 'networkpolicy' || n.source === 'networkpolicy-prose');
          // One label per address, so a second policy allowing it merges its object instead of tying.
          add(byIp, ip, { label: 'ipblock', display: annotated ? annotated.display : fallback, key: null, qualifier: null, source: 'networkpolicy-ipblock', objects: [object], ...who });
        } else {
          ranges.push({ ...c, except: block.except.map(parseCidr).filter(Boolean), display: fallback, objects: [object], ...who });
        }
      }
    }
  }
  ranges.sort((a, b) => b.bits - a.bits || `${a.namespace}/${a.policyName}`.localeCompare(`${b.namespace}/${b.policyName}`));

  const lb = lbEntries(services);
  for (const { ip, service } of lb.ips) {
    add(byIp, ip, { label: 'ingress-lb', display: "This cluster's ingress load balancer", key: null, qualifier: null, source: 'ingress-lb', objects: [`Service ${service}`], namespace: null, policyName: null, cidr: null });
  }
  for (const d of lbDns || []) {
    const svc = lb.hostnames.find(h => h.hostname === d.hostname);
    for (const ip of d.ips || []) {
      add(byIp, ip, {
        label: 'ingress-lb',
        display: "This cluster's ingress load balancer",
        key: null,
        qualifier: `${d.hostname} by DNS at ${d.resolvedAt}`,
        source: 'ingress-lb',
        objects: [svc ? `Service ${svc.service}` : d.hostname],
        namespace: null,
        policyName: null,
        cidr: null
      });
    }
  }

  for (const list of byIp.values()) {
    list.sort((a, b) => RANK[a.source] - RANK[b.source] || b.objects.length - a.objects.length || a.label.localeCompare(b.label));
  }

  return {
    byIp,
    ranges,
    // `ips` are the addresses a provider publishes directly (Azure, GCP); `dns` resolves ELB names.
    lb: { services: lb.services, ips: [...new Set(lb.ips.map(x => x.ip))], hostnames: lb.hostnames.map(h => h.hostname), dns: lbDns || [] },
    sources: {
      networkPolicies: !networkPolicies ? 'not-read' : networkPolicies.unavailable ? 'unavailable' : 'ok',
      lbDns: (lbDns || []).some(d => d.error) ? 'partial' : 'ok'
    }
  };
}

/**
 * The name for one address, or null. `ranges: false` skips the ipBlock ranges: an ingress Host
 * that is a public IP is a client's dial, not an egress.
 *
 * @returns {{display: string, label: string, source: string, key: string|null, qualifier: string|null,
 *   objects: string[], others: string[], ambiguous?: true}|null}
 */
function nameOf(index, ip, { ranges = true } = {}) {
  if (!index || !ip) return null;
  const list = index.byIp.get(ip);
  if (list && list.length) {
    const [top, ...rest] = list;
    /* Two policies of equal standing naming one address differently (apiserver-cluster-a and
       apiserver-cluster-b share IPs) is a conflict the sort would settle by object count or
       alphabet. Name every claimant rather than guess one. */
    const ties = rest.filter(n => RANK[n.source] === RANK[top.source] && n.display !== top.display);
    // An ipBlock entry that took an annotation's name is provenance, not a second name.
    const distinct = rest.filter(n => n.display !== top.display);
    if (ties.length) {
      const claimants = [top, ...ties];
      return {
        ...top,
        display: claimants.map(n => n.display).join(' or '),
        key: null,
        objects: [...new Set(claimants.flatMap(n => n.objects))],
        ambiguous: true,
        others: distinct.filter(n => !claimants.some(t => t.display === n.display)).map(n => n.display)
      };
    }
    return { ...top, others: distinct.map(n => n.display) };
  }
  if (ranges && index.ranges && index.ranges.length && validIp(ip)) {
    const n = ipv4ToInt(ip);
    const hit = index.ranges.find(r => inCidr(r, n) && !r.except.some(e => inCidr(e, n)));
    if (hit) {
      return { display: hit.display, label: 'ipblock-range', source: 'networkpolicy-ipblock', key: null, qualifier: `inside ${hit.cidr}`, objects: hit.objects, others: [], namespace: hit.namespace, policyName: hit.policyName, cidr: hit.cidr };
    }
  }
  return null;
}

/** The IP part of a map node's `ip:port` name. */
function ipOfNode(node) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(String((node && node.name) || ''));
  return m ? m[1] : null;
}

/** Put names on a service map's external nodes, in place. A node is named when its address is. */
function nameServiceMap(serviceMap, index) {
  if (!serviceMap || !index) return serviceMap;
  for (const node of serviceMap.nodes) {
    if (node.kind !== 'external') continue;
    const ip = ipOfNode(node);
    if (!ip) continue;
    const n = nameOf(index, ip);
    if (n) node.destination = n;
  }
  return serviceMap;
}

/** The same, for rows whose `to` is a node reference (Traces → Outbound). */
function nameNodeRefs(rows, index) {
  if (!Array.isArray(rows) || !index) return rows;
  for (const row of rows) {
    const to = row && row.to;
    if (!to || to.kind !== 'external') continue;
    const ip = ipOfNode(to);
    if (!ip) continue;
    const n = nameOf(index, ip);
    if (n) to.destination = n;
  }
  return rows;
}

/** Traffic → Failing requests: a group's external upstream, named like a Traces node. */
function nameFailureGroups(groups, index) {
  if (!Array.isArray(groups) || !index) return groups;
  for (const g of groups) {
    const d = g && g.destination;
    if (!d || d.kind !== 'external' || !d.ip) continue;
    const n = nameOf(index, d.ip);
    if (n) d.destination = n;
  }
  return groups;
}

/** Traces → Endpoints: a Host that is a bare address (a client dialled the LB by IP) gets its name. */
function nameEndpointHosts(rows, index) {
  if (!Array.isArray(rows) || !index) return rows;
  for (const row of rows) {
    const host = String((row && row.host) || '').replace(/:\d+$/, '');
    if (!validIp(host)) continue;
    const n = nameOf(index, host, { ranges: false });
    if (n) row.destination = n;
  }
  return rows;
}

/**
 * Traces → a journey's hops: an external `to` gets its name, or `undeclared` when no object names
 * it. `from` is never touched: `callerOf` already removed any client address.
 */
function nameHopEndpoints(traces, index) {
  if (!Array.isArray(traces) || !index) return traces;
  for (const t of traces) {
    for (const h of (t && t.hops) || []) {
      const to = h && h.to;
      if (!to || to.kind !== 'external' || !to.ip) continue;
      const n = nameOf(index, to.ip);
      if (n) to.destination = n;
      else to.undeclared = true;
    }
  }
  return traces;
}

/** Every named destination in the index, one row per name, with the addresses it covers. */
function namedDestinations(index) {
  if (!index) return [];
  const rows = new Map();
  for (const [ip, names] of index.byIp) {
    for (const n of names) {
      if (n.source === 'ingress-lb') continue;
      const k = `${n.source}|${n.label}|${n.display}`;
      const row = rows.get(k) || { display: n.display, label: n.label, source: n.source, ips: [], objects: [] };
      row.ips.push(ip);
      for (const o of n.objects) if (!row.objects.includes(o)) row.objects.push(o);
      rows.set(k, row);
    }
  }
  const out = [...rows.values()].map(r => ({ ...r, ips: r.ips.sort() }));
  for (const r of index.ranges || []) {
    out.push({ display: r.display, label: 'ipblock-range', source: 'networkpolicy-ipblock', ips: [r.cidr], objects: r.objects });
  }
  return out.sort((a, b) => a.display.localeCompare(b.display));
}

/** The list reads this module needs, as safeList arguments. NetworkPolicies are read whole: spec.egress is not in PartialObjectMetadata. */
const NAME_READS = {
  networkPolicies: { path: '/apis/networking.k8s.io/v1/networkpolicies?limit=1000', label: 'networkpolicies' }
};

/**
 * Start every list read `buildNameIndex` needs. Returns the promise, so a collector can put it in
 * its own `Promise.all` beside the reads it already makes; `finishNameIndex` then needs the
 * Service list the collector holds anyway, for the ingress LB.
 */
function readNameSources({ listFn, baseCtx, safeList, metadataAccept }) {
  const read = r => safeList(listFn, r.metadataOnly ? { ...baseCtx, accept: metadataAccept } : baseCtx, r.path, r.label);
  return Promise.all([read(NAME_READS.networkPolicies)]);
}

/** Resolve the LB hostnames (cached) and build the index. `reads` is `readNameSources`' result. */
async function finishNameIndex(reads, services, { resolve4 } = {}) {
  const [networkPolicies] = reads;
  const lb = lbEntries(services);
  const lbDns = await resolveLbHostnames(lb.hostnames.map(h => h.hostname), resolve4 ? { resolve4 } : undefined);
  const index = buildNameIndex({ networkPolicies, services, lbDns });
  /** The safeList results, so a caller can fold their `unavailable` / `truncated` into its own. */
  index.reads = reads;
  return index;
}

export default {
  buildNameIndex,
  parseCidr,
  namedDestinations,
  readNameSources,
  finishNameIndex,
  nameOf,
  nameServiceMap,
  nameNodeRefs,
  nameFailureGroups,
  nameEndpointHosts,
  nameHopEndpoints,
  isProviderLbHostname,
  parseAnnotation,
  displayOf,
  resolveLbHostnames,
  lbEntries,
  NAME_READS,
  LB_DNS_TTL_MS,
  _lbCache: lbCache
};
