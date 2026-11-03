import { describe, expect, it } from 'vitest';
import type { OpaBundleCoverage, OpaLibraryMatch } from '../../../api';
import { bundleName, listHead, missingTemplates, sourceLabel } from './library';

function match(over: Partial<OpaLibraryMatch>): OpaLibraryMatch {
  return {
    state: 'library',
    title: 'Privileged Container',
    libraryVersion: '1.1.1',
    clusterVersion: '1.1.1',
    behind: false,
    rego: 'identical',
    bundles: ['pod-security-baseline'],
    path: 'library/pod-security-policy/privileged-containers',
    ...over
  };
}

describe('sourceLabel', () => {
  it('names a custom template neutrally', () => {
    const l = sourceLabel(match({ state: 'custom', title: null, libraryVersion: null, clusterVersion: null, behind: null, rego: null }));
    expect(l.text).toBe('custom');
    expect(l.tone).toBe('unknown');
  });

  it('marks a library name with different Rego as modified, never as library', () => {
    const l = sourceLabel(match({ state: 'modified', rego: 'differs' }));
    expect(l.text).toBe('modified');
    expect(l.tone).toBe('warn');
  });

  it('flags a template behind the library version', () => {
    const l = sourceLabel(match({ clusterVersion: '1.0.0', behind: true }));
    expect(l.text).toBe('library v1.0.0 · v1.1.1 out');
    expect(l.tone).toBe('warn');
  });

  it('is ok only when the Rego was compared and matched', () => {
    expect(sourceLabel(match({})).tone).toBe('ok');
    expect(sourceLabel(match({ rego: null })).tone).toBe('unknown');
  });

  it('does not claim a current version when none is annotated', () => {
    const l = sourceLabel(match({ clusterVersion: null, behind: null }));
    expect(l.text).toBe('library v1.1.1');
    expect(l.title).toMatch(/currency is unknown/);
  });
});

describe('bundle helpers', () => {
  it('names the two Pod Security bundles', () => {
    expect(bundleName('pod-security-baseline')).toBe('Pod Security baseline');
    expect(bundleName('pod-security-restricted')).toBe('Pod Security restricted');
    expect(bundleName('other')).toBe('other');
  });

  it('lists only the templates the cluster lacks', () => {
    const b: OpaBundleCoverage = {
      bundle: 'pod-security-baseline', total: 2, installed: 1, enforcing: 1, enforcingUnknown: 0,
      templates: [
        { name: 'k8spspprivilegedcontainer', title: 'Privileged Container', installed: true, enforcing: true, modified: false },
        { name: 'k8spsphostnetworkingports', title: 'Host Networking Ports', installed: false, enforcing: false, modified: false }
      ]
    };
    expect(missingTemplates(b)).toEqual(['Host Networking Ports']);
  });

  it('shows a list head and says how many more, never cutting mid-name', () => {
    expect(listHead(['a', 'b', 'c'], 4)).toBe('a, b, c');
    expect(listHead(['a', 'b', 'c', 'd', 'e', 'f'], 4)).toBe('a, b, c, d +2 more');
  });
});
