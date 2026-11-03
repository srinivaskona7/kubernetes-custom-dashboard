/**
 * Traffic Errors → the error breakdown.
 *
 * One horizontal bar per response code the window recorded, highest count first, with the count and
 * the share printed beside it. A plain bar rather than a chart: one dimension, no axes, and the
 * number is on the row anyway, so a chart library would add a dependency and a second way to be
 * wrong about the same value.
 *
 * ## The two things this section deliberately does differently
 *
 * **It invents no rows.** Only the codes in `summary.byCode` appear. The request's example showed
 * `401 0` and `404 0`; a printed zero for a code that never appeared cannot be told apart from one
 * that was looked for and not found, and the row makes the first reading look authoritative. A code
 * that *is* present with a count of zero keeps its row and is drawn subtle — there, the zero is an
 * observation.
 *
 * **It shows the successes, separated.** `byCode` carries `200` (659 records on the reference
 * cluster) and the redirects alongside the errors. They are the denominator an operator needs before
 * they can read 472 × 403 as either a catastrophe or as the background noise of a cluster turning
 * away unauthenticated callers, so they are printed — in their own band, unfilterable, labelled
 * `success`, and never added into the error total.
 *
 * Colour is never the only carrier: every row prints the class as a word beside the bar, so the
 * section survives greyscale and colour blindness.
 */
import type { TrafficData } from '../../../api';
import { InfoPopover } from '../../../components/InfoPopover';
// The same share formatter the rest of this tab uses. Re-implementing "below 1% but not zero keeps a
// decimal, null is an em-dash" here would give the Traffic tab two ways to print a percentage.
import { share } from '../ingress/shared';
import { breakdownRows, type BreakdownRow } from './metrics-logic';

export function ErrorBreakdown({
  byCode,
  loading,
  onPickCode
}: {
  byCode: TrafficData['summary']['byCode'] | undefined;
  loading: boolean;
  onPickCode: (code: number) => void;
}): JSX.Element {
  const { errors, context, total } = breakdownRows(byCode);
  const contextTotal = context.reduce((n, r) => n + r.count, 0);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-1.5">
        {/*
          Not `layout.tsx`'s `Section`: its `title` is typed `string`, so the explanation icon the
          request asks for beside this heading cannot go inside it. Same typography, so the two read
          as one kind of heading.
        */}
        <h2 className="text-[14px] font-semibold uppercase tracking-[0.04em] text-text">Error breakdown</h2>
        <InfoPopover
          content={{
            title: 'Error breakdown',
            means:
              'Every HTTP response code the access-log window recorded, with how many records carried it.',
            source: 'byCode on the traffic summary — the observed codes, in the collector’s own classification.',
            limitations: [
              'Only codes that appeared are listed. A code missing from this list was never recorded in this window; no zero row is added for it, because a printed 0 cannot say whether the code was looked for and absent or simply never seen.',
              'Successful and redirected responses are listed separately below the errors, as the denominator. They are not counted as errors.',
              'Shares are of the records read in this window, not of the cluster’s traffic.',
              'A code is not a cause. 403 means Envoy recorded a 403; what denied the request is not in this number.'
            ],
            sources: ['accessLog']
          }}
          ariaLabel="Explain the error breakdown"
        />
      </div>
      <p className="text-[13px] text-muted">Distribution of observed HTTP error responses in the selected time range.</p>

      {loading ? (
        <div className="divide-y divide-line" aria-busy="true" aria-label="Loading the error breakdown">
          {/* Four rows, which is roughly what this cluster reports — the section keeps its height so
              the content below it does not jump when the read lands. */}
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-3 py-2.5">
              <span className="skeleton block h-[14px] w-[48px]" />
              <span className="skeleton block h-[8px] flex-1" />
              <span className="skeleton block h-[14px] w-[56px]" />
            </div>
          ))}
        </div>
      ) : errors.length === 0 && context.length === 0 ? (
        <p className="max-w-[92ch] text-[13px] text-muted">
          No response code appears in the window that was read. That is not the same statement as &ldquo;no
          errors&rdquo; — if nothing was read, the cards above say so rather than showing a zero.
        </p>
      ) : (
        <>
          {/* `divide-y` and negative space rather than a card per band: at this density another
              container would read as content. The dashboard-hardening rule in the project's design
              dials forbids a generic card above density 7. */}
          <div className="divide-y divide-line">
            {errors.map(r => (
              <Row key={r.code} row={r} total={total} onPickCode={onPickCode} />
            ))}
          </div>

          {context.length > 0 && (
            <div className="mt-3 border-t border-line pt-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
                  Not counted as errors
                </h3>
                <p className="text-[12px] text-muted/80">
                  {contextTotal.toLocaleString()} of the {total.toLocaleString()} records read answered normally
                </p>
              </div>
              <div className="mt-1 divide-y divide-line/60">
                {context.map(r => (
                  <Row key={r.code} row={r} total={total} onPickCode={onPickCode} />
                ))}
              </div>
            </div>
          )}

          <p className="text-[12px] text-muted/80">
            Shares are of the {total.toLocaleString()} records this read covered — not of the cluster&apos;s
            traffic.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * One code, as a row.
 *
 * Filterable rows are real `<button>`s, so they are reachable by keyboard and announced as
 * actionable. The success and redirect rows are not: the failures table holds failure groups only, so
 * a click on `200` would land the operator on an empty table and blame them for it. Their title says
 * so rather than leaving a dead affordance unexplained.
 */
function Row({
  row,
  total,
  onPickCode
}: {
  row: BreakdownRow;
  total: number;
  onPickCode: (code: number) => void;
}): JSX.Element {
  const what = row.code === 0 ? 'entries with no HTTP response' : `HTTP ${row.code} responses`;
  const detail = `${row.count.toLocaleString()} of the ${total.toLocaleString()} records read — ${row.word}.`;

  const body = (
    <>
      <span className="mono w-[52px] shrink-0 text-left text-[13px] font-medium">{row.label}</span>
      <span className="w-[96px] shrink-0 text-left text-[12px] text-muted">{row.word}</span>
      {/* The bar is decorative: the count and the share beside it carry the same value as text. */}
      <span className={`dist-bar ${row.barClass} min-w-0 flex-1`} aria-hidden="true">
        <span style={{ width: `${(row.share ?? 0) * 100}%` }} />
      </span>
      <span className="mono w-[68px] shrink-0 text-right text-[13px]">{row.count.toLocaleString()}</span>
      <span className="mono w-[52px] shrink-0 text-right text-[12px] text-muted">{share(row.share)}</span>
    </>
  );

  // `dist-bar-zero` on the row, not on the bar: the request asks for a zero value to stay visible and
  // become subtle, and dimming only its bar would leave full-strength digits beside a faint track.
  const cls = `flex w-full items-center gap-3 py-2.5 text-left ${row.zero ? 'dist-bar-zero' : ''}`;

  if (!row.filterable) {
    return (
      <div
        className={cls}
        title={`${detail} Not a filter — the failures table below holds error rows only, so there is nothing here to narrow to.`}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onPickCode(row.code)}
      title={`${detail} Click to show only these.`}
      aria-label={`Filter to ${what} — ${row.count.toLocaleString()} records`}
      className={`${cls} rounded-[4px] transition-colors hover:bg-raised/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
    >
      {body}
    </button>
  );
}
