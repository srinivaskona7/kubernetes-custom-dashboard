/**
 * The Overview tiles' stats, as drawn: which legend entries show, what the bar says to a screen
 * reader, how one headline count reads. The numbers are the server's (`STATS` in
 * srv/fleet/signals.js); nothing here counts.
 */
import type { StatTone, TileStats } from '../../api';

type Split = NonNullable<TileStats['split']>;
type Part = Split['parts'][number];

/** Bar and dot fills. Status tones only: violet is the brand, never a status. */
export const STAT_FILL: Record<StatTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  neutral: 'bg-line-strong',
  unknown: 'bg-unknown'
};

/**
 * Non-zero parts, plus the first (the healthy state) at any count: "0 ready · 3 not ready" says
 * what "3 not ready" alone leaves to be inferred.
 */
export function legendParts(split: Split): Part[] {
  return split.parts.filter((p, i) => i === 0 || p.count > 0);
}

export function barLabel(split: Split): string {
  return split.parts.filter(p => p.count > 0).map(p => `${p.count} ${p.label}`).join(', ');
}

/**
 * One headline count as `{count, text}` so the number can be set in mono. An unread count reads
 * "pods unavailable" with no number at all; a truncated read prefixes `≥`.
 */
export function headlinePart(
  h: TileStats['headline'][number],
  atLeast: boolean
): { count: string | null; text: string; tone: 'bad' | 'warn' | null } {
  if (h.count === null) return { count: null, text: `${h.label} unavailable`, tone: null };
  const count = `${atLeast ? '≥ ' : ''}${h.count}`;
  const text = h.of !== undefined && h.of !== null ? `of ${h.of} ${h.label}` : h.label;
  return { count, text, tone: h.tone ?? null };
}
