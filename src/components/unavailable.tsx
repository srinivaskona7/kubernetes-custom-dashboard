/**
 * "We could not ask" — the state this console was missing.
 *
 * The live dashboard showed **0 PVCs** for two clusters whose service-account tokens had
 * both expired. Nothing was wrong with the rendering: the collector caught the 401, fell
 * back to an empty array, and the page counted it. Zero is the worst possible answer to
 * give for a failed read, because it is indistinguishable from good news — "no pending
 * volumes" reads as healthy whether the fleet is clean or the credential died an hour ago.
 * An error at least gets investigated. A confident zero does not.
 *
 * So every collector-sourced number on every page goes through here, and there are exactly
 * three things a number can be:
 *
 *   ok           every cluster in scope was asked and answered. The count is the truth,
 *                and a 0 means zero.
 *   partial      some clusters answered and some could not. The count is a floor, not a
 *                total, and it is shown with the shortfall named — blanking it would throw
 *                away the half of the fleet that did answer.
 *   unavailable  nothing in scope could be read. An em-dash, never a digit.
 *
 * The distinction is carried by form before colour: an em-dash where the digits would be,
 * plus a dot and the word "unavailable". It survives greyscale, it survives colour
 * blindness, and it reaches a screen reader as a sentence rather than as a dash.
 *
 * Beside those three, and orthogonal to them, sits one more thing that can be wrong with a
 * number — not a state of the reading but a property of the read behind it. A list that came
 * back short because it hit the client's paging ceiling was genuinely read: every item
 * counted was seen. The count is real, but it is a FLOOR and not a total, so it renders
 * `≥ 4,182` with the ceiling named on hover. Folding that into `unavailable` would trade a
 * true lower bound for an em-dash, which tells an operator strictly less than the truth
 * already in hand, so it rides beside it as `truncated`, in the same vocabulary of labels.
 * Per label the two are mutually exclusive — a read either happened or it did not — but one
 * metric can be both partial and floored, when one cluster went blind and another hit the
 * ceiling. A floor is informational, never a fault: it is drawn in muted grey, and the warn
 * tone stays reserved for the readings that did not happen.
 *
 * A 404 is deliberately not unavailable. If the Certificate CRD is not installed, the
 * cluster genuinely has no certificates and 0 is honest — `srv/fleet/collectors/safe-list.js`
 * draws that line, and this module simply renders whichever side of it the server chose.
 */
import type { ReactNode } from 'react';
import { Dot } from './ui';

// --------------------------------------------------------------------------- model

/**
 * One read the collector could not perform.
 *
 * The server contract is `unavailable: string[]` — bare labels. But `safe-list.js` already
 * computes a reason code and a redacted detail per failed read, so the richer object shape
 * is accepted too: if the router ever passes it through, the UI starts naming the actual
 * cause with no further change here.
 */
export type UnavailableEntry =
  | string
  | { label: string; reason?: string | null; detail?: string | null };

/** A normalised failed read, with the cluster it belongs to when that is known. */
export interface UnavailableRead {
  label: string;
  reason: string | null;
  detail: string | null;
  cluster: string | null;
}

/**
 * The fourth, orthogonal axis: not whether a read succeeded, but whether the thing it was
 * looking for exists at all.
 *
 * `unavailable`/`truncated`/`partial` above are all about the READ. `presence` is about the
 * FEATURE, and only means anything once the read is known to have happened — cert-manager
 * reporting zero Certificates is `present, 0 items` when the CRD is served and the
 * list came back genuinely empty, and `absent` when the CRD isn't registered on this cluster
 * at all. Both render a 0 today; that collapse is exactly the defect this axis exists to
 * remove, motivated by 5 CRDs on the reference cluster that are installed with zero objects.
 *
 *   present  the feature is installed/served and the read succeeded — 0 is a true zero.
 *   absent   the feature's CRD/API group is confirmed not registered on this cluster. Not a
 *            failure: an absent optional add-on is the honest, healthy answer for a cluster
 *            that never chose to install it.
 *   unknown  neither confirmed. The probe that tells `present` apart from `absent` (a
 *            discovery call, `absentList`'s `callFn`) itself failed, or was never run.
 *   mixed    only meaningful fleet-wide: some clusters have it, some don't.
 */
export type Presence = 'present' | 'absent' | 'unknown' | 'mixed';

/** One feature the collector reported as absent, with the cluster it belongs to when known. */
export interface AbsentEntry {
  what: string;
  cluster: string | null;
  detail: string | null;
}

/**
 * Read a collector's `absent` verdict off any object shape, matching `unavailableEntries`'s
 * duck-typing so a page can call it before the field's type lands in `api.ts`.
 *
 * `absent` on the wire is `boolean | null` per `srv/fleet/collectors/safe-list.js`'s
 * `absentList` contract — never a list, because there is exactly one CRD per collector
 * summary to ask about. This normalises that scalar into the same "entries" shape the rest
 * of this module uses, so a page folding several collector summaries together (the way
 * `overview.tsx` folds health/compliance/workloads) can treat presence the same way it
 * already treats `unavailable`.
 */
export function absentEntries(what: string, value: unknown, cluster: string | null = null): AbsentEntry[] {
  if (!value || typeof value !== 'object') return [];
  const absent = (value as { absent?: unknown }).absent;
  return absent === true ? [{ what, cluster, detail: (value as { unreadableReason?: { detail?: string } }).unreadableReason?.detail ?? null }] : [];
}

/**
 * Fold a feature's `absent` field (as `safeList`/`absentList` emit it: `true` / `false` /
 * `null`) together across however many clusters are in scope, into the one `Presence` a
 * page needs for one tile or one panel.
 *
 * `unavailable` wins over everything — a read that did not happen cannot speak to presence
 * either way, which is why `unknown` rather than `absent` or `present` is returned for it.
 */
export function presenceOf(entries: { absent: boolean | null; unavailable: boolean }[]): Presence {
  const readable = entries.filter(e => !e.unavailable);
  if (readable.length === 0) return 'unknown';
  const known = readable.filter(e => e.absent !== null);
  if (known.length === 0) return 'unknown';
  const allAbsent = known.every(e => e.absent === true);
  const allPresent = known.every(e => e.absent === false);
  if (allAbsent) return 'absent';
  if (allPresent) return 'present';
  return 'mixed';
}

/** A cluster that could not be reached at all — every metric from it is missing. */
export interface UnreachableCluster {
  id: string;
  code: string;
  message: string;
  needsReseed: boolean;
}

/** What a single metric is: the whole point of this module, in three states. */
export interface MetricStatus {
  state: 'ok' | 'partial' | 'unavailable';
  /** Operator-facing noun for the thing that could not be read, e.g. "PVCs". */
  what: string;
  /** One sentence an operator can act on. Empty when `state` is `ok`. */
  why: string;
  /** How many in-scope clusters could not answer, and how many were asked. */
  blind: number;
  total: number;
  /**
   * A read behind this metric stopped at the client's paging ceiling, so the value is a
   * floor rather than a total. Orthogonal to `state`: an `ok` metric can be floored, and so
   * can a `partial` one. Never set alongside `unavailable`, where there is no number to
   * put a floor under.
   */
  truncated: boolean;
  /** The floor sentence, in the same voice as `why`. Empty when `truncated` is false. */
  truncatedWhy: string;
}

export interface UnavailableScope {
  /** Every failed read in scope, deduplicated. */
  reads: UnavailableRead[];
  /** Every read in scope that happened but stopped at the paging ceiling. */
  truncatedReads: UnavailableRead[];
  /** Clusters that answered nothing at all. */
  unreachable: UnreachableCluster[];
  /**
   * Cluster ids that are registered but have not been read yet — `ok: null` on the roster.
   * Separate from `unreachable` because they have not failed; they only make the aggregate
   * incomplete, which is what `of()` reports.
   */
  pending: string[];
  /** True when anything at all is missing — the trigger for the page-level notice. */
  any: boolean;
  /** True when anything in scope came back floored. Additive: `any` keeps its old meaning. */
  anyTruncated: boolean;
  /**
   * The status of one metric.
   *
   * @param what   the noun to show, e.g. `'PVCs'`
   * @param labels the collector labels that feed it; matched loosely, so `'pvc'` also
   *               matches `'pvcs'` and a raw path like `/api/v1/persistentvolumeclaims`
   */
  of: (what: string, ...labels: string[]) => MetricStatus;
}

// ------------------------------------------------------------------------ reasons

/** The reason codes `safe-list.js` emits, as sentences an operator can act on. */
const REASON_TEXT: Record<string, string> = {
  // No em-dash inside these: `sentence()` already joins with one, and two in a row reads badly.
  FORBIDDEN: 'the cluster refused the read; the service account is missing an RBAC rule',
  UNAUTHORIZED: 'the cluster rejected the token — it has expired or been revoked',
  RATE_LIMITED: 'the API server rate-limited the request',
  TIMEOUT: 'the API server did not answer in time',
  UPSTREAM: 'the API server returned an error'
};

/**
 * What to say when the server sent a bare label and no reason. An expired or forbidden
 * token is overwhelmingly the cause, and naming it is more useful than saying nothing —
 * but it is phrased as the two possibilities rather than as a diagnosis.
 */
const UNSTATED_REASON = 'the token may have expired or the read may be forbidden';

// ------------------------------------------------------------------- normalisation

/**
 * Read an `unavailable` array off any object shape without needing its type.
 *
 * Exported because a per-cluster endpoint returns several collector summaries side by side
 * (`/clusters/:id/overview` carries health, compliance and workloads at once) and the page
 * has to fold them into one list before it can build a scope.
 */
export function unavailableEntries(value: unknown): UnavailableEntry[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as { unavailable?: unknown }).unavailable;
  return Array.isArray(raw) ? (raw as UnavailableEntry[]) : [];
}

/**
 * The same, for the reads that happened but stopped at the paging ceiling.
 *
 * A separate key rather than extra entries in `unavailable`, because the two mean opposite
 * things about whether a number exists at all. An older server sends no `truncated` at all
 * and this returns `[]` — nothing on any page changes until the field arrives.
 */
export function truncatedEntries(value: unknown): UnavailableEntry[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as { truncated?: unknown }).truncated;
  // `LogTail.truncated` is a boolean with an unrelated meaning (log output cut at a byte
  // limit). Only an array is this vocabulary; anything else is somebody else's field.
  return Array.isArray(raw) ? (raw as UnavailableEntry[]) : [];
}

const entriesOf = unavailableEntries;
const floorsOf = truncatedEntries;

function normalise(entry: UnavailableEntry, cluster: string | null): UnavailableRead | null {
  if (typeof entry === 'string') {
    return entry ? { label: entry, reason: null, detail: null, cluster } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.label === 'string' && entry.label) {
    return { label: entry.label, reason: entry.reason ?? null, detail: entry.detail ?? null, cluster };
  }
  return null;
}

/**
 * Does a collector label denote the thing the page is asking about?
 *
 * Loose on purpose. The collectors are being migrated onto `safeList` one at a time and
 * their labels are not settled — some pass `'hpa'`, some `'cronjobs'`, and the ones not yet
 * migrated will default to the raw API path. Matching the last path segment, and singular
 * against plural, means a page keeps working whichever of those lands. Being too strict
 * here fails silently back to rendering a zero, which is the exact bug being fixed.
 */
function matches(label: string, query: string): boolean {
  const a = label.toLowerCase();
  const q = query.toLowerCase();
  if (a === q || a === `${q}s` || `${a}s` === q) return true;
  const tail = a.split('?')[0]!.split('/').filter(Boolean).pop() ?? a;
  return tail === q || tail === `${q}s` || `${tail}s` === q;
}

// --------------------------------------------------------------------------- scope

/** A cluster's slot in a fan-out response, duck-typed so `api.ts` needs no change to read it. */
interface ClusterLike {
  id?: string;
  clusterId?: string;
  /**
   * Three-state on the roster endpoints: `true` read, `false` tried and failed, `null`
   * registered but not read yet. `null` contributes no numbers, exactly like `false` does, so
   * every aggregate built over it has to say so — but it is not a failure and never appears in
   * `unreachable`.
   */
  ok?: boolean | null;
  error?: { code?: string; message?: string; needsReseed?: boolean } | null;
  summary?: unknown;
  unavailable?: unknown;
  truncated?: unknown;
}

/**
 * Build the scope for one page.
 *
 * `summary` is the fleet-level summary object; `clusters` the per-cluster list. Either may
 * be absent — `/security` has no fleet summary, `/drift` has no per-cluster labels — and the
 * scope degrades to whichever is present. `cluster` is the page's cluster filter, so a page
 * filtered to one cluster is judged only on that cluster's reads.
 *
 * Everything is read by duck-typing rather than by a declared type, because the response
 * types live in `api.ts` and the field is arriving there separately. When it does, nothing
 * here has to change.
 */
export function unavailableScope(input: {
  summary?: unknown;
  clusters?: readonly unknown[] | null;
  unreachable?: readonly unknown[] | null;
  cluster?: string;
}): UnavailableScope {
  const filter = input.cluster || '';
  const inScope = (id: string | null) => !filter || !id || id === filter;

  const list: ClusterLike[] = [
    ...((input.clusters ?? []) as ClusterLike[]),
    // `/security` splits the two lists; anything in `unreachable` is by definition not ok.
    ...((input.unreachable ?? []) as ClusterLike[]).map(c => ({ ...c, ok: false }))
  ].filter(c => c && typeof c === 'object');

  const scoped = list.filter(c => inScope(c.id ?? c.clusterId ?? null));

  const unreachable: UnreachableCluster[] = scoped
    .filter(c => c.ok === false)
    .map(c => ({
      id: c.id ?? c.clusterId ?? 'unknown',
      code: c.error?.code ?? 'UNREACHABLE',
      message: c.error?.message ?? 'the cluster returned no data',
      needsReseed: Boolean(c.error?.needsReseed)
    }));

  // Clusters that contributed no numbers because nothing has read them yet — a cluster onboarded
  // seconds ago is the whole population in practice. Kept out of `unreachable` on purpose: they
  // have not failed, and a fleet header that says "1 unreachable" about a cluster nobody
  // contacted is worse than one that says nothing. They still make every aggregate incomplete,
  // which is what `of()` uses them for.
  const pending: string[] = scoped.filter(c => c.ok === null).map(c => c.id ?? c.clusterId ?? 'unknown');

  // Per-cluster labels are preferred, because they say *which* cluster went blind. The
  // fleet-level summary is the fallback for endpoints that only publish the union.
  const perCluster: UnavailableRead[] = scoped.flatMap(c => {
    const id = c.id ?? c.clusterId ?? null;
    return [...entriesOf(c), ...entriesOf(c.summary)]
      .map(e => normalise(e, id))
      .filter((r): r is UnavailableRead => r !== null);
  });

  const fleetWide: UnavailableRead[] = entriesOf(input.summary)
    .map(e => normalise(e, null))
    .filter((r): r is UnavailableRead => r !== null);

  // Both sources at once would double-count, so the union is only consulted when no cluster
  // claimed the failure itself. Over-warning is the safe direction; under-warning is the bug.
  const reads = perCluster.length > 0 ? perCluster : fleetWide;

  // The floored reads are gathered exactly the same way and kept in their own list. Same
  // vocabulary of labels, opposite meaning: these reads happened.
  const perClusterFloors: UnavailableRead[] = scoped.flatMap(c => {
    const id = c.id ?? c.clusterId ?? null;
    return [...floorsOf(c), ...floorsOf(c.summary)]
      .map(e => normalise(e, id))
      .filter((r): r is UnavailableRead => r !== null);
  });

  const fleetFloors: UnavailableRead[] = floorsOf(input.summary)
    .map(e => normalise(e, null))
    .filter((r): r is UnavailableRead => r !== null);

  const truncatedReads = perClusterFloors.length > 0 ? perClusterFloors : fleetFloors;

  function of(what: string, ...labels: string[]): MetricStatus {
    const hit = (c: ClusterLike) => {
      const id = c.id ?? c.clusterId ?? null;
      // `!== true` rather than `=== false`: an unread cluster has no number under this metric
      // either, and an aggregate that quietly leaves it out is the same confident-zero bug as
      // one that leaves out a forbidden read.
      if (c.ok === false || c.ok === null) return true;
      return reads.some(r => r.cluster === id && labels.some(l => matches(r.label, l)));
    };

    const floors = truncatedReads.filter(r => labels.some(l => matches(r.label, l)));
    // A metric with no number under it cannot have a floor, so `unavailable` always wins.
    // The two are mutually exclusive per label per cluster; they can still collide here when
    // one cluster went blind on a label another cluster merely floored.
    const floored = (state: MetricStatus['state']) =>
      state !== 'unavailable' && floors.length > 0
        ? { truncated: true, truncatedWhy: floorSentence(what, floors) }
        : { truncated: false, truncatedWhy: '' };

    // Endpoints that publish no cluster list at all: the union is all we have, so a hit
    // means the whole metric is untrustworthy.
    if (scoped.length === 0) {
      const unattributed = reads.filter(r => labels.some(l => matches(r.label, l)));
      if (unattributed.length === 0) {
        return { state: 'ok', what, why: '', blind: 0, total: 0, ...floored('ok') };
      }
      return {
        state: 'unavailable',
        what,
        why: sentence(what, unattributed, unreachable),
        blind: 1,
        total: 1,
        ...floored('unavailable')
      };
    }

    const blindClusters = scoped.filter(hit);
    if (blindClusters.length === 0) {
      return { state: 'ok', what, why: '', blind: 0, total: scoped.length, ...floored('ok') };
    }

    const blindIds = new Set(blindClusters.map(c => c.id ?? c.clusterId ?? null));
    const relevant = reads.filter(r => labels.some(l => matches(r.label, l)) && blindIds.has(r.cluster));
    const state = blindClusters.length === scoped.length ? 'unavailable' : 'partial';

    return {
      state,
      what,
      why: sentence(
        what,
        relevant,
        unreachable.filter(u => blindIds.has(u.id)),
        pending.filter(id => blindIds.has(id))
      ),
      blind: blindClusters.length,
      total: scoped.length,
      ...floored(state)
    };
  }

  return {
    reads,
    truncatedReads,
    unreachable,
    pending,
    any: reads.length > 0 || unreachable.length > 0 || pending.length > 0,
    anyTruncated: truncatedReads.length > 0,
    of
  };
}

/**
 * The same scope, for a **single-envelope** response — `GET /clusters/:id/<anything>`.
 *
 * `unavailableScope`'s `{summary, clusters, cluster}` signature describes a fan-out with a
 * cluster list; a per-cluster route returns one envelope and no list, so every tab that reads
 * one had to hand-roll a one-element `clusters: [{ id, ok: true, ... }]`. Seven copies of that
 * literal is seven chances to write `ok: true` where the envelope said otherwise, or to forget
 * `truncated` — which fails silently, in the direction of over-confidence.
 *
 * Pass the envelope's `data.summary`. A missing or refused payload gives an empty scope, which
 * is correct: the failure is already on the envelope's own `error`, and the page renders an
 * `ErrorState` for that rather than a wall of per-metric "unavailable".
 */
export function envelopeScope(cluster: string, summary: unknown): UnavailableScope {
  if (!summary) return unavailableScope({});
  return unavailableScope({
    clusters: [
      {
        id: cluster,
        ok: true,
        unavailable: unavailableEntries(summary),
        truncated: truncatedEntries(summary)
      }
    ]
  });
}

/** The operator-facing sentence: what could not be read, and the best available why. */
function sentence(
  what: string,
  reads: UnavailableRead[],
  unreachable: UnreachableCluster[],
  pending: string[] = []
): string {
  const detail = reads.find(r => r.detail)?.detail;
  if (detail) return `could not read ${what} — ${detail}`;

  const code = reads.find(r => r.reason)?.reason;
  if (code && REASON_TEXT[code]) return `could not read ${what} — ${REASON_TEXT[code]}`;

  if (unreachable.length > 0) {
    const first = unreachable[0]!;
    const others = unreachable.length > 1 ? ` (and ${unreachable.length - 1} more)` : '';
    return `could not read ${what} — ${first.id} is unreachable: ${first.message}${others}`;
  }

  // Last, and phrased as waiting rather than as a fault: this is the state a cluster is in for
  // the few seconds between being added and the first fan-out covering it, and the honest thing
  // to say is that the number is not in yet.
  if (pending.length > 0) {
    const names = pending.length > 1 ? `${pending[0]} (and ${pending.length - 1} more)` : pending[0];
    return `no ${what} yet — ${names} has not been read since being added`;
  }

  return `could not read ${what} — ${UNSTATED_REASON}`;
}

/**
 * The operator-facing sentence for a floored metric: read, but not to the end.
 *
 * Deliberately in the same voice as `sentence()` and deliberately not an apology — the
 * number beside it is true, it is simply a lower bound. Naming the reads that came back
 * short matters when the metric is fed by several: "scheduled pods" floored because the
 * `pods` list hit the ceiling is a different fact from the node list hitting it.
 */
function floorSentence(what: string, reads: UnavailableRead[]): string {
  const names = [...new Set(reads.map(r => r.label).filter(Boolean))];
  const which = names.length > 0 ? `the ${names.join(' and ')} read` : `the read behind ${what}`;
  return `${which} stopped at the client's paging ceiling, so the ${what} count is a floor, not a total`;
}

// ------------------------------------------------------------------------ rendering

type Size = 'sm' | 'md' | 'lg';

/** The dash matches the type size of the number it stands in for, so nothing shifts. */
const DASH_SIZE: Record<Size, string> = {
  sm: 'text-[14px]',
  md: 'text-[16px]',
  lg: 'text-[22px]'
};

/**
 * An unreadable metric. An em-dash where the number would be, and a dot-and-word affordance
 * carrying the reason on hover and on focus.
 *
 * Never a digit, and never colour on its own: the em-dash, the word "unavailable" and the
 * dashed underline all survive greyscale, and the whole thing reaches a screen reader as one
 * sentence naming the resource and the cause.
 */
export function Unavailable({
  what,
  why,
  size = 'md',
  variant = 'full'
}: {
  what: string;
  why?: string;
  size?: Size;
  /**
   * `dash` drops the word and keeps the em-dash, for slots too narrow to spell it out —
   * a tab count, a dense table cell. The reason still reaches the tooltip and the screen
   * reader, and the dash is tinted so it cannot be mistaken for the muted "not applicable"
   * dash the console already uses.
   */
  variant?: 'full' | 'dash';
}) {
  const reason = why || `could not read ${what} — ${UNSTATED_REASON}`;
  const tooltip = reason.charAt(0).toUpperCase() + reason.slice(1);

  if (variant === 'dash') {
    return (
      <span
        className="inline-flex items-baseline align-baseline border-b border-dashed border-warn/60"
        tabIndex={0}
        title={tooltip}
      >
        <span className="sr-only">{what} unavailable. {reason}.</span>
        <span aria-hidden="true" className={`mono ${DASH_SIZE[size]} text-warn`}>
          —
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-baseline gap-1.5 align-baseline" tabIndex={0} title={tooltip}>
      <span className="sr-only">{what} unavailable. {reason}.</span>
      <span aria-hidden="true" className={`mono ${DASH_SIZE[size]} text-muted`}>
        —
      </span>
      <span
        aria-hidden="true"
        className="inline-flex items-center gap-1 border-b border-dashed border-warn/60 pb-px text-[12px] font-medium uppercase tracking-[0.06em] text-warn"
      >
        <Dot tone="warn" />
        unavailable
      </span>
    </span>
  );
}

/**
 * A count that is real but not finished: the read stopped at the client's paging ceiling.
 *
 * One presentation, used everywhere a floored number appears — a `≥` in front of the digits,
 * carrying the ceiling in its tooltip and the words "at least" to a screen reader. The digits
 * themselves are untouched, because they are correct as far as they go.
 *
 * Muted, not warn. Nothing failed here, and spending the console's alarm colour on a number
 * that is merely a lower bound would blunt it where it means a dead credential. The `≥` is
 * form, not colour: it survives greyscale exactly as the em-dash does.
 */
export function Truncated({
  status,
  children,
  className = ''
}: {
  status: MetricStatus;
  children: ReactNode;
  className?: string;
}) {
  const why = status.truncatedWhy;
  const tooltip = `At least this many. ${why.charAt(0).toUpperCase()}${why.slice(1)}.`;

  return (
    <span className={`inline-flex items-baseline gap-1 align-baseline ${className}`} tabIndex={0} title={tooltip}>
      <span className="sr-only">at least </span>
      <span
        aria-hidden="true"
        className="mono self-center border-b border-dotted border-muted/70 pb-px text-[14px] leading-none text-muted"
      >
        ≥
      </span>
      {children}
      <span className="sr-only"> — {why}.</span>
    </span>
  );
}

/**
 * A count in a tight slot — a tab label, a section heading. Same three states, no wrapping.
 */
export function Count({ status, value, size = 'sm' }: { status: MetricStatus; value: number | null; size?: Size }) {
  if (status.state === 'unavailable') {
    return <Unavailable what={status.what} why={status.why} size={size} variant="dash" />;
  }
  // A `null` verdict rendered as blank empty space before this — indistinguishable from a
  // still-loading tile, which is exactly the false-affirmative-adjacent defect this module
  // exists to remove. An explicit em-dash matches the convention `Unavailable` already uses,
  // even though `status` itself may say `ok` — a collector can hand back a null count on a
  // successful read (e.g. `IntegrityData.summary.servedVersionDrift`-style fields), and that
  // is a different fact from the read having failed outright.
  if (value === null) {
    return (
      <span aria-hidden="true" className={`mono ${DASH_SIZE[size]} text-muted`}>
        —
      </span>
    );
  }
  if (status.state === 'partial') {
    // `{value}+` is already a floor marker, so a truncated read adds no second glyph here —
    // it would read as two different claims about the same number. The tooltip names both.
    const floor = status.truncated ? ` ${status.truncatedWhy}.` : '';
    return (
      <span tabIndex={0} title={`${status.why.charAt(0).toUpperCase()}${status.why.slice(1)}. At least ${value}.${floor}`}>
        <span className="sr-only">
          At least {value}; {status.blind} of {status.total} clusters could not be read.
        </span>
        <span aria-hidden="true" className="text-warn">
          {value}+
        </span>
      </span>
    );
  }
  if (status.truncated) return <Truncated status={status}>{value}</Truncated>;
  return <>{value}</>;
}

/**
 * A count that is real but incomplete: some clusters answered, some could not.
 *
 * Blanking it would discard the half of the fleet that did answer, so the number stays and
 * the shortfall is named next to it. `+?` is deliberate — the missing amount is unknown, not
 * zero, and that is the whole distinction this module exists to keep.
 */
export function Partial({ status }: { status: MetricStatus }) {
  return (
    <span
      className="inline-flex items-baseline gap-1 align-baseline"
      tabIndex={0}
      title={`${status.why.charAt(0).toUpperCase()}${status.why.slice(1)}. ${status.blind} of ${status.total} clusters did not answer, so this count is a floor, not a total.`}
    >
      <span className="sr-only">
        Partial: {status.blind} of {status.total} clusters could not be read, so this count is a floor, not a
        total. {status.why}.
      </span>
      <span
        aria-hidden="true"
        className="inline-flex items-center gap-1 border-b border-dashed border-warn/60 pb-px text-[12px] font-medium text-warn"
      >
        <Dot tone="warn" />
        +? from {status.blind} of {status.total}
      </span>
    </span>
  );
}

/**
 * The one place a collector-sourced number is rendered.
 *
 * Pass the value as children and the status from `scope.of(...)`; this decides whether the
 * operator sees the digits, the digits behind a `≥`, the digits plus a shortfall, or an
 * em-dash. Every count in the console goes through it, so the states cannot drift apart
 * between pages.
 */
export function MetricValue({
  status,
  children,
  size = 'md',
  className = ''
}: {
  /** Omit for a value that is not collector-sourced; it renders straight through. */
  status?: MetricStatus;
  children: ReactNode;
  size?: Size;
  className?: string;
}) {
  if (!status || (status.state === 'ok' && !status.truncated)) return <span className={className}>{children}</span>;
  if (status.state === 'unavailable') return <Unavailable what={status.what} why={status.why} size={size} />;
  // Read, but not to the end: the digits stand, with a `≥` in front of them.
  if (status.state === 'ok') {
    return (
      <Truncated status={status}>
        <span className={className}>{children}</span>
      </Truncated>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-2">
      {status.truncated ? (
        <Truncated status={status}>
          <span className={className}>{children}</span>
        </Truncated>
      ) : (
        <span className={className}>{children}</span>
      )}
      <Partial status={status} />
    </span>
  );
}

/**
 * A summary tile. The tile chrome already existed on five pages; what is new is that the
 * value slot and the caption both know about the three states, so an unreadable tile cannot
 * look like a healthy one — big em-dash and a warn caption against big digits and a neutral
 * caption. A floored tile keeps its digits and spends its caption saying they are a floor,
 * in muted: the reading is sound, it simply stopped early.
 */
export function StatTile({
  label,
  status,
  value,
  caption,
  valueClass = 'text-text',
  onClick,
  actionLabel
}: {
  label: string;
  status: MetricStatus;
  value: ReactNode;
  caption: ReactNode;
  /** Tone class for the digits. Ignored when the metric could not be read. */
  valueClass?: string;
  /**
   * Makes the whole tile the control that shows the rows behind the number.
   *
   * A summary count with no destination is a dead end: the operator reads "3 failed" and then has
   * to go and find the three. When it is present the tile becomes a `<button>` — not a div with a
   * click handler, so it is reachable by keyboard and announced as actionable.
   *
   * Suppressed when the metric could not be read: filtering a table by a number that does not
   * exist lands the operator on an empty table and blames them for it.
   */
  onClick?: () => void;
  /** What the click does, for the tooltip and the screen reader. */
  actionLabel?: string;
}) {
  const dead = status.state === 'unavailable';
  // `leading-7` on the digits and `leading-tight` on the caption are what keep the tile inside the
  // 104–120px the layout system allows: at the inherited 1.5 line-height a two-line caption pushed
  // it to 131px, which is a different card height on the same row as a one-line neighbour.
  const digits = <span className={`text-[22px] font-semibold leading-7 ${valueClass}`}>{value}</span>;
  const clickable = Boolean(onClick) && !dead;
  const body = (
    <>
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        {dead ? (
          <Unavailable what={status.what} why={status.why} size="lg" />
        ) : (
          <>
            {status.truncated ? <Truncated status={status}>{digits}</Truncated> : digits}
            {status.state === 'partial' && <Partial status={status} />}
          </>
        )}
      </div>
      <div
        className={`mt-1 line-clamp-2 text-[12px] leading-tight ${dead ? 'text-warn' : 'text-muted'}`}
        title={dead ? status.why : status.truncated ? status.truncatedWhy : undefined}
      >
        {dead ? status.why : status.truncated ? `A floor, not a total — ${status.truncatedWhy}` : caption}
      </div>
    </>
  );

  // `h-full` on both branches: in a CSS grid the items stretch by default, but a tile whose
  // caption wraps to two lines while its neighbour's does not would otherwise leave the shorter
  // one's border short of the row's baseline. `min-h-[104px]` is the floor of the allowed band, so
  // a tile with a one-word caption is still a card rather than a strip.
  // `flex flex-col` on the button: Chrome centres a <button>'s content vertically in its box, so in a
  // stretched row a tile with a one-line caption dropped 8–10px below a two-line neighbour (Ingress,
  // Traces, Mesh KPI rows, measured 2026-09-27). A column flex box stacks it from the top like the div.
  if (clickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={actionLabel}
        aria-label={actionLabel ? `${label}: ${actionLabel}` : undefined}
        className="flex h-full min-h-[104px] flex-col rounded-[8px] border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {body}
      </button>
    );
  }
  return <div className="h-full min-h-[104px] rounded-[8px] border border-line bg-surface p-4">{body}</div>;
}

/**
 * The empty state for a table whose source could not be read.
 *
 * "No items found" is the same lie as a zero — it asserts the cluster was asked. This says
 * which read failed and why, and offers the command that repairs the usual cause.
 */
export function UnavailableEmptyBody({ status }: { status: MetricStatus }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 page-x py-12 text-center" role="status">
      <span className="inline-flex items-center gap-2 text-[16px] font-medium text-warn">
        <Dot tone="warn" />
        {status.why.charAt(0).toUpperCase() + status.why.slice(1)}
      </span>
      <p className="max-w-[62ch] text-[14px] text-muted">
        This is not an empty {status.what.toLowerCase()} list — the read did not happen, so nothing here can be
        trusted as zero. Check the cluster&apos;s token on the Tokens page, then refresh.
      </p>
    </div>
  );
}

/** `UnavailableEmptyBody` as a table row, for the pages that hand-roll their tables. */
export function UnavailableRow({ status, colSpan }: { status: MetricStatus; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <UnavailableEmptyBody status={status} />
      </td>
    </tr>
  );
}

/**
 * The absent-feature counterpart to `Unavailable`: the read succeeded and the feature
 * genuinely is not installed. Dotted, not dashed — a dashed border means a read failed;
 * a dotted one means the read succeeded and came back with an honest "not here". Same
 * validated palette, no new hue: only the border style and the tone weight change.
 */
export function NotInstalled({
  what,
  detail,
  size = 'md'
}: {
  /** The operator-facing noun, e.g. "cert-manager" or "the Prometheus Operator". */
  what: string;
  detail?: string | null;
  size?: Size;
}) {
  const reason = detail || `${what} is not installed on this cluster`;
  const tooltip = reason.charAt(0).toUpperCase() + reason.slice(1);
  return (
    <span className="inline-flex items-baseline gap-1.5 align-baseline" tabIndex={0} title={tooltip}>
      <span className="sr-only">{what} not installed. {reason}.</span>
      <span aria-hidden="true" className={`mono ${DASH_SIZE[size]} text-muted`}>
        —
      </span>
      <span
        aria-hidden="true"
        className="inline-flex items-center gap-1 border-b border-dotted border-muted/60 pb-px text-[12px] font-medium uppercase tracking-[0.06em] text-muted"
      >
        <Dot tone="unknown" />
        not installed
      </span>
    </span>
  );
}

/**
 * The absent-feature counterpart to `UnavailableEmptyBody`: a table or panel whose source
 * read cleanly and reported the feature is not on this cluster. Distinct wording from
 * `UnavailableEmptyBody` on purpose — "0 findings because nothing was found" and "0
 * findings because the CRD doesn't exist here" are different facts and must not share one
 * sentence, the same way they must not share one rendered zero.
 */
export function NotInstalledPanel({ what, detail }: { what: string; detail?: string | null }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 page-x py-12 text-center" role="status">
      <span className="inline-flex items-center gap-2 text-[16px] font-medium text-muted">
        <Dot tone="unknown" />
        {what} is not installed on this cluster
      </span>
      <p className="max-w-[62ch] text-[14px] text-muted">
        This read succeeded — the cluster answered — and the honest result is that {what.toLowerCase()} is not
        present here. That is a different fact from a failed read, and a different fact from an installed feature
        with zero findings.
        {detail ? ` ${detail}.` : ''}
      </p>
    </div>
  );
}

/**
 * The page-level banner: everything on this page that could not be read, in one place, and
 * beneath it everything that was read but stopped short.
 *
 * Grouped with `divide-y` rather than boxed in a card — at this density another card
 * container would read as content rather than as a warning, and the console's hardening rule
 * says to group with separators and negative space instead.
 *
 * Up to three bands, never merged into one. A failed read, a floored read and an absent
 * feature are three different facts and get three different border weights: warn/dashed for
 * what could not be taken, muted/solid for what was taken to the ceiling, and a third,
 * visually MUTED muted/dotted band for what was read successfully and reported itself not
 * installed. Merging any pair would either alarm an operator about a number that is fine,
 * bury a dead credential among paging notes, or — the case this third band exists to stop —
 * make "not installed" look like the same kind of problem as a dead token.
 *
 * `absent` is optional and page-supplied (`AbsentEntry[]`, from `absentEntries()`) rather
 * than living on `UnavailableScope` itself: presence is a property of one collector's own
 * `absent` field, not something `unavailableScope`'s duck-typed fold across many collectors
 * can derive on its own the way `unavailable`/`truncated` can.
 */
export function UnavailableNotice({
  scope,
  absent = [],
  className = ''
}: {
  scope: UnavailableScope;
  /** Features this page's collector(s) reported as confirmed absent. See `absentEntries()`. */
  absent?: AbsentEntry[];
  className?: string;
}) {
  const rows: { key: string; subject: string; detail: string }[] = [
    ...scope.unreachable.map(u => ({
      key: `cluster:${u.id}`,
      subject: `${u.id} — every reading`,
      detail: `${u.code}: ${u.message}`
    })),
    ...scope.reads.map(r => ({
      key: `read:${r.cluster ?? '*'}:${r.label}`,
      subject: r.cluster ? `${r.cluster} — ${r.label}` : r.label,
      detail: r.detail || (r.reason && REASON_TEXT[r.reason]) || UNSTATED_REASON
    }))
  ];

  // A cluster that is wholly unreachable already accounts for its own failed reads.
  const blind = new Set(scope.unreachable.map(u => u.id));
  const seen = new Set<string>();
  const visible = rows.filter(row => {
    const cluster = row.key.split(':')[1];
    if (row.key.startsWith('read:') && cluster && blind.has(cluster)) return false;
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });

  const flooredSeen = new Set<string>();
  const floored = scope.truncatedReads
    .map(r => ({
      key: `floor:${r.cluster ?? '*'}:${r.label}`,
      cluster: r.cluster,
      subject: r.cluster ? `${r.cluster} — ${r.label}` : r.label
    }))
    .filter(row => {
      if (row.cluster && blind.has(row.cluster)) return false;
      if (flooredSeen.has(row.key)) return false;
      flooredSeen.add(row.key);
      return true;
    });

  if (visible.length === 0 && floored.length === 0 && absent.length === 0) return null;

  return (
    <div className={className}>
      {visible.length > 0 && (
        <div className="border-y border-warn/25 bg-warn/5 page-x py-2.5" role="status">
          <div className="flex items-baseline gap-2 text-[13px]">
            <Dot tone="warn" />
            <p className="min-w-0">
              <span className="font-medium text-warn">
                {visible.length} {visible.length === 1 ? 'reading' : 'readings'} could not be taken.
              </span>{' '}
              <span className="text-muted">
                Counts on this page exclude them — treat a 0 here as &ldquo;not asked&rdquo; unless it is marked
                otherwise.
              </span>
            </p>
          </div>
          <ul className="mt-1.5 divide-y divide-warn/15 pl-4">
            {visible.map(row => (
              <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-4 py-1 text-[13px]">
                <span className="mono text-text">{row.subject}</span>
                <span className="min-w-0 truncate text-muted" title={row.detail}>
                  {row.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {floored.length > 0 && (
        <div
          className={`border-b border-line bg-raised/40 page-x py-2.5 ${visible.length > 0 ? '' : 'border-t'}`}
          role="status"
        >
          <div className="flex items-baseline gap-2 text-[13px]">
            <Dot tone="unknown" />
            <p className="min-w-0">
              <span className="font-medium text-text">
                {floored.length} {floored.length === 1 ? 'reading' : 'readings'} stopped at the paging ceiling.
              </span>{' '}
              <span className="text-muted">
                Those reads happened and their items are real, but they came back short — every count they feed
                is a floor, marked <span className="mono">≥</span> where it appears.
              </span>
            </p>
          </div>
          <ul className="mt-1.5 divide-y divide-line/60 pl-4">
            {floored.map(row => (
              <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-4 py-1 text-[13px]">
                <span className="mono text-text">{row.subject}</span>
                <span className="min-w-0 truncate text-muted">
                  read to the client&apos;s paging ceiling; more items exist beyond it
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {absent.length > 0 && (
        <div
          className={`border-b border-line bg-raised/25 page-x py-2.5 ${visible.length > 0 || floored.length > 0 ? '' : 'border-t'}`}
          role="status"
        >
          <div className="flex items-baseline gap-2 text-[13px]">
            <Dot tone="unknown" />
            <p className="min-w-0">
              <span className="font-medium text-text">
                {absent.length} {absent.length === 1 ? 'feature' : 'features'} not installed.
              </span>{' '}
              <span className="text-muted">
                These reads succeeded and reported the honest zero — the CRD or API group is confirmed absent on
                the cluster named, not merely empty.
              </span>
            </p>
          </div>
          <ul className="mt-1.5 divide-y divide-line/40 pl-4">
            {absent.map((row, i) => (
              <li
                key={`absent:${row.cluster ?? '*'}:${row.what}:${i}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 py-1 text-[13px]"
              >
                <span className="mono text-text border-b border-dotted border-muted/60 pb-px">
                  {row.cluster ? `${row.cluster} — ${row.what}` : row.what}
                </span>
                <span className="min-w-0 truncate text-muted">{row.detail || 'not installed on this cluster'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
