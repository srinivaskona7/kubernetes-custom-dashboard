/**
 * Every sub-tab of Ingress & Traffic and Distributed Traces opens with its problems, worst first
 * (spec docs/superpowers/specs/2026-09-27-ingress-traces-cleanup-design.md). One shape for both tabs;
 * each deriver returns `null` when its source was not read, so the strip can say Unavailable instead
 * of "no problems". `[]` is "read, none found".
 *
 * Every problem is clickable: a row with nowhere to go is left out rather than shown dead.
 */
import type { IngressAccess, IngressAttention, IngressHost, ServiceMapEdge, ServiceMapNode, Trace, TraceEndpointStat, TraceOutboundRow, TrafficErrorGroup } from '../../api';
import { destinationLabel } from './destination-label';
import { declaredBy, type PolicyRead } from './egress-view';
import { attentionTarget, failuresAreBucketed, joinGaps, TRAFFIC_SECTION_IDS, type TrafficSectionId } from './ingress/edge-view';
import type { PathHop } from './ingress/path-view';
import { edgeId, endpointDrill, isFailing, type EndpointDrill } from './service-map-layout';

export type ProblemSeverity = 'bad' | 'warn' | 'info';

/** Where an Ingress problem lands: the sub-tab, plus what to select, search or scroll to there. */
export interface IngressTarget {
  section: TrafficSectionId;
  host?: string;
  text?: string;
  /** The namespace of the object `text` names, so a same-named object elsewhere is never the landing. */
  namespace?: string;
  key?: string;
  anchor?: string;
}

/** Where a Traces problem lands: a journey drill, or one arrow on the service map. */
export type TracesTarget = { drill: EndpointDrill } | { edge: string } | { outbound: string };

export interface Problem<T> {
  key: string;
  severity: ProblemSeverity;
  title: string;
  detail?: string;
  count?: number;
  target: T;
}

const RANK: Record<ProblemSeverity, number> = { bad: 0, warn: 1, info: 2 };

/** Bad, then warn, then info; a higher count first inside a severity; the input order breaks ties. */
export function sortProblems<T>(ps: readonly Problem<T>[]): Problem<T>[] {
  return ps
    .map((p, i) => ({ p, i }))
    .sort((a, b) => RANK[a.p.severity] - RANK[b.p.severity] || (b.p.count ?? 0) - (a.p.count ?? 0) || a.i - b.i)
    .map(x => x.p);
}

/* ------------------------------------------------------------------ Ingress & Traffic */

const SEVERITY: Record<IngressAttention['severity'], ProblemSeverity> = { critical: 'bad', warning: 'warn', info: 'info' };
/** Attention kinds whose `ref` is a Host header, so the row can select that host. */
const HOST_KINDS = new Set<string>(['app-5xx', 'app-404', 'idle-host']);
const nameOfRef = (ref: unknown): string | undefined => (typeof ref === 'string' && ref ? ref.split('/').pop() || undefined : undefined);
const nsOfRef = (ref: unknown): string | undefined => (typeof ref === 'string' && ref.includes('/') ? ref.slice(0, ref.lastIndexOf('/')) || undefined : undefined);
/** Attention kinds judged from the request sample: without a gateway read they are not evidence. */
export const SAMPLE_KINDS: ReadonlySet<string> = HOST_KINDS;

/** srv's attention rows. A retired section (`listeners`) maps through SECTION_ALIASES; an unknown one stays on the Overview. */
export function attentionProblems(rows: IngressAttention[] | undefined): Problem<IngressTarget>[] | null {
  if (!rows) return null;
  return sortProblems(
    rows.map((r, i) => {
      const section = attentionTarget(r, TRAFFIC_SECTION_IDS) ?? 'ingress';
      const target: IngressTarget = { section };
      const name = nameOfRef(r.ref);
      if (HOST_KINDS.has(r.kind) && typeof r.ref === 'string' && r.ref) target.host = r.ref;
      else if (section === 'hosts' && name) {
        target.text = name;
        const ns = nsOfRef(r.ref);
        if (ns) target.namespace = ns;
      }
      return { key: `${r.kind}:${i}`, severity: SEVERITY[r.severity] ?? 'info', title: r.title, detail: r.detail, target };
    })
  );
}

/** Policies that refused requests, then the hosts refused most. AuthorizationPolicies unread is `null`, never "none". */
/** An IPv4 literal, or a bracketed IPv6 one, with an optional port. */
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])(:\d+)?$/i;

export function accessProblems(access: IngressAccess | null | undefined): Problem<IngressTarget>[] | null {
  if (!access || access.unavailable.authorizationPolicies) return null;
  const out: Problem<IngressTarget>[] = [];
  for (const p of access.policies) {
    const denied = p.denied ?? 0;
    if (denied > 0) {
      // An allowlist refusing unknown clients is the policy working, not a fault: info, counted.
      out.push({ key: `ap:${p.namespace}/${p.name}`, severity: 'info', title: `AuthorizationPolicy ${p.namespace}/${p.name}`, detail: `refused ${denied}`, count: denied, target: { section: 'clients', text: p.name, namespace: p.namespace } });
    }
  }
  // A bare-IP Host header is a scanner that never named a site: counted as one item, not listed by address.
  const direct = access.deniedByHost.filter(h => IP_HOST.test(h.host));
  for (const h of access.deniedByHost.filter(h => !IP_HOST.test(h.host)).slice(0, 5)) {
    out.push({ key: `host:${h.host}`, severity: 'info', title: h.host, detail: `${h.count} refused`, count: h.count, target: { section: 'clients', host: h.host } });
  }
  if (direct.length) {
    const n = direct.reduce((sum, h) => sum + h.count, 0);
    out.push({ key: 'host:direct-ip', severity: 'info', title: 'Direct-IP requests', detail: `${n} refused across ${direct.length} addresses`, count: n, target: { section: 'clients' } });
  }
  return sortProblems(out);
}

/**
 * The Overview strip: srv's attention rows plus the policy-refusal lines Access control lists, so the
 * two sub-tabs never disagree on whether a policy refused anything. Refused-host lines stay on
 * Access control. Policies unread add nothing; an unread attention list is still `null`.
 */
export function overviewProblems(attention: Problem<IngressTarget>[] | null, access: IngressAccess | null | undefined): Problem<IngressTarget>[] | null {
  if (!attention) return null;
  const policies = (accessProblems(access) ?? []).filter(p => p.key.startsWith('ap:'));
  return sortProblems([...attention, ...policies]);
}

/**
 * Each sub-tab's badge: the number of rows its Problems strip lists, the same number the strip's own
 * header prints. An empty strip gets no badge, and an unread one (`null`) none either, never a 0.
 */
export function problemBadges<K extends string>(strips: Partial<Record<K, readonly Problem<unknown>[] | null>>): Partial<Record<K, number | null>> {
  const out: Partial<Record<K, number | null>> = {};
  for (const k of Object.keys(strips) as K[]) {
    const n = strips[k]?.length ?? 0;
    out[k] = n > 0 ? n : null;
  }
  return out;
}

/** The failure buckets that are the operator's own; policy, TLS and direct-IP refusals are the edge working. */
const APP_BUCKETS = new Set<string>(['app-failed', 'not-routed']);

/** App-owned failing groups, 5xx first. An older srv sends no buckets, so server-class groups stand in. */
export function failureProblems(errors: TrafficErrorGroup[] | undefined, limit = 8): Problem<IngressTarget>[] | null {
  if (!errors) return null;
  // `bucket: null` is srv's "unclassified", not an old server: only an absent field is.
  const bucketed = failuresAreBucketed(errors);
  // A group the server left unbucketed is not proven to be the edge working, so it stays, as info.
  const mine = errors.filter(g => (bucketed ? !g.bucket || APP_BUCKETS.has(g.bucket) : g.class === 'server'));
  return sortProblems(
    mine.map(
      (g): Problem<IngressTarget> => ({
        key: g.key,
        severity: bucketed && !g.bucket ? 'info' : g.class === 'server' ? 'bad' : 'warn',
        title: [g.code === 0 ? 'No response' : String(g.code), g.method, g.path].filter(Boolean).join(' '),
        detail: bucketed && !g.bucket ? ['Not classified', g.authority].filter(Boolean).join(' · ') : (g.authority ?? undefined),
        count: g.count,
        target: { section: 'failures', key: g.key }
      })
    )
  ).slice(0, limit);
}

/** The Failures strip's empty line when it set refusals aside: says so, so it never reads clean beside the failing list. */
export function failuresEmptyLine(errors: readonly TrafficErrorGroup[] | undefined): string | undefined {
  const all = errors ?? [];
  const sum = (gs: readonly TrafficErrorGroup[]) => gs.reduce((n, g) => n + g.count, 0);
  // A server without buckets: the strip listed only 5xx, so the 4xx below are named, not hidden.
  if (!failuresAreBucketed([...all])) {
    const n = sum(all.filter(g => g.class !== 'server'));
    return n > 0 ? `No server errors · ${n.toLocaleString('en-US')} client failures listed below` : undefined;
  }
  const n = sum(all.filter(g => g.bucket && !APP_BUCKETS.has(g.bucket)));
  return n > 0 ? `No app failures · ${n.toLocaleString('en-US')} refused at the edge` : undefined;
}

/** Hosts the edge saw whose published chain has a gap (no DNSEntry, Gateway server, certificate or route), busiest first. */
export function hostGapProblems(hosts: readonly IngressHost[] | undefined): Problem<IngressTarget>[] {
  const out: Problem<IngressTarget>[] = [];
  for (const h of hosts ?? []) {
    const gaps = joinGaps(h);
    if (!gaps.length || !h.host) continue;
    out.push({ key: `gap:${h.key}`, severity: 'warn', title: h.host, detail: gaps.join(', '), count: h.requests, target: { section: 'hosts', host: h.host } });
  }
  return sortProblems(out);
}

/** Network Path hops in warn or bad state, each anchored to its card on Gateway & path. */
export function pathProblems(hops: readonly PathHop[]): Problem<IngressTarget>[] {
  return sortProblems(
    hops
      .filter(h => h.state === 'bad' || h.state === 'warn')
      .map(
        (h): Problem<IngressTarget> => ({
          key: `hop:${h.id}`,
          severity: h.state as ProblemSeverity,
          title: h.title,
          detail: h.reason ?? h.why,
          target: { section: 'gateway', anchor: `hop-${h.id}` }
        })
      )
  );
}

/* ------------------------------------------------------------------ Distributed Traces */

/** Endpoints that failed (5xx or no response is bad, 4xx warn), or whose p95 reached `slowMs`. */
export function endpointProblems(endpoints: readonly TraceEndpointStat[] | undefined, traces: readonly Trace[], slowMs: number): Problem<TracesTarget>[] | null {
  if (!endpoints) return null;
  const out: Problem<TracesTarget>[] = [];
  for (const e of endpoints) {
    const title = `${e.method ?? ''} ${e.destination?.display ?? e.host ?? ''}${e.path ?? ''}`.trim();
    const key = `${e.method}|${e.host}|${e.path}`;
    if (e.errors > 0) {
      const five = e.codes.some(c => c.code >= 500 || c.code === 0);
      out.push({ key, severity: five ? 'bad' : 'warn', title, detail: `${e.errors} of ${e.journeys} failed`, count: e.errors, target: { drill: endpointDrill(e, traces) } });
    } else if (e.p95Ms !== null && e.p95Ms >= slowMs) {
      out.push({ key, severity: 'warn', title, detail: `p95 ${e.p95Ms} ms`, target: { drill: endpointDrill(e, traces) } });
    }
  }
  return sortProblems(out);
}

/** Service-map arrows with failed calls, named caller → callee; red on the map's own 5% line. */
export function edgeProblems(map: { nodes: ServiceMapNode[]; edges: ServiceMapEdge[] } | undefined): Problem<TracesTarget>[] | null {
  if (!map) return null;
  const byId = new Map(map.nodes.map(n => [n.id, n]));
  const name = (id: string) => {
    const n = byId.get(id);
    return n ? destinationLabel(n).primary : id;
  };
  return sortProblems(
    map.edges
      .filter(e => e.errors > 0)
      .map(
        (e): Problem<TracesTarget> => ({
          key: edgeId(e),
          severity: isFailing(e) ? 'bad' : 'warn',
          title: `${name(e.from)} → ${name(e.to)}`,
          detail: `${e.errors} of ${e.calls} calls failed`,
          count: e.errors,
          target: { edge: edgeId(e) }
        })
      )
  );
}

/**
 * Outbound pairs that failed, then external addresses no policy names. An address is only called
 * undeclared when the NetworkPolicy list was read in full (`declaredBy` answers Unavailable or
 * Unverified otherwise). A failing row with no sample journey lands on its own Outbound row; an
 * undeclared one with nothing to open is left out.
 */
export function outboundProblems(rows: readonly TraceOutboundRow[] | undefined, policies: PolicyRead, loaded: ReadonlySet<string>): Problem<TracesTarget>[] | null {
  if (!rows) return null;
  const out: Problem<TracesTarget>[] = [];
  for (const r of rows) {
    const key = `${r.from.id}→${r.to.id}`;
    const id = r.sample?.traceId;
    // A row whose journey is not held lands on its own Outbound row instead: a failure is never dropped.
    const target: TracesTarget = id
      ? { drill: loaded.has(id) ? { selectId: id, fetchId: null, search: id } : { selectId: null, fetchId: id, search: id } }
      : { outbound: key };
    const title = `${r.from.name} → ${destinationLabel(r.to).primary}`;
    if (r.errors > 0) {
      out.push({ key, severity: isFailing(r) ? 'bad' : 'warn', title, detail: `${r.errors} of ${r.connections} failed`, count: r.errors, target });
    } else if (id && r.to.kind === 'external' && declaredBy(r.to, policies).text === 'Undeclared') {
      out.push({ key, severity: 'info', title, detail: 'No policy names this address', count: r.connections, target });
    }
  }
  return sortProblems(out);
}
