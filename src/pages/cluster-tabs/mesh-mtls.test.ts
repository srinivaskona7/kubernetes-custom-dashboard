import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  alongsideCaption,
  coverageByNamespace,
  coverageForVerdict,
  fleetCoverage,
  meshWideCoverage,
  mtlsBasisNote,
  mtlsModeCell,
  portOverrideMarkers,
  portOverrideTone
} from './mesh-mtls';

describe('mtlsModeCell — a declared mode is not an observed one', () => {
  it('keeps STRICT green only when every pod in scope carries a sidecar', () => {
    expect(mtlsModeCell('STRICT', 'namespace', { inMeshCount: 4, podCount: 4, ambient: false })).toEqual({
      label: 'STRICT',
      tone: 'ok',
      note: null
    });
  });

  it('refuses green for a STRICT namespace whose pods carry no sidecar', () => {
    const cell = mtlsModeCell('STRICT', 'namespace', { inMeshCount: 0, podCount: 3, ambient: false });
    expect(cell.tone).toBe('bad');
    expect(cell.note).toBe('declared only — 0 of 3 pods carry a sidecar, so nothing enforces it');
  });

  it('warns on partial sidecar coverage under a STRICT declaration', () => {
    const cell = mtlsModeCell('STRICT', 'namespace', { inMeshCount: 2, podCount: 5, ambient: false });
    expect(cell.tone).toBe('warn');
    expect(cell.note).toContain('2 of 5 pods carry a sidecar');
  });

  it('accepts ztunnel as the enforcer for an ambient scope', () => {
    expect(mtlsModeCell('STRICT', 'mesh', { inMeshCount: 0, podCount: 0, ambient: true })).toEqual({
      label: 'STRICT',
      tone: 'ok',
      note: 'enforced by ztunnel (ambient)'
    });
  });

  it('renders unknown, never ok, when the coverage read was refused', () => {
    const cell = mtlsModeCell('STRICT', 'namespace', null);
    expect(cell.tone).toBe('unknown');
    expect(cell.note).toContain('not reported');
  });

  it('renders unknown when the scope holds no pods at all', () => {
    expect(mtlsModeCell('STRICT', 'namespace', { inMeshCount: 0, podCount: 0, ambient: false }).tone).toBe('unknown');
  });

  it('separates an unset PERMISSIVE from a chosen one', () => {
    const unset = mtlsModeCell('PERMISSIVE', 'default', { inMeshCount: 1, podCount: 1, ambient: false });
    expect(unset.label).toBe('PERMISSIVE (unset)');
    expect(unset.tone).toBe('unknown');
    const chosen = mtlsModeCell('PERMISSIVE', 'namespace', { inMeshCount: 1, podCount: 1, ambient: false });
    expect(chosen.label).toBe('PERMISSIVE');
    expect(chosen.tone).toBe('warn');
  });

  it('tones DISABLE bad and an unrecognised mode unknown', () => {
    expect(mtlsModeCell('DISABLE', 'workload', null).tone).toBe('bad');
    expect(mtlsModeCell('', 'workload', null)).toEqual({ label: 'not reported', tone: 'unknown', note: null });
  });
});

describe('portOverrideMarkers', () => {
  it('surfaces only the ports that contradict the declared mode', () => {
    expect(portOverrideMarkers({ '9090': 'DISABLE', '8080': 'STRICT' }, 'STRICT')).toEqual([
      { port: '9090', mode: 'DISABLE' }
    ]);
  });

  it('sorts ports numerically, not lexically', () => {
    expect(portOverrideMarkers({ '9090': 'DISABLE', '80': 'PERMISSIVE' }, 'STRICT').map(o => o.port)).toEqual([
      '80',
      '9090'
    ]);
  });

  it('treats an absent portOverrides map as no overrides', () => {
    expect(portOverrideMarkers(null, 'STRICT')).toEqual([]);
    expect(portOverrideMarkers(undefined, 'STRICT')).toEqual([]);
  });

  it('tones by the weakest override present', () => {
    expect(portOverrideTone([{ port: '1', mode: 'DISABLE' }, { port: '2', mode: 'STRICT' }])).toBe('bad');
    expect(portOverrideTone([{ port: '1', mode: 'PERMISSIVE' }])).toBe('warn');
    expect(portOverrideTone([{ port: '1', mode: 'STRICT' }])).toBe('accent');
    expect(portOverrideTone([])).toBe('unknown');
  });
});

describe('fleetCoverage — the collector s null survives the browser', () => {
  it('relays a suppressed percentage as null rather than re-deriving 0%', () => {
    expect(
      fleetCoverage({ coveragePercent: null, byDeployment: [{ ambient: true, inMeshCount: 0, podCount: 4 }] })
    ).toBeNull();
  });

  it('relays the collector figure verbatim', () => {
    expect(fleetCoverage({ coveragePercent: 62, byDeployment: [] })).toBe(62);
  });

  it('returns null, never 0, for an absent payload', () => {
    expect(fleetCoverage(null)).toBeNull();
    expect(fleetCoverage(undefined)).toBeNull();
  });

  it('falls back to counts only when the field is missing, and still refuses a fake denominator', () => {
    expect(fleetCoverage({ byDeployment: [{ ambient: false, inMeshCount: 1, podCount: 4 }] })).toBe(25);
    expect(fleetCoverage({ byDeployment: [{ ambient: true, inMeshCount: 0, podCount: 4 }] })).toBeNull();
  });
});

describe('coverage joins', () => {
  const rows = [
    { namespace: 'a', ambient: false, inMeshCount: 1, podCount: 2 },
    { namespace: 'a', ambient: false, inMeshCount: 2, podCount: 2 },
    { namespace: 'b', ambient: true, inMeshCount: 0, podCount: 3 }
  ];

  it('sums per namespace, splitting ambient pods out of the sidecar denominator', () => {
    const map = coverageByNamespace(rows)!;
    expect(map.get('a')).toEqual({
      inMeshCount: 3,
      podCount: 4,
      ambient: false,
      ambientPodCount: 0,
      namespace: 'a',
      attribution: 'scope'
    });
    expect(map.get('b')).toEqual({
      inMeshCount: 0,
      podCount: 0,
      ambient: true,
      ambientPodCount: 3,
      namespace: 'b',
      attribution: 'scope'
    });
  });

  it('counts ambient workloads separately in the mesh-wide figure instead of dropping them', () => {
    expect(meshWideCoverage(rows)).toEqual({
      inMeshCount: 3,
      podCount: 4,
      ambient: true,
      ambientPodCount: 3,
      attribution: 'scope'
    });
  });

  it('reports an all-ambient mesh as ztunnel-enforced, not as "no pods in scope"', () => {
    const ambientOnly = [{ namespace: 'a', ambient: true, inMeshCount: 0, podCount: 4 }];
    const mesh = meshWideCoverage(ambientOnly)!;
    expect(mesh).toEqual({ inMeshCount: 0, podCount: 0, ambient: true, ambientPodCount: 4, attribution: 'scope' });
    expect(mtlsModeCell('STRICT', 'mesh', mesh)).toEqual({
      label: 'STRICT',
      tone: 'ok',
      note: 'enforced by ztunnel (ambient)'
    });
  });

  it('keeps a mixed mesh judged on its sidecar pods, with the ambient pods named', () => {
    const mesh = meshWideCoverage(rows)!;
    const cell = mtlsModeCell('STRICT', 'mesh', mesh);
    expect(cell.tone).toBe('warn');
    expect(cell.note).toBe(
      '3 of 4 pods carry a sidecar; the rest are outside the mesh; 3 ambient pod(s) alongside are enforced by ztunnel'
    );
  });

  it('propagates an unreadable pod list as null, not as an empty namespace', () => {
    expect(coverageByNamespace(null)).toBeNull();
    expect(meshWideCoverage(null)).toBeNull();
    expect(coverageForVerdict('namespace', 'a', null, null)).toBeNull();
    expect(coverageForVerdict('mesh', 'istio-system', null, null)).toBeNull();
  });

  it('gives the mesh verdict the mesh-wide join and a namespace verdict its own', () => {
    const map = coverageByNamespace(rows)!;
    const mesh = meshWideCoverage(rows)!;
    expect(coverageForVerdict('mesh', 'istio-system', map, mesh)).toEqual(mesh);
    expect(coverageForVerdict('namespace', 'a', map, mesh)).toEqual(map.get('a'));
    expect(coverageForVerdict('workload', 'nope', map, mesh)).toEqual({
      inMeshCount: 0,
      podCount: 0,
      ambient: false,
      ambientPodCount: 0,
      namespace: 'nope',
      attribution: 'namespace'
    });
  });

  it('marks a workload verdict as namespace-attributed so its note cannot claim the row s own pods', () => {
    const map = coverageByNamespace(rows)!;
    const mesh = meshWideCoverage(rows)!;
    const join = coverageForVerdict('workload', 'a', map, mesh)!;
    expect(join.attribution).toBe('namespace');
    const cell = mtlsModeCell('STRICT', 'workload', join);
    expect(cell.tone).toBe('warn');
    expect(cell.note).toBe(
      'namespace a has 3 of 4 pods with a sidecar; which of them this policy selects is not reported'
    );
  });

  it('still carries the two extremes through to a workload row', () => {
    const none = coverageByNamespace([{ namespace: 'a', ambient: false, inMeshCount: 0, podCount: 3 }])!;
    const bad = mtlsModeCell('STRICT', 'workload', coverageForVerdict('workload', 'a', none, null));
    expect(bad.tone).toBe('bad');
    expect(bad.note).toBe('declared only — no pod in namespace a carries a sidecar, so nothing enforces it');
    const all = coverageByNamespace([{ namespace: 'a', ambient: false, inMeshCount: 3, podCount: 3 }])!;
    const ok = mtlsModeCell('STRICT', 'workload', coverageForVerdict('workload', 'a', all, null));
    expect(ok.tone).toBe('ok');
    expect(ok.note).toBe('every pod in namespace a carries a sidecar');
  });
});

describe('alongsideCaption — a refused count is not zero', () => {
  it('says not reported for null and undefined', () => {
    expect(alongsideCaption(null, 'Ingress route')).toBe('Ingress route count not reported');
    expect(alongsideCaption(undefined, 'Ingress route')).toBe('Ingress route count not reported');
  });

  it('prints a real zero as a zero', () => {
    expect(alongsideCaption(0, 'Ingress route')).toBe('0 Ingress route(s) alongside');
  });
});

describe('mtlsBasisNote', () => {
  it('names configuration as the basis and denies observing a handshake', () => {
    const note = mtlsBasisNote('configuration');
    expect(note).toContain('PeerAuthentication');
    expect(note).toContain('No handshake is observed');
  });

  it('does not claim a basis it was not given', () => {
    expect(mtlsBasisNote(null)).toBe('Basis not reported — treat these rows as unverified.');
  });
});

/*
  Source-reading guards. The rules above live in a testable module, but whether the JSX actually
  calls them cannot be asserted without a DOM (this package's vitest runs environment: 'node'),
  so the component is read as text.
*/
describe('NetworkMeshTab wiring', () => {
  const src = readFileSync(join(__dirname, 'NetworkMeshTab.tsx'), 'utf8');

  it('titles the card as a declaration, not an effective state', () => {
    expect(src).toContain('title="Declared mTLS (configuration)"');
    expect(src).not.toContain('title="Effective mTLS"');
  });

  it('renders the basis, the coverage-gated mode pill, and the port overrides', () => {
    expect(src).toContain('mtlsBasisNote(mtlsEnvelope.mtlsBasis)');
    expect(src).toContain('mtlsModeCell(v.mode, v.modeSource, coverageForVerdict(');
    // Both call sites: the rendered marker AND the sort key. Asserting the substring once let a
    // deliberate break in the render arm hide behind the identical line in `sortValue`.
    expect(src.split('portOverrideMarkers(v.portOverrides, v.mode)').length - 1).toBe(2);
    expect(src).toContain('const overrides = portOverrideMarkers(v.portOverrides, v.mode);');
  });

  it('never re-derives the sidecar percentage with a fabricated denominator', () => {
    expect(src).toContain('fleetCoverage(sidecarCoverage)');
    expect(src).not.toContain('Math.max(1,');
  });

  it('routes the Ingress caption through the null-safe helper', () => {
    expect(src).toContain('const ingressCaption = alongsideCaption(');
    expect(src).not.toContain('Ingress route(s) alongside`');
  });

  it('gates the coverage join on the payload, not on the status label', () => {
    expect(src).toContain(
      'sidecarCoverage == null || sidecarStatus.state === \'unavailable\' ? null : sidecarCoverage.byDeployment ?? null'
    );
    expect(src).toContain('const nsCoverage = coverageByNamespace(coverageJoinRows);');
    expect(src).toContain('const meshCoverage = meshWideCoverage(coverageJoinRows);');
  });

  it('never says "none found" about an unread verdict list or an unread pod list', () => {
    expect(src).toContain('mtlsEnvelope.verdicts === null ? (');
    expect(src).toContain('PeerAuthentication was not read — mTLS verdicts not reported.');
    expect(src).toContain('sidecarCoverage == null || sidecarCoverage.byDeployment === null ? (');
    expect(src).toContain('Pods were not read — sidecar coverage not reported.');
  });

  it('labels an empty port-override cell as "no contradicting override", not "none"', () => {
    expect(src).toContain('no contradicting override');
    expect(src).not.toContain('<span className="text-muted">none</span>');
  });
});
