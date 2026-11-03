/** Successful request monitoring from the same bounded Envoy access-log window as Service Flows. */
import type { ReactNode } from 'react';
import type { Trace } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { Section } from '../../components/layout';
import { Empty, Pill } from '../../components/ui';
import { Count, type MetricStatus } from '../../components/unavailable';
import { ago } from '../../format';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { p95Text } from './service-map-layout';
import { ms, p95Of } from './traces-view';

/** A figure above the table. A window that was not read is a dash with its reason, never a 0. */
function Tile({ label, status, tone = '', children }: { label: string; status: MetricStatus; tone?: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] text-muted">{label}</p>
      <p className={`mono text-[18px] ${tone}`}>{status.state === 'unavailable' ? <Count status={status} value={null} size="md" /> : children}</p>
    </div>
  );
}

/**
 * What the empty table says. On a capped window the collector dropped journeys before this list was
 * built, so an empty one speaks for the kept journeys, not the window. The header checkbox stays the
 * one way to include liveness polls, so the capped copy offers no button of its own.
 */
function emptyCopy(noEvidence: boolean, kept: string | null, showPolls: boolean): { title: string; hint: string; offerPolls: boolean } {
  if (noEvidence) return { title: 'Successful requests not read', hint: 'No proxy evidence was available, so this is not a zero.', offerPolls: false };
  if (kept) return { title: 'No successful requests among the kept journeys', hint: `The cap left the rest of the window unexamined (${kept}).`, offerPolls: false };
  return { title: 'No successful requests in this window', hint: showPolls ? 'Try a wider tail or re-read.' : 'Successful liveness polls are hidden from this read.', offerPolls: !showPolls };
}

export function SuccessfulRequests({ rows, status, kept, noEvidence, showPolls, onShowPolls, onOpen }: { rows: Trace[]; status: MetricStatus; kept: string | null; noEvidence: boolean; showPolls: boolean; onShowPolls: (show: boolean) => void; onOpen: (traceId: string) => void }): JSX.Element {
  const { p95, samples } = p95Of(rows);
  const none = emptyCopy(noEvidence, kept, showPolls);
  const columns: Column<Trace>[] = [
    { key: 'result', header: 'Result', pin: true, priority: 1, width: '76px', render: t => <Pill tone="ok">{t.finalStatus}</Pill> },
    {
      key: 'request', header: 'Request', priority: 1, max: '300px',
      render: t => <span className="mono block truncate text-[12px]" title={`${t.method ?? ''} ${t.path ?? ''}`}>{t.method && <span className="text-muted">{t.method} </span>}{t.path ?? '—'}</span>
    },
    { key: 'service', header: 'Host', priority: 2, max: '180px', render: t => <span className="mono block truncate text-[12px] text-muted" title={t.authority ?? undefined}>{t.authority ?? '—'}</span> },
    { key: 'duration', header: 'Duration', ...NUMERIC, priority: 1, width: '88px', sortValue: t => t.totalDurationMs ?? -1, render: t => <span className="mono text-[13px]">{ms(t.totalDurationMs)}</span> },
    { key: 'hops', header: 'Seen', ...NUMERIC, priority: 1, width: '64px', sortValue: t => t.hopCount, render: t => <span className="mono text-[13px]">{t.hopCount}</span> },
    { key: 'time', header: 'Started', ...NUMERIC, priority: 3, width: '90px', sortValue: t => t.startTime ? Date.parse(t.startTime) : 0, render: t => <span className="text-[12px] text-muted">{t.startTime ? ago(t.startTime) : '—'}</span> }
  ];
  return (
    <Section
      compactHint
      title="Successful requests"
      hint="Completed with a 2xx or 3xx edge result and no observed failed hop. This reflects the access-log window and proxies read, not an unobserved full request topology."
      action={
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" checked={showPolls} onChange={e => onShowPolls(e.target.checked)} />
          Include successful liveness polls
        </label>
      }
    >
      <div className="border-b border-line pb-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile label="Successful" status={status} tone="text-ok">{rows.length}</Tile>
          <Tile label="p95 duration" status={status}>{p95Text(p95, samples, ms)}</Tile>
          <Tile label="Observed hops" status={status}>{rows.reduce((n, t) => n + t.hopCount, 0)}</Tile>
        </div>
        {/* The rows are the kept journeys (the collector's cap), so on a capped window every figure above counts those only. */}
        {kept && status.state !== 'unavailable' && <p className="mt-2 text-[11px] text-muted">Figures cover the kept journeys only ({kept}).</p>}
      </div>
      <div className={`${CARD_TABLE_CLASS} mt-3`}>
        <DataTable
          id="traces.successful"
          columns={columns}
          rows={rows}
          rowKey={t => t.traceId}
          onSelect={t => onOpen(t.traceId)}
          empty={<Empty title={none.title} hint={none.hint} action={none.offerPolls ? <button type="button" className="rounded-[6px] border border-line px-3 py-1.5 text-[13px] text-muted hover:border-line-strong hover:text-text" onClick={() => onShowPolls(true)}>Include liveness polls</button> : undefined} />}
        />
      </div>
    </Section>
  );
}
