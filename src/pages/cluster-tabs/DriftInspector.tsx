/**
 * The drift inspector — why a Deployment is listed as image-drifted, and what the operator does next.
 *
 * ## Why it exists
 *
 * The Image-drifted Deployments table used to print the drifted pod names in red and explain
 * nothing. Red text is a verdict without evidence: it does not say which container drifted, which
 * image the template asks for, which one is actually running, or what to do — so the operator's next
 * move was `kubectl get deploy -o yaml` in another window, which is the work this console exists to
 * remove.
 *
 * ## Read-only, structurally
 *
 * The quick fix is a **string in a `<pre>`**. `CodeViewer`'s copy button writes to the clipboard,
 * never to the cluster; there is no endpoint behind it and there must never be one. A `Restart`
 * button here would be the single most plausible read-only violation in the product — it would sit
 * directly beside the evidence that a restart is what is needed — and the whole guarantee of this
 * console is that nothing it renders can change a cluster.
 *
 * ## Which overlay
 *
 * `DetailPanel`, the console's one drawer — the same primitive the resource drawer and the policy
 * drawer use, so Escape, the focus trap, the focus restore and the inline-at-1280px behaviour are
 * the existing ones rather than a second implementation of them. It is mounted from the tab body,
 * outside the `.table-wrap` whose `overflow-x: auto` computes `overflow-y` to `auto` and clips
 * anything absolutely positioned inside it.
 */
import { CodeViewer } from '../../components/CodeViewer';
import { DetailPanel, Field, Section } from '../../components/layout';
import { Pill } from '../../components/ui';
import {
  driftCopy,
  driftVerdict,
  explanationOf,
  imageRef,
  ownerResolutionReasonText,
  quickFixCommand,
  type DriftSubject,
  type ImageMismatch,
  type PodDrift
} from './image-drift';

/**
 * What the inspector is opened on: the Deployment's rollout entry, and optionally the one pod whose
 * name was clicked.
 *
 * The whole subject rather than just its drift rows, because the verdict — and therefore whether a
 * `kubectl` command is offered at all — is decided from `ownerResolution` and `uncomparableImages`,
 * not from the rows. A drawer given only rows would have to guess.
 */
export interface DriftSelection extends DriftSubject {
  /** The pod whose name was clicked, when it was a pod and not the row. Highlighted, never filtered. */
  focusPod?: string | null;
}

export function DriftInspector({ selection, onClose }: { selection: DriftSelection; onClose: () => void }): JSX.Element {
  const verdict = driftVerdict(selection);
  const { headline, explanation } = driftCopy(selection);
  // `null` for every state but drift, and the section is then absent entirely — see `quickFixCommand`.
  const command = quickFixCommand(selection);
  const uncomparable = selection.uncomparableDetails ?? [];

  return (
    <DetailPanel
      title={<span className="mono">{selection.name}</span>}
      subtitle={`${selection.namespace} · Deployment · ${verdict === 'drifted' ? 'image drift' : 'image comparison'}`}
      onClose={onClose}
    >
      <Section label={headline}>
        <p className="max-w-[80ch] text-[13px] leading-[1.6] text-muted">{explanation}</p>
        {/* State 4: there is no per-container detail at all, so the reason is all there is to say. */}
        {verdict === 'unknown' && (
          <p className="max-w-[80ch] text-[13px] leading-[1.6] text-muted">
            The pod → ReplicaSet → Deployment owner chain was not read because{' '}
            {ownerResolutionReasonText(selection.ownerResolutionReason)}
          </p>
        )}
      </Section>

      {verdict === 'drifted' && selection.driftDetails.length === 0 ? (
        <Section label="Containers">
          <p className="text-[13px] text-muted">
            This Deployment is flagged as drifted but arrived with no per-pod detail. Refresh once; if
            it persists, the drift verdict and its evidence disagree and the reliability collector is
            what to look at.
          </p>
        </Section>
      ) : (
        selection.driftDetails.map(pd => (
          <PodComparison key={pd.pod} drift={pd} focused={pd.pod === selection.focusPod} />
        ))
      )}

      {/*
        The third state, kept out of the comparison above rather than mixed into it: these containers
        were looked at and could not be compared, which no rollout restart changes. Folding them in
        beside real mismatches would imply the command below is their fix too — and on a Deployment
        that is BOTH drifted and not comparable, the command is offered for the drift alone.

        Note the inner key is `containers`, not `mismatches`: the backend shape differs deliberately,
        because these are not mismatches.
      */}
      {uncomparable.map(pu => (
        <Section key={pu.pod} label={`Pod ${pu.pod} — not comparable`}>
          <ul className="divide-y divide-line">
            {pu.containers.map(c => (
              <ContainerComparison key={c.container} mismatch={c} variant="uncomparable" />
            ))}
          </ul>
        </Section>
      ))}

      {command !== null && (
        <Section
          label="Quick fix"
          hint="This console never changes cluster state. Run this yourself, in your own terminal, against this cluster."
        >
          <CodeViewer label="RUN THIS IN YOUR OWN TERMINAL" text={command} searchable={false} maxHeight="120px" />
        </Section>
      )}
    </DetailPanel>
  );
}

/**
 * One pod's containers, declared against running.
 *
 * A focused pod — the one whose name the operator clicked in the cell — is outlined rather than
 * filtered to. Filtering would hide the other drifted pods of the same Deployment, and "are they all
 * on the old image or only this one" is the question that decides whether this is a stuck rollout or
 * a single wedged pod.
 */
function PodComparison({ drift, focused }: { drift: PodDrift; focused: boolean }): JSX.Element {
  return (
    <Section label={`Pod ${drift.pod}`}>
      <div className={focused ? 'rounded-[6px] outline outline-1 outline-accent' : undefined}>
        {drift.mismatches.length === 0 ? (
          <p className="p-2 text-[13px] text-muted">
            No per-container detail was reported for this pod. The comparison lives in the collector's
            `mismatches` array, and this one arrived empty.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {drift.mismatches.map(m => (
              <ContainerComparison key={m.container} mismatch={m} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

/**
 * The comparison itself: container name, what the template declares, what is running.
 *
 * Stacked rather than side by side, because the panel is a share of the viewport and a registry path
 * is 60-odd characters — two columns would ellipsise both halves, which is precisely the detail the
 * operator opened this for. The version is called out ahead of the repository for the same reason:
 * on a real drift the repository is identical on both lines and the tag is the entire difference.
 */
function ContainerComparison({
  mismatch,
  variant = 'drift'
}: {
  mismatch: ImageMismatch;
  /** `uncomparable` labels the row for what it is: unmeasured, not off-image. */
  variant?: 'drift' | 'uncomparable';
}): JSX.Element {
  const declared = imageRef(mismatch.specImage);
  const running = imageRef(mismatch.liveImage);
  const sentence = explanationOf(mismatch);
  const drift = variant === 'drift';

  return (
    <li className="space-y-2 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="mono text-[13px] font-medium text-text">{mismatch.container}</span>
        <Pill tone={drift ? 'warn' : 'unknown'}>{drift ? 'image drift' : 'not comparable'}</Pill>
      </div>

      <Field
        label="Declared in template"
        value={<ImageValue full={mismatch.specImage} version={declared.version} repo={declared.repo} tone="text-text" />}
      />
      <Field
        label="Currently running"
        value={
          <ImageValue
            full={mismatch.liveImage}
            version={running.version}
            repo={running.repo}
            tone={drift ? 'text-warn' : 'text-muted'}
          />
        }
      />

      {/* Absent on an older backend, and deliberately not synthesised here — see image-drift.ts. */}
      {sentence && <p className="max-w-[80ch] break-words text-[12px] leading-[1.5] text-muted">{sentence}</p>}
    </li>
  );
}

/**
 * One image reference. The version reads first and in full; the repository under it, muted and
 * wrapping, because it is the part that is usually the same on both lines.
 *
 * `title` carries the untruncated reference: a digest-pinned image in a long registry path will not
 * fit the panel at any width, and a reference the operator cannot read is a reference they have to
 * go and fetch themselves.
 */
function ImageValue({
  full,
  version,
  repo,
  tone
}: {
  full: string;
  version: string;
  repo: string;
  tone: 'text-text' | 'text-warn' | 'text-muted';
}): JSX.Element {
  return (
    <span className="block min-w-0" title={full}>
      <span className={`mono text-[13px] ${tone}`}>{version || '—'}</span>
      {repo && repo !== version && <span className="mono block break-all text-[12px] text-muted">{repo}</span>}
    </span>
  );
}
