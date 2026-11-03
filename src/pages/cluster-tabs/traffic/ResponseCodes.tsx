/**
 * Traffic Errors → Response codes.
 *
 * Every response code the mesh's proxies recorded in the window that was read, with the share each
 * one took. One table, five facts, and one of them deliberately empty.
 *
 * ## Three decisions worth knowing before changing this
 *
 * **1. The category comes from the class, never from the number.** `summary.byCode` carries a `class`
 * the collector assigned, and re-deriving "is this a 4xx" here would give the table a second opinion
 * that disagrees with the cards above it the first time either side changed. See `categoryOf`.
 *
 * **2. The share's denominator is in the header, not in a comment.** `89.6%` over the records read and
 * `89.6%` over the records that *failed* are different claims about the same row, and the live window
 * makes the difference enormous: 2,974 records read against 2,313 that failed. So the column is headed
 * *Share of records read* and the count's own tooltip states both figures, which is cheaper than a
 * second column and leaves nothing to infer.
 *
 * **3. Trend is empty because there is nothing to compare against.** This console keeps no metrics
 * history: one read, one window, no previous period. A trend arrow here would be invented, so the cell
 * is an em-dash and says why on hover. Do not add one without a comparison read to divide by.
 *
 * ## Why only some rows have an action
 *
 * `TrafficData.errors` holds **failures only**. A "Show requests" button on the `200` row would open a
 * list that says nothing matches — true, and read as a broken link. So the control appears on the
 * failing classes and the successful rows say, on hover, that there is no failing-request list behind
 * them. The same rule as `ingress/IngressFailures.tsx`, which learned it the hard way on the largest
 * row of a healthy cluster.
 */
import { useMemo } from 'react';
import type { TrafficData } from '../../../api';
import { ACTIONS, DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { InfoPopover } from '../../../components/InfoPopover';
import { Section } from '../../../components/layout';
import { Empty, Pill } from '../../../components/ui';
import { categoryOf, isFailingClass, recordsIn, shareOfRecords } from './proxy-rollup';

type CodeRow = TrafficData['summary']['byCode'][number];

/** The user-specified wording, kept verbatim — it is the whole content of the TREND column. */
const TREND_WHY = 'Trend unavailable because no comparison period is available.';

export function ResponseCodes({
  summary,
  onPickCode
}: {
  summary: TrafficData['summary'] | undefined;
  onPickCode: (code: number) => void;
}): JSX.Element {
  // Sorted here rather than trusted: the collector already returns this descending, and a table that
  // depends on an API's ordering for its ranking silently re-ranks itself when the API changes.
  const rows = useMemo(
    () => [...(summary?.byCode ?? [])].sort((a, b) => b.count - a.count || a.code - b.code),
    [summary?.byCode]
  );

  const total = recordsIn(summary?.byCode);
  const errors = summary?.errors ?? 0;

  const explain = (
    <InfoPopover
      ariaLabel="Explain the response code table and its denominator"
      content={{
        title: 'Response codes',
        means:
          'Every status Envoy wrote for a request in this window, counted per code. The class beside each one is the collector’s own — 0 is “no response”, 400–499 is a client error, 500 and above is a server error, and everything below 400 is folded together as answered.',
        source: (
          <>
            The <span className="mono">response_code</span> field of the Envoy access log, tailed from each
            proxy’s <span className="mono">istio-proxy</span> container.
          </>
        ),
        limitations: [
          `Counts are of the ${total.toLocaleString()} records that were read, not of all mesh traffic. A tail of N lines has no denominator, so nothing here is a rate.`,
          'Shares are of those same records read. The count’s tooltip also gives the row’s share of the records that failed, which is the smaller and often more useful denominator.',
          TREND_WHY + ' This console keeps no metrics history, so there is no previous window to compare this one against.',
          'A code absent from this table may simply not have occurred inside the window — absence here is not evidence it never happens.'
        ],
        sources: ['accessLog']
      }}
    />
  );

  if (!summary) {
    return (
      <Section title="Response codes" action={explain}>
        <Empty
          title="No traffic window was read"
          hint="Nothing was tailed for this cluster, so there is no response code to count. The Proxies observed sub-tab says which proxies were selected and what happened to each read."
        />
      </Section>
    );
  }

  /*
    Six columns and nothing unbounded. Padding costs 6*32-32 = 160px and the declared widths sum to
    760px, which fits the ~1090px container at 1440 with the rail expanded — so the base tier is right
    and no column sheds at the default width. `Actions` carries no `priority` on purpose: shedding the
    only affordance on the row is worse than letting the table scroll.

    One `<table>`, one `<thead>`: `DataTable` applies each column's class, width and alignment to the
    `th` and the `td` from the same object, so the header grid is structurally incapable of drifting
    from the body's. That is the mechanism behind "header and body use the same grid" rather than a
    review step.
  */
  const columns: Column<CodeRow>[] = [
    {
      key: 'code',
      header: 'Code',
      pin: true,
      width: '90px',
      sortValue: c => c.code,
      render: c => (
        <span
          className="mono text-[13px] font-semibold"
          title={
            c.code === 0
              ? 'Envoy wrote response_code 0: the connection closed before any HTTP response was sent. There is no status code to show, which is not the same as a 5xx.'
              : `HTTP ${c.code}`
          }
        >
          {c.code === 0 ? 'none' : c.code}
        </span>
      )
    },
    {
      key: 'count',
      header: 'Count',
      ...NUMERIC,
      width: '100px',
      sortValue: c => c.count,
      render: c => (
        <span
          className="mono text-[13px]"
          // Both denominators, on the row itself. An operator comparing this figure against a
          // dashboard elsewhere needs to know which population it is a share of, and the answer is
          // different for the two questions they might be asking.
          title={
            isFailingClass(c.class)
              ? `${c.count.toLocaleString()} records — ${shareOfRecords(c.count, total)} of the ${total.toLocaleString()} read, and ${shareOfRecords(c.count, errors)} of the ${errors.toLocaleString()} that failed. Not a rate: this is a tail of the access log.`
              : `${c.count.toLocaleString()} records — ${shareOfRecords(c.count, total)} of the ${total.toLocaleString()} read. Not a rate: this is a tail of the access log.`
          }
        >
          {c.count.toLocaleString()}
        </span>
      )
    },
    {
      key: 'category',
      header: 'Category',
      width: '164px',
      sortValue: c => categoryOf(c.class).label,
      // A dot and a word, never the colour alone: the class is the one thing on this row an operator
      // acts on, and it has to survive greyscale.
      render: c => {
        const cat = categoryOf(c.class);
        return (
          <Pill tone={cat.tone} title={cat.why}>
            {cat.label}
          </Pill>
        );
      }
    },
    {
      key: 'share',
      header: 'Share of records read',
      ...NUMERIC,
      width: '190px',
      // The ratio, not the formatted string: "9%" and "100%" sort as text in the wrong order.
      sortValue: c => (total > 0 ? c.count / total : null),
      render: c => (
        <span className="mono text-[13px] text-muted" title={`${c.count.toLocaleString()} of the ${total.toLocaleString()} records read.`}>
          {shareOfRecords(c.count, total)}
        </span>
      )
    },
    {
      key: 'trend',
      header: 'Trend',
      width: '84px',
      // No `sortValue`: there is nothing to sort. An em-dash column that can be clicked to reorder
      // rows implies it holds a value this build is withholding.
      render: () => (
        <span className="text-[13px] text-muted/70" title={TREND_WHY}>
          —
        </span>
      )
    },
    {
      key: 'requests',
      ...ACTIONS,
      width: '132px',
      render: c =>
        isFailingClass(c.class) ? (
          <button
            type="button"
            onClick={() => onPickCode(c.code)}
            className="rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
            title={`Open the failing requests filtered to ${c.code === 0 ? 'the records with no response' : c.code}.`}
          >
            Show requests
          </button>
        ) : (
          <span
            className="text-[12px] text-muted/70"
            title="The failing-request list holds failures only, so there is nothing behind a code that succeeded."
          >
            —
          </span>
        )
    }
  ];

  return (
    <Section
      title="Response codes"
      label={`${total.toLocaleString()} records`}
      hint="Every status recorded in the window that was read, ranked by how often it occurred. Click a failing code to open the requests behind it."
      action={explain}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={c => String(c.code)}
        empty={
          <Empty
            title="No response code was recorded"
            hint="Lines were read but none of them carried a status field — which is what a non-JSON access-log format looks like from here. The Proxies observed sub-tab shows how many lines were read and how many were not request records."
          />
        }
      />
      <p className="mt-3 max-w-[100ch] text-[12px] text-muted">
        {`These are counts of access-log lines, not of all mesh traffic: the tab tails a bounded number of lines from a bounded number of proxies, so a code that is absent may simply not have occurred inside the window. `}
        {errors > 0 && total > 0 && (
          <>
            {`Of the ${total.toLocaleString()} records read, ${errors.toLocaleString()} were failures — `}
            <span className="mono">{shareOfRecords(errors, total)}</span>
            {'. '}
          </>
        )}
        The Proxies observed sub-tab is where to check whether this window is representative before
        acting on a share.
      </p>
    </Section>
  );
}
