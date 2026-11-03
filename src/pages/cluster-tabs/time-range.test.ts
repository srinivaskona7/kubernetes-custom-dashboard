import { describe, expect, it } from 'vitest';
import { TIME_RANGES, rangeNote, readStamp, sinceOf } from './time-range';

describe('time range', () => {
  it('offers only what a log tail can answer', () => {
    expect(TIME_RANGES.map(r => r.id)).toEqual(['tail', '15m', '1h', '6h', '24h']);
    expect(sinceOf('1h')).toBe(3600);
    expect(sinceOf('tail')).toBeUndefined();
    expect(sinceOf('7d')).toBeUndefined();
  });
  it('says the window is bounded by the tail', () => {
    expect(rangeNote('1h', 300)).toBe('Last 1 hour, within the last 300 lines per proxy');
  });
  it('a live read says read at, never updated ago', () => {
    expect(readStamp('2026-09-28T10:04:00.000Z', Date.parse('2026-09-28T10:05:00.000Z'))).toMatch(/^Read at /);
    expect(readStamp(null, 0)).toBe('');
  });
});
