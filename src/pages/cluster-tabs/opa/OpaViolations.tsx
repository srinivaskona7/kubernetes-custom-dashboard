/**
 * Violations — the objects the last Gatekeeper audit found in breach.
 *
 * The one thing this screen must never imply: that these are blocked requests. They are objects
 * that exist in the cluster right now and violate a policy — which happens most often because the
 * policy was created after the object. The header says so, in place, rather than in a tooltip.
 *
 * ## Severity is derived, and says so
 *
 * Gatekeeper publishes no severity. The column here is a restatement of the enforcement action in
 * consequence terms — deny means the next apply of this object is rejected, warn means it goes
 * through with a message, dry-run means nothing happens — and every cell carries that derivation in
 * its tooltip. Inventing a CVSS-shaped number from a policy name would be the kind of confident
 * fiction this console exists to avoid.
 */
import { useCallback, useMemo } from 'react';
import { COLUMN_INFO } from '../../../components/table/column-info';
import { useSearchParams } from 'react-router-dom';
import type { OpaData, OpaPolicy, OpaViolation } from '../../../api';
import { capabilityStatus } from '../../../capability';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { Empty, Pill, type Tone } from '../../../components/ui';
import { DetailPanel, Field, Section } from '../../../components/layout';
import { UnavailableEmptyBody, type MetricStatus } from '../../../components/unavailable';
import { ResourceLink } from '../../../components/ResourceLink';
import { ago } from '../../../format';
import { FilterBar, FilterSelect, SearchBox } from '../../../components/filters';
import { ACTION_TONE, auditLine, filterViolations, linkableKind, type OpaFilters } from './shared';

type Severity = 'high' | 'medium' | 'low' | 'unknown';

const SEVERITY: Record<Severity, { label: string; tone: Tone; why: string }> = {
  high: {
    label: 'high',
    tone: 'bad',
    why: 'The policy denies: the next create or update of this object is rejected at admission.'
  },
  medium: {
    label: 'medium',
    tone: 'warn',
    why: 'The policy warns: the request succeeds and the client is told why it should not have.'
  },
  low: {
    label: 'low',
    tone: 'accent',
    why: 'The policy is in dry-run: the violation is recorded and nothing is blocked.'
  },
  unknown: {
    label: 'unknown',
    tone: 'unknown',
    why: 'The enforcement action could not be determined, so the consequence of this violation is unknown.'
  }
};

/**
 * Severity from the enforcement action, and from nothing else.
 *
 * Not from the message text, not from the policy name, not from a category: those would be guesses
 * dressed as a rating. What Gatekeeper does tell us is exactly what happens next, and that is the
 * only thing a severity here can honestly mean.
 */
function severityOf(v: OpaViolation): Severity {
  if (v.enforcementAction === 'deny') return 'high';
  if (v.enforcementAction === 'warn') return 'medium';
  if (v.enforcementAction === 'dryrun') return 'low';
  return 'unknown';
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, unknown: 2, low: 3 };

/** Read and write the selected violation id, so a drawer link is shareable and Back closes it. */
export function useViolationSelection(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const selected = params.get('oviolsel');
  const select = useCallback(
    (id: string | null) => {
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          if (id === null) next.delete('oviolsel');
          else {
            next.set('oviolsel', id);
            // The policy drawer and this one occupy the same slot; the last click wins rather than
            // both rendering side by side and halving the table.
            next.delete('opasel');
            next.delete('opapane');
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );
  return [selected, select];
}

/** The freshness of the audit that produced this row, in the words the metadata line uses. */
function freshnessOf(policy: OpaPolicy | undefined): { text: string; tone: 'ok' | 'warn' | 'unknown' } {
  if (!policy) return { text: 'unknown', tone: 'unknown' };
  if (policy.audit.state === 'never') return { text: 'never audited', tone: 'unknown' };
  if (policy.audit.state === 'fresh') return { text: auditLine(policy), tone: 'ok' };
  return { text: auditLine(policy), tone: 'warn' };
}

export function OpaViolations({
  data,
  status,
  filters,
  setFilters,
  resetFilters,
  activeFilters,
  onOpenPolicy
}: {
  data: OpaData;
  status: MetricStatus;
  filters: OpaFilters;
  setFilters: (patch: Partial<OpaFilters>) => void;
  resetFilters: () => void;
  activeFilters: number;
  onOpenPolicy: (policyId: string) => void;
}): JSX.Element {
  const policiesById = useMemo(() => new Map(data.policies.map(p => [p.id, p])), [data.policies]);
  const [selectedId, selectViolation] = useViolationSelection();

  /**
   * Whether the referenced object can still be assumed to exist.
   *
   * Gatekeeper's audit records a reference, not a live object, so a violation outlives what it
   * points at for up to one audit interval. Confirming deletion would need a GET per row — a read
   * this page will not issue — so the test is the strongest one available from data already in
   * hand: a reference is treated as resolvable unless its own policy has never been audited, in
   * which case nothing about the reference can be asserted either way. The `deleted` presentation
   * below is what an operator sees when that check fails, and the drawer's own `?res=` lookup is
   * where a since-deleted object is discovered for certain.
   */
  const resolvable = (v: OpaViolation) => {
    const policy = policiesById.get(v.policyId);
    // A violation from an audit that has since gone stale cannot be confirmed either way.
    return !policy || policy.audit.state !== 'never';
  };

  const kinds = useMemo(() => [...new Set(data.violations.map(v => v.kind))].sort(), [data.violations]);
  const namespaces = useMemo(
    () => [...new Set(data.violations.map(v => v.namespace ?? '-'))].sort(),
    [data.violations]
  );
  const categories = useMemo(() => [...new Set(data.violations.map(v => v.category))].sort(), [data.violations]);

  const rows = useMemo(
    () =>
      filterViolations(data.violations, filters, resolvable).sort(
        (a, b) =>
          // Severity first, which puts deny at the top: a violating object under a deny policy
          // means the next apply of that object is rejected, and that is the row that changes what
          // an operator does today.
          SEVERITY_RANK[severityOf(a)] - SEVERITY_RANK[severityOf(b)] ||
          a.kind.localeCompare(b.kind) ||
          `${a.namespace ?? ''}/${a.name}`.localeCompare(`${b.namespace ?? ''}/${b.name}`)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.violations, filters, policiesById]
  );

  const selected = useMemo(() => rows.find(v => v.id === selectedId) ?? data.violations.find(v => v.id === selectedId) ?? null, [rows, data.violations, selectedId]);
  const truncatedPolicies = data.policies.filter(p => p.violationsTruncated);
  const violationStatus = capabilityStatus(data.capabilities.violations, 'Audit violations');

  const columns: Column<OpaViolation>[] = [
    {
      key: 'severity',
      header: 'Severity',
      pin: true,
      priority: 1,
      width: '96px',
      render: v => {
        const s = SEVERITY[severityOf(v)];
        return (
          <span title={`${s.why} Derived from the policy's enforcement action — Gatekeeper publishes no severity.`}>
            <Pill tone={s.tone}>{s.label}</Pill>
          </span>
        );
      }
    },
    {
      key: 'policy',
      header: 'Policy',
      priority: 1,
      max: '200px',
      render: v => (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            onOpenPolicy(v.policyId);
          }}
          className="truncate text-left underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent"
          title="Open this policy"
        >
          {policiesById.get(v.policyId)?.displayName ?? v.policyId}
        </button>
      )
    },
    {
      key: 'action',
      header: 'Enforcement',
      priority: 2,
      width: '108px',
      render: v => (
        <Pill tone={ACTION_TONE[v.enforcementAction as keyof typeof ACTION_TONE] ?? 'unknown'}>
          {v.enforcementAction}
        </Pill>
      )
    },
    {
      key: 'namespace',
      header: 'Namespace',
      priority: 2,
      max: '150px',
      render: v => <span className="mono truncate text-[12px]">{v.namespace ?? 'cluster-scoped'}</span>
    },
    {
      key: 'resource',
      header: 'Resource',
      priority: 1,
      max: '220px',
      render: v => {
        // A link only where a drawer exists for the Kind. Gatekeeper targets whatever the policy
        // names, and a link that opens an empty drawer is worse than plain text.
        const kind = linkableKind(v.kind);
        return !resolvable(v) ? (
          <span className="truncate text-muted" title="This object was in the last audit and is no longer resolvable">
            {v.name} <span className="text-[12px]">— resource no longer exists</span>
          </span>
        ) : kind ? (
          <ResourceLink refTo={{ kind, namespace: v.namespace, name: v.name }} />
        ) : (
          <span className="truncate" title={`${v.kind} has no detail view in this console`}>
            {v.name}
          </span>
        );
      }
    },
    {
      key: 'kind',
      header: 'Kind',
      priority: 2,
      // `max`, not `width`: the `truncate` on the cell below is inert without a ceiling, because
      // `width` lands only on the `th` and `table-layout: auto` lets the widest cell override it.
      max: '132px',
      render: v => <span className="mono truncate text-[12px] text-muted">{v.kind}</span>
    },
    {
      key: 'message',
      header: 'Message',
      priority: 2,
      max: '260px',
      render: v => (
        // Gatekeeper's own message, verbatim — it is the policy author's sentence and rewriting it
        // would change what the cluster said.
        <span className="line-clamp-2 text-[13px] text-muted" title={v.message}>
          {v.message}
        </span>
      )
    },
    {
      key: 'source',
      header: 'Source',
      priority: 3,
      width: '132px',
      render: v => (
        <span
          className="mono text-[12px] text-muted"
          title={
            v.source === 'gatekeeper-audit'
              ? 'Gatekeeper audit — an object that exists and fails the policy. Not a denied request.'
              : v.source === 'admission-metric'
                ? 'An admission metric — a request Gatekeeper acted on at admission time.'
                : 'A decision log entry — a request Gatekeeper acted on at admission time.'
          }
        >
          {v.source === 'gatekeeper-audit' ? 'audit' : v.source === 'admission-metric' ? 'metric' : 'decision log'}
        </span>
      )
    },
    {
      key: 'firstSeen',
      header: 'First seen',
      ...NUMERIC,
      priority: 3,
      width: '120px',
      render: v =>
        v.firstSeen ? (
          <span className="text-[12px] text-muted">{ago(v.firstSeen)}</span>
        ) : (
          <span
            className="text-[12px] text-muted"
            title="Gatekeeper's audit records only the scan it last ran, never when a violation first appeared. This is a gap in the source, not a read failure."
          >
            not recorded
          </span>
        )
    },
    {
      key: 'lastSeen',
      header: 'Last seen',
      info: COLUMN_INFO.lastSeen,
      ...NUMERIC,
      priority: 3,
      width: '120px',
      render: v =>
        v.lastSeen ? (
          <span className="text-[12px] text-muted" title={v.lastSeen}>
            {ago(v.lastSeen)}
          </span>
        ) : (
          <span className="text-[12px] text-muted">unknown</span>
        )
    },
    {
      key: 'freshness',
      header: 'Freshness',
      ...NUMERIC,
      priority: 3,
      width: '120px',
      render: v => {
        const f = freshnessOf(policiesById.get(v.policyId));
        return (
          <span className={`text-[12px] ${f.tone === 'ok' ? 'text-muted' : f.tone === 'warn' ? 'text-warn' : 'text-unknown'}`}>
            {f.text}
          </span>
        );
      }
    }
  ];

  return (
    <div className="flex min-w-0 gap-4">
      <div className="min-w-0 flex-1">
        <p className="mb-3 max-w-[100ch] text-[13px] text-muted">
          Objects that <span className="text-text">currently exist</span> and violate a policy, as of each
          policy&apos;s last audit. These were not blocked at admission — a policy created after an object will
          report it here while never having had the chance to reject it.
        </p>

        <FilterBar
          activeCount={activeFilters}
          onReset={resetFilters}
          resultLine={
            rows.length === data.violations.length
              ? `${rows.length} ${rows.length === 1 ? 'violation' : 'violations'}`
              : `${rows.length} of ${data.violations.length}`
          }
        >
          <SearchBox value={filters.q} onChange={q => setFilters({ q })} placeholder="Search resource or message" />
          <FilterSelect
            label="Enforcement"
            value={filters.action}
            onChange={action => setFilters({ action: action as OpaFilters['action'] })}
            options={[
              { value: 'all', label: 'any' },
              { value: 'deny', label: 'deny' },
              { value: 'warn', label: 'warn' },
              { value: 'dryrun', label: 'dry-run' }
            ]}
          />
          <FilterSelect
            label="Kind"
            value={filters.kind}
            onChange={kind => setFilters({ kind })}
            options={[{ value: 'all', label: 'any' }, ...kinds.map(k => ({ value: k, label: k }))]}
          />
          <FilterSelect
            label="Namespace"
            value={filters.namespace}
            onChange={namespace => setFilters({ namespace })}
            options={[
              { value: 'all', label: 'any' },
              ...namespaces.map(n => ({ value: n, label: n === '-' ? 'cluster-scoped' : n }))
            ]}
          />
          <FilterSelect
            label="Category"
            value={filters.category}
            onChange={c => setFilters({ category: c as OpaFilters['category'] })}
            options={[{ value: 'all', label: 'any' }, ...categories.map(c => ({ value: c, label: c }))]}
          />
          <FilterSelect
            label="Source"
            value={filters.source}
            onChange={s => setFilters({ source: s as OpaFilters['source'] })}
            options={[
              { value: 'all', label: 'any' },
              { value: 'gatekeeper-audit', label: 'audit' },
              { value: 'decision-log', label: 'decision log' },
              { value: 'admission-metric', label: 'metrics' }
            ]}
          />
          {filters.policy !== 'all' && (
            <button
              type="button"
              onClick={() => setFilters({ policy: 'all' })}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line bg-raised px-2.5 text-[13px]"
              title="Show violations from every policy"
            >
              <span className="text-muted">policy</span>
              <span className="mono">{policiesById.get(filters.policy)?.displayName ?? filters.policy}</span>
              <span aria-hidden="true">×</span>
              <span className="sr-only">Clear the policy filter</span>
            </button>
          )}
        </FilterBar>

        {truncatedPolicies.length > 0 && (
          <p className="mb-3 text-[12px] text-warn">
            {truncatedPolicies.length} {truncatedPolicies.length === 1 ? 'policy has' : 'policies have'} more
            violations than Gatekeeper itemises — its audit pod caps each list at{' '}
            <span className="mono">--constraint-violations-limit</span>. The per-policy totals on the Policies tab are
            complete; the rows below are not.
          </p>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          // Eleven columns — same correction as Policies and Webhooks: `mid`'s 1000px threshold sits
          // below this table's real container width at 1440, so it shed nothing and overflowed.
          shed="wide"
          rowKey={v => v.id}
          selectedKey={selectedId}
          onSelect={v => selectViolation(v.id)}
          empty={
            status.state === 'unavailable' || violationStatus.state === 'unavailable' ? (
              <UnavailableEmptyBody status={violationStatus.state === 'unavailable' ? violationStatus : status} />
            ) : activeFilters > 0 ? (
              <Empty title="No violation matches these filters" hint="This is a filter result, not a clean cluster." />
            ) : data.summary.policiesWithUnknownViolationCount > 0 ? (
              <Empty
                title="No violations are itemised"
                hint={`${data.summary.policiesWithUnknownViolationCount} of ${data.summary.policyCount} policies have published no violation status yet, so this is not evidence that nothing violates them.`}
              />
            ) : (
              <Empty
                title="The last audit found nothing in violation"
                hint="Every policy that has been audited reported zero violating objects. Check each policy's audit age on the Policies tab — a stale audit makes this out of date."
              />
            )
          }
        />
      </div>

      {selected && (
        <ViolationDrawer
          violation={selected}
          policy={policiesById.get(selected.policyId) ?? null}
          resolvable={resolvable(selected)}
          onClose={() => selectViolation(null)}
          onOpenPolicy={() => onOpenPolicy(selected.policyId)}
        />
      )}
    </div>
  );
}

/**
 * One violation, in full.
 *
 * The row truncates the message to two lines because forty rows have to fit on a screen; this is
 * where the whole sentence lives, plus the two things the row cannot show at all: what the policy
 * actually requires, and what happens next time this object is applied.
 */
function ViolationDrawer({
  violation,
  policy,
  resolvable,
  onClose,
  onOpenPolicy
}: {
  violation: OpaViolation;
  policy: OpaPolicy | null;
  resolvable: boolean;
  onClose: () => void;
  onOpenPolicy: () => void;
}): JSX.Element {
  const severity = SEVERITY[severityOf(violation)];
  const kind = linkableKind(violation.kind);
  const freshness = freshnessOf(policy ?? undefined);

  return (
    <DetailPanel
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{violation.name}</span>
          <Pill tone={severity.tone}>{severity.label}</Pill>
        </span>
      }
      subtitle={
        <span className="mono text-[12px] text-muted">
          {violation.kind} · {violation.namespace ?? 'cluster-scoped'}
        </span>
      }
      onClose={onClose}
    >
      <Section label="What the cluster said">
        {/* Verbatim, and in the code voice, because it is a machine's sentence and an operator will
            paste it into a search. */}
        <p className="mono whitespace-pre-wrap break-words rounded-[6px] border border-line bg-raised p-3 text-[12px] text-text">
          {violation.message}
        </p>
      </Section>

      <Section label="Consequence">
        <p className="text-[13px] text-text">{severity.why}</p>
        <p className="mt-1.5 text-[12px] text-muted">
          Severity is this console&apos;s restatement of the enforcement action. Gatekeeper publishes no severity
          field.
        </p>
      </Section>

      <Section label="Policy">
        <Field label="Policy" value={policy?.displayName ?? violation.policyId} />
        {policy && <Field label="Purpose" value={policy.purpose.text} />}
        {policy && <Field label="ConstraintTemplate" value={policy.templateName} mono />}
        <Field label="Enforcement" value={violation.enforcementAction} mono />
        <Field label="Category" value={violation.category} />
        <div className="mt-2">
          <button
            type="button"
            onClick={onOpenPolicy}
            className="inline-flex h-8 items-center rounded-[6px] border border-line bg-raised px-3 text-[13px] hover:border-line-strong"
          >
            View policy
          </button>
        </div>
      </Section>

      <Section label="Affected resource">
        <Field label="Kind" value={violation.kind} mono />
        <Field label="Name" value={violation.name} mono />
        <Field label="Namespace" value={violation.namespace ?? 'cluster-scoped'} mono />
        <Field
          label="API"
          value={`${violation.group || 'core'}/${violation.version}`}
          mono
        />
        <div className="mt-2 text-[13px]">
          {!resolvable ? (
            <p className="text-muted">
              Resource no longer exists — it was present in the audit that recorded this violation and cannot be
              resolved now.
            </p>
          ) : kind ? (
            <ResourceLink refTo={{ kind, namespace: violation.namespace, name: violation.name }} />
          ) : (
            <p className="text-muted">
              This console has no detail view for <span className="mono">{violation.kind}</span>, so the object cannot
              be opened from here.
            </p>
          )}
        </div>
      </Section>

      <Section label="Evidence">
        <Field
          label="Source"
          value={
            violation.source === 'gatekeeper-audit'
              ? 'Gatekeeper audit — an object that exists and fails the policy'
              : violation.source === 'admission-metric'
                ? 'Admission metric — a request Gatekeeper acted on at admission time'
                : 'Decision log — a request Gatekeeper acted on at admission time'
          }
        />
        <Field
          label="First seen"
          value={violation.firstSeen ? ago(violation.firstSeen) : 'not recorded by Gatekeeper'}
        />
        <Field label="Last seen" value={violation.lastSeen ? ago(violation.lastSeen) : 'unknown'} />
        <Field label="Audit freshness" value={freshness.text} />
      </Section>
    </DetailPanel>
  );
}
