/**
 * The level floor, tested for the one thing it must never do: promote an unclassified line.
 *
 * The dishonest screen this module exists to prevent is "errors only" over 2,000 unclassified lines
 * rendering as an empty pane. Two properties make that impossible, and both are asserted here — an
 * unclassified line clears `all` and nothing else, and the count of what a floor set aside is
 * reported rather than dropped.
 */
import { describe, expect, it } from 'vitest';
import type { LogLine } from '../../api';
import {
  DEFAULT_LEVEL_FLOOR,
  LEVEL_FLOORS,
  isLevelFloor,
  passesLevel,
  splitByLevel,
  type LevelFloor
} from './level';

const line = (level: LogLine['level'], text = 'x'): { level: LogLine['level']; text: string } => ({ level, text });

describe('the floors on offer', () => {
  it('defaults to showing everything', () => {
    expect(DEFAULT_LEVEL_FLOOR).toBe('all');
    expect(LEVEL_FLOORS[0]!.id).toBe('all');
  });

  it('offers exactly the three floors the type allows', () => {
    expect(LEVEL_FLOORS.map(f => f.id)).toEqual(['all', 'warn', 'error']);
  });

  it('accepts only a real floor from a URL parameter', () => {
    for (const f of LEVEL_FLOORS) expect(isLevelFloor(f.id)).toBe(true);
    expect(isLevelFloor('info')).toBe(false);
    expect(isLevelFloor('ERROR')).toBe(false);
    expect(isLevelFloor('')).toBe(false);
    expect(isLevelFloor(null)).toBe(false);
  });
});

describe('passesLevel', () => {
  it('lets every line through at the all floor, including the unclassified ones', () => {
    for (const l of ['fatal', 'error', 'warn', 'debug', null] as LogLine['level'][]) {
      expect(passesLevel(l, 'all')).toBe(true);
    }
  });

  it('never promotes an unclassified line to info', () => {
    expect(passesLevel(null, 'warn')).toBe(false);
    expect(passesLevel(null, 'error')).toBe(false);
  });

  it('treats debug as below every floor above all', () => {
    expect(passesLevel('debug', 'warn')).toBe(false);
    expect(passesLevel('debug', 'error')).toBe(false);
  });

  it('keeps warn and worse at the warn floor', () => {
    expect(passesLevel('warn', 'warn')).toBe(true);
    expect(passesLevel('error', 'warn')).toBe(true);
    expect(passesLevel('fatal', 'warn')).toBe(true);
  });

  it('keeps error and fatal — but not warn — at the error floor', () => {
    expect(passesLevel('warn', 'error')).toBe(false);
    expect(passesLevel('error', 'error')).toBe(true);
    expect(passesLevel('fatal', 'error')).toBe(true);
  });
});

describe('splitByLevel', () => {
  const lines = [line('fatal'), line('error'), line('warn'), line('debug'), line(null), line(null)];

  it('at the all floor keeps everything and reports nothing set aside', () => {
    const split = splitByLevel(lines, 'all');
    expect(split.kept).toHaveLength(6);
    expect(split.unclassified).toBe(0);
  });

  it('counts only the lines removed for having no level, not the quiet ones', () => {
    const split = splitByLevel(lines, 'error');
    expect(split.kept.map(l => l.level)).toEqual(['fatal', 'error']);
    // warn and debug were removed too, but they are classified — they are not part of this count.
    expect(split.unclassified).toBe(2);
  });

  it('reports the whole stream as unclassified when nothing carries a level', () => {
    const split = splitByLevel([line(null), line(null), line(null)], 'warn');
    expect(split.kept).toEqual([]);
    expect(split.unclassified).toBe(3);
    // The specific dishonest screen: an empty pane that would read as "no warnings".
    expect(split.kept.length === 0 && split.unclassified > 0).toBe(true);
  });

  it('preserves order among the kept lines', () => {
    const split = splitByLevel([line('error', 'a'), line(null, 'b'), line('warn', 'c'), line('error', 'd')], 'warn');
    expect(split.kept.map(l => l.text)).toEqual(['a', 'c', 'd']);
  });

  it('returns a copy at the all floor, so the caller cannot mutate the stream', () => {
    const stream = [line('error')];
    const split = splitByLevel(stream, 'all');
    split.kept.push(line('warn'));
    expect(stream).toHaveLength(1);
  });

  it('handles an empty stream at every floor', () => {
    for (const floor of LEVEL_FLOORS.map(f => f.id) as LevelFloor[]) {
      expect(splitByLevel([], floor)).toEqual({ kept: [], unclassified: 0 });
    }
  });
});
