import { describe, expect, it } from 'vitest';
import type { NativePolicy, NativePolicyBinding } from '../../../api';
import { bindingsLine, byNativeRisk, countByStatus, targetLine } from './native-policies';

function binding(over: Partial<NativePolicyBinding['namespaceScope']> = {}): NativePolicyBinding {
  return {
    name: 'b',
    policyName: 'p',
    validationActions: ['Deny'],
    paramRef: null,
    namespaceScope: { evaluable: true, scope: 'cluster-wide', matchedNamespaceCount: 30, totalNamespaces: 30, ...over },
    objectSelectorPresent: false,
    narrowsResources: true
  };
}

function policy(over: Partial<NativePolicy> = {}): NativePolicy {
  return {
    name: 'p',
    owner: null,
    module: null,
    failurePolicy: 'Fail',
    paramKind: null,
    rules: [{ group: '', resource: 'pods', operations: ['CREATE'] }],
    wildcard: false,
    operations: ['CREATE'],
    validationCount: 1,
    messages: [],
    matchConditionCount: 0,
    auditAnnotationCount: 0,
    typeCheckWarningCount: 0,
    bindings: [binding()],
    strongestAction: 'Deny',
    effectiveStatus: 'enforcing',
    ...over
  };
}

describe('native policies', () => {
  it('sorts what enforces nothing before what denies', () => {
    const rows = [policy({ name: 'a' }), policy({ name: 'z', effectiveStatus: 'unbound', bindings: [] }), policy({ name: 'm', effectiveStatus: 'warn-only' })];
    expect(rows.sort(byNativeRisk).map(p => p.name)).toEqual(['z', 'm', 'a']);
  });

  it('counts each effective status', () => {
    const c = countByStatus([policy(), policy(), policy({ effectiveStatus: 'unbound' })]);
    expect(c.enforcing).toBe(2);
    expect(c.unbound).toBe(1);
    expect(c['warn-only']).toBe(0);
  });

  it('says wildcards in words and caps the resource list', () => {
    expect(targetLine(policy({ wildcard: true, operations: ['*'] }))).toBe('every operation · every resource');
    const many = policy({
      operations: ['CREATE', 'UPDATE'],
      rules: ['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs'].map(resource => ({ group: '', resource, operations: ['CREATE'] }))
    });
    expect(targetLine(many)).toBe('CREATE, UPDATE · pods, deployments, statefulsets +2');
  });

  it('never states a reach it could not evaluate', () => {
    expect(bindingsLine(policy({ bindings: [] }))).toBe('no binding');
    expect(bindingsLine(policy({ bindings: [binding({ evaluable: false, matchedNamespaceCount: null, totalNamespaces: null })] }))).toBe('reach unknown');
    const two = policy({ bindings: [binding({ scope: 'selector', matchedNamespaceCount: 4 }), binding()] });
    expect(bindingsLine(two)).toBe('every namespace (30) · +1 binding');
  });

  it('never calls an unread binding list "no binding"', () => {
    const p = policy({ bindings: [], effectiveStatus: 'unknown' });
    expect(bindingsLine(p)).toBe('bindings not read');
    expect(countByStatus([p]).unbound).toBe(0);
    expect([policy({ name: 'a', effectiveStatus: 'unbound', bindings: [] }), p].sort(byNativeRisk)[0]).toBe(p);
  });
});
