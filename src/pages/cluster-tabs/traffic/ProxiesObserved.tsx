/**
 * Traffic Errors → Proxies observed.
 *
 * Which proxies this window actually came from — and, just as importantly, which ones it did not.
 *
 * ## Three states, named for what they are
 *
 * The heading used to read "Proxies read", which invited the obvious next question and answered it
 * wrongly: a proxy missing from the list looked quiet. It was not asked. `window` reports
 * `proxyCandidates` (Running pods carrying an `istio-proxy` container), `proxiesRead`,
 * `proxiesSkipped` and `proxiesFailed[]`, and those are three genuinely different facts:
 *
 *   read        tailed, and it returned lines
 *   not read    never asked — the collector caps the sweep at `maxPods` per request
 *   failed      asked, and the read errored; named here with the reason it gave
 *
 * The word **reporting** appears nowhere for this reason. "37 reporting / 4 silent" is not a statement
 * this backend can make: silence is an observation about a proxy, and a capped sweep is a decision by
 * the reader. `proxiesSkipped` carries a count and no names, which is why those proxies can only ever
 * be a figure beside the table and never a row in it.
 *
 * ## Why there is no per-proxy request count
 *
 * There is no per-proxy endpoint, and `TrafficData.errors` holds **failures only**. Each failure group
 * carries `proxies[]` of `{pod, namespace, container, count}`, so failures per proxy roll up exactly.
 * Requests do not: `summary.requests` is mesh-wide and `window.linesRead` is a single total with no
 * per-proxy breakdown on the wire. So the REQUESTS column states that rather than dividing one by the
 * other — this is the easiest place on the page to fabricate a number, and a plausible fabricated
 * number is worse than an admitted gap.
 *
 * ## Why a read proxy can be missing from the table
 *
 * The rows are rolled up from the failure groups, so a proxy that was read and logged *no* failure has
 * nothing to appear as. That is why the row count is below `proxiesRead` and why both figures are
 * printed: ten read with three rows means seven proxies were tailed and had nothing to report.
 */
import { useMemo } from 'react';
import type { TrafficErrorGroup, TrafficWindow } from '../../../api';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { InfoPopover } from '../../../components/InfoPopover';
import { Field, Section } from '../../../components/layout';
import { Dot, Empty, Pill } from '../../../components/ui';
import { ago } from '../../../format';
import { readCoverage, rollUpProxies, type ProxyRow } from './proxy-rollup';

export function ProxiesObserved({
  groups,
  window: w
}: {
  groups: readonly TrafficErrorGroup[];
  window: TrafficWindow | undefined;
}): JSX.Element {
  const rows = useMemo(() => rollUpProxies(groups, w), [groups, w]);
  const coverage = readCoverage(w);

  const explain = (
    <InfoPopover
      ariaLabel="Explain how proxies are counted and what read, not read and failed mean"
      content={{
        title: 'Proxies observed',
        means:
          'Every Running pod in the mesh carrying an istio-proxy container is an observed proxy. This tab tails a bounded number of them per request, so “observed” is the population and “read” is the sample.',
        source: (
          <>
            Pods with an <span className="mono">istio-proxy</span> container, and the per-read accounting
            the collector returns on <span className="mono">window</span>.
          </>
        ),
        limitations: [
          'Read, not read and failed are three different things. A proxy that was not read was never asked — the sweep is capped per request — so its absence says nothing about whether it is serving traffic or failing it.',
          'The proxies that were not read cannot be named: the payload carries a count and no identities.',
          'A proxy appears in the table only if it logged a failure, because the failure list is what names it. A proxy that was read and logged nothing has no row.',
          'There is no per-proxy request count anywhere in this payload, so the requests column states the gap instead of estimating it.'
        ],
        sources: ['accessLog']
      }}
    />
  );

  if (!coverage) {
    return (
      <Section title="Proxies observed" action={explain}>
        <Empty
          title="No traffic window was read"
          hint="Nothing was tailed for this cluster, so there is no proxy accounting to show. This is a statement about the read, not about the mesh."
        />
      </Section>
    );
  }

  const { observed, read, notRead, failed, truncated, tailLines, linesRead, linesUnparsed, requestsParsed, skippedReads, accountedFor } =
    coverage;
  const reporting = rows.filter(r => r.state === 'read').length;

  /*
    Six columns, two of them capped rather than fixed: a pod name has no natural bound, and `.tbl tbody
    td` sets `white-space: nowrap` under `table-layout: auto`, so only a `max` holds the column — a
    `width` is a suggestion the longest row overrides. The declared widths sum to 828px and padding
    costs 6*32-32 = 160px, which fits the ~1090px container at 1440 with the rail expanded.
  */
  const columns: Column<ProxyRow>[] = [
    {
      key: 'proxy',
      header: 'Proxy',
      pin: true,
      max: '220px',
      sortValue: r => r.pod,
      render: r => (
        <span
          className="mono block truncate text-[12px]"
          title={`${r.key}${r.containers.length ? ` — container ${r.containers.join(', ')}` : ''}`}
        >
          {r.pod}
        </span>
      )
    },
    {
      key: 'namespace',
      header: 'Namespace',
      max: '130px',
      sortValue: r => r.namespace,
      render: r => (
        <span className="mono block truncate text-[12px] text-muted" title={r.namespace}>
          {r.namespace}
        </span>
      )
    },
    {
      key: 'requests',
      header: 'Requests',
      ...NUMERIC,
      width: '116px',
      // No `sortValue`: there is no value. Offering a sort on a column of identical gaps implies the
      // numbers exist and are being withheld.
      render: () => (
        <span
          className="text-[12px] italic text-muted/70"
          title="Not available per proxy. The window’s request total is mesh-wide, and the failure groups carry per-proxy counts for failures only — so a request count for one proxy could only be estimated, and this console does not estimate."
        >
          not per proxy
        </span>
      )
    },
    {
      key: 'errors',
      header: 'Errors',
      ...NUMERIC,
      width: '92px',
      sortValue: r => r.errors,
      render: r =>
        r.errors === null ? (
          // Never a 0. A refused log says nothing about whether that proxy is failing requests, and a
          // zero here would assert the opposite.
          <span
            className="text-[12px] text-muted/70"
            title="The log read failed, so this proxy’s failure count is unknown — which is not the same as zero."
          >
            —
          </span>
        ) : (
          <span
            className="mono text-[13px]"
            title={`${r.errors.toLocaleString()} failing request${r.errors === 1 ? '' : 's'} logged by this proxy, across ${r.groups} failure ${r.groups === 1 ? 'shape' : 'shapes'}. Failures only — this payload carries no successful request, so it is not a share of what this proxy served.`}
          >
            {r.errors.toLocaleString()}
          </span>
        )
    },
    {
      key: 'last',
      header: 'Last seen',
      ...NUMERIC,
      width: '104px',
      sortValue: r => r.lastSeen,
      render: r => (
        <span
          className="text-[12px] text-muted"
          title={
            r.lastSeen
              ? `The newest timestamp among the failure groups this proxy contributed to (${r.lastSeen}). A group’s timestamp spans every proxy that reported it, so this is an upper bound on when this proxy last logged a failure.`
              : r.state === 'failed'
                ? 'The log read failed, so there is no timestamp from this proxy at all.'
                : 'No failure group this proxy contributed to carried a timestamp.'
          }
        >
          {r.lastSeen ? ago(r.lastSeen) : '—'}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      // `max`, not `width`: the reason token beside the pill truncates, and under `table-layout: auto`
      // only a ceiling holds — a `width` is a suggestion the longest reason overrides.
      max: '176px',
      sortValue: r => r.state,
      render: r =>
        r.state === 'failed' ? (
          <span className="flex min-w-0 items-center gap-2">
            <Pill tone="warn" title="The collector asked this proxy for its log and the read errored. Nothing it may have logged is in this window.">
              Read failed
            </Pill>
            {r.reason && (
              <span className="mono min-w-0 truncate text-[11px] text-muted" title={r.detail ?? r.reason}>
                {r.reason}
              </span>
            )}
          </span>
        ) : (
          <Pill tone="ok" title="The collector tailed this proxy’s istio-proxy log and it returned lines.">
            Read
          </Pill>
        )
    }
  ];

  return (
    <div className="space-y-5">
      <Section
        title="Proxies observed"
        label={`${observed} observed`}
        hint="What this window was read from. Observed is every Running pod with an istio-proxy container; read is the bounded sample this request actually tailed."
        action={explain}
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 lg:grid-cols-3">
          {/*
            Under `readsSkipped` every one of these fields describes a read that was never issued, so
            the ordinary wording would say several false things at once — `Lines per proxy: 500` is a
            bound that never applied, and `Not read: 31 over the per-request cap` names a cause that did
            not apply while implying the other ten *were* read. This is the sub-tab an operator opens to
            decide whether the counts elsewhere are trustworthy, so it has to answer "nothing was looked
            at" rather than "nothing was missed". Carried forward from the Window sub-tab, which learned
            this first.
          */}
          <Field
            label="Read"
            value={
              skippedReads
                ? `none of ${observed} — the read was skipped, not empty`
                : `${read} of ${observed}`
            }
          />
          <Field
            label="Not read"
            value={
              skippedReads
                ? `all ${observed} — the access log does not reach pod stdout`
                : notRead
                  ? `${notRead} over the per-request cap — ingress gateways and restart-heavy pods are read first`
                  : 'none'
            }
          />
          <Field
            label="Read failed"
            value={failed ? `${failed} — named below with the reason each gave` : 'none'}
          />
          <Field
            label="Lines per proxy"
            value={
              skippedReads
                ? `— no proxy was tailed (the bound would have been ${tailLines})`
                : `${tailLines}${truncated ? ` — ${truncated} had older lines beyond it` : ''}`
            }
          />
          <Field
            label="Request lines parsed"
            value={
              skippedReads
                ? '— nothing was read'
                : `${requestsParsed.toLocaleString()} of ${linesRead.toLocaleString()} read${linesUnparsed ? `, ${linesUnparsed.toLocaleString()} not request records` : ''}`
            }
          />
          <Field
            label="Window"
            value={
              skippedReads
                ? '— no window; nothing was tailed'
                : w && w.oldest && w.newest
                  ? `${ago(w.oldest)} → ${ago(w.newest)}`
                  : 'no timestamped lines'
            }
          />
        </div>

        {!accountedFor && (
          <p className="mt-2 max-w-[100ch] text-[12px] text-warn">
            Read, not read and failed do not add up to the {observed} observed. Each of the four is read
            from the payload rather than derived from the other three, so the difference is reported here
            rather than absorbed into whichever number happened to be calculated.
          </p>
        )}
      </Section>

      <Section
        title="What each proxy contributed"
        label={String(rows.length)}
        hint={
          skippedReads
            ? 'No proxy was tailed, so nothing here is a statement about the mesh.'
            : `${reporting} of the ${read} proxies that were read logged at least one failure. A proxy that was read and had nothing to report has no row — this table is rolled up from the failure list, which is the only thing on the wire that names a proxy. A read that failed contributed nothing and is listed with the reason it gave.`
        }
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={r => r.key}
          empty={
            <Empty
              title={skippedReads ? 'No proxy was read' : 'No proxy logged a failure in this window'}
              hint={
                skippedReads
                  ? 'The mesh sends its access log somewhere this tab cannot follow, so no proxy was tailed. That is not evidence that nothing failed.'
                  : `Read ${read} of ${observed} observed proxies; none of them recorded a failing request inside the window.${notRead ? ` The ${notRead} that were not read may have.` : ''}`
              }
            />
          }
        />
      </Section>

      {truncated > 0 && (
        <Section title="Older lines beyond the tail">
          <div className="flex flex-wrap items-baseline gap-2">
            <Dot tone="unknown" />
            <p className="max-w-[92ch] flex-1 text-[13px] text-muted">
              {`${truncated} of the ${read} proxies that were read still had lines older than the ${tailLines}-line tail, so this window starts later than their logs do. `}
              This is a different gap from a proxy that was not read at all, and the two are deliberately
              not added together: one is a shorter window, the other is a missing proxy. A larger
              per-proxy line bound closes this one; only a larger proxy budget closes the other.
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}
