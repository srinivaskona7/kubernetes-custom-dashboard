/**
 * The decisions behind the metric cards and the error breakdown, proved rather than eyeballed.
 *
 * Every input below is a shape measured on the live wire (`GET /clusters/platformsbx/traffic-errors`,
 * `tailLines=500`): `requests` 2974, `server` **0**, `client` 505, `noResponse` 1808, `groups` 430,
 * and a `byCode` that contains `200` and two redirects alongside the errors. That cluster is the hard
 * case for this page — the headline number is *not* 5xx, and the largest number on the screen is the
 * one that must not read as a failure — so it is the case the tests are written against.
 *
 * Three claims are load-bearing and each has a test that fails if it is broken:
 *
 *  1. a zero is only a measurement when something was read (`logReadVerdict`);
 *  2. the breakdown lists the codes the window recorded and **never invents a missing one**;
 *  3. the class beside a code is the collector's, never re-derived from the number.
 */
import { describe, expect, it } from 'vitest';
import type { AccessLogVerdict, TrafficData, TrafficErrorGroup } from '../../../api';
import { accessLogView, breakdownRows, logReadVerdict, topPatterns } from './metrics-logic';

type Summary = TrafficData['summary'];

/** The live summary, verbatim. `server: 0` with a full window is the case the cards exist to get right. */
const LIVE: Summary = {
  requests: 2974,
  errors: 2313,
  server: 0,
  client: 505,
  noResponse: 1808,
  groups: 430,
  byCode: [
    { code: 0, class: 'no-response', count: 1808 },
    { code: 200, class: 'ok', count: 659 },
    { code: 403, class: 'client', count: 472 },
    { code: 400, class: 'client', count: 33 },
    { code: 304, class: 'redirect', count: 1 },
    { code: 302, class: 'redirect', count: 1 }
  ]
};

function log(over: Partial<AccessLogVerdict> = {}): AccessLogVerdict {
  return {
    state: 'on',
    reason: null,
    detail: null,
    providers: ['stdout-json'],
    decidedBy: [],
    providerDetail: [
      { name: 'stdout-json', kind: 'file', implementation: 'envoyFileAccessLog', readable: true, destination: '/dev/stdout', fields: null }
    ],
    readable: true,
    unresolvedProviders: [],
    recordedElsewhere: false,
    meshUnavailable: false,
    why: 'Telemetry mesh-default names stdout-json, which the mesh config resolves to /dev/stdout.',
    ...over
  };
}

function group(over: Partial<TrafficErrorGroup> = {}): TrafficErrorGroup {
  return {
    key: 'k',
    code: 403,
    class: 'client',
    method: 'GET',
    path: '/',
    authority: 'example.invalid',
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

describe('logReadVerdict', () => {
  it('reads the live window as a measurement, so `server: 0` prints as a real zero', () => {
    const v = logReadVerdict(LIVE, log());
    expect(v.state).toBe('ok');
  });

  it('marks the counts unavailable when the access log provably never reaches this reader', () => {
    const v = logReadVerdict(
      { ...LIVE, requests: 0, errors: 0, server: 0, client: 0, noResponse: 0, groups: 0, byCode: [] },
      log({
        readable: false,
        recordedElsewhere: true,
        providers: ['otel-logs'],
        providerDetail: [
          { name: 'otel-logs', kind: 'otlp', implementation: 'envoyOtelAls', readable: false, destination: 'telemetry-otlp:4317', fields: 'otel' }
        ]
      })
    );
    expect(v.state).toBe('unavailable');
    // The sink is named, because "not read" with no reason reads as a broken page.
    expect(v.why).toContain('otel-logs');
  });

  it('refuses to call an empty window a zero when the log destination was never confirmed', () => {
    const v = logReadVerdict(
      { ...LIVE, requests: 0, errors: 0, server: 0, client: 0, noResponse: 0, groups: 0, byCode: [] },
      log({ readable: null, providerDetail: [] })
    );
    expect(v.state).toBe('unavailable');
  });

  it('lets a genuinely quiet stdout-logging cluster keep its zero', () => {
    const v = logReadVerdict(
      { ...LIVE, requests: 0, errors: 0, server: 0, client: 0, noResponse: 0, groups: 0, byCode: [] },
      log({ readable: true })
    );
    expect(v.state).toBe('ok');
  });

  it('is unavailable when no payload arrived at all', () => {
    expect(logReadVerdict(undefined, undefined).state).toBe('unavailable');
  });
});

describe('breakdownRows', () => {
  it('lists every observed code, errors highest-first, and nothing else', () => {
    const { errors, context, total } = breakdownRows(LIVE.byCode);
    expect(errors.map(r => r.code)).toEqual([0, 403, 400]);
    // `302` and `304` both counted 1 on the wire and arrived in the opposite order. The code is the
    // tie-break, so two equal counts cannot swap places between renders.
    expect(context.map(r => r.code)).toEqual([200, 302, 304]);
    // The denominator is every record read, which is what makes a share meaningful.
    expect(total).toBe(2974);
  });

  it('never synthesises a row for a code the window did not record', () => {
    const { errors, context } = breakdownRows(LIVE.byCode);
    const codes = [...errors, ...context].map(r => r.code);
    // The request's example listed `401 0` and `404 0`. A printed zero for a code that never
    // appeared is indistinguishable from one that was looked for and not found.
    expect(codes).not.toContain(404);
    expect(codes).not.toContain(401);
    expect(codes).not.toContain(500);
  });

  it('keeps a code that is present with a genuine zero, and marks it subtle', () => {
    const { errors } = breakdownRows([
      { code: 503, class: 'server', count: 0 },
      { code: 403, class: 'client', count: 10 }
    ]);
    const row = errors.find(r => r.code === 503)!;
    expect(row.zero).toBe(true);
    // A share of exactly zero, not an absent one: records were read and none of them was a 503.
    expect(row.share).toBe(0);
  });

  it('states no share at all when the window recorded nothing to divide by', () => {
    const { errors } = breakdownRows([{ code: 503, class: 'server', count: 0 }]);
    expect(errors[0]!.share).toBe(null);
  });

  it('takes the class from the collector and never from the number', () => {
    // A 403 the collector called `server` renders as a server error. Re-deriving the class from
    // 400–499 would silently disagree with the failures table, which reads the same field.
    const { errors } = breakdownRows([{ code: 403, class: 'server', count: 2 }]);
    expect(errors[0]!.barClass).toBe('dist-bar-server');
    expect(errors[0]!.word).toBe('server error');
  });

  it('separates successes and redirects from the errors and makes them unfilterable', () => {
    const { errors, context } = breakdownRows(LIVE.byCode);
    expect(errors.every(r => r.filterable)).toBe(true);
    // Clicking `200` would filter a table that holds failure groups only — an empty table that
    // blames the operator for the click.
    expect(context.every(r => r.filterable)).toBe(false);
    expect(context.map(r => r.word)).toEqual(['success', 'redirect', 'redirect']);
  });

  it('labels response_code 0 as none rather than as the number zero', () => {
    const { errors } = breakdownRows(LIVE.byCode);
    expect(errors[0]!.label).toBe('none');
    expect(errors[1]!.label).toBe('403');
  });

  it('gives an empty window no rows and no denominator', () => {
    expect(breakdownRows(undefined)).toEqual({ errors: [], context: [], total: 0 });
  });

  it('keeps a class it does not recognise, out of the error band and with its own word', () => {
    const { errors, context } = breakdownRows([{ code: 999, class: 'teapot', count: 3 }]);
    expect(errors).toHaveLength(0);
    expect(context[0]!.word).toBe('teapot');
    expect(context[0]!.filterable).toBe(false);
  });
});

describe('topPatterns', () => {
  it('takes the most frequent groups, highest first', () => {
    const rows = topPatterns(
      [group({ key: 'a', count: 3 }), group({ key: 'b', count: 91 }), group({ key: 'c', count: 12 })],
      2
    );
    expect(rows.map(g => g.key)).toEqual(['b', 'c']);
  });

  it('does not mutate the array the shell passed it', () => {
    const groups = [group({ key: 'a', count: 1 }), group({ key: 'b', count: 9 })];
    topPatterns(groups, 5);
    expect(groups.map(g => g.key)).toEqual(['a', 'b']);
  });
});

describe('accessLogView', () => {
  it('says enabled only when the log is readable from here', () => {
    expect(accessLogView(log())).toMatchObject({ word: 'Enabled', tone: 'ok' });
  });

  it('does not say enabled when the log is written somewhere this tab cannot follow', () => {
    const v = accessLogView(log({ readable: false, recordedElsewhere: true }));
    expect(v.tone).toBe('warn');
    expect(v.word).not.toBe('Enabled');
  });

  it('keeps an unconfirmed provider out of both green and red', () => {
    expect(accessLogView(log({ readable: null }))).toMatchObject({ tone: 'unknown' });
  });

  it('reports off and unknown as themselves', () => {
    expect(accessLogView(log({ state: 'off', readable: false })).word).toBe('Disabled');
    expect(accessLogView(log({ state: 'unknown', readable: null })).word).toBe('Unknown');
    expect(accessLogView(undefined).tone).toBe('unknown');
  });
});
