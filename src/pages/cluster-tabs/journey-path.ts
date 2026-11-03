/**
 * Traces → Journeys → Path: one row per node the journey passed, top to bottom. Exact links are
 * solid, inferred ones dashed and always counted. An external node's time is how long a connection
 * stayed open, so it is never written as a latency.
 */
import type { JourneyPath, JourneyPathEdge, JourneyPathNode, Trace } from '../../api';
import type { Tone } from '../../components/ui';
import { ms } from './traces-view';

export interface PathRow {
  node: JourneyPathNode;
  link: JourneyPathEdge | null;
  dashed: boolean;
  linkText: string | null;
  timing: string;
  tone: Tone;
  failing: boolean;
}

export function linkLine(e: JourneyPathEdge): string {
  if (e.link === 'inferred') return e.candidates > 0 ? `inferred · 1 of ${e.candidates}${e.candidates > 1 ? ' in flight' : ''}` : 'declared, not observed';
  return e.transitMs === null ? 'exact' : `exact · transit ${ms(e.transitMs)}`;
}

export function nodeTiming(n: JourneyPathNode): string {
  if (n.kind === 'edge') return 'no timing: the load balancer writes no access log';
  if (n.kind === 'notRead') return n.reason ?? 'not read';
  if (n.kind === 'external') {
    if (!n.seen) return n.reason ?? 'no line in this window';
    const opened = n.openedAtMs === null || n.openedAtMs === undefined ? 'opened' : `opened +${ms(n.openedAtMs)} in`;
    const open = n.openForMs === null || n.openForMs === undefined ? '' : `, open ${seconds(n.openForMs)}`;
    return `${opened}${open} · ${(n.protocol ?? 'tcp').toUpperCase()}, not a latency`;
  }
  const d = n.durationMs === null || n.durationMs === undefined ? 'no duration' : ms(n.durationMs);
  if (n.upstreamMs === null || n.upstreamMs === undefined || n.proxyOverheadMs === null || n.proxyOverheadMs === undefined) return `${d} · split not logged`;
  return `${d} · app ${Math.round(n.upstreamMs)} · px ${Math.round(n.proxyOverheadMs)}`;
}

/**
 * The Edge node's own non-timing facts: the LB Service and the Gateways fronting it, already read
 * elsewhere in the same request. `null` (a failed read) and a missing key (an older server) both
 * render no line for that fact — never a 0 or an "absent" reading of a real failure. Never a client
 * address, an IP, or the CIDRs behind `sourceRangesCount`.
 */
export function edgeFactLines(n: JourneyPathNode): string[] {
  if (n.kind !== 'edge' || !n.edge) return [];
  const lines: string[] = [];
  const lb = n.edge.lb;
  if (lb) {
    if (lb.type) lines.push(lb.addressOnly ? `${lb.type} · address only` : lb.hostname ? `${lb.type} · ${lb.hostname}` : lb.type);
    if (lb.externalTrafficPolicy) lines.push(`externalTrafficPolicy: ${lb.externalTrafficPolicy}`);
    if (lb.sourceRangesCount !== null && lb.sourceRangesCount !== undefined) lines.push(`${lb.sourceRangesCount} source range${lb.sourceRangesCount === 1 ? '' : 's'} configured`);
  }
  for (const g of n.edge.gateways ?? []) {
    for (const s of g.servers) {
      const tls = s.tlsMode ? (s.credentialName ? `${s.tlsMode}, ${s.credentialName}` : s.tlsMode) : 'no TLS';
      lines.push(`${g.name}: ${s.hosts.join(', ')} (${tls})`);
    }
  }
  return lines;
}


/** Connection lifetime in seconds, so it can never be read as a request's milliseconds. */
function seconds(v: number): string {
  return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
}

export function nodeTone(n: JourneyPathNode): Tone {
  if (n.kind === 'edge' || n.kind === 'notRead') return 'unknown';
  if (n.kind === 'external') return n.failed ? 'bad' : n.undeclared ? 'warn' : n.seen ? 'ok' : 'unknown';
  return n.codeClass === 'ok' ? 'ok' : n.codeClass ? 'bad' : 'unknown';
}

export function pathRows(path: JourneyPath): PathRow[] {
  const into = new Map(path.edges.map(e => [e.to, e]));
  return path.nodes.map(node => {
    const link = into.get(node.id) ?? null;
    const tone = nodeTone(node);
    return { node, link, dashed: link?.link === 'inferred', linkText: link ? linkLine(link) : null, timing: nodeTiming(node), tone, failing: tone === 'bad' };
  });
}

export function pathEmptyLine(t: Pick<Trace, 'journeyPath' | 'pathReason'>, summary: { classCounts?: Partial<Record<string, number>> } | undefined): string | null {
  if (t.journeyPath) return null;
  const c = summary?.classCounts ?? {};
  const app = (c.app ?? 0) + (c['egress-declared'] ?? 0) + (c['egress-undeclared'] ?? 0);
  if (app === 0 && (c.probe ?? 0) + (c['direct-or-tls'] ?? 0) > 0) return 'This window holds only health checks and scanners, so there is no app path to draw. Generate traffic through the approuter and refresh.';
  return t.pathReason ?? 'No path could be built for this journey.';
}
