import { describe, expect, it } from 'vitest';
import type { JourneyPath } from '../../api';
import { CONNECTION_DURATION_TIP, confidenceOf, failureRoot, hopStatus } from './journey-status';

describe('journey status', () => {
  it('the connection-duration tooltip is the exact prompt text, one constant', () => {
    expect(CONNECTION_DURATION_TIP).toBe(
      'HTTP/application-level latency is not available for this connection. The value represents observed connection duration from proxy access data.'
    );
  });
  it('confidence follows the resolver source', () => {
    expect(confidenceOf({ source: 'networkpolicy' } as never)).toBe('explicit');
    expect(confidenceOf({ source: 'networkpolicy-ipblock' } as never)).toBe('explicit');
    expect(confidenceOf({ source: 'networkpolicy-prose' } as never)).toBe('inferred');
    expect(confidenceOf({ source: 'networkpolicy', ambiguous: true } as never)).toBe('inferred');
    expect(confidenceOf(null)).toBe('undeclared');
  });
  it('every hop has a status word, never colour alone', () => {
    expect(hopStatus({ kind: 'workload', codeClass: 'ok' } as never)).toEqual({ word: 'Success', tone: 'ok' });
    expect(hopStatus({ kind: 'workload', codeClass: 'server' } as never)).toEqual({ word: 'Error', tone: 'bad' });
    expect(hopStatus({ kind: 'gateway', codeClass: 'client', code: 403, flags: [] } as never).word).toBe('Error');
    expect(hopStatus({ kind: 'notRead' } as never)).toEqual({ word: 'Unknown', tone: 'unknown' });
  });
  it('an observed external TCP connection is evidence, not a successful permission or application request', () => {
    expect(hopStatus({ kind: 'external', seen: true } as never)).toEqual({ word: 'Observed', tone: 'unknown' });
    expect(hopStatus({ kind: 'external', seen: true, failed: true } as never)).toEqual({ word: 'Error', tone: 'bad' });
  });
  it('failure root is the earliest failing hop; a policy only when a refusal names it', () => {
    const path = { nodes: [{ id: 'g', kind: 'gateway', label: 'gw', codeClass: 'ok' }, { id: 's', kind: 'workload', label: 'srv-1', code: 500, codeClass: 'server' }], edges: [] } as unknown as JourneyPath;
    expect(failureRoot(path)).toEqual({ node: 'srv-1', reason: 'HTTP 500' });
    const refused = { nodes: [{ id: 'g', kind: 'gateway', label: 'gw', code: 403, codeClass: 'client' }], edges: [] } as unknown as JourneyPath;
    expect(failureRoot(refused)).toEqual({ node: 'gw', reason: 'HTTP 403' });
    expect(failureRoot(refused, { decidedBy: [{ namespace: 'istio-system', name: 'apple-acl', policyInferred: false }] } as never)).toEqual({ node: 'istio-system/apple-acl', reason: 'Authorization policy denied request' });
    expect(failureRoot(refused, { decidedBy: [{ namespace: 'istio-system', name: 'apple-acl', policyInferred: true }] } as never)).toEqual({ node: 'gw', reason: 'HTTP 403 · no ALLOW rule matched (istio-system/apple-acl, inferred)' });
  });
});
