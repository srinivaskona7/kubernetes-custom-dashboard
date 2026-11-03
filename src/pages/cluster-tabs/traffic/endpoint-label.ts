/**
 * How the Traffic failure list names a request's source or destination. No JSX, so it is tested.
 */
import type { DestinationName, TraceEndpointStat, TrafficEndpoint } from '../../../api';
import { destinationProvenance } from '../destination-label';

/**
 * An unnamed peer is its address; anything the cluster claims is its object name. External peers
 * arrive collapsed with no address (D1), so they read as their name and how many addresses the row
 * folds, "External clients (115 addresses)", never an empty address.
 */
export function endpointLabel(ep: TrafficEndpoint): string {
  if (ep.kind !== 'external' && ep.kind !== 'unresolved') return ep.name;
  if (ep.ip) return ep.ip;
  return typeof ep.distinct === 'number' ? `${ep.name} (${ep.distinct} ${ep.distinct === 1 ? 'address' : 'addresses'})` : ep.name;
}

/** A name to lead with, the address to keep beside it, and the sentence saying who gave the name. */
export interface NamedAddress<P = string> {
  primary: P;
  secondary: string | null;
  provenance: string | null;
}

/**
 * A failing request's endpoint, name first when a cluster object names its address (the way
 * destination-label.ts does for Traces). The address stays as the second line, because the name is
 * only as good as the object that gave it.
 */
export function endpointName(ep: TrafficEndpoint): NamedAddress {
  const d = ep.destination;
  if (!d) return { primary: endpointLabel(ep), secondary: null, provenance: null };
  const address = ep.ip ?? ep.name;
  return { primary: d.display, secondary: `${address}${ep.port ? `:${ep.port}` : ''}`, provenance: destinationProvenance(d) };
}

/** A Traces endpoint's host, name first when it is a bare IP a cluster object names. */
export function endpointHostName(e: Pick<TraceEndpointStat, 'host'> & { destination?: DestinationName }): NamedAddress<string | null> {
  const d = e.destination;
  if (!d || !e.host) return { primary: e.host, secondary: null, provenance: null };
  return { primary: d.display, secondary: e.host, provenance: destinationProvenance(d) };
}
