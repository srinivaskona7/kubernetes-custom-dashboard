/** The Overview tiles' stats: what the bar and legend draw from the server's `stats`. */
import { describe, expect, it } from 'vitest';
import type { StatTone } from '../../api';
import { STAT_FILL, barLabel, headlinePart, legendParts } from './tile-stats';

const split = (parts: Array<[string, number, StatTone]>) => ({
  total: parts.reduce((n, p) => n + p[1], 0),
  parts: parts.map(([key, count, tone]) => ({ key, label: key, count, tone }))
});

describe('legendParts', () => {
  it('lists every non-zero part, in the server order', () => {
    const s = split([['running', 116, 'ok'], ['pending', 2, 'warn'], ['failed', 0, 'bad'], ['succeeded', 1, 'neutral']]);
    expect(legendParts(s).map(p => p.key)).toEqual(['running', 'pending', 'succeeded']);
  });

  it('keeps the first part even at zero, so an all-bad bar still says how many are fine', () => {
    const s = split([['ready', 0, 'ok'], ['notReady', 3, 'bad']]);
    expect(legendParts(s).map(p => [p.key, p.count])).toEqual([['ready', 0], ['notReady', 3]]);
  });
});

describe('barLabel', () => {
  it('names every drawn part for a screen reader', () => {
    expect(barLabel(split([['ready', 73, 'ok'], ['notReady', 2, 'bad']]))).toBe('73 ready, 2 notReady');
  });
});

describe('headlinePart', () => {
  it('reads an unread count as unavailable, never as 0', () => {
    expect(headlinePart({ count: null, label: 'pods' }, false)).toEqual({ text: 'pods unavailable', count: null, tone: null });
  });

  it('writes a denominator as "N of M"', () => {
    expect(headlinePart({ count: 2, of: 3, label: 'nodes ready', tone: 'bad' }, false)).toEqual({ text: 'of 3 nodes ready', count: '2', tone: 'bad' });
  });

  it('marks a count as a floor when the read was truncated', () => {
    expect(headlinePart({ count: 500, label: 'workloads' }, true).count).toBe('≥ 500');
  });
});

describe('STAT_FILL', () => {
  it('draws every tone from a theme token, never the brand violet', () => {
    for (const fill of Object.values(STAT_FILL)) expect(fill).not.toMatch(/accent/);
  });
});
