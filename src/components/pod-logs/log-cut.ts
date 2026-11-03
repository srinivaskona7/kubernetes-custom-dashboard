/**
 * The words the log footer owes an operator when the read stopped short of the raw log.
 *
 * `srv/fleet/collectors/logs.js` computes two facts independent of `LogTail.truncated` (the
 * line-budget cut): `bytesTruncated`, the byte ceiling was reached, and `partialLinesDropped`,
 * how many lines the byte cut sliced through and had to discard rather than render as a
 * fragment. The footer used to read neither, so a pod whose log the client could not fully
 * bank looked identical to one that answered cleanly.
 *
 * Kubelet applies `tailLines` first and `limitBytes` second, and the byte ceiling keeps the *front*
 * of the already-tailed window: what survives is the oldest part of the tail, and what the cut
 * removes is the newest lines. That is why the footer says the *oldest* lines were kept, and why it
 * has to say so at all: the lines an operator most wants are the ones at the end. The proxy-log
 * readers close the same gap with `fetchCappedTail` in `srv/fleet/collectors/traffic.js`.
 */
export function logCutSentences(
  bytesTruncated: boolean | null | undefined,
  partialLinesDropped: number | null | undefined
): string[] {
  const out: string[] = [];
  if (bytesTruncated) out.push('output cut at the byte limit: oldest lines kept');
  if (partialLinesDropped) {
    out.push(`${partialLinesDropped} partial line${partialLinesDropped === 1 ? '' : 's'} dropped`);
  }
  return out;
}
