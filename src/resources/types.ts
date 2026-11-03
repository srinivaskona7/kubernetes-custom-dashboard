/**
 * The resource-centric layer's vocabulary.
 *
 * One `ResourceRef` addresses any Kubernetes object in the console, and one registry
 * entry per Kind says how to render it. The point is stated in the product spec as "do not
 * create five different Deployment detail implementations": a Deployment reached from the
 * Overview, from Reliability, from a Helm release's resource list and from search must open the
 * *same* renderer, because five implementations become five different answers about one object.
 *
 * Nothing here fetches. A registry entry is handed data the console already has — see
 * `registry.tsx` for why that is a constraint and not an oversight.
 */
import type { ReactNode } from 'react';
import type { Tone } from '../components/ui';

/**
 * Every Kind the registry can render. A string union rather than `string`, so that a typo in a
 * `ResourceLink` is a compile error instead of a drawer that opens empty, and so that
 * `Record<ResourceKind, …>` in the registry is exhaustive — adding a Kind here fails the build
 * until its renderer exists.
 */
export type ResourceKind =
  | 'Deployment'
  | 'StatefulSet'
  | 'DaemonSet'
  | 'Pod'
  | 'Container'
  | 'Node'
  | 'Service'
  | 'Ingress'
  | 'Gateway'
  | 'HTTPRoute'
  | 'VirtualService'
  | 'HorizontalPodAutoscaler'
  | 'CronJob'
  | 'PersistentVolumeClaim'
  | 'ResourceQuota'
  // PodDisruptionBudget and NetworkPolicy are deliberately absent. The server sends only
  // aggregates for both — `pdbCoveragePercent` / `pdbDrainBlockerCount` on reliability, and
  // `NetworkPolicyByNamespace { namespace, hasNetworkPolicy, policyCount }` on security. There
  // is no per-object row to render, and a Kind whose drawer could only show a count invents a
  // resource the API never sent. They return here when a collector ships their rows.
  | 'Certificate'
  | 'Namespace'
  | 'HelmRelease';

/**
 * A pointer to one live object.
 *
 * `namespace` is `null` for cluster-scoped Kinds (Node, Namespace). `container` is the one
 * exception to "a ref names an object": a container is not a Kubernetes object and has no name
 * of its own outside its pod, so it rides along on the Pod ref rather than getting a Kind whose
 * identity the API server would not recognise.
 */
export interface ResourceRef {
  kind: ResourceKind;
  namespace: string | null;
  name: string;
  container?: string;
}

/** A row in the drawer's Related Resources panel. Clicking one re-targets the drawer. */
export interface RelatedRef {
  /** What this object is to the one on screen — "Owner", "Backend", "Scale target". */
  relation: string;
  ref: ResourceRef;
  /** Optional trailing note: a replica count, a port, a status word. */
  note?: string;
}

/** One labelled fact in the drawer's identity or status block. */
export interface DetailField {
  label: string;
  value: ReactNode;
  /** Monospace the value — names, IPs, versions, image digests. */
  mono?: boolean;
}

/**
 * What a Kind's renderer produces.
 *
 * `verdict` is deliberately two fields. The spec's §34 requires the console's own Clear /
 * Warning / Attention vocabulary *alongside* the native Kubernetes word, never instead of it:
 * "Running", "Pending", "Bound" and "Degraded" carry information that a generic green pill
 * throws away, and an operator who sees only the pill has to go to kubectl to recover it.
 */
export interface ResourceView {
  /** The native Kubernetes status word — `Running`, `Bound`, `Progressing`. */
  status: string | null;
  /** The console's verdict about that status, for the pill's colour. */
  tone: Tone;
  identity: DetailField[];
  /** The Kind-specific body: spec and status fields worth reading without kubectl. */
  fields: DetailField[];
  related: RelatedRef[];
  /** Rendered under its own heading — a container list, a rule table, a policy summary. */
  extra?: ReactNode;
}

/**
 * How the drawer finds one object's data in a payload the console already fetched.
 *
 * `source` names the endpoint the console *already* calls for this Kind. The registry never adds
 * a fetch of its own: the spec's standing constraint is "do not add unnecessary API calls", and
 * a drawer that fired its own request per Kind would turn one click into an N+1 against the
 * cluster. Every Kind here is rendered from a payload some tab has already paid for.
 */
export interface ResourceDefinition {
  kind: ResourceKind;
  /** Plural label for list headings — "Deployments". */
  plural: string;
  /** True for Kinds the API server scopes to the cluster, not a namespace. */
  clusterScoped?: boolean;
  /** Which already-called endpoint holds this Kind's rows. */
  source: ResourceSource;
  /**
   * Where this Kind's data actually lives in the UI.
   *
   * Resolvers are registered by whichever tab is mounted, so a `?res=Service/...` link followed
   * from the Storage tab would find nothing — the Networking tab that owns Services is not on
   * screen to lend its payload. `home` is how the page fixes that: on a ref whose Kind lives
   * elsewhere, it switches to the owning tab (and sub-section) first, and the drawer fills in as
   * soon as that tab's fetch lands.
   *
   * Omitted for the Kinds the cluster page resolves itself from the overview payload — workloads,
   * Pods, Containers, Nodes, Namespaces — which are reachable from every tab and need no move.
   */
  home?: { tab: string; section?: string };
  /** Build the view from the located row. `row` is `unknown` — each renderer narrows its own. */
  render: (row: unknown, ref: ResourceRef) => ResourceView;
}

/**
 * The endpoints the drawer can read from. Each maps to an `api` method the console already
 * calls on some tab, so opening a drawer hits the server cache rather than the cluster.
 */
export type ResourceSource =
  | 'overview'
  | 'pods'
  | 'networking'
  | 'storage'
  | 'autoscaling'
  | 'certificates'
  | 'security'
  | 'policy'
  | 'mesh'
  | 'helm';

/** Serialise a ref for the URL: `Kind/namespace/name[/container]`. */
export function refToParam(ref: ResourceRef): string {
  const parts = [ref.kind, ref.namespace ?? '-', ref.name];
  if (ref.container) parts.push(ref.container);
  return parts.map(encodeURIComponent).join('/');
}

/**
 * Parse a ref back out of the URL, or `null` if it is not one.
 *
 * Returns `null` rather than throwing or guessing: the value arrives from a URL an operator may
 * have edited or a bookmark that outlived a rename, and a malformed `?res=` should leave the
 * page it decorates working rather than blanking it.
 */
export function refFromParam(raw: string | null, isKind: (k: string) => boolean): ResourceRef | null {
  if (!raw) return null;
  const parts = raw.split('/').map(decodeURIComponent);
  if (parts.length < 3) return null;
  const [kind, namespace, name, container] = parts;
  if (!kind || !name || !isKind(kind)) return null;
  return {
    kind: kind as ResourceKind,
    namespace: !namespace || namespace === '-' ? null : namespace,
    name,
    ...(container ? { container } : {})
  };
}
