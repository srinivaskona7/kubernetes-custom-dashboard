/**
 * OPA Overview — what is enforced here, what is not, and what the evidence is worth.
 *
 * Ordered by what an operator needs first: the six aggregates (each one a control that shows its
 * own rows), then the risk-sorted findings, then the posture bar, then violations by category, then
 * a preview of the policies themselves worst-first. Nothing on this screen is a number without a
 * destination, and nothing is a number that was not read.
 *
 * ## The one number that is not here
 *
 * "Admission denials in 24h" has a card, and on every cluster this console has met it says
 * `Unavailable`. That is deliberate and it is the most important thing on the screen: Gatekeeper's
 * audit tells us which existing objects WOULD fail a policy, and nothing in that answer says a
 * request was ever rejected. Borrowing the audit total to fill the card would be a fabrication that
 * reads as a security metric. The card therefore states its own absence and links to the tab that
 * explains which two sources would populate it.
 */
import type { OpaCategory, OpaData, OpaPolicy } from '../../../api';
import type { MetricStatus } from '../../../components/unavailable';
import { Count, StatTile } from '../../../components/unavailable';
import { capabilityStatus } from '../../../capability';
import { Dot, Empty, Pill } from '../../../components/ui';
import { Section } from '../../../components/layout';
import { DataTable, type Column } from '../../../components/DataTable';
import { useFindingNavigation } from '../../../findings';
import { FindingRow } from './controls';
import { buildOpaFindings, partitionFindings } from './opa-findings';
import { ACTION_TONE, STATUS_TONE, byRisk, isBroken, scopeLine } from './shared';
import { LibrarySection } from './OpaLibrary';

/**
 * The posture bar's bands, worst first, so the eye lands on the problem end.
 *
 * Five bands, not three. `invalid` and `unknown` exist because a policy whose template the API
 * server rejected, and a policy whose Constraint read was refused, are not "dry-run" and are not
 * "deny" — they are two different kinds of hole in the picture, and folding either into a nominal
 * action is how a bar reaches 100% green on a cluster enforcing nothing.
 */
const BANDS: { key: PostureKey; label: string; cls: string; hint: string }[] = [
  { key: 'invalid', label: 'invalid', cls: 'bg-bad', hint: 'The template or constraint is in error — it cannot evaluate' },
  { key: 'inactive', label: 'enforces nothing', cls: 'bg-bad/60', hint: 'Declared, but cannot affect admission' },
  { key: 'unknown', label: 'unknown', cls: 'bg-unknown', hint: 'A read on the path to this policy failed' },
  { key: 'dryrun', label: 'dry-run', cls: 'bg-accent', hint: 'Violations recorded; nothing blocked' },
  { key: 'warn', label: 'warn', cls: 'bg-warn', hint: 'The request succeeds with a warning' },
  { key: 'deny', label: 'deny', cls: 'bg-ok', hint: 'Violating requests are rejected at admission' }
];

type PostureKey = 'invalid' | 'inactive' | 'unknown' | 'dryrun' | 'warn' | 'deny';

/**
 * Which band a policy lands in. Exactly one, and the order is the argument: a broken policy is
 * broken whatever its nominal action says, and a policy that cannot reach admission is not
 * "denying" — "deny" on a policy that cannot run is the claim this whole screen exists to stop
 * making. `isBroken` is imported rather than restated so this bar and the risk sort cannot disagree.
 */
function bandOf(p: OpaPolicy): PostureKey {
  if (isBroken(p)) return 'invalid';
  if (p.status === 'inactive') return 'inactive';
  if (p.status === 'unknown' || p.enforcementAction === 'unknown') return 'unknown';
  return p.enforcementAction;
}

export function OpaOverview({
  data,
  status
}: {
  data: OpaData;
  /** The completeness verdict for the ConstraintTemplate read behind every count here. */
  status: MetricStatus;
}): JSX.Element {
  const go = useFindingNavigation();
  const { risks, noted } = partitionFindings(buildOpaFindings(data));
  const s = data.summary;

  // Violation counts answer to the audit's own capability, which is a different question from
  // whether the policy list was readable: a running read of a dead audit produces a real list of
  // frozen numbers.
  const violationStatus = capabilityStatus(data.capabilities.violations, 'Audit violations');

  const bands: Record<PostureKey, number> = { invalid: 0, inactive: 0, unknown: 0, dryrun: 0, warn: 0, deny: 0 };
  for (const p of data.policies) bands[bandOf(p)] += 1;
  const placed = BANDS.reduce((n, b) => n + bands[b.key], 0);

  const categories = Object.entries(s.categories) as [OpaCategory, { policies: number; violations: number }][];
  const withPolicies = categories.filter(([, c]) => c.policies > 0);
  const maxViolations = Math.max(1, ...withPolicies.map(([, c]) => c.violations));

  // Highest risk first, and only the top slice: the preview exists to answer "what should I look at",
  // and the full list is one click away on its own tab.
  const preview = [...data.policies].sort(byRisk).slice(0, 8);

  /*
   * Six columns, and every text column wraps rather than truncates. Measured at 1440 (container
   * 920px) the previous eight-column preview cut all four text columns to an ellipsis — the policy
   * name, its purpose, its kinds and its scope — so the one table meant to answer "what should I
   * look at" named nothing in full. Target kinds and Last audit left for the Policies tab, which
   * carries both; the preview keeps what identifies a row and what ranks it.
   */
  const columns: Column<OpaPolicy>[] = [
    {
      key: 'policy',
      header: 'Policy',
      pin: true,
      priority: 1,
      max: '260px',
      render: p => (
        <div className="min-w-0">
          <div className="whitespace-normal font-medium text-text [overflow-wrap:anywhere]" title={p.displayName}>
            {p.displayName}
          </div>
          <div className="mono whitespace-normal text-[12px] text-muted [overflow-wrap:anywhere]" title={p.templateName}>
            {p.templateName}
          </div>
        </div>
      )
    },
    {
      key: 'purpose',
      header: 'Purpose',
      priority: 2,
      max: '280px',
      render: p => (
        <span
          className={`whitespace-normal ${p.purpose.source === 'identity' ? 'text-muted' : 'text-text'}`}
          title={`${p.purpose.text} (from ${p.purpose.source})`}
        >
          {p.purpose.text}
        </span>
      )
    },
    {
      key: 'action',
      header: 'Enforcement',
      priority: 1,
      width: '108px',
      render: p => <Pill tone={ACTION_TONE[p.enforcementAction]}>{p.enforcementAction}</Pill>
    },
    {
      key: 'scope',
      header: 'Scope',
      priority: 2,
      // One line for every evaluable form: "every namespace (30)" is 150px of text, which a 180px
      // border-box cap wrapped. 200px holds it with a three-digit count; Purpose gave up the 20px,
      // so the table's width is unchanged. The unreadable-list sentence is too long for any cap and
      // wraps rather than truncating.
      max: '200px',
      render: p => (
        <span className={p.namespaceScope.evaluable ? 'whitespace-nowrap' : 'whitespace-normal [overflow-wrap:break-word]'}>
          {scopeLine(p)}
        </span>
      )
    },
    {
      key: 'violations',
      header: 'Violations',
      align: 'right',
      priority: 1,
      width: '96px',
      render: p => (
        <Count
          status={violationStatus}
          value={p.violationCount}
        />
      )
    },
    {
      key: 'status',
      header: 'Status',
      priority: 1,
      width: '104px',
      render: p => <Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill>
    }
  ];

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------------ is the gate up */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line pb-3 text-[13px]">
        <span className="inline-flex items-center gap-2">
          <Dot tone={data.webhook.active === true ? 'ok' : data.webhook.active === false ? 'bad' : 'unknown'} />
          <span className="text-muted">Admission webhook</span>
          <span className="text-text">
            {data.webhook.present === false
              ? 'not registered — nothing is evaluated at admission'
              : data.webhook.active === true
                ? 'registered, backend ready'
                : data.webhook.active === false
                  ? 'registered, no ready backend'
                  : 'registered; backend readiness unknown'}
          </span>
        </span>
        {data.webhook.failurePolicy && (
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-muted">On failure</span>
            <span className="mono text-text">{data.webhook.failurePolicy}</span>
            <span className="text-[12px] text-muted">
              {data.webhook.failurePolicy === 'Ignore'
                ? '(fails open — writes are admitted unevaluated if Gatekeeper is down)'
                : '(fails closed — matching writes are rejected if Gatekeeper is down)'}
            </span>
          </span>
        )}
        {data.webhook.timeoutSeconds !== null && (
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-muted">Timeout</span>
            <span className="mono text-text">{data.webhook.timeoutSeconds}s</span>
          </span>
        )}
      </div>

      {/* ------------------------------------------------------------------ the six aggregates */}
      {/*
        One row, six cards, equal height — a CSS grid rather than flex, so the tiles in a row share a
        height without anyone measuring anything. Two columns at the narrowest desktop, three at
        `lg`, six at `2xl`: the row never wraps mid-card and never forces sideways scroll.
      */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        <StatTile
          label="Enforced (deny)"
          status={status}
          value={<Count status={status} value={bands.deny} size="lg" />}
          caption="reject a violating request at admission"
          valueClass={bands.deny > 0 ? 'text-ok' : 'text-text'}
          onClick={() => go({ params: { opa: 'policies', oaction: 'deny', ostatus: null } })}
          actionLabel="show the deny policies"
        />
        <StatTile
          label="Warn"
          status={status}
          value={<Count status={status} value={bands.warn} size="lg" />}
          caption="the request succeeds and carries a warning"
          valueClass={bands.warn > 0 ? 'text-warn' : 'text-text'}
          onClick={() => go({ params: { opa: 'policies', oaction: 'warn', ostatus: null } })}
          actionLabel="show the warn policies"
        />
        <StatTile
          label="Dry-run"
          status={status}
          value={<Count status={status} value={bands.dryrun} size="lg" />}
          caption="evaluated and recorded; nothing is blocked"
          valueClass={bands.dryrun > 0 ? 'text-accent' : 'text-text'}
          onClick={() => go({ params: { opa: 'policies', oaction: 'dryrun', ostatus: null } })}
          actionLabel="show the dry-run policies"
        />
        <StatTile
          label="Active audit violations"
          status={violationStatus}
          value={<Count status={violationStatus} value={s.auditViolationTotal} size="lg" />}
          caption={
            s.auditViolationCountPartial
              ? 'a floor — some counts could not be read'
              : 'existing objects the last audit found failing'
          }
          valueClass={s.auditViolationTotal > 0 ? 'text-warn' : 'text-text'}
          onClick={() => go({ params: { opa: 'violations' } })}
          actionLabel="show the violations"
        />
        {/*
          The card that must never show a zero. `capabilityStatus` of an untrusted verdict renders
          `Unavailable` through the same component that draws every other missing metric, so this
          cannot regress into "0 denials" by someone forgetting a conditional here.

          `why` is written to StatTile's two-line caption budget (~60 characters at 12px in a tile
          this wide). The previous sentence ran to 130 and `line-clamp-2` cut it mid-word — "…records
          what Gatekeeper decid" — which reads as a rendering bug rather than a reason. It also
          asserted a universal cause, and the cause is per-cluster: `decisions()` distinguishes no
          metrics Service from a refused read from an unreadable one, and Decision Activity is the
          screen that states which of the three this cluster has. So the tile points there instead of
          guessing on its behalf.
        */}
        <StatTile
          label="Admission denials (24h)"
          status={{
            state: 'unavailable',
            what: 'admission denials',
            why: 'No admission-decision source — see Decision Activity.',
            blind: 1,
            total: 1,
            truncated: false,
            truncatedWhy: ''
          }}
          value={null}
          caption=""
        />
        <StatTile
          label="Gatekeeper health"
          status={capabilityStatus(data.capabilities.runtime, 'Gatekeeper runtime')}
          value={
            <span className="text-[16px] font-semibold">
              {data.runtime.audit.state === 'running'
                ? 'Audit running'
                : data.runtime.audit.state === 'not-ready'
                  ? 'Audit not ready'
                  : data.runtime.audit.state === 'disabled'
                    ? 'Audit off'
                    : 'Unknown'}
            </span>
          }
          caption={
            data.runtime.audit.state === 'running'
              ? data.runtime.audit.intervalSeconds !== null
                ? `every ${data.runtime.audit.intervalSeconds}s — violation counts refresh`
                : 'violation counts refresh'
              : data.runtime.audit.state === 'disabled'
                ? 'no audit controller — violation counts cannot change'
                : 'violation counts are not being refreshed'
          }
          valueClass={
            data.runtime.audit.state === 'running'
              ? 'text-ok'
              : data.runtime.audit.state === 'unknown' || data.runtime.audit.state === 'unreadable'
                ? 'text-unknown'
                : 'text-warn'
          }
        />
      </div>

      {/* ------------------------------------------------------------------ findings */}
      <Section label={`High-risk findings (${risks.length})`}>
        {risks.length === 0 ? (
          <p className="text-[13px] text-muted">
            Nothing to flag: every policy read has a named enforcement action, a reachable webhook and no recorded
            violation. This is a statement about what was read, not a guarantee about what is not covered — see the
            Coverage tab for what is and is not in scope.
          </p>
        ) : (
          <div className="divide-y divide-line">
            {risks.map(f => (
              <FindingRow key={f.id} finding={f} />
            ))}
          </div>
        )}
        {/*
          What IS in force, as a line under the risks rather than a card among them: "3 policies
          deny" counted as one of two high-risk findings on a cluster whose only risk was fail-open.
          Still a button, because the number still has rows behind it.
        */}
        {noted.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 pt-1 text-[13px]">
            <span className="text-muted">In force</span>
            {noted.map(f => (
              <button
                key={f.id}
                type="button"
                onClick={() => go(f.destination)}
                className="text-left text-text underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent"
                title="Show the rows behind this statement"
              >
                {f.summary}
              </button>
            ))}
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------------ posture */}
      <Section
        label="Policy posture"
        hint={`${placed} of ${data.summary.policyCount} policy rows placed — every row lands in exactly one band`}
      >
        {placed === 0 ? (
          <p className="text-[13px] text-muted">No policy rows were read, so there is no posture to draw.</p>
        ) : (
          <div className="space-y-2">
            {/*
              A single stacked bar rather than a donut: the question is "what proportion of the
              declared policies can actually reject something", and a length comparison answers it
              without asking the reader to compare angles. Each segment is a button, so the bar is
              a filter and not a decoration.
            */}
            <div className="flex h-3 w-full overflow-hidden rounded-[4px] border border-line" role="group" aria-label="Policy posture">
              {BANDS.filter(b => bands[b.key] > 0).map(b => (
                <button
                  key={b.key}
                  type="button"
                  title={`${bands[b.key]} — ${b.hint}. Show these.`}
                  aria-label={`${bands[b.key]} policies: ${b.hint}`}
                  onClick={() =>
                    go({
                      params:
                        b.key === 'invalid'
                          ? { opa: 'policies', ostatus: 'broken', oaction: null }
                          : b.key === 'inactive' || b.key === 'unknown'
                            ? { opa: 'policies', ostatus: b.key, oaction: null }
                            : { opa: 'policies', oaction: b.key, ostatus: null }
                    })
                  }
                  className={`${b.cls} h-full transition-opacity hover:opacity-80`}
                  style={{ width: `${(bands[b.key] / placed) * 100}%` }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
              {BANDS.map(b => (
                <span key={b.key} className="inline-flex items-center gap-1.5" title={b.hint}>
                  <span className={`inline-block h-2 w-2 rounded-[2px] ${b.cls}`} aria-hidden="true" />
                  {b.label}
                  <span className="mono text-text">{bands[b.key]}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------------ categories */}
      <Section label="Violations by category">
        {withPolicies.length === 0 ? (
          <p className="text-[13px] text-muted">No policy has been categorised, because none was read.</p>
        ) : (
          <div className="space-y-2">
            {/*
              Categories come from an explicit map keyed on ConstraintTemplate name, with a
              unanimous-target-kind fallback and then `Other`. Never from the display name: a
              template called `restrict-jenkins-deployer` matching four RBAC kinds and a
              NetworkPolicy is not a "Networking" policy, and guessing from words would file it
              there with total confidence.
            */}
            <table className="tbl-inline">
              <tbody>
                {withPolicies
                  .sort((a, b) => b[1].violations - a[1].violations || a[0].localeCompare(b[0]))
                  .map(([name, c]) => (
                    <tr key={name}>
                      <td>
                        <button
                          type="button"
                          onClick={() => go({ params: { opa: 'policies', ocategory: name } })}
                          className="text-left underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent"
                          title={`Show the ${c.policies} ${name.toLowerCase()} ${c.policies === 1 ? 'policy' : 'policies'}`}
                        >
                          {name}
                        </button>
                        {name === 'Other' && (
                          <span className="ml-2 text-[12px] text-muted">uncategorised — no mapping matched</span>
                        )}
                      </td>
                      <td className="num w-[90px] text-muted">
                        {c.policies} {c.policies === 1 ? 'policy' : 'policies'}
                      </td>
                      <td className="w-[42%]">
                        <div className="h-2 w-full rounded-[2px] bg-raised">
                          <div
                            className={`h-full rounded-[2px] ${c.violations > 0 ? 'bg-warn' : 'bg-line'}`}
                            style={{ width: `${(c.violations / maxViolations) * 100}%` }}
                          />
                        </div>
                      </td>
                      <td className="num w-[110px]">
                        {c.violations === 0 ? (
                          <span className="text-muted">no violations</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => go({ params: { opa: 'violations', ocategory: name } })}
                            className="mono text-warn underline decoration-dotted decoration-line underline-offset-[3px] hover:text-accent"
                          >
                            {c.violations}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {s.auditViolationCountPartial && (
              <p className="text-[12px] text-warn">
                At least one violation count could not be read, so these totals are floors.
              </p>
            )}
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------------ library & bundles */}
      <LibrarySection data={data} status={status} />

      {/* ------------------------------------------------------------------ applied policies preview */}
      <Section
        label="Applied policies"
        hint="highest risk first"
        action={
          <button
            type="button"
            onClick={() => go({ params: { opa: 'policies' } })}
            className="inline-flex h-8 items-center rounded-[6px] border border-line bg-raised px-3 text-[13px] hover:border-line-strong"
          >
            View all policies
          </button>
        }
      >
        <DataTable
          columns={columns}
          rows={preview}
          rowKey={p => p.id}
          /* Six columns sit inside the base tier's range; below it Purpose and Scope (priority 2)
             shed before anything that identifies or ranks a row. */
          empty={
            <Empty
              title="No policies were read"
              hint="Gatekeeper is installed and its ConstraintTemplate list came back empty, so no Constraint governs admission here."
            />
          }
          onSelect={p => go({ params: { opa: 'policies', opasel: p.id } })}
        />
      </Section>

      {/* ------------------------------------------------------------------ what this screen is not */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12px] text-muted">
        <Pill tone={ACTION_TONE.deny}>audit</Pill>
        <span className="max-w-[90ch]">
          Every violation number on this page comes from the Gatekeeper audit, which evaluates objects that already
          exist. It is not a count of requests denied at admission — an object can violate a policy that was created
          after it. Runtime denial data, where a cluster publishes any, is on the Decision Activity tab.
        </span>
      </div>
    </div>
  );
}
