/**
 * A card header carries one short line; everything longer is one hover away (spec 2026-09-27,
 * "Answer, not prose"). The first sentence stays when it fits, so the header still says what the
 * card is; the tip always carries the whole text, so nothing is lost.
 */
export const HINT_MAX = 90;

export function splitHint(hint: string | undefined, max = HINT_MAX): { line: string | null; tip: string | null } {
  const text = (hint ?? '').trim();
  if (!text) return { line: null, tip: null };
  if (text.length <= max) return { line: text, tip: null };
  // A sentence ends at ". " followed by a capital, so "1.2 s" and "e.g. x" never end one.
  const m = /^(.*?[.!?])\s+(?=[A-Z])/.exec(text);
  const first = m ? m[1] : null;
  return { line: first && first.length <= max ? first : null, tip: text };
}
