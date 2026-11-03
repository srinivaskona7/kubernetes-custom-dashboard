/**
 * Access control → Refused requests: the words for each row. Pure, so the rules are tested here
 * and the component only renders them.
 */
import type { IngressRefusedRow } from '../../../api';

const CLASS_WORD: Record<string, string> = { 'direct-ip': 'Direct IP', 'tls-rejected': 'TLS', 'policy-blocked': 'Subdomain', app: 'Subdomain', probe: 'Probe' };

export function classWord(edgeClass: string | null): string {
  if (edgeClass === null) return 'Sidecar';
  return CLASS_WORD[edgeClass] ?? edgeClass;
}

export function decidedByText(r: Pick<IngressRefusedRow, 'decidedBy'>): { text: string; inferred: boolean; unknown: boolean; title?: string } {
  if (r.decidedBy === null) return { text: 'not read', inferred: false, unknown: true };
  if (r.decidedBy.length === 0) return { text: 'no policy: refused by routing', inferred: false, unknown: false };
  const names = r.decidedBy.map(p => `${p.namespace}/${p.name}`).join(' or ');
  if (r.decidedBy.length === 1 && r.decidedBy[0]?.decidedBy === 'elimination') {
    return {
      text: `${names} — decided by elimination`,
      inferred: false,
      unknown: false,
      title: 'the only ALLOW policy on this proxy; Envoy logs [none], so it names no policy itself'
    };
  }
  return { text: names, inferred: r.decidedBy.some(p => p.policyInferred), unknown: false };
}

export interface RefusedFilter { policy: string | null; klass: string | null; status: number | null }

export function filterRefused(rows: readonly IngressRefusedRow[], f: RefusedFilter): IngressRefusedRow[] {
  return rows.filter(
    r =>
      (f.policy === null || (r.decidedBy ?? []).some(p => `${p.namespace}/${p.name}` === f.policy)) &&
      (f.klass === null || classWord(r.edgeClass) === f.klass) &&
      (f.status === null || r.code === f.status)
  );
}

export function refusedFilters(rows: readonly IngressRefusedRow[]): { policies: string[]; classes: string[]; statuses: number[] } {
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  return {
    policies: uniq(rows.flatMap(r => (r.decidedBy ?? []).map(p => `${p.namespace}/${p.name}`))).sort(),
    classes: uniq(rows.map(r => classWord(r.edgeClass))).sort(),
    statuses: uniq(rows.map(r => r.code)).sort((a, b) => a - b)
  };
}
