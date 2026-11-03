import { describe, expect, it } from 'vitest';
import type { JourneyPath, JourneyPathNode } from '../../api';
import { edgeFactLines, linkLine, nodeTiming, nodeTone, pathEmptyLine, pathRows } from './journey-path';

const n = (over: Partial<JourneyPathNode>): JourneyPathNode => ({
  id: 'x',
  kind: 'workload',
  label: 'srv-1',
  namespace: 'applecare',
  pod: 'srv-1',
  ...over
});
const PATH: JourneyPath = {
  nodes: [
    n({ id: 'edge', kind: 'edge', label: 'Load balancer' }),
    n({ id: 'g', kind: 'gateway', label: 'istio-ingressgateway-1', code: 200, codeClass: 'ok', durationMs: 42, upstreamMs: 40, proxyOverheadMs: 2 }),
    n({ id: 's', code: 200, codeClass: 'ok', durationMs: 35, upstreamMs: 33, proxyOverheadMs: 2 }),
    n({ id: 'e', kind: 'external', label: 'SAP HANA Cloud · us10', seen: false, openForMs: null, reason: 'connection reused, no line in this window' })
  ],
  edges: [
    { from: 'edge', to: 'g', link: 'exact', candidates: 1, transitMs: null },
    { from: 'g', to: 's', link: 'inferred', candidates: 3, transitMs: null },
    { from: 's', to: 'e', link: 'inferred', candidates: 0, transitMs: null }
  ]
};

describe('path view', () => {
  it('one row per node in path order, each with the edge that led to it', () => {
    const rows = pathRows(PATH);
    expect(rows.map(r => r.node.id)).toEqual(['edge', 'g', 's', 'e']);
    expect(rows[0]!.link).toBeNull();
    expect(rows[2]!.dashed).toBe(true);
  });
  it('an inferred link is dashed and always states its count', () => {
    expect(linkLine({ from: 'a', to: 'b', link: 'inferred', candidates: 3, transitMs: null })).toBe('inferred · 1 of 3 in flight');
    expect(linkLine({ from: 'a', to: 'b', link: 'inferred', candidates: 1, transitMs: null })).toBe('inferred · 1 of 1');
    expect(linkLine({ from: 'a', to: 'b', link: 'exact', candidates: 1, transitMs: 1 })).toBe('exact · transit 1ms');
  });
  it('a declared-but-unseen BTP node never reads as "1 of 0"', () => {
    expect(linkLine({ from: 's', to: 'e', link: 'inferred', candidates: 0, transitMs: null })).toBe('declared, not observed');
  });
  it('an external node never says ms', () => {
    const seen = nodeTiming(n({ kind: 'external', seen: true, openedAtMs: 4, openForMs: 1200, protocol: 'tcp' }));
    expect(seen).toBe('opened +4ms in, open 1.2 s · TCP, not a latency');
    expect(nodeTiming(n({ kind: 'external', seen: false, reason: 'connection reused, no line in this window' }))).toBe(
      'connection reused, no line in this window'
    );
    expect(seen).not.toMatch(/\d ?ms\b(?! in)/);
  });
  it('a workload shows its duration and the app / proxy split', () => {
    expect(nodeTiming(PATH.nodes[1]!)).toBe('42ms · app 40 · px 2');
    expect(nodeTiming(n({ durationMs: 30, upstreamMs: null, proxyOverheadMs: null }))).toBe('30ms · split not logged');
  });
  it('tones come from status only; violet never appears', () => {
    expect(nodeTone(PATH.nodes[1]!)).toBe('ok');
    expect(nodeTone(n({ codeClass: 'server' }))).toBe('bad');
    expect(nodeTone(n({ kind: 'external', failed: true, seen: true }))).toBe('bad');
    expect(nodeTone(n({ kind: 'notRead' }))).toBe('unknown');
    expect(nodeTone(n({ kind: 'external', undeclared: true, seen: true }))).toBe('warn');
  });
  it('a window of only probes and scanners says so', () => {
    expect(
      pathEmptyLine({ journeyPath: null, pathReason: 'no hop of this journey was in the window' } as never, {
        classCounts: { probe: 12, 'direct-or-tls': 30 }
      })
    ).toMatch(/health checks and scanners/);
  });
  it('the edge node states the LB and Gateway facts already read, and no client address', () => {
    const edgeNode = n({
      id: 'edge',
      kind: 'edge',
      label: 'Load balancer',
      edge: {
        lb: { type: 'LoadBalancer', hostname: 'my-lb.elb.amazonaws.com', addressOnly: false, externalTrafficPolicy: 'Local', sourceRangesCount: 0 },
        gateways: [{ namespace: 'istio-system', name: 'kyma-gateway', servers: [{ hosts: ['*.c.example.com'], tlsMode: 'SIMPLE', credentialName: 'kyma-tls' }] }]
      }
    });
    const lines = edgeFactLines(edgeNode);
    expect(lines).toContain('LoadBalancer · my-lb.elb.amazonaws.com');
    expect(lines).toContain('externalTrafficPolicy: Local');
    expect(lines).toContain('0 source ranges configured');
    expect(lines).toContain('kyma-gateway: *.c.example.com (SIMPLE, kyma-tls)');
  });
  it('an LB given only an address says so, never the address itself', () => {
    const lines = edgeFactLines(n({ id: 'edge', kind: 'edge', label: 'Load balancer', edge: { lb: { type: 'LoadBalancer', hostname: null, addressOnly: true, externalTrafficPolicy: null, sourceRangesCount: null }, gateways: null } }));
    expect(lines).toContain('LoadBalancer · address only');
    expect(lines.join(' ')).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
  it('an edge node with no edge facts (older server) has no lines', () => {
    expect(edgeFactLines(n({ id: 'edge', kind: 'edge', label: 'Load balancer' }))).toEqual([]);
  });
});
