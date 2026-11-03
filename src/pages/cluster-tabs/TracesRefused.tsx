/**
 * Distributed Traces → **Refused Requests**: every request a proxy refused itself, edge and
 * sidecars, with what it tried and the AuthorizationPolicy that decided it — moved here from
 * Access control (Task 4's card) because it belongs beside the other views of the same access-log
 * window rather than under Traffic's Ingress screens.
 *
 * `ingress.refused` comes off `/traffic-errors`, a different route from the one the other four
 * Traces sub-tabs share (`traces.js`) — but this component does not read it itself. `TracesTab`
 * owns the one `useAsync` call, because its `SubTabs` chip needs the row count before this section
 * is ever opened; a second, independent fetch here would cost a second read and let this screen and
 * the tab's own chip disagree about the same cluster.
 *
 * Refused is never rendered as an attack, a hacker or malice: it is a proxy decision this console
 * can name (a routing miss, an AuthorizationPolicy DENY) and nothing about who sent the request —
 * clients are counted, never listed, and this screen shows no address.
 */
import { useMemo, useState } from 'react';
import type { IngressRefusedRow, RefusedDecider, TrafficData } from '../../api';
import { DataTable, NUMERIC, type Column } from '../../components/DataTable';
import { Empty, ErrorBanner, Pill, Skeleton } from '../../components/ui';
import { LiveYaml } from '../../components/LiveYaml';
import { FilterBar, FilterSelect, SearchBox } from '../../components/filters';
import { CARD_TABLE_CLASS } from '../../components/table/card-table';
import { ago } from '../../format';
import { classWord, decidedByText, filterRefused, refusedFilters } from './ingress/refused-view';
import { Num } from './ingress/parts';

export function TracesRefused({
  clusterId,
  payload,
  failure,
  initial,
  reload
}: {
  clusterId: string;
  /** `undefined` until the read lands, however it lands. */
  payload: TrafficData | undefined;
  /** A transport failure or an `{ok: false}` envelope — either way, this read failed. */
  failure: { code?: string; message?: string } | null;
  initial: boolean;
  reload: () => void;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [policy, setPolicy] = useState<string | null>(null);
  const [klass, setKlass] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [yamlOf, setYamlOf] = useState<{ namespace: string; name: string } | null>(null);

  const refused = payload?.ingress.refused;
  const all = refused?.rows ?? [];
  const options = useMemo(() => refusedFilters(all), [all]);

  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const byFilter = filterRefused(all, { policy, klass, status });
    if (!needle) return byFilter;
    return byFilter.filter(r => {
      const policyText = decidedByText(r).text;
      return [r.authority, r.path, policyText].filter(Boolean).some(v => String(v).toLowerCase().includes(needle));
    });
  }, [all, policy, klass, status, needle]);

  const activeCount = (policy !== null ? 1 : 0) + (klass !== null ? 1 : 0) + (status !== null ? 1 : 0);
  const resetFilters = () => {
    setPolicy(null);
    setKlass(null);
    setStatus(null);
  };

  const columns: Column<IngressRefusedRow>[] = [
    {
      key: 'count',
      header: 'Count',
      ...NUMERIC,
      width: '72px',
      sortValue: r => r.count,
      render: r => <Num value={r.count} />
    },
    {
      key: 'decided',
      header: 'Decided by',
      max: '260px',
      render: r => <DecidedByCell row={r} onOpen={d => setYamlOf({ namespace: d.namespace, name: d.name })} />
    },
    {
      key: 'time',
      header: 'Time',
      align: 'left',
      priority: 1,
      sortValue: r => r.lastSeen ?? '',
      render: r => (
        <span className="mono text-[12px] text-muted" title={r.firstSeen ? `first seen ${r.firstSeen}` : undefined}>
          {ago(r.lastSeen)}
        </span>
      )
    },
    {
      key: 'host',
      header: 'Host',
      pin: true,
      max: '220px',
      sortValue: r => r.authority ?? '',
      render: r => (
        <span className="mono block truncate text-[12px]" title={r.authority ?? undefined}>
          {r.authority ?? (r.tlsBeforeHttp ? 'no SNI' : 'no Host header')}
        </span>
      )
    },
    {
      key: 'class',
      header: 'Class',
      sortValue: r => classWord(r.edgeClass),
      render: r => <span className="text-[12px]">{classWord(r.edgeClass)}</span>
    },
    {
      key: 'method',
      header: 'Method',
      sortValue: r => r.method ?? '',
      render: r => (
        <span className="mono text-[12px]" title={r.tlsBeforeHttp ? 'TLS refused before HTTP: no method was sent' : undefined}>
          {r.tlsBeforeHttp ? '—' : r.method ?? '—'}
        </span>
      )
    },
    {
      key: 'path',
      header: 'Path',
      max: '260px',
      sortValue: r => r.path ?? '',
      render: r => (
        <span className="mono block truncate text-[12px]">{r.tlsBeforeHttp ? 'TLS refused before HTTP' : r.path ?? '—'}</span>
      )
    },
    {
      key: 'code',
      header: 'Code',
      width: '76px',
      sortValue: r => r.code,
      render: r => <Pill tone={r.code === 0 ? 'unknown' : 'bad'}>{r.code === 0 ? 'none' : r.code}</Pill>
    },
    {
      key: 'why',
      header: 'Why',
      priority: 2,
      max: '240px',
      sortValue: r => r.reason,
      render: r => (
        <span
          className="block truncate text-[12px]"
          title={[r.reason, ...r.responseCodeDetails, ...r.responseFlags].filter(Boolean).join(' · ')}
        >
          {r.reason}
        </span>
      )
    },
  ];

  if (initial) return <Skeleton rows={6} />;

  if (failure && !payload) {
    return (
      <div className="space-y-3">
        <ErrorBanner code={failure.code ?? 'UNKNOWN'} message={failure.message ?? 'this cluster did not answer'} />
        <button type="button" className="text-[12px] text-muted hover:text-text underline" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  if (!refused) {
    return <Empty title="Refused requests" hint="This server did not send refused requests." />;
  }

  return (
    <div className="space-y-3">
      <FilterBar
        activeCount={activeCount}
        onReset={resetFilters}
        resultLine={
          <span className="whitespace-nowrap">
            <span className="font-medium tabular-nums text-text">{rows.length === all.length ? `${all.length}` : `${rows.length} of ${all.length}`}</span>{' '}
            row{all.length === 1 ? '' : 's'}
          </span>
        }
      >
        <label className="relative flex min-w-[180px] max-w-[280px] flex-1 [&>input]:min-w-[180px]">
          <span className="sr-only">Search refused requests</span>
          <SearchBox value={search} onChange={setSearch} placeholder="Search host, path or policy" />
        </label>
        <FilterSelect
          label="Policy"
          value={policy ?? ''}
          onChange={v => setPolicy(v || null)}
          options={[{ value: '', label: 'All' }, ...options.policies.map(p => ({ value: p, label: p }))]}
        />
        <FilterSelect
          label="Class"
          value={klass ?? ''}
          onChange={v => setKlass(v || null)}
          options={[{ value: '', label: 'All' }, ...options.classes.map(c => ({ value: c, label: c }))]}
        />
        <FilterSelect
          label="Status"
          value={status === null ? '' : String(status)}
          onChange={v => setStatus(v === '' ? null : Number(v))}
          options={[{ value: '', label: 'All' }, ...options.statuses.map(s => ({ value: String(s), label: s === 0 ? 'none' : String(s) }))]}
        />
      </FilterBar>
      {refused.policiesUnavailable && (
        <p className="text-[12px] text-warn">AuthorizationPolicies could not be read, so no row can name the policy that decided it.</p>
      )}
      <div className={CARD_TABLE_CLASS}>
        <DataTable
          id="traces.refused"
          shed="mid"
          columns={columns}
          rows={rows}
          rowKey={r => `${r.tier}|${r.authority}|${r.method}|${r.path}|${r.code}|${decidedByText(r).text}`}
          empty={<Empty title="No refused requests found" />}
        />
      </div>
      {refused.rowsFound > refused.rows.length && (
        <p className="text-[12px] text-muted">
          {refused.rows.length} of {refused.rowsFound} groups shown, most refused first.
        </p>
      )}
      {yamlOf && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="mono text-[12px]">AuthorizationPolicy {yamlOf.namespace}/{yamlOf.name}</span>
            <button type="button" className="text-[12px] text-muted hover:text-text" onClick={() => setYamlOf(null)}>
              Close
            </button>
          </div>
          <LiveYaml clusterId={clusterId} kind="AuthorizationPolicy" namespace={yamlOf.namespace} name={yamlOf.name} fetchKey={`${yamlOf.namespace}/${yamlOf.name}`} />
        </div>
      )}
    </div>
  );
}

function DecidedByCell({ row, onOpen }: { row: IngressRefusedRow; onOpen: (d: RefusedDecider) => void }): JSX.Element {
  const decided = decidedByText(row);
  if (decided.unknown) return <span className="text-[12px] text-warn">not read</span>;
  if (!row.decidedBy || row.decidedBy.length === 0) return <span className="text-[12px] text-muted">{decided.text}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.decidedBy.map((d, i) => (
        <span key={`${d.namespace}/${d.name}`}>
          {i > 0 && <span className="text-[12px] text-muted"> or </span>}
          <button
            type="button"
            className="mono text-[12px] underline hover:text-text"
            onClick={e => {
              e.stopPropagation();
              onOpen(d);
            }}
          >
            {d.namespace}/{d.name}
          </button>
          {d.policyInferred && <span className="text-[12px] text-muted"> (inferred)</span>}
        </span>
      ))}
    </span>
  );
}
