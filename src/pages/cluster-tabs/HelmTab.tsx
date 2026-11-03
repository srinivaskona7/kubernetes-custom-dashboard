/**
 * The cluster's Helm releases, as a list.
 *
 * A list and nothing else: picking a release navigates to its own page
 * (`/clusters/:id/helm/:namespace/:name`) rather than unfolding a panel underneath. The panel
 * version put a rendered manifest below a full-height table, and left a release unlinkable.
 * See `pages/HelmReleasePage.tsx`, which owns everything a single release shows — including its
 * detail panel, so there is deliberately no second, thinner Helm drawer here.
 *
 * ## The five cards are the status filter
 *
 * Total, Deployed, Failed, Pending, Superseded — each one filters the table to its own rows,
 * because a count with no destination is a dead end. They do not partition the list: `unknown` and
 * `uninstalled` belong to none of the four, and the line under the grid says how many those are
 * rather than leaving an operator to wonder why four numbers do not add up to the fifth.
 *
 * ## The storage backend is read, never assumed
 *
 * Helm 3 defaults to Secrets but can be configured for ConfigMaps or for SQL, and only the first
 * two are visible from the Kubernetes API at all. The backend line states which driver actually
 * answered; an installation on `HELM_DRIVER=sql` is indistinguishable from a cluster with no
 * releases from here, and that ambiguity is printed rather than resolved by guessing.
 *
 * Nothing here mutates anything.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, helmRelatedPath, type HelmRelease } from '../../api';
import { CapabilityNotice } from '../../capability';
import { Column, DataTable } from '../../components/DataTable';
import { Card, Empty, ErrorState, Pill, Skeleton } from '../../components/ui';
import { StatTile, UnavailableNotice, truncatedEntries, unavailableEntries, unavailableScope } from '../../components/unavailable';
import { ago } from '../../format';
import { warm } from '../../prefetch';
import { useAsync } from '../../useAsync';
import { useRegisterResolver } from '../../components/ResourceLink';
import { makeHelmResolver } from '../../resources/resolve';
import { statusTone } from '../helm/shared';

/**
 * The four status buckets the cards offer, and what Helm status each accepts.
 *
 * Helm's own vocabulary, grouped by what an operator would do next: `deployed` is fine,
 * `failed` needs looking at now, the three `pending-*` states plus `uninstalling` mean an
 * operation is stuck mid-flight, and `superseded` is ordinary history. `unknown` and
 * `uninstalled` are in no bucket on purpose — see the module comment.
 */
const BUCKETS = {
  deployed: ['deployed'],
  failed: ['failed'],
  pending: ['pending-install', 'pending-upgrade', 'pending-rollback', 'uninstalling'],
  superseded: ['superseded']
} as const;

type Bucket = keyof typeof BUCKETS;
type StatusFilter = Bucket | 'all';

const inBucket = (status: string | null, bucket: Bucket): boolean =>
  (BUCKETS[bucket] as readonly string[]).includes(status ?? '');

/** Which driver's records answered, in words. */
const BACKEND_LABEL: Record<string, string> = {
  secret: 'Secrets (the Helm 3 default)',
  configmap: 'ConfigMaps',
  none: 'no Kubernetes-backed driver held any record'
};

export default function HelmTab({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const { data, error, initial } = useAsync(useCallback(() => api.clusterHelmReleases(id), [id]), 0, id);
  const [q, setQ] = useState('');
  /** `all` is "every namespace" — a deliberate value, not an unset filter. */
  const [ns, setNs] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [chart, setChart] = useState('all');

  const d = data?.ok ? data.data : null;
  const all = useMemo(() => d?.releases ?? [], [d]);

  // Helm releases already open a full page of their own; registering here is what lets a
  // `?res=HelmRelease/...` link from elsewhere (a resource's owning release) resolve.
  useRegisterResolver('helm', useMemo(() => makeHelmResolver(d), [d]));
  const key = (r: HelmRelease) => `${r.namespace}/${r.name}`;

  /**
   * The namespaces and charts actually present, with counts — derived from the rows rather than
   * from the cluster's namespace list, so a filter can never offer an option that selects nothing.
   */
  const namespaces = useMemo(() => optionCounts(all.map(r => r.namespace ?? '—')), [all]);
  const charts = useMemo(() => optionCounts(all.map(r => r.chart.name ?? '—')), [all]);

  const counts = useMemo(
    () => ({
      total: all.length,
      deployed: all.filter(r => inBucket(r.status, 'deployed')).length,
      failed: all.filter(r => inBucket(r.status, 'failed')).length,
      pending: all.filter(r => inBucket(r.status, 'pending')).length,
      superseded: all.filter(r => inBucket(r.status, 'superseded')).length
    }),
    [all]
  );
  const other = counts.total - counts.deployed - counts.failed - counts.pending - counts.superseded;

  const releases = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter(r => {
      if (ns !== 'all' && (r.namespace ?? '—') !== ns) return false;
      if (chart !== 'all' && (r.chart.name ?? '—') !== chart) return false;
      if (status !== 'all' && !inBucket(r.status, status)) return false;
      if (!needle) return true;
      return (
        r.name.toLowerCase().includes(needle) ||
        (r.namespace ?? '').toLowerCase().includes(needle) ||
        (r.chart.name ?? '').toLowerCase().includes(needle) ||
        (r.chart.version ?? '').toLowerCase().includes(needle)
      );
    });
  }, [all, q, ns, chart, status]);

  const filtered = releases.length !== all.length;

  const scope = useMemo(() => {
    if (!d) return unavailableScope({});
    return unavailableScope({
      clusters: [{ id, ok: true, unavailable: unavailableEntries(d.summary), truncated: truncatedEntries(d.summary) }]
    });
  }, [d, id]);
  const metric = scope.of('Helm releases', 'helm releases');

  /**
   * Eight columns, `shed="wide"`, and a ceiling on every one of them.
   *
   * Measured at 1440 against the 19 real releases on platformsbx: the table overflowed its 1090px
   * container by 335px, with App version at 297px against a declared `width: '130px'` and Namespace
   * at 214px against 180px. `width` does not bind a `.tbl` cell — `white-space: nowrap` plus
   * `table-layout: auto` means the widest row wins — so these are `max` instead.
   *
   * Caps alone could not reach 1090 here, because every column was priority 1 or 2 and no tier can
   * shed a set that declares nothing sheddable. App version is now priority 3: chart version is what
   * identifies what was installed, and the release page carries the app version in full. Revision
   * deliberately stays at priority 2 — a pending revision above the deployed one is this table's most
   * useful sentence, so it is not the thing to drop.
   *
   * Re-measured at 1280 (container 1005px, where prio-2 survives because the tier drops it below
   * 1000): the seven remaining columns overflowed by 21px, so Release and Chart came down 20px and
   * 10px. The surviving caps now sum to 1020px, and the widest real values land inside them.
   */
  const columns: Column<HelmRelease>[] = [
    {
      key: 'name',
      header: 'Release',
      pin: true,
      priority: 1,
      max: '200px',
      render: r => (
        <span className="mono truncate" title={r.name}>
          {r.name}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      priority: 1,
      max: '140px',
      render: r => <Pill tone={statusTone(r.status)}>{r.status ?? 'unknown'}</Pill>
    },
    {
      key: 'ns',
      header: 'Namespace',
      priority: 1,
      // Namespace names are unbounded; this rendered 214px against the 180px it declared.
      max: '160px',
      render: r => <span className="mono">{r.namespace ?? '—'}</span>
    },
    {
      key: 'chart',
      header: 'Chart',
      priority: 1,
      // The one column that never declared any width at all.
      max: '170px',
      render: r => (
        <span className="mono truncate text-[13px]" title={r.chart.name ?? undefined}>
          {r.chart.name ?? '—'}
        </span>
      )
    },
    {
      key: 'chartVersion',
      header: 'Chart version',
      // Left, not right: a chart version is an identifier, not a magnitude — `1.2.3-rc.1` has no
      // digits to line up. See the alignment rule on `NUMERIC` in DataTable.tsx, and History, which
      // renders the same fact on the release page.
      priority: 1,
      max: '120px',
      render: r => <span className="mono">{r.chart.version ?? '—'}</span>
    },
    {
      key: 'appVersion',
      header: 'App version',
      // Left, for the same reason as Chart version, and more so: this is often a git SHA.
      // Priority 3, and the reason the tier can now do anything: an app version is often a git SHA
      // or a date-stamped build string, which is why this was the widest column on the page at 297px.
      priority: 3,
      max: '130px',
      render: r => <span className="mono">{r.chart.appVersion ?? '—'}</span>
    },
    {
      key: 'rev',
      header: 'Revision',
      align: 'right',
      priority: 2,
      max: '110px',
      // A pending revision above the deployed one is the single most useful thing this table
      // can say: the cluster is not running what the last `helm upgrade` asked for.
      render: r => (
        <span
          className={`mono ${r.pendingRevision ? 'text-warn' : ''}`}
          title={
            r.pendingRevision
              ? `Revision ${r.pendingRevision} was never deployed — the cluster is running ${r.revision ?? 'an earlier revision'}`
              : undefined
          }
        >
          {r.revision ?? '—'}
          {r.pendingRevision ? ` → ${r.pendingRevision}?` : ''}
        </span>
      )
    },
    {
      key: 'updated',
      header: 'Last updated',
      align: 'right',
      priority: 1,
      max: '120px',
      render: r => (
        <span className="mono" title={r.lastDeployed ?? undefined}>
          {r.lastDeployed ? ago(r.lastDeployed) : '—'}
        </span>
      )
    }
  ];

  if (initial) return <Skeleton rows={8} />;

  if (!data) {
    return error ? (
      <ErrorState code={error.code} message={error.message} />
    ) : (
      <Empty title="No Helm data" hint="This cluster's Helm release store has not been read yet." />
    );
  }

  if (!data.ok && data.error) {
    return (
      <ErrorState cluster={id} code={data.error.code} message={data.error.message} needsReseed={data.error.needsReseed} />
    );
  }

  if (!d) return <Empty title="No Helm data" hint="This cluster's Helm release store has not been read yet." />;

  return (
    <div className="space-y-4">
      <UnavailableNotice scope={scope} />
      {/* The store's verdict above the numbers, not after them: a forbidden read makes every count
          below a placeholder, and the sentence names what an admin has to grant. */}
      <CapabilityNotice capability={d.capabilities.releases} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Total"
          status={metric}
          value={counts.total}
          caption={`Across ${d.counts.namespaces} namespace${d.counts.namespaces === 1 ? '' : 's'}`}
          onClick={() => setStatus('all')}
          actionLabel="show every release"
        />
        <StatTile
          label="Deployed"
          status={metric}
          value={counts.deployed}
          caption="Running what Helm last applied"
          valueClass={counts.deployed > 0 ? 'text-ok' : 'text-text'}
          onClick={() => setStatus('deployed')}
          actionLabel="filter to deployed releases"
        />
        <StatTile
          label="Failed"
          status={metric}
          value={counts.failed}
          caption="An install or upgrade that did not complete"
          valueClass={counts.failed > 0 ? 'text-bad' : 'text-text'}
          onClick={() => setStatus('failed')}
          actionLabel="filter to failed releases"
        />
        <StatTile
          label="Pending"
          status={metric}
          value={counts.pending}
          caption="An operation is still in flight, or stuck"
          valueClass={counts.pending > 0 ? 'text-warn' : 'text-text'}
          onClick={() => setStatus('pending')}
          actionLabel="filter to pending releases"
        />
        <StatTile
          label="Superseded"
          status={metric}
          value={counts.superseded}
          caption="Ordinary history — an older revision of a release"
          onClick={() => setStatus('superseded')}
          actionLabel="filter to superseded releases"
        />
      </div>

      {/* Two facts the counts above cannot carry, and both change how they should be read. */}
      <div className="space-y-1 px-1 text-[12px] text-muted">
        <p>
          Release records read from <span className="text-text">{BACKEND_LABEL[d.storage.backend] ?? d.storage.backend}</span>
          {d.storage.backend === 'none' && d.storage.capability.extra?.note ? (
            <> — {String(d.storage.capability.extra.note)}</>
          ) : (
            <>
              . Drivers probed: <span className="mono">{d.storage.drivers.map(b => b.label).join(', ')}</span>.
            </>
          )}
        </p>
        {other > 0 && (
          <p>
            <span className="mono text-text">{other}</span> release{other === 1 ? '' : 's'} in neither of the four states
            above — <span className="mono">unknown</span> or <span className="mono">uninstalled</span>. The four cards do
            not add up to the total, on purpose.
          </p>
        )}
        {d.counts.undecodable > 0 && (
          <p className="text-warn">
            <span className="mono">{d.counts.undecodable}</span> Helm record
            {d.counts.undecodable === 1 ? '' : 's'} would not decode, so this list is short by at least that many.
          </p>
        )}
      </div>

      {/* Filters sit above the table rather than inside it: they change which rows exist, and the
          heading below counts what survives them. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Search
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="release, namespace, chart"
            className="h-8 w-[220px] rounded-[6px] border border-line bg-raised px-2 text-[13px] text-text placeholder:text-muted"
          />
        </label>
        <Filter label="Namespace" value={ns} onChange={setNs} options={namespaces} allLabel={`All (${all.length})`} />
        <Filter
          label="Status"
          value={status}
          onChange={v => setStatus(v as StatusFilter)}
          options={[
            ['deployed', counts.deployed],
            ['failed', counts.failed],
            ['pending', counts.pending],
            ['superseded', counts.superseded]
          ]}
          allLabel={`Any (${all.length})`}
        />
        <Filter label="Chart" value={chart} onChange={setChart} options={charts} allLabel={`All (${charts.length})`} />
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setQ('');
              setNs('all');
              setStatus('all');
              setChart('all');
            }}
            className="h-8 rounded-[6px] border border-line px-3 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
          >
            Clear filters
          </button>
        )}
      </div>

      <Card title={`Releases (${releases.length}${filtered ? ` of ${all.length}` : ''})`} flush>
        <DataTable
          columns={columns}
          rows={releases}
          rowKey={key}
          shed="wide"
          onSelect={r => navigate(`/clusters/${encodeURIComponent(id)}/helm/${encodeURIComponent(r.namespace ?? '')}/${encodeURIComponent(r.name)}`)}
          // The release page's `/related` read is the most expensive single click in the console
          // — 26 list reads against the cluster, ~4s cold, measured on platformsbx. The pointer
          // rests on the row for a few hundred milliseconds first, and spending that window on
          // the read the click is about to make turns the page from loading into appearing.
          onIntent={r => warm(helmRelatedPath(id, r.namespace ?? '', r.name))}
          empty={
            all.length === 0 ? (
              <Empty
                title="No Helm releases"
                hint="Nothing on this cluster was installed with Helm 3, as far as the readable release store shows."
              />
            ) : (
              // Distinguishes "this cluster has none" from "your filter excluded them all".
              // The same empty table for both is how an operator concludes a cluster is bare.
              <Empty title="No releases match" hint="Clear a filter above to see the rest." />
            )
          }
        />
      </Card>
    </div>
  );
}

/** `[value, count]` pairs for a filter, ordered by count then name. */
function optionCounts(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** A labelled `<select>` carrying each option's count, so the shape of the list shows before opening it. */
function Filter({
  label,
  value,
  onChange,
  options,
  allLabel
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: [string, number][];
  allLabel: string;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-muted">
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-8 rounded-[6px] border border-line bg-raised px-2 text-[13px] text-text"
      >
        <option value="all">{allLabel}</option>
        {options.map(([option, count]) => (
          <option key={option} value={option}>
            {option} ({count})
          </option>
        ))}
      </select>
    </label>
  );
}
