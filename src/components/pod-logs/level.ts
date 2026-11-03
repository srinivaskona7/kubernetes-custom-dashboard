/**
 * The log viewer's level filter, and the honest part of it.
 *
 * `LogLine.level` is one of `fatal | error | warn | debug | null`, assigned by the server from the
 * line's own text. **`null` is not `info`** — it means nothing in the line identified a level, which
 * is the overwhelming majority of real output: an Envoy access-log record, a `console.log`, a bare
 * stack-trace continuation line. So a severity floor cannot silently drop them and call the result
 * "warn and worse"; it has to say how many lines it set aside.
 *
 * That is the whole reason this is a module with tests rather than three lines in a component. The
 * naive version (`lines.filter(l => RANK[l.level] >= floor)`) is correct code that produces a
 * dishonest screen: pick "errors only" on an approuter and you get an empty pane that looks like
 * "no errors" when it actually means "2,000 unclassified lines were hidden".
 */
import type { LogLine } from '../../api';

/** The floors the control offers, coarsest last. */
export type LevelFloor = 'all' | 'warn' | 'error';

export const LEVEL_FLOORS: { id: LevelFloor; label: string }[] = [
  { id: 'all', label: 'all levels' },
  { id: 'warn', label: 'warn and worse' },
  { id: 'error', label: 'errors only' }
];

export const DEFAULT_LEVEL_FLOOR: LevelFloor = 'all';

export function isLevelFloor(v: string | null): v is LevelFloor {
  return v === 'all' || v === 'warn' || v === 'error';
}

/**
 * Severity rank. `debug` is below every floor above `all`, which is deliberate: a floor exists to
 * remove noise, and debug output is noise by definition.
 */
const RANK: Record<NonNullable<LogLine['level']>, number> = { debug: 0, warn: 2, error: 3, fatal: 4 };
const FLOOR_RANK: Record<LevelFloor, number> = { all: -1, warn: 2, error: 3 };

/**
 * Does this line clear the floor?
 *
 * An unclassified line clears `all` and nothing else. It is not promoted to "probably info" — the
 * console does not invent a level the server did not find.
 */
export function passesLevel(level: LogLine['level'], floor: LevelFloor): boolean {
  if (floor === 'all') return true;
  if (level === null) return false;
  return RANK[level] >= FLOOR_RANK[floor];
}

export interface LevelSplit<T> {
  kept: T[];
  /** Lines the floor removed *because they carry no level*, not because they were too quiet. */
  unclassified: number;
}

/**
 * Apply the floor and report what it cost.
 *
 * The caller renders `unclassified` next to the line count, so "0 of 2,000 lines · 1,987
 * unclassified" reads as what it is — a filter that cannot see most of this container's output —
 * rather than as a clean bill of health.
 */
export function splitByLevel<T extends { level: LogLine['level'] }>(
  lines: readonly T[],
  floor: LevelFloor
): LevelSplit<T> {
  if (floor === 'all') return { kept: [...lines], unclassified: 0 };
  const kept: T[] = [];
  let unclassified = 0;
  for (const l of lines) {
    if (passesLevel(l.level, floor)) kept.push(l);
    else if (l.level === null) unclassified += 1;
  }
  return { kept, unclassified };
}
