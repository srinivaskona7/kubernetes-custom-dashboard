/**
 * The findings the OPA surface raises, and the rows each one resolves to.
 *
 * Every card on OPA Overview is one of these. The rule this file exists to keep: a finding names
 * a destination, so the number on the card is always one click from the rows behind it. That is
 * why they are built here as data rather than rendered as prose inside the Overview — a `<p>` that
 * says "3 policies enforce nothing" cannot be clicked, cannot be counted, and cannot later move
 * into the shared fleet-wide findings index.
 *
 * ## What is deliberately NOT a finding here
 *
 * Anything that would require inventing evidence. There is no "12 requests denied today" finding,
 * because Gatekeeper's audit violations are objects that currently violate a policy — not requests
 * that were rejected at admission. Those two numbers differ whenever a policy was added after the
 * offending object already existed, which is the common case. Decision Activity says so in words
 * instead.
 */
import type { Finding, FindingFreshness, FindingSeverity } from '../../../findings';
import type { OpaData, OpaPolicy } from '../../../api';

/** Audit freshness, translated once into the shared freshness shape. */
function freshnessOf(policies: OpaPolicy[]): FindingFreshness {
  const stamped = policies.map(p => p.audit).filter(a => a.at !== null);
  if (stamped.length === 0) {
    return { state: 'never', at: null, detail: 'the Gatekeeper audit controller has not reported a run' };
  }
  // The OLDEST run, not the newest: a fleet of policies is only as fresh as its stalest member,
  // and quoting the newest would describe evidence the reader is not looking at.
  const oldest = stamped.reduce((a, b) => ((a.ageSeconds ?? 0) >= (b.ageSeconds ?? 0) ? a : b));
  const state = stamped.some(a => a.state === 'stale') ? 'stale' : oldest.state === 'fresh' ? 'fresh' : 'unknown';
  const age = oldest.ageSeconds;
  return {
    state,
    at: oldest.at,
    detail: age === null ? 'audit run time unreadable' : `oldest audit run was ${Math.round(age / 60)} minutes ago`
  };
}

/** The first few subjects, so a finding can name what it is about without carrying 400 rows. */
function subjectsOf(policies: OpaPolicy[]) {
  return policies.slice(0, 8).map(p => ({
    kind: p.constraintKind ?? 'ConstraintTemplate',
    namespace: null,
    name: p.constraintName ?? p.templateName
  }));
}

export function buildOpaFindings(data: OpaData): Finding[] {
  const out: Finding[] = [];
  const policies = data.policies;
  const freshness = freshnessOf(policies);
  const add = (
    id: string,
    severity: FindingSeverity,
    summary: string,
    affectedCount: number | null,
    params: Record<string, string | null>,
    source: string,
    subjects?: Finding['subjects'],
    withFreshness = false
  ) => out.push({ id, severity, summary, affectedCount, destination: { params }, source, subjects,
    ...(withFreshness ? { freshness } : {}) });

  // ------------------------------------------------------------------ enforcement is broken
  const broken = policies.filter(p =>
    p.ineffectiveReasons.some(r => r.code === 'TEMPLATE_ERROR' || r.code === 'NOT_RECONCILED'));
  if (broken.length > 0) {
    add(
      'opa.template-error',
      'critical',
      `${broken.length} ${broken.length === 1 ? 'policy has' : 'policies have'} a Rego or reconciliation error, so Gatekeeper cannot evaluate ${broken.length === 1 ? 'it' : 'them'}`,
      broken.length,
      { opa: 'policies', ostatus: 'inactive' },
      'constraint-status',
      subjectsOf(broken)
    );
  }

  // The one finding that is about the gate itself rather than any policy: a webhook whose backend
  // is not answering means NOTHING is being evaluated, however healthy each policy row looks.
  if (data.webhook.present && data.webhook.active === false) {
    out.push({
      id: 'opa.webhook-down',
      severity: 'critical',
      summary:
        data.webhook.failurePolicy === 'Ignore'
          ? 'The Gatekeeper admission webhook has no ready backend and fails open — every write is being admitted without policy evaluation'
          : 'The Gatekeeper admission webhook has no ready backend and fails closed — matching writes are being rejected outright',
      affectedCount: null,
      destination: { params: { opa: 'coverage' } },
      source: 'endpointslices',
      subjects: data.webhook.configName
        ? [{ kind: 'ValidatingWebhookConfiguration', namespace: null, name: data.webhook.configName }]
        : undefined
    });
  }

  // The gate is up but fails open. Gatekeeper ships `failurePolicy: Ignore` by default, trading
  // enforcement for availability, so this is a posture statement rather than an outage — but it
  // is the one fact that decides whether every deny policy above holds while Gatekeeper is down.
  if (data.webhook.present && data.webhook.active !== false && data.webhook.failurePolicy === 'Ignore') {
    out.push({
      id: 'opa.webhook-fails-open',
      severity: 'warning',
      summary:
        'The Gatekeeper admission webhook fails open (failurePolicy: Ignore, the Gatekeeper default) — if Gatekeeper stops answering, matching writes are admitted without evaluation and nothing reports it',
      affectedCount: null,
      destination: { params: { opa: 'coverage' } },
      source: 'validatingwebhookconfigurations',
      subjects: data.webhook.configName
        ? [{ kind: 'ValidatingWebhookConfiguration', namespace: null, name: data.webhook.configName }]
        : undefined
    });
  }

  // ------------------------------------------------------------------ declared, enforces nothing
  // Excludes the broken set above so one policy is not counted twice under two headings.
  const brokenIds = new Set(broken.map(p => p.id));
  const inert = policies.filter(p => !brokenIds.has(p.id) && p.status === 'inactive');
  if (inert.length > 0) {
    add(
      'opa.inert',
      'warning',
      `${inert.length} ${inert.length === 1 ? 'policy is' : 'policies are'} declared but cannot affect admission — the detected reason is on each row`,
      inert.length,
      { opa: 'policies', ostatus: 'inactive' },
      'constraint-status',
      subjectsOf(inert)
    );
  }

  const dryRun = policies.filter(p => p.enforcementAction === 'dryrun');
  if (dryRun.length > 0) {
    add(
      'opa.dryrun',
      'warning',
      `${dryRun.length} ${dryRun.length === 1 ? 'policy is' : 'policies are'} in dry-run — violations are recorded and nothing is blocked`,
      dryRun.length,
      { opa: 'policies', oaction: 'dryrun' },
      'constraint-spec',
      subjectsOf(dryRun)
    );
  }

  const warnOnly = policies.filter(p => p.enforcementAction === 'warn');
  if (warnOnly.length > 0) {
    add(
      'opa.warn',
      'info',
      `${warnOnly.length} ${warnOnly.length === 1 ? 'policy warns' : 'policies warn'} instead of denying — the request still succeeds`,
      warnOnly.length,
      { opa: 'policies', oaction: 'warn' },
      'constraint-spec',
      subjectsOf(warnOnly)
    );
  }

  // ------------------------------------------------------------------ current violations
  const violating = policies.filter(p => (p.violationCount ?? 0) > 0);
  if (data.summary.auditViolationTotal > 0) {
    const denyViolations = violating.filter(p => p.enforcementAction === 'deny');
    add(
      'opa.audit-violations',
      denyViolations.length > 0 ? 'warning' : 'info',
      `${data.summary.auditViolationTotal} existing ${data.summary.auditViolationTotal === 1 ? 'object violates' : 'objects violate'} a policy — these already exist in the cluster and were not blocked at admission`,
      data.summary.auditViolationTotal,
      { opa: 'violations', oviol: null },
      'gatekeeper-audit',
      undefined,
      true
    );
  }

  // A stale audit is its own finding because it changes how every zero above should be read.
  if (freshness.state === 'stale' || freshness.state === 'never') {
    out.push({
      id: 'opa.audit-stale',
      severity: 'warning',
      summary:
        freshness.state === 'never'
          ? 'No policy has an audit timestamp, so a violation count of zero is not evidence of compliance'
          : 'The Gatekeeper audit has not run recently, so the violation counts below may be out of date',
      affectedCount: null,
      destination: { params: { opa: 'coverage' } },
      source: 'constraint-status',
      freshness
    });
  }

  // ------------------------------------------------------------------ counts that could not be read
  if (data.summary.policiesWithUnknownViolationCount > 0) {
    add(
      'opa.unknown-violations',
      'warning',
      `${data.summary.policiesWithUnknownViolationCount} ${data.summary.policiesWithUnknownViolationCount === 1 ? 'policy has' : 'policies have'} no violation count yet — unread, not zero`,
      data.summary.policiesWithUnknownViolationCount,
      { opa: 'policies', ostatus: 'unknown' },
      'constraint-status'
    );
  }

  if (data.summary.templateLimitExceeded) {
    out.push({
      id: 'opa.template-limit',
      severity: 'warning',
      summary: `More than ${data.summary.templateLimit} ConstraintTemplates exist; this page describes the first ${data.summary.templateLimit} and every count is a floor`,
      affectedCount: data.summary.templateCount,
      destination: { params: { opa: 'policies' } },
      source: 'constrainttemplates'
    });
  }

  // ------------------------------------------------------------------ the healthy statement
  // An `info` finding, on purpose: an operator opening this page needs to be told what IS being
  // enforced, not only what is broken, and the number has to be clickable like any other.
  const enforcing = policies.filter(p => p.status === 'active' && p.enforcementAction === 'deny');
  if (enforcing.length > 0) {
    add(
      'opa.enforcing',
      'info',
      `${enforcing.length} ${enforcing.length === 1 ? 'policy denies' : 'policies deny'} violating requests at admission`,
      enforcing.length,
      { opa: 'policies', oaction: 'deny', ostatus: 'active' },
      'constraint-spec'
    );
  }

  return out;
}

/**
 * High-risk findings and the rest. `info` findings — "3 policies deny", "2 policies warn" — are
 * statements about what IS in force; listing them under "High-risk findings" made a healthy
 * cluster look like it had one risk. Order within each half is the builder's.
 */
export function partitionFindings(findings: Finding[]): { risks: Finding[]; noted: Finding[] } {
  return {
    risks: findings.filter(f => f.severity !== 'info'),
    noted: findings.filter(f => f.severity === 'info')
  };
}
