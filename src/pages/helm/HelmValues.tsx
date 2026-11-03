/**
 * Values — what this release was configured with, at four levels of "configured".
 *
 * ## The four panes are not the same document
 *
 * `Effective` is chart defaults with the operator's overrides merged on top — what the templates
 * actually rendered against. `Defaults` is the chart's `values.yaml` as shipped. `Revision` is
 * either of those for a revision that is no longer live. `Chart metadata` is `Chart.yaml`. Operators
 * routinely debug the wrong one of these for an hour, which is why each pane is labelled with what
 * it is rather than left to a tab name.
 *
 * ## Fetching
 *
 * `defaults` and `Chart.yaml` live on the per-revision record, not on the release list, so the two
 * panes that need them mount a component that fetches — and the two that do not never pay for it.
 * Mount-to-fetch rather than a conditional inside one hook: the condition is the thing that rots.
 *
 * ## Redaction is stated, not implied
 *
 * The server masks credential-shaped values before serialisation, by key **and** by structure, so a
 * nested `auth.password` is masked even though `auth` is not. The pane says so on screen: an
 * unexplained `[redacted]` reads as the literal configured value, which is worse than saying
 * nothing. Keys always survive — the fact that a value is set is not itself a secret.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { type Capability, type HelmManifestData, type HelmRelease } from '../../api';
import { CodeCompare, CodeViewer, valuesText } from '../../components/CodeViewer';
import { Field, Section } from '../../components/layout';
import { Empty } from '../../components/ui';
import { CapabilityEmpty, CapabilityNotice } from '../../capability';
import { SubTabs, useUrlSection } from '../../components/SubTabs';
import { diffValues, REDACTION_NOTE, WithRevision } from './revision';

type PaneId = 'effective' | 'defaults' | 'revision' | 'chart';

const PANES: { id: PaneId; label: string }[] = [
  { id: 'effective', label: 'Effective values' },
  { id: 'defaults', label: 'Default values' },
  { id: 'revision', label: 'Revision values' },
  { id: 'chart', label: 'Chart metadata' }
];

/** The values of one non-deployed revision, with a delta against the deployed one. */
function RevisionValues({
  payload,
  release,
  deployedValues
}: {
  payload: HelmManifestData;
  release: HelmRelease;
  deployedValues: Record<string, unknown>;
}): JSX.Element {
  const delta = useMemo(() => diffValues(deployedValues, payload.values), [payload.values, deployedValues]);
  return (
    <div className="space-y-3">
      {payload.revision !== release.revision && (
        <p className="text-[13px] text-muted">
          Against the deployed revision {release.revision ?? '—'}:{' '}
          <span className="mono text-ok">{delta.added.length}</span> added ·{' '}
          <span className="mono text-bad">{delta.removed.length}</span> removed ·{' '}
          <span className="mono text-warn">{delta.changed.length}</span> changed
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
      <CodeViewer
        label="HELM VALUES"
        meta={`revision ${payload.revision ?? '—'} · effective`}
        note={REDACTION_NOTE}
        text={valuesText(payload.values)}
        language="json"
        maxHeight="60vh"
      />
    </div>
  );
}

export function HelmValues({
  clusterId,
  release,
  capability
}: {
  clusterId: string;
  release: HelmRelease;
  capability: Capability;
}): JSX.Element {
  const [pane, setPane] = useUrlSection<PaneId>('hvals', PANES, 'effective', { keepResource: true });
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [compareDefaults, setCompareDefaults] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);

  const overrideCount = Object.keys(release.overrides).length;

  if (!capability.trusted) {
    return (
      <Section title="Values" hint="Read from Helm’s stored release record.">
        <CapabilityEmpty capability={capability} />
      </Section>
    );
  }

  let body: ReactNode;

  if (pane === 'effective') {
    if (overridesOnly && overrideCount === 0) {
      body = (
        <Empty
          title="Nothing was overridden"
          hint="This release runs the chart’s defaults exactly — no -f file and no --set flag changed anything."
        />
      );
    } else if (compareDefaults && !overridesOnly) {
      body = (
        <WithRevision clusterId={clusterId} release={release}>
          {payload =>
            payload.hasChartDefaults ? (
              <CodeCompare
                leftLabel="HELM VALUES · chart defaults"
                left={valuesText(payload.defaults)}
                rightLabel="HELM VALUES · effective"
                right={valuesText(release.values)}
                language="json"
                note={REDACTION_NOTE}
                maxHeight="60vh"
              />
            ) : (
              <Empty
                title="This chart shipped no default values"
                hint="There is nothing to compare against — the effective set is the overrides alone."
              />
            )
          }
        </WithRevision>
      );
    } else {
      body = (
        <div className="space-y-3">
          <CodeViewer
            label="HELM VALUES"
            meta={
              overridesOnly
                ? `${overrideCount} override${overrideCount === 1 ? '' : 's'} — the -f / --set half`
                : `effective · revision ${release.revision ?? '—'}`
            }
            note={REDACTION_NOTE}
            text={valuesText(overridesOnly ? release.overrides : release.values)}
            language="json"
            maxHeight="60vh"
          />
          {!overridesOnly && !release.hasChartDefaults && (
            <p className="text-[12px] text-warn">
              This release’s stored chart carries no default values, so the effective set is the overrides alone.
            </p>
          )}
        </div>
      );
    }
  } else if (pane === 'defaults') {
    body = (
      <WithRevision clusterId={clusterId} release={release}>
        {payload =>
          payload.hasChartDefaults ? (
            <CodeViewer
              label="HELM VALUES"
              meta="chart defaults — values.yaml as the chart shipped it"
              note={REDACTION_NOTE}
              text={valuesText(payload.defaults)}
              language="json"
              maxHeight="60vh"
            />
          ) : (
            <Empty
              title="This chart shipped no default values"
              hint="Everything in the effective set came from the operator’s overrides."
            />
          )
        }
      </WithRevision>
    );
  } else if (pane === 'revision') {
    const options = [...release.revisions].sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
    body = (
      <div className="space-y-3">
        <label className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
          Revision
          <select
            value={revision ?? ''}
            onChange={e => setRevision(e.target.value === '' ? null : Number(e.target.value))}
            className="h-7 rounded-[6px] border border-line bg-raised px-2 text-[12px] text-text"
          >
            <option value="">choose a revision…</option>
            {options.map(r => (
              <option key={r.revision ?? 'na'} value={r.revision ?? ''}>
                {r.revision} · {r.status ?? 'unknown'} · {r.chartVersion ?? '—'}
                {r.revision === release.revision ? ' · deployed' : ''}
              </option>
            ))}
          </select>
        </label>
        {revision === null ? (
          <Empty
            title="Pick a revision"
            hint="Each stored revision keeps its own values. Choosing one shows those values and how they differ from the deployed set."
          />
        ) : (
          <WithRevision clusterId={clusterId} release={release} revision={revision}>
            {payload => <RevisionValues payload={payload} release={release} deployedValues={release.values} />}
          </WithRevision>
        )}
      </div>
    );
  } else {
    body = (
      <WithRevision clusterId={clusterId} release={release}>
        {payload => {
          const meta = payload.chartMetadata;
          return (
            <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
              <Field label="Name" value={meta.name ?? '—'} mono />
              <Field label="Chart version" value={meta.version ?? '—'} mono />
              <Field label="App version" value={meta.appVersion ?? '—'} mono />
              <Field label="API version" value={meta.apiVersion ?? '—'} mono />
              <Field label="Type" value={meta.type ?? 'application'} mono />
              <Field label="Home" value={meta.home ?? '—'} mono />
              {meta.description && <Field label="Description" value={meta.description} />}
              {meta.keywords.length > 0 && <Field label="Keywords" value={meta.keywords.join(', ')} mono />}
              {meta.maintainers.length > 0 && (
                <Field label="Maintainers" value={meta.maintainers.map(m => m.name ?? 'unnamed').join(', ')} mono />
              )}
              {release.chart.dependencies.length > 0 && (
                <Field
                  label={`Subcharts (${release.chart.dependencies.length})`}
                  value={release.chart.dependencies.map(d => `${d.name ?? '—'}@${d.version ?? '—'}`).join(', ')}
                  mono
                />
              )}
            </div>
          );
        }}
      </WithRevision>
    );
  }

  return (
    <Section
      title="Values"
      hint="Read from Helm’s stored release record, masked before it left the cluster."
      action={
        pane === 'effective' ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOverridesOnly(v => !v)}
              aria-pressed={overridesOnly}
              className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                overridesOnly
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-line text-muted hover:border-accent hover:text-text'
              }`}
              title="Show only what -f or --set changed"
            >
              Overrides only ({overrideCount})
            </button>
            <button
              type="button"
              onClick={() => setCompareDefaults(v => !v)}
              aria-pressed={compareDefaults}
              disabled={overridesOnly}
              className={`rounded-full border px-3 py-1 text-[12px] transition-colors disabled:opacity-40 ${
                compareDefaults
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-line text-muted hover:border-accent hover:text-text'
              }`}
            >
              Compare with defaults
            </button>
          </div>
        ) : undefined
      }
    >
      <SubTabs sections={PANES} active={pane} onSelect={setPane} />
      <CapabilityNotice capability={capability} className="mb-3" />
      {body}
    </Section>
  );
}
