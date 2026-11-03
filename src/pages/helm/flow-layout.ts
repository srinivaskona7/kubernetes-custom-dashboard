/**
 * Which column each graph node sits in, in the Architecture tab's `flow` layout.
 *
 * ## Why this is a `.ts` file and not part of `HelmArchitecture.tsx`
 *
 * It is the only part of that component with an answer that can be wrong rather than ugly, and this
 * project's vitest runs without a DOM (jsdom is unavailable from the registry), so anything inside a
 * `.tsx` cannot be tested at all. The drawing stays there; the reasoning lives here.
 *
 * ## Two rules, and the graph says which one applies
 *
 * `depth` — distance from the release along the edges that exist. This is the honest default and the
 * only rule that ever applied: a PVC reached through a StatefulSet sits one column right of one the
 * manifest rendered directly, and that is a fact about the release rather than a drawing convention.
 *
 * `ingress` — used only when some object in the release actually routes external traffic into a
 * Service of the release, which the graph states as a `routes-to` edge and nothing else. Under
 * `depth` that Ingress lands in whatever column the release reaches it in — typically beside the
 * ConfigMaps, below eighteen workloads — and the one thing an operator opening this tab wants to
 * trace, *where does a request go*, is the one thing the picture does not show. So when there is a
 * request path, depth becomes the request path.
 *
 * `ingress` is a tier assignment, not a traversal, and the distinction is worth stating plainly
 * because a layered picture invites being read as one: a Pod is two edges from a routed Service and
 * five from a ConfigMap, so a BFS puts the Pod left of the Deployment that owns it. The tiers are
 * fixed by role instead — ingress, front door, downstream, instances, attachments — and the front
 * door is the part that is still *read* rather than declared: a Service is tier 1 because an ingress
 * names it as a backend, and a workload is tier 1 because it owns a Pod that Service selects.
 * Nothing here is decided by a name resembling another name.
 */
import type { HelmGraphEdge, HelmGraphNode } from '../../api';

/** The rule that produced a column map, so the UI can say which picture it is showing. */
export type FlowRule = 'depth' | 'ingress';

export interface FlowLayout {
  columns: Map<string, number>;
  rule: FlowRule;
}

/** The synthetic root node's id. It is not a Kubernetes object and never gets a tier. */
const RELEASE = 'release';

/**
 * Kinds that can front external traffic. Membership alone earns tier 0 *only* for a node that also
 * has a `routes-to` edge — an Ingress with no readable backend is not a front door to anything, and
 * putting it at the head of the picture would claim a path the server never read.
 */
const INGRESS_KINDS = new Set(['Ingress', 'HTTPRoute', 'VirtualService', 'Gateway']);

/** Kinds that serve or run a workload's traffic. Tier 1 when routed into, tier 2 otherwise. */
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']);
const SERVICE_KINDS = new Set(['Service']);

/**
 * The instances, not the declarations. A ReplicaSet is here rather than with the workloads because
 * it is a generation of one, and an operator reads it the way they read a Pod.
 */
const INSTANCE_KINDS = new Set(['Pod', 'ReplicaSet', 'Job', 'EndpointSlice']);

const TIER_INGRESS = 0;
const TIER_FRONT = 1;
const TIER_DOWNSTREAM = 2;
const TIER_INSTANCE = 3;
/** Everything a workload hangs off rather than passes traffic to: config, policy, storage, scaling. */
const TIER_ATTACHED = 4;

function adjacency(edges: HelmGraphEdge[], keep: (e: HelmGraphEdge) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!keep(e)) continue;
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }
  return out;
}

/**
 * Columns by distance from the release root along the edges that exist.
 *
 * A node no edge reaches lands in the last column — it is related to the release (it is in the
 * payload) without a traversable path, and hiding that would be the graph lying by omission.
 */
export function dependencyColumns(nodes: HelmGraphNode[], edges: HelmGraphEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  const next = adjacency(edges, () => true);
  const root = nodes.find(n => n.id === RELEASE)?.id ?? nodes[0]?.id;
  if (!root) return out;
  out.set(root, 0);
  let frontier = [root];
  while (frontier.length > 0) {
    const later: string[] = [];
    for (const id of frontier) {
      const depth = out.get(id)!;
      for (const to of next.get(id) ?? []) {
        if (out.has(to)) continue;
        out.set(to, depth + 1);
        later.push(to);
      }
    }
    frontier = later;
  }
  const orphanColumn = Math.max(0, ...out.values()) + 1;
  for (const n of nodes) if (!out.has(n.id)) out.set(n.id, orphanColumn);
  return out;
}

/** The ingress nodes: a routing Kind that the server read a backend for. */
function ingressNodes(nodes: HelmGraphNode[], edges: HelmGraphEdge[]): Set<string> {
  const routing = new Set(edges.filter(e => e.type === 'routes-to').map(e => e.from));
  return new Set(nodes.filter(n => routing.has(n.id) && INGRESS_KINDS.has(n.kind)).map(n => n.id));
}

/**
 * The workloads behind a routed Service, found by walking owner edges *backwards* from its Pods.
 *
 * Forwards there is no edge from a Service to a Deployment — a Service selects Pods, and the Pod is
 * what carries the ownership chain up to the ReplicaSet and the Deployment. So the front door is
 * reached by following `selector` forwards and then `owner` in reverse, which is the same pair of
 * fields `kubectl describe` follows and not an inference from anything's name.
 */
function frontWorkloads(routed: Set<string>, nodes: HelmGraphNode[], edges: HelmGraphEdge[]): Set<string> {
  const selects = adjacency(edges, e => e.type === 'selector' && routed.has(e.from));
  const served = new Set<string>();
  for (const list of selects.values()) for (const id of list) served.add(id);

  // child -> owners, so a Pod can name the ReplicaSet that made it.
  const owners = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== 'owner' || e.from === RELEASE) continue;
    const list = owners.get(e.to);
    if (list) list.push(e.from);
    else owners.set(e.to, [e.from]);
  }

  const kindOf = new Map(nodes.map(n => [n.id, n.kind]));
  const out = new Set<string>();
  const seen = new Set<string>(served);
  let frontier = [...served];
  while (frontier.length > 0) {
    const later: string[] = [];
    for (const id of frontier) {
      for (const owner of owners.get(id) ?? []) {
        if (seen.has(owner)) continue;
        seen.add(owner);
        later.push(owner);
        if (WORKLOAD_KINDS.has(kindOf.get(owner) ?? '')) out.add(owner);
      }
    }
    frontier = later;
  }
  return out;
}

/**
 * Columns as the request path: ingress, front door, downstream, instances, attachments.
 *
 * The release node stays at column 0 beside the ingress. It is the origin of ownership rather than
 * of traffic, and it is drawn as the leftmost thing either way, so its edges still read left to
 * right — but it is not a hop in the path and nothing is tiered relative to it.
 */
export function ingressTierColumns(
  nodes: HelmGraphNode[],
  edges: HelmGraphEdge[],
  ingress: Set<string>
): Map<string, number> {
  const routed = new Set(edges.filter(e => e.type === 'routes-to' && ingress.has(e.from)).map(e => e.to));
  const front = frontWorkloads(routed, nodes, edges);
  const out = new Map<string, number>();
  for (const n of nodes) {
    if (n.id === RELEASE || ingress.has(n.id)) out.set(n.id, TIER_INGRESS);
    else if (routed.has(n.id) || front.has(n.id)) out.set(n.id, TIER_FRONT);
    else if (SERVICE_KINDS.has(n.kind) || WORKLOAD_KINDS.has(n.kind)) out.set(n.id, TIER_DOWNSTREAM);
    else if (INGRESS_KINDS.has(n.kind)) out.set(n.id, TIER_DOWNSTREAM);
    else if (INSTANCE_KINDS.has(n.kind)) out.set(n.id, TIER_INSTANCE);
    else out.set(n.id, TIER_ATTACHED);
  }
  return out;
}

/**
 * The `flow` layout's columns, and which of the two rules produced them.
 *
 * The choice is made from the payload rather than offered as a third option in the dropdown: an
 * operator cannot be expected to know whether this release has a readable request path, and a menu
 * entry that silently degrades to the same picture as the one above it is worse than no entry.
 */
export function flowColumns(nodes: HelmGraphNode[], edges: HelmGraphEdge[]): FlowLayout {
  const ingress = ingressNodes(nodes, edges);
  if (ingress.size === 0) return { columns: dependencyColumns(nodes, edges), rule: 'depth' };
  return { columns: ingressTierColumns(nodes, edges, ingress), rule: 'ingress' };
}

/** What the columns mean, for the caption under the canvas. Indexed by tier. */
export const TIER_LABELS = ['ingress', 'front door', 'downstream', 'instances', 'attached config'] as const;
