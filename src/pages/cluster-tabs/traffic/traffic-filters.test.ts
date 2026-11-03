/**
 * The Traffic Errors filter rules, proved rather than eyeballed.
 *
 * Each test names the rule it holds, because the rules are the part a later refactor breaks
 * invisibly: a dropped search field, a status class quietly re-derived from a code, a `no-response`
 * group folded into 5xx, a badge that counts a filter Clear does not clear. None of those changes
 * how the page *looks*, which is why a screenshot cannot catch them and this file has to.
 *
 * No DOM: `vitest.config.ts` runs `environment: 'node'` and everything under test is pure.
 */
import { describe, expect, test } from 'vitest';
import type { TrafficErrorGroup, TrafficWindow } from '../../../api';
import {
  DEFAULT_TRAFFIC_FILTERS,
  TIME_RANGES,
  activeTrafficFilters,
  coverageNote,
  filterGroups,
  methodOptions,
  sinceSecondsFor,
  type StatusFilter,
  type TrafficFilterState
} from './traffic-filters';

/** A group with every field present, so a test only has to state the field it is about. */
function group(over: Partial<TrafficErrorGroup> = {}): TrafficErrorGroup {
  return {
    key: '403 GET shop.example.com /api -',
    code: 403,
    class: 'client',
    method: 'GET',
    path: '/api',
    authority: 'shop.example.com',
    protocol: 'HTTP/1.1',
    count: 7,
    firstSeen: '2026-09-19T21:04:00.000Z',
    lastSeen: '2026-09-20T10:16:00.000Z',
    responseFlags: [],
    responseCodeDetails: [],
    transportFailures: [],
    p50Ms: 3,
    maxMs: 9,
    upstream: null,
    gateway: null,
    destination: null,
    sources: [],
    proxies: [{ pod: 'istio-ingressgateway-abc', namespace: 'istio-system', container: 'istio-proxy', count: 7 }],
    samples: [],
    ...over
  };
}

function win(over: Partial<TrafficWindow> = {}): TrafficWindow {
  return {
    proxiesRead: 10,
    proxiesFailed: [],
    proxyCandidates: 41,
    proxiesSkipped: 31,
    tailLines: 500,
    namespace: null,
    sinceSeconds: 86400,
    linesRead: 2974,
    requestsParsed: 2974,
    linesUnparsed: 0,
    truncatedProxies: 5,
    oldest: '2026-09-19T21:04:00.000Z',
    newest: '2026-09-20T10:16:00.000Z',
    readsSkipped: false,
    ...over
  };
}

function state(over: Partial<TrafficFilterState> = {}): TrafficFilterState {
  return { ...DEFAULT_TRAFFIC_FILTERS, ...over };
}

describe('the default state', () => {
  test('defaults to Last 24 hours, per requirement 3', () => {
    expect(DEFAULT_TRAFFIC_FILTERS.range).toBe('24h');
  });

  test('leaves every other control open, so the first paint is unfiltered', () => {
    expect(DEFAULT_TRAFFIC_FILTERS.status).toBe('all');
    expect(DEFAULT_TRAFFIC_FILTERS.method).toBe('all');
    expect(DEFAULT_TRAFFIC_FILTERS.search).toBe('');
    expect(DEFAULT_TRAFFIC_FILTERS.namespaces.size).toBe(0);
  });

  test('an empty namespace set means all, so the default state hides nothing', () => {
    const rows = [group({ proxies: [{ pod: 'p', namespace: 'applecare', container: 'istio-proxy', count: 1 }] })];
    expect(filterGroups(rows, DEFAULT_TRAFFIC_FILTERS)).toHaveLength(1);
  });
});

describe('TIME_RANGES', () => {
  test('offers exactly the five windows the route can read', () => {
    expect(TIME_RANGES.map(r => r.id)).toEqual(['15m', '1h', '6h', '24h', '7d']);
  });

  test('carries the request’s own labels, so the chip reads as specified', () => {
    expect(TIME_RANGES.map(r => r.label)).toEqual([
      'Last 15 minutes',
      'Last 1 hour',
      'Last 6 hours',
      'Last 24 hours',
      'Last 7 days'
    ]);
  });

  test('omits Custom deliberately — sinceSeconds is a duration, not a window with an end', () => {
    // A Custom option that rounded to the nearest fixed range would answer a different question than
    // the operator asked with nothing on screen admitting it. Restoring it starts at the route.
    expect(TIME_RANGES.some(r => String(r.id) === 'custom')).toBe(false);
  });
});

describe('sinceSecondsFor', () => {
  test('maps each of the five ranges to the seconds the route receives', () => {
    expect(sinceSecondsFor(state({ range: '15m' }))).toBe(900);
    expect(sinceSecondsFor(state({ range: '1h' }))).toBe(3600);
    expect(sinceSecondsFor(state({ range: '6h' }))).toBe(21600);
    expect(sinceSecondsFor(state({ range: '24h' }))).toBe(86400);
    expect(sinceSecondsFor(state({ range: '7d' }))).toBe(604800);
  });

  test('falls back to the default window rather than sending NaN for a range from a bad URL', () => {
    // `?sinceSeconds=NaN` failed every proxy read and reported a cluster-wide read failure for a
    // query string typo. The fallback keeps that impossible from this side.
    const bad = { ...DEFAULT_TRAFFIC_FILTERS, range: 'lastweek' as unknown as TrafficFilterState['range'] };
    expect(sinceSecondsFor(bad)).toBe(86400);
  });
});

describe('methodOptions', () => {
  test('offers only the verbs observed in the window, with all first', () => {
    const rows = [group({ method: 'POST' }), group({ method: 'GET' }), group({ method: 'HEAD' }), group({ method: 'GET' })];
    expect(methodOptions(rows)).toEqual(['all', 'GET', 'HEAD', 'POST']);
  });

  test('canary: a hardcoded seven-verb list would fail this — PATCH is never offered unobserved', () => {
    // The request lists GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS. Offering PATCH when no PATCH request
    // was observed invites the operator to select it, see an empty table and conclude there are no
    // PATCH failures, when the truth is that none was observed at all.
    const rows = [group({ method: 'GET' })];
    const offered = methodOptions(rows);
    expect(offered).toEqual(['all', 'GET']);
    for (const verb of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) expect(offered).not.toContain(verb);
  });

  test('offers no option for a null method — a chip reading an em-dash cannot be understood', () => {
    expect(methodOptions([group({ method: null }), group({ method: 'GET' })])).toEqual(['all', 'GET']);
  });

  test('sorts alphabetically, not by volume, so the dropdown does not reorder between reads', () => {
    const rows = [group({ method: 'POST', count: 900 }), group({ method: 'GET', count: 1 })];
    expect(methodOptions(rows)).toEqual(['all', 'GET', 'POST']);
  });

  test('returns just all for no groups, rather than throwing', () => {
    expect(methodOptions([])).toEqual(['all']);
  });
});

describe('the STATUS filter is the backend’s class', () => {
  const client = group({ code: 403, class: 'client' });
  const server = group({ code: 503, class: 'server' });
  const none = group({ code: 0, class: 'no-response' });
  const rows = [client, server, none];

  test('all keeps every class', () => {
    expect(filterGroups(rows, state({ status: 'all' }))).toEqual(rows);
  });

  test('4xx means class client, and nothing else', () => {
    expect(filterGroups(rows, state({ status: 'client' }))).toEqual([client]);
  });

  test('5xx means class server, and nothing else', () => {
    expect(filterGroups(rows, state({ status: 'server' }))).toEqual([server]);
  });

  test('No HTTP response is selectable as its own category', () => {
    expect(filterGroups(rows, state({ status: 'no-response' }))).toEqual([none]);
  });

  test('a no-response group is in neither 4xx nor 5xx — code 0 is not a server error', () => {
    expect(filterGroups([none], state({ status: 'client' }))).toEqual([]);
    expect(filterGroups([none], state({ status: 'server' }))).toEqual([]);
  });

  test('the class decides, never the number — a code the UI never banded still filters correctly', () => {
    // If this module re-derived a class from `code`, a 302 carrying class `client` would land in the
    // wrong bucket, and the two answers would disagree the first time a 3xx appeared.
    const oddity = group({ code: 302, class: 'client' });
    expect(filterGroups([oddity], state({ status: 'client' }))).toEqual([oddity]);
  });
});

describe('the METHOD filter', () => {
  const get = group({ method: 'GET' });
  const post = group({ method: 'POST' });
  const unknown = group({ method: null });

  test('all keeps a group whose method is null — 3 of 430 have none', () => {
    expect(filterGroups([get, post, unknown], state({ method: 'all' }))).toHaveLength(3);
  });

  test('a specific verb excludes a group whose method is null', () => {
    expect(filterGroups([get, unknown], state({ method: 'GET' }))).toEqual([get]);
  });

  test('keeps only the chosen verb', () => {
    expect(filterGroups([get, post], state({ method: 'POST' }))).toEqual([post]);
  });

  test('matches case-insensitively, so a hand-edited URL still filters', () => {
    expect(filterGroups([get, post], state({ method: 'get' }))).toEqual([get]);
  });

  test('an empty method is open, not a filter for groups with no method', () => {
    expect(filterGroups([get, unknown], state({ method: '' }))).toHaveLength(2);
  });
});

describe('the proxy-namespace filter', () => {
  const istio = group({
    key: 'a',
    proxies: [{ pod: 'istio-ingressgateway-abc', namespace: 'istio-system', container: 'istio-proxy', count: 4 }]
  });
  const care = group({
    key: 'b',
    proxies: [{ pod: 'srv-1', namespace: 'applecare', container: 'istio-proxy', count: 2 }]
  });

  test('an empty selection admits everything', () => {
    expect(filterGroups([istio, care], state({ namespaces: new Set() }))).toHaveLength(2);
  });

  test('a selection keeps only groups a selected proxy logged', () => {
    expect(filterGroups([istio, care], state({ namespaces: new Set(['applecare']) }))).toEqual([care]);
  });

  test('several namespaces are OR, not AND', () => {
    const sel = new Set(['applecare', 'istio-system']);
    expect(filterGroups([istio, care], state({ namespaces: sel }))).toHaveLength(2);
  });

  test('a group logged by proxies in two namespaces survives a selection of either', () => {
    // `groupKey` in the collector is code+method+authority+path+upstream with no proxy in it, so one
    // group really does aggregate records from proxies in different namespaces. Membership has to be
    // group-level OR; comparing a single value would drop this group from both selections.
    const spread = group({
      proxies: [
        { pod: 'istio-ingressgateway-abc', namespace: 'istio-system', container: 'istio-proxy', count: 4 },
        { pod: 'srv-1', namespace: 'applecare', container: 'istio-proxy', count: 1 }
      ]
    });
    expect(filterGroups([spread], state({ namespaces: new Set(['applecare']) }))).toHaveLength(1);
    expect(filterGroups([spread], state({ namespaces: new Set(['istio-system']) }))).toHaveLength(1);
    expect(filterGroups([spread], state({ namespaces: new Set(['kyma-system']) }))).toHaveLength(0);
  });

  test('a group carrying no proxy at all still shows under an empty selection', () => {
    // `[].some()` is false, so the open state has to be answered before the membership test runs.
    expect(filterGroups([group({ proxies: [] })], state({ namespaces: new Set() }))).toHaveLength(1);
  });
});

describe('SEARCH reaches every field it claims, one assertion each', () => {
  const keeps = (over: Partial<TrafficErrorGroup>, needle: string) =>
    filterGroups([group(over)], state({ search: needle })).length;

  test('path', () => {
    expect(keeps({ path: '/v1/orders' }, 'orders')).toBe(1);
  });

  test('host, which is the authority field', () => {
    expect(keeps({ authority: 'shop.kyma.example' }, 'kyma.example')).toBe(1);
  });

  test('code, because the breakdown panels hand back a number and STATUS cannot express one', () => {
    expect(keeps({ code: 503 }, '503')).toBe(1);
  });

  test('upstream, as Envoy wrote it', () => {
    expect(
      keeps(
        {
          upstream: {
            raw: 'outbound|8080||srv.applecare.svc.cluster.local',
            direction: 'outbound',
            port: 8080,
            subset: null,
            fqdn: 'srv.applecare.svc.cluster.local',
            service: null
          }
        },
        'srv.applecare'
      )
    ).toBe(1);
  });

  test('the Service the upstream resolved to', () => {
    expect(
      keeps(
        {
          upstream: {
            raw: 'outbound|8080||10.0.0.1',
            direction: 'outbound',
            port: 8080,
            subset: null,
            fqdn: null,
            service: { kind: 'Service', name: 'checkout', namespace: 'applecare', evidence: 'FQDN match' }
          }
        },
        'checkout'
      )
    ).toBe(1);
  });

  test('gateway name — populated on 381 of 430 groups where upstream is populated on 1', () => {
    expect(
      keeps(
        { gateway: { name: 'kyma-gateway', namespace: 'kyma-system', host: '*.kyma.example', port: 443, evidence: 'server host' } },
        'kyma-gateway'
      )
    ).toBe(1);
  });

  test('gateway host', () => {
    expect(
      keeps(
        { gateway: { name: 'kyma-gateway', namespace: 'kyma-system', host: 'api.kyma.example', port: 443, evidence: 'server host' } },
        'api.kyma'
      )
    ).toBe(1);
  });

  test('gateway namespace', () => {
    expect(
      keeps(
        { gateway: { name: 'g', namespace: 'kyma-system', host: 'h', port: 443, evidence: 'server host' } },
        'kyma-system'
      )
    ).toBe(1);
  });

  test('destination name', () => {
    expect(
      keeps(
        { destination: { ip: '10.1.2.3', port: 8080, kind: 'Service', name: 'payments', namespace: 'applecare', evidence: 'EndpointSlice' } },
        'payments'
      )
    ).toBe(1);
  });

  test('destination ip', () => {
    expect(
      keeps(
        { destination: { ip: '10.1.2.3', port: 8080, kind: 'Service', name: 'payments', namespace: 'applecare', evidence: 'EndpointSlice' } },
        '10.1.2'
      )
    ).toBe(1);
  });

  test('destination namespace', () => {
    expect(
      keeps(
        { destination: { ip: '10.1.2.3', port: 8080, kind: 'Service', name: 'p', namespace: 'applecare', evidence: 'EndpointSlice' } },
        'applecare'
      )
    ).toBe(1);
  });

  test('response code details — the richest explanatory field on the page', () => {
    expect(keeps({ responseCodeDetails: ['rbac_access_denied_matched_policy[ns[x]-policy]'] }, 'rbac_access_denied')).toBe(1);
  });

  test('response flags, which an operator types verbatim from Envoy’s documentation', () => {
    expect(keeps({ responseFlags: ['NR', 'DC'] }, 'nr')).toBe(1);
  });

  test('transport failures', () => {
    expect(keeps({ transportFailures: ['TLS_error:certificate_expired'] }, 'certificate_expired')).toBe(1);
  });

  test('proxy pod', () => {
    expect(
      keeps({ proxies: [{ pod: 'istio-ingressgateway-7f9', namespace: 'istio-system', container: 'istio-proxy', count: 1 }] }, 'ingressgateway-7f9')
    ).toBe(1);
  });

  test('proxy namespace — the namespace of whatever logged the record', () => {
    expect(
      keeps({ proxies: [{ pod: 'p', namespace: 'istio-system', container: 'istio-proxy', count: 1 }] }, 'istio-system')
    ).toBe(1);
  });

  test('source name', () => {
    expect(
      keeps({ sources: [{ ip: '1.2.3.4', port: 55000, kind: 'pod', name: 'scanner-1', namespace: 'kyma-system', evidence: 'Pod IP' }] }, 'scanner-1')
    ).toBe(1);
  });

  test('source ip', () => {
    expect(
      keeps({ sources: [{ ip: '203.0.113.9', port: 55000, kind: 'external', name: '203.0.113.9', namespace: null, evidence: 'nothing claims it' }] }, '203.0.113')
    ).toBe(1);
  });

  test('source namespace — the *client’s* namespace, non-null on 1 of 430 groups', () => {
    expect(
      keeps({ sources: [{ ip: '1.2.3.4', port: 1, kind: 'pod', name: 'p', namespace: 'kyma-system', evidence: 'Pod IP' }] }, 'kyma-system')
    ).toBe(1);
  });

  test('a request id, because an operator often arrives holding only an x-request-id', () => {
    expect(keeps({ samples: ['b3f1c2d4-0000-4aaa-8bbb-000000000001'] }, 'b3f1c2d4')).toBe(1);
  });

  test('matches case-insensitively, anywhere in the value', () => {
    expect(keeps({ path: '/V1/Orders' }, 'orders')).toBe(1);
    expect(keeps({ authority: 'SHOP.example' }, 'shop')).toBe(1);
  });

  test('an empty or whitespace needle is not a filter', () => {
    expect(keeps({ path: '/a' }, '')).toBe(1);
    expect(keeps({ path: '/a' }, '   ')).toBe(1);
  });

  test('a needle that matches nothing returns nothing, rather than everything', () => {
    expect(keeps({ path: '/a' }, 'zzz')).toBe(0);
  });
});

describe('SEARCH does not claim to reach fields it cannot', () => {
  test('there is no route field on the wire, so no needle finds one', () => {
    // 0 of 430 groups carry `route` — the field is absent, not null. The expanded row omits it
    // rather than rendering "Route —", which would claim the field exists and is empty.
    const withRoute = { ...group(), route: 'orders-route' } as TrafficErrorGroup;
    expect(filterGroups([withRoute], state({ search: 'orders-route' }))).toEqual([]);
  });

  test('method has its own control, so a verb in the needle does not hijack a path search', () => {
    expect(filterGroups([group({ method: 'GET', path: '/x' })], state({ search: 'GET' }))).toEqual([]);
  });

  test('class has its own control — searching "server" does not sweep in every 5xx', () => {
    expect(filterGroups([group({ class: 'server', path: '/x' })], state({ search: 'server' }))).toEqual([]);
  });
});

describe('the filters work together (requirement 3’s own example)', () => {
  const careServer = group({
    key: 'care-5xx',
    code: 503,
    class: 'server',
    method: 'GET',
    path: '/checkout',
    proxies: [{ pod: 'srv-1', namespace: 'applecare', container: 'istio-proxy', count: 3 }]
  });
  const careClient = group({
    key: 'care-4xx',
    code: 403,
    class: 'client',
    method: 'GET',
    path: '/checkout',
    proxies: [{ pod: 'srv-1', namespace: 'applecare', container: 'istio-proxy', count: 9 }]
  });
  const istioServer = group({
    key: 'istio-5xx',
    code: 502,
    class: 'server',
    method: 'POST',
    path: '/checkout',
    proxies: [{ pod: 'istio-ingressgateway-abc', namespace: 'istio-system', container: 'istio-proxy', count: 2 }]
  });
  const rows = [careServer, careClient, istioServer];

  test('Namespace = applecare, Status = 5xx, Time = Last 6 hours shows only matching data', () => {
    const picked = state({ namespaces: new Set(['applecare']), status: 'server', range: '6h' });
    expect(filterGroups(rows, picked)).toEqual([careServer]);
    // The range is not a row predicate: it is sent to the route, which re-reads the proxies.
    expect(sinceSecondsFor(picked)).toBe(21600);
  });

  test('adding a search narrows further without losing the other three', () => {
    const picked = state({ namespaces: new Set(['applecare']), status: 'server', search: 'checkout' });
    expect(filterGroups(rows, picked)).toEqual([careServer]);
    expect(filterGroups(rows, state({ ...picked, search: 'nowhere' }))).toEqual([]);
  });

  test('every control applied at once still returns the one row that satisfies all of them', () => {
    const picked = state({
      namespaces: new Set(['applecare']),
      status: 'server',
      method: 'GET',
      search: '503',
      range: '1h'
    });
    expect(filterGroups(rows, picked)).toEqual([careServer]);
  });

  test('the order the filters are applied in never changes the result', () => {
    // AND commutes, and a test pins it because "the filters work together" is exactly the claim a
    // reordering refactor — done for cost, as the predicate order here was — breaks silently.
    const both = state({ namespaces: new Set(['applecare']), status: 'server', method: 'GET', search: 'checkout' });
    const nsFirst = filterGroups(
      filterGroups(rows, state({ namespaces: new Set(['applecare']) })),
      state({ status: 'server', method: 'GET', search: 'checkout' })
    );
    const searchFirst = filterGroups(
      filterGroups(rows, state({ search: 'checkout' })),
      state({ namespaces: new Set(['applecare']), status: 'server', method: 'GET' })
    );
    expect(nsFirst).toEqual(filterGroups(rows, both));
    expect(searchFirst).toEqual(filterGroups(rows, both));
  });

  test('two filters that cannot both hold return nothing, not the union', () => {
    expect(filterGroups(rows, state({ status: 'server', method: 'HEAD' }))).toEqual([]);
  });

  test('does not mutate or reorder the groups it was given', () => {
    const before = [...rows];
    filterGroups(rows, state({ status: 'server' }));
    expect(rows).toEqual(before);
    expect(filterGroups(rows, DEFAULT_TRAFFIC_FILTERS)).toEqual(rows);
  });
});

describe('activeTrafficFilters counts what Clear filters would clear', () => {
  test('the default state is the cleared state, so it counts 0', () => {
    expect(activeTrafficFilters(DEFAULT_TRAFFIC_FILTERS)).toBe(0);
  });

  test('counts each control once, including the range', () => {
    expect(activeTrafficFilters(state({ status: 'server' }))).toBe(1);
    expect(activeTrafficFilters(state({ method: 'GET' }))).toBe(1);
    expect(activeTrafficFilters(state({ search: 'checkout' }))).toBe(1);
    expect(activeTrafficFilters(state({ namespaces: new Set(['applecare']) }))).toBe(1);
    expect(activeTrafficFilters(state({ range: '15m' }))).toBe(1);
  });

  test('a multi-select counts once, not once per namespace', () => {
    const sel = new Set(['applecare', 'istio-system', 'kyma-system']);
    expect(activeTrafficFilters(state({ namespaces: sel }))).toBe(1);
  });

  test('counts every control when all five are set', () => {
    expect(
      activeTrafficFilters(
        state({ namespaces: new Set(['applecare']), range: '7d', status: 'client', method: 'GET', search: 'x' })
      )
    ).toBe(5);
  });

  test('a whitespace-only search counts 0, and filters nothing — the two must agree', () => {
    const only = state({ search: '   ' });
    expect(activeTrafficFilters(only)).toBe(0);
    expect(filterGroups([group()], only)).toHaveLength(1);
  });

  test('an empty method counts 0, and filters nothing', () => {
    const only = state({ method: '' });
    expect(activeTrafficFilters(only)).toBe(0);
    expect(filterGroups([group({ method: null })], only)).toHaveLength(1);
  });

  test('the default range counts 0 even when spelled through the state helper', () => {
    expect(activeTrafficFilters(state({ range: '24h' }))).toBe(0);
  });
});

describe('coverageNote', () => {
  test('the live case: 24h requested, about 13h covered — names the real span', () => {
    const note = coverageNote(win(), state({ range: '24h' }));
    expect(note).toContain('Last 24 hours');
    expect(note).toContain('13h 12m');
  });

  test('says which proxies truncated, because that is what an operator can act on', () => {
    const note = coverageNote(win({ truncatedProxies: 5, proxiesRead: 10, tailLines: 500 }), state({ range: '24h' }));
    expect(note).toContain('5 of the 10 proxies read');
    expect(note).toContain('500-line tail');
    expect(note).toContain('were not read');
  });

  test('says the opposite when nothing truncated — a wider range will not reach further back', () => {
    const note = coverageNote(win({ truncatedProxies: 0 }), state({ range: '24h' }));
    expect(note).toContain('No proxy reached its 500-line cap');
    expect(note).toContain('will not reach further back');
  });

  test('is null when the window genuinely covers the requested range', () => {
    // A 1h selection whose records span the full hour. Nothing to warn about, and a note that fired
    // here would be a note nobody reads by the time it matters.
    const covered = win({ oldest: '2026-09-20T09:00:00.000Z', newest: '2026-09-20T10:00:00.000Z' });
    expect(coverageNote(covered, state({ range: '1h' }))).toBeNull();
  });

  test('stays silent for a quiet edge, because oldest is the first record and not the range start', () => {
    // 55 minutes of an hour: a window with no traffic in its first five minutes is normal, and
    // warning about it would train the operator to ignore the warning that matters.
    const quiet = win({ oldest: '2026-09-20T09:05:00.000Z', newest: '2026-09-20T10:00:00.000Z' });
    expect(coverageNote(quiet, state({ range: '1h' }))).toBeNull();
  });

  test('fires once a fifth of the range is missing', () => {
    const short = win({ oldest: '2026-09-20T09:30:00.000Z', newest: '2026-09-20T10:00:00.000Z' });
    expect(coverageNote(short, state({ range: '1h' }))).toContain('30m');
  });

  test('a 7 day selection that read a day says so, in days', () => {
    const short = win({ oldest: '2026-09-19T10:00:00.000Z', newest: '2026-09-20T13:00:00.000Z' });
    expect(coverageNote(short, state({ range: '7d' }))).toContain('1d 3h');
  });

  test('a span under a minute reads in seconds rather than as 0m', () => {
    const tiny = win({ oldest: '2026-09-20T10:00:00.000Z', newest: '2026-09-20T10:00:42.000Z' });
    expect(coverageNote(tiny, state({ range: '15m' }))).toContain('42s');
  });

  test('is null with no window — nothing was read is the page’s statement, not a footnote', () => {
    expect(coverageNote(undefined, state({ range: '24h' }))).toBeNull();
  });

  test('is null when no record carried a timestamp, rather than claiming a zero-length window', () => {
    expect(coverageNote(win({ oldest: null, newest: null }), state({ range: '24h' }))).toBeNull();
    expect(coverageNote(win({ oldest: 'not-a-date', newest: 'also-not' }), state({ range: '24h' }))).toBeNull();
  });

  test('narrowing the range to what was covered clears the note — the control has an answer', () => {
    // 13h covered: "Last 6 hours" is fully inside it, so the note has nothing left to say.
    expect(coverageNote(win(), state({ range: '6h' }))).toBeNull();
  });
});

describe('the status values are the classes the payload uses', () => {
  test('every StatusFilter other than all is a class a group can carry', () => {
    // Typed rather than asserted at runtime: if the backend ever renames a class, this stops
    // compiling instead of silently filtering to nothing.
    const classes: TrafficErrorGroup['class'][] = ['client', 'server', 'no-response'];
    const filters: StatusFilter[] = ['all', ...classes];
    expect(filters).toHaveLength(4);
    for (const c of classes) {
      expect(filterGroups([group({ class: c })], state({ status: c }))).toHaveLength(1);
    }
  });
});
