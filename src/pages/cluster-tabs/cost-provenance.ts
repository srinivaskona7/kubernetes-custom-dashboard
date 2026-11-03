/**
 * The rules that qualify a dollar figure on the Cost tab, kept out of the JSX so they can be
 * unit-tested (fleet-ui's vitest runs `environment: 'node'` — there is no DOM here).
 *
 * Two rules live here, and both exist because a money figure with the wrong qualifier is worse
 * than no figure at all:
 *
 *   1. **One qualifier, every figure.** The server computes `costQualifier` once over the whole
 *      node set, and every dollar the tab prints — tiles, node rows, namespace rows, the idle row
 *      — goes through `qualifiedUsd`. A header reading "at least $4,102" above rows of exact
 *      dollars over the same data is the defect this file exists to prevent.
 *   2. **Provenance is not the word "built-in".** A rate card is judged by its region and its
 *      date. Where the built-in list genuinely has neither, the honest rendering says so — it does
 *      not fall silent, and it certainly does not imply the current month.
 */

/** As computed by `srv/fleet/collectors/cost.js`. */
export type CostQualifier = 'exact' | 'floor' | 'approximate' | 'approximate-floor';

/**
 * The prefix for a figure carrying this qualifier.
 *
 * `≥` only for a pure floor — every priced node had a stated rate, so the only missing money is
 * the money nobody could price, and the total really is a lower bound.
 *
 * `≈` as soon as one rate was derived from a node's shape: the derived per-unit rate sits above
 * some machine families and below others, so the error has no known direction and no bound can be
 * claimed. That is also why `approximate-floor` reads `≈` and not `≥` — with an unpriced node AND
 * a derived one, neither statement holds on its own; the caption carries the detail.
 */
export function qualifierPrefix(q: CostQualifier | null | undefined): string {
  switch (q) {
    case 'floor':
      return '≥';
    case 'approximate':
    case 'approximate-floor':
      return '≈';
    default:
      return '';
  }
}

/** Whole dollars by default: cents are false precision on a modelled number. */
export function usd(n: number | null | undefined, places = 0): string {
  if (n === null || n === undefined) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })}`;
}

/** A dollar figure with its qualifier. Null stays an em-dash — never `$0`. */
export function qualifiedUsd(n: number | null | undefined, q: CostQualifier | null | undefined, places = 0): string {
  if (n === null || n === undefined) return '—';
  return `${qualifierPrefix(q)}${usd(n, places)}`;
}

/** The same discipline for a fixed-decimal hourly figure. */
export function qualifiedHourlyUsd(n: number | null | undefined, q: CostQualifier | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${qualifierPrefix(q)}$${n.toFixed(2)}`;
}

/** What the headline tile says under the number, naming both kinds of doubt separately. */
export function qualifierCaption(
  q: CostQualifier | null | undefined,
  unpricedNodes: number | null | undefined,
  derivedRateNodes: number | null | undefined
): string {
  /*
    No `?? 0` here. This sentence exists to justify the qualifier on the number above it, so a
    count we do not have must not be printed as "0 nodes could not be priced at all" — that reads
    as a contradiction of the very qualifier it is explaining.
  */
  const unpriced = unpricedNodes ?? null;
  const derived = derivedRateNodes ?? null;
  const noRate =
    unpriced === null
      ? 'the number of nodes that could not be priced is not reported'
      : `${unpriced} node${unpriced === 1 ? '' : 's'} could not be priced at all`;
  const fromShape =
    derived === null
      ? 'an unreported number of nodes were priced from their shape, not from a stated rate'
      : `${derived} node${derived === 1 ? '' : 's'} priced from ${derived === 1 ? 'its' : 'their'} shape, not from a stated rate`;
  switch (q) {
    case 'floor':
      return `a floor — ${noRate}`;
    case 'approximate':
      return `an approximation — ${fromShape}`;
    case 'approximate-floor':
      return `${noRate}, and ${fromShape} — so this is neither exact nor a bound`;
    default:
      return 'per month, at list rate plus the Kyma management fee';
  }
}

/** The short pill beside the simulator's delta, or null when today's figure is unqualified. */
export function qualifierPillLabel(q: CostQualifier | null | undefined): string | null {
  switch (q) {
    case 'floor':
      return 'vs a floor';
    case 'approximate':
      return 'vs an approximation';
    case 'approximate-floor':
      return 'vs an unbounded approximation';
    default:
      return null;
  }
}

export interface RateCardProvenance {
  rateCard?: string | null;
  rateCardRegion?: string | null;
  rateCardRegionNote?: string | null;
  rateCardAsOf?: string | null;
  rateCardAsOfBasis?: string | null;
}

/**
 * The provenance sentence: where the rates came from, which region they are for, and when they
 * were recorded.
 *
 * No field is guessed. A missing region prints the server's own note (the built-in list has no
 * region dimension, and saying so is the correct rendering), and a missing date prints "no price
 * date recorded" rather than today's — an undated rate card is a real finding for an operator, not
 * something to paper over.
 */
export function rateCardProvenance(s: RateCardProvenance | null | undefined): string {
  const source = s?.rateCard ?? 'unknown source';
  const region = s?.rateCardRegion
    ? `region ${s.rateCardRegion}`
    : (s?.rateCardRegionNote ?? 'no region recorded');
  const asOf = s?.rateCardAsOf
    ? `rates as of ${s.rateCardAsOf}${s.rateCardAsOfBasis ? ` (${s.rateCardAsOfBasis})` : ''}`
    : 'no price date recorded, so their age is unknown';
  return `${source}; ${region}; ${asOf}`;
}

/**
 * What to print for the unrequested-capacity share when some namespace could not be weighed.
 *
 * A namespace with an unknown share used to contribute 0% to the claimed total, which pushed its
 * spend into this row and told the operator nobody was paying for it. While any such namespace
 * exists the remainder is unknown, and this is the sentence that says so.
 */
export function unattributedNote(n: number | null | undefined): string | null {
  /*
    `null` and absent are different facts. The collector sends `null` when attribution was not
    computed at all (the pod list half-failed), and that is a sentence an operator needs — not a
    silent nothing and certainly not `0 namespaces`. A field that is simply absent from an older
    payload carries no claim either way, so it stays silent.
  */
  if (n === null) {
    return 'attribution was not computed for this cluster, so how many namespaces could not be weighed is not reported — the unrequested remainder is not 0';
  }
  const count = n ?? 0;
  if (count <= 0) return null;
  return `${count} namespace${count === 1 ? '' : 's'} could not be weighed against cluster allocatable, so the unrequested remainder is not known — it is not 0, and their spend is not idle`;
}
