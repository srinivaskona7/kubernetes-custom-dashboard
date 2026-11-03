/**
 * Finding one resource in the data the cluster page already holds.
 *
 * The drawer never fetches — see `resources/registry.tsx` for why. This is the other half of
 * that bargain: given a `ResourceRef`, dig the matching row out of a payload the page fetched
 * already. Opening a drawer therefore costs a lookup, not a round trip, and the drawer's
 * contents stay live with the rest of the page for free.
 *
 * ## Why resolvers compose
 *
 * No single payload holds every Kind. The overview has workloads, pods, nodes and namespaces;
 * networking has Services and Ingresses; storage has PVCs; and so on. Rather than one resolver
 * that knows about every endpoint — which would force the cluster page to fetch all of them on
 * mount just so a drawer *might* work — each tab contributes the resolver for the data it
 * already has, and `combineResolvers` tries them in turn.
 *
 * The consequence is deliberate and worth stating: a `?res=Service/...` deep link opens with
 * "not in view" unless the Networking tab is mounted. That is the truthful answer. The
 * alternative is a drawer that silently fires a request the rest of the console has been
 * carefully built to avoid, and an operator cannot tell a slow drawer from a slow cluster.
 */
import type {
  AutoscalingData,
  CertificatesData,
  ClusterOverview,
  HelmData,
  NetworkingData,
  PodRow,
  StorageData,
  WorkloadRow
} from '../api';
import type { ResourceRef } from './types';

/** What every resolver looks like: a ref in, a row or `undefined` out. */
export type Resolver = (ref: ResourceRef) => unknown | undefined;

/**
 * First resolver with an answer wins; `undefined` from all of them means "not in view".
 *
 * Nulls are filtered so a tab can pass `data && makeXResolver(data)` without a guard at every
 * call site.
 */
export function combineResolvers(...resolvers: (Resolver | null | undefined)[]): Resolver {
  const live = resolvers.filter((r): r is Resolver => typeof r === 'function');
  return ref => {
    for (const r of live) {
      const hit = r(ref);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
}

/** Namespaced match. Cluster-scoped Kinds carry `namespace: null` and match on name alone. */
const sameObject = (row: { namespace?: string | null; name: string }, ref: ResourceRef) =>
  row.name === ref.name && (ref.namespace === null || row.namespace === ref.namespace);

// ------------------------------------------------------------------ overview

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

/** Every pod on the page, flattened out of its workload. */
function allPods(data: ClusterOverview): PodRow[] {
  const out: PodRow[] = [];
  for (const w of data.workloads.items) {
    for (const p of w.pods ?? []) out.push(p);
  }
  return out;
}

/** Workloads, their pods and containers, nodes, and compliance namespaces. */
export function makeOverviewResolver(data: ClusterOverview | null): Resolver {
  return (ref: ResourceRef) => {
    if (!data) return undefined;

    if (WORKLOAD_KINDS.has(ref.kind)) {
      // Kind is part of the match, not just namespace and name: a Deployment and a StatefulSet
      // can legitimately share a name in one namespace, and matching on name alone would open
      // the wrong object's drawer with no sign that it had.
      return data.workloads.items.find(
        (w: WorkloadRow) => w.kind === ref.kind && w.namespace === ref.namespace && w.name === ref.name
      );
    }

    // A Container ref addresses its pod; the renderer picks the container out by `ref.container`.
    if (ref.kind === 'Pod' || ref.kind === 'Container') {
      return allPods(data).find(p => p.namespace === ref.namespace && p.name === ref.name);
    }

    if (ref.kind === 'Node') return data.health.nodes.items.find(n => n.name === ref.name);
    if (ref.kind === 'Namespace') return data.compliance.namespaces.find(n => n.namespace === ref.name);

    return undefined;
  };
}

// ---------------------------------------------------------------- networking

/** Services, Ingresses, Gateway API Gateways and HTTPRoutes, and VirtualServices. */
export function makeNetworkingResolver(data: NetworkingData | null | undefined): Resolver {
  return (ref: ResourceRef) => {
    if (!data) return undefined;
    switch (ref.kind) {
      case 'Service':
        return data.services?.find(r => sameObject(r, ref));
      case 'Ingress':
        return data.ingresses?.find(r => sameObject(r, ref));
      case 'Gateway':
        return data.gateways?.find(r => sameObject(r, ref));
      case 'HTTPRoute':
        return data.httproutes?.find(r => sameObject(r, ref));
      case 'VirtualService':
        return data.virtualservices?.find(r => sameObject(r, ref));
      default:
        return undefined;
    }
  };
}

// ------------------------------------------------------------------- storage

/** PersistentVolumeClaims and ResourceQuotas. LimitRanges have no registry Kind yet. */
export function makeStorageResolver(data: StorageData | null | undefined): Resolver {
  return (ref: ResourceRef) => {
    if (!data) return undefined;
    if (ref.kind === 'PersistentVolumeClaim') return data.pvcs?.find(r => sameObject(r, ref));
    if (ref.kind === 'ResourceQuota') return data.quotas?.find(r => sameObject(r, ref));
    return undefined;
  };
}

// --------------------------------------------------------------- autoscaling

/** HorizontalPodAutoscalers and CronJobs. */
export function makeAutoscalingResolver(data: AutoscalingData | null | undefined): Resolver {
  return (ref: ResourceRef) => {
    if (!data) return undefined;
    if (ref.kind === 'HorizontalPodAutoscaler') return data.hpas?.find(r => sameObject(r, ref));
    if (ref.kind === 'CronJob') return data.cronjobs?.find(r => sameObject(r, ref));
    return undefined;
  };
}

// -------------------------------------------------------------- certificates

export function makeCertificatesResolver(data: CertificatesData | null | undefined): Resolver {
  return (ref: ResourceRef) =>
    data && ref.kind === 'Certificate' ? data.certificates?.find(r => sameObject(r, ref)) : undefined;
}

// ---------------------------------------------------------------------- helm

/**
 * Helm releases.
 *
 * A release's namespace is nullable on the wire — a release Secret whose namespace could not be
 * attributed — so the comparison tolerates null on the row while still requiring the name.
 */
export function makeHelmResolver(data: HelmData | null | undefined): Resolver {
  return (ref: ResourceRef) =>
    data && ref.kind === 'HelmRelease'
      ? data.releases?.find(r => r.name === ref.name && (ref.namespace === null || r.namespace === ref.namespace))
      : undefined;
}
