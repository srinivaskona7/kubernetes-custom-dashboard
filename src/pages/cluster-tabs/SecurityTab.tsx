/**
 * Security & Compliance tab for one cluster's detail page.
 *
 * Folds a formerly-standalone global page down to a single already-known cluster:
 * Security.tsx's per-cluster row (NetworkPolicy isolation, container security posture, secret
 * metadata) — sourced from `api.clusterSecurity(id)`. This used to fetch the fleet-wide
 * `api.security()` and pick this cluster's row out of the array, which paid for every cluster's
 * pod-and-secret sweep to draw one; the per-cluster route carries the same `SecuritySummary` and
 * lands on the `sec:<id>` cache entry the Overview tile already primed.
 *
 * The plain namespace-compliance-checks list (findings/warnings per namespace) already has
 * a home as `ComplianceTab` in ClusterDetail.tsx and is passed in rather than duplicated here.
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { api, type NetPolDirection, type NetworkPolicyByNamespace } from '../../api';
import { Section, Field } from '../../components/layout';
import { Card, ErrorState, Pill, Skeleton, type Tone } from '../../components/ui';
import { ResourceLink } from '../../components/ResourceLink';
import { DataTable, type Column } from '../../components/DataTable';
import { MetricValue, UnavailableEmptyBody, envelopeScope } from '../../components/unavailable';
import { useAsync } from '../../useAsync';
import { SubTabs, useSection } from '../../components/SubTabs';
import { mergeElevated, namesAreReported, type ElevatedContainer } from './elevated-containers';
import {
  ISOLATION_METHOD_WHY,
  ISOLATION_NOTHING_AUDITED_WHY,
  ISOLATION_NOT_REPORTED_WHY,
  RATIO_UNSTABLE_WHY,
  isolationRendering
} from './security-isolation';
import { TAB_SECTIONS } from './tabs';

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
 * Its own component, and its own fetch: only the mounted section reads.
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
      {section === 'isolation' && <IsolationSection id={id} />}
      {section === 'compliance' && (compliance ?? <p className="text-[13px] text-muted">No compliance data on this page.</p>)}
    </div>
  );
}
