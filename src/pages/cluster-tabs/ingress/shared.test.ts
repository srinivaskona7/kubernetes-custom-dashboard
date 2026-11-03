/**
 * The pure half of the ingress screens.
 *
 * These exist because "which rows does this chip keep" and "what does a 100% error share mean" are
 * questions that read as obvious and are not. A host answering 100% 403 is either a broken route or
 * an auth gate doing its job, and the verdict this module returns is what an operator will act on —
 * so it gets a test rather than a screenshot.
 *
 * No DOM: `vitest.config.ts` runs `environment: 'node'`, and everything here is a pure function.
 */
import { describe, expect, test } from 'vitest';
import type { IngressHost, IngressRate, TrafficIngress } from '../../../api';
import {
  GROUP_LABEL,
  GROUP_TONE,
  GROUP_WHY,
  byteLine,
  exactTimestamp,
  externalPeerSplit,
  hostFilterChips,
  hostTone,
  hostWhy,
  ingressGapWhy,
  ingressWasRead,
  matchesHostFilter,
  rateLine,
  share
} from './shared';

test('exactTimestamp preserves a precise UTC instant and handles missing values', () => {
  expect(exactTimestamp('2026-09-30T10:20:30+05:30')).toBe('2026-09-30T04:50:30.000Z');
  expect(exactTimestamp(null)).toBeUndefined();
  expect(exactTimestamp('not-a-time')).toBe('not-a-time');
});

const NO_LATENCY = { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };

function host(over: Partial<IngressHost> = {}): IngressHost {
  return {
    key: 'shop.example.com',
    host: 'shop.example.com',
    group: 'declared',
    matchedSuffix: null,
    gateway: null,
    servedBy: [],
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
    methods: ['GET'],
    paths: [],
    codes: [],
    flags: [],
    details: [],
    clients: 1,
    externalClients: 1,
    sni: 0,
    ports: [],
    bytesSent: 0,
    bytesReceived: 0,
    proxies: [],
    firstSeen: null,
    lastSeen: null,
    ...over
  };
}

describe('matchesHostFilter', () => {
  test('a group chip keeps only its own group', () => {
    const declared = host({ group: 'declared' });
    const infra = host({ key: 'healthz.example.com', host: 'healthz.example.com', group: 'infra' });
    expect(matchesHostFilter(declared, 'declared', '')).toBe(true);
    expect(matchesHostFilter(infra, 'declared', '')).toBe(false);
    // `all` is the absence of a filter, not a seventh group.
    expect(matchesHostFilter(infra, 'all', '')).toBe(true);
  });

  test('the no-Host-header row survives every filter that should keep it', () => {
    const none = host({ key: '(no host header)', host: null, group: 'none' });
    expect(matchesHostFilter(none, 'all', '')).toBe(true);
    expect(matchesHostFilter(none, 'none', '')).toBe(true);
    expect(matchesHostFilter(none, 'declared', '')).toBe(false);
    // Searchable by its printable key, because the host itself is null and cannot be typed.
    expect(matchesHostFilter(none, 'all', 'no host')).toBe(true);
  });

  test('search reaches the declaring object, not just the host', () => {
    const h = host({
      servedBy: [
        { kind: 'APIRule', name: 'shop-rule', namespace: 'shop', evidence: 'publishes it', matched: 'shop.example.com' }
      ],
      gateway: { name: 'kyma-gateway', namespace: 'kyma-system', host: '*.example.com', port: 443, evidence: 'server host' }
    });
    // An operator who knows the APIRule name and not the host is the whole reason for this.
    expect(matchesHostFilter(h, 'all', 'shop-rule')).toBe(true);
    expect(matchesHostFilter(h, 'all', 'kyma-gateway')).toBe(true);
    expect(matchesHostFilter(h, 'all', 'nothing-like-this')).toBe(false);
  });

  test('search is case-insensitive and ignores surrounding space', () => {
    expect(matchesHostFilter(host(), 'all', '  SHOP.Example  ')).toBe(true);
  });

  test('a group filter and a search both have to pass', () => {
    const infra = host({ key: 'healthz.example.com', host: 'healthz.example.com', group: 'infra' });
    expect(matchesHostFilter(infra, 'infra', 'healthz')).toBe(true);
    expect(matchesHostFilter(infra, 'declared', 'healthz')).toBe(false);
  });
});

describe('hostFilterChips', () => {
  test('a group with no rows gets no chip', () => {
    const chips = hostFilterChips([host({ group: 'declared' }), host({ key: 'b', group: 'declared' })]);
    expect(chips.map(c => c.id)).toEqual(['all', 'declared']);
    expect(chips[0]).toEqual({ id: 'all', label: 'All hosts', count: 2 });
    // Canary: a chip for an empty group lands the operator on an empty table and blames them for it.
    expect(chips.some(c => c.id === 'infra')).toBe(false);
  });

  test('chips are ordered by what an operator looks for first, not by count', () => {
    const rows = [
      host({ key: 'i1', group: 'infra' }),
      host({ key: 'i2', group: 'infra' }),
      host({ key: 'i3', group: 'infra' }),
      host({ key: 'c1', group: 'corporate' })
    ];
    // `infra` has 3 rows and `corporate` has 1, and corporate still comes first: cluster plumbing
    // is the most voluminous bucket on a live cluster and the least interesting.
    expect(hostFilterChips(rows).map(c => c.id)).toEqual(['all', 'corporate', 'infra']);
  });

  test('no rows means the all chip alone, reading zero', () => {
    expect(hostFilterChips([])).toEqual([{ id: 'all', label: 'All hosts', count: 0 }]);
  });
});

describe('share', () => {
  test('null is an em-dash and zero is a zero', () => {
    // The distinction the whole console rests on: no measurement is not a measurement of none.
    expect(share(null)).toBe('—');
    expect(share(undefined)).toBe('—');
    expect(share(0)).toBe('0%');
  });

  test('a share under one percent keeps a decimal instead of rounding to clean', () => {
    expect(share(0.004)).toBe('0.4%');
    // Canary: `Math.round(0.4)` is 0, and "0%" on a host with a real failure reads as healthy.
    expect(share(0.004)).not.toBe('0%');
  });

  test('ordinary shares round to whole percent', () => {
    expect(share(0.5)).toBe('50%');
    expect(share(1)).toBe('100%');
    expect(share(0.495)).toBe('50%');
  });

  test('a non-finite share is a gap, not NaN%', () => {
    expect(share(Number.NaN)).toBe('—');
    expect(share(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('hostTone', () => {
  test('a 5xx is bad at any share', () => {
    expect(hostTone(host({ requests: 1000, ok: 999, server: 1 }))).toBe('bad');
    expect(hostWhy(host({ requests: 1000, ok: 999, server: 1 }))).toMatch(/workload/);
  });

  test('a host answering entirely 403 is a warning, not a fault', () => {
    // An auth gate turning away every unauthenticated caller looks exactly like this, which is why
    // it is not `bad`. Banding this like utilisation would paint a working edge red.
    const gate = host({ requests: 424, ok: 0, client: 424, errorShare: 1 });
    expect(hostTone(gate)).toBe('warn');
    expect(hostWhy(gate)).toMatch(/not automatically a fault/);
  });

  test('a clean host is ok and says how many records back that', () => {
    const clean = host({ requests: 593, ok: 593, errorShare: 0 });
    expect(hostTone(clean)).toBe('ok');
    expect(hostWhy(clean)).toMatch(/593/);
  });

  test('a handful of client errors is neither clean nor a warning', () => {
    // 2 of 100 is real and worth a dot that is not green — and is not the majority, so not a warning.
    expect(hostTone(host({ requests: 100, ok: 98, client: 2 }))).toBe('unknown');
  });

  test('no records is unknown, never ok', () => {
    const empty = host({ requests: 0, ok: 0, errorShare: null });
    expect(hostTone(empty)).toBe('unknown');
    expect(hostWhy(empty)).toMatch(/No record/);
  });

  test('response_code 0 is reported as no response, not as an HTTP error', () => {
    const dropped = host({ requests: 318, ok: 0, noResponse: 318, errorShare: 1 });
    expect(hostWhy(dropped)).toMatch(/no HTTP response at all/);
    expect(hostWhy(dropped)).toMatch(/Not an HTTP error/);
  });
});

describe('rateLine', () => {
  const base: IngressRate = {
    perSecond: 0.06,
    contributors: [],
    shortestSpanSeconds: 400,
    suppressed: false,
    why: 'each proxy over its own span'
  };

  test('a measured rate prints with its units and its caveat', () => {
    expect(rateLine(base)).toEqual({ value: '0.06/s', why: 'each proxy over its own span' });
  });

  test('a suppressed rate prints the reason where the number would be', () => {
    const out = rateLine({ ...base, perSecond: null, suppressed: true, why: 'window too short' });
    expect(out.value).toBe('—');
    expect(out.why).toBe('window too short');
    // Canary: an em-dash with no sentence reads as a broken feature; a 0.0/s reads as an idle
    // cluster. Both are worse than the reason.
    expect(out.why).not.toBe('');
  });

  test('a missing rate still has something honest to say', () => {
    expect(rateLine(undefined).value).toBe('—');
    expect(rateLine(undefined).why.length).toBeGreaterThan(0);
  });
});

function ingress(over: Partial<TrafficIngress> = {}): TrafficIngress {
  return {
    scope: 'ingress',
    summary: {
      ingressProxies: 3,
      records: 1485,
      requests: 1175,
      connections: 310,
      ok: 593,
      redirect: 0,
      client: 582,
      server: 0,
      noResponse: 0,
      errors: 582,
      errorShare: 0.49,
      hosts: 13,
      hostsIncludingUnnamed: 14,
      // 310 records with no Host header against a bucket difference of 1 — the live shape that made
      // the subtraction a bug, kept here so a fixture reader sees why the field exists.
      unnamedRequests: 310,
      clients: 158,
      externalClients: 158,
      clientsConnecting: 4,
      clientsFullyRejected: 8,
      bytesSent: 10868,
      bytesReceived: 0,
      total: NO_LATENCY,
      upstream: NO_LATENCY,
      overheadMs: null,
      ports: [],
      byCode: [],
      rate: { perSecond: null, contributors: [], shortestSpanSeconds: null, suppressed: true, why: 'x' },
      corporateSuffixes: []
    },
    groups: [],
    hosts: [],
    hostsTotal: 0,
    hostsTruncated: false,
    clients: [],
    clientsTotal: 0,
    clientsTruncated: false,
    flags: [],
    listeners: [],
    rejections: [],
    rejectionsTotal: 0,
    rejectionsTruncated: false,
    gateways: [],
    tier: null,
    ingressProxiesSelected: 3,
    ingressProxiesUnread: [],
    routesFrom: { virtualservices: 9, apirules: 4 },
    ...over
  };
}

describe('ingressWasRead', () => {
  test('scope none is never treated as a read, however the counts look', () => {
    // The counts under `scope: 'none'` are 0 because nothing was measured. Trusting them would
    // print a confident "0 errors at the edge" for a cluster whose gateway refused every log.
    expect(ingressWasRead(ingress({ scope: 'none' }))).toBe(false);
    expect(ingressWasRead(ingress())).toBe(true);
    expect(ingressWasRead(undefined)).toBe(false);
  });

  test('scope ingress with no contributing proxy is not a read either', () => {
    expect(ingressWasRead(ingress({ summary: { ...ingress().summary, ingressProxies: 0 } }))).toBe(false);
  });
});

describe('ingressGapWhy', () => {
  test('a refused log names the pods and blames the reader, not the edge', () => {
    const why = ingressGapWhy(ingress({ scope: 'none', ingressProxiesUnread: ['istio-system/gw-2'] }));
    expect(why).toContain('istio-system/gw-2');
    expect(why).toMatch(/this reader's access/);
  });

  test('no gateway pod at all says so, rather than blaming access', () => {
    const why = ingressGapWhy(ingress({ scope: 'none', ingressProxiesSelected: 0, ingressProxiesUnread: [] }));
    expect(why).toMatch(/No pod in this cluster is an Istio ingress gateway/);
  });

  test('a gateway that was read and logged nothing is a third, different sentence', () => {
    const why = ingressGapWhy(ingress({ scope: 'none', ingressProxiesSelected: 2, ingressProxiesUnread: [] }));
    expect(why).toMatch(/returned no request line/);
    expect(why).toMatch(/not read/);
  });

  test('the three causes never share a sentence', () => {
    const refused = ingressGapWhy(ingress({ scope: 'none', ingressProxiesUnread: ['a/b'] }));
    const missing = ingressGapWhy(ingress({ scope: 'none', ingressProxiesSelected: 0 }));
    const quiet = ingressGapWhy(ingress({ scope: 'none', ingressProxiesSelected: 2 }));
    expect(new Set([refused, missing, quiet]).size).toBe(3);
  });
});

describe('byteLine', () => {
  test('an unrecorded total is named as such, and a real zero stays a zero', () => {
    expect(byteLine(null).text).toBe('not recorded');
    expect(byteLine(null).title).toMatch(/Not zero bytes/);
    // `bytes_received` is genuinely 0 on every line of a live ingress window — probes carry no body.
    expect(byteLine(0).text).toBe('0');
  });

  test('a large total is grouped for reading', () => {
    expect(byteLine(1234567).text).toBe((1234567).toLocaleString());
  });
});

describe('the group vocabulary', () => {
  test('every group has a label, a tone and a sentence', () => {
    const groups = ['corporate', 'declared', 'infra', 'address', 'other', 'none'] as const;
    for (const g of groups) {
      expect(GROUP_LABEL[g].length).toBeGreaterThan(0);
      expect(GROUP_WHY[g].length).toBeGreaterThan(20);
      expect(GROUP_TONE[g]).toBeTruthy();
    }
  });

  test('no group label or explanation names a specific company or cluster domain', () => {
    // The suffixes come from FLEET_CORPORATE_DOMAIN_SUFFIXES and the Kyma domain is per shoot. A
    // literal here would ship green and be wrong on the next cluster onboarded.
    const prose = [...Object.values(GROUP_LABEL), ...Object.values(GROUP_WHY)].join(' ');
    expect(prose).not.toMatch(/apple\.com/i);
    expect(prose).not.toMatch(/c-[0-9a-f]{7}/i);
  });
});

describe('externalPeerSplit', () => {
  // platformsbx 2026-09-28: External 45 beside 3 allowed and 11 refused only; the 31 TLS-only peers had no tile.
  const peers = { distinct: 45, internal: 0, external: 45, externalAllowed: 3, externalBlockedOnly: 11, externalTlsOnly: 31 };

  test('the parts under External add up to External', () => {
    const out = externalPeerSplit(peers);
    expect(out.map(r => [r.key, r.value])).toEqual([
      ['allowed', 3],
      ['refused', 11],
      ['tls', 31]
    ]);
    expect(out.reduce((n, r) => n + (r.value ?? 0), 0)).toBe(peers.external);
  });

  test('peers in none of the three are counted as a remainder, never dropped', () => {
    const out = externalPeerSplit({ ...peers, external: 50 });
    expect(out.at(-1)).toMatchObject({ key: 'other', value: 5 });
  });

  test('an older srv without the TLS-only count shows it unknown, and no remainder is guessed', () => {
    const { externalTlsOnly: _, ...old } = peers;
    const out = externalPeerSplit(old);
    expect(out.find(r => r.key === 'tls')?.value).toBeNull();
    expect(out.some(r => r.key === 'other')).toBe(false);
  });
});
