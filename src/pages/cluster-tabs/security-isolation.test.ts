import { describe, it, expect } from 'vitest';
import {
  isolationRendering,
  ISOLATION_METHOD_WHY,
  ISOLATION_NOTHING_AUDITED_WHY,
  ISOLATION_NOT_REPORTED_WHY,
  RATIO_UNSTABLE_WHY
} from './security-isolation';

describe('NetworkPolicy isolation rendering', () => {
  it('prints the two counts the old bar hid', () => {
    const out = isolationRendering({
      appNamespacesAudited: 18,
      networkPolicyProtectedNamespaces: 12,
      networkPolicyFullyIsolatedNamespaces: 4
    });
    expect(out.coverage).toBe('12 of 18 namespaces have a NetworkPolicy');
    expect(out.isolated).toBe('4 deny an unlabelled pod in both directions');
    expect(out.coverageAbsence).toBeNull();
  });

  it('is null, never 100, when no app namespace was audited', () => {
    const out = isolationRendering({
      appNamespacesAudited: 0,
      networkPolicyProtectedNamespaces: 0,
      networkPolicyFullyIsolatedNamespaces: 0
    });
    expect(out.coverage).toBeNull();
    expect(out.coverageAbsence).toBe('nothing-audited');
  });

  it('separates "nothing to audit" from "this server did not report it"', () => {
    // Denominator present and zero: there genuinely is no ratio.
    expect(isolationRendering({ appNamespacesAudited: 0 }).coverageAbsence).toBe('nothing-audited');
    // Denominator absent entirely: unknown, not zero namespaces.
    expect(isolationRendering({ networkPolicyProtectedNamespaces: 3 }).coverageAbsence).toBe(
      'not-reported'
    );
    // Numerator absent: also unknown.
    expect(isolationRendering({ appNamespacesAudited: 6 }).coverageAbsence).toBe('not-reported');
    expect(ISOLATION_NOTHING_AUDITED_WHY).toMatch(/No app namespaces were audited/);
    expect(ISOLATION_NOT_REPORTED_WHY).toMatch(/did not report the namespace counts/);
    expect(ISOLATION_NOT_REPORTED_WHY).not.toMatch(/No app namespaces were audited/);
  });

  it('reports direction coverage as absent rather than zero on an older server', () => {
    const out = isolationRendering({
      appNamespacesAudited: 4,
      networkPolicyProtectedNamespaces: 4
    });
    expect(out.isolated).toBeNull();
    expect(out.coverage).toBe('4 of 4 namespaces have a NetworkPolicy');
  });

  it('degrades to null when the summary itself is missing', () => {
    const out = isolationRendering(undefined);
    expect(out.coverage).toBeNull();
    expect(out.isolated).toBeNull();
    expect(out.coverageAbsence).toBe('not-reported');
  });

  it('marks a truncated ratio as movable in either direction', () => {
    const clean = isolationRendering({ appNamespacesAudited: 3, networkPolicyProtectedNamespaces: 1 });
    expect(clean.ratioUnstable).toBe(false);
    const cut = isolationRendering(
      { appNamespacesAudited: 3, networkPolicyProtectedNamespaces: 1 },
      { truncated: true }
    );
    expect(cut.ratioUnstable).toBe(true);
    expect(RATIO_UNSTABLE_WHY).toMatch(/either direction/);
    expect(RATIO_UNSTABLE_WHY).toMatch(/not even a floor/);
  });

  it('never claims a connection was tested', () => {
    expect(ISOLATION_METHOD_WHY).toMatch(/allow rules inside each policy are not evaluated/);
  });

  it('derives no percentage at all, so there is nothing to overflow a track', () => {
    const out = isolationRendering({ appNamespacesAudited: 2, networkPolicyProtectedNamespaces: 5 });
    expect(out).not.toHaveProperty('percent');
    expect(out.coverage).toBe('5 of 2 namespaces have a NetworkPolicy');
  });
});
