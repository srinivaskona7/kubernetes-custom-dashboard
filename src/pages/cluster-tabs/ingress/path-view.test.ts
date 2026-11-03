/**
 * The Network Path hops. Every hop states what an object declares, and a hop whose read failed says
 * so: these tests pin that a `null` becomes "unavailable" with its reason, never a zero or a default.
 */
import { describe, expect, test } from 'vitest';
import type { IngressNetworkPath } from '../../../api';
import { destinationSourceGaps, egressHops, ingressHops, lbTitle, observedLabel, policyNamedDestinations, truncateObjects } from './path-view';

/** The platform-sbx shape read on 2026-09-26, trimmed to what the hops read. */
function livePath(): IngressNetworkPath {
  return {
    cluster: {
      provider: 'aws',
      region: 'us-east-1',
      zones: ['us-east-1a', 'us-east-1b', 'us-east-1d'],
      domain: 'c-9d0a141.kyma.ondemand.com',
      shootName: 'c-9d0a141',
      nodeCidr: '10.250.0.0/16',
      podCidr: '100.96.0.0/11',
      serviceCidr: '100.64.0.0/13',
      unavailable: false,
      reason: null
    },
    ingress: {
      dns: [{ name: 'kyma-system/kyma-gateway', dnsName: '*.c-9d0a141.kyma.ondemand.com', targets: ['a959.elb.amazonaws.com'], ready: true }],
      loadBalancers: [
        {
          service: 'istio-system/istio-ingressgateway',
          kind: 'Classic Load Balancer',
          hostnames: ['a959.elb.amazonaws.com'],
          ips: [],
          resolvedIps: ['32.197.162.126', '98.83.101.14', '98.87.43.3'],
          resolvedAt: '2026-09-26T07:02:51.435Z',
          dnsError: null,
          proxyProtocol: true,
          idleTimeoutSeconds: 4000,
          externalTrafficPolicy: 'Local',
          ports: [
            { name: 'status-port', port: 15021, targetPort: 15021, nodePort: 30390, protocol: 'TCP' },
            { name: 'http2', port: 80, targetPort: 8080, nodePort: 31293, protocol: 'TCP' },
            { name: 'https', port: 443, targetPort: 8443, nodePort: 31430, protocol: 'TCP' }
          ]
        }
      ],
      servicesUnavailable: false,
      gatewayPods: { total: 3, ready: 3, nodes: 3, zones: ['us-east-1a', 'us-east-1b', 'us-east-1d'] },
      nodes: { total: 3, zones: ['us-east-1a', 'us-east-1b', 'us-east-1d'] },
      proxyProtocolFilter: true,
      policies: [{ namespace: 'istio-system', name: 'apple-acl', action: 'ALLOW' }],
      servers: 6,
      tlsServers: 5,
      routes: 13
    },
    egress: {
      natIps: ['34.200.180.67', '54.209.206.118', '3.211.197.234'],
      natCidrs: [],
      egressGateway: false,
      serviceEntries: 0,
      outboundPolicy: 'ALLOW_ANY',
      destinations: [
        { display: 'External API', label: 'External API', source: 'networkpolicy-prose', ips: ['23.20.180.97'], objects: ['NetworkPolicy gatekeeper-system/egress-allow-gatekeeper'] },
        { display: 'xsuaa', label: 'xsuaa', source: 'networkpolicy', ips: ['3.214.110.153'], objects: ['NetworkPolicy a/one', 'NetworkPolicy b/two'] },
        { display: 'CLS ingest', label: 'CLS ingest', source: 'telemetry', ips: ['54.86.56.192'], objects: ['LogPipeline x'] }
      ],
      observed: [{ ip: '54.86.56.192', display: 'SAP Cloud Logging', source: 'telemetry', requests: 307, callers: ['kyma-system/otlp-a'], callersTotal: 1 }]
    },
    envoyFilters: { istioVersion: '1.30.4' }
  };
}

const byId = <T extends { id: string }>(hops: T[], id: string): T => {
  const hop = hops.find(h => h.id === id);
  if (!hop) throw new Error(`no hop ${id}`);
  return hop;
};
const fact = (hop: { facts: { label: string; value: string | string[] }[] }, label: string) => hop.facts.find(f => f.label === label)?.value;

describe('ingressHops', () => {
  test('draws the ten hops in the order a request takes them', () => {
    expect(ingressHops(livePath()).map(h => h.id)).toEqual(['clients', 'dns', 'lb', 'nodeport', 'gateway', 'policy', 'servers', 'routes', 'service', 'pod']);
  });

  test('the live platform-sbx path reads as the objects declare it', () => {
    const hops = ingressHops(livePath());
    expect(byId(hops, 'lb').title).toBe('AWS Classic Load Balancer');
    expect(fact(byId(hops, 'lb'), 'Resolves to')).toEqual(['32.197.162.126', '98.83.101.14', '98.87.43.3']);
    expect(fact(byId(hops, 'lb'), 'Proxy protocol')).toBe('on');
    expect(fact(byId(hops, 'lb'), 'Idle timeout')).toBe('4000s');
    expect(byId(hops, 'nodeport').title).toBe('NodePort');
    expect(fact(byId(hops, 'nodeport'), 'Gateway nodes')).toBe('3 nodes · 3 zones');
    expect(byId(hops, 'nodeport').why).toMatch(/externalTrafficPolicy Local keeps the client source address; only nodes with a gateway pod receive traffic/);
    expect(fact(byId(hops, 'nodeport'), 'Node ports')).toEqual(['80 → 31293', '443 → 31430']);
    expect(fact(byId(hops, 'gateway'), 'Pods')).toBe('3/3 ready');
    expect(fact(byId(hops, 'gateway'), 'Container ports')).toBe('8080, 8443');
    expect(fact(byId(hops, 'servers'), 'TLS')).toBe('5 of 6 servers');
    expect(fact(byId(hops, 'routes'), 'Routes')).toBe('13');
    // Green only where a check ran; a hop that only states a fact is neutral, not healthy.
    expect(Object.fromEntries(hops.map(h => [h.id, h.state]))).toEqual({
      clients: 'info', dns: 'ok', lb: 'ok', nodeport: 'ok', gateway: 'ok', policy: 'ok', servers: 'ok', routes: 'ok', service: 'info', pod: 'info'
    });
  });

  test('no egress hop claims health it did not check', () => {
    const hops = egressHops(livePath());
    expect(Object.fromEntries(hops.map(h => [h.id, h.state]))).toEqual({
      pod: 'info', sidecar: 'info', netpol: 'info', node: 'info', nat: 'ok', destinations: 'info'
    });
  });

  test('a hop whose read failed is unavailable with its reason, never a zero', () => {
    const p = livePath();
    p.ingress.dns = null;
    p.ingress.gatewayPods = null;
    p.ingress.policies = null;
    p.ingress.servicesUnavailable = true;
    const hops = ingressHops(p);
    for (const id of ['dns', 'lb', 'nodeport', 'gateway', 'policy']) {
      const hop = byId(hops, id);
      expect(hop.state, id).toBe('unavailable');
      expect(hop.reason, id).toMatch(/could not be read/);
      expect(hop.facts, id).toEqual([]);
    }
  });

  test('shoot-info missing leaves the CIDR hops unavailable and says which object', () => {
    const p = livePath();
    p.cluster = { ...p.cluster, unavailable: true, reason: 'NOT_FOUND', nodeCidr: null, podCidr: null, serviceCidr: null };
    const service = byId(ingressHops(p), 'service');
    expect(service.state).toBe('unavailable');
    expect(service.reason).toMatch(/kube-system\/shoot-info was not found/);
  });

  test('servers or routes unread is an unavailable hop, never a 0', () => {
    const p = livePath();
    p.ingress.servers = null;
    p.ingress.tlsServers = null;
    p.ingress.routes = null;
    const hops = ingressHops(p);
    for (const id of ['servers', 'routes']) {
      const hop = byId(hops, id);
      expect(hop.state, id).toBe('unavailable');
      expect(hop.reason, id).toMatch(/could not be read/);
      expect(hop.facts, id).toEqual([]);
    }
  });

  test('TLS count unread alone says "not read" beside a real server count', () => {
    const p = livePath();
    p.ingress.tlsServers = null;
    expect(fact(byId(ingressHops(p), 'servers'), 'TLS')).toBe('not read');
    expect(fact(byId(ingressHops(p), 'servers'), 'Servers')).toBe('6');
  });

  test('NodePort zones are "not read" when the Nodes read failed', () => {
    const p = livePath();
    p.ingress.nodes = null;
    const np = byId(ingressHops(p), 'nodeport');
    expect(fact(np, 'Zones')).toBe('not read');
    expect(fact(np, 'Cluster nodes')).toBe('not read');
  });

  test('an empty list is a finding, not a gap', () => {
    const p = livePath();
    p.ingress.dns = [];
    p.ingress.policies = [];
    p.ingress.loadBalancers = [];
    const hops = ingressHops(p);
    expect(byId(hops, 'dns').state).toBe('warn');
    expect(byId(hops, 'policy').state).toBe('warn');
    expect(byId(hops, 'lb').state).toBe('warn');
    expect(byId(hops, 'lb').reason).toBeNull();
  });

  test('proxy protocol on the load balancer without the gateway filter is flagged', () => {
    const p = livePath();
    p.ingress.proxyProtocolFilter = false;
    expect(byId(ingressHops(p), 'policy').state).toBe('warn');
  });

  test('gateway pods not all ready is a warning; none ready is bad', () => {
    const p = livePath();
    p.ingress.gatewayPods = { total: 3, ready: 2, nodes: 3, zones: [] };
    expect(byId(ingressHops(p), 'gateway').state).toBe('warn');
    p.ingress.gatewayPods = { total: 3, ready: 0, nodes: 3, zones: [] };
    expect(byId(ingressHops(p), 'gateway').state).toBe('bad');
  });

  test('a Cluster traffic policy explains the lost source address instead', () => {
    const p = livePath();
    p.ingress.loadBalancers = p.ingress.loadBalancers.map(l => ({ ...l, externalTrafficPolicy: 'Cluster' }));
    expect(byId(ingressHops(p), 'nodeport').why).toMatch(/replaces the client source address/);
  });
});

describe('egressHops', () => {
  test('draws the six hops in the order a connection takes them', () => {
    expect(egressHops(livePath()).map(h => h.id)).toEqual(['pod', 'sidecar', 'netpol', 'node', 'nat', 'destinations']);
  });

  test('the live platform-sbx egress', () => {
    const hops = egressHops(livePath());
    expect(fact(byId(hops, 'pod'), 'Pod CIDR')).toBe('100.96.0.0/11');
    expect(fact(byId(hops, 'sidecar'), 'Outbound policy')).toBe('ALLOW_ANY');
    expect(fact(byId(hops, 'sidecar'), 'Egress gateway')).toBe('none');
    expect(fact(byId(hops, 'sidecar'), 'ServiceEntries')).toBe('0');
    expect(fact(byId(hops, 'netpol'), 'NetworkPolicies')).toBe('3');
    // Policy-only, so it cannot share a label with the destinations hop's all-sources count.
    expect(byId(hops, 'netpol').facts.map(f => f.label)).toContain('Destinations named by policy');
    expect(byId(hops, 'netpol').facts.map(f => f.label)).not.toContain('Named destinations');
    expect(fact(byId(hops, 'node'), 'Node CIDR')).toBe('10.250.0.0/16');
    expect(byId(hops, 'nat').title).toBe('AWS NAT gateway (egress IPs)');
    expect(fact(byId(hops, 'nat'), 'Addresses')).toEqual(['34.200.180.67', '54.209.206.118', '3.211.197.234']);
    expect(byId(hops, 'nat').why).toMatch(/upstream allowlists need these addresses/i);
  });

  test('NAT unread is unavailable; a sidecar fact unread says "not read", never a default', () => {
    const p = livePath();
    p.egress.natIps = null;
    p.egress.egressGateway = null;
    p.egress.serviceEntries = null;
    p.egress.outboundPolicy = null;
    const hops = egressHops(p);
    expect(byId(hops, 'nat').state).toBe('unavailable');
    const sidecar = byId(hops, 'sidecar');
    expect(sidecar.state).toBe('unavailable');
    expect(sidecar.facts).toEqual([]);
  });

  test('one sidecar fact unread keeps the others', () => {
    const p = livePath();
    p.egress.serviceEntries = null;
    expect(fact(byId(egressHops(p), 'sidecar'), 'ServiceEntries')).toBe('not read');
    expect(fact(byId(egressHops(p), 'sidecar'), 'Outbound policy')).toBe('ALLOW_ANY');
  });

  test('the NetworkPolicy hop is unavailable when the NetworkPolicy read did not succeed', () => {
    const p = livePath();
    p.egress.destinationSources = { networkPolicies: 'unavailable', pipelines: 'ok', lbDns: 'ok' };
    const np = byId(egressHops(p), 'netpol');
    expect(np.state).toBe('unavailable');
    expect(np.reason).toMatch(/NetworkPolicies could not be read/);
    p.egress.destinationSources = { networkPolicies: 'not-read', pipelines: 'ok', lbDns: 'ok' };
    expect(byId(egressHops(p), 'netpol').state).toBe('unavailable');
    p.egress.destinationSources = { networkPolicies: 'ok', pipelines: 'ok', lbDns: 'ok' };
    expect(byId(egressHops(p), 'netpol').state).toBe('info');
  });

  test('destinationSourceGaps names every source that was not read cleanly', () => {
    expect(destinationSourceGaps({ networkPolicies: 'ok', pipelines: 'ok', lbDns: 'ok' })).toEqual([]);
    expect(destinationSourceGaps({ networkPolicies: 'unavailable', pipelines: 'not-read', lbDns: 'partial' })).toEqual([
      'NetworkPolicies could not be read',
      'telemetry pipelines were not read',
      'the load balancer DNS resolved only in part'
    ]);
    expect(destinationSourceGaps(null)).toEqual(['the destination sources were not reported']);
    expect(destinationSourceGaps(undefined)).toEqual([]);
  });

  test('no observed sample says so rather than zero', () => {
    const p = livePath();
    p.egress.observed = null;
    expect(fact(byId(egressHops(p), 'destinations'), 'Observed in sample')).toBe('no sidecar sample');
  });
});

describe('helpers', () => {
  test('lbTitle names the provider only when it knows it', () => {
    expect(lbTitle('aws', 'Network Load Balancer')).toBe('AWS Network Load Balancer');
    expect(lbTitle('aws', null)).toBe('AWS Elastic Load Balancer');
    expect(lbTitle('gcp', null)).toBe('Cloud load balancer');
    expect(lbTitle(null, null)).toBe('Cloud load balancer');
  });

  test('truncateObjects keeps the first n and counts the rest', () => {
    expect(truncateObjects(['a', 'b', 'c', 'd'], 2)).toEqual({ shown: ['a', 'b'], more: 'and 2 more' });
    expect(truncateObjects(['a', 'b'], 2)).toEqual({ shown: ['a', 'b'], more: null });
  });

  test('observedLabel prefers the name, falls back to the destination address', () => {
    expect(observedLabel({ ip: '1.2.3.4', display: 'SAP Cloud Logging' })).toBe('SAP Cloud Logging');
    expect(observedLabel({ ip: '1.2.3.4', display: null })).toBe('1.2.3.4');
  });

  test('policyNamedDestinations counts only NetworkPolicy sources and their distinct objects', () => {
    expect(policyNamedDestinations(livePath().egress.destinations)).toEqual({ policies: 3, destinations: 2, addresses: 2 });
  });
});
