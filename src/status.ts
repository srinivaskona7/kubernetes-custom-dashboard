/**
 * The one place that maps a server status string to a tone and a human label.
 *
 * Centralised because the same token status appears on the Overview, the Token Health
 * page and the detail panel; three separate ternaries would drift, and the moment
 * "expiring" renders amber in one place and red in another the colour vocabulary stops
 * meaning anything.
 */
import type { CheckStatus, TokenStatus, Verdict } from './api';
import type { Tone } from './components/ui';

export function tokenTone(status: TokenStatus): Tone {
  switch (status) {
    case 'valid':
      return 'ok';
    case 'expiring':
      return 'warn';
    case 'expired':
      return 'bad';
    case 'unseeded':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export const TOKEN_LABEL: Record<TokenStatus, string> = {
  valid: 'Valid',
  expiring: 'Expiring',
  expired: 'Expired',
  unseeded: 'Not seeded',
  unknown: 'Unknown'
};

export function checkTone(status: CheckStatus): Tone {
  switch (status) {
    case 'pass':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'fail':
      return 'bad';
    default:
      return 'unknown';
  }
}

export const CHECK_LABEL: Record<CheckStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Finding',
  na: 'N/A'
};

export function verdictTone(v: Verdict): Tone {
  switch (v) {
    case 'compliant':
      return 'ok';
    case 'warnings':
      return 'warn';
    case 'findings':
      return 'bad';
    default:
      return 'unknown';
  }
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  compliant: 'Compliant',
  warnings: 'Warnings',
  findings: 'Findings',
  system: 'System'
};

/**
 * Workload state is a free string because it may be a diagnosis the collector lifted
 * straight from the container status — CrashLoopBackOff, ImagePullBackOff — rather than
 * one of a fixed set. Anything that reads as a back-off or an error is critical.
 */
export function workloadTone(state: string, healthy: boolean): Tone {
  if (healthy) return 'ok';
  if (/BackOff|Error|Invalid|Unavailable/i.test(state)) return 'bad';
  if (/Scaled to zero/i.test(state)) return 'unknown';
  return 'warn';
}

/** The command that repairs a broken chain. Shown, never run by the app. */
export function seedCommand(namespace: string, serviceAccount: string): string {
  return `kubectl create token ${serviceAccount} -n ${namespace} --duration=24h`;
}
