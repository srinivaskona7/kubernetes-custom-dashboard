/**
 * Coverage — which kinds are governed, by what, and how far it reaches.
 *
 * A matrix, deliberately not a percentage. A coverage figure needs a denominator: "how many
 * resources in this cluster COULD this policy have evaluated". Gatekeeper does not publish that,
 * and deriving it would mean listing every object of every target kind in every namespace on every
 * page load — the exact enumeration the spec rules out, and still only an estimate. So this shows
 * what is known, per kind, and labels the rest unknown rather than inventing a ratio.
 */
import { useMemo, useState } from 'react';
import type { OpaCategory, OpaData, OpaPolicy } from '../../../api';
import { Section } from '../../../components/layout';
import { Dot, Pill } from '../../../components/ui';
import { DataTable, NUMERIC, type Column } from '../../../components/DataTable';
import { useFindingNavigation } from '../../../findings';
import { ACTION_TONE, auditLine, byRisk, isBroken, kindLine } from './shared';
import { FilterSelect } from '../../../components/filters';

const CATEGORY_ORDER: OpaCategory[] = [
  'Security context',
  'Resource requests and limits',
  'Image provenance',
  'Networking',
  'Labels and ownership',
  'Storage',
  'Other'
];

type Reach = 'cluster-wide' | 'partial' | 'none' | 'unknown';

/** The reach of a group of policies over one kind, taking the WIDEST — the kind is covered if any policy covers it. */
function reachOf(policies: OpaPolicy[]): Reach {
  if (policies.some(p => p.namespaceScope.evaluable && p.namespaceScope.scope === 'cluster-wide')) return 'cluster-wide';
  if (policies.some(p => !p.namespaceScope.evaluable)) return 'unknown';
  if (policies.some(p => (p.namespaceScope.matchedNamespaceCount ?? 0) > 0)) return 'partial';
  return 'none';
}

const REACH_LABEL: Record<Reach, string> = {
  'cluster-wide': 'every namespace',
  partial: 'some namespaces',
  none: 'no namespace',
  unknown: 'reach unknown'
};

const REACH_TONE: Record<Reach, 'ok' | 'warn' | 'bad' | 'unknown'> = {
  'cluster-wide': 'ok',
  partial: 'warn',
  none: 'bad',
  unknown: 'unknown'
};

/** How the per-policy coverage rows are bucketed. */
type GroupBy = 'policy' | 'namespace' | 'kind' | 'category' | 'enforcement';

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'policy', label: 'nothing — one row per policy' },
  { value: 'namespace', label: 'namespace' },
  { value: 'kind', label: 'resource kind' },
  { value: 'category', label: 'policy category' },
  { value: 'enforcement', label: 'enforcement action' }
];

/**
 * Whether this policy is currently able to evaluate anything, in three words.
 *
 * Separate from the enforcement action on purpose: `deny` describes what the policy would do, and
 * this column describes whether it is in a position to do it. A deny policy whose template the API
 * server rejected is `not evaluating`, and a table that showed only the action would call it
 * enforcing.
 */
function evaluationState(p: OpaPolicy): { text: string; tone: 'ok' | 'warn' | 'bad' | 'unknown'; why: string } {
  if (isBroken(p)) {
    return {
      text: 'not evaluating',
      tone: 'bad',
      why: p.ineffectiveReasons.map(r => r.text).join(' · ') || 'The template or constraint is in error.'
    };
  }
  if (p.status === 'inactive') {
    return {
      text: 'evaluates nothing',
      tone: 'bad',
      why: p.ineffectiveReasons.map(r => r.text).join(' · ') || 'Declared, but cannot affect admission.'
    };
  }
  if (p.status === 'unknown') {
    return { text: 'unknown', tone: 'unknown', why: 'A read on the path to this policy did not complete.' };
  }
  if (p.audit.state === 'never') {
    return {
      text: 'never audited',
      tone: 'warn',
      why: 'Gatekeeper has not audited this constraint, so its violation count is unread rather than zero.'
    };
  }
  return {
    text: 'evaluating',
    tone: 'ok',
    why: `The constraint is reconciled and was last audited ${auditLine(p)}.`
  };
}

/** Namespace lists as a readable clause. `null` is "the list could not be read", never "none". */
function nsList(list: string[] | null, emptyWord: string): { text: string; title?: string; muted: boolean } {
  if (list === null) return { text: 'unreadable', muted: false, title: 'The namespace list could not be read.' };
  if (list.length === 0) return { text: emptyWord, muted: true };
  if (list.length <= 2) return { text: list.join(', '), muted: false, title: list.join(', ') };
  return { text: `${list.slice(0, 2).join(', ')} +${list.length - 2}`, muted: false, title: list.join(', ') };
}

/** One rendered coverage row: a policy, and which bucket it is being shown under. */
type CoverageRow = { rowId: string; group: string; p: OpaPolicy };

export function OpaCoverage({ data }: { data: OpaData }): JSX.Element {
  const go = useFindingNavigation();
  const [groupBy, setGroupBy] = useState<GroupBy>('policy');

  /**
   * The per-policy rows, bucketed, flattened into the one list `DataTable` renders.
   *
   * A policy that reaches four namespaces appears in four namespace buckets and once in the flat
   * view — deliberately, because "what governs this namespace" is the question the namespace
   * grouping is asked, and answering it with one arbitrary row per policy would drop three of the
   * four namespaces on the floor. The bucket is carried on the row rather than kept in a parallel
   * structure, which is what lets `DataTable.groupOf` draw the group rule inside the same table and
   * `rowId` stay unique across the repeats.
   */
  const policyRows = useMemo<CoverageRow[]>(() => {
    const sorted = [...data.policies].sort(byRisk);
    if (groupBy === 'policy') return sorted.map(p => ({ rowId: p.id, group: '', p }));
    const buckets = new Map<string, OpaPolicy[]>();
    const push = (key: string, p: OpaPolicy) => {
      const list = buckets.get(key) ?? [];
      list.push(p);
      buckets.set(key, list);
    };
    for (const p of sorted) {
      if (groupBy === 'namespace') {
        const scope = p.namespaceScope;
        if (!scope.evaluable) push('reach unreadable', p);
        else if (scope.scope === 'cluster-wide') push('every namespace', p);
        else if ((scope.matchedNamespaces ?? []).length === 0) push('no namespace on this cluster', p);
        else for (const ns of scope.matchedNamespaces ?? []) push(ns, p);
      } else if (groupBy === 'kind') {
        const kinds = [...new Set(p.targetKinds.flatMap(t => t.kinds))];
        if (kinds.length === 0) push('no kinds configured', p);
        else for (const k of kinds) push(k === '*' ? '* (every kind)' : k, p);
      } else if (groupBy === 'category') {
        push(p.category, p);
      } else {
        push(p.enforcementAction, p);
      }
    }
    return [...buckets.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .flatMap(([group, policies]) => policies.map(p => ({ rowId: `${group}:${p.id}`, group, p })));
  }, [data.policies, groupBy]);

  /**
   * The matrix rows: one per Kind any policy names.
   *
   * Kinds come from the policies, not from a list of Kubernetes kinds — the alternative would be a
   * table of 200 rows of which 195 say "no policy", which is true but tells the operator nothing
   * they can act on and buries the five that matter. What is NOT covered is stated as a sentence
   * beneath the table instead, because it is an open set and pretending otherwise is the same
   * mistake as a coverage percentage.
   */
  const rows = useMemo(() => {
    const byKind = new Map<string, OpaPolicy[]>();
    for (const p of data.policies) {
      for (const kind of new Set(p.targetKinds.flatMap(t => t.kinds))) {
        const list = byKind.get(kind) ?? [];
        list.push(p);
        byKind.set(kind, list);
      }
    }
    return [...byKind.entries()]
      .map(([kind, policies]) => ({
        kind,
        policies,
        reach: reachOf(policies),
        // The strongest action across the policies covering this kind. A kind covered by one deny
        // and three dry-runs IS denied, and reporting the average would be meaningless.
        strongest: policies.some(p => p.status !== 'inactive' && p.enforcementAction === 'deny')
          ? ('deny' as const)
          : policies.some(p => p.status !== 'inactive' && p.enforcementAction === 'warn')
            ? ('warn' as const)
            : policies.some(p => p.status !== 'inactive' && p.enforcementAction === 'dryrun')
              ? ('dryrun' as const)
              : ('unknown' as const),
        byCategory: new Map<OpaCategory, OpaPolicy[]>(
          CATEGORY_ORDER.map(c => [c, policies.filter(p => p.category === c)])
        )
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }, [data.policies]);

  const activeCategories = CATEGORY_ORDER.filter(c => data.policies.some(p => p.category === c));
  const wildcard = rows.find(r => r.kind === '*');

  /**
   * The coverage columns.
   *
   * Both tables on this page are `DataTable`s now. They used to be hand-rolled, and the whole of what
   * that cost is what the shared component gives them here: the width ceilings that were a local
   * `CAP` constant are `Column.max` (applied to the `th` and the `td` from one object, so they cannot
   * drift), the `prio-*` classes come from `priority`, the alignment from the header, and Columns /
   * Wrap names / resize / reorder arrive without this file knowing about them. The one thing the
   * component could not do was the group rule, so `DataTable` grew `groupOf` rather than this file
   * keeping its own table to draw one row.
   */
  const coverageColumns: Column<CoverageRow>[] = [
    {
      key: 'policy',
      header: 'Policy',
      pin: true,
      max: '220px',
      title: r => `Open ${r.p.displayName}`,
      sortValue: r => r.p.displayName,
      render: r => (
        <button
          type="button"
          onClick={() => go({ params: { opa: 'policies', opasel: r.p.id } })}
          className="truncate text-left underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent"
        >
          {r.p.displayName}
        </button>
      )
    },
    {
      key: 'action',
      header: 'Enforcement',
      sortValue: r => r.p.enforcementAction,
      render: r => <Pill tone={ACTION_TONE[r.p.enforcementAction]}>{r.p.enforcementAction}</Pill>
    },
    {
      key: 'kinds',
      header: 'Target kinds',
      priority: 2,
      // 170, not 190, and the same ceiling the Policies table gives this column. Measured at a
      // 1405px container: the nine columns summed to 1408.06px, because the four uncapped headers
      // are `nowrap` and "Applicable resources" alone is 199px — a 3px overflow, which is enough
      // for a horizontal scrollbar and a clipped `Freshness` column and reads as a broken table
      // rather than a wide one.
      max: '170px',
      title: r => r.p.targetKinds.flatMap(t => t.kinds).join(', '),
      render: r => <span className="mono text-[12px] text-muted">{kindLine(r.p)}</span>
    },
    {
      key: 'included',
      // `namespace list`, not `namespaces`: the plural is a count everywhere else on this console, so
      // the alignment classifier reads it as a quantity — and this cell is a list of names.
      header: 'Included namespace list',
      priority: 3,
      max: '150px',
      title: r => {
        const l = nsList(r.p.namespaceScope.included, 'all (not restricted)');
        return l.title ?? l.text;
      },
      render: r => {
        const l = nsList(r.p.namespaceScope.included, 'all (not restricted)');
        return <span className={`text-[12px] ${l.muted ? 'text-muted' : ''}`}>{l.text}</span>;
      }
    },
    {
      key: 'excluded',
      header: 'Excluded namespace list',
      priority: 3,
      max: '150px',
      title: r => {
        const l = nsList(r.p.namespaceScope.excluded, 'none');
        return l.title ?? l.text;
      },
      render: r => {
        const l = nsList(r.p.namespaceScope.excluded, 'none');
        return <span className={`text-[12px] ${l.muted ? 'text-muted' : ''}`}>{l.text}</span>;
      }
    },
    {
      key: 'applicable',
      header: 'Applicable resources',
      ...NUMERIC,
      title: r =>
        r.p.namespaceScope.evaluable
          ? 'Resource-level counts are not enumerated. This is the namespace reach, which is what the console can state without listing the cluster.'
          : 'The namespace list could not be read.',
      // Sorted on the reach, with cluster-wide above every finite count — it is the widest reach
      // there is, and a policy that spans an unknown number of namespaces is not a zero.
      sortValue: r =>
        !r.p.namespaceScope.evaluable
          ? null
          : r.p.namespaceScope.scope === 'cluster-wide'
            ? Number.MAX_SAFE_INTEGER
            : (r.p.namespaceScope.matchedNamespaceCount ?? 0),
      render: r =>
        /*
         * The number this page refuses to make up. Counting the objects a policy could evaluate
         * means listing every resource of every target kind in every matched namespace on each
         * load — the enumeration the spec rules out, and still only an estimate. What IS known is
         * the namespace reach, so that is what this cell reports.
         */
        r.p.namespaceScope.evaluable ? (
          <span className="text-[12px] text-muted">
            {r.p.namespaceScope.scope === 'cluster-wide'
              ? `all ns (${r.p.namespaceScope.totalNamespaces ?? '?'})`
              : `${r.p.namespaceScope.matchedNamespaceCount ?? 0} ns`}
          </span>
        ) : (
          <span className="text-[12px] text-unknown">unknown</span>
        )
    },
    {
      key: 'violating',
      header: 'Violating',
      ...NUMERIC,
      sortValue: r => r.p.violationCount,
      render: r =>
        r.p.violationCount === null ? (
          <span className="text-[12px] text-muted" title="Gatekeeper has published no count — unread, not zero">
            unread
          </span>
        ) : (
          <button
            type="button"
            onClick={() => go({ params: { opa: 'violations', opolicy: r.p.id } })}
            className={`mono underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent ${r.p.violationCount > 0 ? 'text-warn' : 'text-muted'}`}
            title={`Show the violations recorded against ${r.p.displayName}`}
          >
            {r.p.violationCount}
          </button>
        )
    },
    {
      key: 'state',
      header: 'Evaluation state',
      title: r => evaluationState(r.p).why,
      sortValue: r => evaluationState(r.p).text,
      render: r => {
        const state = evaluationState(r.p);
        return <Pill tone={state.tone}>{state.text}</Pill>;
      }
    },
    {
      key: 'freshness',
      header: 'Freshness',
      ...NUMERIC,
      priority: 2,
      render: r => (
        <span className={`text-[12px] ${r.p.audit.state === 'fresh' ? 'text-muted' : 'text-warn'}`}>
          {auditLine(r.p)}
        </span>
      )
    }
  ];

  /**
   * The matrix columns: three fixed, then one per category actually present.
   *
   * The category columns are built the same way the fleet drift matrix builds its per-cluster ones —
   * one `Column` object each, so the count under a category header can only ever be that category's.
   * Their header carries the full category name as a `title` because the label itself is abbreviated
   * ("Requests/limits" for "Resource requests and limits") to keep seven numeric columns narrow.
   *
   * No column here declares a `priority`: every category column IS the matrix, and shedding one
   * would delete a fact rather than defer it. The tier is set anyway, for the sticky `Kind` column —
   * a horizontally scrolled row of counts belonging to no visible kind is the failure this prevents.
   */
  const matrixColumns: Column<(typeof rows)[number]>[] = [
    {
      key: 'kind',
      header: 'Kind',
      pin: true,
      max: '220px',
      sortValue: r => r.kind,
      render: r => <span className="mono">{r.kind === '*' ? '* (every kind)' : r.kind}</span>
    },
    {
      key: 'strongest',
      header: 'Strongest action',
      // Strongest first, so the kinds that are actually being denied sort to the top of one click.
      sortValue: r => ({ deny: 0, warn: 1, dryrun: 2, unknown: 3 })[r.strongest],
      render: r => (
        <Pill tone={ACTION_TONE[r.strongest]}>{r.strongest === 'unknown' ? 'nothing enforcing' : r.strongest}</Pill>
      )
    },
    {
      key: 'reach',
      header: 'Namespace reach',
      title: r =>
        r.reach === 'partial'
          ? 'Covered in some namespaces only — a resource of this kind elsewhere is not evaluated'
          : r.reach === 'unknown'
            ? 'The namespace list could not be read, so reach cannot be determined'
            : REACH_LABEL[r.reach],
      // Weakest reach first: `none` is the row an operator has to act on.
      sortValue: r => ({ none: 0, partial: 1, 'cluster-wide': 2, unknown: 3 })[r.reach],
      render: r => <Pill tone={REACH_TONE[r.reach]}>{REACH_LABEL[r.reach]}</Pill>
    },
    ...activeCategories.map<Column<(typeof rows)[number]>>(c => ({
      key: `cat:${c}`,
      align: 'right',
      width: '110px',
      header: (
        <span title={c}>
          {c === 'Resource requests and limits' ? 'Requests/limits' : c === 'Labels and ownership' ? 'Labels' : c}
        </span>
      ),
      sortValue: r => (r.byCategory.get(c) ?? []).length,
      render: r => {
        const cell = r.byCategory.get(c) ?? [];
        return cell.length === 0 ? (
          <span className="text-muted" title={`No ${c.toLowerCase()} policy targets ${r.kind}`}>
            ·
          </span>
        ) : (
          <button
            type="button"
            onClick={() => go({ params: { opa: 'policies', okind: r.kind, ocategory: c } })}
            className="mono underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent"
            title={cell.map(p => p.displayName).join(', ')}
          >
            {cell.length}
          </button>
        );
      }
    }))
  ];

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------------ the gate */}
      <Section label="The admission gate">
        {/*
          Kept here rather than duplicated from the Admission surface above: this is the same
          webhook data the rebuilt admission section reads, said in coverage terms — because a
          policy's reach is bounded by the webhook's operations and its backend, and a matrix that
          ignored that would overstate every row in it.
        */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
            <span className="inline-flex items-center gap-2">
              <Dot tone={data.webhook.active === true ? 'ok' : data.webhook.active === false ? 'bad' : 'unknown'} />
              <span className="text-muted">Backend</span>
              <span className="text-text">
                {data.webhook.backendStatus === 'ready'
                  ? 'ready'
                  : data.webhook.backendStatus === 'none'
                    ? 'no ready endpoint'
                    : data.webhook.backendStatus === 'absent'
                      ? 'service not found'
                      : 'unknown'}
              </span>
            </span>
            {data.webhook.service && (
              <span className="inline-flex items-baseline gap-1.5">
                <span className="text-muted">Service</span>
                <span className="mono text-text">
                  {data.webhook.service.namespace}/{data.webhook.service.name}
                  {data.webhook.service.port !== null && `:${data.webhook.service.port}`}
                </span>
              </span>
            )}
            {data.webhook.operations && data.webhook.operations.length > 0 && (
              <span className="inline-flex items-baseline gap-1.5">
                <span className="text-muted">Intercepts</span>
                <span className="mono text-text">{data.webhook.operations.join(', ')}</span>
              </span>
            )}
          </div>
          {/*
            Blast radius, stated rather than scored. Which way a fail-closed webhook with a dead
            backend breaks is the single most consequential fact on this page, and it is the
            opposite of what an operator expects in each case.
          */}
          {data.webhook.present && (
            <p className="max-w-[100ch] text-[13px] text-muted">
              {data.webhook.failurePolicy === 'Fail'
                ? data.webhook.active === false
                  ? 'Blast radius: fail-closed with no ready backend — every matching write on this cluster is being rejected until Gatekeeper returns.'
                  : 'Blast radius: fail-closed. If Gatekeeper stops answering, every matching write is rejected until it returns.'
                : data.webhook.active === false
                  ? 'Blast radius: fail-open with no ready backend — matching writes are being admitted right now without any policy evaluation, silently.'
                  : 'Blast radius: fail-open. If Gatekeeper stops answering, matching writes are admitted unevaluated and nothing reports it.'}
            </p>
          )}
          {data.webhook.present === false && (
            <p className="text-[13px] text-warn">
              No Gatekeeper validating webhook is registered, so no policy below is evaluated at admission at all —
              whatever their enforcement actions say. The audit still records violations.
            </p>
          )}
        </div>
      </Section>

      {/*
        Per-policy coverage. This Section carries no `hint` and no `CapabilityNotice`: the notice it
        used to print is the *same* `data.capabilities.coverage` the OPA shell already prints above
        the sub-tab strip for whichever tab is open, so on this tab the identical sentence appeared
        twice on one screen. A hint would be worse still — it used to read "Partial coverage based on
        currently available resources", a hardcoded string that announces partial coverage even when
        every read succeeded. The shell's notice is derived from the actual capability verdict and
        names the actual cause, so it is the one that stays.
      */}
      <Section
        label="Policy coverage"
        action={
          <FilterSelect
            label="Group by"
            value={groupBy}
            onChange={g => setGroupBy(g as GroupBy)}
            options={GROUP_OPTIONS}
          />
        }
      >
        {data.policies.length === 0 ? (
          <p className="text-[13px] text-muted">No policy was read, so there is no coverage to map.</p>
        ) : (
          <DataTable
            id="opa.coverage"
            columns={coverageColumns}
            rows={policyRows}
            rowKey={r => r.rowId}
            /*
              `wide` (1300/1000), not `mid`: the thresholds are CONTAINER widths, and at 1440 with the
              rail expanded this container is 1090px — above mid's 1000px trigger, so mid would stay
              quiet and all nine columns would render into a 523px overflow.
            */
            shed="wide"
            // '' means the flat view, where there is nothing to group and no rule to draw.
            groupOf={r => r.group || null}
            groupSummary={(label, count) => (
              <>
                <span className="mono text-[12px] text-text">{label}</span>
                <span className="ml-2 text-[12px] text-muted">
                  {count} {count === 1 ? 'policy' : 'policies'}
                </span>
              </>
            )}
            empty="No policy was read, so there is no coverage to map."
          />
        )}
      </Section>

      {/* ------------------------------------------------------------------ the matrix */}
      <Section label={`Coverage matrix (${rows.length} ${rows.length === 1 ? 'kind' : 'kinds'})`}>
        {rows.length === 0 ? (
          <p className="text-[13px] text-muted">No policy names a target kind, so there is nothing to map.</p>
        ) : (
          <DataTable
            id="opa.coverage-matrix"
            columns={matrixColumns}
            rows={rows}
            rowKey={r => r.kind}
            shed="wide"
            empty="No policy names a target kind, so there is nothing to map."
          />
        )}
      </Section>

      {/* ------------------------------------------------------------------ what this does not say */}
      <div className="space-y-2 border-t border-line pt-3 text-[13px] text-muted">
        <p className="max-w-[100ch]">
          <span className="text-text">There is no coverage percentage on this page, on purpose.</span> Gatekeeper does
          not publish how many resources a policy evaluated, and computing a denominator would mean listing every
          object of every kind in every namespace on each load — expensive, and still an estimate. The matrix says
          what is governed; it does not claim to say what proportion of the cluster that is.
        </p>
        <p className="max-w-[100ch]">
          A kind absent from the table has no Gatekeeper policy naming it. That is a complete statement about the
          policies read here and not a claim about the cluster&apos;s other admission controls — ValidatingAdmissionPolicies
          and plain webhooks are on the Admission &amp; Policy surface above.
        </p>
        {wildcard && (
          <p className="max-w-[100ch] text-warn">
            One or more policies target <span className="mono">*</span>, so they apply to kinds not listed as their own
            row here.
          </p>
        )}
      </div>
    </div>
  );
}
