/**
 * Names for the external addresses an access log reports, each with the object that named it.
 *
 * ## Why this exists
 *
 * An egress line through TLS passthrough carries an IP and nothing else: `requested_server_name`
 * and `authority` are null on the platformsbx format, so the Traces map drew `18.213.242.208:443`
 * where an operator needed "XSUAA". Forward DNS is no answer — one shared BTP load balancer IP
 * serves many hostnames, and ELB addresses rotate. The cluster already says who these addresses
 * are, in three places, and this module reads only those:
 *
 *   networkpolicy   operators annotate their egress NetworkPolicies with the IPs each allowed
 *                   service resolves to (`xsuaa-service-instances-us10: "3.214.110.153, ..."`).
 *                   Gatekeeper's policies carry the same thing as prose.
 *   telemetry       a Kyma telemetry gateway exports only to its pipelines' outputs, and the
 *                   output's `secretKeyRef` leads to a BTP ServiceBinding whose ServiceInstance
 *                   names the offering (`cloud-logging`). The Secret's value is never read.
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
 * A readable service name for an annotation key or a BTP offering. Only the family is named; the
 * key itself always travels with it as `key`, because it is the operator's word, not ours.
 */
const FAMILIES = [
  [/^xsuaa/i, 'SAP Authorization and Trust (XSUAA)'],
  [/^hana/i, 'SAP HANA Cloud'],
  [/^destination/i, 'SAP Destination service'],
  [/^connectivity/i, 'SAP Connectivity service'],
  [/^cloud-logging|^cls\b/i, 'SAP Cloud Logging'],
  [/^credstore/i, 'SAP Credential Store'],
  [/^apiserver/i, 'Kubernetes API server']
];
const REGION = /-((?:us|eu|ap|jp|br|ca|ch|cn|in|il|sa|ae)\d{2})$/i;

function displayOf(key) {
  const k = String(key || '').replace(/^.*\//, '');
  const family = FAMILIES.find(([re]) => re.test(k));
  if (!family) return k;
  const apiserver = /^apiserver-(.+)$/i.exec(k);
  if (apiserver) return `${family[1]} (${apiserver[1]})`;
  const region = REGION.exec(k);
  return region ? `${family[1]} · ${region[1].toLowerCase()}` : family[1];
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
 * Where the telemetry gateways export to, from the pipelines' outputs.
 *
 * `valueFrom.secretKeyRef` is followed to the ServiceBinding that owns the Secret (the btp-operator
 * names the Secret `spec.secretName`) and on to its ServiceInstance's `serviceOfferingName`. A
 * literal `value` names its host directly. Nothing is inferred when a link is missing: the export
 * is then named by the Secret reference alone, which is still the operator's own object.
 */
function telemetryExport({ pipelines = [], serviceBindings = null, serviceInstances = null }) {
  /* Every pipeline kind must be read: with TracePipelines unread, a trace gateway's export to
     another backend would take the LogPipelines' name. A 404 is a true zero and stays readable. */
  if (!pipelines.length || pipelines.some(p => !p || p.unavailable)) return null;
  const readable = pipelines;
  const outputs = new Map();
  for (const list of readable) {
    for (const p of list.items || []) {
      const otlp = (((p || {}).spec || {}).output || {}).otlp;
      const ep = otlp && otlp.endpoint;
      if (!ep) continue;
      let key;
      let target;
      if (ep.valueFrom && ep.valueFrom.secretKeyRef) {
        const ref = ep.valueFrom.secretKeyRef;
        key = `secret:${ref.namespace}/${ref.name}`;
        target = { kind: 'secret', namespace: ref.namespace || null, name: ref.name || null, key: ref.key || null };
      } else if (typeof ep.value === 'string' && ep.value) {
        let host = null;
        try { host = new URL(ep.value).hostname; } catch { host = ep.value.split(/[/:]/)[0] || null; }
        key = `host:${host}`;
        target = { kind: 'host', host };
      } else {
        continue;
      }
      const o = outputs.get(key) || { ...target, pipelines: [] };
      o.pipelines.push(`${p.kind || 'Pipeline'}/${p.metadata && p.metadata.name}`);
      outputs.set(key, o);
    }
  }
  if (!outputs.size) return null;

  const bindings = serviceBindings && !serviceBindings.unavailable ? serviceBindings.items || [] : null;
  const instances = serviceInstances && !serviceInstances.unavailable ? serviceInstances.items || [] : null;
  const named = [...outputs.values()].map(o => {
    if (o.kind !== 'secret' || !bindings || !instances) return { ...o, offering: null, instance: null };
    const b = bindings.find(
      x => x.metadata && x.metadata.namespace === o.namespace && ((x.spec || {}).secretName || x.metadata.name) === o.name
    );
    const inst = b && instances.find(i => i.metadata && i.metadata.namespace === o.namespace && i.metadata.name === (b.spec || {}).serviceInstanceName);
    const offering = inst ? (inst.spec || {}).serviceOfferingName || null : null;
    return { ...o, offering, instance: inst ? `${o.namespace}/${inst.metadata.name}` : null, binding: b ? `${o.namespace}/${b.metadata.name}` : null };
  });

  // One output is a name. Several different ones are a list, and the gateway's connection could
  // be to any of them, so the label says so rather than picking.
  const labels = [...new Set(named.map(o => (o.offering ? displayOf(o.offering) : o.kind === 'host' ? o.host : `${o.namespace}/${o.name}`)))];
  return {
    label: labels.length === 1 ? labels[0] : `Telemetry export (${labels.length} outputs)`,
    display: labels.length === 1 ? `${labels[0]} (telemetry export)` : `Telemetry export: ${labels.join(', ')}`,
    source: 'telemetry',
    outputs: named,
    objects: named.flatMap(o => o.pipelines)
  };
}

/** A caller that exports telemetry: Kyma's OTLP/log/trace/metric gateways and agents. */
function isTelemetryExporter(caller) {
  if (!caller || caller.namespace !== 'kyma-system') return false;
  return /^telemetry-(otlp|log|trace|metric|fluent)[\w-]*(gateway|agent)/.test(caller.name || '');
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
  the hub's private DNS answers to every viewer. Gardener providers that report hostnames are AWS.
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
 * @param {object[]} [args.pipelines]     safeList results for log/trace/metric pipelines
 * @param {object} [args.serviceBindings] a safeList result
 * @param {object} [args.serviceInstances] a safeList result
 * @param {object} [args.services]        a safeList result; the ingress gateway's LB is read from it
 * @param {object[]} [args.lbDns]         `resolveLbHostnames` output
 */
function buildNameIndex({ networkPolicies = null, pipelines = [], serviceBindings = null, serviceInstances = null, services = null, lbDns = [] } = {}) {
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
    telemetry: telemetryExport({ pipelines, serviceBindings, serviceInstances }),
    // `ips` are the addresses a provider publishes directly (Azure, GCP); `dns` resolves ELB names.
    lb: { services: lb.services, ips: [...new Set(lb.ips.map(x => x.ip))], hostnames: lb.hostnames.map(h => h.hostname), dns: lbDns || [] },
    sources: {
      networkPolicies: !networkPolicies ? 'not-read' : networkPolicies.unavailable ? 'unavailable' : 'ok',
      pipelines: !pipelines.length ? 'not-read' : pipelines.every(p => !p || p.unavailable) ? 'unavailable' : pipelines.some(p => !p || p.unavailable) ? 'partial' : 'ok',
      lbDns: (lbDns || []).some(d => d.error) ? 'partial' : 'ok'
    }
  };
}

/**
 * The name for one address, or null. `caller` is the workload that opened the connection, when
 * known: a telemetry gateway's external connection is its export, whatever the IP. `ranges: false`
 * skips the ipBlock ranges: an ingress Host that is a public IP is a client's dial, not an egress.
 *
 * @returns {{display: string, label: string, source: string, key: string|null, qualifier: string|null,
 *   objects: string[], others: string[], ambiguous?: true}|null}
 */
function nameOf(index, ip, { caller = null, ranges = true } = {}) {
  if (!index || !ip) return null;
  const list = index.byIp.get(ip);
  if (list && list.length) {
    const [top, ...rest] = list;
    /* Two policies of equal standing naming one address differently (apiserver-apppfkymaut and
       apiserver-platformsbx share IPs) is a conflict the sort would settle by object count or
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
  if (index.telemetry && isTelemetryExporter(caller)) {
    const t = index.telemetry;
    return { display: t.display, label: t.label, source: t.source, key: null, qualifier: null, objects: t.objects, others: [], namespace: null, policyName: null, cidr: null };
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

/**
 * Put names on a service map's external nodes, in place. A node is named when its address is, or
 * when every caller of it is a telemetry exporter and the pipelines are readable.
 */
function nameServiceMap(serviceMap, index) {
  if (!serviceMap || !index) return serviceMap;
  const byId = new Map(serviceMap.nodes.map(n => [n.id, n]));
  for (const node of serviceMap.nodes) {
    if (node.kind !== 'external') continue;
    const ip = ipOfNode(node);
    if (!ip) continue;
    const callers = serviceMap.edges.filter(e => e.to === node.id).map(e => byId.get(e.from)).filter(Boolean);
    const exporter = callers.length > 0 && callers.every(isTelemetryExporter) ? callers[0] : null;
    const n = nameOf(index, ip, { caller: exporter });
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
    const n = nameOf(index, ip, { caller: row.from || null });
    if (n) to.destination = n;
  }
  return rows;
}

/**
 * Traffic → Failing requests: a group's external upstream, named like a Traces node. The callers are
 * the proxies that logged it, so a telemetry gateway's export is named by caller as elsewhere.
 */
function nameFailureGroups(groups, index) {
  if (!Array.isArray(groups) || !index) return groups;
  for (const g of groups) {
    const d = g && g.destination;
    if (!d || d.kind !== 'external' || !d.ip) continue;
    const callers = (g.proxies || []).map(p => ({ namespace: p.namespace, name: p.pod || p.name }));
    const exporter = callers.length > 0 && callers.every(isTelemetryExporter) ? callers[0] : null;
    const n = nameOf(index, d.ip, { caller: exporter });
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
 * it. The caller is the proxy that logged the hop, so a telemetry gateway's export is named by
 * caller as on the map. `from` is never touched: `callerOf` already removed any client address.
 */
function nameHopEndpoints(traces, index) {
  if (!Array.isArray(traces) || !index) return traces;
  for (const t of traces) {
    for (const h of (t && t.hops) || []) {
      const to = h && h.to;
      if (!to || to.kind !== 'external' || !to.ip) continue;
      const caller = h.observedBy ? { namespace: h.observedBy.namespace, name: h.observedBy.pod } : null;
      const n = nameOf(index, to.ip, { caller: caller && isTelemetryExporter(caller) ? caller : null });
      if (n) to.destination = n;
      else to.undeclared = true;
    }
  }
  return traces;
}

/**
 * Every named destination in the index, one row per name, with the addresses it covers. The
 * telemetry export has no address of its own (it is named by caller), so it lists none.
 */
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
  if (index.telemetry) out.push({ display: index.telemetry.display, label: index.telemetry.label, source: index.telemetry.source, ips: [], objects: index.telemetry.objects });
  return out.sort((a, b) => a.display.localeCompare(b.display));
}

/** The list reads this module needs, as safeList arguments. NetworkPolicies are read whole: spec.egress is not in PartialObjectMetadata. */
const NAME_READS = {
  networkPolicies: { path: '/apis/networking.k8s.io/v1/networkpolicies?limit=1000', label: 'networkpolicies' },
  logPipelines: { path: '/apis/telemetry.kyma-project.io/v1alpha1/logpipelines', label: 'logpipelines' },
  tracePipelines: { path: '/apis/telemetry.kyma-project.io/v1alpha1/tracepipelines', label: 'tracepipelines' },
  metricPipelines: { path: '/apis/telemetry.kyma-project.io/v1alpha1/metricpipelines', label: 'metricpipelines' },
  serviceBindings: { path: '/apis/services.cloud.sap.com/v1/servicebindings?limit=1000', label: 'servicebindings' },
  serviceInstances: { path: '/apis/services.cloud.sap.com/v1/serviceinstances?limit=1000', label: 'serviceinstances' }
};

/**
 * Start every list read `buildNameIndex` needs. Returns the promise, so a collector can put it in
 * its own `Promise.all` beside the reads it already makes; `finishNameIndex` then needs the
 * Service list the collector holds anyway, for the ingress LB.
 */
function readNameSources({ listFn, baseCtx, safeList, metadataAccept }) {
  const read = r => safeList(listFn, r.metadataOnly ? { ...baseCtx, accept: metadataAccept } : baseCtx, r.path, r.label);
  return Promise.all([
    read(NAME_READS.networkPolicies),
    read(NAME_READS.logPipelines),
    read(NAME_READS.tracePipelines),
    read(NAME_READS.metricPipelines),
    read(NAME_READS.serviceBindings),
    read(NAME_READS.serviceInstances)
  ]);
}

/** Resolve the LB hostnames (cached) and build the index. `reads` is `readNameSources`' result. */
async function finishNameIndex(reads, services, { resolve4 } = {}) {
  const [networkPolicies, logs, traces, metrics, serviceBindings, serviceInstances] = reads;
  const lb = lbEntries(services);
  const lbDns = await resolveLbHostnames(lb.hostnames.map(h => h.hostname), resolve4 ? { resolve4 } : undefined);
  const index = buildNameIndex({ networkPolicies, pipelines: [logs, traces, metrics], serviceBindings, serviceInstances, services, lbDns });
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
  telemetryExport,
  isTelemetryExporter,
  resolveLbHostnames,
  lbEntries,
  NAME_READS,
  LB_DNS_TTL_MS,
  _lbCache: lbCache
};
