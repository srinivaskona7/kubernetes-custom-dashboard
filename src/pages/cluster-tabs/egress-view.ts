/**
 * Traces → Outbound "Declared by": which cluster object names an outbound destination. An unnamed
 * external address reads "Undeclared" only when the NetworkPolicy list was read whole; a
 * refused read is Unavailable and a truncated one Unverified, never undeclared (CLAUDE.md, real data only).
 *
 * Pure `.ts`: tested in the node environment.
 */
import type { TraceClass, TracesData, TraceNodeRef } from '../../api';
import { destinationProvenance } from './destination-label';

export type DeclaredBy = { text: string; title: string; tone: 'text' | 'muted' | 'unknown' | 'partial' };

/** How the NetworkPolicy list was read: a list cut at the paging ceiling proves no absence. */
export type PolicyRead = 'read' | 'unavailable' | 'truncated';

export function policyRead(summary: { unavailable?: readonly string[]; truncated?: readonly string[] } | undefined): PolicyRead {
  if ((summary?.unavailable ?? []).includes('networkpolicies')) return 'unavailable';
  if ((summary?.truncated ?? []).includes('networkpolicies')) return 'truncated';
  return 'read';
}

export function declaredBy(to: TraceNodeRef, policies: PolicyRead): DeclaredBy {
  if (to.kind !== 'external') return { text: 'In cluster', title: 'An in-cluster destination. Applicable network policies are not evaluated by this naming view.', tone: 'muted' };
  const d = to.destination;
  if (!d) {
    if (policies === 'unavailable') return { text: 'Unavailable', title: 'The NetworkPolicy list could not be read, so whether a rule names this address is unknown.', tone: 'unknown' };
    if (policies === 'truncated') return { text: 'Unverified', title: 'The NetworkPolicy list stopped at the paging ceiling, so a rule naming this address may be in the part not read.', tone: 'partial' };
    return { text: 'Undeclared', title: 'No NetworkPolicy annotation or ipBlock, telemetry pipeline or load balancer status names this address.', tone: 'muted' };
  }
  const title = `${d.display}, ${destinationProvenance(d)}. A destination declaration does not prove effective egress permission; selectors, ports and all applicable rules must be evaluated.`;
  if (d.source === 'telemetry') return { text: 'Telemetry pipeline', title, tone: 'text' };
  if (d.source === 'ingress-lb') return { text: 'Ingress load balancer', title, tone: 'text' };
  const policy = d.namespace && d.policyName ? `${d.namespace}/${d.policyName}` : (d.objects[0] ?? '').replace(/^NetworkPolicy /, '');
  return { text: policy || d.display, title, tone: 'text' };
}

/** The Endpoints block to render: every journey when asked for and served, else the noise-free one. */
export function endpointBlock(
  payload: Pick<TracesData, 'endpoints' | 'endpointsAll'> | undefined,
  includeFiltered: boolean
): TracesData['endpoints'] | undefined {
  if (!payload) return undefined;
  return includeFiltered && payload.endpointsAll ? payload.endpointsAll : payload.endpoints;
}

const FILTERED_NOUN: Partial<Record<TraceClass, [string, string]>> = {
  probe: ['probe', 'probes'],
  'security-refused': ['security refusal', 'security refusals'],
  'direct-or-tls': ['direct-IP or TLS rejection', 'direct-IP or TLS rejections']
};

/** An empty Problems strip's line when noise was filtered out, so it never reads clean over those rows. */
export function filteredEmptyLine(filtered: { journeys: number; byClass: readonly { class: TraceClass; count: number }[] } | undefined): string | undefined {
  if (!filtered?.journeys) return undefined;
  const parts = filtered.byClass.map(b => {
    const noun = FILTERED_NOUN[b.class] ?? [b.class, b.class];
    return `${b.count.toLocaleString('en-US')} ${noun[b.count === 1 ? 0 : 1]}`;
  });
  return `No app problems · ${parts.join(', ')} left out`;
}

/** The Include-filtered control's tooltip: what the noise-free Endpoints list left out. */
export function filteredTitle(byClass: readonly { class: TraceClass; count: number }[]): string {
  const parts = byClass.map(b => {
    const noun = FILTERED_NOUN[b.class] ?? [b.class, b.class];
    return `${b.count.toLocaleString('en-US')} ${noun[b.count === 1 ? 0 : 1]}`;
  });
  return `Left out of p50 and p95: ${parts.join(', ')}.`;
}
