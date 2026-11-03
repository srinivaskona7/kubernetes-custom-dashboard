import { describe, expect, it } from 'vitest';
import type { IngressRefusedRow } from '../../../api';
import { classWord, decidedByText, filterRefused, refusedFilters } from './refused-view';

const row = (over: Partial<IngressRefusedRow>): IngressRefusedRow => ({ tier: 'edge', namespace: 'istio-system', method: 'GET', authority: '192.0.2.10', path: '/', edgeClass: 'direct-ip', code: 403, responseCodeDetails: ['rbac_access_denied_matched_policy[none]'], responseFlags: [], reason: 'No ALLOW rule matched this request', tlsBeforeHttp: false, decidedBy: [{ namespace: 'istio-system', name: 'edge-acl', action: 'ALLOW', policyInferred: true, decidedBy: 'inferred', rules: [] }], firstSeen: null, lastSeen: null, count: 3, clients: 2, ...over });

describe('refused requests', () => {
  it('an inferred decider says so', () => {
    expect(decidedByText(row({}))).toEqual({ text: 'istio-system/edge-acl', inferred: true, unknown: false });
  });
  it('policies unread reads unknown, never none', () => {
    expect(decidedByText(row({ decidedBy: null }))).toEqual({ text: 'not read', inferred: false, unknown: true });
  });
  it('no deciding policy is said in words', () => {
    expect(decidedByText(row({ decidedBy: [] })).text).toBe('no policy: refused by routing');
  });
  it('two inferred deciders are both named', () => {
    const r = row({ decidedBy: [{ namespace: 'a', name: 'x', action: 'ALLOW', policyInferred: true, decidedBy: 'inferred', rules: [] }, { namespace: 'a', name: 'y', action: 'ALLOW', policyInferred: true, decidedBy: 'inferred', rules: [] }] });
    expect(decidedByText(r).text).toBe('a/x or a/y');
  });
  it('the one ALLOW policy elimination decided reads "decided by elimination", with a title', () => {
    const r = row({ decidedBy: [{ namespace: 'istio-system', name: 'edge-acl', action: 'ALLOW', policyInferred: false, decidedBy: 'elimination', rules: [] }] });
    const d = decidedByText(r);
    expect(d.text).toBe('istio-system/edge-acl — decided by elimination');
    expect(d.inferred).toBe(false);
    expect(d.title).toBe('the only ALLOW policy on this proxy; Envoy logs [none], so it names no policy itself');
  });
  it('classes read as words', () => {
    expect(classWord('direct-ip')).toBe('Direct IP');
    expect(classWord('tls-rejected')).toBe('TLS');
    expect(classWord(null)).toBe('Sidecar');
  });
  it('filters by policy, class and status', () => {
    const rows = [row({}), row({ code: 400, edgeClass: 'direct-ip', decidedBy: [] }), row({ tier: 'sidecar', edgeClass: null, code: 403 })];
    expect(filterRefused(rows, { policy: 'istio-system/edge-acl', klass: null, status: null })).toHaveLength(2);
    expect(filterRefused(rows, { policy: null, klass: 'Sidecar', status: null })).toHaveLength(1);
    expect(filterRefused(rows, { policy: null, klass: null, status: 400 })).toHaveLength(1);
    expect(refusedFilters(rows)).toEqual({ policies: ['istio-system/edge-acl'], classes: ['Direct IP', 'Sidecar'], statuses: [400, 403] });
  });
});
