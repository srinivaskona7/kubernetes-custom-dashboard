/*
  Namespace compliance labels — findings, not certification.

  The pill read `Compliant` under a sub-tab called `Namespace Compliance`, with no standard named
  anywhere on screen. The five checks behind it come from one organisation's
  `namespace-bootstrapping` Helm chart (istio-injection label, PSA enforce label,
  `docker-registry-secret`, a RoleBinding onto cicd-serviceaccount/jenkins-deployer, and the
  chart's egress-allow NetworkPolicy) — see `srv/fleet/collectors/compliance.js`. "Compliant"
  with no standard named reads as certification against something external; what was actually
  measured is whether a namespace got the chart's treatment.

  The PSA check is the sharper case: it reads the `pod-security.kubernetes.io/enforce` **label**.
  That is admission-time only, so pods that predate the label keep running, and `warn`/`audit` are
  not read at all. A namespace can therefore show PSA present here while Security & Isolation flags
  a privileged pod inside it — hence the cross-link.

  JSX-free so it can be unit-tested under vitest's `environment: 'node'`.
*/

export type ComplianceVerdict = 'compliant' | 'warnings' | 'findings' | 'system';

/** The chart every check on this sub-tab is derived from. Named on screen, never implied. */
export const BOOTSTRAP_CHART = 'namespace-bootstrapping';

export const BOOTSTRAP_VERDICT_LABEL: Record<ComplianceVerdict, string> = {
  compliant: 'Conventions present',
  warnings: 'Conventions present, with warnings',
  findings: 'Conventions missing',
  system: 'System'
};

/** `Bootstrap conventions — 4/5 present`. `na` checks leave the denominator, not the numerator. */
export function bootstrapSummary(checks: readonly { status: string }[]): string {
  const applicable = checks.filter(c => c.status !== 'na');
  const present = applicable.filter(c => c.status === 'pass').length;
  if (applicable.length === 0) return 'Bootstrap conventions — none applicable';
  return `Bootstrap conventions — ${present}/${applicable.length} present`;
}

/**
 * The check name as it should read on screen. Only PSA is rewritten: `PSA baseline` claims a
 * workload verdict the collector never evaluates.
 */
export function bootstrapCheckName(id: string, name: string): string {
  // A switch, not a lookup object: `test/fleet/tab-icons-and-tips.test.js` rejects an `info:` key
  // in a column literal, and a label map here is the same shape that guard is about.
  switch (id) {
    case 'psa':
      return 'PSA enforce label set';
    default:
      return name;
  }
}

/** The qualifier printed under a check whose label overstates what was read. Null for the rest. */
export function bootstrapCheckNote(id: string): string | null {
  switch (id) {
    case 'psa':
      return 'Label only, evaluated at admission. Pods that predate the label keep running, and warn/audit labels are not read.';
    case 'istio':
      return 'Injection label only. Whether mTLS actually applies is the mesh policy verdict on Networking, not this label.';
    default:
      return null;
  }
}
