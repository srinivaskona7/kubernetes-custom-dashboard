/**
 * Traces → Outbound: the headline and the words its table prints. Pure, so it is tested without a DOM.
 */
import type { TraceOutboundRow } from '../../api';
import { isFailing } from './service-map-layout';

export interface OutboundHeadline {
  workloads: number;
  destinations: number;
  external: number;
  connections: number;
  failing: number;
  /** Connections tied to a request, exactly or by time. */
  linked: number;
  /** Connections that carry no correlator — the ones a link has to be inferred for. */
  headerless: number;
  crowded: number;
}

export function outboundHeadline(rows: readonly TraceOutboundRow[]): OutboundHeadline {
  const to = new Map(rows.map(r => [r.to.id, r.to.kind]));
  return {
    workloads: new Set(rows.map(r => r.from.id)).size,
    destinations: to.size,
    external: [...to.values()].filter(k => k === 'external').length,
    connections: rows.reduce((n, r) => n + r.connections, 0),
    failing: rows.filter(isFailing).length,
    linked: rows.reduce((n, r) => n + r.exact + r.inferred, 0),
    headerless: rows.reduce((n, r) => n + r.inferred + r.unlinked, 0),
    crowded: rows.reduce((n, r) => n + r.crowded, 0)
  };
}

/** Binary units, and "—" for a count no line logged: an unknown is never printed as 0. */
export function byteText(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** How the row's connections were tied to requests, in the fewest words that stay true. */
export function linkSummary(r: Pick<TraceOutboundRow, 'exact' | 'inferred' | 'unlinked' | 'crowded'>): string {
  const parts: string[] = [];
  if (r.exact) parts.push(`${r.exact} exact`);
  if (r.inferred) parts.push(`${r.inferred} inferred${r.crowded ? ` (${r.crowded} crowded)` : ''}`);
  if (r.unlinked) parts.push(`${r.unlinked} no request`);
  return parts.join(' · ') || '—';
}

/**
 * The From cell's tooltip: the caller in full. The cell prints a fitted name, and the td's derived
 * title would repeat that fitted text over the cell padding, so both carry this one.
 */
export function fromTitle(r: Pick<TraceOutboundRow, 'from'>): string {
  const who = r.from.namespace ? `${r.from.namespace}/${r.from.name}` : r.from.name;
  return `${who} — its sidecar logged these calls on the way out.`;
}
