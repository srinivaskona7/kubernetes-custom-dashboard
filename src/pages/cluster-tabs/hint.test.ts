import { describe, expect, it } from 'vitest';
import { HINT_MAX, splitHint } from './hint';

describe('splitHint', () => {
  it('keeps a short hint inline with no tip', () => {
    expect(splitHint('Most severe first.')).toEqual({ line: 'Most severe first.', tip: null });
  });
  it('keeps exactly 90 characters inline', () => {
    const s = 'x'.repeat(HINT_MAX);
    expect(splitHint(s)).toEqual({ line: s, tip: null });
  });
  it('shows the first sentence and moves the whole text to the tip', () => {
    const s = 'One row per distinct failure. The same code, host, path and upstream, however many times it hit in the window read.';
    expect(splitHint(s)).toEqual({ line: 'One row per distinct failure.', tip: s });
  });
  it('never splits inside a number', () => {
    const s = 'p95 is 1.2 s over the window read, which is a long sentence that runs well past ninety characters in total.';
    expect(splitHint(s).line).toBeNull();
    expect(splitHint(s).tip).toBe(s);
  });
  it('drops the line when the first sentence alone is too long', () => {
    const s = `${'word '.repeat(25)}end. Second.`;
    expect(splitHint(s)).toEqual({ line: null, tip: s });
  });
  it('treats empty and missing hints as nothing', () => {
    expect(splitHint(undefined)).toEqual({ line: null, tip: null });
    expect(splitHint('  ')).toEqual({ line: null, tip: null });
  });
});
