/**
 * The OPA Gatekeeper surface: seven nested tabs inside Security & Compliance → Admission & Policy.
 *
 * ## Where the fetches happen, and why here
 *
 * One `clusterOpa` read serves Overview, Policies, Violations and Coverage, because on the server
 * they are one collection: the same ConstraintTemplate list and the same per-template Constraint
 * reads produce all four. Splitting it into four endpoints would make four requests hit the same
 * cluster reads and give the four screens four chances to disagree about the same cluster. So it is
 * issued once, by this shell, when the OPA strip mounts — not by the Admission section above it,
 * which must stay cheap for operators who never open OPA.
 *
 * The two genuinely separable reads ARE deferred to their own mounted tab: Decision Activity's
 * Deployment read happens in `OpaDecisions`, and a policy's YAML happens in the drawer's YAML pane.
 * Neither is paid by anyone who does not open them.
 *
 * Admission Webhooks and Native policies add no read at all. The enclosing Security tab already
 * holds every validating and mutating webhook — risk-sorted, with blast radius — and every
 * ValidatingAdmissionPolicy joined to its bindings, from its own `clusterPolicy` read, so the
 * rows arrive as props. Re-fetching them here would ask the cluster the same question twice and let
 * the two screens disagree about the same webhook.
 *
 * ## Read-only
 *
 * Every control here is View, Inspect, Filter, Search or Open. There is no create, edit, delete,
 * apply, sync, enable/disable, enforcement change or exemption anywhere in this folder — and the
 * repo's grep guard over `srv/fleet` means the backend has no verb to reach even if a control were
 * added.
 */
import { useCallback, useMemo } from 'react';
import { api, type AdmissionWebhookEntry, type Capability, type NativePolicies, type OpaData } from '../../../api';
import { CapabilityBadge, CapabilityNotice } from '../../../capability';
import { ago } from '../../../format';
import { Card, ErrorState, Pill, Skeleton } from '../../../components/ui';
import {
  NotInstalledPanel,
  UnavailableNotice,
  unavailableScope,
  type MetricStatus
} from '../../../components/unavailable';
import { SubTabs, useUrlSection } from '../../../components/SubTabs';
import { useAsync } from '../../../useAsync';
import { OpaCoverage } from './OpaCoverage';
import { OpaDecisions } from './OpaDecisions';
import { OpaNativePolicies } from './OpaNativePolicies';
import { OpaOverview } from './OpaOverview';
import { OpaPolicies } from './OpaPolicies';
import { OpaViolations } from './OpaViolations';
import { OpaWebhooks } from './OpaWebhooks';
import { PolicyDrawer, usePolicySelection } from './PolicyDrawer';
import { useOpaFilters } from './shared';

export type OpaTabId = 'overview' | 'policies' | 'violations' | 'native' | 'webhooks' | 'coverage' | 'decisions';

/**
 * Exported, because the Admission & Policy section below this strip needs to *send* an operator
 * here. It used to render its own second list of the same webhooks; now it points at this one, and
 * a pointer can only be written against the real ids — a hand-typed `?opa=webhooks` that stopped
 * matching would silently land on OPA Overview instead of erroring.
 */
export const OPA_TABS = [
  { id: 'overview' as const, label: 'OPA Overview' },
  { id: 'policies' as const, label: 'Policies' },
  { id: 'violations' as const, label: 'Violations' },
  { id: 'native' as const, label: 'Native policies' },
  { id: 'webhooks' as const, label: 'Admission Webhooks' },
  { id: 'coverage' as const, label: 'Coverage' },
  { id: 'decisions' as const, label: 'Decision Activity' }
];

/**
 * Which capability verdict governs which tab.
 *
 * A map rather than a chain of conditionals so that adding a tab without deciding what its
 * unavailability looks like is a compile error in the making rather than a silently unguarded
 * screen. `native` and `webhooks` read their rows from the Security tab's request and `decisions` from its own, so
 * both state their verdicts inside their own components — hence the nulls.
 */
const TAB_CAPABILITY: Record<OpaTabId, ((d: OpaData) => Capability | null) | null> = {
  overview: d => (d.capabilities.policies.state === 'available' ? null : d.capabilities.policies),
  policies: d => d.capabilities.policies,
  violations: d => d.capabilities.violations,
  native: null,
  webhooks: null,
  coverage: d => d.capabilities.coverage,
  decisions: null
};

/**
 * The header every OPA tab shares: what this surface is, whether Gatekeeper is up, and how old the
 * evidence is.
 *
 * One header rather than one per tab, and it is why changing tabs cannot shift the page: the title,
 * the status and the metadata line are rendered above the tab strip by the shell, so only the panel
 * below the strip changes. Six tabs that each drew their own heading is how a console ends up with
 * six subtly different left edges.
 */
function OpaHeader({ data, collectedAt }: { data: OpaData; collectedAt: string | null }): JSX.Element {
  const r = data.runtime;
  const audit = r.audit;
  // The freshest audit across the policies IS the last audit: Gatekeeper stamps each constraint
  // separately, and the newest stamp is the last time the controller ran at all.
  const lastAudit = data.policies
    .map(p => p.audit.at)
    .filter((at): at is string => Boolean(at))
    .sort()
    .pop() ?? null;

  const auditWord =
    audit.state === 'running'
      ? audit.intervalSeconds !== null
        ? `running every ${audit.intervalSeconds}s`
        : 'running'
      : audit.state === 'not-ready'
        ? 'no ready replica'
        : audit.state === 'disabled'
          ? 'not running'
          : audit.state === 'unreadable'
            ? 'unreadable'
            : 'unknown';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-[18px] font-medium text-text">OPA Policy Governance</h3>
        {/* The native state, not a derived verdict: these are Gatekeeper's own words about itself. */}
        <Pill
          tone={
            data.gatekeeper.state === 'installed'
              ? 'ok'
              : data.gatekeeper.state === 'no-templates'
                ? 'warn'
                : data.gatekeeper.state === 'forbidden'
                  ? 'bad'
                  : 'unknown'
          }
        >
          {data.gatekeeper.state === 'installed'
            ? 'Gatekeeper installed'
            : data.gatekeeper.state === 'no-templates'
              ? 'Installed, no templates'
              : data.gatekeeper.state === 'forbidden'
                ? 'Reads refused'
                : 'Not installed'}
        </Pill>
        <CapabilityBadge capability={data.capabilities.runtime} />
      </div>
      <p className="max-w-[110ch] text-[13px] text-muted">
        Understand which policies are applied, what they enforce and which resources are affected.
      </p>
      {/* One compact metadata line. Every entry is a fact this cluster reported, or the word that
          says it did not — never a blank, which reads as "nothing to say". */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-line pt-2 text-[12px] text-muted">
        <span>
          Version{' '}
          {r.version ? (
            <span className="mono text-text" title={r.versionSource ?? undefined}>
              {r.version}
            </span>
          ) : (
            <span className="text-text">unavailable</span>
          )}
        </span>
        <span>
          Audit <span className="text-text">{auditWord}</span>
        </span>
        <span>
          Last audit{' '}
          <span className="mono text-text" title={lastAudit ?? undefined}>
            {lastAudit ? ago(lastAudit) : audit.state === 'disabled' ? 'never — audit not running' : 'unknown'}
          </span>
        </span>
        {audit.violationsLimit !== null && (
          <span>
            Itemised per constraint <span className="mono text-text">max {audit.violationsLimit}</span>
          </span>
        )}
        <span>
          Data <span className="mono text-text">{collectedAt ? ago(collectedAt) : 'unknown'}</span>
        </span>
      </div>
    </div>
  );
}

export function OpaSection({
  id,
  webhooks,
  webhooksStatus,
  webhooksLoading,
  nativePolicies,
  nativeStatus
}: {
  id: string;
  /** Handed down from the Security tab's `clusterPolicy` read — every webhook, not only fail-open. */
  webhooks: AdmissionWebhookEntry[] | null;
  webhooksStatus: MetricStatus;
  webhooksLoading: boolean;
  /** Same read as `webhooks`: the built-in ValidatingAdmissionPolicies joined to their bindings. */
  nativePolicies: NativePolicies | null;
  nativeStatus: MetricStatus;
}): JSX.Element {
  const opa = useAsync(useCallback(() => api.clusterOpa(id), [id]), 0, id);
  const [tab, setTab] = useUrlSection<OpaTabId>('opa', OPA_TABS, 'overview', { keepResource: true });
  const { filters, set: setFilters, reset: resetFilters, activeCount } = useOpaFilters();
  const [selectedId, selectPolicy] = usePolicySelection();

  const scope = unavailableScope({ clusters: opa.data ? [{ ...opa.data, id }] : [] });
  // Every count on these screens traces back to the ConstraintTemplate list and the per-template
  // Constraint reads, so one status covers them all. `constrainttemplates` is the label
  // `absentList` used on the server.
  const status = scope.of('Gatekeeper policies', 'constrainttemplates');

  const data: OpaData | null = opa.data?.ok ? opa.data.data ?? null : null;
  const selected = useMemo(
    () => (data && selectedId ? data.policies.find(p => p.id === selectedId) ?? null : null),
    [data, selectedId]
  );
  const selectedViolations = useMemo(
    () => (data && selectedId ? data.violations.filter(v => v.policyId === selectedId) : []),
    [data, selectedId]
  );

  return (
    // No card title: `OpaHeader` below renders the title, the native status and the metadata line as
    // one block above the tab strip. A card header as well would put two competing titles on the
    // screen and cost 52px of vertical space to say the same thing twice.
    <Card>
      {opa.initial && <Skeleton rows={6} />}

      {/* The page-level failure. Distinct from a gap inside a response: nothing below can be
          trusted, so no zeros are drawn at all. */}
      {!opa.initial && opa.error && !opa.data && <ErrorState code={opa.error.code} message={opa.error.message} />}
      {!opa.initial && opa.data && !opa.data.ok && (
        <ErrorState
          cluster={id}
          code={opa.data.error?.code ?? 'UNKNOWN'}
          message={opa.data.error?.message ?? 'this cluster did not answer'}
          needsReseed={opa.data.error?.needsReseed}
        />
      )}

      {!opa.initial && data && (
        <div className="space-y-4">
          {/*
            Installed, absent, or refused — three different answers, three different screens. The
            distinction that matters most: `forbidden` means the CRDs may well be there and this
            console cannot see them, which is a credential problem, while `absent` is a fact about
            the cluster. Collapsing them into "not installed" sends an operator to fix the wrong
            thing.
          */}
          {data.gatekeeper.state === 'absent' || data.gatekeeper.state === 'unreadable' ? (
            <NotInstalledPanel what="OPA Gatekeeper" detail={data.gatekeeper.detail} />
          ) : data.gatekeeper.state === 'forbidden' ? (
            <ErrorState
              cluster={id}
              code="FORBIDDEN"
              message={
                data.gatekeeper.detail ??
                'This cluster refused the Gatekeeper resource reads, so whether Gatekeeper is installed cannot be determined from here. This is an access result, not an absence.'
              }
              needsReseed={false}
              command="npm run fleet:onboard"
            />
          ) : (
            <>
              <OpaHeader data={data} collectedAt={data.collectedAt} />

              <UnavailableNotice scope={scope} />

              {/*
                The verdict for the tab that is actually open, above the panel it governs.
                Per-tab rather than page-level: a refused Constraint read must not put a banner on
                the Admission Webhooks tab, whose rows come from a different request entirely.
              */}
              <CapabilityNotice capability={TAB_CAPABILITY[tab] ? TAB_CAPABILITY[tab](data) : null} />

              <SubTabs
                sections={OPA_TABS}
                active={tab}
                onSelect={setTab}
                counts={{
                  // The counts follow the feature's own verdict: an untrusted one shows no number
                  // rather than a zero the operator would read as "clean".
                  policies: data.capabilities.policies.trusted ? data.summary.policyCount : null,
                  violations: data.capabilities.violations.trusted ? data.violations.length : null,
                  // The webhook count comes from a different read with its own status, so it is
                  // suppressed on that read's failure rather than on the Gatekeeper one.
                  native: nativeStatus.state === 'ok' && nativePolicies ? nativePolicies.policies.length : null,
                  webhooks: webhooksStatus.state === 'ok' && webhooks ? webhooks.length : null
                }}
              />

              {/*
                A flex row so `DetailPanel` can seat itself beside the table above 1280px and take
                width away from it, which is what makes the table's own column-priority shedding
                fire. Below that it falls back to a modal overlay on its own.
              */}
              <div className="flex min-w-0 gap-4">
                <div className="min-w-0 flex-1">
                  {tab === 'overview' && <OpaOverview data={data} status={status} />}
                  {tab === 'policies' && (
                    <OpaPolicies
                      data={data}
                      status={status}
                      filters={filters}
                      setFilters={setFilters}
                      resetFilters={resetFilters}
                      activeFilters={activeCount}
                      selectedId={selectedId}
                      onSelect={p => selectPolicy(p.id)}
                    />
                  )}
                  {tab === 'violations' && (
                    <OpaViolations
                      data={data}
                      status={status}
                      filters={filters}
                      setFilters={setFilters}
                      resetFilters={resetFilters}
                      activeFilters={activeCount}
                      onOpenPolicy={selectPolicy}
                    />
                  )}
                  {tab === 'native' && (
                    <OpaNativePolicies native={nativePolicies} status={nativeStatus} loading={webhooksLoading} />
                  )}
                  {tab === 'webhooks' && (
                    <OpaWebhooks webhooks={webhooks} status={webhooksStatus} loading={webhooksLoading} />
                  )}
                  {tab === 'coverage' && <OpaCoverage data={data} />}
                  {tab === 'decisions' && <OpaDecisions cluster={id} opa={data} />}
                </div>

                {selected && (
                  <PolicyDrawer
                    cluster={id}
                    policy={selected}
                    violations={selectedViolations}
                    onClose={() => selectPolicy(null)}
                    onShowViolations={() => {
                      setFilters({ policy: selected.id });
                      setTab('violations');
                    }}
                  />
                )}
                {/*
                  A drawer whose policy is not in the payload — a stale link, or a policy removed
                  since. Said plainly rather than left as a silent no-op, which reads as a broken
                  click.
                */}
                {selectedId && !selected && (
                  <div className="w-[320px] shrink-0 rounded-[8px] border border-line bg-surface p-4 text-[13px] text-muted">
                    <p className="font-medium text-text">That policy is not in this cluster’s current read.</p>
                    <p className="mt-1">
                      It may have been removed since the link was made, or it belongs to another cluster.
                    </p>
                    <button
                      type="button"
                      onClick={() => selectPolicy(null)}
                      className="mt-3 inline-flex h-8 items-center rounded-[6px] border border-line bg-raised px-3 text-[13px] text-text"
                    >
                      Close
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
