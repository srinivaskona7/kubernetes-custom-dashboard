import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { updatedAgo } from './updated-ago';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const before = (ms: number) => new Date(NOW - ms).toISOString();

describe('updatedAgo', () => {
  it('says just now under a minute', () => {
    expect(updatedAgo(before(0), NOW)).toBe('updated just now');
    expect(updatedAgo(before(59_999), NOW)).toBe('updated just now');
  });
  it('counts whole minutes from one', () => {
    expect(updatedAgo(before(60_000), NOW)).toBe('updated 1 min ago');
    expect(updatedAgo(before(3 * 60_000 + 40_000), NOW)).toBe('updated 3 min ago');
    expect(updatedAgo(before(10 * 60_000), NOW)).toBe('updated 10 min ago');
  });
  it('treats a stamp slightly ahead of the browser clock as just now, never negative', () => {
    expect(updatedAgo(before(-5_000), NOW)).toBe('updated just now');
  });
  it('says nothing for a missing or unparseable stamp, never "0 min ago"', () => {
    expect(updatedAgo(undefined, NOW)).toBeUndefined();
    expect(updatedAgo(null, NOW)).toBeUndefined();
    expect(updatedAgo('', NOW)).toBeUndefined();
    expect(updatedAgo('not a date', NOW)).toBeUndefined();
  });
});

describe('ProxiesChip renders the age', () => {
  // No DOM in this suite (jsdom is not installed), so the wiring is pinned in source, comments stripped.
  const src = readFileSync(new URL('./ProxiesRead.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const chip = src.slice(src.indexOf('export function ProxiesChip'), src.indexOf('export type ProxiesReadWindow'));
  it('takes an optional collectedAt and formats it with updatedAgo', () => {
    expect(chip).toMatch(/collectedAt\?: string/);
    expect(chip).toMatch(/updatedAgo\(collectedAt, now\)/);
    expect(chip).toMatch(/text-muted/);
  });
  it('re-renders on a 30s interval and clears it on unmount', () => {
    expect(chip).toMatch(/setInterval\([^;]*, 30_000\)/);
    expect(chip).toMatch(/return \(\) => clearInterval\(/);
  });
});
