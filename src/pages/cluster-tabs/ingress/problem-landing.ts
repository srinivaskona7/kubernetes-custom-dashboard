/**
 * The Problems strip on each Ingress & Traffic sub-tab, and where a press on one lands.
 *
 * `problems.ts` derives the rows; this decides which rows each of the five sub-tabs leads with and
 * turns a row's target into the state its screen needs (a selected row, a search). Pure, so the
 * landing — the part a person judges the strip by — is tested without a DOM.
 *
 * `null` on a sub-tab is "its source was not read" and renders Unavailable; `[]` is a read that
 * found nothing. Overview shows every attention row; the other sub-tabs show only the rows that
 * land on them, so a problem is listed where pressing it leads.
 */
import type { IngressAccess, IngressHost, TrafficErrorGroup, TrafficIngress } from '../../../api';
import { accessProblems, attentionProblems, failureProblems, hostGapProblems, pathProblems, SAMPLE_KINDS, sortProblems, type IngressTarget, type Problem } from '../problems';
import { notFromServer, type TrafficSectionId } from './edge-view';
import type { PathHop } from './path-view';

export type TrafficProblems = Record<TrafficSectionId, Problem<IngressTarget>[] | null>;

/**
 * Attention kinds with a card of their own on Gateway & path, by the element id that card carries.
 * `attentionProblems` keys a row `${kind}:${index}`, so the kind is read back from the key.
 */
const GATEWAY_ANCHOR: Record<string, string> = { 'dead-envoyfilter': 'gateway-envoyfilters' };
const kindOf = (p: Problem<IngressTarget>) => p.key.slice(0, p.key.lastIndexOf(':'));
const withGatewayAnchor = (p: Problem<IngressTarget>): Problem<IngressTarget> => {
  const anchor = GATEWAY_ANCHOR[kindOf(p)];
  return anchor && !p.target.anchor ? { ...p, target: { ...p.target, anchor } } : p;
};

export function trafficProblems({
  ingress,
  errors,
  noEvidence,
  edgeRead,
  hops
}: {
  ingress: TrafficIngress | undefined;
  errors: TrafficErrorGroup[] | undefined;
  /** No request log was read: the failure list is not evidence of anything. */
  noEvidence: boolean;
  /** An ingress window exists (`ingressWasRead`). */
  edgeRead: boolean;
  /** Both Network Path lanes, or `null` when the path was not assembled. */
  hops: PathHop[] | null;
}): TrafficProblems {
  // Without a gateway read, rows srv judged from the request sample ("no traffic", 404s) are not evidence.
  const rows = attentionProblems(ingress?.attention)?.map(withGatewayAnchor).filter(p => edgeRead || !SAMPLE_KINDS.has(kindOf(p))) ?? null;
  const gaps = rows && edgeRead ? hostGapProblems(ingress?.hosts) : [];
  const attention = rows && sortProblems([...rows, ...gaps]);
  const on = (section: TrafficSectionId) => attention?.filter(p => p.target.section === section) ?? null;
  const gateway = on('gateway');
  const hosts = on('hosts');
  return {
    ingress: attention,
    // The Hosts & TLS list is the sample's: unread, a strip of config rows alone is kept, and none is Unavailable.
    hosts: !edgeRead && !hosts?.length ? null : hosts,
    failures: noEvidence ? null : failureProblems(errors),
    clients: edgeRead ? accessProblems(ingress?.access) : null,
    gateway: gateway && sortProblems([...gateway, ...(hops ? pathProblems(hops) : [])])
  };
}

/** The Failures list state a press lands in: a group's own row, or the list filtered to a host. */
export function failuresLanding(t: IngressTarget): { klass: 'all'; search: string; selectedKey: string | null } {
  return { klass: 'all', search: t.key ? '' : (t.host ?? ''), selectedKey: t.key ?? null };
}

/**
 * Hosts & TLS: select the host's row, or search for it when the capped list does not hold it, so
 * the landing shows "no host matches" rather than an unrelated selection.
 */
export function hostFocus(hosts: readonly IngressHost[], host: string | null | undefined): { selectKey: string | null; search: string | null } | null {
  if (!host) return null;
  const h = hosts.find(x => x.host === host);
  return h ? { selectKey: h.key, search: null } : { selectKey: null, search: host };
}

/** Access control: the AuthorizationPolicies row a policy problem names, or the Denied by host row. */
export function clientsFocus(
  access: IngressAccess | null | undefined,
  t: Pick<IngressTarget, 'host' | 'text' | 'namespace'> | null | undefined
): { table: 'policies' | 'denied'; key: string } | null {
  if (!access || !t) return null;
  if (t.host) return access.deniedByHost.some(d => d.host === t.host) ? { table: 'denied', key: t.host } : null;
  // A target without a namespace (an older row) takes the first namespace holding the name.
  const p = t.text ? access.policies.find(x => x.name === t.text && (!t.namespace || x.namespace === t.namespace)) : undefined;
  return p ? { table: 'policies', key: `${p.namespace}/${p.name}` } : null;
}

/**
 * The URL a Problems press lands on: its section, with the Proxies read panel closed (one panel at
 * a time) and `?res=` dropped as any section change does.
 *
 * One write on purpose. react-router 6's `setSearchParams(prev => ...)` hands every call the
 * params of the last render, so `setActiveSection` and `setProxiesOpen(false)` in one handler
 * each start from the same `prev` and the second undoes the first.
 */
export function landingParams(prev: URLSearchParams, section: TrafficSectionId): URLSearchParams {
  const p = new URLSearchParams(prev);
  p.set('section', section);
  p.delete('proxies');
  p.delete('res');
  return p;
}

/**
 * Why each sub-tab's strip is Unavailable when its deriver returned `null`: the one read it is
 * missing, never a generic "not read". Mirrors the branches of `trafficProblems`.
 */
export function problemsUnreadWhy({
  ingress,
  edgeRead,
  notReadWhy
}: {
  ingress: TrafficIngress | undefined;
  edgeRead: boolean;
  /** `accessLogEvidence(...).notRead.why`: why the request log is not evidence. */
  notReadWhy: string;
}): Record<TrafficSectionId, string> {
  const attention = notFromServer('The attention list').why;
  const clients = !edgeRead
    ? 'no ingress gateway proxy was read for this cluster'
    : !ingress?.access
      ? notFromServer('AuthorizationPolicies').why
      : 'could not read AuthorizationPolicies';
  return { ingress: attention, hosts: attention, gateway: attention, failures: notReadWhy, clients };
}
