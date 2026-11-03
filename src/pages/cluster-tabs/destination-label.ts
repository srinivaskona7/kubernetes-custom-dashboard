/**
 * Traces → the name an external address was given by a cluster object (srv/fleet/destination-names.js).
 *
 * The name leads and the address stays beside it, because the name is only as good as the object
 * that gave it: an operator checking a NetworkPolicy's IP list needs the IP. An address no object
 * names stays the bare address — nothing here guesses.
 */
import type { DestinationName, TraceNodeRef } from '../../api';

/** How many source objects a tooltip lists before it counts the rest. */
const MAX_OBJECTS = 3;

export function destinationLabel(n: Pick<TraceNodeRef, 'name' | 'destination'>): { primary: string; secondary: string | null; named: boolean } {
  const d = n.destination;
  return d ? { primary: d.display, secondary: n.name, named: true } : { primary: n.name, secondary: null, named: false };
}

function objectList(objects: readonly string[]): string {
  const shown = objects.slice(0, MAX_OBJECTS).join(', ');
  return objects.length > MAX_OBJECTS ? `${shown} and ${objects.length - MAX_OBJECTS} more` : shown;
}

/** One sentence naming the object the name came from, and any other name the address carries. */
export function destinationProvenance(d: DestinationName): string {
  // A tied name lists every claimant's object: the operator has to find the conflict to settle it.
  const objects = d.ambiguous ? d.objects.join(', ') : objectList(d.objects);
  let from: string;
  switch (d.source) {
    case 'networkpolicy':
    case 'networkpolicy-prose':
      from = `from ${objects}${d.key ? ` annotation ${d.key}` : ''}`;
      break;
    case 'networkpolicy-ipblock':
      from = `from ${objects} egress ipBlock ${d.cidr ?? 'unknown'}`;
      break;
    case 'telemetry':
      from = `from the telemetry export of ${objects}`;
      break;
    case 'ingress-lb':
      from = `from the load balancer status of ${objects}`;
      break;
  }
  // A range entry's qualifier is "inside <cidr>", which the sentence already names.
  if (d.source === 'networkpolicy-ipblock' && d.cidr && d.qualifier === `inside ${d.cidr}`) from += ' (the address is inside it)';
  else if (d.qualifier) from += ` (${d.qualifier})`;
  if (d.ambiguous) from += ' (ambiguous: policies of equal standing name this address differently)';
  if (d.others.length) from += ` · +${d.others.length} other name${d.others.length === 1 ? '' : 's'}: ${d.others.join(', ')}`;
  return from;
}
