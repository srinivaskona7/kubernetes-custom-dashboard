/**
 * History — the release's revision timeline, and what changed between two of them.
 *
 * ## Where the rows come from, and where they do not
 *
 * Every row is a stored Helm release record. That matters because the alternative — inferring
 * history from live resource labels — is not history at all: labels carry the *current* revision and
 * nothing about the ones before it, so a "history" built that way would be one row wearing several
 * hats. When release storage cannot be read, this tab says so and shows nothing, rather than
 * assembling a plausible timeline out of what the cluster happens to be running.
 *
 * ## The comparison
 *
 * Comparing revision N with N−1 needs both records, so it fetches the two manifests on demand
 * rather than up front — a release with forty kept revisions would otherwise pull forty payloads to
 * render six columns. The added/removed/changed summary is computed over flattened value paths, so
 * it counts leaves rather than lines: `image.tag` changing once is one change, not the three lines
 * of YAML around it.
 *
 * ## No rollback
 *
 * There is no rollback control, and there is no code path that could grow one — `helm rollback` is a
 * write, and this console has none. The tab's job is to explain a rollback an operator will run
 * themselves with `helm`.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, type Capability, type HelmRelease, type HelmManifestData, type ClusterGroupEnvelope } from '../../api';
import { CodeCompare, valuesText } from '../../components/CodeViewer';
import { Section } from '../../components/layout';
import { ACTIONS, Column, DataTable } from '../../components/DataTable';
import { Empty, ErrorBanner, Pill, Skeleton } from '../../components/ui';
import { CapabilityEmpty, CapabilityNotice } from '../../capability';
import { ago } from '../../format';
import { useAsync } from '../../useAsync';
import { diffValues } from './revision';
import { statusTone } from './shared';

/** The two-revision comparison pane. Its own component so the two fetches unmount with it. */
function RevisionCompare({
  clusterId,
  release,
  revision,
  onClose,
  loadRevision
}: {
  clusterId: string;
  release: HelmRelease;
  revision: number;
  onClose: () => void;
  loadRevision: (revision: number) => Promise<ClusterGroupEnvelope<HelmManifestData>>;
}): JSX.Element {
  const previous = revision - 1;
  const ns = release.namespace ?? '';

  const current = useAsync(
    useCallback(() => loadRevision(revision), [loadRevision, revision]),
    0,
    `${clusterId}/${ns}/${release.name}/${revision}`
  );
  const prior = useAsync(
    useCallback(() => loadRevision(previous), [loadRevision, previous]),
    0,
    `${clusterId}/${ns}/${release.name}/${previous}`
  );

  const cur = current.data?.ok ? current.data.data : null;
  const prev = prior.data?.ok ? prior.data.data : null;
  const delta = useMemo(() => (cur && prev ? diffValues(prev.values, cur.values) : null), [cur, prev]);

  if (current.initial || prior.initial) return <Skeleton rows={6} />;

  const failure = current.error ?? prior.error;
  const envelopeError = (!current.data?.ok && current.data?.error) || (!prior.data?.ok && prior.data?.error) || null;

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-text">
          Revision {previous} → {revision}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
        >
          Close comparison
        </button>
      </div>

      {failure && <ErrorBanner code={failure.code} message={failure.message} />}
      {envelopeError && <ErrorBanner code={envelopeError.code} message={envelopeError.message} />}
      <CapabilityNotice capability={cur?.capability} />
      <CapabilityNotice capability={prev?.capability} />

      {delta && (
        <p className="text-[13px] text-muted">
          <span className="mono text-ok">{delta.added.length}</span> added ·{' '}
          <span className="mono text-bad">{delta.removed.length}</span> removed ·{' '}
          <span className="mono text-warn">{delta.changed.length}</span> changed value
          {delta.changed.length === 1 ? '' : 's'}
          {delta.changed.length > 0 && (
            <>
              {' — '}
              <span className="mono text-text" title={delta.changed.join('\n')}>
                {delta.changed.slice(0, 6).join(', ')}
                {delta.changed.length > 6 && ` and ${delta.changed.length - 6} more`}
              </span>
            </>
          )}
        </p>
      )}

      {cur && prev ? (
        <CodeCompare
          leftLabel={`HELM VALUES · revision ${previous}`}
          left={valuesText(prev.values)}
          rightLabel={`HELM VALUES · revision ${revision}`}
          right={valuesText(cur.values)}
          language="json"
          valueDelta={delta ?? undefined}
          note="Credential-shaped values read [redacted] on both sides, so a rotated Secret shows as unchanged here. Rotation is not a values change."
        />
      ) : (
        !failure && !envelopeError && <Empty title="Neither revision’s values could be read" />
      )}
    </div>
  );
}

export function HelmHistory({
  clusterId,
  release,
  capability
}: {
  clusterId: string;
  release: HelmRelease;
  capability: Capability;
}): JSX.Element {
  const [compare, setCompare] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<Record<number, ClusterGroupEnvelope<HelmManifestData>>>({});
  // Concurrent reads of one revision already share a request inside `api` (sharedGet), so only a
  // settled, available read is remembered here; a refused or failed one is asked again next time.
  const loadRevision = useCallback((revision: number) => {
    const cached = loaded[revision];
    if (cached) return Promise.resolve(cached);
    return api.clusterHelmManifest(clusterId, release.namespace ?? '', release.name, revision).then(result => {
      if (result.ok && result.data && (!result.data.capability || result.data.capability.state === 'available')) {
        setLoaded(old => ({ ...old, [revision]: result }));
      }
      return result;
    });
  }, [clusterId, loaded, release.namespace, release.name]);
  const selectedRead = useAsync(useCallback(() => selected === null ? Promise.resolve(null) : loadRevision(selected), [selected, loadRevision]), 0, selected);

  const rows = useMemo(
    () => release.revisions.map(r => {
      const envelope = r.revision === null ? undefined : loaded[r.revision];
      const detail = envelope?.ok ? envelope.data : undefined;
      return detail ? { ...r, chartVersion: detail.chartMetadata.version, appVersion: detail.chartMetadata.appVersion, description: detail.description ?? r.description, lastDeployed: detail.lastDeployed ?? r.lastDeployed } : r;
    }).sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0)),
    [release.revisions, loaded]
  );

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'revision',
      header: 'Revision',
      pin: true,
      priority: 1,
      // Left, despite being a number: a pinned leading column is the row's label, and a
      // right-aligned one opens a gap between the table's own left edge and its first text.
      // See the alignment rule on `NUMERIC` in DataTable.tsx.
      width: '100px',
      render: r => (
        <span className="mono">
          {r.revision ?? '—'}
          {r.revision === release.revision && release.status === 'deployed' && (
            <span className="ml-1.5 text-[11px] text-ok" title="The revision the cluster is running">
              live
            </span>
          )}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      priority: 1,
      width: '150px',
      render: r => <Pill tone={statusTone(r.status)}>{r.status ?? 'unknown'}</Pill>
    },
    {
      key: 'chartVersion',
      header: 'Chart version',
      priority: 1,
      width: '140px',
      render: r => <span className="mono">{r.chartVersion ?? '—'}</span>
    },
    {
      key: 'appVersion',
      header: 'App version',
      priority: 2,
      width: '130px',
      render: r => <span className="mono">{r.appVersion ?? '—'}</span>
    },
    {
      key: 'lastDeployed',
      header: 'Updated',
      priority: 1,
      align: 'right',
      width: '120px',
      render: r => (
        <span className="mono text-muted" title={r.lastDeployed ?? undefined}>
          {r.lastDeployed ? ago(r.lastDeployed) : '—'}
        </span>
      )
    },
    {
      key: 'description',
      header: 'Description',
      priority: 1,
      // `max-w-[60ch]` bounded the text but left the COLUMN free to grow to that 60ch. It rendered
      // 372px of a 1142px container that its seven columns already filled exactly, so any longer
      // description was overflow. The ceiling belongs on the column; the text keeps its `title`.
      max: '340px',
      render: r => (
        <span className="block truncate text-muted" title={r.description ?? ''}>
          {r.description ?? '—'}
        </span>
      )
    },
    {
      key: 'compare',
      ...ACTIONS,
      priority: 2,
      width: '130px',
      render: r =>
        r.revision !== null && r.revision > 1 ? (
          <button
            type="button"
            onClick={() => setCompare(r.revision)}
            className="rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
            title={`Compare the values of revision ${r.revision - 1} with revision ${r.revision}`}
          >
            Compare to {r.revision - 1}
          </button>
        ) : (
          <span className="text-[12px] text-muted/70" title="There is no earlier revision to compare against">
            —
          </span>
        )
    }
  ];

  return (
    <Section
      title="Revision history"
      label={String(release.revisionCount)}
      hint="History labels load first. Select a revision to read its chart version, app version and description; comparisons reuse contents already read in this view."
    >
      <CapabilityNotice capability={capability} className="mb-3" />

      {release.pendingRevision !== null && (
        <div className="mb-3 rounded-[8px] border border-warn/40 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
          <strong className="font-semibold">Revision {release.pendingRevision} was never deployed.</strong> The cluster
          is running revision {release.revision ?? '—'}, so the last upgrade did not land — what is on screen is not
          what the last <span className="mono">helm upgrade</span> asked for.
        </div>
      )}

      {rows.length === 0 ? (
        capability.state === 'available' ? (
          <Empty
            title="No revision history stored"
            hint="Helm keeps a bounded number of revisions and this release has none beyond the current one, or the history was pruned."
          />
        ) : (
          <CapabilityEmpty capability={capability} />
        )
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={r => String(r.revision)}
          selectedKey={selected === null ? undefined : String(selected)}
          onSelect={r => setSelected(r.revision)}
          empty={<Empty title="No revisions" />}
        />
      )}

      {selected !== null && (
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          <h3 className="text-[14px] font-semibold text-text">Revision {selected}</h3>
          {selectedRead.initial ? <Skeleton rows={2} /> : selectedRead.error ? <ErrorBanner code={selectedRead.error.code} message={selectedRead.error.message} /> : selectedRead.data && !selectedRead.data.ok ? <ErrorBanner code={selectedRead.data.error?.code ?? 'UPSTREAM'} message={selectedRead.data.error?.message ?? 'Revision could not be read'} /> : (
            <>
              <CapabilityNotice capability={selectedRead.data?.data?.capability} />
              <p className="text-[13px] text-muted">{loaded[selected]?.data?.description ?? 'Description not available'}</p>
            </>
          )}
        </div>
      )}
      {compare !== null && (
        <RevisionCompare clusterId={clusterId} release={release} revision={compare} loadRevision={loadRevision} onClose={() => setCompare(null)} />
      )}
    </Section>
  );
}
