/**
 * The Architecture tab's column rules.
 *
 * The cases that matter are the ones where the two rules disagree: a release with a readable request
 * path must read left to right as the request travels, and a release without one must keep the
 * distance-from-the-release picture it has always had, orphans in the last column included.
 */
import { describe, expect, it } from 'vitest';
import type { HelmGraphEdge, HelmGraphNode } from '../../api';
import { dependencyColumns, flowColumns, ingressTierColumns } from './flow-layout';

function node(id: string, kind: string, group = 'Workloads'): HelmGraphNode {
  return { id, kind, name: id, namespace: 'app', group, relationship: 'helm-owned', status: null };
}

function edge(from: string, to: string, type: HelmGraphEdge['type']): HelmGraphEdge {
  return { id: `${from}->${to}:${type}`, from, to, type, evidence: 'test', explanation: 'test' };
}

/** A release shaped like the real one: an APIRule into approuter, a second Service behind it. */
function releaseGraph(): { nodes: HelmGraphNode[]; edges: HelmGraphEdge[] } {
  const nodes = [
    node('release', 'HelmRelease', 'Helm Release'),
    node('rule', 'APIRule', 'Networking'),
    node('svc-approuter', 'Service', 'Networking'),
    node('svc-srv', 'Service', 'Networking'),
    node('deploy-approuter', 'Deployment'),
    node('deploy-srv', 'Deployment'),
    node('rs-approuter', 'ReplicaSet'),
    node('pod-approuter', 'Pod', 'Pods'),
    node('cm', 'ConfigMap', 'Configuration'),
    node('secret', 'Secret', 'Configuration'),
    node('netpol', 'NetworkPolicy', 'Security and Policy'),
    node('sa', 'ServiceAccount', 'Security and Policy')
  ];
  const edges = [
    ...['rule', 'svc-approuter', 'svc-srv', 'deploy-approuter', 'deploy-srv', 'cm', 'secret', 'netpol', 'sa'].map(id =>
      edge('release', id, 'helm-managed')
    ),
    edge('rule', 'svc-approuter', 'routes-to'),
    edge('svc-approuter', 'pod-approuter', 'selector'),
    edge('deploy-approuter', 'rs-approuter', 'owner'),
    edge('rs-approuter', 'pod-approuter', 'owner'),
    edge('deploy-approuter', 'cm', 'mounts'),
    edge('deploy-approuter', 'secret', 'references')
  ];
  return { nodes, edges };
}

describe('flowColumns rule selection', () => {
  it('uses the ingress rule when something routes into the release', () => {
    const { nodes, edges } = releaseGraph();
    expect(flowColumns(nodes, edges).rule).toBe('ingress');
  });

  it('falls back to depth when no routes-to edge was read', () => {
    const { nodes, edges } = releaseGraph();
    const noRouting = edges.filter(e => e.type !== 'routes-to');
    expect(flowColumns(nodes, noRouting).rule).toBe('depth');
  });

  it('ignores a routes-to edge from a Kind that does not front traffic', () => {
    // Defensive: the tier picture only makes sense when the source really is an entry point.
    const nodes = [node('release', 'HelmRelease', 'Helm Release'), node('a', 'Deployment'), node('b', 'Service')];
    const edges = [edge('release', 'a', 'helm-managed'), edge('a', 'b', 'routes-to')];
    expect(flowColumns(nodes, edges).rule).toBe('depth');
  });
});

describe('ingress tiers', () => {
  const { nodes, edges } = releaseGraph();
  const columns = flowColumns(nodes, edges).columns;

  it('puts the APIRule at the head of the picture', () => {
    expect(columns.get('rule')).toBe(0);
  });

  it('keeps the release at the origin rather than giving it a hop', () => {
    expect(columns.get('release')).toBe(0);
  });

  it('puts the routed Service and the workload behind it in the front-door column', () => {
    expect(columns.get('svc-approuter')).toBe(1);
    expect(columns.get('deploy-approuter')).toBe(1);
  });

  it('leaves an unrouted Service and its workload downstream', () => {
    expect(columns.get('svc-srv')).toBe(2);
    expect(columns.get('deploy-srv')).toBe(2);
  });

  it('puts Pods and ReplicaSets right of the workloads that declare them', () => {
    expect(columns.get('pod-approuter')).toBe(3);
    expect(columns.get('rs-approuter')).toBe(3);
    expect(columns.get('deploy-approuter')!).toBeLessThan(columns.get('rs-approuter')!);
  });

  it('puts config and policy last', () => {
    for (const id of ['cm', 'secret', 'netpol', 'sa']) expect(columns.get(id)).toBe(4);
  });

  it('gives every node a column', () => {
    for (const n of nodes) expect(columns.has(n.id)).toBe(true);
  });

  it('does not promote a workload whose Pods no ingress reaches', () => {
    // The front door is read off the selector/owner chain, so removing the Service's selector
    // edge must demote the Deployment — otherwise the tier was being guessed from the name.
    const withoutSelector = edges.filter(e => e.type !== 'selector');
    const c = flowColumns(nodes, withoutSelector).columns;
    expect(c.get('svc-approuter')).toBe(1);
    expect(c.get('deploy-approuter')).toBe(2);
  });

  it('survives an ownership cycle rather than hanging', () => {
    const cyclic = [...edges, edge('pod-approuter', 'rs-approuter', 'owner')];
    expect(() => ingressTierColumns(nodes, cyclic, new Set(['rule']))).not.toThrow();
  });
});

describe('dependencyColumns', () => {
  it('measures distance from the release along real edges', () => {
    const { nodes, edges } = releaseGraph();
    const c = dependencyColumns(nodes, edges);
    expect(c.get('release')).toBe(0);
    expect(c.get('deploy-approuter')).toBe(1);
    expect(c.get('rs-approuter')).toBe(2);
    expect(c.get('pod-approuter')).toBe(2); // reached by the Service's selector, which is shorter
  });

  it('parks a node no edge reaches in the last column rather than hiding it', () => {
    const nodes = [node('release', 'HelmRelease', 'Helm Release'), node('a', 'Deployment'), node('lonely', 'Secret')];
    const edges = [edge('release', 'a', 'helm-managed')];
    const c = dependencyColumns(nodes, edges);
    expect(c.get('lonely')).toBe(2);
  });

  it('returns nothing for an empty graph', () => {
    expect(dependencyColumns([], []).size).toBe(0);
  });
});
