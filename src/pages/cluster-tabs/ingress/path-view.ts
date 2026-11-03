/**
 * Ingress & Traffic → Network Path, the rules.
 *
 * Two lanes of hops: the way a request comes in, and the way a connection goes out. Each hop is built
 * from the object that declares it — the LoadBalancer Service, the DNSEntries, the gateway pods, the
 * AuthorizationPolicies, `kube-system/shoot-info`, the mesh config — and says nothing no object says.
 * A hop whose read failed is `unavailable` with the reason; an empty list that was read is a finding
 * (`warn`), not a gap. No JSX here, so vitest's node environment can test every rule.
 *
 * Client addresses never appear: the ingress lane starts at "Internet clients" as a class, and the
 * only addresses shown are the cluster's own (load balancer, NAT) and its destinations'.
 */
import type { IngressNetworkPath, PathDestination, PathDestinationSources, PathLoadBalancer, PathObservedEgress } from '../../../api';

/**
 * `ok` only where a check ran and passed (DNSEntries Ready, gateway pods ready, a load balancer
 * present). `info` is a hop that states what an object declares and checks nothing, so it earns no
 * green dot.
 */
export type HopState = 'ok' | 'info' | 'warn' | 'bad' | 'unavailable';

export interface PathFact {
  label: string;
  /** A list renders one value per line; a string renders inline. */
  value: string | string[];
}

export interface PathHop {
  id: string;
  title: string;
  facts: PathFact[];
  /** One plain line on why the hop matters to an operator. */
  why: string;
  state: HopState;
  /** Why the hop is unavailable, or what the warning is. `null` when there is nothing to add. */
  reason: string | null;
}

function unread(id: string, title: string, why: string, reason: string): PathHop {
  return { id, title, facts: [], why, state: 'unavailable', reason };
}

/** Why `kube-system/shoot-info` facts are missing, in the terms of the object. */
function shootInfoGap(cluster: IngressNetworkPath['cluster']): string {
  if (cluster.reason === 'NOT_FOUND') return 'kube-system/shoot-info was not found, so the shoot networks are unknown';
  return `kube-system/shoot-info could not be read${cluster.reason ? ` (${cluster.reason})` : ''}`;
}

/** The load balancer card title: the provider only when srv read it, the kind only when it knows it. */
export function lbTitle(provider: string | null, kind: string | null): string {
  if (provider === 'aws') return `AWS ${kind ?? 'Elastic Load Balancer'}`;
  return kind ?? 'Cloud load balancer';
}

/** The first `n` objects and an "and N more" tail, for a cell that must stay one or two lines. */
export function truncateObjects(objects: string[], n: number): { shown: string[]; more: string | null } {
  const rest = objects.length - n;
  return { shown: objects.slice(0, n), more: rest > 0 ? `and ${rest} more` : null };
}

/** The observed row's label: the name the index gives it, else its destination address. */
export function observedLabel(o: Pick<PathObservedEgress, 'ip' | 'display'>): string {
  return o.display ?? o.ip;
}

/** The destination address of an observed row. A destination, never a client (D1 covers clients). */
export function observedAddress(o: Pick<PathObservedEgress, 'ip'>): string {
  return o.ip;
}

/** How many NetworkPolicies name egress destinations, and how many destinations and addresses they name. */
export function policyNamedDestinations(destinations: PathDestination[]): { policies: number; destinations: number; addresses: number } {
  const named = destinations.filter(d => d.source.startsWith('networkpolicy'));
  const policies = new Set(named.flatMap(d => d.objects.filter(o => o.startsWith('NetworkPolicy '))));
  const addresses = new Set(named.flatMap(d => d.ips));
  return { policies: policies.size, destinations: named.length, addresses: addresses.size };
}

/**
 * Every naming source behind `destinations` that was not read cleanly, in plain words. Non-empty
 * means an empty destination list is unknown, not "nothing named". `undefined` is an older srv that
 * does not report sources, so it claims nothing either way.
 */
export function destinationSourceGaps(src: PathDestinationSources | null | undefined): string[] {
  if (src === undefined) return [];
  if (src === null) return ['the destination sources were not reported'];
  const read = (what: string, state: 'ok' | 'unavailable' | 'not-read'): string[] =>
    state === 'unavailable' ? [`${what} could not be read`] : state === 'not-read' ? [`${what} were not read`] : [];
  return [
    ...read('NetworkPolicies', src.networkPolicies),
    ...read('telemetry pipelines', src.pipelines),
    ...(src.lbDns === 'partial' ? ['the load balancer DNS resolved only in part'] : [])
  ];
}

const count = (n: number | null | undefined): string => (n === null || n === undefined ? 'not read' : String(n));

function lbFacts(lb: PathLoadBalancer, many: boolean): PathFact[] {
  const at = many ? ` (${lb.service})` : '';
  return [
    ...(many ? [] : [{ label: 'Service', value: lb.service }]),
    { label: `Hostname${at}`, value: lb.hostnames.length ? lb.hostnames : lb.ips.length ? lb.ips : 'none assigned' },
    { label: `Resolves to${at}`, value: lb.dnsError ? `lookup failed: ${lb.dnsError}` : lb.resolvedIps.length ? lb.resolvedIps : 'not resolved on this read' },
    { label: `Proxy protocol${at}`, value: lb.proxyProtocol ? 'on' : 'off' },
    { label: `Idle timeout${at}`, value: lb.idleTimeoutSeconds === null ? 'provider default' : `${lb.idleTimeoutSeconds}s` }
  ];
}

/** Ports the Service forwards to, minus Istio's health port, which carries no request. */
function trafficPorts(lbs: PathLoadBalancer[]): PathLoadBalancer['ports'] {
  return lbs.flatMap(l => l.ports).filter(p => p.name !== 'status-port');
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The ingress lane, Internet to pod. */
export function ingressHops(path: IngressNetworkPath): PathHop[] {
  const { cluster, ingress, envoyFilters } = path;
  const lbs = ingress.loadBalancers;
  const lbProxy = lbs.some(l => l.proxyProtocol);
  const hops: PathHop[] = [];

  hops.push({
    id: 'clients',
    title: 'Internet clients',
    facts: cluster.domain ? [{ label: 'Cluster domain', value: cluster.domain }] : [],
    why: 'Where a request starts. Client addresses are counted on Access control and never listed.',
    state: 'info',
    reason: null
  });

  const dnsWhy = 'DNS entries publish the cluster names onto the load balancer hostname.';
  if (ingress.dns === null) {
    hops.push(unread('dns', 'Public DNS', dnsWhy, 'DNSEntries could not be read'));
  } else if (!ingress.dns.length) {
    hops.push({ id: 'dns', title: 'Public DNS', facts: [], why: dnsWhy, state: 'warn', reason: 'No DNSEntry publishes a name; any name here was set outside the cluster.' });
  } else {
    const notReady = ingress.dns.filter(d => d.ready === false).length;
    hops.push({
      id: 'dns',
      title: 'Public DNS',
      facts: [
        { label: 'Names', value: ingress.dns.map(d => d.dnsName) },
        { label: 'Points at', value: [...new Set(ingress.dns.flatMap(d => d.targets))] }
      ],
      why: dnsWhy,
      state: notReady ? 'warn' : 'ok',
      reason: notReady ? `${plural(notReady, 'DNSEntry', 'DNSEntries')} not Ready` : null
    });
  }

  const lbWhy = 'The provider front door. Proxy protocol carries the client address through it; the idle timeout closes quiet connections.';
  const title = lbTitle(cluster.provider, lbs[0]?.kind ?? null);
  if (ingress.servicesUnavailable) {
    hops.push(unread('lb', title, lbWhy, 'Services could not be read'));
  } else if (!lbs.length) {
    hops.push({ id: 'lb', title, facts: [], why: lbWhy, state: 'warn', reason: null });
  } else {
    hops.push({ id: 'lb', title, facts: lbs.flatMap(l => lbFacts(l, lbs.length > 1)), why: lbWhy, state: lbs.some(l => l.dnsError) ? 'warn' : 'ok', reason: null });
  }

  const policy = lbs[0]?.externalTrafficPolicy ?? null;
  const npWhy =
    policy === 'Local'
      ? 'externalTrafficPolicy Local keeps the client source address; only nodes with a gateway pod receive traffic.'
      : policy === 'Cluster'
        ? 'externalTrafficPolicy Cluster sends traffic to every node and replaces the client source address with a node address.'
        : 'The Service states no externalTrafficPolicy.';
  const gw = ingress.gatewayPods;
  if (!gw || ingress.servicesUnavailable) {
    hops.push(unread('nodeport', 'NodePort', npWhy, gw ? 'Services could not be read' : 'Pods could not be read'));
  } else {
    const nodeTotal = ingress.nodes?.total ?? null;
    hops.push({
      id: 'nodeport',
      title: 'NodePort',
      facts: [
        { label: 'Gateway nodes', value: `${plural(gw.nodes, 'node')}${gw.zones.length ? ` · ${plural(gw.zones.length, 'zone')}` : ''}` },
        { label: 'Node ports', value: trafficPorts(lbs).map(p => `${p.port} → ${p.nodePort ?? 'none'}`) },
        { label: 'Traffic policy', value: policy ?? 'not set' },
        // Zones come from the Node labels, so an unread Nodes list is unknown, not "not labelled".
        { label: 'Zones', value: ingress.nodes === null ? 'not read' : gw.zones.length ? gw.zones : 'not labelled' },
        { label: 'Cluster nodes', value: count(nodeTotal) }
      ],
      why: npWhy,
      state: gw.nodes === 0 ? 'bad' : cluster.zones.length > gw.zones.length && gw.zones.length > 0 ? 'warn' : 'ok',
      reason: gw.nodes === 0 ? 'No node runs a gateway pod' : cluster.zones.length > gw.zones.length && gw.zones.length > 0 ? `Gateway pods cover ${gw.zones.length} of ${cluster.zones.length} zones` : null
    });
  }

  const gwWhy = 'Envoy terminates the connection here and applies the Gateway, policy and route config.';
  if (!gw) {
    hops.push(unread('gateway', 'Istio ingress gateway', gwWhy, 'Pods could not be read'));
  } else {
    const targets = [...new Set(trafficPorts(lbs).map(p => p.targetPort).filter(p => p !== null))];
    const state: HopState = gw.total === 0 || gw.ready === 0 ? 'bad' : gw.ready < gw.total ? 'warn' : 'ok';
    hops.push({
      id: 'gateway',
      title: 'Istio ingress gateway',
      facts: [
        { label: 'Pods', value: `${gw.ready}/${gw.total} ready` },
        { label: 'Container ports', value: targets.length ? targets.join(', ') : 'not declared' },
        ...(envoyFilters?.istioVersion ? [{ label: 'Istio', value: envoyFilters.istioVersion }] : [])
      ],
      why: gwWhy,
      state,
      reason: state === 'ok' ? null : gw.total === 0 ? 'No gateway pod exists' : `${gw.total - gw.ready} of ${gw.total} pods not ready`
    });
  }

  const polWhy = 'AuthorizationPolicies decide which sources the gateway admits; the proxy-protocol filter lets them see the real client address.';
  if (ingress.policies === null) {
    hops.push(unread('policy', 'Access policy', polWhy, 'AuthorizationPolicies could not be read'));
  } else {
    const filter = ingress.proxyProtocolFilter;
    const mismatch = lbProxy && filter === false;
    hops.push({
      id: 'policy',
      title: 'Access policy',
      facts: [
        { label: 'AuthorizationPolicies', value: ingress.policies.length ? ingress.policies.map(p => `${p.namespace}/${p.name} ${p.action ?? 'ALLOW'}`) : 'none' },
        { label: 'Proxy-protocol filter', value: filter === null ? 'not read' : filter ? 'on' : 'off' }
      ],
      why: polWhy,
      state: !ingress.policies.length || mismatch ? 'warn' : 'ok',
      reason: mismatch
        ? 'The load balancer sends proxy protocol but no EnvoyFilter reads it, so policies see the load balancer address.'
        : !ingress.policies.length
          ? 'No AuthorizationPolicy selects the gateway; every source reaches the routes.'
          : null
    });
  }

  const tls = ingress.tlsServers;
  const serversWhy = 'A Gateway server binds hosts to a port; a TLS server terminates HTTPS with the certificate its credentialName names.';
  const serverCount = ingress.servers;
  hops.push(
    serverCount === null
      ? unread('servers', 'Gateway servers and TLS', serversWhy, 'Gateways could not be read')
      : {
          id: 'servers',
          title: 'Gateway servers and TLS',
          facts: [
            { label: 'Servers', value: String(serverCount) },
            { label: 'TLS', value: tls === undefined ? 'not reported' : tls === null ? 'not read' : `${tls} of ${plural(serverCount, 'server')}` }
          ],
          why: serversWhy,
          state: serverCount === 0 ? 'warn' : 'ok',
          reason: serverCount === 0 ? 'No Gateway server selects the ingress gateway' : null
        }
  );

  const routesWhy = 'A route maps a host and path to a Service; a host with no route answers 404 at the gateway.';
  const routeCount = ingress.routes;
  hops.push(
    routeCount === null
      ? unread('routes', 'Routes', routesWhy, 'VirtualServices, Ingresses or HTTPRoutes could not be read')
      : {
          id: 'routes',
          title: 'Routes',
          facts: [{ label: 'Routes', value: String(routeCount) }],
          why: routesWhy,
          state: routeCount === 0 ? 'warn' : 'ok',
          reason: routeCount === 0 ? 'No VirtualService, Ingress or HTTPRoute routes through the gateway' : null
        }
  );

  const svcWhy = 'The route destination; its ready endpoints are the pods that can answer.';
  hops.push(
    cluster.serviceCidr
      ? { id: 'service', title: 'Service', facts: [{ label: 'Service CIDR', value: cluster.serviceCidr }], why: svcWhy, state: 'info', reason: null }
      : unread('service', 'Service', svcWhy, shootInfoGap(cluster))
  );

  const podWhy = 'The workload, reached through its Istio sidecar.';
  hops.push(
    cluster.podCidr
      ? { id: 'pod', title: 'Pod', facts: [{ label: 'Pod CIDR', value: cluster.podCidr }], why: podWhy, state: 'info', reason: null }
      : unread('pod', 'Pod', podWhy, shootInfoGap(cluster))
  );

  return hops;
}

/** The egress lane, pod to destination. */
export function egressHops(path: IngressNetworkPath): PathHop[] {
  const { cluster, egress, ingress } = path;
  const hops: PathHop[] = [];

  const podWhy = 'Connections start from a pod address in this range.';
  hops.push(
    cluster.podCidr
      ? { id: 'pod', title: 'Pod', facts: [{ label: 'Pod CIDR', value: cluster.podCidr }], why: podWhy, state: 'info', reason: null }
      : unread('pod', 'Pod', podWhy, shootInfoGap(cluster))
  );

  const outbound = egress.outboundPolicy;
  const sideWhy =
    outbound === 'REGISTRY_ONLY'
      ? 'REGISTRY_ONLY limits sidecars to hosts a ServiceEntry declares.'
      : 'ALLOW_ANY lets a sidecar reach any external host; REGISTRY_ONLY would limit it to hosts a ServiceEntry declares.';
  if (outbound === null && egress.egressGateway === null && egress.serviceEntries === null) {
    hops.push(unread('sidecar', 'Istio sidecar', sideWhy, 'The mesh config, pods and ServiceEntries could not be read'));
  } else {
    hops.push({
      id: 'sidecar',
      title: 'Istio sidecar',
      facts: [
        { label: 'Outbound policy', value: outbound ?? 'not read' },
        { label: 'Egress gateway', value: egress.egressGateway === null ? 'not read' : egress.egressGateway ? 'present' : 'none' },
        { label: 'ServiceEntries', value: count(egress.serviceEntries) }
      ],
      why: sideWhy,
      state: 'info',
      reason: null
    });
  }

  const np = policyNamedDestinations(egress.destinations);
  const npWhy = 'Egress rules limit which addresses a pod may open connections to; their annotations name the destinations.';
  const npRead = egress.destinationSources === undefined ? 'ok' : egress.destinationSources === null ? 'not-read' : egress.destinationSources.networkPolicies;
  if (npRead !== 'ok') {
    hops.push(
      unread('netpol', 'NetworkPolicy egress allowlist', npWhy, npRead === 'unavailable' ? 'NetworkPolicies could not be read' : 'NetworkPolicies were not read on this request')
    );
  } else hops.push({
    id: 'netpol',
    title: 'NetworkPolicy egress allowlist',
    facts: np.policies
      ? [
          { label: 'NetworkPolicies', value: String(np.policies) },
          { label: 'Destinations named by policy', value: String(np.destinations) },
          { label: 'Addresses', value: String(np.addresses) }
        ]
      : [],
    why: npWhy,
    state: 'info',
    reason: np.policies ? null : 'No NetworkPolicy names an egress destination on this read.'
  });

  const nodeWhy = 'Pod traffic leaves the cluster through its node, whose address sits in this range.';
  hops.push(
    cluster.nodeCidr
      ? {
          id: 'node',
          title: 'Node',
          facts: [
            { label: 'Node CIDR', value: cluster.nodeCidr },
            { label: 'Nodes', value: count(ingress.nodes?.total) }
          ],
          why: nodeWhy,
          state: 'info',
          reason: null
        }
      : unread('node', 'Node', nodeWhy, shootInfoGap(cluster))
  );

  const natTitle = cluster.provider === 'aws' ? 'AWS NAT gateway (egress IPs)' : 'Egress NAT (egress IPs)';
  const natWhy = 'Upstream allowlists need these addresses: every connection to the internet leaves from one of them.';
  if (egress.natIps === null) {
    hops.push(unread('nat', natTitle, natWhy, shootInfoGap(cluster)));
  } else {
    const cidrs = egress.natCidrs ?? [];
    const none = !egress.natIps.length && !cidrs.length;
    hops.push({
      id: 'nat',
      title: natTitle,
      facts: [...(egress.natIps.length ? [{ label: 'Addresses', value: egress.natIps }] : []), ...(cidrs.length ? [{ label: 'Ranges', value: cidrs }] : [])],
      why: natWhy,
      state: none ? 'warn' : 'ok',
      reason: none ? 'kube-system/shoot-info lists no egress address' : null
    });
  }

  hops.push({
    id: 'destinations',
    title: 'External destinations',
    facts: [
      { label: 'Named destinations', value: String(egress.destinations.length) },
      { label: 'Observed in sample', value: egress.observed === null ? 'no sidecar sample' : String(egress.observed.length) }
    ],
    why: 'Where connections end. The tables below name each one and the object that declares it.',
    state: 'info',
    reason: null
  });

  return hops;
}
