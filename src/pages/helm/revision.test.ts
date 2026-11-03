/**
 * `diffValues` semantics — the first test in `app/fleet-ui`.
 *
 * ## Why this one, and why here
 *
 * vitest is configured in this package and, until now, had no test files. Installing jsdom is
 * blocked on this workstation (npm E401 against the internal registry), so no component can be
 * rendered here. `diffValues` needs no DOM: it is the pure function behind "3 added · 1 removed ·
 * 2 changed" on the History and Values panes, and those three numbers are the ones an operator
 * uses to decide whether a revision is worth investigating. A diff that miscounts is worse than
 * no diff, because it is trusted.
 *
 * Run with `npm test` inside `app/fleet-ui` (vitest, node environment — no DOM required).
 */
import { describe, expect, it } from 'vitest';
import { diffValues } from './revision';

describe('diffValues', () => {
  it('counts a leaf change once, not the lines around it', () => {
    const before = { image: { repository: 'app', tag: '1.0.0' }, replicas: 2 };
    const after = { image: { repository: 'app', tag: '1.1.0' }, replicas: 2 };

    expect(diffValues(before, after)).toEqual({ added: [], removed: [], changed: ['image.tag'] });
  });

  it('reports added and removed paths by their full dotted path', () => {
    const before = { a: { keep: 1, drop: 2 } };
    const after = { a: { keep: 1, gain: 3 } };

    expect(diffValues(before, after)).toEqual({
      added: ['a.gain'],
      removed: ['a.drop'],
      changed: []
    });
  });

  it('compares an array whole, so one insertion is one change and not a cascade', () => {
    // Index-wise comparison would report ports.1 and ports.2 as changed as well, which reads as
    // three unrelated edits when the operator made one.
    const before = { ports: [80, 443] };
    const after = { ports: [80, 8080, 443] };

    expect(diffValues(before, after)).toEqual({ added: [], removed: [], changed: ['ports'] });
  });

  it('treats a value replaced by a subtree as a removal plus additions', () => {
    const before = { auth: 'inline' };
    const after = { auth: { username: 'u', password: '[redacted]' } };

    expect(diffValues(before, after)).toEqual({
      added: ['auth.password', 'auth.username'],
      removed: ['auth'],
      changed: []
    });
  });

  it('distinguishes null, an empty string and a missing key', () => {
    // All three render as nothing on screen, and all three mean different things to a chart.
    expect(diffValues({ x: null }, { x: '' })).toEqual({ added: [], removed: [], changed: ['x'] });
    expect(diffValues({ x: null }, {})).toEqual({ added: [], removed: ['x'], changed: [] });
    expect(diffValues({}, { x: null })).toEqual({ added: ['x'], removed: [], changed: [] });
  });

  it('does not confuse a number with the string of that number', () => {
    // A chart that expects an integer and receives "2" behaves differently, so this is a change.
    expect(diffValues({ replicas: 2 }, { replicas: '2' })).toEqual({
      added: [],
      removed: [],
      changed: ['replicas']
    });
  });

  it('reports two identically masked values as unchanged — the caller must say so', () => {
    // CANARY of a real limitation, pinned so nobody "fixes" it into a false rotation signal: both
    // sides arrive already masked, so a rotated credential is invisible here. The panes that use
    // this carry REDACTION_NOTE for exactly that reason. It must never be papered over by making
    // masked values compare as different, which would report a change on every single diff.
    const before = { db: { password: '[redacted]' } };
    const after = { db: { password: '[redacted]' } };

    expect(diffValues(before, after)).toEqual({ added: [], removed: [], changed: [] });
  });

  it('returns every list sorted, so two runs of the same diff read identically', () => {
    const before = { z: 1, a: 1, m: 1 };
    const after = { z: 2, a: 2, m: 2 };

    expect(diffValues(before, after).changed).toEqual(['a', 'm', 'z']);
  });

  it('survives the empty and non-object cases the API can hand it', () => {
    expect(diffValues({}, {})).toEqual({ added: [], removed: [], changed: [] });
    // A release whose stored values were absent arrives as an empty object, never as undefined —
    // but a scalar at the root would flatten to nothing rather than throw.
    expect(diffValues(undefined, undefined)).toEqual({ added: [], removed: [], changed: [] });
    expect(diffValues('a', 'b')).toEqual({ added: [], removed: [], changed: [] });
  });
});
