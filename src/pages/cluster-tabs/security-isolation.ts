/**
 * What "NetworkPolicy isolation" is allowed to say.
 *
 * The tile used to draw a filled bar and an `N%`. The number behind it
 * (`summary.networkPolicyIsolationScore`) is the fraction of app namespaces holding *at least
 * one* NetworkPolicy, which is the weaker of the two claims the collector reports, and it was
 * `100` when there were no app namespaces at all — a green full bar for a cluster nothing was
 * audited on. The bar also hid which of the two counts it drew.
 *
 * So the rendering is the two counts themselves, and no percentage is derived here at all: a tile
 * that prints `12 of 18` cannot be read as a green bar, and there is nothing to clamp. When a count
 * is missing the tile says so, and says *which* of the two reasons applies. JSX-free on purpose:
 * the rule is unit-tested here, because `app/fleet-ui` vitest runs `environment: 'node'`.
 */

export interface IsolationSummaryLike {
  /** App (non-system) namespaces the collector actually walked. The denominator. */
  appNamespacesAudited?: number;
  /** Namespaces holding at least one NetworkPolicy — "has a policy", the weaker claim. */
  networkPolicyProtectedNamespaces?: number;
  /**
   * Namespaces where both directions are covered by an all-pods selector. Optional: a server
   * predating the field reports nothing, which is not the same as zero.
   */
  networkPolicyFullyIsolatedNamespaces?: number;
}

export interface IsolationRendering {
  /** e.g. `12 of 18 namespaces have a NetworkPolicy`, or null when there is no denominator. */
  coverage: string | null;
  /** e.g. `4 deny an unlabelled pod in both directions`, or null when the server omits it. */
  isolated: string | null;
  /**
   * Why `coverage` is null, because the two reasons are not the same claim and the tile used to
   * print the zero-namespace explanation for both:
   *  - `nothing-audited`: the denominator is present and 0. There genuinely is no ratio.
   *  - `not-reported`: the denominator or the numerator is absent from this response, so whether
   *    there is a ratio is unknown.
   * `null` when `coverage` is present.
   */
  coverageAbsence: 'nothing-audited' | 'not-reported' | null;
  /**
   * True when a read behind the ratio was cut short. A truncated ratio is not even a floor: the
   * numerator and the denominator can each be short, so it can move in either direction.
   */
  ratioUnstable: boolean;
}

/** The two causes, in the words the tile shows. Exported so the tooltip cannot drift from the code. */
export const ISOLATION_NOTHING_AUDITED_WHY =
  'No app namespaces were audited on this cluster, so there is no ratio to report. This is not 100%.';

export const ISOLATION_NOT_REPORTED_WHY =
  'This server did not report the namespace counts behind the ratio, so whether there is coverage is unknown. This is neither 0% nor 100%.';

/** The sentence under the truncation marker. Exported so the test pins the exact words. */
export const RATIO_UNSTABLE_WHY =
  'A read behind this ratio stopped at the paging ceiling, so it is not even a floor — the numerator and the denominator can each be short, and the ratio can move in either direction.';

/** What the tab may claim from `policyTypes` and `podSelector` alone. */
export const ISOLATION_METHOD_WHY =
  'Read from each policy\'s policyTypes and podSelector only. "Both directions" means every pod in the namespace is governed in both directions; the allow rules inside each policy are not evaluated, so no individual connection is proven blocked.';

export function isolationRendering(
  summary: IsolationSummaryLike | undefined | null,
  opts: { truncated?: boolean } = {}
): IsolationRendering {
  const audited = summary?.appNamespacesAudited;
  const holding = summary?.networkPolicyProtectedNamespaces;
  const fully = summary?.networkPolicyFullyIsolatedNamespaces;
  const ratioUnstable = opts.truncated === true;

  const hasDenominator = typeof audited === 'number' && audited > 0;
  const hasNumerator = typeof holding === 'number';
  const denominatorIsZero = audited === 0;

  return {
    coverage: hasDenominator && hasNumerator
      ? `${holding} of ${audited} namespaces have a NetworkPolicy`
      : null,
    isolated: typeof fully === 'number'
      ? `${fully} deny an unlabelled pod in both directions`
      : null,
    coverageAbsence: hasDenominator && hasNumerator
      ? null
      : denominatorIsZero
        ? 'nothing-audited'
        : 'not-reported',
    ratioUnstable
  };
}
