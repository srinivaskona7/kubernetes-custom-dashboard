/**
 * Distributed Traces: the outcome filter, its counts, and the captions that name what the collector's
 * cap left in the table.
 */
import { describe, expect, it } from 'vitest';
import type { Trace, TraceHop, TraceOutboundRow } from '../../api';
import { fromTitle } from './outbound-view';
import {
  capped,
  filterTraces,
  hiddenLine,
  initialOutcome,
  isSuccessfulTrace,
  keptCaption,
  matchesOutcome,
  matchesTraceSearch,
  ofShown,
  outcomeCounts,
  outcomeUnclassified,
  p95Of,
  shownSpanLine,
  worstHopText
} from './traces-view';

const hop = (over: Partial<TraceHop> = {}): TraceHop => ({ seq: 1, code: 200, codeClass: 'ok', ...over }) as TraceHop;

const trace = (over: Partial<Trace> = {}): Trace =>
  ({
    traceId: 't1',
    requestId: 'r1',
    method: 'GET',
    path: '/health',
    authority: 'app.example.com',
    flags: [],
    hasError: false,
    totalDurationMs: 10,
    hopCount: 1,
    startTime: '2026-09-25T10:00:00.000Z',
    worstStatus: null,
    errorHop: null,
    hops: [hop()],
    ...over
  }) as Trace;

const rows = [
  trace({ traceId: 'ok' }),
  trace({ traceId: 'err', class: 'app', appError: false, hasError: true, worstStatus: 401, errorHop: 1, hops: [hop({ code: 401, codeClass: 'client' })] }),
  trace({ traceId: 'slow', totalDurationMs: 800, path: '/checkout' }),
  trace({ traceId: 'multi', hopCount: 3, path: '/checkout' }),
  trace({ traceId: 'nodur', totalDurationMs: null })
];

describe('outcome filter', () => {
  it('each outcome selects its own rows', () => {
    const ids = (o: Parameters<typeof filterTraces>[1]) => filterTraces(rows, o, '', 500).map(t => t.traceId);
    expect(ids('all')).toHaveLength(5);
    expect(ids('app-errors')).toEqual([]);
    expect(ids('app')).toEqual(['err']);
    expect(ids('slow')).toEqual(['slow']);
    expect(ids('multi')).toEqual(['multi']);
  });

  it('slow is a threshold, inclusive, and a journey with no duration is never slow', () => {
    expect(matchesOutcome(trace({ totalDurationMs: 500 }), 'slow', 500)).toBe(true);
    expect(matchesOutcome(trace({ totalDurationMs: 499 }), 'slow', 500)).toBe(false);
    expect(matchesOutcome(trace({ totalDurationMs: null }), 'slow', 500)).toBe(false);
  });

  it('search matches ids, path, host and flags, case-insensitively, and combines with the outcome', () => {
    expect(matchesTraceSearch(trace({ flags: ['UF'] }), 'uf')).toBe(true);
    expect(matchesTraceSearch(trace(), 'APP.example')).toBe(true);
    expect(matchesTraceSearch(trace(), 'nope')).toBe(false);
    expect(filterTraces(rows, 'multi', 'checkout', 500).map(t => t.traceId)).toEqual(['multi']);
  });

  it('counts each chip over the rows the search leaves', () => {
    expect(outcomeCounts(rows, '', 500)).toEqual({ all: 5, app: 1, egress: 0, refused: 0, 'app-errors': 0, slow: 1, multi: 1 });
    expect(outcomeCounts(rows, 'checkout', 500)).toEqual({ all: 2, app: 0, egress: 0, refused: 0, 'app-errors': 0, slow: 1, multi: 1 });
  });
});

describe('request-class outcomes', () => {
  const classed = [
    trace({ traceId: 'a1', class: 'app', appError: true }),
    trace({ traceId: 'a2', class: 'app', appError: false }),
    trace({ traceId: 'e1', class: 'egress-declared', appError: false }),
    trace({ traceId: 'e2', class: 'egress-undeclared', appError: false }),
    trace({ traceId: 'r1', class: 'security-refused', appError: false, hasError: true })
  ];
  it('counts each chip over its class', () => {
    const c = outcomeCounts(classed, '', 500);
    expect([c.all, c.app, c.egress, c.refused, c['app-errors']]).toEqual([5, 2, 1, 1, 1]);
  });
  it('a refused 403 is never an app error', () => {
    expect(filterTraces(classed, 'app-errors', '', 500).map(t => t.traceId)).toEqual(['a1']);
  });
  it('a server older than the class field counts zero, never throws', () => {
    const c = outcomeCounts([trace({ hasError: true })], '', 500);
    expect([c.all, c.app, c['app-errors']]).toEqual([1, 0, 0]);
  });
});

describe('what the cap left', () => {
  it('names the denominator only when the cap bit', () => {
    expect(capped({ traces: 200, tracesFound: 1509 })).toBe(true);
    expect(capped({ traces: 40, tracesFound: 40 })).toBe(false);
    expect(ofShown({ traces: 200, tracesFound: 1509 }, 'seen by more than one proxy')).toBe('seen by more than one proxy, of the 200 kept');
    expect(ofShown({ traces: 40, tracesFound: 40 }, 'seen by more than one proxy')).toBe('seen by more than one proxy');
  });

  it('states the shown journeys and their own time range, not the window', () => {
    expect(shownSpanLine({ traces: 40, tracesFound: 40 }, rows)).toBeNull();
    const line = shownSpanLine({ traces: 200, tracesFound: 1509 }, rows);
    expect(line).toMatch(/^Showing 200 of 1,509 journeys, app first, started /);
  });
});

describe('worst hop', () => {
  it('says a clean journey is clean, never an em dash', () => {
    expect(worstHopText(trace())).toBe('none — every hop answered 2xx/3xx');
  });
  it('names the status and the hop when one failed', () => {
    expect(worstHopText(rows[1]!)).toBe('401 at hop 1');
    expect(worstHopText(trace({ worstStatus: 0, errorHop: 2 }))).toBe('no response at hop 2');
  });
  it('stays unknown when there is no worst status and not every hop is ok', () => {
    expect(worstHopText(trace({ hops: [hop({ code: 0, codeClass: 'no-response' })] }))).toBe('—');
    expect(worstHopText(trace({ hops: [] }))).toBe('—');
  });
});

describe('successful request monitoring', () => {
  it('requires a successful edge result and every observed hop to be successful', () => {
    expect(isSuccessfulTrace(trace({ finalStatusClass: 'ok' }))).toBe(true);
    expect(isSuccessfulTrace(trace({ finalStatusClass: 'client' }))).toBe(false);
    expect(isSuccessfulTrace(trace({ finalStatusClass: 'ok', worstStatus: 503, hops: [hop({ code: 503, codeClass: 'server' })] }))).toBe(false);
    expect(isSuccessfulTrace(trace({ finalStatusClass: 'ok', hops: [] }))).toBe(false);
    expect(isSuccessfulTrace(trace({ finalStatusClass: 'ok', hops: [hop({ code: 0, codeClass: 'no-response' })] }))).toBe(false);
  });
});

describe('p95 of the successful requests', () => {
  const durations = (n: number, from = 1) => Array.from({ length: n }, (_, i) => trace({ traceId: `t${i}`, totalDurationMs: from + i }));

  it('is withheld below the server floor of 20 durations, with the count it rests on', () => {
    expect(p95Of(durations(19))).toEqual({ p95: null, samples: 19 });
    expect(p95Of([])).toEqual({ p95: null, samples: 0 });
  });

  it('is the nearest-rank value at 20 and above', () => {
    expect(p95Of(durations(20))).toEqual({ p95: 19, samples: 20 });
    expect(p95Of(durations(100))).toEqual({ p95: 95, samples: 100 });
  });

  it('rounds the rank up: 25 durations put the p95 at the 24th, not the 23rd', () => {
    expect(p95Of(durations(25))).toEqual({ p95: 24, samples: 25 });
  });

  it('ignores a journey with no duration and does not depend on row order', () => {
    const rowsIn = [...durations(20), trace({ totalDurationMs: null })].reverse();
    expect(p95Of(rowsIn)).toEqual({ p95: 19, samples: 20 });
  });
});

describe('what the server left out', () => {
  it('names the hidden polls by kind and the journeys outside the scope', () => {
    expect(
      hiddenLine(
        { pollsHidden: 746, pollsHiddenBy: [{ kind: 'Streamlit health', count: 728 }, { kind: 'Istio readiness', count: 18 }], outsideNamespace: 32 },
        ['applecare']
      )
    ).toBe('746 successful liveness polls hidden (Streamlit health 728, Istio readiness 18); 32 journeys never touched applecare');
  });
  it('says nothing when nothing was left out, and ignores an outside count with no scope', () => {
    expect(hiddenLine({ pollsHidden: 0, pollsHiddenBy: [], outsideNamespace: 0 }, [])).toBeNull();
    expect(hiddenLine({ pollsHidden: 0, outsideNamespace: 5 }, [])).toBeNull();
    expect(hiddenLine(undefined, [])).toBeNull();
  });
});

describe('outcomeUnclassified', () => {
  it('a server that sends no classCounts leaves the class chips unanswered, not at zero', () => {
    expect(outcomeUnclassified('app', undefined)).toBe(true);
    expect(outcomeUnclassified('app-errors', {})).toBe(true);
    expect(outcomeUnclassified('slow', {})).toBe(false);
    expect(outcomeUnclassified('all', undefined)).toBe(false);
  });
  it('a classifying server answers every chip, zeros included', () => {
    for (const o of ['app', 'egress', 'refused', 'app-errors'] as const) expect(outcomeUnclassified(o, { classCounts: {} })).toBe(false);
  });
});

describe('initialOutcome', () => {
  it('opens on App journeys when the server classifies and some exist', () => {
    expect(initialOutcome({ classCounts: { app: 3, 'direct-or-tls': 190 } })).toBe('app');
  });
  it('stays on All for an older server or no app journey', () => {
    expect(initialOutcome(undefined)).toBe('all');
    expect(initialOutcome({})).toBe('all');
    expect(initialOutcome({ classCounts: { 'direct-or-tls': 200 } })).toBe('all');
  });
});

describe('keptCaption', () => {
  it('says the cap kept app first', () => {
    expect(keptCaption({ traces: 200, tracesFound: 912 })).toBe('200 kept of 912: app first');
    expect(keptCaption({ traces: 12, tracesFound: 12 })).toBeNull();
  });
});

describe('fromTitle (Outbound From cell)', () => {
  const ref = (name: string, namespace: string | null) => ({ from: { id: 'w', kind: 'workload', name, namespace } }) as unknown as Pick<TraceOutboundRow, 'from'>;
  it('names the caller in full, however long, where the cell prints a fitted name', () => {
    const long = 'bookshop-srv-approuter-canary-7f9c';
    expect(fromTitle(ref(long, 'shop'))).toContain(`shop/${long}`);
  });
  it('prints no dangling slash when the caller has no namespace', () => {
    expect(fromTitle(ref('gw', null)).startsWith('gw ')).toBe(true);
  });
});
