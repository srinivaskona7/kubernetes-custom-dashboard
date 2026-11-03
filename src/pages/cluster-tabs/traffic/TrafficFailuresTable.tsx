/**
 * Ingress & Traffic → the mesh-wide failure table.
 *
 * ## What one row is
 *
 * A **group**, not a log line. `data.errors` arrives already grouped by the collector on
 * `response_code + method + path + authority + upstream`, with a `key` and a `count` per group — 430
 * groups over 2313 failing records on the reference cluster. §9's "do not display hundreds of
 * identical raw log entries separately" is therefore satisfied by the payload, and this component
 * **must not group again**: a second client-side pass over an already-grouped list can only merge rows
 * the collector deliberately kept apart, and the `count` it would have to recompute is the one number
 * on the row an operator acts on.
 *
 * ## Three columns the request asked for that the wire cannot answer
 *
 * Measured over all 430 groups of `/traffic-errors?tailLines=500` on the reference cluster
 * (2026-09-21, live measurement, not inference):
 *
 *   - **No NAMESPACE column.** A failure group has no namespace field. The two nearby namespaces are
 *     the *client's* (`sources[].namespace`, non-null in 1 of 430) and the namespace of the proxy that
 *     *logged* it (always `istio-system`), and neither is what a column headed Namespace implies. A
 *     column that is `—` in 429 of 430 rows teaches the operator to stop reading the row, so the slot
 *     is spent on **Client** instead — which is the question they were actually asking. Both
 *     namespaces are named in the expanded details, where there is room to say which is which.
 *   - **UPSTREAM is empty, so the column is SERVED BY.** `upstream` is non-null in 1 of 430 groups;
 *     `gateway` in 381. The column reads `gateway` first and falls back to `upstream`, and `upstream`
 *     is still printed in the details so nothing is hidden by the rename.
 *   - **ROUTE is not on the wire at all** — the field is absent, not null. It has no row in the
 *     details either: "Route —" claims a field exists and is empty, which is a different statement.
 *
 * ## "Not routed" comes from a flag, never from an empty column
 *
 * §5 and §11 forbid inferring a cause. An absent `upstream` is not evidence that Envoy refused to
 * route — under an OpenTelemetry-labelled access log the field does not exist at all. So **Not routed
 * is rendered only when `responseFlags` contains `NR`** (2 of 430 groups). When nothing served the
 * request and no flag says why, the cell is `—` and says so. The same rule governs the status phrase:
 * `403 + NR` may read "Not routed"; a bare `403` stays "HTTP 403 response".
 *
 * `class` is the collector's own verdict and is authoritative. Nothing here re-derives a class from
 * the digits of a code.
 *
 * ## The measured column budget
 *
 * `.tbl tbody td` is `padding: 10px 16px` with the outer edges zeroed, so **padding = N*32 − 32**. The
 * container on this tab at a 1440px viewport with the rail expanded measures **1090px** (1405px with
 * it collapsed). `wide` sheds priority 3 below a 1300px container and priority 2 below 1000px, so at
 * 1090 priority 3 is **already shed** — which is what the budget below is built around:
 *
 *   | shown at 1090 | Status 128 · Count 64 · Method 68 · Path 208 · Host 152 · Served by 148 · Client 130 |
 *   |---------------|-------------------------------------------------------------------------------------|
 *   | content       | 898px                                                                               |
 *   | padding       | 7*32 − 32 = 192px                                                                   |
 *   | total         | **1090px — the container exactly**                                                  |
 *
 * Destination is the eighth column at priority 3 and `max: '140px'`: 1038 + 224 = 1262px, which fits
 * the 1405px container an operator gets by collapsing the rail, and is shed at 1090. That is the right
 * column to lose, and it is the only one that would be — it is populated in **1 of 430** groups, and
 * its value is in the details for every row. Client is the single priority-2 column: below a 1000px
 * container the six that remain measure 768 + 160 = 928px, so the table still fits rather than
 * clipping. Re-measure rather than re-adding these up: `max` is a ceiling, not a reservation, so a
 * column only claims it when its longest row needs it.
 */
import { useMemo, useRef, useState } from 'react';
import type { TrafficErrorGroup } from '../../../api';
import { endpointLabel } from './endpoint-label';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { InfoPopover, type InfoPopoverContent } from '../../../components/InfoPopover';
import { Field, Section } from '../../../components/layout';
import { ResourceLink } from '../../../components/ResourceLink';
import {
  DEFAULT_PAGE_SIZE,
  countLabel,
  nextSort,
  paginate,
  rowsFingerprint,
  sortRows,
  type SortDir,
  type SortState
} from '../../../components/table/pagination';
import { PageControl } from '../../../components/table/PageControl';
import { COLUMN_INFO } from '../../../components/table/column-info';
import { Dot, Empty, Pill, type Tone } from '../../../components/ui';
import { ago } from '../../../format';

/** Count, descending — §8's default, and the order the collector already ranks its groups in. */
const DEFAULT_SORT: SortState = { key: 'count', dir: 'desc' };

/**
 * The badge beside the status code, taken from `class` and never from the code's digits.
 *
 * `no response` rather than a number, because `response_code: 0` is a connection Envoy never answered
 * and calling it `0xx` would invent an HTTP class that does not exist.
 */
const CLASS_BADGE: Record<TrafficErrorGroup['class'], string> = {
  server: '5xx',
  client: '4xx',
  'no-response': 'no response'
};

const CLASS_TONE: Record<TrafficErrorGroup['class'], Tone> = {
  server: 'bad',
  client: 'warn',
  // Neutral, not red. On the reference cluster 1808 of 2313 failing records are unanswered
  // connections, and painting the largest bucket red makes a working mesh look on fire.
  'no-response': 'unknown'
};

const CLASS_WHY: Record<TrafficErrorGroup['class'], string> = {
  server:
    '5xx — the upstream answered with a server error, or Envoy could not reach it. The workload is the place to look.',
  client:
    '4xx — the request was rejected. Often the caller, but a 403 from an AuthorizationPolicy and a 404 from a missing route are cluster configuration.',
  'no-response':
    'Envoy recorded response_code 0: the connection produced no HTTP response at all. A client that hung up, a TLS handshake that failed, or a health probe closing early — not an HTTP error.'
};

/**
 * Envoy's response flags, decoded — and only ever read from `responseFlags`.
 *
 * §11 in one sentence: the explanation belongs to the flag, not to the code. `403` alone is "HTTP 403
 * response"; `403` with `NR` beside it is "Not routed", because the proxy said so. Three of these were
 * observed live (`DC`, `DPE`, `NR`); the rest are the ones this tab's own tooltips already name, so a
 * flag an operator sees here is explained here.
 */
const FLAG_MEANING: Record<string, string> = {
  NR: 'No route configured — nothing in the mesh matched this host and path, so Envoy never chose an upstream.',
  UF: 'Upstream connection failure — Envoy reached for the upstream and the connection itself failed.',
  UO: 'Upstream overflow — a circuit breaker was open, so Envoy shed the request rather than forwarding it.',
  UH: 'No healthy upstream — the cluster existed and every endpoint in it was failing its health check.',
  URX: 'Retry limit reached — Envoy retried this request as configured and ran out of attempts.',
  UT: 'Upstream timeout — the upstream did not answer inside the route timeout.',
  UAEX: 'Denied by an external authorization filter — an ext_authz call refused the request.',
  DC: 'Downstream disconnect — the client hung up before the response was written. People closing tabs produce this.',
  DPE: 'Downstream protocol error — the client sent something Envoy could not parse as HTTP. Scanners produce this constantly.',
  LH: 'Local service failed the health check request.',
  RL: 'Rate limited locally, before the request reached the upstream.'
};

/**
 * The two sentences that distinguish "the proxy said it was not routed" from "nothing on this record
 * says anything". Reused verbatim from `TrafficTab.tsx`'s existing pair rather than re-worded: a third
 * variant of the same distinction is how a console ends up meaning three things by one em-dash.
 */
const NOT_ROUTED_TITLE =
  'Envoy recorded no upstream cluster for this request — it was rejected before routing, at the listener or by a policy.';
const NO_UPSTREAM_TITLE =
  'Envoy recorded no upstream for this request and no response flag explaining it.';

/* ------------------------------------------------------------------ the four-part explanations (§12) */

const FAILURES_INFO: InfoPopoverContent = {
  title: 'Traffic failures',
  means:
    'Every 4xx, 5xx and unanswered connection the proxies reported, grouped so that one row is one failure shape rather than one log line. The count is how many records fell into that shape.',
  source: (
    <>
      Envoy access-log records from up to ten <span className="mono">istio-proxy</span> containers,
      grouped by the collector on code, method, path, host and upstream.
    </>
  ),
  limitations: [
    'A bounded tail of the log, so every count is "of the lines that were read" and none of them is a rate — a tail has no denominator.',
    'A group only exists if a proxy that was read logged it. Requests handled entirely by proxies outside the sweep are absent, not zero.'
  ],
  sources: ['accessLog']
};

const SERVED_BY_INFO: InfoPopoverContent = {
  title: 'Served by, and upstream',
  means:
    'Which side of the mesh answered: the Gateway that admitted the request where one is recorded, otherwise the upstream cluster Envoy chose.',
  source: (
    <>
      <span className="mono">gateway</span> is resolved from the Gateway objects that publish this
      host; <span className="mono">upstream</span> is Envoy&rsquo;s own{' '}
      <span className="mono">upstream_cluster</span>, verbatim.
    </>
  ),
  limitations: [
    'upstream_cluster is populated on 1 of the 430 groups this cluster returns, which is why the column reads the gateway first.',
    'An OpenTelemetry-labelled access log carries no upstream_cluster at all, so an empty value there is a missing field rather than an unrouted request.'
  ],
  sources: ['accessLog', 'networkIssues']
};

const NOT_ROUTED_INFO: InfoPopoverContent = {
  title: 'Not routed',
  means: (
    <>
      Envoy matched no route for this request. Shown only when the record carries the{' '}
      <span className="mono">NR</span> response flag — the proxy&rsquo;s own statement, not an
      inference from an empty upstream column.
    </>
  ),
  source: (
    <>
      <span className="mono">response_flags</span> containing <span className="mono">NR</span>.
    </>
  ),
  limitations: [
    'A request can fail before routing without NR being set, in which case this console says nothing about why rather than guessing.'
  ],
  sources: ['networkIssues']
};

const FLAGS_INFO: InfoPopoverContent = {
  title: 'Response flags',
  means:
    "Envoy's own short codes for what it did with the connection. They are the field that separates a 503 the upstream returned from a 503 Envoy produced because it had nothing healthy to ask.",
  source: (
    <>
      <span className="mono">response_flags</span> on the access-log record, decoded against this
      build&rsquo;s table of flags.
    </>
  ),
  limitations: [
    'Only 2 of the 430 groups on this cluster carry any flag, so an empty list is the normal case and not a gap.',
    'A flag this build cannot name is shown as its letters rather than guessed at — Envoy can emit flags newer than this console.'
  ],
  sources: ['accessLog']
};

/* ----------------------------------------------------------------------------------- cell vocabulary */

/**
 * How an address should read. `unresolved` is a gap rather than a fault: the address was genuinely
 * seen, and what is missing is this console's ability to name it.
 */
function endpointTone(kind: string): Tone {
  if (kind === 'unresolved') return 'unknown';
  if (kind === 'external') return 'accent';
  return 'ok';
}

/** What §11 allows this row's status to be called. A flag may name a cause; a code may not. */
function statusPhrase(g: TrafficErrorGroup): string {
  if (g.responseFlags.includes('NR')) return 'Not routed';
  if (g.code === 0) return 'No HTTP response';
  return `HTTP ${g.code} response`;
}

/**
 * What answered, as a four-way verdict rather than a string, so the cell, its tooltip and the sort all
 * read the same decision. The `not-routed` case is reachable only from the flag; see the file header.
 */
type Served =
  | { kind: 'gateway' | 'upstream'; text: string; why: string }
  | { kind: 'not-routed' }
  | { kind: 'unknown' };

function servedBy(g: TrafficErrorGroup): Served {
  if (g.gateway) {
    const port = g.gateway.port ? `:${g.gateway.port}` : '';
    return {
      kind: 'gateway',
      text: `${g.gateway.namespace}/${g.gateway.name}${port}`,
      why: `Gateway ${g.gateway.namespace}/${g.gateway.name} admits ${g.gateway.host} — ${g.gateway.evidence}`
    };
  }
  const u = g.upstream;
  if (u) {
    if (u.service) {
      const port = u.port ? `:${u.port}` : '';
      return {
        kind: 'upstream',
        text: `${u.service.namespace}/${u.service.name}${port}`,
        why: `${u.raw} — ${u.service.evidence}`
      };
    }
    return {
      kind: 'upstream',
      text: u.fqdn ?? u.raw,
      why: u.fqdn
        ? `${u.raw} — no Service in this cluster reports the FQDN ${u.fqdn}. A Service is matched on the full FQDN Envoy emitted, never on a bare name.`
        : `${u.raw} — Envoy's own cluster name, which does not name a Service. BlackHoleCluster means no route matched; PassthroughCluster means the request left the mesh unrouted.`
    };
  }
  return g.responseFlags.includes('NR') ? { kind: 'not-routed' } : { kind: 'unknown' };
}

/** The sort value for each column, so the order is over the value rather than over the rendered text. */
const SORT_VALUE: Record<string, (g: TrafficErrorGroup) => string | number | null> = {
  status: g => g.code,
  count: g => g.count,
  method: g => g.method,
  path: g => g.path,
  host: g => g.authority,
  served: g => {
    const s = servedBy(g);
    return s.kind === 'not-routed' ? 'not routed' : s.kind === 'unknown' ? null : s.text;
  },
  client: g => {
    const first = g.sources[0];
    return first ? endpointLabel(first) : null;
  },
  destination: g => (g.destination ? endpointLabel(g.destination) : null)
};

/** Which way a column reads on its first press: a count wants its largest first, a name wants A→Z. */
const FIRST_DIR: Record<string, SortDir> = { count: 'desc' };

const DASH = <span className="text-muted/70">—</span>;

/* -------------------------------------------------------------------------------------- the table */

export function TrafficFailuresTable({
  groups,
  total,
  loading
}: {
  /** Already filtered by the shell. This component filters nothing and fetches nothing. */
  groups: readonly TrafficErrorGroup[];
  /** The group count before filtering, so every number on screen carries its denominator. */
  total: number;
  loading: boolean;
}): JSX.Element {
  /*
    Sorting lives here rather than in `DataTable`, and that is a correctness requirement rather than a
    preference. `DataTable` sorts the `rows` it is handed — which, on a paginated table, is one page.
    Page 3 of "count, descending" would then hold the 51st-to-75th rows of the *arrival* order, sorted
    among themselves: ordered, internally consistent, and the wrong rows. So the whole filtered set is
    sorted here and sliced afterwards. See `pagination.ts` for the assertion, and this component's
    report for the `DataTable` change that would let the native sort do it instead.
  */
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  /*
    The page number is component state and NOT in the URL, unlike every other piece of navigation
    state on this tab. The case for the URL is real and worth stating: `use-namespace-selection` and
    `useUrlSection` both put their state there, a shareable link to what you are looking at is how one
    operator hands a finding to another, and back/forward then work on a table the way they work on
    the rest of the console.

    It loses anyway, on one property of this particular data. These rows are a bounded tail of a live
    access log: the set is re-read, re-grouped and re-ordered on every visit, so `page=9` does not name
    the same twenty-five rows twice. A colleague following the link reaches a page of *different*
    failures, or — if the tail shortened — an empty page that clamps to 1 with nothing saying why. The
    other URL-backed state on this tab names WHAT to look at (a namespace, a section), and that
    survives a re-read; a page number names WHERE IN A LIST, and the list is not stable enough to be
    addressed that way. The reset-on-filter-change rule makes it worse rather than better: a URL
    carrying both a filter and a page would contradict itself the moment either was edited by hand.

    What makes the link shareable instead is the filter, which the shell already owns. Revisit this if
    the tab ever reads a stable window (a time range rather than a tail) — then the page addresses
    something real.
  */
  const [page, setPage] = useState(1);
  const [openKey, setOpenKey] = useState<string | null>(null);

  /*
    Reset to page 1 when the result set changes — staying on page 9 of a set that has just been
    narrowed to five rows is the same bug as not clamping at all. Keyed on a fingerprint of the row
    keys rather than on the array's identity: the shell hands down a new array whenever it re-renders,
    and a page that resets on every render is not a page.

    A render-phase update rather than an effect, which is React's documented way to adjust state to a
    prop change: an effect would commit the wrong page first and then correct it, so the operator sees
    one frame of the wrong rows.
  */
  const fingerprint = useMemo(() => rowsFingerprint(groups.map(g => g.key)), [groups]);
  const lastFingerprint = useRef(fingerprint);
  if (lastFingerprint.current !== fingerprint) {
    lastFingerprint.current = fingerprint;
    setPage(1);
  }

  const sorted = useMemo(
    () => sortRows(groups, SORT_VALUE[sort.key] ?? SORT_VALUE.count!, sort.dir),
    [groups, sort]
  );
  const view = paginate(sorted, page, DEFAULT_PAGE_SIZE);

  /*
    The expanded row is resolved from the page on screen rather than held as an object, so the panel
    can only ever describe a row the operator can see: a row the filter has just excluded, or that
    paging has moved off screen, takes its details with it. Holding the group itself instead would
    leave a panel describing a row that is no longer listed anywhere — the same failure as a stale
    count, and harder to notice because the panel looks authoritative.
  */
  const open = openKey ? (view.rows.find(g => g.key === openKey) ?? null) : null;

  /**
   * A sortable column header.
   *
   * Built here rather than by `DataTable`, for the reason above: a `sortValue` on the column would
   * give the operator a control that sorts one page. It reuses `.th-sort` and `.th-sort-mark` so it is
   * the same affordance as every other table's, and the active mark repeats what the CSS does for
   * `[aria-sort]` — which `DataTable` sets from its own state and therefore cannot set for this one.
   */
  const head = (label: string, key: string) => {
    const active = sort.key === key;
    const dir = active ? sort.dir : null;
    return (
      <button
        type="button"
        className="th-sort"
        title={`Sort by ${label.toLowerCase()}`}
        // The direction is in the accessible name because `aria-sort` belongs on the `th` and only
        // `DataTable` can put it there. Without it a screen reader announces eight identical buttons.
        aria-label={
          dir
            ? `Sorted by ${label}, ${dir === 'asc' ? 'ascending' : 'descending'}. Press to reverse.`
            : `Sort by ${label}`
        }
        onClick={() => {
          setSort(s => nextSort(s, key, FIRST_DIR[key] ?? 'asc'));
          // A new order puts different rows at the top, and the top is what the operator sorted to see.
          setPage(1);
        }}
      >
        {label}
        <SortMark dir={dir} />
      </button>
    );
  };

  const columns: Column<TrafficErrorGroup>[] = [
    {
      key: 'status',
      header: head('Status', 'status'),
      // The row's identity and the sticky column: a horizontally scrolled row whose code has scrolled
      // away is a set of paths belonging to nobody.
      pin: true,
      align: 'left',
      priority: 1,
      width: '128px',
      title: g => `${statusPhrase(g)} — ${CLASS_WHY[g.class]}`,
      render: g => (
        <span className="inline-flex items-center gap-1.5">
          {/* Text, not only a dot or a colour (§26). The code is the thing an operator searches for. */}
          <span className="mono text-[13px] font-semibold">{g.code}</span>
          <Pill tone={CLASS_TONE[g.class]}>{CLASS_BADGE[g.class]}</Pill>
        </span>
      )
    },
    {
      key: 'count',
      header: head('Count', 'count'),
      // `Seen` was the old label and it was ambiguous — it read as a timestamp on a table that also
      // has first and last seen. §8 replaces it with the noun the number actually is.
      ...NUMERIC,
      priority: 1,
      width: '64px',
      title: g =>
        `${g.count.toLocaleString()} record${g.count === 1 ? '' : 's'} matched this failure shape in the window that was read — not a rate, and not a total for the cluster.`,
      render: g => <span className="mono text-[13px]">{g.count.toLocaleString()}</span>
    },
    {
      key: 'method',
      header: head('Method', 'method'),
      align: 'left',
      priority: 1,
      width: '68px',
      title: g =>
        g.method ?? 'Envoy recorded no method — the connection failed before a request line was parsed.',
      render: g => (g.method ? <span className="mono text-[12px]">{g.method}</span> : DASH)
    },
    {
      key: 'path',
      header: head('Path', 'path'),
      align: 'left',
      priority: 1,
      // `max`, not `width`: `.tbl tbody td` sets `white-space: nowrap` under `table-layout: auto`, so
      // a `th` width is a suggestion the longest path overrides. The ceiling is what holds, and the
      // full value is on the cell's tooltip.
      max: '208px',
      title: g => g.path ?? 'Envoy recorded no path — the connection failed before a request line was parsed.',
      render: g => (g.path ? <span className="mono block truncate text-[12px]">{g.path}</span> : DASH)
    },
    {
      key: 'host',
      header: head('Host', 'host'),
      align: 'left',
      priority: 1,
      max: '152px',
      // `authority` is the Host header the client sent, which is not the same thing as the object that
      // publishes it — that is the Gateway, one column to the right.
      title: g => g.authority ?? 'No Host header was recorded on these records.',
      render: g =>
        g.authority ? <span className="mono block truncate text-[12px] text-muted">{g.authority}</span> : DASH
    },
    {
      key: 'served',
      header: head('Served by', 'served'),
      align: 'left',
      priority: 1,
      max: '148px',
      title: g => {
        const s = servedBy(g);
        if (s.kind === 'not-routed') return NOT_ROUTED_TITLE;
        if (s.kind === 'unknown') return NO_UPSTREAM_TITLE;
        return s.why;
      },
      render: g => {
        const s = servedBy(g);
        if (s.kind === 'not-routed') return <span className="text-[12px] text-muted/70">Not routed</span>;
        if (s.kind === 'unknown') return DASH;
        return <span className="mono block truncate text-[12px]">{s.text}</span>;
      }
    },
    {
      key: 'client',
      header: head('Client', 'client'),
      info: COLUMN_INFO.ingressPeerKind,
      align: 'left',
      // The one priority-2 column. It is the column an operator can most afford to lose at a narrow
      // container, because the caller of a 403 is a follow-up question and the details carry all of
      // them rather than just the first.
      priority: 2,
      max: '130px',
      title: g => {
        const first = g.sources[0];
        if (!first) return 'Envoy recorded no client address on these records.';
        const more = g.sources.length > 1 ? ` (+${g.sources.length - 1} more distinct source${g.sources.length > 2 ? 's' : ''})` : '';
        return `${first.ip}${first.port ? `:${first.port}` : ''} — ${first.evidence}${more}`;
      },
      render: g => {
        const first = g.sources[0];
        if (!first) return DASH;
        return (
          <span className="mono inline-flex min-w-0 items-center gap-1.5 text-[12px]">
            <Dot tone={endpointTone(first.kind)} />
            <span className="truncate">{endpointLabel(first)}</span>
            {g.sources.length > 1 && (
              <span className="text-[11px] text-muted/70">+{g.sources.length - 1}</span>
            )}
          </span>
        );
      }
    },
    {
      key: 'destination',
      header: head('Destination', 'destination'),
      align: 'left',
      /*
        Priority 3, which at this tab's 1090px container means it is shed at the default width. That is
        deliberate and it is the only column it would be true of: `destination` is populated in 1 of
        430 groups, and the expanded details print it for every row. Collapsing the rail (container
        1405px) brings it back.
      */
      priority: 3,
      max: '140px',
      title: g =>
        g.destination
          ? `${g.destination.ip}${g.destination.port ? `:${g.destination.port}` : ''} — ${g.destination.evidence}`
          : 'Envoy recorded no destination address for this side of the request.',
      render: g =>
        g.destination ? (
          <span className="mono inline-flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
            <Dot tone={endpointTone(g.destination.kind)} />
            <span className="truncate">{endpointLabel(g.destination)}</span>
          </span>
        ) : (
          DASH
        )
    }
  ];

  return (
    <Section
      title="Traffic failures"
      hint="Grouped traffic failure patterns observed in Istio proxy access logs."
      action={
        <div className="flex items-center gap-2">
          {/*
            Always "N of M", even when nothing is filtered and even on a single page. A count that
            shrank silently is indistinguishable from a read that returned less, and this is the table
            where that mistake costs the most.
          */}
          <span className="mono text-[12px] text-muted">{countLabel(groups.length, total)} groups</span>
          <InfoPopover content={FAILURES_INFO} ariaLabel="About grouped traffic failures" />
        </div>
      }
    >
      {loading && groups.length === 0 ? (
        // The table's own shape while the read is in flight, rather than a spinner: the header and
        // eight row-height bars keep the page from reflowing when the rows land.
        <div className="space-y-1.5 py-2" aria-busy="true" aria-label="Reading the access log">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton h-[44px]" />
          ))}
        </div>
      ) : (
        <>
          <DataTable
            id="traffic-failures"
            columns={columns}
            rows={view.rows}
            rowKey={g => g.key}
            shed="wide"
            selectedKey={open?.key ?? undefined}
            onSelect={g => setOpenKey(k => (k === g.key ? null : g.key))}
            empty={
              /*
                Two different empty tables, because they call for two different actions. `DataTable`
                unmounts its header and toolbar here, so the sort affordance goes with it — the sort
                itself survives, because this component owns it, and is still applied when the filter
                is cleared.
              */
              total === 0 ? (
                <Empty
                  title="No traffic failure came back"
                  hint="Whether that means a quiet mesh or an access log this tab cannot read is answered by the verdict above the table — an empty list is not on its own evidence that nothing failed."
                />
              ) : (
                <Empty
                  title="No failure matches these filters"
                  hint={`All ${total.toLocaleString()} groups were filtered out. Clearing a filter brings them back; the sort you chose is kept.`}
                />
              )
            }
          />
          {/*
            Between the table and the pager, not below both: the panel describes the row that was
            clicked, and an operator who has to scroll past a row of page buttons to reach it has lost
            the connection between the two.
          */}
          {open && <FailureDetails group={open} onClose={() => setOpenKey(null)} />}
          {/* Renders nothing at all on a single page — see `PageControl`. */}
          <PageControl
            page={view.page}
            pageCount={view.pageCount}
            from={view.from}
            to={view.to}
            total={view.total}
            noun="failure groups"
            onPage={setPage}
          />
        </>
      )}
    </Section>
  );
}

/**
 * The sort indicator. Always present, so an unsorted column still says it *can* sort, and its width
 * is reserved so the label does not shift sideways when the arrow changes.
 *
 * A component rather than inline JSX for one non-obvious reason: `DataTable` derives a column's
 * Columns-menu label and its resize control's accessible name from `textOf(header)`, which walks the
 * children of the nodes it is given. A component element has no `children` prop for it to walk, so the
 * glyph stays out of the derived text and the menu reads "Path" rather than "Path ↕".
 */
function SortMark({ dir }: { dir: SortDir | null }): JSX.Element {
  return (
    <span aria-hidden="true" className={dir ? 'th-sort-mark text-accent opacity-100' : 'th-sort-mark'}>
      {dir ? (dir === 'asc' ? '▲' : '▼') : '↕'}
    </span>
  );
}

/**
 * One group, expanded.
 *
 * Below the table rather than inside it: `test/fleet/table-structure.test.js` allows no hand-written
 * `.tbl` markup outside `DataTable`, and `DataTable` has no facility for a spanning detail row — so an
 * inline `<tr>` would mean editing a component this change does not own. The panel is still inline on
 * the page (no drawer, no dialog), it is anchored directly under the row it describes, and every field
 * either holds a value that is on the wire or says plainly that it is not there.
 *
 * `ROUTE` is absent from this list on purpose: the field is not in the payload at all, and "Route —"
 * asserts that it exists and is empty.
 */
function FailureDetails({ group: g, onClose }: { group: TrafficErrorGroup; onClose: () => void }): JSX.Element {
  const served = servedBy(g);
  const flags = g.responseFlags;

  return (
    <div className="mt-3 rounded-[8px] border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-line py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="mono text-[14px] font-semibold">{g.code}</span>
          <Pill tone={CLASS_TONE[g.class]} title={CLASS_WHY[g.class]}>
            {CLASS_BADGE[g.class]}
          </Pill>
          <span className="truncate text-[13px] text-muted">{statusPhrase(g)}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close these failure details"
          title="Close these failure details"
          className="rounded-[6px] border border-line px-2 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 py-3 lg:grid-cols-3">
        <Field label="Status" value={<span className="text-[13px]">{statusPhrase(g)}</span>} />
        <Field
          label="Count"
          value={
            <span title="Within the window this tab read. Not a rate and not a cluster total.">
              {g.count.toLocaleString()} record{g.count === 1 ? '' : 's'}
            </span>
          }
          mono
        />
        <Field label="Method" value={g.method ?? <Missing why="No request line was parsed, so there is no method." />} mono />
        <Field
          label="Path"
          value={
            g.path ? (
              <span className="break-all">{g.path}</span>
            ) : (
              <Missing why="No request line was parsed, so there is no path." />
            )
          }
          mono
        />
        <Field
          label="Host"
          value={g.authority ?? <Missing why="These records carried no Host header." />}
          mono
        />
        <Field
          label="Namespace"
          value={
            /*
              The honest answer to §9's Namespace field. A failure group has no namespace of its own,
              so this states which namespace is actually known — the client's, when the address
              resolved to something in this cluster — rather than borrowing the proxy's and letting it
              read as the traffic's. The proxy's namespace is in `Reported by`, where it belongs.
            */
            g.sources.find(s => s.namespace)?.namespace ? (
              <span title="The namespace of the client that sent these requests, from the object that claims its address.">
                {g.sources.find(s => s.namespace)!.namespace} <span className="text-muted">(client)</span>
              </span>
            ) : (
              <Missing why="A traffic failure group has no namespace field. No client address on these records resolved to an object in this cluster, and the namespace of the proxy that logged them is under Reported by." />
            )
          }
          mono
        />
        <Field
          label="Served by"
          value={
            <span className="inline-flex min-w-0 items-baseline gap-1.5">
              {served.kind === 'not-routed' ? (
                <>
                  <span className="text-muted">Not routed</span>
                  <InfoPopover content={NOT_ROUTED_INFO} ariaLabel="Explain not routed" />
                </>
              ) : served.kind === 'unknown' ? (
                <>
                  <Missing why={NO_UPSTREAM_TITLE} />
                  <InfoPopover content={SERVED_BY_INFO} ariaLabel="Explain served by and upstream" />
                </>
              ) : (
                <>
                  <span className="mono break-all" title={served.why}>
                    {served.text}
                  </span>
                  <InfoPopover content={SERVED_BY_INFO} ariaLabel="Explain served by and upstream" />
                </>
              )}
            </span>
          }
        />
        <Field
          label="Upstream"
          value={
            /*
              Kept even though the column was renamed to Served by: `upstream` is Envoy's own verdict
              and is non-null on 1 of 430 groups, so hiding it would make the rename a loss of
              information rather than a change of emphasis.
            */
            g.upstream ? (
              <span className="break-all" title={g.upstream.service ? g.upstream.service.evidence : undefined}>
                {g.upstream.raw}
              </span>
            ) : (
              <Missing
                why={
                  flags.includes('NR')
                    ? NOT_ROUTED_TITLE
                    : 'Envoy recorded no upstream_cluster on these records. Under an OpenTelemetry-labelled access log the field does not exist at all, so this is not evidence that the request went unrouted.'
                }
              />
            )
          }
          mono
        />
        <Field
          label="Client"
          value={
            g.sources.length ? (
              <div className="space-y-1">
                {g.sources.map(src => (
                  <div
                    key={`${src.kind}/${src.namespace ?? '-'}/${src.ip}`}
                    className="flex items-baseline gap-2"
                    title={`${src.ip}${src.port ? `:${src.port}` : ''} — ${src.evidence}`}
                  >
                    <Dot tone={endpointTone(src.kind)} />
                    {src.kind === 'Pod' && src.namespace ? (
                      // A link is free here: there is no selectable row under this panel, so it cannot
                      // both navigate and toggle the row the way it would inside the table.
                      <ResourceLink refTo={{ kind: 'Pod', namespace: src.namespace, name: src.name }} />
                    ) : (
                      <span className="mono text-[13px]">{endpointLabel(src)}</span>
                    )}
                    {src.kind === 'unresolved' && <span className="text-[11px] text-muted/70">unresolved</span>}
                    {src.count ? <span className="mono text-[11px] text-muted/70">×{src.count}</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <Missing why="Envoy recorded no client address on these records." />
            )
          }
        />
        <Field
          label="Destination"
          value={
            g.destination ? (
              <span
                className="mono inline-flex items-baseline gap-1.5"
                title={`${g.destination.ip}${g.destination.port ? `:${g.destination.port}` : ''} — ${g.destination.evidence}`}
              >
                <Dot tone={endpointTone(g.destination.kind)} />
                {endpointLabel(g.destination)}
              </span>
            ) : (
              <Missing why="Envoy recorded no destination address for this side of the request." />
            )
          }
        />
        <Field
          label="Response flags"
          value={
            <span className="inline-flex min-w-0 items-baseline gap-1.5">
              {flags.length ? (
                <span className="space-y-1">
                  {flags.map(f => (
                    <span key={f} className="block">
                      <span className="mono text-[13px] font-semibold">{f}</span>{' '}
                      <span className="text-[12px] text-muted">
                        {/*
                          The explanation belongs to the flag that is present. Nothing here is derived
                          from the status code, and a flag this build cannot name says so rather than
                          being guessed at — Envoy can emit flags newer than this console.
                        */}
                        {FLAG_MEANING[f] ?? 'Envoy emitted this flag and this build’s table does not have it. That is a gap in the console, not a new failure mode.'}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                <Missing why="Envoy added no response flag to these records, so nothing on the wire explains the code beyond the code itself." />
              )}
              <InfoPopover content={FLAGS_INFO} ariaLabel="Explain Envoy response flags" />
            </span>
          }
        />
        {g.responseCodeDetails.length > 0 && (
          <Field
            label="Response code details"
            value={
              // Envoy's own words, verbatim: `response_code_details` is the richest explanatory field
              // on this payload (429 of 430 groups carry one) and rewriting it would change what the
              // proxy said.
              <div className="space-y-0.5 text-[13px]">
                {g.responseCodeDetails.map(d => (
                  <div key={d} className="break-all">
                    {d}
                  </div>
                ))}
              </div>
            }
            mono
          />
        )}
        {g.transportFailures.length > 0 && (
          <Field
            label="Transport failure"
            value={
              <div className="space-y-0.5 text-[13px] text-bad">
                {g.transportFailures.map(d => (
                  <div key={d} className="break-all">
                    {d}
                  </div>
                ))}
              </div>
            }
            mono
          />
        )}
        {g.proxies.length > 0 && (
          <Field
            label="Reported by"
            value={
              <div className="space-y-1">
                {g.proxies.map(p => (
                  <div key={`${p.namespace}/${p.pod}`} className="flex items-baseline gap-2" title={`${p.namespace}/${p.pod} · ${p.container}`}>
                    <ResourceLink refTo={{ kind: 'Pod', namespace: p.namespace, name: p.pod }} />
                    <span className="mono text-[11px] text-muted/70">×{p.count}</span>
                  </div>
                ))}
              </div>
            }
          />
        )}
        {g.firstSeen && (
          <Field
            label="First seen"
            value={<span title={g.firstSeen}>{ago(g.firstSeen)}</span>}
            mono
          />
        )}
        {g.lastSeen && (
          <Field label="Last seen" value={<span title={g.lastSeen}>{ago(g.lastSeen)}</span>} mono />
        )}
        {g.p50Ms !== null && (
          <Field
            label="Duration"
            value={`p50 ${g.p50Ms} ms${g.maxMs !== null ? `, max ${g.maxMs} ms` : ''}`}
            mono
          />
        )}
      </div>
    </div>
  );
}

/** An absent value, with the reason it is absent. Never a blank cell and never a zero. */
function Missing({ why }: { why: string }): JSX.Element {
  return (
    <span className="text-muted/70" title={why}>
      —
    </span>
  );
}
