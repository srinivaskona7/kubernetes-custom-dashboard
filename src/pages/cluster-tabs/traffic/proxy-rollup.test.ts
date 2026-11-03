/**
 * The pure half of the Response codes and Proxies observed sub-tabs.
 *
 * Every one of these guards a place where the page could state something the backend never said. The
 * per-proxy rollup is derived by summing across failure groups, so double-counting a proxy that
 * appears in two of them is a silent inflation; a failed log read that renders as `0 errors` is a
 * confident lie about a proxy nobody could read; and a visibility warning that never fires is as
 * useless as one that always does.
 *
 * No DOM: `vitest.config.ts` runs `environment: 'node'`, and everything here is a pure function.
 */
import { describe, expect, test } from 'vitest';
import type { TrafficErrorGroup, TrafficWindow } from '../../../api';
import {
  categoryOf,
  isFailingClass,
  readCoverage,
  recordsIn,
  rollUpProxies,
  shareOfRecords,
  visibilityNotice
} from './proxy-rollup';

type Proxy = TrafficErrorGroup['proxies'][number];

function proxy(pod: string, count: number, namespace = 'istio-system'): Proxy {
  return { pod, namespace, container: 'istio-proxy', count };
}

function group(over: Partial<TrafficErrorGroup> = {}): TrafficErrorGroup {
  return {
    key: '403|GET|/|shop.example.com',
    code: 403,
    class: 'client',
    method: 'GET',
    path: '/',
    authority: 'shop.example.com',
    protocol: 'HTTP/1.1',
    count: 1,
    firstSeen: '2026-09-19T10:00:00Z',
    lastSeen: '2026-09-19T11:00:00Z',
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

/** The live window at `tailLines=500`: 41 observed, 10 read, 31 never asked, 5 truncated. */
function window(over: Partial<TrafficWindow> = {}): TrafficWindow {
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
    oldest: '2026-09-18T22:00:00Z',
    newest: '2026-09-19T11:00:00Z',
    readsSkipped: false,
    ...over
  };
}

describe('rollUpProxies', () => {
  test('a proxy named by two groups is one row whose errors are the sum', () => {
    const rows = rollUpProxies(
      [
        group({ key: 'a', proxies: [proxy('gw-1', 200)] }),
        group({ key: 'b', proxies: [proxy('gw-1', 41)] })
      ],
      window()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.errors).toBe(241);
    // The group count is per group, not per entry: "named in 2 failure shapes", not "named twice".
    expect(rows[0]!.groups).toBe(2);
  });

  test('a proxy listed twice inside one group counts that group once', () => {
    // Two entries for one pod under two container names is a real shape, and counting the group twice
    // would make "failure shapes seen" larger than the number of groups that exist.
    const rows = rollUpProxies(
      [
        group({
          key: 'a',
          proxies: [proxy('gw-1', 3), { pod: 'gw-1', namespace: 'istio-system', container: 'istio-proxy-2', count: 4 }]
        })
      ],
      window()
    );
    expect(rows[0]!.groups).toBe(1);
    // Both entries are lines that pod logged, so both count toward its failures.
    expect(rows[0]!.errors).toBe(7);
    expect(rows[0]!.containers).toEqual(['istio-proxy', 'istio-proxy-2']);
  });

  test('the same pod name in two namespaces is two rows', () => {
    const rows = rollUpProxies(
      [group({ proxies: [proxy('istio-proxy-abc', 1, 'ns-a'), proxy('istio-proxy-abc', 2, 'ns-b')] })],
      window()
    );
    expect(rows.map(r => r.key).sort()).toEqual(['ns-a/istio-proxy-abc', 'ns-b/istio-proxy-abc']);
  });

  test('a failed read is distinguished from a proxy merely not read', () => {
    const rows = rollUpProxies([group({ proxies: [proxy('gw-1', 5)] })], window({
      proxiesRead: 9,
      proxiesFailed: [{ pod: 'gw-2', namespace: 'istio-system', reason: 'FORBIDDEN', detail: 'pods/log is refused' }]
    }));
    const failed = rows.find(r => r.pod === 'gw-2')!;
    expect(failed.state).toBe('failed');
    expect(failed.reason).toBe('FORBIDDEN');
    // The 31 proxies that were never asked are a count on the window and have no names on the wire,
    // so they must not appear as rows — a row would be this console inventing a pod.
    expect(rows).toHaveLength(2);
  });

  test('a failed read reports no error count, never a zero', () => {
    const rows = rollUpProxies([], window({
      proxiesRead: 9,
      proxiesFailed: [{ pod: 'gw-2', namespace: 'istio-system', reason: 'TIMEOUT', detail: null }]
    }));
    // Canary: `0` here asserts that proxy is failing nothing, which nobody observed.
    expect(rows[0]!.errors).toBeNull();
    expect(rows[0]!.errors).not.toBe(0);
    expect(rows[0]!.lastSeen).toBeNull();
  });

  test('a pod in both the groups and the failed list keeps the lines that were read', () => {
    // Not a shape the collector produces today — a failed read returns no lines. If it ever does,
    // overwriting a real count with null would hide failures this reader actually holds.
    const rows = rollUpProxies([group({ proxies: [proxy('gw-1', 12)] })], window({
      proxiesFailed: [{ pod: 'gw-1', namespace: 'istio-system', reason: 'UPSTREAM', detail: null }]
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failed');
    expect(rows[0]!.errors).toBe(12);
  });

  test('failed reads sort above the busiest proxy', () => {
    const rows = rollUpProxies([group({ proxies: [proxy('busy', 900)] })], window({
      proxiesFailed: [{ pod: 'refused', namespace: 'istio-system', reason: 'FORBIDDEN', detail: null }]
    }));
    // A gap in the data outranks a large number, because the gap changes how the number reads.
    expect(rows.map(r => r.pod)).toEqual(['refused', 'busy']);
  });

  test('last seen is the newest group timestamp, and unparseable stamps do not win', () => {
    const rows = rollUpProxies(
      [
        group({ key: 'a', lastSeen: '2026-09-19T10:00:00Z', proxies: [proxy('gw-1', 1)] }),
        group({ key: 'b', lastSeen: '2026-09-19T12:00:00Z', proxies: [proxy('gw-1', 1)] }),
        group({ key: 'c', lastSeen: 'not a date', proxies: [proxy('gw-1', 1)] }),
        group({ key: 'd', lastSeen: null, proxies: [proxy('gw-1', 1)] })
      ],
      window()
    );
    expect(rows[0]!.lastSeen).toBe('2026-09-19T12:00:00Z');
  });

  test('no groups and no failures is no rows, not a fabricated roster', () => {
    expect(rollUpProxies([], window())).toEqual([]);
    expect(rollUpProxies([], undefined)).toEqual([]);
  });
});

describe('readCoverage', () => {
  test('every figure is the backend’s own, and the three states account for the observed total', () => {
    const c = readCoverage(window())!;
    expect(c).toMatchObject({ observed: 41, read: 10, notRead: 31, failed: 0, truncated: 5 });
    expect(c.accountedFor).toBe(true);
  });

  test('a breakdown that does not add up says so rather than absorbing the difference', () => {
    // Nothing is derived from the other three, so a collector change surfaces as a refusal to print
    // the breakdown instead of a number that silently swallows the gap.
    expect(readCoverage(window({ proxiesSkipped: 12 }))!.accountedFor).toBe(false);
  });

  test('no window is no coverage, not a coverage of zero', () => {
    expect(readCoverage(undefined)).toBeNull();
  });
});

describe('visibilityNotice', () => {
  test('10 of 41 observed proxies fires the warning, worded as read rather than reporting', () => {
    const n = visibilityNotice(window())!;
    expect(n.title).toBe('Partial traffic visibility');
    expect(n.message).toContain('receiving logs from 10 of 41 observed proxies');
    expect(n.message).toContain('Results may not represent all mesh traffic');
    // "Reporting" and "silent" are claims about the proxy. A capped sweep is a claim about the reader.
    expect(n.message).not.toMatch(/reporting|silent/i);
  });

  test('41 of 41 with no failure is silence, not a warning nobody can act on', () => {
    expect(visibilityNotice(window({ proxiesRead: 41, proxiesSkipped: 0, truncatedProxies: 0 }))).toBeNull();
  });

  test('a failed read fires the warning even at a full read', () => {
    const n = visibilityNotice(window({
      proxiesRead: 41,
      proxiesSkipped: 0,
      proxiesFailed: [{ pod: 'gw-2', namespace: 'istio-system', reason: 'FORBIDDEN', detail: null }]
    }));
    expect(n).not.toBeNull();
    expect(n!.message).toContain('1 log read failed');
  });

  test('truncation is its own sentence and is never added to the not-read count', () => {
    const n = visibilityNotice(window())!;
    expect(n.truncatedNote).toContain('5 proxies had older lines beyond the 500-line tail');
    // 31 not read and 5 truncated are different gaps. 36 would describe neither.
    expect(n.message).not.toContain('36');
    expect(n.truncatedNote).toContain('different gap');
  });

  test('no truncated proxy leaves the truncation sentence unwritten', () => {
    expect(visibilityNotice(window({ truncatedProxies: 0 }))!.truncatedNote).toBeNull();
  });

  test('a skipped read is not partial visibility — it is none, and says so', () => {
    const n = visibilityNotice(window({ readsSkipped: true, proxiesRead: 0, proxiesSkipped: 41 }))!;
    expect(n.title).toBe('No traffic visibility');
    expect(n.message).toMatch(/cannot follow/);
    // Calling a read that never happened "partial" understates it by the whole window.
    expect(n.message).not.toContain('receiving logs from');
  });

  test('no observed proxy is no warning — there is no mesh here to be partly visible', () => {
    expect(visibilityNotice(window({ proxyCandidates: 0, proxiesRead: 0, proxiesSkipped: 0 }))).toBeNull();
  });

  test('no window at all establishes nothing, so it warns about nothing', () => {
    expect(visibilityNotice(undefined)).toBeNull();
  });
});

describe('categoryOf', () => {
  test('the category comes from the class the collector assigned', () => {
    expect(categoryOf('client').label).toBe('4xx Client');
    expect(categoryOf('server').label).toBe('5xx Server');
    expect(categoryOf('no-response').label).toBe('No response');
  });

  test('the answered class is not labelled 2xx, because the mesh classifier folds 3xx into it', () => {
    // `classOf` in the collector returns `ok` for anything under 400, and the live window carries a
    // 302 and a 304. "2xx Success" on those rows would be a lie the operator cannot see through.
    expect(categoryOf('ok').label).not.toMatch(/2xx/);
    expect(categoryOf('ok').why).toMatch(/3xx|redirect/i);
  });

  test('an unknown class prints verbatim rather than blank, and blames the console', () => {
    const c = categoryOf('teapot');
    expect(c.label).toBe('teapot');
    expect(c.tone).toBe('unknown');
    expect(c.why).toMatch(/gap in this build/);
    // An empty CATEGORY cell reads as a rendering bug, so even an empty class gets a word.
    expect(categoryOf('').label).toBe('unclassified');
  });

  test('every class has a tone and a sentence', () => {
    for (const cls of ['client', 'server', 'no-response', 'ok', 'redirect']) {
      expect(categoryOf(cls).label.length).toBeGreaterThan(0);
      expect(categoryOf(cls).why.length).toBeGreaterThan(20);
      expect(categoryOf(cls).tone).toBeTruthy();
    }
  });

  test('only a failing class has failing requests behind it to open', () => {
    // `data.errors` holds failures only, so a clickable `200` opens a table that says "nothing
    // matches" — true, and read as a broken link.
    expect(['client', 'server', 'no-response'].every(isFailingClass)).toBe(true);
    expect(isFailingClass('ok')).toBe(false);
    expect(isFailingClass('redirect')).toBe(false);
  });
});

describe('the share column', () => {
  const byCode = [
    { code: 0, class: 'no-response', count: 1808 },
    { code: 200, class: 'ok', count: 659 },
    { code: 403, class: 'client', count: 472 },
    { code: 400, class: 'client', count: 33 },
    { code: 304, class: 'ok', count: 1 },
    { code: 302, class: 'ok', count: 1 }
  ];

  test('the denominator is every record the table lists, so the column totals 100%', () => {
    const total = recordsIn(byCode);
    expect(total).toBe(2974);
    expect(shareOfRecords(472, total)).toBe('16%');
    // Summed from the rows on screen rather than from `summary.requests`, which is equal on the live
    // wire — the sum is what keeps the column internally consistent if they ever diverge.
    const sum = byCode.reduce((n, c) => n + c.count / total, 0);
    expect(Math.round(sum * 100)).toBe(100);
  });

  test('a zero denominator is an em-dash, never NaN%', () => {
    expect(shareOfRecords(0, 0)).toBe('—');
    expect(shareOfRecords(5, 0)).toBe('—');
    expect(shareOfRecords(5, 0)).not.toContain('NaN');
  });

  test('a share too small to round is floored, not printed as zero', () => {
    // 1 of 2,974 is 0.03%. Both "0%" and "0.0%" beside a count of 1 read as a rendering fault.
    expect(shareOfRecords(1, 2974)).toBe('<0.1%');
    expect(shareOfRecords(1, 2974)).not.toBe('0%');
    expect(shareOfRecords(1, 2974)).not.toBe('0.0%');
    // A share that genuinely has a tenth keeps it rather than being floored too.
    expect(shareOfRecords(33, 2974)).toBe('1%');
    expect(shareOfRecords(3, 1000)).toBe('0.3%');
  });

  test('a measured zero is a zero, which is not the same as no measurement', () => {
    expect(shareOfRecords(0, 2974)).toBe('0%');
    expect(shareOfRecords(0, 0)).toBe('—');
  });

  test('an empty byCode has no records, and that is a zero rather than a gap', () => {
    expect(recordsIn([])).toBe(0);
    expect(recordsIn(undefined)).toBe(0);
  });
});
