/**
 * The classified edge's ordering and gap rules. Each of these is a claim an operator acts on — which
 * host is broken, which failure is theirs, whether a p95 exists — so each gets a test.
 */
import { describe, expect, test } from 'vitest';
import type { IngressAttention, IngressCertificate, IngressClient, IngressHost, IngressLb, TrafficErrorGroup } from '../../../api';
import {
  appP95Line,
  attentionTarget,
  bucketFailures,
  certForServer,
  certTone,
  chainLinks,
  classBreakdown,
  classFilterChips,
  classUnits,
  connectionsByClass,
  daysLeftText,
  failingUpstreams,
  failureBucketState,
  hostRank,
  joinGaps,
  lbAddressRows,
  listablePeers,
  matchesClassFilter,
  notFromServer,
  peerAddress,
  readFailed,
  routingUnread,
  sortAttention,
  sortHosts,
  TRAFFIC_SECTION_IDS
} from './edge-view';

const NO_LATENCY = { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };

function host(over: Partial<IngressHost> = {}): IngressHost {
  return {
    key: over.host ?? 'shop.example.com',
    host: 'shop.example.com',
    group: 'declared',
    matchedSuffix: null,
    gateway: null,
    servedBy: [{ kind: 'HTTPRoute', name: 'shop', namespace: 'shop', evidence: '', matched: 'shop.example.com' }],
    requests: 10,
    ok: 10,
    redirect: 0,
    client: 0,
    server: 0,
    noResponse: 0,
    errorShare: 0,
    total: NO_LATENCY,
    upstream: NO_LATENCY,
    overheadMs: null,
    methods: [],
    paths: [],
    codes: [],
    flags: [],
    details: [],
    clients: 1,
    externalClients: 1,
    sni: 0,
    ports: [],
    bytesSent: null,
    bytesReceived: null,
    proxies: [],
    firstSeen: null,
    lastSeen: null,
    edgeClass: 'app',
    chain: {
      dns: { name: 'shop', dnsName: 'shop.example.com', ready: true },
      servers: [
        {
          gateway: 'platform-system/main-gateway',
          port: 443,
          tlsMode: 'SIMPLE',
          credentialName: 'main-gateway-certs',
          certificate: { namespace: 'istio-system', name: 'wildcard', expires: '2026-12-02', daysLeft: 67, ready: true }
        }
      ]
    },
    ...over
  };
}

function group(over: Partial<TrafficErrorGroup> = {}): TrafficErrorGroup {
  return {
    key: String(Math.random()),
    code: 503,
    class: 'server',
    method: 'GET',
    path: '/',
    authority: 'shop.example.com',
    protocol: 'HTTP/1.1',
    count: 1,
    firstSeen: null,
    lastSeen: null,
    responseFlags: [],
    responseCodeDetails: [],
    transportFailures: [],
    p50Ms: null,
    maxMs: null,
    upstream: null,
    gateway: null,
    destination: null,
    sources: [],
    proxies: [],
    samples: [],
    ...over
  };
}

describe('attention', () => {
  const row = (severity: IngressAttention['severity'], title: string, section = 'hosts'): IngressAttention => ({
    severity,
    kind: 'cert-expiry',
    title,
    detail: '',
    section,
    ref: null
  });

  test('critical before warning before info, server order kept within a severity', () => {
    const out = sortAttention([row('info', 'i1'), row('warning', 'w1'), row('critical', 'c1'), row('warning', 'w2'), row('critical', 'c2')]);
    expect(out.map(r => r.title)).toEqual(['c1', 'c2', 'w1', 'w2', 'i1']);
  });

  test('absent list is empty, not an error', () => {
    expect(sortAttention(undefined)).toEqual([]);
  });

  test('a section this tab does not have is not a link', () => {
    expect(attentionTarget(row('info', 'x', 'gateway'), ['ingress', 'gateway'] as const)).toBe('gateway');
    expect(attentionTarget(row('info', 'x', 'nowhere'), ['ingress', 'gateway'] as const)).toBeNull();
  });
});

describe('class breakdown', () => {
  test('app first, refusals last, share over the total', () => {
    const out = classBreakdown({
      total: 400,
      rows: [
        { key: 'tls-rejected', records: 155, requests: 0, codes: [] },
        { key: 'probe', records: 238, requests: 238, codes: [] },
        { key: 'app', records: 5, requests: 5, codes: [] }
      ]
    });
    expect(out.map(r => r.key)).toEqual(['app', 'probe', 'tls-rejected']);
    expect(out[0]?.share).toBeCloseTo(5 / 400);
  });

  test('no denominator is a null share, not 0%', () => {
    expect(classBreakdown({ total: 0, rows: [{ key: 'app', records: 0, requests: 0, codes: [] }] })[0]?.share).toBeNull();
    expect(classBreakdown(undefined)).toEqual([]);
  });
});

describe('app p95', () => {
  const app = { requests: 5, errors: 2, server: 0, client: 2, notFound: 2, samples: 5, minSamples: 20, p50Ms: null, p95Ms: null, hosts: [] };
  test('under the floor says so, with the count', () => {
    const l = appP95Line(app);
    expect(l.value).toBe('too few samples');
    expect(l.why).toContain('too few samples (5 of 20)');
  });
  test('over the floor prints the number', () => {
    expect(appP95Line({ ...app, samples: 40, p95Ms: 120, p50Ms: 30 }).value).toBe('120 ms');
  });
});

describe('certificates', () => {
  test('attention follows the issuer: renewal overdue or under 7 days, never a steady-state countdown (UI_SPEC §13a)', () => {
    // cert-manager renews with a third of a 90-day life left, so 39-66 days left with renewal pending is healthy.
    expect(certTone({ daysLeft: 39, ready: true, renewalOverdue: false })).toBe('ok');
    expect(certTone({ daysLeft: 20, ready: true, renewalOverdue: false })).toBe('ok');
    expect(certTone({ daysLeft: 40, ready: true, renewalOverdue: true })).toBe('warn');
    expect(certTone({ daysLeft: 6, ready: true, renewalOverdue: false })).toBe('bad');
    // No renewal time from the issuer: fall back to under 30 days.
    expect(certTone({ daysLeft: 29, ready: true })).toBe('warn');
    expect(certTone({ daysLeft: 29, ready: true, renewalOverdue: null })).toBe('warn');
    expect(certTone({ daysLeft: 45, ready: true })).toBe('ok');
    expect(certTone({ daysLeft: null, ready: true })).toBe('unknown');
    expect(certTone({ daysLeft: 200, ready: false })).toBe('bad');
  });
  test('a server finds its certificate by usedBy first, then by Secret name', () => {
    const cert = (over: Partial<IngressCertificate>): IngressCertificate => ({
      namespace: 'istio-system',
      name: 'wildcard',
      secretName: 'main-gateway-certs',
      commonName: null,
      dnsNames: [],
      expires: null,
      daysLeft: 67,
      ready: true,
      issuer: null,
      usedBy: [],
      ...over
    });
    const byKey = cert({ name: 'by-key', secretName: 'other', usedBy: ['platform-system/main-gateway/443'] });
    const bySecret = cert({ name: 'by-secret' });
    const server = { key: 'platform-system/main-gateway/443', credentialName: 'main-gateway-certs' };
    expect(certForServer(server, [bySecret, byKey])?.name).toBe('by-key');
    expect(certForServer({ ...server, key: 'x' }, [bySecret])?.name).toBe('by-secret');
    expect(certForServer({ key: 'x', credentialName: null }, [bySecret])).toBeNull();
    expect(certForServer(server, undefined)).toBeNull();
  });

  test('expired reads as expired', () => {
    expect(daysLeftText(-3)).toBe('expired 3 d ago');
    expect(daysLeftText(null)).toBe('expiry not reported');
  });
});

describe('hosts & routes order', () => {
  test('a complete chain has no gap; each missing link is named', () => {
    expect(joinGaps(host())).toEqual([]);
    expect(joinGaps(host({ chain: { dns: null, servers: [] }, servedBy: [] }))).toEqual([
      'no DNSEntry',
      'no Gateway server admits it',
      'no route declares it'
    ]);
    const noCert = host({ chain: { dns: { name: 'a', dnsName: 'a', ready: true }, servers: [{ gateway: 'g', port: 443, tlsMode: 'SIMPLE', credentialName: 's', certificate: null }] } });
    expect(joinGaps(noCert)).toEqual([':443 names no readable certificate']);
  });

  test('an unread DNSEntry list is unknown, not a missing DNSEntry', () => {
    const unread = host({ chain: { dns: undefined, servers: host().chain?.servers ?? [] } });
    expect(joinGaps(unread)).toEqual([]);
    expect(chainLinks(unread)[0]).toMatchObject({ step: 'DNS', tone: 'unknown', text: 'not read' });
  });

  test('an unread Certificates list is unknown, not a missing certificate', () => {
    const unread = host({
      chain: { dns: { name: 'a', dnsName: 'a', ready: true }, servers: [{ gateway: 'g', port: 443, tlsMode: 'SIMPLE', credentialName: 's', certificate: undefined }] }
    });
    expect(joinGaps(unread)).toEqual([]);
    expect(hostRank(unread)).not.toBe(0);
    expect(chainLinks(unread).find(l => l.step === 'Certificate')).toMatchObject({ tone: 'unknown', text: 'not read' });
  });

  test('an unread Gateways list is unknown, not a host no server admits', () => {
    const unread = host({ chain: { dns: { name: 'a', dnsName: 'a', ready: true }, servers: undefined } });
    expect(joinGaps(unread)).toEqual([]);
    expect(hostRank(unread)).not.toBe(0);
    const links = chainLinks(unread);
    expect(links.find(l => l.step === 'Gateway')).toMatchObject({ tone: 'unknown', text: 'not read' });
    // With the servers unknown, whether a certificate is expected is unknown too: no Certificate link.
    expect(links.map(l => l.step)).toEqual(['DNS', 'Gateway', 'Route']);
  });

  test('no chain and direct-IP hosts are never join gaps', () => {
    expect(joinGaps(host({ chain: undefined, servedBy: [] }))).toEqual([]);
    expect(joinGaps(host({ edgeClass: 'direct-ip', chain: { dns: null, servers: [] }, servedBy: [] }))).toEqual([]);
  });

  test('broken joins, then failures, then requests, then idle', () => {
    const idle = host({ host: 'idle.example.com', requests: 0, ok: 0 });
    const busy = host({ host: 'busy.example.com', requests: 90, ok: 90 });
    const failing = host({ host: 'fail.example.com', requests: 3, ok: 1, server: 2 });
    const broken = host({ host: 'broken.example.com', servedBy: [] });
    const blocked = host({ host: 'blocked.example.com', edgeClass: 'policy-blocked', requests: 50, ok: 0, client: 50 });
    const out = sortHosts([idle, busy, blocked, failing, broken]);
    expect(out.map(h => h.host)).toEqual(['broken.example.com', 'fail.example.com', 'busy.example.com', 'blocked.example.com', 'idle.example.com']);
    // 403s from the allowlist are not a failure of the host.
    expect(hostRank(blocked)).toBe(2);
  });

  test('the chain reads DNS, Gateway server, certificate, route — each with its own verdict', () => {
    expect(chainLinks(host()).map(l => [l.step, l.text, l.tone])).toEqual([
      ['DNS', 'shop', 'ok'],
      ['Gateway', ':443 SIMPLE', 'ok'],
      ['Certificate', '67 d left', 'ok'],
      ['Route', 'HTTPRoute shop', 'ok']
    ]);
    const broken = chainLinks(host({ chain: { dns: null, servers: [] }, servedBy: [] }));
    expect(broken.map(l => [l.step, l.tone])).toEqual([
      ['DNS', 'warn'],
      ['Gateway', 'warn'],
      ['Route', 'warn']
    ]);
    expect(chainLinks(host({ chain: undefined }))).toEqual([]);
  });

  test('class filter: all passes everything, a class only its own rows', () => {
    expect(matchesClassFilter(host({ edgeClass: 'probe' }), 'all')).toBe(true);
    expect(matchesClassFilter(host({ edgeClass: 'probe' }), 'app')).toBe(false);
    expect(matchesClassFilter(host({ edgeClass: 'app' }), 'app')).toBe(true);
  });

  test('class chips come from the rows, in class order', () => {
    const chips = classFilterChips([host({ edgeClass: 'probe' }), host({ edgeClass: 'app' }), host({ edgeClass: 'app' })]);
    expect(chips.map(c => [c.id, c.count])).toEqual([
      ['all', 3],
      ['app', 2],
      ['probe', 1]
    ]);
  });
});

describe('failure buckets', () => {
  test('bucket order, empty buckets dropped, unbucketed last', () => {
    const out = bucketFailures([
      group({ bucket: 'tls-rejected', count: 155 }),
      group({ count: 4 }),
      group({ bucket: 'app-failed', count: 2 }),
      group({ bucket: 'app-failed', count: 3 })
    ]);
    expect(out.map(b => [b.bucket, b.requests])).toEqual([
      ['app-failed', 5],
      ['tls-rejected', 155],
      ['unclassified', 4]
    ]);
  });

  test('upstream targets only for failures the operator owns, flags split on commas', () => {
    const out = failingUpstreams([
      group({ bucket: 'app-failed', count: 2, responseFlags: ['UF,URX'], upstream: { raw: 'outbound|8080||shop.shop.svc.cluster.local', direction: 'outbound', port: 8080, subset: null, fqdn: 'shop.shop.svc.cluster.local', service: null } }),
      group({ bucket: 'policy-blocked', count: 50, code: 403 }),
      group({ bucket: 'not-routed', count: 1, code: 404 })
    ]);
    expect(out.map(u => [u.target, u.requests])).toEqual([
      ['outbound|8080||shop.shop.svc.cluster.local', 2],
      ['no upstream chosen', 1]
    ]);
    expect(out[0]?.flags).toEqual(['UF', 'URX']);
  });
});

describe('direct-ip bucket and the empty window', () => {
  test('direct-ip sorts after tls-rejected and is not the operator\'s upstream', () => {
    const out = bucketFailures([
      group({ bucket: 'direct-ip', count: 26, code: 400 }),
      group({ bucket: 'tls-rejected', count: 155 }),
      group({ bucket: 'app-failed', count: 2 })
    ]);
    expect(out.map(b => b.bucket)).toEqual(['app-failed', 'tls-rejected', 'direct-ip']);
    expect(failingUpstreams([group({ bucket: 'direct-ip', count: 26, code: 400 })])).toEqual([]);
  });

  test('a window with no failing group is empty, not an older srv', () => {
    expect(failureBucketState([])).toBe('empty');
    expect(failureBucketState(undefined)).toBe('unread');
    expect(failureBucketState([group({ bucket: 'app-failed' })])).toBe('bucketed');
    expect(failureBucketState([group({})])).toBe('legacy');
  });

  test('an empty list from a log nothing proved readable is unproven, never "no failing request"', () => {
    expect(failureBucketState([], true)).toBe('unproven');
    expect(failureBucketState(undefined, true)).toBe('unread');
    expect(failureBucketState([], false)).toBe('empty');
  });
});

describe('routingUnread', () => {
  test('a null app block is unknown with the reads named, never an older srv or 0', () => {
    const st = routingUnread('App traffic');
    expect(st.state).toBe('unavailable');
    expect(st.why).toMatch(/routing unread/);
    expect(st.why).not.toMatch(/srv predates/);
  });
});

describe('load balancer addresses', () => {
  const lb = (over: Partial<IngressLb> = {}): IngressLb => ({ services: ['istio-system/istio-ingressgateway'], hostnames: [], ips: [], dns: [], ...over });

  test('an IP-only load balancer lists its published addresses, not "none assigned"', () => {
    const rows = lbAddressRows(lb({ ips: ['20.1.2.3', '20.1.2.4'] }));
    expect(rows.map(r => [r.address, r.kind])).toEqual([
      ['20.1.2.3', 'ip'],
      ['20.1.2.4', 'ip']
    ]);
  });

  test('hostnames keep their DNS lookup and lead the published IPs', () => {
    const rows = lbAddressRows(lb({ hostnames: ['a1.elb.amazonaws.com'], ips: ['20.1.2.3'], dns: [{ hostname: 'a1.elb.amazonaws.com', ips: ['3.3.3.3'], resolvedAt: '2026-09-26T10:00:00Z', error: null }] }));
    expect(rows.map(r => [r.address, r.kind, r.ips])).toEqual([
      ['a1.elb.amazonaws.com', 'hostname', ['3.3.3.3']],
      ['20.1.2.3', 'ip', ['20.1.2.3']]
    ]);
  });

  test('an older srv without ips reads as hostnames only', () => {
    const old = { services: [], hostnames: ['h'], dns: [{ hostname: 'h', ips: [], resolvedAt: null, error: 'ENOTFOUND' }] } as unknown as IngressLb;
    expect(lbAddressRows(old).map(r => [r.address, r.error])).toEqual([['h', 'ENOTFOUND']]);
  });
});

describe('peers (D1)', () => {
  const peer = (over: Partial<IngressClient>): IngressClient => ({
    key: '10.0.0.1',
    ip: '10.0.0.1',
    kind: 'Pod',
    name: 'probe',
    namespace: 'platform-system',
    external: false,
    evidence: '',
    requests: 1,
    ok: 1,
    redirect: 0,
    client: 0,
    server: 0,
    noResponse: 0,
    errorShare: 0,
    connects: 0,
    hosts: 1,
    topHosts: [],
    codes: [],
    methods: [],
    bytesSent: null,
    bytesReceived: null,
    firstSeen: null,
    lastSeen: null,
    ...over
  });

  test('an external peer never has a printable address, even when the server sent one', () => {
    expect(peerAddress(peer({}))).toBe('10.0.0.1');
    expect(peerAddress(peer({ ip: '203.0.113.9', kind: 'external', external: true }))).toBeNull();
    expect(peerAddress({ ip: '203.0.113.9', kind: 'external' })).toBeNull();
  });

  test('older servers: external rows with an address are dropped and counted', () => {
    const { rows, externalHidden } = listablePeers([
      peer({}),
      peer({ key: '203.0.113.9', ip: '203.0.113.9', kind: 'external', external: true }),
      peer({ key: 'external', ip: null, kind: 'external', external: true, name: 'External clients', distinct: 40 })
    ]);
    expect(rows.map(r => r.key)).toEqual(['10.0.0.1', 'external']);
    expect(externalHidden).toBe(1);
  });
});

describe('gaps', () => {
  test('an absent block is unavailable with a reason, never ok', () => {
    expect(notFromServer('certificates').state).toBe('unavailable');
    expect(readFailed('certificates', undefined)?.why).toContain('not reported by this server');
    expect(readFailed('certificates', { unavailable: true, reason: 'FORBIDDEN' })?.why).toContain('FORBIDDEN');
    expect(readFailed('certificates', { unavailable: false, reason: null })).toBeNull();
  });
});

describe('attentionTarget with retired sections', () => {
  const row = (section: string): IngressAttention => ({ severity: 'warning', kind: 'cert-expiry', title: 't', detail: 'd', section });

  test('maps a server row naming a retired section onto the screen that holds it now', () => {
    // srv still sends `listeners` for cert-expiry, permissive-mtls and join-gap rows.
    expect(attentionTarget(row('listeners'), TRAFFIC_SECTION_IDS)).toBe('hosts');
    expect(attentionTarget(row('codes'), TRAFFIC_SECTION_IDS)).toBe('failures');
    expect(attentionTarget(row('path'), TRAFFIC_SECTION_IDS)).toBe('gateway');
  });

  test('keeps an unknown section as plain text', () => {
    expect(attentionTarget(row('nope'), TRAFFIC_SECTION_IDS)).toBeNull();
  });
});

describe('TCP connections by class: one definition for the Overview row and the Hosts note', () => {
  // platformsbx 2026-09-28: 164 TCP on Hosts beside 163 Rejected at TLS on Overview, and nothing said where the one went.
  const classes = {
    total: 358,
    rows: [
      { key: 'tls-rejected' as const, records: 163, requests: 0, codes: [] },
      { key: 'direct-ip' as const, records: 32, requests: 31, codes: [] },
      { key: 'probe' as const, records: 161, requests: 161, codes: [] },
      { key: 'app' as const, records: 2, requests: 2, codes: [] }
    ]
  };

  test('a connection is a record with no request line, split by class, and the split sums to the TCP total', () => {
    const out = connectionsByClass(classes)!;
    expect(out).toEqual([
      { key: 'direct-ip', connections: 1 },
      { key: 'tls-rejected', connections: 163 }
    ]);
    expect(out.reduce((n, r) => n + r.connections, 0)).toBe(164);
  });

  test('no classes from the server is unknown, never an empty split', () => {
    expect(connectionsByClass(undefined)).toBeNull();
  });

  test("a class row names both units whenever it holds both, so its number reads against the note's", () => {
    expect(classUnits(classes.rows[0]!)).toBe('163 TCP');
    expect(classUnits(classes.rows[1]!)).toBe('31 HTTP + 1 TCP');
    expect(classUnits(classes.rows[2]!)).toBe('161 HTTP');
  });
});
