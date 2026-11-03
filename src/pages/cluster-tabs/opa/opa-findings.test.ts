import { describe, expect, it } from 'vitest';
import type { OpaData, OpaPolicy, OpaWebhookState } from '../../../api';
import { buildOpaFindings, partitionFindings } from './opa-findings';

function policy(over: Partial<OpaPolicy> = {}): OpaPolicy {
  return {
    id: 'p1',
    templateName: 'k8srequiredlabels',
    constraintKind: 'K8sRequiredLabels',
    constraintName: 'must-have-owner',
    enforcementAction: 'deny',
    status: 'active',
    ineffectiveReasons: [],
    violationCount: 0,
    audit: { at: '2026-09-24T10:00:00Z', ageSeconds: 60, state: 'fresh' },
    ...over
  } as unknown as OpaPolicy;
}

function data(webhook: Partial<OpaWebhookState>, policies: OpaPolicy[] = [policy()]): OpaData {
  return {
    webhook: {
      present: true,
      active: true,
      backendStatus: 'ready',
      configName: 'gatekeeper-validating-webhook-configuration',
      failurePolicy: 'Fail',
      timeoutSeconds: 3,
      service: null,
      reason: null,
      ...webhook
    },
    policies,
    summary: { auditViolationTotal: 0, policiesWithUnknownViolationCount: 0, templateLimitExceeded: false, templateLimit: 500 }
  } as unknown as OpaData;
}

const ids = (d: OpaData) => buildOpaFindings(d).map(f => f.id);

describe('opa.webhook-fails-open', () => {
  it('is raised for a live webhook that fails open', () => {
    const f = buildOpaFindings(data({ failurePolicy: 'Ignore' })).find(x => x.id === 'opa.webhook-fails-open');
    expect(f?.severity).toBe('warning');
    expect(f?.destination.params).toEqual({ opa: 'coverage' });
    expect(f?.subjects?.[0]?.name).toBe('gatekeeper-validating-webhook-configuration');
  });

  it('is not raised when the webhook fails closed', () => {
    expect(ids(data({ failurePolicy: 'Fail' }))).not.toContain('opa.webhook-fails-open');
  });

  it('gives way to opa.webhook-down when the backend is down', () => {
    const got = ids(data({ failurePolicy: 'Ignore', active: false }));
    expect(got).toContain('opa.webhook-down');
    expect(got).not.toContain('opa.webhook-fails-open');
  });

  it('is still raised when backend readiness is unknown (null), not only when proven up', () => {
    expect(ids(data({ failurePolicy: 'Ignore', active: null }))).toContain('opa.webhook-fails-open');
  });

  it('is not raised when there is no webhook, or presence is unknown', () => {
    expect(ids(data({ failurePolicy: 'Ignore', present: false }))).not.toContain('opa.webhook-fails-open');
    expect(ids(data({ failurePolicy: 'Ignore', present: null }))).not.toContain('opa.webhook-fails-open');
  });
});

describe('partitionFindings', () => {
  it('moves the info "policies deny" statement out of the risks', () => {
    const { risks, noted } = partitionFindings(buildOpaFindings(data({ failurePolicy: 'Ignore' })));
    expect(noted.map(f => f.id)).toEqual(['opa.enforcing']);
    expect(risks.map(f => f.id)).toContain('opa.webhook-fails-open');
    expect(risks.every(f => f.severity !== 'info')).toBe(true);
  });

  it('leaves a healthy fail-closed cluster with zero risks', () => {
    const { risks, noted } = partitionFindings(buildOpaFindings(data({ failurePolicy: 'Fail' })));
    expect(risks).toEqual([]);
    expect(noted).toHaveLength(1);
  });
});
