/** Network Operations landing view: recent, observed request failures and their first failing hop. */
import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, DEFAULT_TRACES_TAIL, type Trace } from '../../api';
import { Card, Dot, ErrorBanner, Pill, Skeleton, type Tone } from '../../components/ui';
import { UnavailableNotice, envelopeScope } from '../../components/unavailable';
import { StaleReadNotice } from '../../components/StaleReadNotice';
import { ago } from '../../format';
import { useAsync } from '../../useAsync';
import { accessLogEvidence } from './access-log';
import { firstFailingNode } from './journey-status';

function rootOf(trace: Trace): { label: string; stage: string } {
  const first = trace.journeyPath && firstFailingNode(trace.journeyPath);
  if (first) return { label: first.label, stage: first.kind === 'gateway' ? 'Gateway' : 'Service' };
  if (trace.errorHop !== null && trace.errorHop > 0) {
    const hop = trace.hops[trace.errorHop - 1];
    if (hop) return {
      label: hop.to?.name ?? hop.observedBy.pod,
      stage: hop.role === 'ingress' ? 'Ingress' : 'Service'
    };
  }
  return { label: 'First failing hop unavailable', stage: 'Unknown' };
}

function outcome(trace: Trace): { label: string; tone: Tone; detail: string } {
  if (trace.class === 'security-refused') {
    const label = trace.entryRole === 'ingress' ? 'Blocked at ingress' : trace.entryRole === 'sidecar' ? 'Blocked in mesh' : 'Policy refusal';
    return { label, tone: 'warn', detail: 'Policy refusal; expected control-plane outcome, not an application error.' };
  }
  const root = rootOf(trace);
  if (trace.appError) return {
    label: root.stage === 'Service' ? 'Broken at service' : root.stage === 'Gateway' || root.stage === 'Ingress' ? 'Failed at ingress or upstream' : 'Application request failed',
    tone: 'bad',
    detail: `${root.stage}: ${root.label}`
  };
  return { label: trace.finalStatusClass === 'no-response' ? 'No response' : 'Request failed', tone: trace.finalStatusClass === 'client' ? 'warn' : 'unknown', detail: `${root.stage}: ${root.label}` };
}

function countText(value: number | undefined, readable: boolean): string {
  return readable && value !== undefined ? value.toLocaleString('en-US') : '—';
}

export default function NetworkOverview({ id }: { id: string }): JSX.Element {
  const [, setParams] = useSearchParams();
  const wantsFresh = useRef(false);
  const { data, error, loading, reload, stale } = useAsync(
    useCallback(() => {
      const fresh = wantsFresh.current;
      wantsFresh.current = false;
      return api.clusterTraces(id, { tailLines: DEFAULT_TRACES_TAIL }, { fresh });
    }, [id]),
    0,
    id,
    { subject: id }
  );
  const payload = data?.ok ? data.data : undefined;
  const log = payload?.accessLog;
  const w = payload?.window;
  const evidence = accessLogEvidence(log, w);
  const scope = envelopeScope(id, payload?.summary);
  const classes = payload?.summary.classCounts;
  const ingressBlocked = payload?.traces.filter(t => t.class === 'security-refused' && t.entryRole === 'ingress').length;
  // `appError` = true 5xx / upstream flags on app journeys — the application failures counter.
  // `hasError || security-refused` is wider (includes 4xx client errors) and is what the list shows.
  // We split them so the list stays honest about why a row appears when appError is false.
  const appErrorTraces = (payload?.traces ?? []).filter(t => t.appError);
  const securityTraces = (payload?.traces ?? []).filter(t => t.class === 'security-refused');
  const clientErrorTraces = (payload?.traces ?? []).filter(t => t.hasError && !t.appError && t.class !== 'security-refused');
  // Ordered: app errors first, then security refusals, then client-error-only rows.
  const affected = [...appErrorTraces, ...securityTraces, ...clientErrorTraces].slice(0, 8);
  // When the list has rows that are NOT appErrors, note the discrepancy so the counter makes sense.
  const listHasClientOnlyRows = clientErrorTraces.length > 0;

  const go = (section: 'journeys' | 'refused' | 'outbound', extra: Record<string, string> = {}) => setParams(prev => {
    const next = new URLSearchParams(prev);
    next.set('networkView', 'flows');
    next.set('section', section);
    next.delete('res');
    // The failures-only filter belongs to the card that sets it; every other card opens unfiltered.
    next.delete('outboundErrors');
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return next;
  }, { replace: true });

  const reRead = () => {
    wantsFresh.current = true;
    reload();
  };

  if (loading && !data) return <div className="py-4"><Skeleton rows={5} /></div>;
  if (data && !data.ok) return <div className="py-4"><ErrorBanner code={data.error?.code ?? 'UNKNOWN'} message={data.error?.message ?? 'this cluster did not answer'} /></div>;
  if (error && !payload) return <div className="py-4"><ErrorBanner code={error.code} message={error.message} /></div>;

  const refusedCount = classes?.['security-refused'];
  const outboundFailureCount = payload?.outbound?.errors;
  const appFailureCount = payload?.summary.appErrorTraces;
  const countsReadable = !evidence.noEvidence;
  const countCard = (title: string, value: number | undefined, note: string, action: () => void, tone: Tone) => (
    <button type="button" onClick={action} className="rounded-[8px] border border-line bg-base p-4 text-left transition-colors hover:border-line-strong hover:bg-raised">
      <span className="flex items-center gap-2 text-[12px] uppercase tracking-[0.06em] text-muted"><Dot tone={tone} />{title}</span>
      <span className="mono mt-2 block text-[26px] font-semibold tabular-nums text-text">{countText(value, countsReadable)}</span>
      <span className="mt-1 block text-[12px] text-muted">{note}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-4">
      <UnavailableNotice scope={scope} className="mb-3" />
      <StaleReadNotice stale={stale} loading={loading} failed={!!error} what="request journeys" />
      {evidence.noEvidence && (
        <div className="mb-4 rounded-[8px] border border-warn/40 bg-warn/5 px-4 py-3 text-[13px]">
          <p className="font-medium text-text">Request outcomes are unavailable</p>
          <p className="mt-1 text-muted">{log?.why ?? 'The access-log destination could not be confirmed.'} Counts below are withheld because this read cannot prove whether the cluster was quiet.</p>
        </div>
      )}
      {error && <div className="mb-3"><ErrorBanner code={error.code} message={error.message} /></div>}

      <Card title="Request health" action={<button type="button" onClick={reRead} className="rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted hover:text-text">Re-read</button>}>
        <p className="mb-3 text-[12px] text-muted">
          Bounded access-log sample · {w ? `${w.requestsParsed.toLocaleString()} requests from ${w.proxiesRead} of ${w.proxyCandidates} proxies` : 'no request window'}
          {payload?.summary.readAt ? ` · read ${ago(payload.summary.readAt)}` : ''}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {countCard(
            'Blocked at ingress',
            ingressBlocked,
            ingressBlocked === undefined ? 'Ingress classification is unavailable' : 'AuthorizationPolicy denials in sampled journeys',
            () => go('refused'),
            'warn'
          )}
          {countCard(
            'Outbound failures',
            outboundFailureCount,
            outboundFailureCount === undefined ? 'Outbound failure counts are unavailable' : 'Observed proxy failures; these do not prove a NetworkPolicy block',
            () => go('outbound', { outboundErrors: '1' }),
            'bad'
          )}
          {countCard(
            'Policy refusals',
            refusedCount,
            refusedCount === undefined ? 'Refusal classification is unavailable from this server' : 'Ingress and mesh refusals in sampled journeys',
            () => go('refused'),
            'warn'
          )}
          {countCard(
            'Application failures',
            appFailureCount,
            appFailureCount === undefined ? 'Application error classification is unavailable from this server' : '5xx or upstream failures on application journeys',
            () => go('journeys'),
            'bad'
          )}
        </div>
        {ingressBlocked !== undefined && ingressBlocked > 0 && (
          <p className="mt-3 text-[12px] text-muted">{ingressBlocked} of the displayed journeys were blocked at ingress. Open Blocked requests for the request and policy evidence.</p>
        )}
        {listHasClientOnlyRows && (
          <p className="mt-2 text-[12px] text-muted">
            <span className="font-medium text-text">Why the counter is lower than the list:</span>{' '}
            "Application failures" counts 5xx and upstream errors only. 4xx client errors (401, 404) appear below but are not counted — the cause is the caller, its token, or a missing route.
          </p>
        )}
      </Card>

      <Card title="Recent affected requests" className="mt-4" flush>
        {affected.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted">{countsReadable ? 'No affected request in this sample.' : 'No verdict: request logs were not readable.'}</p>
        ) : (
          <ul className="divide-y divide-line">
            {affected.map(trace => {
              const state = outcome(trace);
              const target = trace.class === 'security-refused' ? 'refused' : 'journeys';
              return (
                <li key={trace.traceId}>
                  <button type="button" onClick={() => go(target)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-raised/40">
                    <Pill tone={state.tone} size="sm">{state.label}</Pill>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-text">{[trace.method, trace.authority, trace.path].filter(Boolean).join(' ') || 'Request details unavailable'}</span>
                      <span className="block truncate text-[12px] text-muted">{state.detail}{trace.finalStatus !== null ? ` · HTTP ${trace.finalStatus}` : ''}</span>
                    </span>
                    <span className="mono shrink-0 text-[11px] text-muted">{trace.startTime ? ago(trace.startTime) : 'time unavailable'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={() => go('journeys')} className="text-[12px] text-accent hover:underline">Open Requests</button>
          <button type="button" onClick={() => go('refused')} className="text-[12px] text-accent hover:underline">Open Blocked requests</button>
        </div>
      </Card>
      <p className="mt-3 text-[11px] text-muted">Counts describe the bounded proxy-log sample, not cluster-wide request totals. External TCP observations and uncorrelated hops do not prove application success.</p>
    </div>
  );
}
