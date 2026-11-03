/**
 * Speculative tab warming, and the GET coalescing it depends on.
 *
 * Both exist to remove first-visit latency, and both fail in ways no user-visible symptom
 * would report:
 *
 *  - Warming that runs in *parallel* still makes every tab fast — while saturating the same
 *    eight-slot per-cluster gate the tab in front of the operator is waiting on. The page gets
 *    slower and the sweep looks like it is working.
 *  - Warming that silently stops running (the first version cancelled its own sweep on a tab
 *    switch and then refused to start another for thirty seconds) leaves every tab exactly as
 *    slow as before. There is no error, no console line, nothing to notice.
 *  - Coalescing that drops a caller means one of two components rendering an empty section.
 *
 * So the properties are asserted directly rather than inferred from a timing measurement.
 * `environment: 'node'` — the browser globals these two modules touch are stubbed per test,
 * which is also the reason they are touched inside functions and never at module scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, DEFAULT_TRACES_TAIL, helmRelatedPath } from './api';
import * as prefetch from './prefetch';
import { TABS, type Tab } from './pages/cluster-tabs/tabs';

type Call = { path: string; priority: string | null };

/** Every fetch the modules under test issued, and how many were open at their peak. */
let calls: Call[] = [];
let open = 0;
let peakOpen = 0;
/**
 * Reads park here while `hold` is set, so a test can observe the world *mid-request* — which
 * is the only moment the two properties that matter are observable at all. Let every read
 * settle on the microtask queue instead and the sweep runs to completion inside a single
 * `await`, at which point "one at a time" and "the click joined the read already in flight"
 * are both unfalsifiable.
 */
let parked: Array<() => void> = [];
let hold = false;
let failPaths: Set<string>;

/** Stop parking, and let go of everything already parked. */
function releaseAll() {
  hold = false;
  const waiting = parked;
  parked = [];
  for (const resolve of waiting) resolve();
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: 'http://localhost/api/fleet',
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

beforeEach(() => {
  calls = [];
  open = 0;
  peakOpen = 0;
  parked = [];
  hold = false;
  failPaths = new Set();
  prefetch.reset();
  vi.useFakeTimers();

  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k)
    },
    location: { origin: 'http://localhost', reload: () => {} }
  });
  vi.stubGlobal('document', { visibilityState: 'visible' });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const path = String(url).replace('/api/fleet', '');
      calls.push({ path, priority: headers['x-fleet-priority'] ?? null });
      open += 1;
      peakOpen = Math.max(peakOpen, open);
      try {
        await new Promise<void>(resolve => (hold ? parked.push(resolve) : queueMicrotask(resolve)));
        if (failPaths.has(path)) throw new Error(`network down for ${path}`);
        return jsonResponse({ ok: true, path });
      } finally {
        open -= 1;
      }
    })
  );
});

afterEach(() => {
  prefetch.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the microtask queue settle far enough for the sweep's serial awaits to chain. */
async function settle() {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}

/** Run the sweep to completion: fire the head-start timer, then drain its serial awaits. */
async function drainSweep() {
  await vi.advanceTimersByTimeAsync(prefetch.HEAD_START_MS);
  releaseAll();
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
}

/** Fire the head-start timer and stop with the sweep's first read still open. */
async function sweepToFirstRead() {
  hold = true;
  await vi.advanceTimersByTimeAsync(prefetch.HEAD_START_MS);
  await settle();
}

const paths = () => calls.map(c => c.path);

/**
 * The Traffic tab's URL, taken from the prefetch map rather than written out.
 *
 * A literal here is what hid the defect the URL-parity test now pins: the tests agreed with
 * the prefetch and the prefetch disagreed with the tab, so everything was green while the
 * warmed entry was one no tab ever read.
 */
const TRAFFIC_URL = prefetch.TAB_READS.network('c1')[0]!;
const TRACES_URL = prefetch.TAB_READS.network('c1')[1]!;

describe('the warming sweep', () => {
  it('reads one tab at a time, never in parallel', async () => {
    // The whole reason this is a sweep and not a `Promise.all`. Twelve parallel speculative
    // reads fill the per-cluster gate and the tab the operator clicked queues behind work
    // nobody asked for — the inversion the low-priority tier was introduced to prevent.
    prefetch.start('c1', 'overview');
    await drainSweep();
    expect(calls.length).toBeGreaterThan(5);
    expect(peakOpen).toBe(1);
  });

  it('marks every speculative read low priority', async () => {
    // The server demotes on this header alone. Drop it and the sweep competes with the
    // foreground at equal priority, which is strictly worse than not warming at all.
    prefetch.start('c1', 'overview');
    await drainSweep();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.priority).toBe('low');
  });

  it('skips the tab that is already loading itself', async () => {
    prefetch.start('c1', 'security');
    await drainSweep();
    for (const p of prefetch.TAB_READS.security('c1')) expect(paths()).not.toContain(p);
    // ...and still warms the others.
    expect(paths()).toContain(TRAFFIC_URL);
  });

  it('reads a path shared by two tabs exactly once per sweep', async () => {
    // Tabs share reads on purpose: Top Utilization ranks the workloads payload the Workloads tab
    // fetches, and Observability reads the same access-log tail as Traffic Errors. Declaring the
    // shared path in both tabs is the honest description of what each needs — so the sweep, not
    // the declaration, is what must not fetch it twice. The second fetch hits the server's route
    // cache and so looks free, while still holding one of the cluster's eight gate slots at the
    // moment the operator's own tab may want it.
    prefetch.start('c1', null);
    await drainSweep();
    const seen = paths();
    const duplicated = seen.filter((p, i) => seen.indexOf(p) !== i);
    expect(duplicated).toEqual([]);
    // And the shared paths really were in scope, so this is not passing on an empty sweep.
    expect(seen).toContain(TRAFFIC_URL);
    expect(seen).toContain(prefetch.TAB_READS.workloads('c1')[0]);
  });

  it('warms edge request evidence first, because traffic-errors is never cached', async () => {
    prefetch.start('c1', 'overview');
    await drainSweep();
    expect(paths()[0]).toBe(TRAFFIC_URL);
  });

  it('warms service-flow evidence straight after edge traffic because the two share a proxy-log tail', async () => {
    // Warming traces last left the first visit to Distributed Traces paying a cold 11s read.
    // Since `proxy-log-share.js` it reuses the tails the traffic read just took, so it is cheap
    // second and the costliest wait in the console when it is last.
    prefetch.start('c1', 'overview');
    await drainSweep();
    expect(paths().slice(0, 2)).toEqual([TRAFFIC_URL, TRACES_URL]);
  });

  it('keeps sweeping when one read is refused', async () => {
    // A reader role that cannot see one tab must not cost the operator every other tab.
    failPaths.add(TRAFFIC_URL);
    prefetch.start('c1', 'overview');
    await drainSweep();
    expect(paths()).toContain('/clusters/c1/policy');
  });

  it('does not restart a sweep that is already running for the same cluster', async () => {
    // The first version's bug, and an invisible one: `start` cancelled unconditionally and
    // then hit its own TTL check, so switching tabs two seconds in killed the sweep and
    // refused to run another for thirty seconds. Warming simply stopped for the operators who
    // browse fastest, with nothing on screen to say so.
    prefetch.start('c1', 'overview');
    await sweepToFirstRead();
    expect(calls).toHaveLength(1);

    prefetch.start('c1', 'network'); // the operator switched network views mid-sweep
    await drainSweep();

    expect(calls.length).toBeGreaterThan(1);
    // ...and exactly one sweep ran, not two racing each other.
    expect(new Set(paths()).size).toBe(paths().length);
  });

  it('sweeps a cluster at most once per cache window', async () => {
    prefetch.start('c1', 'overview');
    await drainSweep();
    const first = calls.length;
    prefetch.start('c1', 'overview');
    await drainSweep();
    expect(calls.length).toBe(first);
  });

  it('abandons the sweep when the operator leaves the cluster', async () => {
    const cancel = prefetch.start('c1', 'overview');
    await sweepToFirstRead();
    const atCancel = calls.length;
    cancel();
    await drainSweep();
    expect(calls.filter(c => c.path.startsWith('/clusters/c1/')).length).toBe(atCancel);
  });

  it('warms nothing while the page is hidden', async () => {
    // Same rule useAsync applies to polling: a background tab is nobody looking at a
    // dashboard, and warming it spends the operator's cluster budget on a window they cannot
    // see.
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    prefetch.start('c1', 'overview');
    await drainSweep();
    expect(calls).toEqual([]);
  });
});

describe('the tab-to-read map', () => {
  it('names every tab, so adding one cannot silently skip warming it', () => {
    expect(Object.keys(prefetch.TAB_READS)).toEqual(expect.arrayContaining(TABS.map(t => t.id)));
    expect([...prefetch.SWEEP_ORDER].sort()).toEqual(TABS.map(t => t.id).sort());
  });

  it('warms no path that depends on a selection the operator has not made', () => {
    // Guessing a namespace, a pod or a release warms the wrong read and pays for it twice.
    //
    // Stated over parameter *names*, not over the presence of a `?`. The earlier form banned
    // query strings outright, and that is precisely what let this break: `tailLines` is not a
    // guess about anything the operator chose, it is the default the tab always sends, so
    // banning it meant the prefetch warmed a URL no tab ever requests. See the URL-parity
    // test below for the other half of the rule.
    const SELECTION_PARAMS = ['namespace', 'pod', 'container', 'release', 'name', 'kind'];
    for (const tab of Object.keys(prefetch.TAB_READS) as Tab[]) {
      for (const path of prefetch.TAB_READS[tab]('c1')) {
        const query = new URLSearchParams(path.split('?')[1] ?? '');
        for (const param of SELECTION_PARAMS) {
          expect(query.has(param), `${tab} -> ${path} guesses ${param}`).toBe(false);
        }
      }
    }
  });

  it('warms the exact URL the tab requests, query string included', async () => {
    // The defect this pins: the prefetch warmed `/traffic-errors` while the Traffic tab
    // requested `/traffic-errors?tailLines=300`. Two URLs are two cache keys on both the
    // client (`sharedGet`) and the server (the 15s traffic entry), so the speculative read
    // bought nothing *and* cost a second ten-pod log sweep — measured in the browser at 8.6s
    // followed by 2.3s for one tab open.
    //
    // Traffic is the only warmed read that carries a parameter today. Asserting it against
    // the client method rather than against a literal is what makes the two impossible to
    // change apart.
    await api.clusterTrafficErrors('c1', {});
    expect([TRAFFIC_URL]).toEqual(paths());
  });

  it('warms the exact Traces URL the tab requests, plus Refused Requests’ own read', async () => {
    // The same defect a second time, found 2026-09-27: the prefetch warmed `/traces` while the
    // tab asked for `/traces?tailLines=500`, a different key on the client and on the server.
    // The tab's default comes from `DEFAULT_TRACES_TAIL`, so this is the tab's own request.
    await api.clusterTraces('c1', { tailLines: DEFAULT_TRACES_TAIL });
    const tracesPath = paths()[0];
    // Refused Requests (the fifth sub-tab) reads `/traffic-errors` on its own — the exact URL
    // `TracesRefused.tsx` requests with no namespace filter, so its first visit is warm too.
    await api.clusterTrafficErrors('c1', {});
    const trafficErrorsPath = paths()[1];
    const warmed = prefetch.TAB_READS.network('c1');
    // Network Operations reads these two and nothing else: Networking, Istio and Certificates warm their own.
    expect(warmed).toHaveLength(2);
    expect(warmed).toEqual(expect.arrayContaining([tracesPath, trafficErrorsPath]));
  });

  it('is cluster-agnostic — every path is built from the id it is given', () => {
    // This console is a fleet console: nothing here may assume a particular cluster.
    const built = (Object.keys(prefetch.TAB_READS) as Tab[]).flatMap(t => prefetch.TAB_READS[t]('any-cluster'));
    expect(built.length).toBeGreaterThan(0);
    for (const p of built) expect(p.startsWith('/clusters/any-cluster/')).toBe(true);
  });
});

describe('hover-intent warming', () => {
  it('warms the exact URL the release page will request', async () => {
    // The same URL-parity property as the traffic test above, and the same failure if it slips:
    // a warm that misses is worse than no warm, because it pays a 26-call, ~4s read twice. Both
    // sides are built from `helmRelatedPath`, so this asserts they are still the one function.
    prefetch.warm(helmRelatedPath('c1', 'ns one', 'rel'));
    releaseAll();
    await settle();
    const warmed = paths();

    calls = [];
    await api.clusterHelmRelated('c1', 'ns one', 'rel');
    expect(warmed).toEqual(paths());
  });

  it('is low priority, so it can never take the last slots from the tab in front of the operator', async () => {
    prefetch.warm('/clusters/c1/anything');
    releaseAll();
    await settle();
    expect(calls.map(c => c.priority)).toEqual(['low']);
  });

  it('reads once per window however many times the pointer crosses the row', async () => {
    // A pointer sweeping a table of forty releases fires `onIntent` forty times. Without the
    // dedupe that is forty speculative reads against the cluster for one click.
    for (let i = 0; i < 20; i += 1) prefetch.warm('/clusters/c1/helm/releases/ns/rel/related');
    releaseAll();
    await settle();
    expect(paths()).toEqual(['/clusters/c1/helm/releases/ns/rel/related']);
  });

  it('warms a different row separately', async () => {
    prefetch.warm('/clusters/c1/a');
    prefetch.warm('/clusters/c1/b');
    releaseAll();
    await settle();
    expect(paths().sort()).toEqual(['/clusters/c1/a', '/clusters/c1/b']);
  });

  it('never rejects when the read fails, because nobody is awaiting it', async () => {
    // `warm` is called from a pointer handler and its result is discarded. A rejection here
    // would surface as an unhandled promise rejection on a hover — a console error for a read
    // the operator never asked for.
    failPaths.add('/clusters/c1/refused');
    expect(() => prefetch.warm('/clusters/c1/refused')).not.toThrow();
    releaseAll();
    await settle();
    expect(paths()).toEqual(['/clusters/c1/refused']);
  });
});

describe('GET coalescing', () => {
  it('serves two simultaneous callers of one route from a single request', async () => {
    // Not hypothetical: the Security tab renders two independent sections that each call
    // `api.clusterPolicy(id)`, so one screen used to issue two 80 KB reads.
    const both = Promise.all([api.clusterPolicy('c1'), api.clusterPolicy('c1')]);
    await vi.advanceTimersByTimeAsync(0);
    await both;
    expect(paths().filter(p => p === '/clusters/c1/policy')).toHaveLength(1);
  });

  it('upgrades past a low-priority prefetch instead of joining it', async () => {
    // Joining the prefetch's promise would inherit its `low` header and queue the click behind
    // the server's per-cluster gate (measured 1014ms vs. a 12ms cold read) — worse than not
    // warming at all. So the click starts its own foreground read and takes over the slot;
    // the superseded low read still runs to completion underneath it.
    prefetch.start('c1', 'overview');
    await sweepToFirstRead();
    expect(paths()).toEqual([TRAFFIC_URL]);

    const clicked = api.clusterTrafficErrors('c1', {});
    await settle();
    await drainSweep();
    await clicked;

    const trafficCalls = calls.filter(c => c.path === TRAFFIC_URL);
    expect(trafficCalls).toHaveLength(2);
    expect(trafficCalls.map(c => c.priority)).toEqual(['low', null]);
  });

  it('still lets a prefetch join a foreground read already in flight for it', async () => {
    // The other direction is unchanged: a speculative read arriving after the operator's own
    // click gains nothing by displacing it, so it joins rather than issuing a second copy.
    hold = true;
    const clicked = api.clusterTrafficErrors('c1', {});
    await settle();
    expect(paths()).toEqual([TRAFFIC_URL]);

    prefetch.start('c1', 'overview');
    await vi.advanceTimersByTimeAsync(prefetch.HEAD_START_MS);
    await settle();
    releaseAll();
    await clicked;
    await drainSweep();

    expect(calls.filter(c => c.path === TRAFFIC_URL)).toHaveLength(1);
  });

  it('starts a fresh request once the shared one has settled', async () => {
    // Coalescing shares an in-flight promise, never a stored response. A second read after
    // the first completed must actually go to the server, or this would be a cache with none
    // of a cache's staleness rules.
    await api.clusterPolicy('c1');
    await api.clusterPolicy('c1');
    expect(paths().filter(p => p === '/clusters/c1/policy')).toHaveLength(2);
  });

  it('never shares a request that carries a method or a body', async () => {
    // Sharing a promise whose underlying request another caller can abort — or whose method is
    // not GET at all — would hand a write's result to a reader, or cancel a read its owner
    // never cancelled. `renew` is the non-GET on the same client and must always be its own
    // request even when its path repeats.
    await Promise.all([api.renew('c1').catch(() => undefined), api.renew('c1').catch(() => undefined)]);
    expect(paths().filter(p => p === '/tokens/c1/renew')).toHaveLength(2);
  });
});
