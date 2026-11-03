/**
 * Admission Webhooks — every validating and mutating webhook on the cluster, risk-sorted.
 *
 * ## No fetch of its own
 *
 * The rows arrive as a prop from the Security & Compliance section above, which already reads
 * `clusterPolicy` for its own risk list. That satisfies both halves of the spec at once: reuse the
 * existing risk-sorted webhook and blast-radius implementation, and never issue a request a
 * mounted tab does not need. A second endpoint for the same payload would be a second chance for
 * the two lists to disagree about the same webhook.
 *
 * ## The one claim this screen must not make
 *
 * A webhook whose Service has no ready Endpoints does not enforce anything, whatever its rules
 * say — so `backend-unavailable` is a separate effective status from `active-enforcing`, computed
 * on the server in `effectiveWebhookStatus` and only ever relayed here.
 */
import { useMemo, useState } from 'react';
import type { AdmissionWebhookEntry } from '../../../api';
import { DataTable, type Column } from '../../../components/DataTable';
import { DetailPanel, Field, Section } from '../../../components/layout';
import { Empty, Pill, Skeleton, type Tone } from '../../../components/ui';
import { UnavailableEmptyBody, type MetricStatus } from '../../../components/unavailable';
import { ResourceLink } from '../../../components/ResourceLink';
import { FilterBar, FilterSelect, SearchBox } from '../../../components/filters';

type Effective = AdmissionWebhookEntry['effectiveStatus'];

/**
 * The six states, worst first. Ordered by what an operator has to do about them today: a
 * fail-closed webhook with a dead backend is rejecting writes right now; a fail-open one is
 * admitting them unevaluated, which is silent and therefore worse to leave undiscovered.
 */
const EFFECTIVE: Record<Effective, { label: string; tone: Tone; rank: number; hint: string }> = {
  'backend-unavailable': {
    label: 'Backend unavailable',
    tone: 'bad',
    rank: 0,
    hint: 'The Service behind this webhook has no ready endpoint, so it evaluates nothing. Fail-closed means matching writes are being rejected; fail-open means they are being admitted unchecked.'
  },
  'fail-open': {
    label: 'Fail-open',
    tone: 'warn',
    rank: 1,
    hint: 'failurePolicy is Ignore: if this webhook stops answering, matching writes are admitted without evaluation and nothing reports it.'
  },
  'partially-effective': {
    label: 'Partially effective',
    tone: 'warn',
    rank: 2,
    hint: 'An objectSelector or a CEL matchCondition narrows this webhook, so it evaluates a subset of the requests its rules name.'
  },
  'declared-matches-nothing': {
    label: 'Declared, matches nothing',
    tone: 'bad',
    rank: 3,
    hint: 'The webhook is registered but its rules or namespace selector resolve to nothing on this cluster, so no request reaches it.'
  },
  unknown: {
    label: 'Unknown',
    tone: 'unknown',
    rank: 4,
    hint: 'Backend readiness could not be joined — for a URL-backed webhook there is no Service to check from inside the cluster.'
  },
  'active-enforcing': {
    label: 'Active and enforcing',
    tone: 'ok',
    rank: 5,
    hint: 'Registered, fail-closed, with a ready backend and rules that match resources on this cluster.'
  }
};

function rowId(w: AdmissionWebhookEntry): string {
  return `${w.kind}/${w.configName}/${w.webhookName}`;
}

/** The blast radius in one clause: what it intercepts, over how much of the cluster. */
function blastRadius(w: AdmissionWebhookEntry): string {
  const scope = w.blastRadius.namespaceScope;
  const where = !scope.evaluable
    ? 'namespace reach unknown'
    : scope.scope === 'cluster-wide'
      ? `every namespace (${scope.totalNamespaces})`
      : scope.matchedNamespaceCount === 0
        ? 'no namespace on this cluster'
        : `${scope.matchedNamespaceCount} of ${scope.totalNamespaces} namespaces`;
  const what = w.blastRadius.wildcard
    ? 'every resource'
    : `${w.blastRadius.rules.length} rule${w.blastRadius.rules.length === 1 ? '' : 's'}`;
  return `${what} · ${where}`;
}

/** Target resources as `group/resource`, wildcards said in words. */
function targetLine(w: AdmissionWebhookEntry): string {
  const names = [
    ...new Set(w.blastRadius.rules.map(r => (r.group === '*' || r.resource === '*' ? '*' : `${r.group || 'core'}/${r.resource}`)))
  ];
  if (names.length === 0) return 'no rules';
  if (names.includes('*')) return 'every resource';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

export function OpaWebhooks({
  webhooks,
  status,
  loading
}: {
  /** null while the Security section's `clusterPolicy` read is still in flight or failed. */
  webhooks: AdmissionWebhookEntry[] | null;
  status: MetricStatus;
  loading: boolean;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'Validating' | 'Mutating'>('all');
  const [effective, setEffective] = useState<'all' | Effective>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = webhooks ?? [];
    return all
      .filter(w => {
        if (kind !== 'all' && w.kind !== kind) return false;
        if (effective !== 'all' && w.effectiveStatus !== effective) return false;
        if (q.trim()) {
          const hay = `${w.webhookName} ${w.configName} ${w.owner ?? ''} ${targetLine(w)}`.toLowerCase();
          if (!hay.includes(q.trim().toLowerCase())) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          EFFECTIVE[a.effectiveStatus].rank - EFFECTIVE[b.effectiveStatus].rank ||
          a.webhookName.localeCompare(b.webhookName)
      );
  }, [webhooks, kind, effective, q]);

  const selected = useMemo(
    () => (selectedId ? (webhooks ?? []).find(w => rowId(w) === selectedId) ?? null : null),
    [webhooks, selectedId]
  );

  const activeFilters = (kind !== 'all' ? 1 : 0) + (effective !== 'all' ? 1 : 0) + (q.trim() ? 1 : 0);
  const present = new Set((webhooks ?? []).map(w => w.effectiveStatus));

  const columns: Column<AdmissionWebhookEntry>[] = [
    {
      key: 'webhook',
      header: 'Webhook',
      pin: true,
      // Measured 463px uncapped: the name plus its type plus its parent configuration, none bounded.
      // 260px still put the nine columns 21px over a 1405px container at 1728 (nothing sheds there —
      // `wide`'s prio-3 threshold is 1300), so 240 with both lines carrying their full value as a
      // tooltip. Truncation without a title hides the identifier the row is about.
      max: '240px',
      render: w => (
        <div className="min-w-0">
          <div className="truncate font-medium" title={w.webhookName}>
            {w.webhookName}
          </div>
          <div className="mono truncate text-[12px] text-muted" title={`${w.kind} · ${w.configName}`}>
            {w.kind} · {w.configName}
          </div>
        </div>
      )
    },
    {
      key: 'owner',
      header: 'Owner',
      max: '140px',
      // Priority 1: this column is the reason the tab exists. A MutatingWebhookConfiguration is not
      // Gatekeeper's because its name looks like it — Owner is what separates Gatekeeper from Istio,
      // Kyma, cert-manager and whatever else registered a webhook here, and reading a fail-closed
      // webhook without knowing who owns it tells you a write is being rejected but not who to go
      // to. At priority 3 it was the FIRST column to shed, so the identifying fact vanished at
      // 1440 while Timeout stayed.
      render: w =>
        w.owner ? (
          <span className="text-[13px]">{w.owner}</span>
        ) : (
          <span className="text-[12px] text-muted" title="No installer label declares an owner. Not guessed from the webhook's name.">
            undeclared
          </span>
        )
    },
    {
      key: 'failure',
      header: 'On failure',
      render: w => (
        <span
          tabIndex={0}
          title={
            w.failurePolicy === 'Ignore'
              ? 'Ignore — matching writes are admitted unevaluated when this webhook is down'
              : 'Fail — matching writes are rejected when this webhook is down'
          }
        >
          <Pill tone={w.failurePolicy === 'Ignore' ? 'warn' : 'ok'}>{w.failurePolicy}</Pill>
        </span>
      )
    },
    {
      key: 'timeout',
      header: 'Timeout',
      priority: 3,
      align: 'right',
      render: w => <span className="mono text-[12px] text-muted">{w.timeoutSeconds}s</span>
    },
    {
      key: 'operations',
      header: 'Operations',
      priority: 2,
      max: '130px',
      render: w => (
        <span className="mono text-[12px] text-muted" title={w.operations.join(', ')}>
          {w.operations.length === 0 ? 'none' : w.operations.includes('*') ? 'all' : w.operations.join(', ')}
        </span>
      )
    },
    {
      key: 'targets',
      header: 'Target resources',
      priority: 2,
      // A rule can name dozens of resources; 392px uncapped here, unbounded in principle.
      max: '200px',
      render: w => (
        <span
          className="mono text-[12px] text-muted"
          title={w.blastRadius.rules.map(r => `${r.group || 'core'}/${r.resource} [${r.operations.join(',')}]`).join('\n')}
        >
          {targetLine(w)}
        </span>
      )
    },
    {
      key: 'backend',
      header: 'Backend',
      // namespace/service plus endpoint readiness — 336px uncapped.
      // Priority 3: whether the backend can be reached is already the input to Effective status,
      // which stays. So this column repeats a fact the row still carries and is the cheapest thing
      // to drop when the tier fires — the service coordinates matter when diagnosing, not scanning.
      priority: 3,
      max: '190px',
      render: w => (
        <div className="min-w-0">
          {w.urlBacked ? (
            <span className="text-[12px] text-muted" title="clientConfig.url — an endpoint outside the cluster, with no Service to join">
              external URL
            </span>
          ) : w.service ? (
            <span className="mono truncate text-[12px]">
              {w.service.namespace}/{w.service.name}
            </span>
          ) : (
            <span className="text-[12px] text-muted">no clientConfig</span>
          )}
          <div className="text-[12px]">
            {w.readyEndpoints === null ? (
              <span className="text-muted" title="No EndpointSlice matched this Service, so readiness could not be joined — not zero.">
                readiness unknown
              </span>
            ) : (
              <span className={w.readyEndpoints > 0 ? 'text-muted' : 'text-bad'}>
                {w.readyEndpoints} ready endpoint{w.readyEndpoints === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      )
    },
    {
      key: 'blast',
      header: 'Estimated blast radius',
      // Priority 3, not 2: it is derived entirely from Target resources, which is priority 2 and
      // survives longer. Keeping the derivation while shedding nothing else left the table 251px
      // over its 1090px container at 1440 even with every column capped.
      priority: 3,
      max: '160px',
      render: w => (
        <span className="text-[12px] text-muted" title={blastRadius(w)}>
          {blastRadius(w)}
        </span>
      )
    },
    {
      key: 'effective',
      header: 'Effective status',
      max: '150px',
      render: w => (
        <span tabIndex={0} title={EFFECTIVE[w.effectiveStatus].hint}>
          <Pill tone={EFFECTIVE[w.effectiveStatus].tone}>{EFFECTIVE[w.effectiveStatus].label}</Pill>
        </span>
      )
    }
  ];

  if (loading) return <Skeleton rows={6} />;

  return (
    <div className="flex min-w-0 gap-4">
      <div className="min-w-0 flex-1">
        <p className="mb-3 max-w-[100ch] text-[13px] text-muted">
          Every validating and mutating webhook registered on this cluster, not only Gatekeeper&apos;s. A webhook is
          what makes any policy engine able to reject a request at all, so a dead backend here disables enforcement
          that every other screen reports as configured.
        </p>

        <FilterBar
          activeCount={activeFilters}
          onReset={() => {
            setQ('');
            setKind('all');
            setEffective('all');
          }}
          resultLine={
            rows.length === (webhooks?.length ?? 0)
              ? `${rows.length} webhook${rows.length === 1 ? '' : 's'}`
              : `${rows.length} of ${webhooks?.length ?? 0}`
          }
        >
          <SearchBox value={q} onChange={setQ} placeholder="Search webhook, configuration or owner" />
          <FilterSelect
            label="Kind"
            value={kind}
            onChange={k => setKind(k as typeof kind)}
            options={[
              { value: 'all', label: 'any' },
              { value: 'Validating', label: 'Validating' },
              { value: 'Mutating', label: 'Mutating' }
            ]}
          />
          <FilterSelect
            label="Status"
            value={effective}
            onChange={e => setEffective(e as typeof effective)}
            options={[
              { value: 'all', label: 'any' },
              // Only the states this cluster actually holds, so a filter can never pick nothing.
              ...(Object.keys(EFFECTIVE) as Effective[])
                .filter(k => present.has(k))
                .sort((a, b) => EFFECTIVE[a].rank - EFFECTIVE[b].rank)
                .map(k => ({ value: k, label: EFFECTIVE[k].label }))
            ]}
          />
        </FilterBar>

        <DataTable
          columns={columns}
          rows={rows}
          // Ten columns with two long text cells (Target resources, Estimated blast radius), so the
          // twelve-column tier. At `mid` the container never fell below 1000px at 1440 and TARGETS
          // clipped mid-word ("core," / "ever") instead of shedding cleanly.
          shed="wide"
          rowKey={rowId}
          selectedKey={selectedId}
          onSelect={w => setSelectedId(rowId(w))}
          empty={
            status.state === 'unavailable' ? (
              <UnavailableEmptyBody status={status} />
            ) : activeFilters > 0 ? (
              <Empty title="No webhook matches these filters" hint="This is a filter result, not an empty cluster." />
            ) : webhooks === null ? (
              <Empty
                title="Webhook data is unavailable"
                hint="The admission policy read for this cluster did not answer, so the webhook list could not be built. This is not a cluster with no webhooks."
              />
            ) : (
              <Empty
                title="No admission webhooks are registered"
                hint="Nothing intercepts writes on this cluster — no policy engine, no mutating sidecar injector, nothing."
              />
            )
          }
        />
      </div>

      {selected && <WebhookDetail webhook={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

/** The selected webhook, in full. Inspection only — nothing here changes a registration. */
function WebhookDetail({
  webhook: w,
  onClose
}: {
  webhook: AdmissionWebhookEntry;
  onClose: () => void;
}): JSX.Element {
  const scope = w.blastRadius.namespaceScope;
  return (
    <DetailPanel title={`Webhook / ${w.webhookName}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={EFFECTIVE[w.effectiveStatus].tone}>{EFFECTIVE[w.effectiveStatus].label}</Pill>
          <Pill tone="unknown">{w.kind}</Pill>
        </div>
        <p className="text-[13px] text-muted">{EFFECTIVE[w.effectiveStatus].hint}</p>

        <Section label="Registration">
          <Field label="Configuration" value={w.configName} mono />
          <Field label="Owner" value={w.owner ?? 'undeclared'} />
          <Field label="Failure policy" value={w.failurePolicy} mono />
          <Field label="Timeout" value={`${w.timeoutSeconds}s`} mono />
          <Field label="Side effects" value={w.sideEffects ?? 'not declared'} mono />
          <Field label="Match policy" value={w.matchPolicy} mono />
          <Field label="AdmissionReview versions" value={w.admissionReviewVersions.join(', ') || 'not declared'} mono />
        </Section>

        <Section label={`Rules (${w.blastRadius.rules.length})`}>
          {w.blastRadius.rules.length === 0 ? (
            <p className="text-[13px] text-warn">
              No rules are declared, so this webhook is never consulted for any resource.
            </p>
          ) : (
            <div className="space-y-1">
              {w.blastRadius.rules.map((r, i) => (
                <div key={`${r.group}/${r.resource}/${i}`} className="mono text-[12px] text-muted">
                  <span className="text-text">
                    {r.group === '*' ? '*' : r.group || 'core'}/{r.resource}
                  </span>{' '}
                  · {r.operations.join(', ') || 'no operations'}
                </div>
              ))}
              {w.blastRadius.wildcard && (
                <p className="text-[12px] text-warn">
                  A rule uses a wildcard, so this webhook sees kinds not named above — including kinds installed later.
                </p>
              )}
            </div>
          )}
        </Section>

        <Section label="Match narrowing">
          <Field
            label="Namespace reach"
            value={
              !scope.evaluable
                ? 'unknown — the namespace list could not be read'
                : scope.scope === 'cluster-wide'
                  ? `every namespace (${scope.totalNamespaces})`
                  : `${scope.matchedNamespaceCount} of ${scope.totalNamespaces} namespaces`
            }
          />
          <Field
            label="namespaceSelector"
            value={w.namespaceSelector ? JSON.stringify(w.namespaceSelector) : 'none — every namespace'}
            mono
          />
          <Field
            label="objectSelector"
            value={w.objectSelector ? JSON.stringify(w.objectSelector) : 'none — every object'}
            mono
          />
          <Field
            label="matchConditions"
            value={
              w.matchConditions.length === 0
                ? 'none'
                : // Names only. A CEL expression can embed cluster-specific detail, and the names
                  // are what identifies the condition anyway.
                  `${w.matchConditions.length}: ${w.matchConditions.join(', ')}`
            }
            mono
          />
        </Section>

        <Section label="Backend">
          {w.urlBacked ? (
            <p className="text-[13px] text-muted">
              This webhook is addressed by URL rather than by a Service, so there is no in-cluster endpoint to check.
              Its reachability cannot be determined from here, which is why its effective status is not reported as
              enforcing or as down.
            </p>
          ) : w.service ? (
            <>
              <Field
                label="Service"
                value={
                  <ResourceLink
                    refTo={{ kind: 'Service', namespace: w.service.namespace, name: w.service.name }}
                  />
                }
              />
              <Field label="Port" value={w.service.port ?? 'default (443)'} mono />
              <Field label="Path" value={w.service.path ?? '/'} mono />
              <Field
                label="Ready endpoints"
                value={
                  w.readyEndpoints === null
                    ? 'unknown — no EndpointSlice matched this Service'
                    : `${w.readyEndpoints}`
                }
                mono
              />
            </>
          ) : (
            <p className="text-[13px] text-warn">No clientConfig names a Service or a URL.</p>
          )}
          <Field
            label="CA bundle"
            value={w.caBundlePresent ? 'pinned in clientConfig' : 'not pinned — the cluster CA is used'}
          />
        </Section>
      </div>
    </DetailPanel>
  );
}
