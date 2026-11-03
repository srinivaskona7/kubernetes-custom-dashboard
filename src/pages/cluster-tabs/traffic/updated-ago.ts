/**
 * How old the Traffic / Traces answer is, for the Proxies chip.
 *
 * Both routes may serve a body up to 10 minutes old while a background read replaces it
 * (srv/fleet/router.js, `TRAFFIC_MAX_AGE_MS`), and every body is dated by its oldest log read,
 * `collectedAt`. This turns that stamp into the chip's suffix. An unknown age says nothing: a
 * missing stamp printed as "updated 0 min ago" would claim a freshness nobody measured.
 */
export function updatedAgo(collectedAtIso: string | null | undefined, nowMs: number): string | undefined {
  if (!collectedAtIso) return undefined;
  const then = Date.parse(collectedAtIso);
  if (!Number.isFinite(then)) return undefined;
  // A stamp a little ahead of the browser's clock is skew, not the future.
  const age = Math.max(0, nowMs - then);
  if (age < 60_000) return 'updated just now';
  return `updated ${Math.floor(age / 60_000)} min ago`;
}
