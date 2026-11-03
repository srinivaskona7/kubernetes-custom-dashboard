/**
 * Decision Activity — runtime admission decisions, when the cluster publishes any.
 *
 * The honest tab. On most clusters there is nothing here, and the reason is not "no denials
 * happened" but "nothing records them": Gatekeeper only logs denials when started with
 * `--log-denies`, and its Prometheus counters need a route to the metrics endpoint that this
 * cluster may not have. The cause is per-cluster, so the page states which of the two sources
 * answered rather than asserting one universal reason — on platformsbx, measured, there is no
 * metrics Service to scrape at all. So the empty state names the missing sources instead of
 * borrowing the audit's violation count and calling it "denied in the last 24 hours" — those are
 * different facts and the substitution would be a fabrication.
 */
import { useCallback } from 'react';
import { api, type OpaDecisionEntry, type OpaData } from '../../../api';
import { Section } from '../../../components/layout';
import { DataTable, type Column } from '../../../components/DataTable';
import { Dot, ErrorState, Pill, Skeleton, type Tone } from '../../../components/ui';
import { CapabilityNotice } from '../../../capability';
import { ago } from '../../../format';
import { useAsync } from '../../../useAsync';
import { useFindingNavigation } from '../../../findings';
import { ResourceLink } from '../../../components/ResourceLink';
import { linkableKind } from './shared';

const DECISION_TONE: Record<OpaDecisionEntry['decision'], Tone> = {
  denied: 'bad',
  warned: 'warn',
  dryrun: 'accent',
  allowed: 'ok'
};

export function OpaDecisions({ cluster, opa }: { cluster: string; opa: OpaData }): JSX.Element {
  // Its own request, issued only because this tab is mounted — it costs a Deployment read that the
  // other four tabs have no use for.
  const decisions = useAsync(useCallback(() => api.clusterOpaDecisions(cluster), [cluster]), 0, cluster);
  const go = useFindingNavigation();

  if (decisions.initial) return <Skeleton rows={6} />;
  if (decisions.error && !decisions.data) {
    return <ErrorState code={decisions.error.code} message={decisions.error.message} />;
  }
  if (decisions.data && !decisions.data.ok) {
    return (
      <ErrorState
        cluster={cluster}
        code={decisions.data.error?.code ?? 'UNKNOWN'}
        message={decisions.data.error?.message ?? 'this cluster did not answer'}
        needsReseed={decisions.data.error?.needsReseed}
      />
    );
  }

  const data = decisions.data?.ok ? decisions.data.data : null;
  if (!data) return <p className="py-6 text-[13px] text-muted">This cluster returned no decision-source payload.</p>;

  /**
   * The nine columns, and the two things deliberately missing from them.
   *
   * There is no request body and no object payload. A decision record's `object` is the thing being
   * admitted — for a Secret admission that IS the Secret, and for a Pod it is every environment
   * variable in it. The decision, the policy, the operation and the object's identity answer the
   * operator's question without carrying any of that to the browser.
   */
  const columns: Column<OpaDecisionEntry>[] = [
    {
      key: 'at',
      header: 'Timestamp',
      pin: true,
      priority: 1,
      width: '132px',
      render: e =>
        // Every field a decision source publishes is optional — a metric-derived entry has a
        // counter and a policy and nothing else. Each cell says which one is missing rather than
        // rendering a blank that reads as a read failure.
        e.at ? (
          <span className="mono text-[12px]" title={e.at}>
            {ago(e.at)}
          </span>
        ) : (
          <span className="text-[12px] text-muted" title="This source publishes no timestamp per decision">
            no timestamp
          </span>
        )
    },
    {
      key: 'decision',
      header: 'Decision',
      priority: 1,
      width: '104px',
      render: e => <Pill tone={DECISION_TONE[e.decision]}>{e.decision}</Pill>
    },
    {
      key: 'policy',
      header: 'Policy',
      priority: 1,
      max: '200px',
      render: e =>
        e.policyId && e.policy ? (
          <button
            type="button"
            onClick={() => go({ params: { opa: 'policies', opasel: e.policyId as string } })}
            className="truncate text-left underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent"
            title={`Open ${e.policy}`}
          >
            {e.policy}
          </button>
        ) : (
          <span className="text-[12px] text-muted">{e.policy ?? 'policy not named'}</span>
        )
    },
    {
      key: 'operation',
      header: 'Operation',
      priority: 2,
      width: '104px',
      render: e => <span className="mono text-[12px] text-muted">{e.operation ?? '—'}</span>
    },
    {
      key: 'kind',
      header: 'Resource kind',
      priority: 2,
      max: '132px',
      render: e => <span className="mono truncate text-[12px] text-muted">{e.kind ?? '—'}</span>
    },
    {
      key: 'namespace',
      header: 'Namespace',
      priority: 2,
      // Namespace names are unbounded, so this is the one column here that had neither a width nor
      // a cap — the `truncate` did nothing and the column grew to its longest row.
      max: '150px',
      render: e => <span className="mono truncate text-[12px]">{e.namespace ?? 'cluster-scoped'}</span>
    },
    {
      key: 'resource',
      header: 'Resource',
      priority: 1,
      max: '220px',
      render: e => {
        const kind = e.kind ? linkableKind(e.kind) : null;
        // A denied request may name an object that was never created — there is nothing to open, and
        // a link that resolves to "not found" would read as a deleted resource rather than a
        // rejected one.
        return kind && e.name && e.decision !== 'denied' ? (
          <ResourceLink refTo={{ kind, namespace: e.namespace, name: e.name }} />
        ) : (
          <span className="truncate" title={e.decision === 'denied' ? 'This request was rejected, so no such object exists to open' : undefined}>
            {e.name ?? 'resource not named'}
          </span>
        );
      }
    },
    {
      key: 'message',
      header: 'Message',
      priority: 3,
      max: '260px',
      render: e => (
        <span className="line-clamp-2 text-[13px] text-muted" title={e.message}>
          {e.message}
        </span>
      )
    },
    {
      key: 'source',
      header: 'Source',
      priority: 3,
      width: '124px',
      render: e => <span className="mono text-[12px] text-muted">{e.source}</span>
    }
  ];

  return (
    <div className="space-y-6">
      {/* The backend's own sentence for why this tab can or cannot answer, printed verbatim. */}
      <CapabilityNotice capability={data.capability} />

      {/* ------------------------------------------------------------------ the verdict */}
      <div className="rounded-[8px] border border-line bg-surface p-4">
        <p className="flex items-center gap-2 text-[16px] font-medium">
          <Dot tone={data.available ? 'ok' : 'unknown'} />
          {data.available ? 'Admission decisions are being recorded' : 'Admission denial activity unavailable'}
        </p>
        {/*
          This paragraph carries only what the `CapabilityNotice` above it does NOT say. It used to
          open "No source on this cluster records what Gatekeeper decided at admission time", which
          is the notice's sentence again in different words — the third statement of one fact on a
          single screen, counting the empty state below. What is genuinely only here is why the audit
          count is not a stand-in for a denial count, so that is all that is left.
        */}
        <p className="mt-1.5 max-w-[100ch] text-[14px] text-muted">
          {data.available
            ? 'At least one runtime source below is publishing decisions, so the entries here are actual admission outcomes.'
            : 'This is a gap in instrumentation, not evidence that nothing was denied — and it is why this tab shows no number rather than reusing the audit’s violation count, which counts objects that already exist and never counts a rejected request.'}
        </p>
      </div>

      {/* ------------------------------------------------------------------ the two sources */}
      <Section label="Sources">
        <ul className="divide-y divide-line">
          {data.sources.map(s => (
            <li key={s.id} className="flex flex-col gap-1 py-3">
              <span className="flex items-center gap-2 text-[14px] font-medium">
                <Dot tone={s.available ? 'ok' : 'unknown'} />
                {s.label}
                <span className="mono text-[12px] text-muted">{s.available ? 'available' : 'not available'}</span>
              </span>
              {/* The specific knob, named. "Unavailable" without the reason is not actionable. */}
              <span className="max-w-[100ch] text-[13px] text-muted">{s.detail}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ------------------------------------------------------------------ what IS running */}
      {data.audit && (
        <Section label="What is running instead">
          <p className="max-w-[100ch] text-[13px] text-muted">
            {data.audit.present ? (
              <>
                The Gatekeeper audit controller is running
                {data.audit.intervalSeconds !== null && (
                  <>
                    {' '}
                    every <span className="mono text-text">{data.audit.intervalSeconds}s</span>
                  </>
                )}
                {data.audit.violationsLimit !== null && (
                  <>
                    , itemising at most{' '}
                    <span className="mono text-text">{data.audit.violationsLimit}</span> violations per constraint
                  </>
                )}
                . It evaluates objects that already exist — so it will report a resource that was created before its
                policy, and it will never report a request that was rejected.
              </>
            ) : (
              'The Gatekeeper audit controller could not be found either, so neither runtime decisions nor periodic violation scans are being recorded on this cluster.'
            )}
          </p>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => go({ params: { opa: 'violations' } })}
              className="inline-flex h-8 items-center rounded-[6px] border border-line bg-raised px-3 text-[13px] hover:border-line-strong"
            >
              View the {opa.summary.auditViolationTotal} audit {opa.summary.auditViolationTotal === 1 ? 'violation' : 'violations'}
            </button>
          </div>
        </Section>
      )}

      {/* ------------------------------------------------------------------ entries, when there are any */}
      <Section label={`Decisions${data.entries.length > 0 ? ` (${data.entries.length})` : ''}`}>
        <DataTable
          columns={columns}
          rows={data.entries}
          shed="mid"
          rowKey={e => e.id}
          empty={
            <div className="py-8 text-center">
              {/*
                The required sentence, verbatim and in this order: what is missing, then what is
                still true. An operator who reads only the first half would conclude the console
                knows nothing about policy on this cluster, and the audit findings are right there.
              */}
              <p className="text-[14px] font-medium text-text">
                {data.available
                  ? 'A source is available but has reported no decision in the window read.'
                  : 'Runtime admission decisions are not available.'}
              </p>
              <p className="mx-auto mt-1.5 max-w-[80ch] text-[13px] text-muted">
                {data.available
                  ? 'The source below answered and had nothing to report for this period.'
                  : 'Current Gatekeeper audit findings remain available in the Violations tab.'}
              </p>
              {!data.available && (
                <button
                  type="button"
                  onClick={() => go({ params: { opa: 'violations' } })}
                  className="mt-3 inline-flex h-8 items-center rounded-[6px] border border-line bg-raised px-3 text-[13px] hover:border-line-strong"
                >
                  Open the Violations tab
                </button>
              )}
            </div>
          }
        />
      </Section>

      {/* Deliberately no complete admission request bodies anywhere on this tab: a request body
          carries the object being admitted, which for a Secret is the Secret. Only the decision,
          the policy and the object's identity would ever be rendered here. */}
    </div>
  );
}
