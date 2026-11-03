/**
 * Security & Compliance tab for one cluster's detail page.
 *
 * Folds two formerly-standalone global pages down to a single already-known cluster:
 *   - Security.tsx's per-cluster row (NetworkPolicy isolation, container security posture,
 *     secret metadata) — sourced from `api.clusterSecurity(id)`. This used to fetch the
 *     fleet-wide `api.security()` and pick this cluster's row out of the array, which paid for
 *     every cluster's pod-and-secret sweep to draw one; the per-cluster route carries the same
 *     `SecuritySummary` and lands on the `sec:<id>` cache entry the Overview tile already primed.
 *   - Compliance.tsx's "Admission Policy" (C1/C2) and "RBAC & PDBs" (C3) sections — sourced
 *     from the real per-cluster `api.clusterPolicy(id)`.
 *
 * The plain namespace-compliance-checks list (findings/warnings per namespace) already has
 * a home as `ComplianceTab` in ClusterDetail.tsx and is deliberately not duplicated here.
 *
 * The two sections fetch independently (`useAsync` per source), so a refused policy read on
 * this cluster cannot blank the security posture next to it, and vice versa.
 */
import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { api, type NetPolDirection, type NetworkPolicyByNamespace, type PolicyData } from '../../api';
import { Section, Field } from '../../components/layout';
import { Card, ErrorState, Pill, Skeleton, type Tone } from '../../components/ui';
import { ResourceLink } from '../../components/ResourceLink';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Count,
  MetricValue,
  NotInstalled,
  NotInstalledPanel,
  Unavailable,
  UnavailableEmptyBody,
  envelopeScope,
  unavailableScope
} from '../../components/unavailable';
import { useAsync } from '../../useAsync';
import { SubTabs, useSection, useUrlSection } from '../../components/SubTabs';
import { mergeElevated, namesAreReported, type ElevatedContainer } from './elevated-containers';
import {
  ISOLATION_METHOD_WHY,
  ISOLATION_NOTHING_AUDITED_WHY,
  ISOLATION_NOT_REPORTED_WHY,
  RATIO_UNSTABLE_WHY,
  isolationRendering
} from './security-isolation';
import {
  DRAIN_BLOCKER_LABEL,
  DRAIN_BLOCKER_QUALIFIER,
  DRAIN_COVERAGE_CONVERSE,
  PDB_UNRECONCILED_WHY,
  drainBlockerHeading,
  unreconciledHeading
} from './pdb-drain';
import { TAB_SECTIONS } from './tabs';
import { OPA_TABS, OpaSection, type OpaTabId } from './opa/OpaSection';

// -----------------------------------------------------------------------------------------
// C1/C2/C3 shapes — same narrowing pattern as Compliance.tsx's `narrowPolicy`: `PolicyData`
// types `admission` / `failClosedWebhooks` / `pdbCoverage` as `unknown` in api.ts, matched
// here against what `srv/fleet/collectors/policy.js` actually returns.
// -----------------------------------------------------------------------------------------

interface AdmissionTemplate {
  name: string;
  kind: string | null;
  plural: string;
  constraintCount: number;
  constraintsUnavailable: boolean;
  admissionActions: string[];
}

interface AdmissionVerdict {
  policyEngineVerdict: 'enforcing' | 'installed-inert' | 'enforcement-suspended' | 'unknown' | 'absent' | string;
  webhookPresent: boolean | null;
  webhookBackendStatus: string | null;
  constraintTemplateCount: number;
  constraintTemplates: AdmissionTemplate[];
}

interface PdbCoverage {
  totalWorkloads: number;
  coveredWorkloads: number;
  coveragePercent: number | null;
  selectorUnmatched: { name: string; namespace: string }[];
  drainBlockers: { name: string; namespace: string }[];
  /**
   * PDBs whose `status.observedGeneration` lags `metadata.generation` — the controller has not
   * evaluated the current spec, so they belong in neither the blocking nor the safe list. Optional:
   * a server predating the field reports nothing, which is not the same as "there are none".
   */
  unreconciled?: {
    name: string;
    namespace: string;
    observedGeneration: number | null;
    generation: number | null;
  }[];
  unavailable: string[];
  truncated: string[];
}

/** Cast site for the three narrowed fields above — one place, so a real shape change is one diff. */
function narrowPolicy(data: PolicyData) {
  return {
    admission: data.admission as unknown as AdmissionVerdict,
    failClosedWebhooks: data.failClosedWebhooks,
    nativePolicies: data.nativePolicies,
    pdbCoverage: data.pdbCoverage as unknown as PdbCoverage
  };
}

const VERDICT_TONE: Record<string, Tone> = {
  enforcing: 'ok',
  'installed-inert': 'warn',
  'enforcement-suspended': 'bad',
  unknown: 'unknown'
};

/** How many PDB names to print before the list is summarised. */
const PDB_LIST_CAP = 10;

/** How many template names a finding prints before it becomes the list it replaced. */
const TEMPLATE_NAME_CAP = 6;

/*
  There used to be a second webhook list here.

  It rendered the same `failClosedWebhooks` rows that OPA's **Admission Webhooks** tab renders from
  the same prop, a few hundred pixels higher up this very section — one screen, one payload, two
  lists. Worse, the two described it differently: this one had a three-value `risk` (`fail-open` /
  `latent-risk` / `active-outage-risk`), while `OpaWebhooks` relays the server's six-value
  `effectiveStatus`, which separates *declared but matching nothing* and *narrowed by an
  objectSelector* from plain fail-open. So the weaker vocabulary could call a webhook healthy while
  the upper list called it out — two answers about one object, which is the thing the resource layer
  exists to prevent.

  The richer list won. What is left in the card below is the cross-mechanism strip, the engine
  verdict, and a control that takes you to that list.
*/

const SECTIONS = TAB_SECTIONS.security;

type SectionId = (typeof SECTIONS)[number]['id'];

// -----------------------------------------------------------------------------------------
// NetworkPolicy protection by namespace
//
// Was one bordered card per namespace carrying a single pill — 18 cards, ~44px each, to say
// two facts about each namespace, and the pill said "4 Policies" in green for a namespace where
// none of those four policies selected half its pods. A table says more in less space and, more
// to the point, has room for the columns that turn a policy count into a protection verdict.
//
// The direction columns are the substance. `partial` is its own state on purpose: policies
// govern the direction, but every one of them is pod-selective, so a pod outside those selectors
// is unrestricted. Folding it into `all` is how the green pill lied.
//
// Every column here is a field `srv/fleet/collectors/security.js` already returns from reads it
// was already making. No new cluster call, no new RBAC rule.
// -----------------------------------------------------------------------------------------

const DIRECTION_TONE: Record<NetPolDirection, Tone> = {
  all: 'ok',
  partial: 'warn',
  none: 'bad'
};

const DIRECTION_WORD: Record<NetPolDirection, string> = {
  all: 'All pods',
  partial: 'Partial',
  none: 'None'
};

const DIRECTION_WHY: Record<NetPolDirection, string> = {
  all: 'at least one policy covers this direction with an all-pods selector, so every pod here is governed in this direction. The allow rules inside the policies are not evaluated.',
  partial: 'policies cover this direction, but all of them are pod-selective — pods outside those selectors are unrestricted',
  none: 'no policy in this namespace governs this direction'
};

/**
 * An absent direction means the server predates the field, which is not the same as `none`.
 * Rendering it as a red "None" would invent a finding, so it stays an explicit em-dash.
 */
function DirectionCell({ value }: { value: NetPolDirection | undefined }) {
  if (!value) return <span className="text-muted" title="This server did not report direction coverage.">—</span>;
  return (
    <Pill tone={DIRECTION_TONE[value]} title={DIRECTION_WHY[value]}>
      {DIRECTION_WORD[value]}
    </Pill>
  );
}

/**
 * The row verdict, derived from the two directions and the exception count — presentation only,
 * so it lives here rather than in the collector.
 */
function rowStatus(np: NetworkPolicyByNamespace): { tone: Tone; word: string; why: string } {
  // An empty namespace with no policy is not a finding — there is nothing in it to reach. Red
  // here would put eight false alarms above the two namespaces that are genuinely exposed, which
  // is how a posture table stops being read.
  if (!np.hasNetworkPolicy && np.podsObserved === 0) {
    return { tone: 'unknown', word: 'No workloads', why: 'no pods observed here, so there is nothing for a policy to protect' };
  }
  if (!np.hasNetworkPolicy) {
    return { tone: 'bad', word: 'Unprotected', why: 'no NetworkPolicy exists in this namespace' };
  }
  if (np.ingress === undefined || np.egress === undefined) {
    return { tone: 'unknown', word: `${np.policyCount} policies`, why: 'this server did not report direction coverage' };
  }
  if (np.ingress === 'all' && np.egress === 'all') {
    return { tone: 'ok', word: 'Isolated', why: 'both directions are governed by an all-pods selector, so an unlabelled pod is subject to policy in both directions. Whether a given connection is denied depends on the allow rules, which are not evaluated here.' };
  }
  if (np.unselectedPods) {
    return {
      tone: 'warn',
      word: 'Gaps',
      why: `${np.unselectedPods} pod${np.unselectedPods === 1 ? '' : 's'} here match no policy selector`
    };
  }
  return { tone: 'warn', word: 'Partial', why: 'one direction is uncovered or only pod-selectively covered' };
}

/**
 * Worst first. Alphabetical put eight empty namespaces above the two with exposed pods, and the
 * row an operator opens this section for was below the fold. Ties break on name so the order is
 * stable between refreshes.
 */
const STATUS_RANK: Record<string, number> = { Unprotected: 0, Gaps: 1, Partial: 2, Isolated: 3, 'No workloads': 4 };

function byExposure(a: NetworkPolicyByNamespace, b: NetworkPolicyByNamespace): number {
  const ra = STATUS_RANK[rowStatus(a).word] ?? 2;
  const rb = STATUS_RANK[rowStatus(b).word] ?? 2;
  if (ra !== rb) return ra - rb;
  // Within a tier, more exposed pods first — the size of the blast radius, not just its kind.
  const ea = (a.unselectedPods ?? 0) || (a.hasNetworkPolicy ? 0 : a.podsObserved ?? 0);
  const eb = (b.unselectedPods ?? 0) || (b.hasNetworkPolicy ? 0 : b.podsObserved ?? 0);
  if (ea !== eb) return eb - ea;
  return a.namespace.localeCompare(b.namespace);
}

const NETPOL_COLUMNS: Column<NetworkPolicyByNamespace>[] = [
  {
    key: 'namespace',
    header: 'Namespace',
    width: '150px',
    max: '150px',
    // A link, because this was the one table on the tab where every row named a real object and none
    // of them could be opened. `Namespace` resolves from the overview payload the cluster page
    // already holds, so the drawer fills in from any tab and no navigation is needed — unlike
    // `Service`, which declares a `home` tab and makes the page move to reach its resolver.
    render: np => (
      <ResourceLink
        refTo={{ kind: 'Namespace', namespace: null, name: np.namespace }}
        className="font-medium text-text"
      />
    )
  },
  {
    key: 'pods',
    header: 'Pods',
    align: 'right',
    width: '80px',
    // Sheds at 1100 (priority 3), before Unselected pods, which carries the isolation verdict.
    priority: 3,
    render: np =>
      np.podsObserved === undefined
        ? <span className="text-muted">—</span>
        : <span className="mono">{np.podsObserved}</span>
  },
  {
    key: 'ingress',
    header: 'Ingress',
    width: '110px',
    render: np => <DirectionCell value={np.ingress} />
  },
  {
    key: 'egress',
    header: 'Egress',
    width: '110px',
    render: np => <DirectionCell value={np.egress} />
  },
  {
    key: 'policies',
    header: 'Policies',
    align: 'right',
    width: '86px',
    render: np => <span className="mono">{np.policyCount}</span>
  },
  {
    key: 'exceptions',
    header: 'Unselected pods',
    align: 'right',
    width: '130px',
    priority: 2,
    render: np => {
      if (np.unselectedPods === undefined) return <span className="text-muted">—</span>;
      if (np.unselectedPods === 0) return <span className="mono text-muted">0</span>;
      return (
        <span className="mono text-bad" title="These pods are selected by no NetworkPolicy in this namespace.">
          {np.unselectedPods}
        </span>
      );
    }
  },
  {
    key: 'status',
    header: 'Status',
    width: '130px',
    render: np => {
      const s = rowStatus(np);
      return (
        <Pill tone={s.tone} title={s.why}>
          {s.word}
        </Pill>
      );
    }
  }
];

// -----------------------------------------------------------------------------------------
// Containers with elevated privileges
//
// "9 Privileged" and "71 / 147 non-root" were the two most actionable numbers on the tab and
// both were dead ends: the operator was told a count and given no way to find out which
// containers it was about, on a console whose entire premise is that a number leads to the
// object behind it. `srv/fleet/collectors/security.js` now names them from the same pod walk
// that produced the counts — no extra cluster read, no extra RBAC rule.
//
// The two lists are merged into one table because they overlap: `privileged: true` implies root
// capability, so rendering them separately would print the same container twice under two
// headings and inflate what an operator reads as the size of the problem. One row per container,
// with both findings on it, is the honest count.
// -----------------------------------------------------------------------------------------

const ELEVATED_COLUMNS: Column<ElevatedContainer>[] = [
  {
    key: 'namespace',
    header: 'Namespace',
    width: '150px',
    max: '150px',
    render: c => (
      <ResourceLink refTo={{ kind: 'Namespace', namespace: null, name: c.namespace }} className="text-text" />
    )
  },
  {
    key: 'pod',
    header: 'Pod',
    width: '220px',
    max: '220px',
    render: c => (
      <ResourceLink
        refTo={{ kind: 'Pod', namespace: c.namespace, name: c.pod }}
        className="font-medium text-text"
      />
    )
  },
  {
    // The container itself, not just its pod: `Container` is a ref on the Pod rather than an
    // object of its own (see `ResourceRef.container`), and its drawer is where the securityContext
    // that caused the finding is actually visible.
    key: 'container',
    header: 'Container',
    align: 'left',
    width: '160px',
    max: '160px',
    render: c => (
      <ResourceLink
        refTo={{ kind: 'Container', namespace: c.namespace, name: c.pod, container: c.container }}
        className="mono text-[13px] text-text"
      />
    )
  },
  {
    key: 'finding',
    header: 'Finding',
    // Four fixed columns summed to 910px, wider than the 1100 content box: the pills clipped.
    width: '220px',
    render: c => (
      <span className="flex flex-wrap items-center gap-1.5">
        {c.privileged && (
          <Pill tone="bad" title="privileged: true — this container has the host's capabilities.">
            Privileged
          </Pill>
        )}
        {c.rootCapable && (
          <Pill
            tone="warn"
            title="Nothing in the pod or container securityContext stops this container running as uid 0."
          >
            Root-capable
          </Pill>
        )}
      </span>
    )
  }
];

/**
 * Security posture and isolation — the container/Secret/NetworkPolicy audit.
 *
 * Its own component, and its own fetch, so that opening the tab no longer pays for the policy
 * sweep as well. Only the mounted section reads.
 *
 * Mounted as Security & Isolation (`?section=isolation`): removed from the strip 2026-09-25,
 * restored 2026-09-26.
 */
export function IsolationSection({ id }: { id: string }): JSX.Element {
  const security = useAsync(useCallback(() => api.clusterSecurity(id), [id]), 0, id);

  const payload = security.data?.ok ? security.data.data : undefined;
  const summary = payload?.summary;
  const unreachable = security.data && !security.data.ok ? security.data : undefined;

  const securityScope = envelopeScope(id, summary);
  const policyIsolationStatus = securityScope.of('NetworkPolicy isolation', 'networkpolicies');
  const podStatus = securityScope.of('container audit', 'pods');
  const secretStatus = securityScope.of('secret metadata', 'secrets');
  const nsStatus = securityScope.of('namespaces', 'namespaces');
  // Both reads feed the coverage ratio — the namespace list is its denominator and the policy list
  // its numerator — so a cut or refusal in either one is a fact about the ratio, not just about one
  // of the two tiles it used to be attached to.
  const isolationRatioStatus = securityScope.of('NetworkPolicy coverage', 'networkpolicies', 'namespaces');
  const isolation = useMemo(
    () => isolationRendering(summary, { truncated: isolationRatioStatus.truncated }),
    [summary, isolationRatioStatus.truncated]
  );

  // Sorted here rather than in the render so the comparator — which calls `rowStatus` twice per
  // comparison — runs once per payload instead of once per paint.
  const netPolRows = useMemo(
    () => [...(payload?.networkPolicies ?? [])].sort(byExposure),
    [payload?.networkPolicies]
  );
  const saStatus = securityScope.of('ServiceAccounts', 'serviceaccounts');

  // The two posture lists, merged once per payload. `privilegedContainerList` absent means this
  // server predates the field, which is not the same as "there are none" — hence `undefined`
  // rather than `[]` below, so the section can stay silent instead of claiming a clean audit.
  const elevated = useMemo(
    () => mergeElevated(payload?.privilegedContainerList, payload?.rootCapableContainerList),
    [payload?.privilegedContainerList, payload?.rootCapableContainerList]
  );
  const namesReported = payload ? namesAreReported(payload) : false;
  // Each list has its own truncation label, and either can be cut without the other, so the floor
  // is read per list rather than folded into `podStatus`.
  const elevatedStatus = securityScope.of(
    'the flagged containers',
    'containers[privileged]',
    'containers[root-capable]'
  );

  /**
   * What the type buckets actually account for.
   *
   * `secretTypeDistributionComplete` has existed on the wire, been typed and been backend-tested
   * since the completeness contract landed, and no UI file read it — so a breakdown missing a
   * refused or paging-capped type rendered exactly like a whole one. The collector's own comment
   * says "the UI must not present them as a whole"; this is that sentence, enforced.
   */
  const accountedSecrets = useMemo(
    () => Object.values(payload?.secretTypeDistribution ?? {}).reduce((sum, n) => sum + n, 0),
    [payload?.secretTypeDistribution]
  );

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------------ Security */}
      <Card title="Security & isolation">
        {security.initial && <Skeleton rows={5} />}
        {!security.initial && !payload && !unreachable && !security.error && (
          <div className="py-4 text-[14px] text-muted">No security posture reported for this cluster.</div>
        )}
        {!security.initial && security.error && !payload && (
          <ErrorState code={security.error.code} message={security.error.message} />
        )}
        {unreachable && (
          <ErrorState
            cluster={id}
            code={unreachable.error?.code ?? 'UNREACHABLE'}
            message={unreachable.error?.message ?? 'this cluster did not answer'}
            needsReseed={unreachable.error?.needsReseed}
          />
        )}
        {payload && summary && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {/*
                The bar is gone. It drew `networkPolicyIsolationScore` — the fraction of app
                namespaces holding at least one NetworkPolicy, which is the weaker of the two
                claims the collector reports, `100` when nothing was audited at all, and unclamped
                against its own track. A filled accent bar also hid which of the two counts it was
                drawing. What replaces it is the two counts themselves, from
                `security-isolation.ts` so the rule is unit-tested.
              */}
              <Field
                label="NetworkPolicy coverage"
                value={
                  <MetricValue
                    // The floor sentence is suppressed on purpose: a truncated *ratio* is not a
                    // floor, so it is marked below in its own words instead of borrowing the
                    // "at least this many" vocabulary that applies to counts.
                    status={{ ...isolationRatioStatus, truncated: false, truncatedWhy: '' }}
                    size="sm"
                  >
                    {isolation.coverage === null ? (
                      <span
                        className="text-muted"
                        title={
                          isolation.coverageAbsence === 'nothing-audited'
                            ? ISOLATION_NOTHING_AUDITED_WHY
                            : ISOLATION_NOT_REPORTED_WHY
                        }
                      >
                        not reported
                      </span>
                    ) : (
                      <span className="block">
                        <span className="text-[13px] text-text">{isolation.coverage}</span>
                        <span className="block text-[13px] text-muted" title={ISOLATION_METHOD_WHY}>
                          {isolation.isolated === null
                            ? 'direction coverage not reported by this server'
                            : isolation.isolated}
                        </span>
                        {isolation.ratioUnstable && (
                          <span className="block text-[12px] text-warn" title={RATIO_UNSTABLE_WHY}>
                            partial read - ratio may move in either direction
                          </span>
                        )}
                      </span>
                    )}
                  </MetricValue>
                }
              />
              <Field
                label="Non-root containers"
                value={
                  <MetricValue status={podStatus} size="sm">
                    <span className="mono">
                      {summary.nonRootContainers} / {summary.totalContainers}
                    </span>
                  </MetricValue>
                }
              />
              <Field
                label="Privileged containers"
                value={
                  <MetricValue status={podStatus} size="sm">
                    <Pill tone={summary.privilegedContainers === 0 ? 'ok' : 'warn'}>
                      {summary.privilegedContainers === 0
                        ? '0 Privileged'
                        : `${summary.privilegedContainers} Privileged`}
                    </Pill>
                  </MetricValue>
                }
              />
              <Field
                label="Secrets (metadata only)"
                value={
                  <MetricValue status={secretStatus} size="sm">
                    <span className="mono">{summary.totalSecretsCount}</span>
                  </MetricValue>
                }
              />
            </div>

            {/*
              The denominators. Every percentage and every count above is only as meaningful as
              the sweep behind it, and until now the console showed the numerators alone: "68%
              isolated" reads very differently when 4 of 31 namespaces were audited than when
              all 31 were. `appNamespacesAudited` is deliberately smaller than
              `totalNamespaces` — the collector skips `kube-*`/`istio-system`-class namespaces
              on purpose, because a system namespace with no NetworkPolicy is not a finding.
              ServiceAccounts sit here rather than beside Secrets: it is the identity surface
              the RBAC questions attach to, not a secret-material count.
            */}
            <Section label="Audit scope — what these numbers cover">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
                <Field
                  label="App namespaces audited"
                  value={
                    <MetricValue status={nsStatus} size="sm">
                      <span className="mono">
                        {summary.appNamespacesAudited} / {summary.totalNamespaces}
                      </span>
                    </MetricValue>
                  }
                />
                <Field
                  label="NetworkPolicies"
                  value={
                    <MetricValue status={policyIsolationStatus} size="sm">
                      <span className="mono">{summary.totalNetworkPolicies}</span>
                    </MetricValue>
                  }
                />
                {/*
                  Beside the policy count on purpose. "5 of 18 namespaces have a NetworkPolicy"
                  is the number the isolation score above is built on, and it is the weaker
                  claim; this is how many of those 5 actually deny an unlabelled pod in both
                  directions. Where they differ, the table below says which namespaces.
                */}
                <Field
                  label="Fully isolated namespaces"
                  value={
                    <MetricValue status={policyIsolationStatus} size="sm">
                      {summary.networkPolicyFullyIsolatedNamespaces === undefined ? (
                        <span className="text-muted" title="This server did not report direction coverage.">—</span>
                      ) : (
                        <span className="mono">
                          {summary.networkPolicyFullyIsolatedNamespaces} / {summary.networkPolicyProtectedNamespaces}
                        </span>
                      )}
                    </MetricValue>
                  }
                />
                <Field
                  label="Pods audited"
                  value={
                    <MetricValue status={podStatus} size="sm">
                      <span className="mono">{summary.totalPodsAudited}</span>
                    </MetricValue>
                  }
                />
                <Field
                  label="ServiceAccounts"
                  value={
                    <MetricValue status={saStatus} size="sm">
                      <span className="mono">{summary.totalServiceAccounts}</span>
                    </MetricValue>
                  }
                />
              </div>
            </Section>

            {/*
              The names behind the two container counts above.
              Rendered only when the server actually reports the lists: an older server sends no
              list at all, and an empty table under a heading that says "flagged" would read as
              "the audit found nothing" when the truth is "this server does not say".
            */}
            {namesReported && (elevated.length > 0 || summary.privilegedContainers > 0) && (
              <Section label="Containers with elevated privileges">
                <DataTable
                  rows={elevated}
                  rowKey={c => `${c.namespace}/${c.pod}/${c.container}`}
                  columns={ELEVATED_COLUMNS}
                  empty={
                    podStatus.state === 'ok' ? (
                      <div className="text-[13px] text-muted">
                        The audit counted flagged containers but named none. The counts above stand;
                        the list does not.
                      </div>
                    ) : (
                      <UnavailableEmptyBody status={podStatus} />
                    )
                  }
                />
                {elevatedStatus.truncated && (
                  <p className="pt-2 text-[13px] text-warn">
                    {elevatedStatus.truncatedWhy}. The counts above are the true totals — only this
                    list of names was cut.
                  </p>
                )}
              </Section>
            )}

            <Section label="NetworkPolicy protection by namespace">
              {/*
                What this table did and did not evaluate, said once above it rather than only in
                seven column tooltips: the verdicts come from `policyTypes` and `podSelector`, so
                "All pods" means the direction is governed for every pod — not that a named
                connection was tested and refused.
              */}
              <p className="pb-2 text-[13px] text-muted">{ISOLATION_METHOD_WHY}</p>
              <DataTable
                rows={netPolRows}
                rowKey={np => np.namespace}
                columns={NETPOL_COLUMNS}
                empty={
                  policyIsolationStatus.state === 'ok' ? (
                    <div className="text-[13px] text-muted">No namespaces audited.</div>
                  ) : (
                    <UnavailableEmptyBody status={policyIsolationStatus} />
                  )
                }
              />
            </Section>

            <Section label="Secret type distribution (metadata only)">
              <div className="space-y-1">
                {Object.entries(payload.secretTypeDistribution).map(([type, count]) => (
                  <Field key={type} label={type} value={count} mono />
                ))}
                {Object.keys(payload.secretTypeDistribution).length === 0 &&
                  (secretStatus.state === 'ok' ? (
                    <div className="text-[13px] text-muted">No Secrets exist on this cluster.</div>
                  ) : (
                    <UnavailableEmptyBody status={secretStatus} />
                  ))}
                {Object.keys(payload.secretTypeDistribution).length > 0 &&
                  (payload.secretTypeDistributionComplete === false ||
                    accountedSecrets !== summary.totalSecretsCount) && (
                    <p className="pt-2 text-[13px] text-warn">
                      A partial breakdown — these types account for{' '}
                      <span className="mono">{accountedSecrets}</span> of the{' '}
                      <span className="mono">{summary.totalSecretsCount}</span> Secrets counted above
                      {payload.secretTypeDistributionComplete === false
                        ? ', because at least one type read was refused or stopped at its paging ceiling'
                        : ''}
                      . Each count shown is exact; the set of types is not the whole set.
                    </p>
                  )}
              </div>
            </Section>
          </div>
        )}
      </Card>

    </div>
  );
}

/**
 * What the ConstraintTemplate list said that the count above it does not.
 *
 * Three states, and only the ones that apply are printed. An inert template is a finding: it is
 * installed, the engine reports enforcing, and it evaluates nothing, so the cluster is protected by
 * one fewer rule than `kubectl get constrainttemplates` suggests. "Constraints unread" is the third
 * state and it is deliberately not folded into either of the other two — a refused read is not a
 * zero, and a template whose constraints could not be counted may be enforcing perfectly well.
 *
 * Names are capped the same way the PDB lists are: past a handful this stops being a finding and
 * becomes the list it replaced.
 */
function TemplateFindings({
  templates,
  onOpenPolicies
}: {
  templates: AdmissionTemplate[];
  onOpenPolicies: () => void;
}): JSX.Element | null {
  const inert = templates.filter(t => !t.constraintsUnavailable && t.constraintCount === 0);
  const unread = templates.filter(t => t.constraintsUnavailable);
  // Nothing to say beyond the strip's linked count: a heading over "3 templates declared" was filler.
  if (templates.length > 0 && inert.length === 0 && unread.length === 0) return null;
  const names = (list: AdmissionTemplate[]) =>
    list
      .slice(0, TEMPLATE_NAME_CAP)
      .map(t => t.name)
      .join(', ') + (list.length > TEMPLATE_NAME_CAP ? ` +${list.length - TEMPLATE_NAME_CAP} more` : '');

  return (
    <Section label="Constraint templates">
      {templates.length === 0 ? (
        <p className="text-[13px] text-muted">
          The engine is installed but defines no constraint templates, so it rejects nothing.
        </p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[13px] text-muted">
            <span className="mono text-text">{templates.length}</span> template
            {templates.length === 1 ? '' : 's'} declared.
          </p>
          {inert.length > 0 && (
            <p className="text-[13px] text-warn">
              <span className="mono">{inert.length}</span> define no constraints and therefore enforce
              nothing: <span className="mono">{names(inert)}</span>
            </p>
          )}
          {unread.length > 0 && (
            <p className="text-[13px] text-muted">
              <span className="mono">{unread.length}</span> had their constraints refused, so whether
              they enforce anything is unknown: <span className="mono">{names(unread)}</span>
            </p>
          )}
          <p className="text-[13px] text-muted">
            Each template, its constraints, its violations and its YAML are under{' '}
            <button
              type="button"
              onClick={onOpenPolicies}
              className="underline decoration-dotted decoration-line underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              Policies
            </button>{' '}
            above.
          </p>
        </div>
      )}
    </Section>
  );
}

/** Admission enforcement: the policy engine, its constraint templates, and the webhooks. */
function AdmissionSection({ id }: { id: string }): JSX.Element {
  const policy = useAsync(useCallback(() => api.clusterPolicy(id), [id]), 0, id);

  /**
   * Send the operator to one of the OPA tabs, and take the page with them.
   *
   * Setting `?opa=` alone would switch a strip that is scrolled off the top of the viewport — the
   * card doing the pointing is below it — so the click would look like it did nothing. The scroll
   * is the other half of the affordance, and `keepResource` matches `OpaSection`'s own call so that
   * following a pointer does not close a drawer the operator opened.
   */
  const opaRef = useRef<HTMLDivElement | null>(null);
  const [, setOpaTab] = useUrlSection<OpaTabId>('opa', OPA_TABS, 'overview', { keepResource: true });
  const goOpa = useCallback(
    (next: OpaTabId) => {
      setOpaTab(next);
      opaRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [setOpaTab]
  );

  const policyScope = unavailableScope({ clusters: policy.data ? [{ ...policy.data, id }] : [] });
  const admissionStatus = policyScope.of('admission policy', 'constrainttemplates', 'validatingwebhookconfigurations');
  const webhookStatus = policyScope.of('webhooks', 'validatingwebhookconfigurations', 'mutatingwebhookconfigurations');
  const vapStatus = policyScope.of('ValidatingAdmissionPolicies', 'validatingadmissionpolicies');
  // A native-policy row is a join of both reads, so it is only as available as the weaker one.
  const nativeStatus = policyScope.of(
    'native admission policies',
    'validatingadmissionpolicies',
    'validatingadmissionpolicybindings'
  );

  const narrowed = policy.data?.ok && policy.data.data ? narrowPolicy(policy.data.data) : null;
  const policySummary = policy.data?.ok ? policy.data.data?.summary : undefined;

  // A ValidatingAdmissionPolicy with no binding is admitted by the API server and enforces
  // nothing — the built-in equivalent of Gatekeeper's `installed-inert`. Counted per policy on the
  // server (a binding count of 11 said nothing about which of 11 policies it bound), and
  // deliberately not asserted when either read failed.
  const vapUnbound =
    policySummary && nativeStatus.state === 'ok' ? policySummary.validatingAdmissionPolicyUnboundCount ?? 0 : 0;

  return (
    <div className="space-y-6">
      {/*
        OPA first, then the cross-mechanism summary. The order is load-bearing, and it is why the
        card below points *up* into this strip: the two are complementary, not alternatives — this
        one answers "what exactly do the Gatekeeper policies say" and pays for its own read only
        while this section is open; the one below answers "is anything enforcing here at all" across
        Gatekeeper, ValidatingAdmissionPolicy and raw webhooks, from the cheap `/policy` collector
        every overview tile already reads.

        The webhook rows are HANDED DOWN rather than re-fetched: this section already has them, and
        OPA's Admission Webhooks tab needs the same list. A second request for the same payload
        would be a second chance for the two lists to disagree.

        The wrapper exists only to be scrolled to — see `goOpa`.
      */}
      <div ref={opaRef}>
        <OpaSection
          id={id}
          webhooks={narrowed ? narrowed.failClosedWebhooks : null}
          webhooksStatus={webhookStatus}
          webhooksLoading={policy.initial}
          nativePolicies={narrowed ? narrowed.nativePolicies ?? null : null}
          nativeStatus={nativeStatus}
        />
      </div>

      {/* ------------------------------------------------------------------ Policy */}
      <Card title="Admission policy & webhooks">
        {policy.initial && <Skeleton rows={5} />}
        {!policy.initial && policy.error && !policy.data && (
          <ErrorState code={policy.error.code} message={policy.error.message} />
        )}
        {!policy.initial && policy.data && !policy.data.ok && (
          <ErrorState
            cluster={id}
            code={policy.data.error?.code ?? 'UNKNOWN'}
            message={policy.data.error?.message ?? 'this cluster did not answer'}
            needsReseed={policy.data.error?.needsReseed}
          />
        )}
        {!policy.initial && narrowed && (
          <div className="space-y-4">
            {/*
              The three admission mechanisms this cluster could be using, side by side, before
              any of them is described. Gatekeeper ConstraintTemplates, the built-in
              ValidatingAdmissionPolicy pair, and raw webhooks are independent — a cluster can
              enforce through any one of them — so a single "policy engine verdict" below
              cannot answer "is anything enforcing here". `activeOutageRiskCount` is the one
              number in this strip that is not about enforcement at all: it counts webhooks
              that are fail-closed *and* have no ready backend, which does not weaken
              admission, it breaks it — every matching write is rejected until the backend
              returns. That is why it gets the alarm tone and the others do not.
            */}
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-line pb-3 text-[13px]">
              <button
                type="button"
                onClick={() => goOpa('policies')}
                title="List them under Policies above"
                className="inline-flex items-baseline gap-1.5 text-left hover:text-accent"
              >
                <span className="text-muted underline decoration-dotted decoration-line underline-offset-[3px]">
                  Gatekeeper templates
                </span>
                <span className="mono text-text">
                  <Count status={admissionStatus} value={policySummary?.constraintTemplateCount ?? null} />
                </span>
              </button>
              <button
                type="button"
                onClick={() => goOpa('native')}
                title="List them under Native policies above"
                className="inline-flex items-baseline gap-1.5 text-left hover:text-accent"
              >
                <span className="text-muted underline decoration-dotted decoration-line underline-offset-[3px]">
                  ValidatingAdmissionPolicies
                </span>
                <span className="mono text-text">
                  <Count status={vapStatus} value={policySummary?.validatingAdmissionPolicyCount ?? null} />
                </span>
              </button>
              <span className="inline-flex items-baseline gap-1.5">
                <span className="text-muted">of which deny</span>
                <span className="mono text-text">
                  <Count
                    status={nativeStatus}
                    value={policySummary?.validatingAdmissionPolicyEnforcingCount ?? null}
                  />
                </span>
                {vapUnbound > 0 && (
                  <span
                    tabIndex={0}
                    title="A ValidatingAdmissionPolicy with no binding is admitted by the API server and enforces nothing."
                  >
                    <Pill tone="warn">{vapUnbound} unbound</Pill>
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => goOpa('webhooks')}
                title="Fail-closed webhooks of every validating and mutating webhook — list them under Admission Webhooks above"
                className="inline-flex items-baseline gap-1.5 text-left hover:text-accent"
              >
                <span className="text-muted underline decoration-dotted decoration-line underline-offset-[3px]">
                  Fail-closed webhooks
                </span>
                <span className="mono text-text">
                  <Count status={webhookStatus} value={policySummary?.failClosedWebhookCount ?? null} />
                </span>
                {webhookStatus.state !== 'unavailable' && policySummary && (
                  <span className="text-[12px] text-muted">of {policySummary.webhookCount}</span>
                )}
              </button>
              <span className="inline-flex items-baseline gap-1.5">
                <span className="text-muted">Active outage risk</span>
                <span className={`mono ${(policySummary?.activeOutageRiskCount ?? 0) > 0 ? 'text-bad' : 'text-text'}`}>
                  <Count status={webhookStatus} value={policySummary?.activeOutageRiskCount ?? null} />
                </span>
                {(policySummary?.activeOutageRiskCount ?? 0) > 0 && (
                  <span className="text-[12px] text-bad">fail-closed with no ready backend — writes are being rejected</span>
                )}
              </span>
            </div>

            {narrowed.admission.policyEngineVerdict === 'absent' ? (
              <NotInstalledPanel
                what="an admission policy engine"
                detail="No Gatekeeper CRDs and no matching validating webhook were found"
              />
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-[13px] text-muted">Policy engine verdict</span>
                  <Pill tone={VERDICT_TONE[narrowed.admission.policyEngineVerdict] ?? 'unknown'}>
                    {narrowed.admission.policyEngineVerdict}
                  </Pill>
                </div>
                {/* Gatekeeper's webhook backend readiness is on OPA Overview's first line, with its
                    failure policy beside it; a second copy here said "ready" with neither. */}
                {/*
                  The templates, as findings rather than as a list.

                  A per-template enumeration lived here — name, constraint count, admission actions
                  and plural, one bordered row apiece — and OPA's **Policies** tab renders the same
                  ConstraintTemplates with their constraints, their violations, their match scope and
                  their YAML. The list was a strictly poorer copy of a screen that is two clicks
                  away and already on this section.
                  What it had that the strip above does not is the one *finding* in it: a template
                  with zero constraints is the quiet failure here — `kubectl get constrainttemplates`
                  lists it, the engine reports enforcing, and not one request is ever evaluated
                  against it. That survives, in a sentence, with the names. The enumeration does not.
                */}
                <TemplateFindings
                  templates={narrowed.admission.constraintTemplates}
                  onOpenPolicies={() => goOpa('policies')}
                />
              </div>
            )}

            {/* The webhook and native-policy lists are above, under Admission Webhooks and Native
                policies; the strip's counts link to them. See the note at the top of this file about
                the second copy that used to be here. */}

            {(!narrowed.admission || narrowed.admission.policyEngineVerdict !== 'absent') &&
              admissionStatus.state !== 'ok' && <UnavailableEmptyBody status={admissionStatus} />}
          </div>
        )}
        {!policy.initial && policy.data?.ok && !narrowed && (
          <NotInstalled what="admission policy data" detail="this cluster reported no policy payload" />
        )}
      </Card>

    </div>
  );
}

/**
 * PodDisruptionBudget coverage and drain blockers. Inspection only — there is no drain, cordon
 * or uncordon control here or anywhere else in this console.
 *
 * Not mounted: the PDBs & Drain sub-tab was removed from the strip. Exported so the section stays
 * compiled and reusable rather than deleted.
 */
export function PdbSection({ id }: { id: string }): JSX.Element {
  const policy = useAsync(useCallback(() => api.clusterPolicy(id), [id]), 0, id);

  const policyScope = unavailableScope({ clusters: policy.data ? [{ ...policy.data, id }] : [] });
  const pdbStatus = policyScope.of('PDB coverage', 'poddisruptionbudgets');

  const narrowed = policy.data?.ok && policy.data.data ? narrowPolicy(policy.data.data) : null;
  const policySummary = policy.data?.ok ? policy.data.data?.summary : undefined;

  return (
    <div className="space-y-6">
      <Card title="PodDisruptionBudget coverage">
        {policy.initial && <Skeleton rows={4} />}
        {!policy.initial && policy.error && !policy.data && (
          <ErrorState code={policy.error.code} message={policy.error.message} />
        )}
        {!policy.initial && narrowed && (
          <Section label="Coverage">
            <Field
              label="Coverage"
              value={
                narrowed.pdbCoverage.coveragePercent === null ? (
                  <Unavailable what="PDB coverage" why={pdbStatus.why} size="sm" />
                ) : (
                  `${narrowed.pdbCoverage.coveragePercent}%`
                )
              }
              mono
            />
            <Field
              label="Covered / total workloads"
              value={
                <MetricValue status={pdbStatus} size="sm">
                  {narrowed.pdbCoverage.coveredWorkloads} / {narrowed.pdbCoverage.totalWorkloads}
                </MetricValue>
              }
              mono
            />
            {/*
              Drain blockers are the opposite failure from missing coverage, and the two are
              easy to conflate because both are "PDB problems". A workload with no PDB is
              evicted freely during a node drain; a workload whose PDB already allows zero
              disruptions makes the drain hang indefinitely, which is what turns a routine
              Gardener maintenance window into a stuck upgrade. The collector's own count is
              used rather than `drainBlockers.length` so a truncated PDB read marks it a floor.
            */}
            <Field
              label={DRAIN_BLOCKER_LABEL}
              value={
                <span
                  className={(policySummary?.pdbDrainBlockerCount ?? 0) > 0 ? 'text-bad' : 'text-text'}
                  title={DRAIN_BLOCKER_QUALIFIER}
                >
                  <Count status={pdbStatus} value={policySummary?.pdbDrainBlockerCount ?? null} />
                </span>
              }
              mono
            />
            {/* The qualifier in the open, not only in a tooltip: it is the difference between a
                measurement and a conclusion, and the converse matters just as much. */}
            <p className="pt-1 text-[13px] text-muted">
              {DRAIN_BLOCKER_QUALIFIER}. {DRAIN_COVERAGE_CONVERSE}
            </p>
            {narrowed.pdbCoverage.drainBlockers.length > 0 && (
              <div className="mt-2">
                <p className="text-[13px] font-medium text-bad">
                  {drainBlockerHeading(narrowed.pdbCoverage.drainBlockers.length)}
                </p>
                {narrowed.pdbCoverage.drainBlockers.slice(0, PDB_LIST_CAP).map(b => (
                  <p key={`${b.namespace}/${b.name}`} className="mono text-[13px] text-muted">
                    {b.namespace}/{b.name}
                  </p>
                ))}
                {narrowed.pdbCoverage.drainBlockers.length > PDB_LIST_CAP && (
                  <p className="text-[12px] text-muted">
                    +{narrowed.pdbCoverage.drainBlockers.length - PDB_LIST_CAP} more
                  </p>
                )}
              </div>
            )}
            {narrowed.pdbCoverage.selectorUnmatched.length > 0 && (
              <div className="mt-2">
                {/* A PDB whose selector matches no pod protects nothing, and reads as coverage
                    in every count that only asks whether a PDB exists. */}
                <p className="text-[13px] font-medium text-warn">
                  Selector-unmatched PDBs — these protect no pods
                </p>
                {narrowed.pdbCoverage.selectorUnmatched.slice(0, PDB_LIST_CAP).map(b => (
                  <p key={`${b.namespace}/${b.name}`} className="mono text-[13px] text-muted">
                    {b.namespace}/{b.name}
                  </p>
                ))}
                {narrowed.pdbCoverage.selectorUnmatched.length > PDB_LIST_CAP && (
                  <p className="text-[12px] text-muted">
                    +{narrowed.pdbCoverage.selectorUnmatched.length - PDB_LIST_CAP} more
                  </p>
                )}
              </div>
            )}
            {(narrowed.pdbCoverage.unreconciled?.length ?? 0) > 0 && (
              <div className="mt-2">
                {/* Neither list used to mention these, so an unevaluated PDB read as safe by
                    omission. Unknown is its own answer — and it carries its count, like the
                    blocking list it has to be compared against, because the rows below are capped
                    and `+N more` is a remainder rather than a total. */}
                <p className="text-[13px] font-medium text-muted" title={PDB_UNRECONCILED_WHY}>
                  {unreconciledHeading(narrowed.pdbCoverage.unreconciled?.length ?? 0)}
                </p>
                {(narrowed.pdbCoverage.unreconciled ?? []).slice(0, PDB_LIST_CAP).map(b => (
                  <p key={`${b.namespace}/${b.name}`} className="mono text-[13px] text-muted">
                    {b.namespace}/{b.name} (observedGeneration{' '}
                    {b.observedGeneration === null ? 'not set' : b.observedGeneration} of generation{' '}
                    {b.generation === null ? 'not set' : b.generation})
                  </p>
                ))}
                {(narrowed.pdbCoverage.unreconciled?.length ?? 0) > PDB_LIST_CAP && (
                  <p className="text-[12px] text-muted">
                    +{(narrowed.pdbCoverage.unreconciled?.length ?? 0) - PDB_LIST_CAP} more
                  </p>
                )}
              </div>
            )}
            {pdbStatus.state !== 'ok' && narrowed.pdbCoverage.coveragePercent !== null && (
              <UnavailableEmptyBody status={pdbStatus} />
            )}
          </Section>
        )}
      </Card>
    </div>
  );
}

/**
 * The tab shell.
 *
 * `compliance` is passed in rather than fetched here: the per-namespace findings ride on the
 * cluster page's overview payload, which `ClusterDetail` already holds. Rendering it as a
 * section keeps the operator's security questions in one place without a second read.
 */
export default function SecurityTab({ id, compliance }: { id: string; compliance?: ReactNode }): JSX.Element {
  const [section, setSection] = useSection<SectionId>(SECTIONS, SECTIONS[0].id);

  return (
    <div>
      <SubTabs sections={SECTIONS} active={section} onSelect={setSection} />
      {section === 'admission' && <AdmissionSection id={id} />}
      {section === 'isolation' && <IsolationSection id={id} />}
      {section === 'compliance' && (compliance ?? <p className="text-[13px] text-muted">No compliance data on this page.</p>)}
    </div>
  );
}
