import { describe, expect, it } from 'vitest';
import {
  matchesNamespace,
  namespaceLabel,
  namespaceTitle,
  namespacesOf,
  pruneNamespaces,
  resultLine,
  searchNamespaces,
  toggleNamespace
} from './namespace-filter';

const rows = [
  { name: 'a', namespace: 'applecare' },
  { name: 'b', namespace: 'istio-system' },
  { name: 'c', namespace: 'applecare' },
  { name: 'd', namespace: 'kyma-system' }
];

describe('namespacesOf', () => {
  it('returns each namespace once, sorted', () => {
    expect(namespacesOf(rows, r => r.namespace)).toEqual(['applecare', 'istio-system', 'kyma-system']);
  });

  it('drops null, undefined and empty — a cluster-scoped row is not a namespace option', () => {
    const mixed = [{ ns: 'a' }, { ns: null }, { ns: undefined }, { ns: '' }, { ns: 'a' }];
    expect(namespacesOf(mixed, r => r.ns)).toEqual(['a']);
  });

  it('returns an empty list for no rows, rather than throwing', () => {
    expect(namespacesOf([], (r: { ns: string }) => r.ns)).toEqual([]);
  });
});

describe('matchesNamespace', () => {
  it('an empty selection admits everything — the default state is not a filter', () => {
    expect(matchesNamespace('applecare', new Set())).toBe(true);
    expect(matchesNamespace(null, new Set())).toBe(true);
  });

  it('a single selection admits only that namespace', () => {
    const sel = new Set(['applecare']);
    expect(matchesNamespace('applecare', sel)).toBe(true);
    expect(matchesNamespace('istio-system', sel)).toBe(false);
  });

  it('several selections are OR, not AND', () => {
    const sel = new Set(['applecare', 'istio-system']);
    expect(matchesNamespace('applecare', sel)).toBe(true);
    expect(matchesNamespace('istio-system', sel)).toBe(true);
    expect(matchesNamespace('kyma-system', sel)).toBe(false);
  });

  it('a cluster-scoped row survives any selection — no namespace can exclude it', () => {
    const sel = new Set(['applecare']);
    expect(matchesNamespace(null, sel)).toBe(true);
    expect(matchesNamespace(undefined, sel)).toBe(true);
    expect(matchesNamespace('', sel)).toBe(true);
  });

  it('composes with a type filter without either losing rows the other kept', () => {
    const all = [
      { kind: 'Deployment', ns: 'applecare' },
      { kind: 'Deployment', ns: 'istio-system' },
      { kind: 'Pod', ns: 'applecare' },
      { kind: 'ClusterRole', ns: null }
    ];
    const sel = new Set(['applecare']);
    const out = all.filter(r => r.kind === 'Deployment').filter(r => matchesNamespace(r.ns, sel));
    // The spec's own example: Deployments + Namespace=applecare is exactly one row.
    expect(out).toEqual([{ kind: 'Deployment', ns: 'applecare' }]);
  });
});

describe('searchNamespaces', () => {
  const all = ['applecare', 'istio-system', 'kyma-system'];

  it('returns everything for an empty or whitespace search', () => {
    expect(searchNamespaces(all, '')).toEqual(all);
    expect(searchNamespaces(all, '   ')).toEqual(all);
  });

  it('matches a substring anywhere, case-insensitively', () => {
    expect(searchNamespaces(all, 'SYSTEM')).toEqual(['istio-system', 'kyma-system']);
    expect(searchNamespaces(all, 'care')).toEqual(['applecare']);
  });

  it('returns an empty list rather than everything when nothing matches', () => {
    expect(searchNamespaces(all, 'zzz')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const copy = [...all];
    searchNamespaces(all, 'sys');
    expect(all).toEqual(copy);
  });
});

describe('toggleNamespace', () => {
  it('adds one that is absent and removes one that is present', () => {
    expect([...toggleNamespace(new Set(), 'a')]).toEqual(['a']);
    expect([...toggleNamespace(new Set(['a']), 'a')]).toEqual([]);
  });

  it('returns a NEW Set — a mutated Set would not re-render', () => {
    const before = new Set(['a']);
    const after = toggleNamespace(before, 'b');
    expect(after).not.toBe(before);
    expect([...before]).toEqual(['a']);
  });
});

describe('pruneNamespaces', () => {
  it('drops a selection that is no longer an option', () => {
    const out = pruneNamespaces(new Set(['applecare', 'gone']), ['applecare', 'istio-system']);
    expect([...out]).toEqual(['applecare']);
  });

  it('returns the SAME instance when nothing changed, so a useMemo does not loop', () => {
    const sel = new Set(['applecare']);
    expect(pruneNamespaces(sel, ['applecare', 'istio-system'])).toBe(sel);
  });

  it('returns the same empty instance untouched', () => {
    const sel = new Set<string>();
    expect(pruneNamespaces(sel, ['a'])).toBe(sel);
  });

  it('can prune to empty, which is "all" again rather than "nothing"', () => {
    const out = pruneNamespaces(new Set(['gone']), ['applecare']);
    expect(out.size).toBe(0);
    expect(matchesNamespace('applecare', out)).toBe(true);
  });
});

describe('namespaceLabel', () => {
  it('says All namespaces for an empty selection', () => {
    expect(namespaceLabel(new Set())).toBe('All namespaces');
  });

  it('names a single selection in full — the name is the answer', () => {
    expect(namespaceLabel(new Set(['applecare']))).toBe('applecare');
  });

  it('counts two or more, because three long names do not fit a toolbar button', () => {
    expect(namespaceLabel(new Set(['applecare', 'istio-system']))).toBe('2 namespaces');
    expect(namespaceLabel(new Set(['a', 'b', 'c']))).toBe('3 namespaces');
  });
});

describe('namespaceTitle', () => {
  it('states the option count when nothing is selected', () => {
    expect(namespaceTitle(new Set(), 3)).toContain('3 appear');
  });

  it('says there is nothing to filter by when no namespace appears at all', () => {
    expect(namespaceTitle(new Set(), 0)).toContain('nothing to filter by');
  });

  it('resolves the count in namespaceLabel by listing every selected name', () => {
    const t = namespaceTitle(new Set(['istio-system', 'applecare']), 3);
    expect(t).toContain('applecare, istio-system');
    expect(t).toContain('2 of 3');
  });

  it('always says cluster-scoped rows stay visible, so their presence is never a surprise', () => {
    expect(namespaceTitle(new Set(['applecare']), 3)).toContain('Cluster-scoped rows');
  });
});

describe('resultLine', () => {
  it('prints a bare total when nothing is filtered out', () => {
    expect(resultLine(12, 12, 'pods')).toBe('12 pods');
  });

  it('prints "of" when rows are hidden — a count that shrank silently reads as a failed read', () => {
    expect(resultLine(3, 12, 'pods')).toBe('3 of 12 pods');
  });

  it('groups thousands, because a six-figure pod count is unreadable otherwise', () => {
    expect(resultLine(1234, 12345, 'rows')).toBe('1,234 of 12,345 rows');
  });
});
