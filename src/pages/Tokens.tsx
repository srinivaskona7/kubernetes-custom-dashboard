/**
 * Token Health — the page an operator opens when something has already gone wrong.
 *
 * It is the only page that never reads from the cache: a thirty-second-stale expiry
 * countdown is a liability precisely when it matters. It also never displays a token,
 * because the server never sends one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { PageProps } from '../App';
import { api, ApiError, type Cluster, type RenewerState, type TokenHealth } from '../api';
import { ACTIONS, Column, DataTable } from '../components/DataTable';
import { DetailPanel, Field, PageHeader, Section } from '../components/layout';
import { Btn, Card, Empty, ErrorState, Pill, Skeleton } from '../components/ui';
import { ago, duration } from '../format';
import { seedCommand, TOKEN_LABEL, tokenTone } from '../status';
import { useAsync } from '../useAsync';

type Row = { cluster: Cluster } & TokenHealth;

export default function Tokens({ onRefreshed }: PageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const urlCluster = new URLSearchParams(location.search).get('cluster') || '';

  const { data, error, initial, loading, reload } = useAsync(useCallback(() => api.tokens(), []), 30_000);
  const [clusterFilter, setClusterFilter] = useState<string>(urlCluster);
  const [selected, setSelected] = useState<string | null>(urlCluster || null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (urlCluster) {
      setClusterFilter(urlCluster);
      setSelected(urlCluster);
    }
  }, [urlCluster]);

  useEffect(() => {
    if (data) onRefreshed(data.checkedAt);
  }, [data, onRefreshed]);

  const rows = data?.clusters ?? [];
  const uniqueClusters = useMemo(() => {
    const map = new Map<string, Cluster>();
    rows.forEach(r => map.set(r.cluster.id, r.cluster));
    return Array.from(map.values());
  }, [rows]);

  const displayedRows = useMemo(() => {
    if (!clusterFilter) return rows;
    return rows.filter(r => r.cluster.id === clusterFilter);
  }, [rows, clusterFilter]);

  const current = rows.find(r => r.cluster.id === selected) ?? null;

  async function renew(id: string) {
    setBusy(id);
    setNotice(null);
    try {
      const out = await api.renew(id);
      setNotice({ tone: 'ok', text: `${id} renewed — the new token expires ${out.expiresAt}.` });
      reload();
    } catch (err) {
      const e = err as ApiError;
      setNotice({
        tone: 'bad',
        // 501 means this deployment simply has no RBAC to write the Secret. That is a
        // supported configuration, not a fault, and the message says so.
        text: e.code === 'RENEW_DISABLED' ? `Manual renewal is not enabled on this deployment. ${e.message}` : `${id}: ${e.message}`
      });
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<Row>[] = [
    {
      key: 'cluster',
      header: 'Cluster',
      pin: true,
      max: '230px',
      render: r => (
        <div className="flex items-center gap-2.5">
          <Pill tone={tokenTone(r.status)}>{TOKEN_LABEL[r.status]}</Pill>
          <span className="mono truncate">{r.cluster.id}</span>
        </div>
      )
    },
    {
      key: 'expires',
      header: 'Expires in',
      align: 'right',
      render: r => (
        <span
          className={`mono ${r.status === 'expired' ? 'text-bad' : r.status === 'expiring' ? 'text-warn' : ''}`}
        >
          {duration(r.expiresInMs)}
        </span>
      )
    },
    { key: 'renewed', header: 'Last renewed', align: 'right', priority: 2, render: r => <span className="mono">{ago(r.renewedAt)}</span> },
    {
      key: 'due',
      header: 'Due',
      priority: 3,
      render: r => (r.dueForRenewal ? <Pill tone="warn">Due now</Pill> : <span className="text-muted">No</span>)
    },
    {
      key: 'error',
      header: 'Last error',
      priority: 3,
      /**
       * The ceiling belongs on the column, not on the span inside it.
       *
       * `max-w-[38ch]` bounded the text but left the COLUMN free to grow to that 38ch — roughly
       * 296px against the 181px it renders today with no errors present, which is 115px this
       * 1100px-container table has no room for. `max` caps the `td` itself; the full message stays
       * in the `title`, and this column is priority 3 so it is also the first to shed.
       */
      max: '180px',
      render: r =>
        r.lastError ? (
          <span className="mono truncate text-bad" title={r.lastError}>
            {r.lastError}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )
    },
    {
      key: 'action',
      ...ACTIONS,
      render: r => (
        <Btn
          onClick={() => void renew(r.cluster.id)}
          disabled={busy !== null || r.status === 'unseeded' || r.status === 'expired'}
          title={
            r.status === 'unseeded' || r.status === 'expired'
              ? 'Renewal mints the next token using the current one — there is no usable token to mint from'
              : 'Mint the next 24h token now'
          }
        >
          {busy === r.cluster.id ? 'Renewing…' : 'Renew now'}
        </Btn>
      )
    }
  ];

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <PageHeader
          title="Token health"
          icon="credentials"
          info="The lifetime and renewal state of each cluster's service-account token, from the dashboard's own runtime store. Token values are never returned to the browser \u2014 only expiry, age and whether renewal is possible."
          subtitle={
            data
              ? `Each token lives ${data.tokenLifetimeHours}h and is renewed once it drops below ${data.renewIntervalHours}h left — a whole cycle can fail before anything breaks. The pod sweeps for due tokens itself. Checked ${ago(data.checkedAt)}.`
              : 'Checking…'
          }
          actions={
            <div className="flex items-center gap-2">
              <select
                aria-label="Filter by cluster"
                className="h-8 rounded-[6px] border border-line bg-surface px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none"
                value={clusterFilter}
                onChange={e => {
                  const val = e.target.value;
                  setClusterFilter(val);
                  navigate(val ? `/tokens?cluster=${encodeURIComponent(val)}` : '/tokens');
                }}
              >
                <option value="">All clusters ({uniqueClusters.length})</option>
                {uniqueClusters.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.displayName || c.id}
                  </option>
                ))}
              </select>
              <Btn onClick={reload} disabled={loading}>
                {loading ? 'Checking…' : 'Refresh'}
              </Btn>
            </div>
          }
        />

        {notice && (
          <div className="page-x pb-4">
            <div
              className={`card flex items-center gap-2 px-4 py-3 text-[14px] ${
                notice.tone === 'ok' ? 'text-ok' : 'text-bad'
              }`}
            >
              {notice.text}
            </div>
          </div>
        )}

        <div className="page-x pb-6">
          {data && (
            <RenewalClock state={data.renewer} canRenew={data.canRenew} rows={displayedRows} fleetSize={rows.length} />
          )}
        </div>

        <div className="page-x pb-6">
          <Card title="Service account tokens" flush>
            {initial && <Skeleton />}
            {!initial && error && <ErrorState code={error.code} message={error.message} />}
            {!initial && !error && (
              <DataTable
                columns={columns}
                rows={displayedRows}
                rowKey={r => r.cluster.id}
                selectedKey={selected}
                onSelect={r => setSelected(r.cluster.id)}
                empty={<Empty title="No clusters registered" hint="Nothing is being tracked yet." />}
              />
            )}
          </Card>
        </div>

        <div className="page-x pb-8">
          <Card title="How the chain works">
            <ol className="ml-4 list-decimal space-y-1.5 text-[14px] text-muted">
              {/* Both durations come from the response. They used to be prose — "24 hour",
                  "every half hour" — which a deployment overriding the token lifetime or
                  FLEET_RENEW_INTERVAL_MS silently turned into instructions that were wrong. */}
              <li>A human seeds the first token by hand, with a {data?.tokenLifetimeHours ?? 24} hour lifetime.</li>
              <li>
                The srv pod itself sweeps
                {data?.renewer?.sweepIntervalMs ? ` every ${sweepEvery(data.renewer.sweepIntervalMs)}` : ' on a timer'},
                and any token past half its life is used to mint its own replacement through the TokenRequest API. The
                new token is patched straight into the Secret. There is no CronJob and no second workload — renewal is
                part of the application.
              </li>
              <li>
                The pod picks the new token up from its projected mount within about a minute. Nothing restarts.
              </li>
              <li>
                Renewing at half-life means one entire cycle can fail with no loss of service — the previous token is
                kept, never blanked.
              </li>
              <li>
                If the chain does break, only a human can restart it: minting needs a valid token, and an expired one
                cannot mint anything.
              </li>
              <li>
                The trade for having no CronJob: renewal only happens while the pod is running. A fleet left with no
                running replica for longer than a token&apos;s remaining life has to be re-seeded by hand.
              </li>
            </ol>
          </Card>
        </div>
      </div>

      {current && (
        <DetailPanel title={current.cluster.displayName} subtitle={current.cluster.id} onClose={() => setSelected(null)}>
          <Section label="Token">
            <Field label="Status" value={<Pill tone={tokenTone(current.status)}>{TOKEN_LABEL[current.status]}</Pill>} />
            <Field label="Expires in" value={duration(current.expiresInMs)} mono />
            <Field label="Expires at" value={current.expiresAt ?? '—'} mono />
            <Field label="Last renewed" value={ago(current.renewedAt)} mono />
            <Field label="Due for renewal" value={current.dueForRenewal ? 'Yes' : 'No'} />
          </Section>

          <Section label="Identity">
            <Field label="Namespace" value={current.cluster.namespace} mono />
            <Field label="Service account" value={current.cluster.serviceAccount} mono />
            <Field label="API server" value={current.cluster.apiUrl} mono />
          </Section>

          {current.lastError && (
            <Section label="Last error">
              <p className="mono text-[13px] text-bad">{current.lastError}</p>
            </Section>
          )}

          {(current.status === 'unseeded' || current.status === 'expired') && (
            <Section label="Re-seed by hand">
              <p className="mb-2 text-[13px] text-muted">
                {current.status === 'unseeded'
                  ? 'This cluster has never been seeded.'
                  : 'The chain is broken: minting requires a valid token and this one has lapsed.'}{' '}
                Run this against the cluster, then write the result into the fleet token Secret:
              </p>
              <pre className="mono overflow-x-auto rounded-[6px] border border-line bg-bg px-3 py-2 text-[13px]">
                {seedCommand(current.cluster.namespace, current.cluster.serviceAccount)}
              </pre>
            </Section>
          )}
        </DetailPanel>
      )}
    </div>
  );
}

/**
 * Whether the clock is actually ticking.
 *
 * Renewal moved from a CronJob into this pod, and the failure mode that came with it is a
 * silent one: a pod whose timer never armed looks exactly like a fleet with nothing due. So
 * the last sweep is shown with its timestamp, and an absent one is named rather than
 * rendered as a dash.
 */
function RenewalClock({
  state,
  canRenew,
  rows,
  fleetSize
}: {
  state: RenewerState;
  canRenew: boolean;
  /** The rows the table below is showing — filtered, if the operator filtered it. */
  rows: Row[];
  /** Every registered cluster, filter or no filter. The sweeper's coverage is fleet-wide. */
  fleetSize: number;
}) {
  if (!state.inProcess) {
    return (
      <Card title="Renewal clock">
        <p className="text-[14px] text-warn">
          Automatic renewal is off in this deployment
          {canRenew ? '' : ' — the pod has no permission to write the token Secret'}. Tokens will expire as given
          unless they are renewed by hand.
        </p>
      </Card>
    );
  }

  const never = state.at === null;
  // Token health is read from the SAME rows the table below renders, never from the last
  // sweep's tally.
  //
  // The sweep's numbers are a historical fact about one past moment: the first sweep runs
  // seconds after boot, and a cluster onboarded after it — or one whose record had not yet
  // reached the in-process store — was simply not in that pass. Rendering `0 / 0` from it put
  // "TOKENS HEALTHY 0 / 0" directly above a table listing a token valid for 23h. A card that
  // contradicts the table beneath it teaches the operator to distrust both.
  const healthy = rows.filter(r => r.status === 'valid').length;
  // A cluster filter shrinks the table, so it has to shrink this card too — "2 / 3" above a
  // single red row is the same defect as "0 / 0" above a valid one, and the fix for the first
  // one is undone by the filter unless the count follows the filter. The label says which
  // population it is counting rather than leaving the operator to infer it.
  const filtered = rows.length !== fleetSize;
  // The sweep's own coverage is still worth showing when it disagrees — that gap IS the signal
  // that a cluster is not yet under the sweeper. It is fleet-wide, so it compares against the
  // whole registry and stays visible while a filter is on.
  const uncovered = state.total !== null && state.total < fleetSize ? fleetSize - state.total : 0;
  return (
    <Card title="Renewal clock">
      <div className="flex flex-wrap items-start gap-x-12 gap-y-4">
        <Stat label="Sweeper">
          <Pill tone={state.error ? 'bad' : never ? 'warn' : 'ok'}>
            {state.error ? 'Failing' : never ? 'Starting' : 'Running'}
          </Pill>
        </Stat>
        <Stat label="Last sweep">
          {never ? (
            <span className="text-[14px] text-muted">not yet — the first runs seconds after start</span>
          ) : (
            <span className="mono text-[14px]">{ago(state.at)}</span>
          )}
        </Stat>
        <Stat label={filtered ? 'Tokens healthy (filtered)' : 'Tokens healthy'}>
          <span className="mono text-[14px]">
            {rows.length === 0 ? '—' : `${healthy} / ${rows.length}`}
          </span>
        </Stat>
        <Stat label="Renewed last sweep">
          <span className="mono text-[14px]">{state.renewed}</span>
        </Stat>
      </div>
      {uncovered > 0 && (
        <p className="mt-4 text-[13px] text-warn">
          {uncovered} cluster{uncovered === 1 ? '' : 's'} {uncovered === 1 ? 'was' : 'were'} not in the last sweep — it
          covered {state.total}. A cluster added since then joins the next one
          {state.sweepIntervalMs ? `, within ${sweepEvery(state.sweepIntervalMs)}` : ''}.
        </p>
      )}
      {state.error && <p className="mono mt-4 text-[13px] text-bad">last sweep failed: {state.error}</p>}
    </Card>
  );
}

/** "30 minutes" / "2 hours" — the sweep cadence as the server reports it, never a guess. */
function sweepEvery(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {  return (
    <div className="min-w-0">
      <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
      {children}
    </div>
  );
}
