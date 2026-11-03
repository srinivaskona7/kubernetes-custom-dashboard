/**
 * The Problems strip's derivers: which rows each sub-tab leads with, worst first, and where a press
 * on one lands. `null` is "the source was not read" and must never read as "no problems".
 */
import { describe, expect, it } from 'vitest';
import type { IngressAccess, IngressAttention, ServiceMapEdge, ServiceMapNode, TraceEndpointStat, TraceOutboundRow, TrafficErrorGroup } from '../../api';
import { accessProblems, attentionProblems, edgeProblems, endpointProblems, failureProblems, failuresEmptyLine, outboundProblems, overviewProblems, pathProblems, problemBadges, sortProblems } from './problems';
import { visibleProblems } from './ProblemStrip';

const att = (p: Partial<IngressAttention>): IngressAttention => ({ severity: 'info', kind: 'idle-host', title: 't', detail: 'd', section: 'hosts', ...p });

describe('sortProblems', () => {
  it('orders bad, warn, info, then count, then input order', () => {
    const t = { section: 'ingress' as const };
    const out = sortProblems([
      { key: 'a', severity: 'info', title: 'a', target: t },
      { key: 'b', severity: 'warn', title: 'b', count: 1, target: t },
      { key: 'c', severity: 'warn', title: 'c', count: 5, target: t },
      { key: 'd', severity: 'bad', title: 'd', target: t },
      { key: 'e', severity: 'warn', title: 'e', count: 5, target: t }
    ]);
    expect(out.map(p => p.key)).toEqual(['d', 'c', 'e', 'b', 'a']);
  });
});

describe('attentionProblems', () => {
  it('is unavailable when the server sent no list', () => {
    expect(attentionProblems(undefined)).toBeNull();
  });

  it('maps severity, and sends listeners rows to Hosts & TLS with the object and its namespace', () => {
    const p = attentionProblems([att({ severity: 'critical', kind: 'cert-expiry', section: 'listeners', ref: 'istio-system/kyma-gateway-certs' })])![0]!;
    expect(p.severity).toBe('bad');
    expect(p.target).toEqual({ section: 'hosts', text: 'kyma-gateway-certs', namespace: 'istio-system' });
  });

  it('points a host row at the host', () => {
    const p = attentionProblems([att({ severity: 'warning', kind: 'app-404', section: 'failures', ref: 'a.example.com' })])![0]!;
    expect(p.target).toEqual({ section: 'failures', host: 'a.example.com' });
  });

  it('keeps a row whose section is unknown, on the Overview', () => {
    const p = attentionProblems([att({ section: 'nope' })])![0]!;
    expect(p.target.section).toBe('ingress');
  });
});

describe('accessProblems', () => {
  const access = (p: Partial<IngressAccess>): IngressAccess => ({
    policies: [],
    deniedTotal: 0,
    deniedByHost: [],
    peers: { distinct: 0, internal: 0, external: 0, externalAllowed: 0, externalBlockedOnly: 0 },
    proxyProtocol: null,
    peerAuthentications: [],
    unavailable: { authorizationPolicies: false, peerAuthentications: false },
    ...p
  });

  it('is unavailable when the policies were not read, never "none"', () => {
    expect(accessProblems(undefined)).toBeNull();
    expect(accessProblems(access({ unavailable: { authorizationPolicies: true, peerAuthentications: false } }))).toBeNull();
  });

  it('names each refusing policy by namespace/name with its count', () => {
    const out = accessProblems(
      access({
        policies: [{ namespace: 'istio-system', name: 'apple-acl', action: 'ALLOW', selector: null, remoteIpBlocks: 3, rules: 1, denied: 283 }],
        deniedByHost: [{ host: 'a.example.com', count: 12 }]
      })
    )!;
    // An allowlist refusing unknown clients is the policy working: info, never a warning.
    expect(out[0]).toMatchObject({ severity: 'info', title: 'AuthorizationPolicy istio-system/apple-acl', detail: 'refused 283', count: 283, target: { section: 'clients', text: 'apple-acl', namespace: 'istio-system' } });
    expect(out[1]).toMatchObject({ severity: 'info', title: 'a.example.com', count: 12 });
  });

  it('counts refusals on a bare-IP host as one item instead of listing each address', () => {
    const out = accessProblems(
      access({
        deniedByHost: [
          { host: '203.0.113.7', count: 60 },
          { host: 'a.example.com', count: 12 },
          { host: '198.51.100.2', count: 29 },
          { host: '[2001:db8::1]', count: 1 }
        ]
      })
    )!;
    expect(out.map(p => p.title)).toEqual(['Direct-IP requests', 'a.example.com']);
    expect(out[0]).toMatchObject({ severity: 'info', count: 90, detail: '90 refused across 3 addresses' });
    expect(out.some(p => /\d+\.\d+\.\d+\.\d+|::/.test(p.title + (p.detail ?? '')))).toBe(false);
  });

  it('is empty, not null, when read and nothing was refused', () => {
    expect(accessProblems(access({}))).toEqual([]);
  });
});

describe('failureProblems', () => {
  const g = (p: Partial<TrafficErrorGroup>) => ({ key: 'k', code: 503, class: 'server', count: 1, method: 'GET', path: '/x', authority: 'h', ...p }) as TrafficErrorGroup;

  it('is unavailable with no payload', () => {
    expect(failureProblems(undefined)).toBeNull();
  });

  it('lists app-owned buckets only, 5xx as bad, and opens the row', () => {
    const out = failureProblems([
      g({ key: '1', bucket: 'app-failed', count: 4 }),
      g({ key: '2', bucket: 'policy-blocked', code: 403, class: 'client', count: 99 }),
      g({ key: '3', bucket: 'not-routed', code: 404, class: 'client', count: 2 })
    ])!;
    expect(out.map(p => p.key)).toEqual(['1', '3']);
    expect(out[0]).toMatchObject({ severity: 'bad', title: '503 GET /x', detail: 'h', count: 4, target: { section: 'failures', key: '1' } });
    expect(out[1]!.severity).toBe('warn');
  });

  it('lists a group the server could not classify as info, never hiding it behind a clean strip', () => {
    const out = failureProblems([g({ key: '1', bucket: 'policy-blocked', code: 403, class: 'client' }), g({ key: '2', bucket: null, code: 0, class: 'no-response', count: 12 })])!;
    expect(out).toEqual([{ key: '2', severity: 'info', title: 'No response GET /x', detail: 'Not classified · h', count: 12, target: { section: 'failures', key: '2' } }]);
  });

  it('treats a window of only unclassified groups (bucket: null on the wire) as bucketed, not as an old server', () => {
    const out = failureProblems([g({ key: '1', bucket: null, code: 0, class: 'no-response', count: 3 })])!;
    expect(out.map(p => [p.key, p.severity])).toEqual([['1', 'info']]);
  });

  it('falls back to server-class groups when the server sends no buckets', () => {
    const out = failureProblems([g({ key: '1' }), g({ key: '2', code: 404, class: 'client' })])!;
    expect(out.map(p => p.key)).toEqual(['1']);
  });
});

describe('pathProblems', () => {
  it('lists only warn and bad hops, anchored to their card', () => {
    const out = pathProblems([
      { id: 'dns', title: 'Public DNS', facts: [], why: 'w', state: 'warn', reason: 'No DNSEntry' },
      { id: 'lb', title: 'LB', facts: [], why: 'w', state: 'ok', reason: null }
    ]);
    expect(out).toEqual([{ key: 'hop:dns', severity: 'warn', title: 'Public DNS', detail: 'No DNSEntry', target: { section: 'gateway', anchor: 'hop-dns' } }]);
  });
});

describe('endpointProblems', () => {
  const e = (p: Partial<TraceEndpointStat>): TraceEndpointStat => ({
    method: 'GET', host: 'h', path: '/p', service: null, journeys: 10, errors: 0, errorRate: 0, p50Ms: 10, p95Ms: 20, samples: 10, codes: [], lastSeen: null, sampleTraceId: 't1', ...p
  });

  it('is unavailable with no endpoints block', () => {
    expect(endpointProblems(undefined, [], 500)).toBeNull();
  });

  it('flags 5xx endpoints bad, 4xx warn, slow p95 warn, and drills to the journey', () => {
    const out = endpointProblems(
      [e({ path: '/a', errors: 3, errorRate: 0.3, codes: [{ code: 503, count: 3 }] }), e({ path: '/b', errors: 1, errorRate: 0.1, codes: [{ code: 404, count: 1 }] }), e({ path: '/c', p95Ms: 900 })],
      [],
      500
    )!;
    expect(out.map(p => [p.title, p.severity])).toEqual([['GET h/a', 'bad'], ['GET h/b', 'warn'], ['GET h/c', 'warn']]);
    expect(out[0]!.target).toEqual({ drill: { selectId: null, fetchId: 't1', search: '/a' } });
  });
});

describe('edgeProblems', () => {
  const n = (id: string): ServiceMapNode => ({ id, kind: 'workload', workloadKind: 'Deployment', name: id, namespace: 'ns' });
  const edge = (p: Partial<ServiceMapEdge>): ServiceMapEdge => ({
    from: 'a', to: 'b', calls: 10, errors: 0, errorRate: 0, p50Ms: 1, p95Ms: 2, samples: 10, codes: [], protocol: 'http', observedBy: 'both', lastSeen: null, ...p
  });

  it('is unavailable with no map', () => {
    expect(edgeProblems(undefined)).toBeNull();
  });

  it('names failing calls caller → callee and selects the arrow', () => {
    const out = edgeProblems({ nodes: [n('a'), n('b')], edges: [edge({ errors: 1, errorRate: 0.01 }), edge({ from: 'b', to: 'a', errors: 0 })] })!;
    expect(out).toEqual([{ key: 'a→b', severity: 'warn', title: 'a → b', detail: '1 of 10 calls failed', count: 1, target: { edge: 'a→b' } }]);
  });
});

describe('outboundProblems', () => {
  const ref = (id: string, kind: ServiceMapNode['kind'] = 'workload') => ({ id, kind, name: id, namespace: kind === 'external' ? null : 'ns' });
  const r = (p: Partial<TraceOutboundRow>): TraceOutboundRow => ({
    from: ref('app'), to: ref('db'), connections: 4, errors: 0, errorRate: 0, p50Ms: 1, p95Ms: 1, samples: 4, protocol: 'tcp',
    bytesSent: null, bytesReceived: null, bytesUnknown: 0, lastSeen: null, exact: 0, inferred: 4, unlinked: 0, crowded: 0,
    sample: { traceId: 't9', method: null, path: null, link: 'inferred', candidates: 1, startTime: 'x' },
    ...p
  });

  it('is unavailable on a server without outbound', () => {
    expect(outboundProblems(undefined, 'read', new Set())).toBeNull();
  });

  it('lists failing pairs and undeclared external destinations', () => {
    const out = outboundProblems([r({ errors: 2, errorRate: 0.5 }), r({ to: ref('203.0.113.9', 'external') })], 'read', new Set(['t9']))!;
    expect(out.map(p => [p.title, p.severity])).toEqual([['app → db', 'bad'], ['app → 203.0.113.9', 'info']]);
    expect(out[0]!.target).toEqual({ drill: { selectId: 't9', fetchId: null, search: 't9' } });
  });

  it('does not call an address undeclared when the policy list was not read', () => {
    expect(outboundProblems([r({ to: ref('203.0.113.9', 'external') })], 'unavailable', new Set())).toEqual([]);
  });

  it('keeps a failing row with no journey to open, landing on its own Outbound row', () => {
    const out = outboundProblems([r({ errors: 2, errorRate: 0.5, sample: null })], 'read', new Set())!;
    expect(out).toHaveLength(1);
    expect(out[0]!.target).toEqual({ outbound: 'app→db' });
  });

  it('leaves out a healthy row with no journey to open', () => {
    expect(outboundProblems([r({ to: ref('203.0.113.9', 'external'), sample: null })], 'read', new Set())).toEqual([]);
  });
});

describe('visibleProblems', () => {
  const p = (k: string) => ({ key: k, severity: 'warn' as const, title: k, target: null });

  it('shows three, then all when expanded', () => {
    const all = ['a', 'b', 'c', 'd'].map(p);
    expect(visibleProblems(all, false).map(x => x.key)).toEqual(['a', 'b', 'c']);
    expect(visibleProblems(all, true)).toHaveLength(4);
  });
});

describe('failuresEmptyLine', () => {
  const g = (p: Partial<TrafficErrorGroup>) => ({ key: 'k', code: 403, class: 'client', count: 1, method: 'GET', path: '/x', authority: 'h', ...p }) as TrafficErrorGroup;

  it('counts the requests the strip set aside as the edge working', () => {
    expect(failuresEmptyLine([g({ bucket: 'policy-blocked', count: 9 }), g({ bucket: 'tls-rejected', code: 0, count: 149 }), g({ bucket: 'direct-ip', code: 400 })])).toBe('No app failures · 159 refused at the edge');
  });

  it('on a server without buckets, counts the client failures the strip did not list', () => {
    expect(failuresEmptyLine([g({ count: 4 }), g({ code: 404, count: 2 })])).toBe('No server errors · 6 client failures listed below');
  });

  it('is undefined when nothing was set aside', () => {
    expect(failuresEmptyLine(undefined)).toBeUndefined();
    expect(failuresEmptyLine([])).toBeUndefined();
  });
});

describe('overviewProblems', () => {
  const policies = (denied: number): IngressAccess => ({
    policies: [{ namespace: 'istio-system', name: 'apple-acl', action: 'ALLOW', selector: null, remoteIpBlocks: 3, rules: 1, denied }],
    deniedTotal: denied,
    deniedByHost: [{ host: 'a.example.com', count: 12 }],
    peers: { distinct: 0, internal: 0, external: 0, externalAllowed: 0, externalBlockedOnly: 0 },
    proxyProtocol: null,
    peerAuthentications: [],
    unavailable: { authorizationPolicies: false, peerAuthentications: false }
  });
  const warn = attentionProblems([att({ severity: 'warning', kind: 'dead-envoyfilter', section: 'gateway', ref: null })])!;

  it('lists the policy-refusal line Access control shows, as info, after the attention rows', () => {
    const out = overviewProblems(warn, policies(283))!;
    expect(out.map(p => [p.title, p.severity])).toEqual([
      ['t', 'warn'],
      ['AuthorizationPolicy istio-system/apple-acl', 'info']
    ]);
    // The same row Access control lists, so a press lands on the same policy.
    expect(out[1]).toEqual(accessProblems(policies(283))![0]);
  });

  it('adds no refused-host lines: those stay on Access control', () => {
    expect(overviewProblems([], policies(1))!.map(p => p.key)).toEqual(['ap:istio-system/apple-acl']);
  });

  it('keeps the attention rows alone when the policies were not read, and stays null when the attention list was not', () => {
    expect(overviewProblems(warn, null)).toEqual(warn);
    expect(overviewProblems(null, policies(5))).toBeNull();
  });
});

describe('problemBadges', () => {
  const p = (k: string, severity: 'bad' | 'warn' | 'info' = 'warn') => ({ key: k, severity, title: k, target: null });

  it("counts exactly the rows each sub-tab's strip lists, so a badge never contradicts its strip", () => {
    const strips = { failures: [p('a', 'info')], clients: [p('b'), p('c', 'info')], hosts: [p('d', 'bad')] };
    expect(problemBadges(strips)).toEqual({ failures: 1, clients: 2, hosts: 1 });
  });

  it('shows no badge for an empty strip, and none for an unread one: an unread strip is never 0', () => {
    expect(problemBadges({ failures: [], clients: null })).toEqual({ failures: null, clients: null });
  });
});
