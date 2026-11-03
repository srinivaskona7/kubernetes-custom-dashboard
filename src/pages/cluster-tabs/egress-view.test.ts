/**
 * Traces → Outbound "Declared by" and the Endpoints noise filter.
 */
import { describe, expect, it } from 'vitest';
import { declaredBy, endpointBlock, filteredEmptyLine, filteredTitle, policyRead } from './egress-view';
import type { DestinationName, TraceNodeRef } from '../../api';

const d = (over: Partial<DestinationName>): DestinationName => ({ display: 'X', label: 'x', source: 'networkpolicy', key: null, qualifier: null, objects: ['NetworkPolicy shop/allow'], others: [], namespace: 'shop', policyName: 'allow', ...over });
const ext = (destination?: DestinationName): TraceNodeRef => ({ id: 'ext:1', kind: 'external', name: '52.1.2.3:443', namespace: null, ...(destination ? { destination } : {}) });
const bare = (over: Partial<DestinationName>): DestinationName => {
  const v = d(over);
  delete v.namespace;
  delete v.policyName;
  return v;
};

describe('declaredBy', () => {
  it('names the declaring policy', () => {
    expect(declaredBy(ext(d({})), 'read').text).toBe('shop/allow');
    expect(declaredBy(ext(d({ source: 'networkpolicy-ipblock', cidr: '52.1.0.0/16' })), 'read').title).toContain('52.1.0.0/16');
  });
  it('falls back to the object name when the server sent no policy fields', () => {
    expect(declaredBy(ext(bare({})), 'read').text).toBe('shop/allow');
  });
  it('an unnamed external address is undeclared only when the policies were read', () => {
    expect(declaredBy(ext(), 'read').text).toBe('Undeclared');
    expect(declaredBy(ext(), 'unavailable')).toMatchObject({ text: 'Unavailable', tone: 'unknown' });
  });
  it('a policy list cut at the paging ceiling cannot prove an address undeclared', () => {
    expect(declaredBy(ext(), 'truncated')).toMatchObject({ text: 'Unverified', tone: 'partial' });
    expect(declaredBy(ext(d({})), 'truncated').text).toBe('shop/allow');
  });
  it('policyRead: unavailable beats truncated, and both beat read', () => {
    expect(policyRead(undefined)).toBe('read');
    expect(policyRead({ unavailable: [], truncated: [] })).toBe('read');
    expect(policyRead({ unavailable: ['services'], truncated: ['networkpolicies'] })).toBe('truncated');
    expect(policyRead({ unavailable: ['networkpolicies'], truncated: ['networkpolicies'] })).toBe('unavailable');
  });
  it('a named address keeps its name even when the policy list was refused', () => {
    expect(declaredBy(ext(bare({ source: 'telemetry' })), 'unavailable').text).toBe('Telemetry pipeline');
  });
  it('in-cluster destinations need no egress rule; telemetry and LB say their source', () => {
    expect(declaredBy({ id: 'wl:a', kind: 'workload', name: 'srv', namespace: 'shop' }, 'read').text).toBe('In cluster');
    expect(declaredBy(ext(bare({ source: 'telemetry' })), 'read').text).toBe('Telemetry pipeline');
    expect(declaredBy(ext(bare({ source: 'ingress-lb' })), 'read').text).toBe('Ingress load balancer');
  });
});

describe('endpointBlock', () => {
  const block = (n: number) => ({ endpoints: Array.from({ length: n }, () => ({}) as never), endpointsFound: n });
  it('picks the unfiltered list only when asked and present', () => {
    const p = { endpoints: block(1), endpointsAll: block(3) };
    expect(endpointBlock(p, false)?.endpoints).toHaveLength(1);
    expect(endpointBlock(p, true)?.endpoints).toHaveLength(3);
    expect(endpointBlock({ endpoints: block(1) }, true)?.endpoints).toHaveLength(1);
    expect(endpointBlock(undefined, true)).toBeUndefined();
  });
});

describe('filteredTitle', () => {
  it('names each left-out class in words, busiest first as served', () => {
    expect(filteredTitle([{ class: 'probe', count: 12 }, { class: 'security-refused', count: 3 }, { class: 'direct-or-tls', count: 1 }]))
      .toBe('Left out of p50 and p95: 12 probes, 3 security refusals, 1 direct-IP or TLS rejection.');
  });
});

describe('filteredEmptyLine', () => {
  it('says what an empty strip left out, so it never reads clean over the filtered rows', () => {
    expect(filteredEmptyLine({ journeys: 9, byClass: [{ class: 'security-refused', count: 9 }] })).toBe('No app problems · 9 security refusals left out');
  });

  it('is undefined when nothing was filtered', () => {
    expect(filteredEmptyLine(undefined)).toBeUndefined();
    expect(filteredEmptyLine({ journeys: 0, byClass: [] })).toBeUndefined();
  });
});
