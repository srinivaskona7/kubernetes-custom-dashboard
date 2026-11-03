/**
 * The rules behind the "Declared mTLS (configuration)" card on the Istio & Mesh tab.
 *
 * Nothing in this console observes a TLS handshake. Every mTLS verdict the collector emits is
 * read from PeerAuthentication and DestinationRule *specs* — which is why it stamps
 * `mtlsBasis: 'configuration'` on each one (`srv/fleet/collectors/mesh.js`). Three consequences
 * are encoded here rather than in JSX, so they can be unit-tested (this package's vitest runs
 * `environment: 'node'`; there is no DOM):
 *
 *  1. A declared STRICT mode is only enforced by something that terminates the connection — a
 *     sidecar, or ztunnel for an ambient workload. A namespace whose pods carry no proxy is not
 *     in the mesh at all, so its STRICT row must not read green.
 *  2. `PERMISSIVE` because nobody ever wrote a PeerAuthentication (`modeSource: 'default'`) is a
 *     different fact from a PERMISSIVE somebody chose, and is reported as unknown-not-warn.
 *  3. `portLevelMtls` can contradict the top-level mode for individual ports with the same
 *     workload > namespace > mesh precedence. The collector resolves these into `portOverrides`;
 *     an override that differs from the top-level mode has to be visible on the row, or a
 *     `{9090: DISABLE}` hides under a green STRICT.
 *
 * Nothing here ever substitutes a number or a verdict for an absent read: a missing coverage
 * join yields `unknown` and says so, never `ok` and never 0.
 */

export type MtlsTone = 'ok' | 'warn' | 'bad' | 'unknown' | 'accent';

/**
 * The coverage facts for the scope a verdict applies to, or `null` when the pod read failed.
 *
 * `podCount`/`inMeshCount` count **sidecar-eligible** pods only. Ambient pods have no sidecar to
 * count and are enforced by ztunnel instead, so they are carried separately in `ambientPodCount` —
 * folding them into `podCount` made an all-ambient scope look like a scope with unmeshed pods, and
 * excluding them entirely made it look like a scope with no pods at all.
 */
export interface CoverageJoin {
  inMeshCount: number;
  podCount: number;
  ambient: boolean;
  /** Pods in scope that are ambient (ztunnel-enforced), when the split is known. */
  ambientPodCount?: number;
  /** The namespace these counts came from, for a join attributed to one. */
  namespace?: string;
  /**
   * `'scope'` — the counts describe exactly the pods the verdict governs.
   * `'namespace'` — they describe the verdict's whole namespace because which pods a
   * workload-scoped PeerAuthentication selects is not on the wire (the payload carries label
   * selectors, the coverage rows carry owner names — they do not join). A note built from a
   * `'namespace'` join must say so instead of asserting the figure about the row.
   */
  attribution?: 'scope' | 'namespace';
}

export interface MtlsModeCell {
  /** What the pill says. */
  label: string;
  tone: MtlsTone;
  /** The one-line reason, shown as the pill's title and beside the row. `null` = nothing to add. */
  note: string | null;
}

/** The literal the collector uses when no PeerAuthentication defined a mode at any scope. */
export const DEFAULT_MODE_SOURCE = 'default';

/** Printed under the card title. The basis is a fact from the payload, never assumed here. */
export function mtlsBasisNote(basis: string | null | undefined): string {
  if (basis === 'configuration') {
    return 'Basis: configuration — resolved from PeerAuthentication and DestinationRule specs. No handshake is observed, so this is what the mesh was told to do, not what a connection did.';
  }
  if (!basis) return 'Basis not reported — treat these rows as unverified.';
  return `Basis: ${basis}.`;
}

/**
 * The mode pill for one verdict row.
 *
 * `coverage` must be the coverage for the scope this verdict governs (the namespace's pods for a
 * namespace/workload verdict, the mesh-wide aggregate for the mesh verdict), or `null` when the
 * pod read was refused.
 */
export function mtlsModeCell(
  mode: string,
  modeSource: string,
  coverage: CoverageJoin | null | undefined
): MtlsModeCell {
  if (mode === 'STRICT') {
    if (!coverage) {
      return {
        label: 'STRICT',
        tone: 'unknown',
        note: 'sidecar coverage not reported — whether anything enforces this is unknown'
      };
    }
    // Every sidecar-eligible pod is ambient (or the scope is ambient with no sidecar pods at all):
    // ztunnel terminates the connection, so the declaration is enforced.
    if (coverage.podCount === 0 && coverage.ambient) {
      return { label: 'STRICT', tone: 'ok', note: 'enforced by ztunnel (ambient)' };
    }
    if (coverage.podCount === 0) {
      return { label: 'STRICT', tone: 'unknown', note: 'no pods in scope — nothing to enforce it on' };
    }
    const amb = typeof coverage.ambientPodCount === 'number' ? coverage.ambientPodCount : null;
    const ambSuffix = coverage.ambient
      ? amb === null
        ? '; ambient pods alongside are enforced by ztunnel'
        : `; ${amb} ambient pod(s) alongside are enforced by ztunnel`
      : '';
    // A namespace-attributed join may not describe the pods this row selects. The two extremes
    // still carry over — a subset of a fully-meshed namespace is fully meshed, and a subset of a
    // namespace with no sidecar at all has no sidecar either — but the middle must not be
    // reported as if the figure were the row's own.
    const viaNamespace = coverage.attribution === 'namespace';
    const where = viaNamespace ? `namespace ${coverage.namespace || '(unnamed)'}` : 'scope';
    if (coverage.inMeshCount === 0) {
      return {
        label: 'STRICT',
        tone: 'bad',
        note: viaNamespace
          ? `declared only — no pod in ${where} carries a sidecar, so nothing enforces it${ambSuffix}`
          : `declared only — 0 of ${coverage.podCount} pods carry a sidecar, so nothing enforces it${ambSuffix}`
      };
    }
    if (coverage.inMeshCount < coverage.podCount) {
      return {
        label: 'STRICT',
        tone: 'warn',
        note: viaNamespace
          ? `${where} has ${coverage.inMeshCount} of ${coverage.podCount} pods with a sidecar; which of them this policy selects is not reported${ambSuffix}`
          : `${coverage.inMeshCount} of ${coverage.podCount} pods carry a sidecar; the rest are outside the mesh${ambSuffix}`
      };
    }
    return {
      label: 'STRICT',
      tone: 'ok',
      note: viaNamespace
        ? `every pod in ${where} carries a sidecar${ambSuffix}`
        : ambSuffix
          ? ambSuffix.replace(/^; /, '')
          : null
    };
  }

  if (mode === 'PERMISSIVE') {
    if (modeSource === DEFAULT_MODE_SOURCE) {
      return {
        label: 'PERMISSIVE (unset)',
        tone: 'unknown',
        note: "no PeerAuthentication sets a mode at any scope — this is Istio's default, not a choice anybody made"
      };
    }
    return { label: 'PERMISSIVE', tone: 'warn', note: 'plaintext is accepted alongside mTLS' };
  }

  if (mode === 'DISABLE') {
    return { label: 'DISABLE', tone: 'bad', note: 'mTLS is switched off for this scope' };
  }

  return { label: mode || 'not reported', tone: 'unknown', note: null };
}

export interface PortOverride {
  port: string;
  mode: string;
}

/**
 * The `portOverrides` entries that contradict the row's top-level mode. Entries equal to the
 * top-level mode are `portLevelMtls` blocks that merely restate it and are not a surprise.
 * Ports sort numerically so 80 precedes 9090.
 */
export function portOverrideMarkers(
  portOverrides: Record<string, string> | null | undefined,
  topMode: string
): PortOverride[] {
  if (!portOverrides) return [];
  return Object.entries(portOverrides)
    .filter(([, mode]) => typeof mode === 'string' && mode !== topMode)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([port, mode]) => ({ port, mode }));
}

/** The tone for the port-override marker: the weakest mode among the overrides decides. */
export function portOverrideTone(overrides: PortOverride[]): MtlsTone {
  if (overrides.length === 0) return 'unknown';
  if (overrides.some(o => o.mode === 'DISABLE')) return 'bad';
  if (overrides.some(o => o.mode === 'PERMISSIVE')) return 'warn';
  return 'accent';
}

/**
 * The fleet sidecar coverage figure. The collector already computed it over *meshable* pods and
 * publishes `null` when there are none (`mesh.js`); re-deriving it in the browser with a
 * `Math.max(1, …)` denominator turns that null into a confident `0%`. So this relays, and only
 * falls back to a count-based derivation when the collector's own field is absent from an older
 * payload — and even then returns `null` rather than inventing a denominator.
 */
export function fleetCoverage(
  coverage: { coveragePercent?: number | null; byDeployment?: { ambient: boolean; inMeshCount: number; podCount: number }[] | null } | null | undefined
): number | null {
  if (!coverage) return null;
  if (typeof coverage.coveragePercent === 'number') return coverage.coveragePercent;
  if (coverage.coveragePercent === null) return null;
  const rows = coverage.byDeployment || [];
  const meshable = rows.filter(d => !d.ambient);
  const denominator = meshable.reduce((n, d) => n + d.podCount, 0);
  if (denominator === 0) return null;
  const numerator = meshable.reduce((n, d) => n + d.inMeshCount, 0);
  return Math.round((numerator / denominator) * 100);
}

interface CoverageRow {
  namespace: string;
  ambient: boolean;
  inMeshCount: number;
  podCount: number;
}

/**
 * Per-namespace coverage, summed from the per-workload rows — the same aggregation the collector
 * does for its AuthorizationPolicy verdict. Summing counts is not re-deriving a suppressed null:
 * the counts are facts in the payload. `null` in stays `null` out. Ambient rows are summed into
 * `ambientPodCount`, never into `podCount`: a sidecar percentage over an ambient workload is not a
 * meaningful number (the collector suppresses it too).
 */
export function coverageByNamespace(rows: CoverageRow[] | null | undefined): Map<string, CoverageJoin> | null {
  if (!rows) return null;
  const map = new Map<string, CoverageJoin>();
  for (const r of rows) {
    const e =
      map.get(r.namespace) ||
      ({ inMeshCount: 0, podCount: 0, ambient: false, ambientPodCount: 0, namespace: r.namespace, attribution: 'scope' } as CoverageJoin);
    if (r.ambient) {
      e.ambient = true;
      e.ambientPodCount = (e.ambientPodCount || 0) + r.podCount;
    } else {
      e.inMeshCount += r.inMeshCount;
      e.podCount += r.podCount;
    }
    map.set(r.namespace, e);
  }
  return map;
}

/**
 * The mesh-wide coverage join. Sidecar counts cover the meshable (non-ambient) workloads; the
 * ambient ones are counted separately so an all-ambient cluster reads "enforced by ztunnel" rather
 * than the old "no pods in scope", which asserted an emptiness that the filter itself created.
 */
export function meshWideCoverage(rows: CoverageRow[] | null | undefined): CoverageJoin | null {
  if (!rows) return null;
  const meshable = rows.filter(r => !r.ambient);
  const ambientRows = rows.filter(r => r.ambient);
  return {
    inMeshCount: meshable.reduce((n, r) => n + r.inMeshCount, 0),
    podCount: meshable.reduce((n, r) => n + r.podCount, 0),
    ambient: ambientRows.length > 0,
    ambientPodCount: ambientRows.reduce((n, r) => n + r.podCount, 0),
    attribution: 'scope'
  };
}

/**
 * The coverage a verdict should be judged against: its own namespace for a namespace- or
 * workload-scoped verdict, the mesh-wide aggregate for the mesh verdict. A namespace with no
 * rows at all is `{0,0}` — "no pods in scope", which reads unknown, not green.
 *
 * A workload-scoped verdict gets its namespace's join marked `attribution: 'namespace'`, because
 * the payload has no join between a label selector and the owner-name coverage rows. The marker is
 * what stops the note claiming a namespace figure describes the selected pods.
 */
export function coverageForVerdict(
  scope: string,
  namespace: string,
  byNamespace: Map<string, CoverageJoin> | null,
  meshWide: CoverageJoin | null
): CoverageJoin | null {
  if (scope === 'mesh') return meshWide;
  if (!byNamespace) return null;
  const join =
    byNamespace.get(namespace) ||
    ({ inMeshCount: 0, podCount: 0, ambient: false, ambientPodCount: 0, namespace } as CoverageJoin);
  if (scope === 'workload') return { ...join, namespace, attribution: 'namespace' };
  return { ...join, namespace, attribution: 'scope' };
}

/**
 * The caption for a count that came off a read which may have been refused. A refused read is
 * never 0 — `null` in, "not reported" out.
 */
export function alongsideCaption(count: number | null | undefined, noun: string): string {
  if (typeof count !== 'number') return `${noun} count not reported`;
  return `${count} ${noun}(s) alongside`;
}
