import { describe, expect, it } from 'vitest';
import { jsonPathLines, valueDiffMarks } from './code-compare';

describe('structured value-diff navigation', () => {
  const before = JSON.stringify({ global: { image: { tag: '1.0.0' }, retired: true }, ports: [80, 443] }, null, 2);
  const after = JSON.stringify({ global: { image: { tag: '1.1.0' }, enabled: true }, ports: [80, 8080, 443] }, null, 2);
  const delta = { added: ['global.enabled'], removed: ['global.retired'], changed: ['global.image.tag', 'ports'] };

  it('finds a nested JSON value by its dotted Helm path', () => {
    expect(jsonPathLines(before).get('global.image.tag')).toBe(3);
    expect(jsonPathLines(before).get('ports')).toBe(7);
  });

  it('marks removals only on the old side, additions only on the new side, and edits on both', () => {
    expect(valueDiffMarks(before, delta, 'left')).toEqual([
      { path: 'global.retired', line: 5, tone: 'removed' },
      { path: 'global.image.tag', line: 3, tone: 'changed' },
      { path: 'ports', line: 7, tone: 'changed' }
    ]);
    expect(valueDiffMarks(after, delta, 'right')).toEqual([
      { path: 'global.enabled', line: 5, tone: 'added' },
      { path: 'global.image.tag', line: 3, tone: 'changed' },
      { path: 'ports', line: 7, tone: 'changed' }
    ]);
  });
});
