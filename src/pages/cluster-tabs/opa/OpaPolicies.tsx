/**
 * Policies — every Constraint on the cluster, riskiest first.
 *
 * One row per Constraint, plus one row for a ConstraintTemplate that has no Constraint at all,
 * because "declared and instantiated nowhere" is a policy state and it has no Constraint to hang
 * off. Clicking a row opens the drawer; nothing here mutates anything.
 */
import { useMemo } from 'react';
import type { OpaData, OpaPolicy } from '../../../api';
import { DataTable, type Column } from '../../../components/DataTable';
import { Empty, Pill } from '../../../components/ui';
import { UnavailableEmptyBody, type MetricStatus } from '../../../components/unavailable';
import { capabilityStatus } from '../../../capability';
import { Count } from '../../../components/unavailable';
import { FilterBar, FilterSelect, SearchBox } from '../../../components/filters';
import {
  ACTION_TONE,
  STATUS_TONE,
  auditLine,
  byRisk,
  filterPolicies,
  kindLine,
  scopeLine,
  type OpaFilters
} from './shared';
import { sourceLabel } from './library';
import { COLUMN_INFO } from '../../../components/table/column-info';

export function OpaPolicies({
  data,
  status,
  filters,
  setFilters,
  resetFilters,
  activeFilters,
  selectedId,
  onSelect
}: {
  data: OpaData;
  status: MetricStatus;
  filters: OpaFilters;
  setFilters: (patch: Partial<OpaFilters>) => void;
  resetFilters: () => void;
  activeFilters: number;
  selectedId: string | null;
  onSelect: (policy: OpaPolicy) => void;
}): JSX.Element {
  // Option lists built from the data itself, so a filter can never offer a value that matches
  // nothing — and the operator learns what this cluster actually contains from the dropdown.
  const kinds = useMemo(
    () => [...new Set(data.policies.flatMap(p => p.targetKinds.flatMap(t => t.kinds)))].sort(),
    [data.policies]
  );
  const categories = useMemo(() => [...new Set(data.policies.map(p => p.category))].sort(), [data.policies]);
  const namespaces = useMemo(
    () => [...new Set(data.policies.flatMap(p => p.namespaceScope.matchedNamespaces ?? []))].sort(),
    [data.policies]
  );

  // How many Constraints share each ConstraintTemplate. Built here rather than on the server
  // because it is a fact about the rows already sent, and a second source would be a second
  // chance to disagree.
  const constraintsPerTemplate = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of data.policies) {
      if (p.constraintName === null) continue;
      counts.set(p.templateName, (counts.get(p.templateName) ?? 0) + 1);
    }
    return counts;
  }, [data.policies]);

  const violationStatus = capabilityStatus(data.capabilities.violations, 'Audit violations');

  const rows = useMemo(() => filterPolicies(data.policies, filters).sort(byRisk), [data.policies, filters]);

  const columns: Column<OpaPolicy>[] = [
    {
      key: 'name',
      header: 'Policy',
      pin: true,
      max: '240px',
      render: p => (
        <div className="min-w-0">
          <div className="whitespace-normal font-medium [overflow-wrap:anywhere]" title={p.displayName}>
            {p.displayName}
          </div>
          <div
            className="mono whitespace-normal text-[12px] text-muted [overflow-wrap:anywhere]"
            title={`${p.constraintKind ?? 'no constraint kind'} — ConstraintTemplate ${p.templateName}`}
          >
            {p.constraintKind ?? 'no constraint kind'}
          </div>
        </div>
      )
    },
    {
      key: 'purpose',
      // Prose, so it sheds in the first tier rather than the second. At priority 2 it survived
      // alongside Category and Namespace scope and pushed Enforcement, Status and Violations off
      // the right edge — a paragraph outranking the three columns that answer "is this policy
      // enforcing, and is it failing". The full text is on the row's drawer either way.
      header: 'Purpose',
      priority: 3,
      max: '220px',
      render: p => (
        <span className="line-clamp-2 text-[13px] text-muted" title={p.purpose.text}>
          {p.purpose.text}
        </span>
      )
    },
    {
      // Replaces a ConstraintTemplate column. Gatekeeper requires a template's name to be its
      // Constraint kind lowercased, so that column repeated the line under every policy name and
      // spent 190px doing it; the template name is in that line's tooltip instead.
      key: 'source',
      header: 'Source',
      priority: 2,
      max: '190px',
      info: COLUMN_INFO.policySource,
      render: p => {
        const l = sourceLabel(p.library);
        return (
          <span title={l.title}>
            <Pill tone={l.tone}>{l.text}</Pill>
          </span>
        );
      }
    },
    {
      key: 'action',
      header: 'Enforcement',
      render: p => <Pill tone={ACTION_TONE[p.enforcementAction]}>{p.enforcementAction}</Pill>
    },
    {
      key: 'status',
      header: 'Status',
      max: '150px',
      render: p =>
        // The status pill carries the FIRST detected reason as its label when a policy enforces
        // nothing, rather than the word "inactive" — the reason is the actionable part, and one
        // more click to find it is one an operator scanning 40 rows will not make.
        p.ineffectiveReasons.length > 0 ? (
          <span title={p.ineffectiveReasons.map(r => r.text).join(' · ')}>
            <Pill tone={STATUS_TONE[p.status]}>{p.ineffectiveReasons[0]?.code.toLowerCase().replace(/_/g, ' ')}</Pill>
          </span>
        ) : (
          <Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill>
        )
    },
    { key: 'category', header: 'Category', priority: 3, render: p => <span className="text-[13px]">{p.category}</span> },
    {
      key: 'kinds',
      header: 'Target kinds',
      priority: 2,
      max: '170px',
      render: p => (
        <span
          className="mono whitespace-normal text-[12px] text-muted [overflow-wrap:anywhere]"
          title={p.targetKinds.flatMap(t => t.kinds).join(', ')}
        >
          {kindLine(p)}
        </span>
      )
    },
    {
      key: 'scope',
      header: 'Namespace scope',
      priority: 3,
      max: '150px',
      render: p => <span className="text-[12px] text-muted">{scopeLine(p)}</span>
    },
    {
      key: 'constraints',
      header: 'Constraints',
      align: 'right',
      priority: 3,
      width: '96px',
      render: p =>
        // The count is per ConstraintTemplate, not per row: a template with three Constraints
        // occupies three rows, and knowing that from any one of them is what tells an operator
        // whether tightening this row's parameters covers the policy or one third of it.
        p.constraintName === null ? (
          <span className="text-[12px] text-bad" title="The template is declared and no Constraint instantiates it, so it evaluates nothing">
            none
          </span>
        ) : (
          <span className="mono text-[13px] text-muted" title={`${constraintsPerTemplate.get(p.templateName) ?? 1} Constraint(s) use ${p.templateName}`}>
            {constraintsPerTemplate.get(p.templateName) ?? 1}
          </span>
        )
    },
    {
      key: 'violations',
      header: 'Violations',
      align: 'right',
      width: '104px',
      render: p =>
        // Two different absences, and they are not interchangeable. `violationCount === null` is
        // Gatekeeper publishing no status for this constraint — unread, not zero. An untrusted
        // audit capability is the whole audit being unreliable, and `<Count>` renders that as
        // `Unavailable` through the same path every other missing metric uses.
        p.violationCount === null ? (
          <span className="text-[12px] text-muted" title="Gatekeeper has published no count for this policy — unread, not zero">
            unread
          </span>
        ) : (
          <span className={`mono ${p.violationCount > 0 ? 'text-warn' : 'text-muted'}`}>
            <Count status={violationStatus} value={p.violationCount} />
            {p.violationsTruncated && violationStatus.state !== 'unavailable' && (
              <span className="text-[11px] text-muted" title={`${p.violationsShown} itemised of ${p.violationCount}`}>
                {' '}
                ({p.violationsShown} shown)
              </span>
            )}
          </span>
        )
    },
    {
      key: 'audit',
      header: 'Last audit',
      priority: 2,
      align: 'right',
      render: p => (
        <span className={`text-[12px] ${p.audit.state === 'fresh' ? 'text-muted' : 'text-warn'}`}>{auditLine(p)}</span>
      )
    }
  ];

  return (
    <div>
      <FilterBar
        activeCount={activeFilters}
        onReset={resetFilters}
        resultLine={
          rows.length === data.policies.length
            ? `${rows.length} ${rows.length === 1 ? 'policy' : 'policies'}`
            : `${rows.length} of ${data.policies.length}`
        }
      >
        <SearchBox
          value={filters.q}
          onChange={q => setFilters({ q })}
          placeholder="Search name, template or description"
        />
        <FilterSelect
          label="Enforcement"
          value={filters.action}
          onChange={action => setFilters({ action: action as OpaFilters['action'] })}
          options={[
            { value: 'all', label: 'any' },
            { value: 'deny', label: 'deny' },
            { value: 'warn', label: 'warn' },
            { value: 'dryrun', label: 'dry-run' },
            { value: 'unknown', label: 'undetermined' }
          ]}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={s => setFilters({ status: s as OpaFilters['status'] })}
          options={[
            { value: 'all', label: 'any' },
            { value: 'active', label: 'enforcing' },
            { value: 'warning', label: 'worth reading' },
            { value: 'inactive', label: 'enforces nothing' },
            { value: 'broken', label: 'broken — cannot evaluate' },
            { value: 'unknown', label: 'unknown' }
          ]}
        />
        <FilterSelect
          label="Category"
          value={filters.category}
          onChange={c => setFilters({ category: c as OpaFilters['category'] })}
          options={[{ value: 'all', label: 'any' }, ...categories.map(c => ({ value: c, label: c }))]}
        />
        <FilterSelect
          label="Kind"
          value={filters.kind}
          onChange={kind => setFilters({ kind })}
          options={[{ value: 'all', label: 'any' }, ...kinds.map(k => ({ value: k, label: k }))]}
        />
        {namespaces.length > 0 && (
          <FilterSelect
            label="Namespace"
            value={filters.namespace}
            onChange={namespace => setFilters({ namespace })}
            options={[{ value: 'all', label: 'any' }, ...namespaces.map(n => ({ value: n, label: n }))]}
          />
        )}
        <FilterSelect
          label="Source"
          value={filters.origin}
          onChange={o => setFilters({ origin: o as OpaFilters['origin'] })}
          options={[
            { value: 'all', label: 'any' },
            { value: 'library', label: 'library' },
            { value: 'modified', label: 'modified library' },
            { value: 'custom', label: 'custom' },
            { value: 'behind', label: 'behind the library' }
          ]}
        />
        <FilterSelect
          label="Violations"
          value={filters.violations}
          onChange={v => setFilters({ violations: v as OpaFilters['violations'] })}
          options={[
            { value: 'all', label: 'any' },
            { value: 'violating', label: 'has violations' },
            { value: 'clean', label: 'none recorded' }
          ]}
        />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={rows}
        // Eleven columns, so the widest tier — not `mid`, and no longer `wide`. Each tier's
        // thresholds are measured for a column count: `mid`'s 1000/700 are for nine, and at 1440
        // this table's container is ~1090px, above 1000, so nothing shed and all eleven clipped.
        // `wide` (1300/1000) failed the same way one width up: at a 1728px viewport the container
        // is 1405px, so prio-3 never hid and the eleven columns summed to 1628px — 223px off the
        // right edge. The failure mode of a threshold that fires too late is not "sheds too much",
        // it is "sheds nothing and clips instead". `lean` hides prio-3 at ≤1440, which covers
        // every width from a laptop to this one, and — unlike `xwide` — keeps prio-2 down to a
        // 1040px container, because this table's pinned set is only 563px wide. See theme.css.
        shed="lean"
        rowKey={p => p.id}
        selectedKey={selectedId}
        onSelect={onSelect}
        empty={
          status.state === 'unavailable' ? (
            <UnavailableEmptyBody status={status} />
          ) : activeFilters > 0 ? (
            <Empty
              title="No policy matches these filters"
              hint="The cluster's policies were read successfully — this is a filter result, not an empty cluster."
            />
          ) : (
            <Empty
              title="No Gatekeeper policies are defined"
              hint="Gatekeeper is installed and answered, and it holds no ConstraintTemplates — so it rejects nothing."
            />
          )
        }
      />
    </div>
  );
}
