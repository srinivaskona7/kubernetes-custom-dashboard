/** Journey status words, the failure root, and how sure a destination name is. */
import type { DestinationName, IngressRefusedRow, JourneyPath, JourneyPathNode } from '../../api';
import type { Tone } from '../../components/ui';
import { decidedByText } from './ingress/refused-view';

/**
 * The one tooltip for every external/BTP TCP timing shown as "Connection duration" or an
 * open-for time: it is a connection's lifetime, never an HTTP/application latency. One constant,
 * imported at each use site, so the wording can never drift between them.
 */
export const CONNECTION_DURATION_TIP =
  'HTTP/application-level latency is not available for this connection. The value represents observed connection duration from proxy access data.';

export function confidenceOf(d: DestinationName | null | undefined): 'explicit' | 'inferred' | 'undeclared' {
  if (!d) return 'undeclared';
  if (d.ambiguous) return 'inferred';
  return d.source === 'networkpolicy' || d.source === 'networkpolicy-ipblock' ? 'explicit' : 'inferred';
}

export function hopStatus(n: Pick<JourneyPathNode, 'kind' | 'codeClass' | 'failed' | 'seen' | 'undeclared'>): { word: string; tone: Tone } {
  if (n.kind === 'edge' || n.kind === 'notRead') return { word: 'Unknown', tone: 'unknown' };
  if (n.kind === 'external') {
    if (n.failed) return { word: 'Error', tone: 'bad' };
    if (!n.seen) return { word: 'Unknown', tone: 'unknown' };
    return { word: 'Observed', tone: 'unknown' }; // A TCP record proves observation, not application success or permission.
  }
  if (n.codeClass === 'ok') return { word: 'Success', tone: 'ok' };
  return n.codeClass ? { word: 'Error', tone: 'bad' } : { word: 'Unknown', tone: 'unknown' };
}

/** The earliest gateway or workload hop whose code class is not ok: where a failure is attributed. */
export function firstFailingNode(path: JourneyPath): JourneyPathNode | undefined {
  return path.nodes.find(n => (n.kind === 'gateway' || n.kind === 'workload') && n.codeClass && n.codeClass !== 'ok');
}

/**
 * The earliest failing gateway/workload hop, and why. A refusal's `decidedBy` names the policy
 * only when a decider was resolved without inference; an inferred decider stays a candidate on
 * the hop's own HTTP code, never promoted to the node. Wording for the policy's name comes from
 * `decidedByText` — never re-worded here.
 */
export function failureRoot(path: JourneyPath, refusal?: Pick<IngressRefusedRow, 'decidedBy'>): { node: string; reason: string } | null {
  const first = firstFailingNode(path);
  if (!first) return null;
  const code = first.code ? `HTTP ${first.code}` : 'no response';
  const deciders = refusal?.decidedBy ?? [];
  if (deciders.length) {
    const { text: names } = decidedByText({ decidedBy: deciders });
    const exact = deciders.find(p => !p.policyInferred);
    if (exact) return { node: names, reason: 'Authorization policy denied request' };
    return { node: first.label, reason: `${code} · no ALLOW rule matched (${names}, inferred)` };
  }
  return { node: first.label, reason: code };
}
