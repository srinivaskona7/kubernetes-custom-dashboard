/**
 * Traces time range. The read is a tail of each proxy's access log, so a range narrows the tail
 * (`sinceSeconds`) and never widens it: there is no store behind it, so no 7-day or custom range.
 */
export const TIME_RANGES = [
  { id: 'tail', label: 'Whole tail', seconds: null },
  { id: '15m', label: 'Last 15 minutes', seconds: 900 },
  { id: '1h', label: 'Last 1 hour', seconds: 3600 },
  { id: '6h', label: 'Last 6 hours', seconds: 21600 },
  { id: '24h', label: 'Last 24 hours', seconds: 86400 }
] as const;

export function sinceOf(id: string): number | undefined {
  const r = TIME_RANGES.find(x => x.id === id);
  return r && r.seconds !== null ? r.seconds : undefined;
}

export function rangeNote(id: string, tailLines: number): string {
  const r = TIME_RANGES.find(x => x.id === id) ?? TIME_RANGES[0];
  return `${r.label}, within the last ${tailLines} lines per proxy`;
}

export function readStamp(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const hhmm = new Date(t).toISOString().slice(11, 16);
  const mins = Math.max(Math.round((now - t) / 60000), 0);
  return `Read at ${hhmm} UTC${mins > 0 ? ` (${mins} min ago)` : ''}`;
}
