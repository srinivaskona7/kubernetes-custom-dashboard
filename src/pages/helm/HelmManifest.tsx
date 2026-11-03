/**
 * Manifest — the YAML Helm rendered, and the chart source it rendered from.
 *
 * ## Why the label on every pane is not decoration
 *
 * `HELM RENDERED MANIFEST` is what Helm sent to the API server at install time. It is **not** the
 * object that is running: a mutating webhook, an HPA, a controller default and any subsequent
 * `kubectl edit` all change the live object without touching this. An operator who debugs the
 * rendered manifest believing it is live loses an afternoon, so every document carries the label and
 * a link to the live object where this console has a view for it.
 *
 * ## Secrets
 *
 * A rendered Secret's values are blanked on the server by Kind, before serialisation — the pane says
 * `redacted because this document is a Secret` rather than leaving `[redacted]` to read as the
 * configured value. Keys survive; values were never carried.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Capability, HelmChartFile, HelmManifestData, HelmRelease } from '../../api';
import { CodeViewer } from '../../components/CodeViewer';
import { Section } from '../../components/layout';
import { Empty, Pill } from '../../components/ui';
import { CapabilityEmpty } from '../../capability';
import { SubTabs, useUrlSection } from '../../components/SubTabs';
import { bytes } from '../../format';
import { liveResourceHref } from './shared';
import { WithRevision } from './revision';

type PaneId = 'rendered' | 'source';

const PANES: { id: PaneId; label: string }[] = [
  { id: 'rendered', label: 'Rendered manifest' },
  { id: 'source', label: 'Chart source' }
];

const UNPARSED = 'Unparsed document';

/**
 * Documents grouped by Kind, in the release's own order inside each Kind.
 *
 * Kinds alphabetically, with `Unparsed document` pinned last — a document Helm rendered that this
 * console could not parse is the one an operator most needs to notice, and burying it between
 * `Ingress` and `Service` is how it goes unread. The Resources tab's `GROUP_ORDER` does not apply
 * here: that orders resource *groups*, and a manifest has Kinds.
 */
function groupByKind(payload: HelmManifestData) {
  const byKind = new Map<string, HelmManifestData['documents']>();
  for (const doc of payload.documents) {
    const kind = doc.kind ?? UNPARSED;
    const list = byKind.get(kind);
    if (list) list.push(doc);
    else byKind.set(kind, [doc]);
  }
  const kinds = [...byKind.keys()].sort((a, b) =>
    a === UNPARSED ? 1 : b === UNPARSED ? -1 : a.localeCompare(b)
  );
  return kinds.map(kind => ({ kind, docs: byKind.get(kind)! }));
}

function RenderedPane({
  clusterId,
  payload
}: {
  clusterId: string;
  payload: HelmManifestData;
}): JSX.Element {
  const groups = useMemo(() => groupByKind(payload), [payload]);
  const [open, setOpen] = useState<string | null>(null);
  // A one-document manifest with everything collapsed is a screen with nothing on it, so the sole
  // document opens itself until the operator collapses something explicitly.
  const sole = groups.length === 1 && groups[0]?.docs.length === 1 ? groups[0] : null;
  const soleDoc = sole?.docs[0];
  const soleKey = sole && soleDoc ? `${sole.kind}/${soleDoc.namespace ?? '-'}/${soleDoc.name ?? 'unnamed'}/0` : null;
  const openKey = open ?? soleKey;

  if (payload.documents.length === 0) {
    return (
      <Empty
        title="This revision rendered no manifest"
        hint="A chart of hooks alone, or a release whose stored manifest was empty. The chart source pane still shows what shipped."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted">
        <span className="mono text-text">{payload.counts.documents}</span> documents ·{' '}
        <span className="mono text-text">{bytes(payload.counts.manifestBytes)}</span> as stored
        {payload.counts.undecodable > 0 && (
          <>
            {' · '}
            <span className="text-warn">
              {payload.counts.undecodable} record{payload.counts.undecodable === 1 ? '' : 's'} would not decode, so this
              list is short
            </span>
          </>
        )}
      </p>

      {groups.map(g => (
        <div key={g.kind}>
          <div className="mb-1.5 flex items-baseline gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{g.kind}</h3>
            <span className="mono text-[12px] text-muted/70">{g.docs.length}</span>
          </div>
          <div className="divide-y divide-line rounded-[8px] border border-line">
            {g.docs.map((doc, i) => {
              const key = `${g.kind}/${doc.namespace ?? '-'}/${doc.name ?? 'unnamed'}/${i}`;
              const expanded = openKey === key;
              const href = doc.kind && doc.name ? liveResourceHref(clusterId, doc.kind, doc.namespace, doc.name) : null;
              return (
                <div key={key} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : key)}
                      aria-expanded={expanded}
                      className="mono min-w-0 flex-1 truncate text-left text-[13px] text-text transition-colors hover:text-accent"
                    >
                      <span className="text-muted">{expanded ? '▾' : '▸'} </span>
                      {doc.name ?? 'unnamed'}
                      {doc.namespace && <span className="text-muted"> · {doc.namespace}</span>}
                    </button>
                    {doc.redactedByKind && (
                      <Pill tone="warn">redacted by kind</Pill>
                    )}
                    {href && (
                      <Link
                        to={href}
                        className="shrink-0 rounded-[6px] border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-accent hover:text-accent"
                        title={`Open the LIVE ${doc.kind} — which may differ from what Helm rendered`}
                      >
                        View live resource
                      </Link>
                    )}
                  </div>
                  {doc.source && (
                    <p className="mono mt-1 truncate text-[11px] text-muted/80" title={doc.source}>
                      from {doc.source}
                    </p>
                  )}
                  {expanded && (
                    <div className="mt-2">
                      <CodeViewer
                        label="HELM RENDERED MANIFEST"
                        meta={`${doc.kind ?? 'unknown kind'}${doc.name ? `/${doc.name}` : ''} · revision ${payload.revision ?? '—'}`}
                        note={
                          doc.redactedByKind
                            ? 'Values in this document were blanked because it is a Secret (or could not be parsed and is treated as one). The keys are real; the values were never carried out of the cluster.'
                            : 'What Helm sent to the API server. The live object may differ — a webhook, a controller default or a later edit all change it without changing this.'
                        }
                        text={doc.content}
                        language="yaml"
                        maxHeight="60vh"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SourcePane({ payload }: { payload: HelmManifestData }): JSX.Element {
  const files = payload.chartFiles;
  const [selected, setSelected] = useState<string | null>(files[0]?.name ?? null);
  const file: HelmChartFile | undefined = files.find(f => f.name === selected);

  if (files.length === 0) {
    return (
      <Empty
        title="This release’s stored record carries no chart files"
        hint="Helm stores the chart alongside the release, but a chart packaged without templates — or a record written by an older Helm — has none to show."
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
      <nav aria-label="Chart files" className="w-full shrink-0 lg:w-[260px]">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {files.length} file{files.length === 1 ? '' : 's'}
        </div>
        <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto rounded-[8px] border border-line">
          {files.map(f => (
            <li key={f.name}>
              <button
                type="button"
                onClick={() => setSelected(f.name)}
                aria-current={f.name === selected ? 'true' : undefined}
                className={`flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
                  f.name === selected ? 'bg-accent/10 text-accent' : 'text-muted hover:text-text'
                }`}
              >
                <span className="mono min-w-0 truncate" title={f.name}>
                  {f.name}
                </span>
                <span className="mono shrink-0 text-[11px] text-muted/70">{bytes(f.bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        {file ? (
          <CodeViewer
            label={file.type === 'template' ? 'HELM CHART TEMPLATE' : 'HELM CHART FILE'}
            meta={`${file.name} · ${bytes(file.bytes)}`}
            note={
              file.truncated
                ? `Shown up to the size cap — the stored file is ${bytes(file.bytes)}. This is a prefix, not the whole file.`
                : 'The chart as it shipped, before Helm rendered anything. Template expressions are unevaluated here on purpose.'
            }
            text={file.content}
            language="yaml"
            maxHeight="60vh"
          />
        ) : (
          <Empty title="Pick a file" />
        )}
      </div>
    </div>
  );
}

export function HelmManifest({
  clusterId,
  release,
  capability
}: {
  clusterId: string;
  release: HelmRelease;
  capability: Capability;
}): JSX.Element {
  const [pane, setPane] = useUrlSection<PaneId>('hman', PANES, 'rendered', { keepResource: true });

  if (!capability.trusted) {
    return (
      <Section title="Manifest" hint="Read from Helm’s stored release record.">
        <CapabilityEmpty capability={capability} />
      </Section>
    );
  }

  return (
    <Section
      title="Manifest"
      hint="What Helm rendered for the deployed revision, and the chart it rendered from. Neither is the live object."
    >
      <SubTabs sections={PANES} active={pane} onSelect={setPane} />
      <WithRevision clusterId={clusterId} release={release}>
        {payload => (pane === 'rendered' ? <RenderedPane clusterId={clusterId} payload={payload} /> : <SourcePane payload={payload} />)}
      </WithRevision>
    </Section>
  );
}
