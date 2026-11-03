/**
 * Resources — every live object related to this release, grouped and typed by how it got here.
 *
 * ## The claim this tab is careful about
 *
 * A release's *rendered manifest* and a release's *live footprint* are different sets, and calling
 * both "the release's resources" is the mistake this tab exists to avoid. Helm renders a Deployment;
 * Kubernetes then creates a ReplicaSet and Pods that appear in no manifest, and a PVC created by a
 * StatefulSet outlives the release entirely. So every row carries a Relationship, and the
 * relationship carries the field that proves it — `evidence`, straight from the server, never a
 * name match.
 *
 * ## Grouping
 *
 * `GROUP_ORDER` is decided once in `shared.ts` and the server tags each resource with its group, so
 * the Resources tab, the Architecture graph and the Insights tiles cannot disagree about whether a
 * Service is Networking.
 *
 * ## Freshness
 *
 * Every row on this tab came out of one fan-out at `collectedAt`, so the Freshness column reads the
 * same for all of them. That is stated in the hint rather than dressed up per row: pretending each
 * object was observed at its own time would be a fabrication, and leaving the column out would hide
 * how old the whole reading is.
 */
import { useMemo, useState } from 'react';
import { COLUMN_INFO } from '../../components/table/column-info';
import type { HelmRelatedData, HelmRelatedResource } from '../../api';
import { Column, DataTable } from '../../components/DataTable';
import { Section } from '../../components/layout';
import { Empty, Pill } from '../../components/ui';
import { ago } from '../../format';
import { orderGroups, RELATIONSHIP, liveTone, isSupersededReplicaSet } from './shared';

export interface ResourceFilters {
  q: string;
  kind: string;
  group: string;
  relationship: string;
}

export function filterResources(rows: HelmRelatedResource[], f: ResourceFilters): HelmRelatedResource[] {
  const needle = f.q.trim().toLowerCase();
  return rows.filter(r => {
    if (f.kind !== 'all' && r.kind !== f.kind) return false;
    if (f.group !== 'all' && r.group !== f.group) return false;
    if (f.relationship !== 'all' && r.relationship !== f.relationship) return false;
    if (!needle) return true;
    return (
      r.name.toLowerCase().includes(needle) ||
      r.kind.toLowerCase().includes(needle) ||
      (r.namespace ?? '').toLowerCase().includes(needle) ||
      r.evidence.toLowerCase().includes(needle)
    );
  });
}

/** A `<select>` in the console's filter idiom. */
function Filter({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-muted">
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-7 rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function HelmResources({
  data,
  filters,
  onFilters,
  selected,
  onSelect
}: {
  data: HelmRelatedData;
  filters: ResourceFilters;
  onFilters: (next: Partial<ResourceFilters>) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
}): JSX.Element {
  const rows = useMemo(() => filterResources(data.resources, filters), [data.resources, filters]);

  const kinds = useMemo(
    () => [...new Set(data.resources.map(r => r.kind))].sort(),
    [data.resources]
  );
  const groups = useMemo(() => orderGroups([...new Set(data.resources.map(r => r.group))]), [data.resources]);
  const relationships = useMemo(
    () => [...new Set(data.resources.map(r => r.relationship))],
    [data.resources]
  );

  const [showSuperseded, setShowSuperseded] = useState(false);

  /**
   * A filter that names ReplicaSets — by Kind, or by a search term one of them matches — overrides
   * the collapse. Hiding a row an operator explicitly searched for is the one thing worse than
   * showing twenty-two of them.
   */
  const forced = filters.kind === 'ReplicaSet' || filters.q.trim().length > 0;
  const reveal = showSuperseded || forced;

  const grouped = useMemo(() => {
    const byGroup = new Map<string, HelmRelatedResource[]>();
    for (const r of rows) {
      const list = byGroup.get(r.group);
      if (list) list.push(r);
      else byGroup.set(r.group, [r]);
    }
    for (const list of byGroup.values()) {
      list.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    }
    return orderGroups([...byGroup.keys()]).map(g => {
      const all = byGroup.get(g)!;
      const superseded = all.filter(isSupersededReplicaSet);
      return { group: g, all, rows: all.filter(r => !isSupersededReplicaSet(r)), superseded };
    });
  }, [rows]);

  /** Rows hidden right now, so the toggle, the group badges and the Section label agree on one number. */
  const supersededTotal = grouped.reduce((n, g) => n + g.superseded.length, 0);
  const hiddenCount = reveal ? 0 : supersededTotal;
  const shownCount = rows.length - hiddenCount;

  const readAge = ago(data.collectedAt);

  const columns: Column<HelmRelatedResource>[] = [
    /**
     * `max`, not `width`: measured at 1440, `width: '150px'` rendered **181px** on the Security and
     * Policy group, whose longest Kind is `ValidatingWebhookConfiguration`. A `title` carries the
     * full Kind, because a clipped Kind is the one cell an operator cannot infer from its neighbours.
     */
    { key: 'kind', header: 'Kind', pin: true, priority: 1, max: '160px', render: r => <span className="mono" title={r.kind}>{r.kind}</span> },
    {
      key: 'name',
      header: 'Name',
      priority: 1,
      /**
       * `max-w-full` on the button inside bounds nothing: it resolves against the `td`, which has no
       * width of its own under `table-layout: auto`, so the column grew to the longest resource name.
       * Measured at 1440 across the six relationship tables this page renders, Name came out between
       * 264px and 536px, and the 536px one put its table 253px past a 1132px container. 280px keeps
       * that table inside its container; the full `kind namespace/name` stays in the `title`.
       */
      max: '280px',
      render: r => (
        <button
          type="button"
          onClick={() => onSelect(r.id)}
          className="mono max-w-full truncate text-left underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent"
          title={`${r.kind} ${r.namespace ? `${r.namespace}/` : ''}${r.name} — open details`}
        >
          {r.name}
        </button>
      )
    },
    {
      key: 'namespace',
      header: 'Namespace',
      priority: 2,
      /** Rendered 214px against a declared `width: '160px'` — long namespaces, uncapped. */
      max: '160px',
      render: r => (
        <span className="mono text-muted" title={r.namespace ?? 'This Kind is cluster-scoped — it has no namespace.'}>
          {r.namespace ?? 'cluster-scoped'}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Native status',
      priority: 1,
      width: '170px',
      render: r =>
        r.status ? (
          <Pill tone={liveTone(r)}>{r.status.text}</Pill>
        ) : (
          <span className="text-muted" title={`A ${r.kind} publishes no status of its own — it either exists or it does not.`}>
            —
          </span>
        )
    },
    {
      key: 'age',
      header: 'Age',
      info: COLUMN_INFO.age,
      priority: 2,
      align: 'right',
      width: '96px',
      render: r => <span className="mono text-muted">{r.createdAt ? ago(r.createdAt) : 'unknown'}</span>
    },
    {
      key: 'relationship',
      header: 'Relationship',
      priority: 1,
      width: '190px',
      render: r => (
        <span title={`${RELATIONSHIP[r.relationship].why}\n\nEvidence: ${r.evidence}`}>
          <Pill tone={RELATIONSHIP[r.relationship].tone}>{RELATIONSHIP[r.relationship].label}</Pill>
        </span>
      )
    },
    {
      key: 'freshness',
      header: 'Freshness',
      priority: 3,
      align: 'right',
      width: '110px',
      render: () => (
        <span
          className="mono text-muted"
          title="Every row on this tab came from one read of the cluster, so they share a freshness. Refresh to take a new one."
        >
          {readAge}
        </span>
      )
    }
  ];

  return (
    <Section
      title="Live resources"
      label={String(shownCount)}
      hint={`Every object this release owns, manages or reaches, read ${readAge}. The label counts what is listed below; the release's full live footprint is ${data.counts.total} object${data.counts.total === 1 ? '' : 's'}. The Relationship column says how each one got here, and its tooltip names the field that proves it.`}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filters.q}
            onChange={e => onFilters({ q: e.target.value })}
            placeholder="Search name, kind, evidence"
            aria-label="Search resources"
            className="h-7 w-[220px] rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text placeholder:text-muted"
          />
          <Filter
            label="Group"
            value={filters.group}
            onChange={v => onFilters({ group: v })}
            options={[{ value: 'all', label: 'all' }, ...groups.map(g => ({ value: g, label: g }))]}
          />
          <Filter
            label="Kind"
            value={filters.kind}
            onChange={v => onFilters({ kind: v })}
            options={[{ value: 'all', label: 'all' }, ...kinds.map(k => ({ value: k, label: k }))]}
          />
          <Filter
            label="Relationship"
            value={filters.relationship}
            onChange={v => onFilters({ relationship: v })}
            options={[
              { value: 'all', label: 'all' },
              ...relationships.map(r => ({ value: r, label: RELATIONSHIP[r].label }))
            ]}
          />
        </div>
      }
    >
      {rows.length === 0 ? (
        <Empty
          title={data.resources.length === 0 ? 'No live resources found for this release' : 'No resource matches these filters'}
          hint={
            data.resources.length === 0
              ? 'The rendered manifest may be empty, or every Kind’s live list may have been refused — check the notice above the tabs before reading this as an empty release.'
              : 'Clear a filter to widen the list.'
          }
        />
      ) : (
        <div className="space-y-5">
          {supersededTotal > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]">
              <span className="text-muted">
                <span className="mono text-text">{supersededTotal}</span> superseded ReplicaSet
                {supersededTotal === 1 ? '' : 's'} — scaled to zero, kept by Kubernetes as rollout
                history
              </span>
              {forced ? (
                <span className="text-muted/70">shown because a filter names them</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSuperseded(v => !v)}
                  aria-expanded={showSuperseded}
                  className="underline decoration-dotted decoration-line underline-offset-[3px] text-muted transition-colors hover:text-accent hover:decoration-accent"
                >
                  {showSuperseded ? 'hide them' : 'show them'}
                </button>
              )}
            </div>
          )}
          {grouped.map(g => {
            const visible = reveal ? g.all : g.rows;
            if (visible.length === 0) return null;
            const hiddenHere = reveal ? 0 : g.superseded.length;
            return (
              <div key={g.group}>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{g.group}</h3>
                  <span className="mono text-[12px] text-muted/70">{visible.length}</span>
                  {hiddenHere > 0 && (
                    <span
                      className="text-[12px] text-muted/70"
                      title="Earlier-generation ReplicaSets holding zero Pods. They are part of this release’s live footprint; use “show them” above to list them."
                    >
                      +{hiddenHere} superseded
                    </span>
                  )}
                </div>
                  {/*
                  Measured at 1440: the seven declared widths sum to 1166px in a 1132px container, so
                  no cap can make them all fit — something has to shed. `wide` drops priority 3 below
                  1300px, which is Freshness, and Freshness is the right column to lose: it reads
                  identically on every row and the Section hint already states it once. Priority 2
                  only sheds below 1000px, so Namespace and Age survive here.
                */}
                <DataTable
                  columns={columns}
                  rows={visible}
                  rowKey={r => r.id}
                  shed="wide"
                  selectedKey={selected ?? undefined}
                  onSelect={r => onSelect(r.id)}
                  empty={<Empty title="None in this group" />}
                />
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
