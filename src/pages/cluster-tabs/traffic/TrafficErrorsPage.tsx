/**
 * Traffic Errors — the page shell.
 *
 * Owns the read, the filter state, the header, the filter bar, refresh, and the three sub-tabs. The
 * blocks it arranges (the metric strip, the breakdown, the failures table, the response-code list, the
 * proxy list) each live in their own module and decide nothing about the page they sit on.
 *
 * ## One read, and why this file holds it
 *
 * `/clusters/:id/traffic-errors` tails the access log of up to ten `istio-proxy` containers and takes
 * four to seven seconds cold; the server deliberately does not cache it beyond a 15s window, because a
 * log tail is a moving target. So a second component fetching the same endpoint is not a tidiness
 * problem — it is a second ten-pod log sweep against a production cluster. `TrafficTab` therefore
 * mounts *either* the ingress screens (which own their own read of the same route) *or* this page, never
 * both, so exactly one read of this endpoint is alive at any moment. The cost of that choice is stated
 * on `TrafficTab`'s own `MESH_SECTIONS`.
 *
 * ## Every filter is in the URL, and that is structural rather than tidy
 *
 * The request says refresh must never reset the operator's namespace, status or time filters. A promise
 * like that kept in `useState` is one remount away from being broken — and this subtree *is* remounted,
 * by the sub-tab strip above it. Held in the URL it survives the remount, the reload, the Back button,
 * and it makes a filtered view something an operator can paste into an incident channel. `replace: true`
 * throughout, following `useUrlSection`: ticking a filter must not cost a Back press.
 *
 * ## What the controls actually do, stated once
 *
 *   - **Proxy namespace** narrows the rows to groups that a proxy in those namespaces logged. It does
 *     **not** narrow the read — see the long note on `namespaceOptions` below, and `PROXY_NAMESPACE_INFO`
 *     for the operator-facing version.
 *   - **Time range** is the one control that changes what is read: it is `sinceSeconds` on the request.
 *     Because each proxy is also capped at a line count, the range is a request and not a guarantee, so
 *     `coverageNote` prints the span actually covered whenever the two differ materially.
 *   - **Refresh** and **Retry** re-read. Nothing on this page writes to a cluster; `{fresh: true}` sets
 *     `cache-control: no-cache`, which is the whole of what they do.
 *
 * Read-only throughout, like the rest of this tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, DEFAULT_TRAFFIC_TAIL, type TrafficData, type TrafficErrorGroup } from '../../../api';
import { FilterBar, FilterSelect, SearchBox } from '../../../components/filters';
import { InfoPopover } from '../../../components/InfoPopover';
import { NamespaceFilter } from '../../../components/NamespaceFilter';
import { namespacesOf, resultLine } from '../../../components/namespace-filter';
import { useNamespaceSelection } from '../../../components/use-namespace-selection';
import { SubTabs, useUrlSection, type SubTab } from '../../../components/SubTabs';
import { Btn, Dot, ErrorState } from '../../../components/ui';import { UnavailableNotice, envelopeScope } from '../../../components/unavailable';
import { ago } from '../../../format';
import { useAsync } from '../../../useAsync';
import { accessLogEvidence } from '../access-log';
import {
  DATA_SOURCE_INFO,
  PROXY_NAMESPACE_INFO,
  TIME_RANGE_INFO,
  TRAFFIC_ERRORS_ABOUT,
  TRAFFIC_FAILURES_INFO
} from './explanations';
import { SkeletonBars, SkeletonRows } from './skeletons';
import {
  activeTrafficFilters,
  coverageNote,
  DEFAULT_TRAFFIC_FILTERS,
  filterGroups,
  methodOptions,
  sinceSecondsFor,
  TIME_RANGES,
  type StatusFilter,
  type TimeRangeId,
  type TrafficFilterState
} from './traffic-filters';
import { ErrorBreakdown } from './ErrorBreakdown';
import { ProxiesObserved } from './ProxiesObserved';
import { ResponseCodes } from './ResponseCodes';
import { TopPatterns } from './TopPatterns';
import { TrafficFailuresTable } from './TrafficFailuresTable';
import { TrafficMetrics } from './TrafficMetrics';
import { VisibilityWarning } from './VisibilityWarning';

/**
 * The three views, and the ids they keep.
 *
 * The **ids** are `failures`, `codes` and `window` because those are already `?section=` values in
 * `TAB_SECTIONS.traffic` — every existing deep link, and every Overview tile that names one, has to
 * keep landing where it did. The **labels** are the request's, which are better: "Proxies" says what
 * the view lists, where "Proxies read" reads as a count of something.
 *
 * `as const` so `PAGE_TABS[0].id` is a literal under `noUncheckedIndexedAccess`; the fallback is taken
 * from the list rather than repeated, for the same reason every other section strip does it — a
 * repeated literal drifts from the list it is supposed to match.
 */
const PAGE_TABS = [
  {
    id: 'failures',
    label: 'Traffic Failures',
    description: 'One row per distinct failure shape parsed from the proxy access logs in this window.'
  },
  {
    id: 'codes',
    label: 'Response Codes',
    description: 'Every response code in the window that was read, error and success alike.'
  },
  {
    id: 'window',
    label: 'Proxies',
    description: 'Which proxies were read, which were not, and which could not be.'
  }
] as const satisfies readonly SubTab<'failures' | 'codes' | 'window'>[];

type PageSection = (typeof PAGE_TABS)[number]['id'];

/**
 * How wide a tail to ask each proxy for. The server clamps to 1000 whatever arrives.
 *
 * This control is not in the request's filter bar, and keeping it is a deliberate addition rather than
 * an oversight. `coverageNote` can report "3 of the 10 proxies read returned a full 500-line tail, so
 * older records inside the range were not read" — and a page that says that while offering no way to
 * read further is worse than one that says nothing. It sits last in the bar because it is the only
 * control there that is about the *instrument* rather than about the traffic.
 */
const TAIL_CHOICES = [200, 300, 500, 1000] as const;

/**
 * Auto-refresh intervals. **Off is the default and that is not a placeholder.**
 *
 * Each tick is a real read of up to ten pod logs against a production cluster — four to seven seconds
 * of API-server work that nobody asked for the moment the operator walks away from the screen. So it
 * is opt-in, the cost is stated in the control's own tooltip, the interval is cleared on unmount, and
 * a tick is skipped while the browser tab is hidden (the same guard `useAsync`'s polling uses, and for
 * the same reason).
 *
 * Deliberately **not** in the URL, unlike every other control here. A shared link is opened by someone
 * who did not choose the setting, and a link that quietly starts reading a cluster every thirty seconds
 * on their behalf is not a link an operator should be able to send by accident.
 */
const AUTO_REFRESH = [
  { value: 'off', label: 'Off', ms: 0 },
  { value: '30s', label: '30 seconds', ms: 30_000 },
  { value: '1m', label: '1 minute', ms: 60_000 },
  { value: '5m', label: '5 minutes', ms: 300_000 }
] as const;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  // The labels are the operator's vocabulary; the values are the backend's `class`, never a band this
  // file derives from a number. See the note on STATUS in `traffic-filters.ts`.
  { value: 'server', label: '5xx server' },
  { value: 'client', label: '4xx client' },
  { value: 'no-response', label: 'No HTTP response' }
];

/** The URL keys. One place, so a reader can see the whole query string this page owns at a glance. */
const PARAM = { range: 'range', status: 'status', method: 'method', search: 'q', tail: 'tail', ns: 'ns' } as const;

/** Everything on the bar except the namespace set, which has its own hook and its own staleness rule. */
interface BarState {
  range: TimeRangeId;
  status: StatusFilter;
  method: string;
  search: string;
  tail: number;
}

/**
 * A URL value narrowed to something this page can honour, or the default.
 *
 * Every one of these falls back rather than trusting the string. The state arrives from a URL that a
 * person can hand-edit and a colleague can truncate in a chat client, and an unvalidated `?range=`
 * reaches the API server as `sinceSeconds=NaN` — which fails *every* proxy read and reports a
 * cluster-wide read failure for a typo in a query string.
 */
function readRange(raw: string | null): TimeRangeId {
  return TIME_RANGES.find(r => r.id === raw)?.id ?? DEFAULT_TRAFFIC_FILTERS.range;
}

function readStatus(raw: string | null): StatusFilter {
  return STATUS_OPTIONS.find(s => s.value === raw)?.value ?? DEFAULT_TRAFFIC_FILTERS.status;
}

function readTail(raw: string | null): number {
  const n = Number(raw);
  return TAIL_CHOICES.find(t => t === n) ?? DEFAULT_TRAFFIC_TAIL;
}

/**
 * The bar's state, read from and written to the URL.
 *
 * Writing a **default deletes the parameter** rather than spelling it out, following
 * `serializeNamespaceParam`: a default does not belong in a URL, and `?status=all` in a shared link
 * reads as a filter that was set and then broke. It also keeps one logical view to one URL string,
 * which is what makes two operators comparing links able to see that they are looking at the same thing.
 *
 * The returned object is memoised on the raw query string, not rebuilt per render, so the `useMemo`
 * over 430 groups downstream does not recompute every time something unrelated on the page re-renders.
 */
function useBarState(): [BarState, (patch: Partial<BarState>) => void] {
  const [params, setParams] = useSearchParams();
  const query = params.toString();

  const bar = useMemo<BarState>(() => {
    const p = new URLSearchParams(query);
    return {
      range: readRange(p.get(PARAM.range)),
      status: readStatus(p.get(PARAM.status)),
      method: p.get(PARAM.method) ?? DEFAULT_TRAFFIC_FILTERS.method,
      search: p.get(PARAM.search) ?? DEFAULT_TRAFFIC_FILTERS.search,
      tail: readTail(p.get(PARAM.tail))
    };
  }, [query]);

  const patch = useCallback(
    (next: Partial<BarState>) => {
      setParams(
        prev => {
          const p = new URLSearchParams(prev);
          const write = (key: string, value: string, isDefault: boolean) => {
            if (isDefault) p.delete(key);
            else p.set(key, value);
          };
          if (next.range !== undefined) write(PARAM.range, next.range, next.range === DEFAULT_TRAFFIC_FILTERS.range);
          if (next.status !== undefined) write(PARAM.status, next.status, next.status === DEFAULT_TRAFFIC_FILTERS.status);
          if (next.method !== undefined) write(PARAM.method, next.method, next.method === DEFAULT_TRAFFIC_FILTERS.method);
          if (next.search !== undefined) write(PARAM.search, next.search, next.search.trim().length === 0);
          if (next.tail !== undefined) write(PARAM.tail, String(next.tail), next.tail === DEFAULT_TRAFFIC_TAIL);
          return p;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  return [bar, patch];
}

/**
 * Re-render on a timer, so "Last updated 4m ago" is true rather than true-at-mount.
 *
 * Thirty seconds, which is the resolution `ago` has anyway below the hour — a faster tick would
 * re-render the page to print the same words. The interval is cleared on unmount; it holds no state of
 * its own beyond a counter nothing reads, which is exactly what forcing a re-render needs.
 */
function useClockTick(ms = 30_000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/**
 * The proxy that reported the most of what is currently on screen.
 *
 * The footer offers one jump into the raw log lines, and it has to be a *defensible* one: an operator
 * who clicks "open raw lines" and lands on a proxy that contributed four of the two thousand records in
 * view has been sent to the wrong pod. The busiest reporter is the one whose buffer most likely still
 * holds the lines behind the numbers above, and "most of what you are looking at came from here" is a
 * sentence the button can honestly put in its own tooltip.
 *
 * Ties break on the pod name so the control does not point somewhere different on each re-render.
 */
function busiestProxy(
  groups: readonly TrafficErrorGroup[]
): { namespace: string; pod: string; container: string; count: number } | null {
  const byPod = new Map<string, { namespace: string; pod: string; container: string; count: number }>();
  for (const g of groups) {
    for (const p of g.proxies) {
      const k = `${p.namespace}/${p.pod}`;
      const seen = byPod.get(k);
      if (seen) seen.count += p.count;
      else byPod.set(k, { namespace: p.namespace, pod: p.pod, container: p.container, count: p.count });
    }
  }
  return [...byPod.values()].sort((a, b) => b.count - a.count || a.pod.localeCompare(b.pod))[0] ?? null;
}

export function TrafficErrorsPage({
  id,
  onViewLogs
}: {
  id: string;
  /** Jump into the Live Pod Logs tab on a proxy, so the lines behind a count can be read as lines. */
  onViewLogs?: (namespace: string, pod: string, container?: string | null, opts?: { previous?: boolean }) => void;
}): JSX.Element {
  const [bar, setBar] = useBarState();
  /*
    `?section=` — the same key the tab's own strip reads, deliberately, rather than a second one.

    `failures`, `codes` and `window` are already `?section=` values in `TAB_SECTIONS.traffic`: every
    existing deep link and every Overview tile that names one has to keep landing where it did. So the
    tab treats all three as "show the Traffic Errors page" and this strip reads the same parameter to
    decide which of its three views that means. One URL string, one place, and the two strips cannot
    disagree about where the page is.
  */
  const [section, setSection] = useUrlSection<PageSection>('section', PAGE_TABS, PAGE_TABS[0].id);
  const [auto, setAuto] = useState<(typeof AUTO_REFRESH)[number]['value']>('off');
  useClockTick();

  /**
   * Whether the *next* read is a person asking, rather than a mount or a key change.
   *
   * The server keeps its answer for a few seconds so that arriving on this page does not cost ten
   * pod-log reads every time — but Refresh promises "read the proxies again", and a control that can be
   * served a cached copy is a control that lies. A ref rather than state on purpose: flipping it must
   * not re-render, and it has to be readable by the fetcher `useAsync` already holds rather than
   * changing that fetcher's identity, which would refetch on its own and defeat the whole thing.
   */
  const wantsFreshRead = useRef(false);

  const sinceSeconds = sinceSecondsFor({ ...DEFAULT_TRAFFIC_FILTERS, range: bar.range });

  /*
    A primitive key, never the fetcher: `useAsync` refetches on the key, and passing the closure itself
    either never refetches or loops. The cluster, the tail width and the time range all belong in it,
    because a change to any one of them means the payload in hand describes a different read — and
    `sinceSeconds` in particular is the one an operator changes expecting new data.

    `namespace` is deliberately NOT sent, and therefore not in the key. See `namespaceOptions` below.
  */
  const { data, loading, error, reload, fetchedAt } = useAsync(
    useCallback(() => {
      const fresh = wantsFreshRead.current;
      wantsFreshRead.current = false;
      return api.clusterTrafficErrors(id, { tailLines: bar.tail, sinceSeconds }, { fresh });
    }, [id, bar.tail, sinceSeconds]),
    0,
    `${id}:${bar.tail}:${sinceSeconds}`
  );

  /** Refresh and Retry. Both re-read the proxies; neither changes anything in the cluster. */
  const refresh = useCallback(() => {
    wantsFreshRead.current = true;
    reload();
  }, [reload]);

  useEffect(() => {
    const ms = AUTO_REFRESH.find(o => o.value === auto)?.ms ?? 0;
    if (!ms) return;
    const t = setInterval(() => {
      // A hidden browser tab must not keep tailing ten pod logs for nobody — the same guard
      // `useAsync`'s own polling applies, and the reason auto-refresh is safe to offer at all.
      if (document.visibilityState === 'visible') refresh();
    }, ms);
    return () => clearInterval(t);
  }, [auto, refresh]);

  const payload: TrafficData | undefined = data?.ok ? data.data : undefined;  const scope = useMemo(() => envelopeScope(id, payload?.summary), [payload?.summary, id]);
  const groups = payload?.errors ?? [];

  /**
   * The namespaces this control can offer: the namespaces of the proxies that **logged** the records.
   *
   * Derived from the payload with `namespacesOf`, never from a list — a hardcoded set goes stale the
   * first time a team creates a namespace, and `test/fleet/namespace-filter-standard.test.js` fails the
   * build on a second opinion about what "the namespaces present" means.
   *
   * `proxies[].namespace` rather than `sources[].namespace`, and rather than the `namespace` query
   * parameter, for three separate reasons:
   *
   *  1. A failure group has **no namespace of its own** — absent on all 430 groups of the live window.
   *     `sources[].namespace` is the *client's* and is non-null on 1 of 430; the rest is external
   *     internet traffic. An option list built from it would have one entry and explain nothing.
   *  2. The route's `?namespace=` parameter scopes **which proxies get tailed**, not which rows come
   *     back. It is also single-valued, while this control is a multi-select, so a two-namespace
   *     selection cannot be expressed as a request at all.
   *  3. Sending it anyway would be a dead end for the operator: the options are derived from the
   *     proxies in the response, so scoping the read to one namespace removes every other namespace
   *     from the very list the control offers, and there is then no way back to a different one. It
   *     would also make the fetch path depend on a value narrowed against the payload that fetch
   *     returns, which is a refetch loop waiting for the first stale link to arrive.
   *
   * So the selection is applied where it can be applied honestly — over the groups in hand, by
   * `filterGroups`, with group-level OR across `proxies[]` — and the control says so in its own ⓘ.
   */
  const namespaceOptions = useMemo(
    () => namespacesOf(groups.flatMap(g => g.proxies), p => p.namespace),
    [groups]
  );
  const [namespaces, setNamespaces] = useNamespaceSelection(PARAM.ns, namespaceOptions);

  const state: TrafficFilterState = useMemo(
    () => ({ namespaces, range: bar.range, status: bar.status, method: bar.method, search: bar.search }),
    [namespaces, bar.range, bar.status, bar.method, bar.search]
  );

  const rows = useMemo(() => filterGroups(groups, state), [groups, state]);

  /**
   * The METHOD options, plus the current value when it is not among them.
   *
   * `methodOptions` offers only the verbs actually observed, which is right: a dropdown offering PATCH
   * on a cluster where no PATCH was logged invites the operator to select it, see an empty table, and
   * conclude there are no PATCH failures. But a `<select>` whose value matches no option silently
   * displays the *first* one instead, so a shared link carrying `?method=PATCH` would show "all
   * methods" over a table filtered to PATCH — a control lying about its own state. Keeping the value as
   * a labelled entry is the honest fix, and it keeps the link working.
   */
  const methodChoices = useMemo(() => {
    const observed = methodOptions(groups);
    const options = observed.map(m => ({ value: m, label: m === 'all' ? 'All methods' : m }));
    if (bar.method !== DEFAULT_TRAFFIC_FILTERS.method && !observed.includes(bar.method)) {
      options.push({ value: bar.method, label: `${bar.method} — not observed` });
    }
    return options;
  }, [groups, bar.method]);

  /**
   * How many filters Clear filters would clear.
   *
   * `activeTrafficFilters` counts the five the request names; the tail is added here because this page
   * added the control. The two halves have to agree with `clear` below — a badge counting a filter the
   * button does not reset, and a button resetting a filter the badge never counted, are the same bug
   * seen from two sides.
   */
  const activeCount = activeTrafficFilters(state) + (bar.tail === DEFAULT_TRAFFIC_TAIL ? 0 : 1);

  const clear = useCallback(() => {
    setNamespaces(new Set());
    setBar({
      range: DEFAULT_TRAFFIC_FILTERS.range,
      status: DEFAULT_TRAFFIC_FILTERS.status,
      method: DEFAULT_TRAFFIC_FILTERS.method,
      search: DEFAULT_TRAFFIC_FILTERS.search,
      tail: DEFAULT_TRAFFIC_TAIL
    });
  }, [setNamespaces, setBar]);

  /**
   * What a click on a metric tile or a breakdown bar does.
   *
   * It sets the same filters a person would set by hand, so what lands is a state the operator can see
   * and undo rather than a hidden pre-filter — and it moves to the failures view, because the rows are
   * the answer to "what is behind that number".
   *
   * `code: 0` filters by **status, not by text**. `String(0)` as a needle matches every path and every
   * code containing a zero, which on this cluster is most of them; the `no-response` class is what
   * actually means "no HTTP response".
   */
  const pickStatus = useCallback(
    (next: StatusFilter) => {
      setBar({ status: next });
      setSection('failures');
    },
    [setBar, setSection]
  );

  const pickCode = useCallback(
    (code: number) => {
      if (code === 0) setBar({ status: 'no-response', search: '' });
      else setBar({ status: 'all', search: String(code) });
      setSection('failures');
    },
    [setBar, setSection]
  );

  /**
   * A click on a top pattern.
   *
   * The most specific text the group carries, plus its class — which together narrow the table to that
   * pattern and a handful of near neighbours. Deliberately not an exact row selection: the table owns
   * which row is expanded, and reaching into it from here would give the page two opinions about what
   * is selected.
   */
  const pickPattern = useCallback(
    (g: TrafficErrorGroup) => {
      setBar({ status: g.class, search: g.path ?? g.authority ?? String(g.code) });
      setSection('failures');
    },
    [setBar, setSection]
  );

  const w = payload?.window;
  const log = payload?.accessLog;

  /*
    The three states this page is drawn through — nothing was read, nothing was proved, or a real
    measurement. Computed in `access-log.ts` because the Observability tab reads the same payload and
    must reach the same verdict from it; see that module for what each one means.
  */
  const { readsSkipped, unprovenZero, noEvidence } = accessLogEvidence(log, w);

  const coverage = coverageNote(w, state);
  const firstLoad = loading && !payload;
  const busiest = useMemo(() => busiestProxy(rows), [rows]);

  /**
   * The tab counts, and what each one is counting.
   *
   * **Traffic Failures** is the *filtered* group count, because it sits beside a filter bar and an
   * operator reads it as "how many rows are below". **Proxies** is `proxyCandidates` — every pod with an
   * `istio-proxy` container that this read could have chosen — not `proxiesRead`, because the view
   * behind it is about the gap between those two numbers. **Response Codes** carries no count on
   * purpose: the honest number there would be "how many distinct codes", which nobody asks.
   *
   * `null` rather than `0` whenever nothing was read. A `0` on a tab label is a claim that something
   * looked and found nothing, and it would contradict the banner directly above it.
   */
  const counts: Partial<Record<PageSection, number | null>> = {
    failures: !payload || noEvidence ? null : rows.length,
    window: readsSkipped ? null : (w?.proxyCandidates ?? null)
  };

  return (
    <div className="flex flex-col gap-4 pb-8">
      {/* ------------------------------------------------------------------ §2 page header */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1 text-[16px] font-semibold text-text">
            Traffic Errors
            <InfoPopover content={TRAFFIC_ERRORS_ABOUT} ariaLabel="About Traffic Errors and what proxy access logs can show" />
          </h2>
          <p className="mt-0.5 max-w-[78ch] text-[13px] text-muted">
            Investigate HTTP errors and requests without an HTTP response captured by Istio proxy access
            logs.
          </p>
        </div>

        {/* Last updated, then the two controls that act on it. Grouped, because "how old is this" and
            "read it again" are one thought and separating them makes the operator hunt for the second. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">
            {fetchedAt === null ? (
              'Not read yet'
            ) : (
              <>
                Last updated {ago(new Date(fetchedAt).toISOString())}
                {/* A refresh over data already on screen. Subtle by design: the page keeps its content
                    and says it is re-reading, rather than blanking and losing the operator's place. */}
                {loading && <span className="ml-1.5 text-muted/80">— re-reading…</span>}
                {/*
                  `useAsync` deliberately keeps the last good payload when a read throws, which is the
                  right call — thirty-second-stale data beats a blank page. But it is only right if the
                  page says so. Without this, a lapsed session or a refused read leaves the previous
                  window on screen indefinitely while "Last updated" ages, and every number above reads
                  as current. The banner below covers a *failed* page; this covers a failed *refresh*.
                */}
                {!loading && error && (
                  <span className="ml-1.5 text-warn">— the last read failed; showing the previous window</span>
                )}
              </>
            )}
          </span>
          <Btn
            onClick={refresh}
            disabled={loading}
            title="Read the proxy logs again. A log window moves, so a refresh shows a different set of records. This re-reads only; nothing in the cluster is changed."
          >
            ↻ Refresh
          </Btn>
          <FilterSelect
            label="Auto-refresh"
            value={auto}
            options={AUTO_REFRESH.map(o => ({ value: o.value, label: o.label }))}
            onChange={v => setAuto((AUTO_REFRESH.find(o => o.value === v)?.value ?? 'off'))}
          />
        </div>
      </div>

      {/* ------------------------------------------------------------------ §3 global filter bar */}
      <div>
        <FilterBar
          activeCount={activeCount}
          onReset={clear}
          resultLine={
            // "N of M", never a bare number: a count that shrank silently is indistinguishable from a
            // read that returned less, which is the failure this console exists to avoid.
            payload ? resultLine(rows.length, groups.length, groups.length === 1 ? 'failure' : 'failures') : null
          }
        >
          <span className="inline-flex items-center gap-1">
            {/* "Proxy namespace", not "Namespace": what is selected is the namespace of the proxy that
                *reported* the record, because a failure group carries no namespace of its own. The label
                and the ⓘ both say so — see PROXY_NAMESPACE_INFO. */}
            <NamespaceFilter
              label="Proxy namespace"
              options={namespaceOptions}
              selected={namespaces}
              onChange={setNamespaces}
            />
            <InfoPopover content={PROXY_NAMESPACE_INFO} ariaLabel="Explain the proxy namespace filter" />
          </span>
          <span className="inline-flex items-center gap-1">
            <FilterSelect
              label="Time range"
              value={bar.range}
              options={TIME_RANGES.map(r => ({ value: r.id, label: r.label }))}
              onChange={v => setBar({ range: readRange(v) })}
            />
            <InfoPopover content={TIME_RANGE_INFO} ariaLabel="Explain the time range and what it actually reads" />
          </span>
          <FilterSelect
            label="Status"
            value={bar.status}
            options={STATUS_OPTIONS}
            onChange={v => setBar({ status: readStatus(v) })}
          />
          <FilterSelect label="Method" value={bar.method} options={methodChoices} onChange={v => setBar({ method: v })} />
          <SearchBox
            value={bar.search}
            onChange={v => setBar({ search: v })}
            placeholder="Path, host, code, flag, request id…"
          />
          <FilterSelect
            label="Lines per proxy"
            value={String(bar.tail)}
            options={TAIL_CHOICES.map(n => ({ value: String(n), label: `${n} lines` }))}
            onChange={v => setBar({ tail: readTail(v) })}
          />
        </FilterBar>

        {/* The span actually covered, whenever it is materially shorter than the range that was asked
            for. Beside the control rather than in its tooltip: a chip reading "Last 24 hours" over a
            13-hour read is precisely the kind of quiet over-promise this console exists to prevent. */}
        {coverage && (
          <p className="flex items-baseline gap-2 text-[12px] text-muted">
            <Dot tone="warn" />
            <span>{coverage}</span>
          </p>
        )}
      </div>

      <UnavailableNotice scope={scope} />

      {/* ------------------------------------------------- the access-log verdict, before any count */}
      {/*
        This fires on "this page cannot see the requests", which is wider than "logging is off" in two
        directions: a mesh pointed at an off-pod sink is `state: 'on'` and shows nothing here, and a
        provider that resolved to nothing leaves `readable: null`, so the read is rightly not skipped but
        the zero it produces is still unproven. Above the numbers on purpose — an operator who reads a
        strip of zeros before reading this has already drawn the wrong conclusion.
      */}
      {log && (log.state !== 'on' || noEvidence) && (
        <div className="rounded-[8px] border border-warn/40 bg-warn/5 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <Dot tone={log.state === 'unknown' ? 'unknown' : 'warn'} />
            <span className="text-[13px] font-semibold text-text">
              {readsSkipped
                ? 'The access log does not reach this page'
                : unprovenZero
                  ? 'No request line came back, and this page cannot prove one should have'
                  : log.state === 'off'
                    ? 'Envoy access logging is off'
                    : 'Access logging state is unknown'}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-muted">{log.why}</p>
          {noEvidence && (
            <p className="mt-1 text-[13px] text-muted">
              Every count below reads as "not read" rather than as zero.{' '}
              {log.recordedElsewhere
                ? 'The requests are being recorded — open the destination named under Proxies to see them.'
                : 'Nothing is recording these requests, here or anywhere else.'}
            </p>
          )}
          {log.decidedBy.length > 0 && (
            <p className="mono mt-1 text-[12px] text-muted/80">
              Decided by {log.decidedBy.map(d => `${d.namespace}/${d.name}`).join(', ')}
            </p>
          )}
        </div>
      )}

      {/* §16 — 10 of 41 proxies read is genuinely partial visibility, and it is stated where the
          numbers are rather than only on the view that lists the proxies. */}
      <VisibilityWarning window={w} />

      {/* ------------------------------------------------------------------ §19 error state */}
      {/*
        The read failed. The four-part template is the console's one error shape — title, what it means,
        what to do, and the backend's own words verbatim — so this surface uses it rather than inventing
        a fifth style, and a bare error code is never rendered. Retry is a data re-read and says so.

        Rendered *in place of* the page's body, but below the header and filter bar, which stay usable:
        the most common fix for a failed read on this page is a narrower range, and blanking the controls
        would take that away.

        The condition covers **both** ways a read fails, which is not the same test. `data && !data.ok`
        is the envelope saying the cluster refused — but when the request itself throws (a lapsed SSO
        session, a 502 from the approuter, a dropped connection) `useAsync` sets `error` and leaves
        `data` null. Testing only the envelope sent that case into the success branch, where every
        `payload?.…` is `undefined` and the page rendered a confident empty window: zero failures, no
        proxies, "no records matched". A failed read must never be drawn as an answer.
      */}
      {(data && !data.ok) || (error && !payload) ? (
        <div className="rounded-[8px] border border-line bg-raised">
          {/* `.panel-head` rather than a hand-written gutter: one token owns the inline inset of every
              divider header in this console, and `layout-alignment.test.ts` fails a second opinion. */}
          <h3 className="panel-head border-b border-line py-3 text-[14px] font-semibold uppercase tracking-[0.04em] text-text">
            Unable to load traffic data
          </h3>
          {/*
            The envelope's own error wins when there is one: it is the cluster's words about the cluster,
            and it carries `needsReseed`, which decides whether the operator's next step is a new token
            or a narrower range. The thrown `ApiError` is the fallback — it has a code and a message but
            no `needsReseed`, because a transport failure says nothing about the credential.
          */}
          <ErrorState
            cluster={id}
            code={data?.error?.code ?? error?.code ?? 'UNKNOWN'}
            message={data?.error?.message ?? error?.message ?? 'this cluster did not answer'}
            needsReseed={data?.error?.needsReseed}
          />
          <div className="panel-head flex flex-wrap items-center gap-x-4 gap-y-2 pb-6">
            <Btn
              variant="primary"
              onClick={refresh}
              disabled={loading}
              title="Read the proxy logs again. This is a read; nothing in the cluster is created, changed or deleted."
            >
              Retry
            </Btn>
            <span className="text-[12px] text-muted">
              Data source <span className="text-text">Istio proxy access logs</span>
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* --------------------------------------------------------- §4 the four counts + logging */}
          <TrafficMetrics summary={payload?.summary} accessLog={log} loading={firstLoad} onPickStatus={pickStatus} />

          {/* --------------------------------------------------------- §5 error breakdown */}
          <ErrorBreakdown byCode={payload?.summary.byCode} loading={firstLoad} onPickCode={pickCode} />

          {/* --------------------------------------------------------- §7 the three views */}
          <div>
            <h2 className="flex items-center gap-1 text-[14px] font-semibold uppercase tracking-[0.04em] text-text">
              Traffic failures
              <InfoPopover content={TRAFFIC_FAILURES_INFO} ariaLabel="Explain what a traffic failure row counts" />
            </h2>
            {/*
              The strip switches the view; the filter bar above stays in force across all three. The
              request draws Search, Status and Method again at this level — they are deliberately not
              repeated here, because two controls bound to one piece of state is the drift this console
              spends its comments avoiding, and the bar is already on screen. The table's own column
              picker is the one control that belongs to the table and lives with it.
            */}
            <SubTabs sections={PAGE_TABS} active={section} onSelect={setSection} counts={counts} className="mt-2" />

            {section === 'failures' && <TrafficFailuresTable groups={rows} total={groups.length} loading={firstLoad} />}

            {section === 'codes' &&
              (firstLoad ? <SkeletonBars rows={6} /> : <ResponseCodes summary={payload?.summary} onPickCode={pickCode} />)}

            {section === 'window' &&
              (firstLoad ? <SkeletonRows rows={6} /> : <ProxiesObserved groups={groups} window={w} />)}
          </div>

          {/* --------------------------------------------------------- the optional pattern roll-up */}
          {section === 'failures' && !firstLoad && rows.length > 0 && <TopPatterns groups={rows} onPick={pickPattern} />}
        </>
      )}

      {/* ------------------------------------------------------------------ §29 footer: provenance */}
      {/*
        The same statement as the header's ⓘ, at the bottom, where a reader who scrolled through the
        numbers arrives holding "where did this come from". The links are the shared `SOURCES` registry —
        official Istio documentation only, so a disagreement about what a field means is settled by the
        project that writes the field rather than by this console.
      */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-line pt-3 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="font-semibold uppercase tracking-[0.06em]">Data source</span>
          <InfoPopover content={DATA_SOURCE_INFO} ariaLabel="Explain where every number on this page comes from" />
        </span>
        <span className="text-text">Istio / Envoy proxy access logs</span>
        <span aria-hidden="true">·</span>
        <span>
          read from up to ten istio-proxy containers, {bar.tail} lines each
          {w && !readsSkipped ? `, ${w.requestsParsed.toLocaleString()} request records parsed` : ''}
        </span>
        {onViewLogs && busiest && (
          <button
            type="button"
            onClick={() => onViewLogs(busiest.namespace, busiest.pod, busiest.container)}
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-raised px-2 py-[2px] text-[12px] text-text hover:border-line-strong"
            title={`Open the Live Pod Logs tab on ${busiest.namespace}/${busiest.pod}, the proxy that reported ${busiest.count.toLocaleString()} of the records currently in view. The lines this page parsed are the lines that pod logged.`}
          >
            Open raw lines
            <span className="mono text-muted">
              {busiest.namespace}/{busiest.pod}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
