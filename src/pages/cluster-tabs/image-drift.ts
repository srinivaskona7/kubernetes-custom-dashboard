/**
 * What "image drift" means on screen, as logic rather than as JSX.
 *
 * Its own module because `app/fleet-ui` runs vitest with `environment: 'node'` (jsdom is blocked by
 * npm E401 on this workstation), so nothing that renders can be proven. The four decisions worth
 * proving are all pure and all live here:
 *
 *  1. Whether the drift verdict for a Deployment is drifted, clean, or **unknown** — the third is
 *     the one a table that only knows about the first two gets wrong, because `reliability.js`
 *     returns `drifted: false` with empty detail arrays when the pod→ReplicaSet→Deployment owner
 *     chain could not be built. Rendering that as "no image-drifted Deployments" is a clean verdict
 *     the backend never gave.
 *  2. The `explanation` sentence, which an older backend does not send. Absent means the sentence is
 *     omitted, NOT synthesised here: the comparison rows already carry the two references, and a
 *     second author for the drift explanation is how two versions of it drift apart.
 *  3. The part of an image reference an operator reads — its tag, or the digest. Used only to label
 *     the comparison, never to decide drift: that comparison is `normalizeImage`'s job on the
 *     server, and two different references can perfectly well share a tag.
 *  4. The quick-fix command string. One function, so the command an operator copies cannot differ
 *     from the command the drawer prints.
 *
 * Nothing here calls anything. The console is read-only: the "fix" is text the operator runs in
 * their own terminal, and `rolloutRestartCommand` returns a string to a `<pre>`.
 */

/** The heading over the explanation. The drawer's title says which Deployment; this says what. */
export const DRIFT_HEADLINE = 'Image Drift Detected';

/**
 * The two-line plain-English explanation, verbatim as specified.
 *
 * A constant rather than inline JSX so the test can hold the wording: this is the one sentence pair
 * that has to keep saying the same thing as the table's own column tip.
 */
export const DRIFT_EXPLANATION =
  'The running pod is executing a different container image than declared in the Deployment ' +
  'template. This typically happens after an image update when a rollout is stuck or pods have ' +
  'not restarted.';

/**
 * The headline and lead for the two states that are neither drift nor clean.
 *
 * Separate copy in the same register rather than `DRIFT_EXPLANATION` with a hedge bolted on: that
 * paragraph explains a mismatch, and a Deployment whose containers could not be compared has no
 * mismatch to explain. Written here and not inside the component so the test can hold it, and so
 * the register cannot drift from the drift copy sitting beside it.
 *
 * Neither is a substitute for the backend's own per-container `explanation` — those still render
 * verbatim on the rows beneath.
 */
export const NOT_COMPARABLE_HEADLINE = 'Image Comparison Not Possible';

export const NOT_COMPARABLE_EXPLANATION =
  'The running container reports a bare image ID rather than an image reference, so there is ' +
  'nothing to compare the Deployment template against. This is not drift, and it is not a clean ' +
  'verdict either — a restart cannot change it.';

export const UNKNOWN_HEADLINE = 'Drift Not Evaluated';

export const UNKNOWN_EXPLANATION =
  'Which pods belong to this Deployment could not be resolved, so no image comparison was made ' +
  'for any of them. Nothing below is evidence that the images agree.';

// --------------------------------------------------------------------- the wire

/**
 * How the collector resolved which pods belong to a Deployment.
 *
 * `'owner-chain'` is the only trustworthy answer — pod → controlling ReplicaSet → its owning
 * Deployment, both hops real API relations. `'unavailable'` means the ReplicaSet read failed or
 * stopped at the paging ceiling, and the collector deliberately did NOT fall back to selector
 * matching (overlapping labels in `platform-system` reported a dozen false drifts when it did).
 *
 * `undefined` is an older backend that sent no such field. That release resolved pods by selector
 * and always produced a verdict, so it is read as resolved rather than as unknown — treating it as
 * unknown would blank the drift table for every operator on the previous image.
 */
export type OwnerResolution = 'owner-chain' | 'unavailable';

/** One container's drift, as `reliability.js` emits it. `explanation` is newer than the rest. */
export interface ImageMismatch {
  container: string;
  specImage: string;
  liveImage: string;
  explanation?: string | null;
}

/** One drifted pod of a Deployment. `mismatches` can legitimately be empty on an older payload. */
export interface PodDrift {
  pod: string;
  mismatches: ImageMismatch[];
}

/**
 * One container that was looked at and could not be compared — the live image is a bare image ID
 * (`sha256:…` with no repository), so there is nothing to compare the template's reference against.
 *
 * Its own shape because it is the third state, not a weaker drift: no restart can change it, and
 * counting it as clean is the silent zero this module exists to prevent.
 */
export interface UncomparableContainer extends ImageMismatch {
  reason?: string | null;
}

export interface PodUncomparable {
  pod: string;
  containers: UncomparableContainer[];
}

/** The subset of a Deployment rollout entry the drift verdict is decided from. */
export interface DriftSubject {
  name: string;
  namespace: string;
  drifted: boolean;
  driftDetails: PodDrift[];
  ownerResolution?: OwnerResolution;
  ownerResolutionReason?: string | null;
  /** Containers looked at and not comparable. Absent on a backend older than the three-way verdict. */
  uncomparableImages?: number;
  uncomparableDetails?: PodUncomparable[];
}

// ------------------------------------------------------------------- the verdict

/**
 * Four states, not two.
 *
 * `'unknown'` is the one a table that knows only drifted/clean gets wrong: with
 * `ownerResolution: 'unavailable'` the collector evaluated no drift at all, so neither `drifted` nor
 * the empty `driftDetails` is evidence of anything.
 *
 * `'not-comparable'` is the collector's own definition of a clean verdict read backwards — it says a
 * clean answer is `drifted: false` AND `uncomparableImages === 0`. A Deployment whose live containers
 * report bare image IDs has not been cleared of drift; it has not been measured.
 */
export type DriftVerdict = 'drifted' | 'clean' | 'unknown' | 'not-comparable';

export function driftVerdict(subject: DriftSubject): DriftVerdict {
  if (subject.ownerResolution === 'unavailable') return 'unknown';
  if (subject.drifted) return 'drifted';
  return (subject.uncomparableImages ?? 0) > 0 ? 'not-comparable' : 'clean';
}

/** How many containers across these Deployments could not be compared at all. */
export function uncomparableTotal(subjects: readonly DriftSubject[]): number {
  return subjects.reduce((n, s) => n + (s.uncomparableImages ?? 0), 0);
}

/**
 * The Rollouts sub-tab pill: a count, or **no count at all**.
 *
 * Here rather than inline in the tab because it is the same confident-zero decision as the tile
 * beside it, and a test can hold "the unknown label contains no digit" in a way a JSX template
 * cannot. `Rollouts (0)` where the truth is "the drifted half was never evaluated" is read before
 * anything is opened, and it tells the operator there is nothing to look at.
 *
 * The stale half IS known in that case, and is deliberately not shown as the number: a pill reading
 * `Rollouts (2)` that silently means "2 stale, drift unknown" is the same lie with a different digit.
 * It goes in the tooltip instead.
 */
export function rolloutTabLabel(
  driftState: 'ok' | 'unknown',
  drifted: number,
  stale: number
): { label: string; why?: string } {
  if (driftState === 'unknown') {
    return {
      label: 'Rollouts',
      why:
        'Image drift was not evaluated on this cluster, so this count has no drifted half. ' +
        `${stale} StatefulSet${stale === 1 ? '' : 's'} on a stale revision.`
    };
  }
  return { label: `Rollouts (${drifted + stale})` };
}

/**
 * The fleet-of-one-cluster question the table asks: may an empty drift list be printed as "none"?
 *
 * Answered over the whole rollout list rather than per row, because the collector's owner index is
 * built once for the cluster: if one Deployment reports `unavailable`, every one of them did, and
 * the empty table underneath is empty by construction.
 */
export function driftListState(subjects: readonly DriftSubject[]): 'ok' | 'unknown' {
  return subjects.some(s => driftVerdict(s) === 'unknown') ? 'unknown' : 'ok';
}

/**
 * Why the owner chain could not be resolved, as a clause that completes
 * "…could not be resolved because …".
 *
 * Only `TRUNCATED` gets tailored copy, because only it is not an error: the read succeeded and hit
 * the paging ceiling, which is a different operator action (nothing is broken) from a refused or
 * failed read. Every other code is quoted rather than interpreted — inventing a cause from a code
 * this file has not seen is how a UI confidently explains something nobody observed.
 */
export function ownerResolutionReasonText(reason: string | null | undefined): string {
  if (!reason) return 'the ReplicaSet read for this cluster did not complete.';
  if (reason === 'TRUNCATED') {
    return 'the ReplicaSet list stopped at this console’s paging ceiling, so it was incomplete.';
  }
  return `the ReplicaSet read for this cluster failed, reported as ${reason}.`;
}

// -------------------------------------------------------------------- the detail

/**
 * The backend's sentence, or `null`.
 *
 * Blank and whitespace-only are the same as absent: an older backend sends no field, and a field
 * containing a space is not a sentence. Never a fallback string — see (2) above.
 */
export function explanationOf(mismatch: ImageMismatch): string | null {
  const text = mismatch.explanation;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * An image reference split the way it is read: what it is, and which version of it.
 *
 * `tag` and `digest` are independent — `repo:1.2@sha256:…` carries both, and a bare `nginx` carries
 * neither, in which case `version` is the reference itself rather than the empty string a bare
 * `slice` would produce. A sentence or a cell naming no version at all is worse than one naming the
 * whole reference.
 */
export interface ImageRef {
  /** Everything before the tag and the digest. */
  repo: string;
  tag: string | null;
  digest: string | null;
  /** The short thing to print beside the repo: the tag, else a clipped digest, else the reference. */
  version: string;
}

const DIGEST_CLIP = 19;

/**
 * A bare image ID — what a runtime reports instead of a reference for a pre-loaded local image
 * (`sha256:1a3d043f79f8…`). It is the whole value, not a repository named `sha256` with a tag, which
 * is what the generic tag rule below would otherwise make of it: the colon is left of no slash.
 *
 * Printed whole, because "the runtime reported an image ID" is the fact the operator needs, and
 * `sha256` on its own line as though it were a repository is a fact nobody stated.
 */
const BARE_IMAGE_ID = /^sha256:[0-9a-f]{12,}$/i;

export function imageRef(image: string | null | undefined): ImageRef {
  const ref = typeof image === 'string' ? image : '';
  if (ref === '') return { repo: '', tag: null, digest: null, version: '' };
  if (BARE_IMAGE_ID.test(ref)) return { repo: '', tag: null, digest: ref, version: ref };

  const at = ref.indexOf('@');
  const digest = at === -1 ? null : ref.slice(at + 1) || null;
  const named = at === -1 ? ref : ref.slice(0, at);

  // A colon left of the last slash is a registry port (`registry:5000/app`), not a tag.
  const lastSlash = named.lastIndexOf('/');
  const lastColon = named.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;

  const tag = hasTag ? named.slice(lastColon + 1) || null : null;
  const repo = hasTag ? named.slice(0, lastColon) : named;
  const version = tag ?? (digest ? digest.slice(0, DIGEST_CLIP) : ref);

  return { repo, tag, digest, version };
}

// ------------------------------------------------------------------- the quick fix

/**
 * The command the operator runs in their own terminal. Text, only ever text.
 *
 * `--` is not used and neither is any shell quoting: a Kubernetes object name is a DNS label, so it
 * cannot contain a character that would need it, and a quoted name in a copied command reads as
 * though the tool expected something stranger than it did.
 */
export function rolloutRestartCommand(name: string, namespace: string): string {
  return `kubectl rollout restart deployment ${name} -n ${namespace}`;
}

/**
 * The command for a *subject*, or `null` — and `null` is the point of this function existing at all.
 *
 * A restart is only meaningful for outcome 1. Offering it for a container that could not be compared,
 * or for a Deployment whose pods were never resolved, tells the operator to take an action that
 * cannot affect the thing they are looking at — worse than offering nothing, because it reads as the
 * tool having diagnosed something. So the *drawer never decides this*: it renders whatever this
 * returns, and `null` removes the section.
 */
export function quickFixCommand(subject: DriftSubject): string | null {
  return driftVerdict(subject) === 'drifted' ? rolloutRestartCommand(subject.name, subject.namespace) : null;
}

/** The headline and lead paragraph for a subject, so the drawer holds no copy of its own. */
export function driftCopy(subject: DriftSubject): { headline: string; explanation: string } {
  switch (driftVerdict(subject)) {
    case 'drifted':
      return { headline: DRIFT_HEADLINE, explanation: DRIFT_EXPLANATION };
    case 'not-comparable':
      return { headline: NOT_COMPARABLE_HEADLINE, explanation: NOT_COMPARABLE_EXPLANATION };
    default:
      // 'clean' shares the unknown copy because the drawer is never opened on a clean Deployment —
      // and if it somehow is, "nothing was evaluated" is the safer of the two things to say.
      return { headline: UNKNOWN_HEADLINE, explanation: UNKNOWN_EXPLANATION };
  }
}
