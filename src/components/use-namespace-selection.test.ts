import { describe, expect, it } from 'vitest';
import { parseNamespaceParam, serializeNamespaceParam } from './use-namespace-selection';

const options = ['acme-shop', 'istio-system', 'platform-system'];

describe('parseNamespaceParam', () => {
  it('a missing parameter is the empty selection, which means all namespaces', () => {
    expect(parseNamespaceParam(null, options).size).toBe(0);
  });

  it('an empty or comma-only value is also all namespaces, not a filter matching nothing', () => {
    expect(parseNamespaceParam('', options).size).toBe(0);
    expect(parseNamespaceParam(',,', options).size).toBe(0);
  });

  it('reads one namespace', () => {
    expect([...parseNamespaceParam('acme-shop', options)]).toEqual(['acme-shop']);
  });

  it('reads several, which is the OR selection', () => {
    const out = parseNamespaceParam('acme-shop,istio-system', options);
    expect(out.has('acme-shop')).toBe(true);
    expect(out.has('istio-system')).toBe(true);
    expect(out.has('platform-system')).toBe(false);
  });

  it('tolerates whitespace a human added by hand', () => {
    expect([...parseNamespaceParam(' acme-shop , istio-system ', options)].sort()).toEqual([
      'acme-shop',
      'istio-system'
    ]);
  });

  it('drops a namespace that no longer exists, so a stale link does not empty the table', () => {
    expect([...parseNamespaceParam('acme-shop,deleted-ns', options)]).toEqual(['acme-shop']);
  });

  it('drops every value when none exists, which reads as all namespaces rather than none', () => {
    expect(parseNamespaceParam('gone,also-gone', options).size).toBe(0);
  });

  it('passes the selection through untouched while the options are still unknown', () => {
    // The first render happens before the cluster payload arrives, so there are no options yet.
    // Narrowing against an empty list here would discard a selection from a shared link, and the
    // next write would persist that loss to the URL. "No options" means "not known yet".
    expect([...parseNamespaceParam('acme-shop,istio-system', [])].sort()).toEqual([
      'acme-shop',
      'istio-system'
    ]);
  });

  it('deduplicates a repeated value', () => {
    expect([...parseNamespaceParam('acme-shop,acme-shop', options)]).toEqual(['acme-shop']);
  });
});

describe('serializeNamespaceParam', () => {
  it('returns null for the empty selection, so the default leaves no trace in the URL', () => {
    expect(serializeNamespaceParam(new Set())).toBeNull();
  });

  it('writes one name plainly', () => {
    expect(serializeNamespaceParam(new Set(['acme-shop']))).toBe('acme-shop');
  });

  it('sorts, so two operators ticking the same pair in opposite orders share one URL', () => {
    expect(serializeNamespaceParam(new Set(['istio-system', 'acme-shop']))).toBe('acme-shop,istio-system');
    expect(serializeNamespaceParam(new Set(['acme-shop', 'istio-system']))).toBe('acme-shop,istio-system');
  });
});

describe('the two halves round-trip', () => {
  it('survives serialize then parse for every selection size', () => {
    for (const sel of [new Set<string>(), new Set(['acme-shop']), new Set(options)]) {
      const raw = serializeNamespaceParam(sel);
      const back = parseNamespaceParam(raw, options);
      expect([...back].sort()).toEqual([...sel].sort());
    }
  });
});
