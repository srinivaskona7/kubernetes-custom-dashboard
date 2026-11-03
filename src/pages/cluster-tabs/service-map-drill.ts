/** Service map → the journeys behind an arrow, and the nodes a failing arrow touches. */
import type { ServiceMapEdge, Trace, TracesData } from '../../api';
import { edgeId, isFailing } from './service-map-layout';

/** The map aggregates calls by arrow; healthy means every observed call on that arrow completed without an Envoy failure. */
export type ServiceMapOutcome = 'all' | 'healthy' | 'failing';

export function matchesServiceMapOutcome(edge: ServiceMapEdge, outcome: ServiceMapOutcome): boolean {
  if (outcome === 'healthy') return edge.calls > 0 && edge.errors === 0;
  if (outcome === 'failing') return isFailing(edge);
  return true;
}

export function edgeJourneys(edge: ServiceMapEdge, traces: readonly Trace[]): { openable: Trace[]; elsewhere: number | null } {
  if (!edge.traceIds) return { openable: [], elsewhere: null };
  const byId = new Map(traces.map(t => [t.traceId, t]));
  const openable = edge.traceIds.map(id => byId.get(id)).filter((t): t is Trace => !!t);
  return { openable, elsewhere: Math.max((edge.traceIdsFound ?? edge.traceIds.length) - openable.length, 0) };
}

/** Service-call edges that carry this request's correlation id, in the map's stable id format. */
export function edgesForTrace(traceId: string | null | undefined, edges: readonly ServiceMapEdge[]): string[] {
  if (!traceId) return [];
  return edges.filter(edge => edge.traceIds?.includes(traceId)).map(edgeId);
}

export function failingNodes(map: NonNullable<TracesData['serviceMap']>): Set<string> {
  const out = new Set<string>();
  for (const e of map.edges) if (isFailing(e)) { out.add(e.from); out.add(e.to); }
  return out;
}
