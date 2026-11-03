/**
 * The Overview's Namespaces tile: how many namespaces, how many pods, how they split by type, and
 * the way into **Namespaces & Workloads → Namespaces**.
 *
 * It sits in the "What to look at" grid but carries no health verdict of its own — the server
 * sends no summary group for namespaces, and a pill invented here would be the one tile on the grid
 * whose verdict nobody else can reproduce. Per-namespace status lives on the tab it opens.
 *
 * The counts come from `namespaceTypeCounts` over `/clusters/:id/namespaces`, the same function and
 * the same read the Namespaces table uses, so the two numbers are one number.
 */

import { useCallback, useMemo } from 'react';
import { api } from '../../api';
import { useAsync } from '../../useAsync';
import { InfoTip, Pill } from '../../components/ui';
import { Icon } from '../../components/icons';
import { namespaceTypeCounts } from './namespace-table';
import { TAB_LABEL, sectionLabel, type Tab } from './tabs';

const SEGMENTS = [
  { key: 'application', label: 'application', fill: 'bg-ok' },
  { key: 'system', label: 'system', fill: 'bg-line-strong' },
  { key: 'other', label: 'other', fill: 'bg-unknown' }
] as const;

export function NamespacesTile({ id, onOpen }: { id: string; onOpen: (tab: Tab, section?: string) => void }): JSX.Element {
  const ns = useAsync(useCallback(() => api.namespaces(id), [id]), 0, id);
  const payload = ns.data?.ok ? ns.data.data : null;
  const counts = useMemo(
    () => (payload ? namespaceTypeCounts(payload.namespaces ?? [], payload.summary) : null),
    [payload]
  );
  const where = `${TAB_LABEL.workloads} → ${sectionLabel('workloads', 'namespaces') ?? 'Namespaces'}`;

  return (
    <div className="group relative rounded-[8px] border border-line bg-base px-4 py-3.5 text-left transition-colors hover:border-line-strong hover:bg-raised">
      <button
        type="button"
        onClick={() => onOpen('workloads', 'namespaces')}
        className="absolute inset-0 rounded-[8px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        aria-label={`Namespaces — open ${where}`}
      />
      <div className="pointer-events-none relative flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[14px] font-medium text-text">
          <Icon name="layers" size={16} className="text-muted" />
          <span>Namespaces</span>
          <span className="pointer-events-auto relative z-10">
            <InfoTip
              title="Namespaces"
              text="Every namespace on the cluster, split by the server's system classification. Pods are counted from a cluster-wide pod list; no total is shown when that list was refused or came back short."
            />
          </span>
        </span>
        {((ns.error && !payload) || counts?.list === 'unavailable') && <Pill tone="unknown">Unavailable</Pill>}
      </div>

      {counts?.list === 'unavailable' ? (
        <p className="pointer-events-none relative mt-2 text-[13px] text-muted">
          The namespace list was not read, so there is no count to show.
        </p>
      ) : counts ? (
        <>
          <p className="pointer-events-none relative mt-2 text-[13px] text-text">
            {counts.list === 'truncated' && <span className="text-muted">at least </span>}
            <span className="mono tabular-nums font-semibold">{counts.total}</span> namespace{counts.total === 1 ? '' : 's'}
            <span className="text-muted"> · </span>
            {counts.pods === null ? (
              <span className="text-muted">pod count unavailable</span>
            ) : (
              <>
                <span className="mono tabular-nums font-semibold">{counts.pods}</span> pod{counts.pods === 1 ? '' : 's'}
              </>
            )}
          </p>
          {counts.total > 0 && (
            <div
              className="pointer-events-none relative mt-2 flex h-[6px] w-full overflow-hidden rounded-[2px] bg-raised"
              role="img"
              aria-label={`${counts.application} application, ${counts.system} system, ${counts.other} other`}
            >
              {SEGMENTS.map(s =>
                counts[s.key] > 0 ? (
                  <span key={s.key} className={`h-full ${s.fill}`} style={{ width: `${(counts[s.key] / counts.total) * 100}%` }} />
                ) : null
              )}
            </div>
          )}
          <p className="pointer-events-none relative mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-muted">
            {SEGMENTS.filter(s => s.key !== 'other' || counts.other > 0).map(s => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className={`inline-block h-[8px] w-[8px] rounded-full ${s.fill}`} aria-hidden />
                <span className="mono tabular-nums text-text">{counts[s.key]}</span> {s.label}
              </span>
            ))}
          </p>
        </>
      ) : ns.error ? (
        <p className="pointer-events-none relative mt-2 text-[13px] text-muted">The namespace list was not read ({ns.error.code}).</p>
      ) : (
        <div className="mt-2.5 h-[13px] w-4/5 animate-pulse rounded bg-raised" />
      )}

      <p className="pointer-events-none relative mt-2 text-[12px] text-accent/80 group-hover:text-accent group-focus-within:text-accent">
        Open Namespaces &rarr;
      </p>
    </div>
  );
}
