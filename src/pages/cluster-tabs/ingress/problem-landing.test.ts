/**
 * Which Problems each Ingress sub-tab leads with, and where a press on one lands. Every row must
 * open the object it names; a row that lands on an empty table or nowhere is the dead click the
 * spec forbids.
 */
import { describe, expect, test } from 'vitest';
import type { IngressAccess, IngressAttention, IngressHost, TrafficErrorGroup, TrafficIngress } from '../../../api';
import type { PathHop } from './path-view';
import { clientsFocus, failuresLanding, hostFocus, landingParams, problemsUnreadWhy, trafficProblems } from './problem-landing';

const att = (p: Partial<IngressAttention>): IngressAttention => ({ severity: 'info', kind: 'idle-host', title: 't', detail: 'd', section: 'hosts', ...p });

const access = (p: Partial<IngressAccess> = {}): IngressAccess => ({
  policies: [],
  deniedTotal: 0,
  deniedByHost: [],
  peers: { distinct: 0, internal: 0, external: 0, externalAllowed: 0, externalBlockedOnly: 0 },
  proxyProtocol: null,
  peerAuthentications: [],
  unavailable: { authorizationPolicies: false, peerAuthentications: false },
  ...p
});

const ingressWith = (p: Partial<TrafficIngress>) => p as unknown as TrafficIngress;

const hop = (p: Partial<PathHop>): PathHop => ({ id: 'h', title: 'Hop', facts: [], state: 'ok', why: 'w', reason: null, ...p });

const group = (p: Partial<TrafficErrorGroup>) => ({ key: 'g', code: 503, class: 'server', method: 'GET', path: '/x', authority: 'a.example.com', count: 1, bucket: 'app-failed', ...p }) as TrafficErrorGroup;

describe('trafficProblems', () => {
  const attention = [
    att({ severity: 'critical', kind: 'cert-expiry', section: 'listeners', ref: 'istio-system/c1' }),
    att({ severity: 'warning', kind: 'dead-envoyfilter', section: 'gateway', ref: null }),
    att({ severity: 'critical', kind: 'app-5xx', section: 'failures', ref: 'a.example.com' })
  ];

  test('Overview lists every attention row; Hosts & TLS only the ones that land there', () => {
    const out = trafficProblems({ ingress: ingressWith({ attention }), errors: [], noEvidence: false, edgeRead: true, hops: [] });
    expect(out.ingress).toHaveLength(3);
    expect(out.hosts!.map(p => p.target.section)).toEqual(['hosts']);
  });

  test('Gateway & path merges its attention rows with the failing hops, worst first', () => {
    const out = trafficProblems({
      ingress: ingressWith({ attention }),
      errors: [],
      noEvidence: false,
      edgeRead: true,
      hops: [hop({ id: 'lb', title: 'Load balancer', state: 'bad', reason: 'down' }), hop({ id: 'ok', state: 'ok' })]
    });
    expect(out.gateway!.map(p => p.title)).toEqual(['Load balancer', 't']);
    expect(out.gateway![0]!.target).toEqual({ section: 'gateway', anchor: 'hop-lb' });
  });

  test('a dead EnvoyFilter row lands on the EnvoyFilters card', () => {
    const out = trafficProblems({ ingress: ingressWith({ attention }), errors: [], noEvidence: false, edgeRead: true, hops: [] });
    expect(out.gateway![0]!.target).toEqual({ section: 'gateway', anchor: 'gateway-envoyfilters' });
    // The same row on the Overview lands in the same place.
    expect(out.ingress!.find(p => p.target.section === 'gateway')!.target.anchor).toBe('gateway-envoyfilters');
  });

  test('an unread source is null on its sub-tab, never an empty list', () => {
    const out = trafficProblems({ ingress: undefined, errors: undefined, noEvidence: true, edgeRead: false, hops: null });
    expect(out).toEqual({ ingress: null, hosts: null, failures: null, clients: null, gateway: null });
  });

  test('Failures is unavailable when no request log was read, even with a stale error list', () => {
    const out = trafficProblems({ ingress: ingressWith({ attention: [] }), errors: [group({})], noEvidence: true, edgeRead: true, hops: [] });
    expect(out.failures).toBeNull();
  });

  test('Access control is unavailable when no ingress window exists', () => {
    const out = trafficProblems({ ingress: ingressWith({ attention: [], access: access() }), errors: [], noEvidence: false, edgeRead: false, hops: [] });
    expect(out.clients).toBeNull();
  });

  test('a host the edge saw with a broken chain is a Hosts & TLS problem that selects it', () => {
    const h = { key: 'k1', host: 'shop.example.com', edgeClass: 'app', servedBy: [], requests: 7, chain: { dns: null, servers: [] } } as unknown as IngressHost;
    const out = trafficProblems({ ingress: ingressWith({ attention: [], access: access(), hosts: [h] }), errors: [], noEvidence: false, edgeRead: true, hops: [] });
    expect(out.hosts).toEqual([
      { key: 'gap:k1', severity: 'warn', title: 'shop.example.com', detail: 'no DNSEntry, no Gateway server admits it, no route declares it', count: 7, target: { section: 'hosts', host: 'shop.example.com' } }
    ]);
    expect(out.ingress!.map(p => p.key)).toContain('gap:k1');
  });

  test('with no gateway read, rows judged from the sample are dropped and Hosts & TLS keeps only config rows', () => {
    const rows = [att({ kind: 'idle-host', section: 'hosts', ref: 'x.example.com' }), att({ severity: 'critical', kind: 'app-5xx', section: 'failures', ref: 'a.example.com' })];
    const unread = trafficProblems({ ingress: ingressWith({ attention: rows }), errors: [], noEvidence: false, edgeRead: false, hops: [] });
    expect(unread.hosts).toBeNull();
    expect(unread.ingress).toEqual([]);
    const withCert = trafficProblems({ ingress: ingressWith({ attention: [...rows, att({ severity: 'critical', kind: 'cert-expiry', section: 'listeners', ref: 'istio-system/c1' })] }), errors: [], noEvidence: false, edgeRead: false, hops: [] });
    expect(withCert.hosts!.map(p => p.key)).toEqual(['cert-expiry:2']);
  });

  test('read and clean is an empty list on every sub-tab', () => {
    const out = trafficProblems({ ingress: ingressWith({ attention: [], access: access() }), errors: [], noEvidence: false, edgeRead: true, hops: [] });
    expect(out).toEqual({ ingress: [], hosts: [], failures: [], clients: [], gateway: [] });
  });
});

describe('failuresLanding', () => {
  test('a failure group selects its row with every filter cleared', () => {
    expect(failuresLanding({ section: 'failures', key: 'g1' })).toEqual({ klass: 'all', search: '', selectedKey: 'g1' });
  });
  test('a host row filters the list to that host', () => {
    expect(failuresLanding({ section: 'failures', host: 'a.example.com' })).toEqual({ klass: 'all', search: 'a.example.com', selectedKey: null });
  });
});

describe('hostFocus', () => {
  const hosts = [{ key: 'k1', host: 'a.example.com' }, { key: 'k2', host: 'b.example.com' }] as IngressHost[];
  test('selects the host row when it is listed', () => {
    expect(hostFocus(hosts, 'b.example.com')).toEqual({ selectKey: 'k2', search: null });
  });
  test('searches for a host the capped list does not hold, so the absence is visible', () => {
    expect(hostFocus(hosts, 'c.example.com')).toEqual({ selectKey: null, search: 'c.example.com' });
  });
  test('does nothing without a host', () => {
    expect(hostFocus(hosts, null)).toBeNull();
  });
});

describe('clientsFocus', () => {
  const a = access({
    policies: [{ namespace: 'istio-system', name: 'apple-acl', action: 'ALLOW', selector: null, remoteIpBlocks: 3, rules: 1, denied: 283 }],
    deniedByHost: [{ host: 'a.example.com', count: 12 }]
  });
  test('a refusing policy selects its row in AuthorizationPolicies', () => {
    expect(clientsFocus(a, { text: 'apple-acl' })).toEqual({ table: 'policies', key: 'istio-system/apple-acl' });
  });
  test('a refused host selects its row in Denied by host', () => {
    expect(clientsFocus(a, { host: 'a.example.com' })).toEqual({ table: 'denied', key: 'a.example.com' });
  });
  test('a namespaced policy selects that namespace\'s row, not the first one with the name', () => {
    const two = access({
      policies: [
        { namespace: 'app', name: 'deny', action: 'DENY', selector: null, remoteIpBlocks: 0, rules: 1, denied: 0 },
        { namespace: 'shop', name: 'deny', action: 'DENY', selector: null, remoteIpBlocks: 0, rules: 1, denied: 9 }
      ]
    });
    expect(clientsFocus(two, { text: 'deny', namespace: 'shop' })).toEqual({ table: 'policies', key: 'shop/deny' });
  });
  test('names nothing it cannot find', () => {
    expect(clientsFocus(a, { text: 'gone' })).toBeNull();
    expect(clientsFocus(undefined, { host: 'a.example.com' })).toBeNull();
    expect(clientsFocus(a, null)).toBeNull();
  });
});

describe('landingParams', () => {
  test('moves to the section, closes the proxies panel and drops the resource drawer in one write', () => {
    const out = landingParams(new URLSearchParams('tab=traffic&section=ingress&proxies=1&res=Pod/a/b&ns=x'), 'hosts');
    expect(out.get('section')).toBe('hosts');
    expect(out.has('proxies')).toBe(false);
    expect(out.has('res')).toBe(false);
    expect(out.get('ns')).toBe('x');
    expect(out.get('tab')).toBe('traffic');
  });
  test('does not change the params it was given', () => {
    const prev = new URLSearchParams('section=ingress&proxies=1');
    landingParams(prev, 'gateway');
    expect(prev.toString()).toBe('section=ingress&proxies=1');
  });
});

describe('problemsUnreadWhy', () => {
  test('names the read that each unavailable strip is missing', () => {
    const why = problemsUnreadWhy({ ingress: ingressWith({}), edgeRead: true, notReadWhy: 'the access log goes to kyma-logs' });
    expect(why.failures).toBe('the access log goes to kyma-logs');
    expect(why.ingress).toMatch(/^The attention list is not reported by this server/);
    expect(why.hosts).toBe(why.ingress);
    expect(why.gateway).toBe(why.ingress);
    expect(why.clients).toMatch(/^AuthorizationPolicies is not reported by this server/);
  });
  test('Access control says which of its two reads failed', () => {
    const refused = ingressWith({ access: access({ unavailable: { authorizationPolicies: true, peerAuthentications: false } }) });
    expect(problemsUnreadWhy({ ingress: refused, edgeRead: true, notReadWhy: '' }).clients).toBe('could not read AuthorizationPolicies');
    expect(problemsUnreadWhy({ ingress: refused, edgeRead: false, notReadWhy: '' }).clients).toBe('no ingress gateway proxy was read for this cluster');
  });
});
