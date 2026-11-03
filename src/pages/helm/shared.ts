/**
 * Shared vocabulary for the seven Helm release tabs.
 *
 * The reason this file exists rather than each tab defining its own: "what does `helm-managed`
 * mean", "which group does a Service belong in", and "what does deployed look like" are answers the
 * seven screens have to give identically. A Service that reads `Networking` on the Resources tab and
 * `Services` in the graph is two different claims about the same object.
 */
import type { HelmEdgeType, HelmRelationship, HelmRelatedData, HelmRelatedResource } from '../../api';
import type { Tone } from '../../components/ui';
import { isKind, RESOURCE_REGISTRY } from '../../resources/registry';
import { refToParam } from '../../resources/types';

/**
 * Helm's own status vocabulary. `deployed` is the only one that means "this is what is running";
 * `superseded` is normal history, and everything else is a rollout that stopped somewhere it
 * should not have.
 */
export function statusTone(status: string | null): Tone {
  switch (status) {
    case 'deployed':
      return 'ok';
    case 'superseded':
    case 'uninstalled':
      return 'unknown';
    case 'pending-install':
    case 'pending-upgrade':
    case 'pending-rollback':
      return 'warn';
    default:
      return 'bad';
  }
}

/**
 * The resource groups, in the order an operator works down them.
 *
 * Workloads first because a broken release is almost always a broken workload; Configuration and
 * Security late because they are what you check once the workload has told you which value it is
 * unhappy about. `Other supported resources` is last and is deliberately named "supported" — it
 * holds the Kinds this console can read and has no better home for, not "everything else in the
 * release", which would imply a completeness the group does not have.
 */
export const GROUP_ORDER = [
  // The graph's synthetic root. It is not a Kubernetes object, so it never appears on the
  // Resources tab — but the graph groups by the same vocabulary and needs somewhere to put it.
  'Helm Release',
  'Workloads',
  'Pods',
  'Networking',
  'Scaling',
  'Storage',
  'Configuration',
  'Security and Policy',
  'Certificates',
  'Other supported resources'
] as const;

export type HelmGroup = (typeof GROUP_ORDER)[number];

/** Groups sorted into `GROUP_ORDER`, with anything unexpected appended rather than dropped. */
export function orderGroups(groups: string[]): string[] {
  const known = GROUP_ORDER.filter(g => groups.includes(g));
  const rest = groups.filter(g => !(GROUP_ORDER as readonly string[]).includes(g)).sort();
  return [...known, ...rest];
}

/**
 * What each relationship claims, and — in the tooltip — what evidence would have to exist for it.
 *
 * The distinction the spec insists on and the one this console had to earn: `helm-owned` is a
 * resource Helm's own manifest rendered, `helm-managed` is a resource carrying Helm's release
 * labels, and `runtime` is a resource Kubernetes created underneath one of those. Labelling all
 * three "Helm-owned" is the mistake — a Pod is not in the manifest, and deleting the release does
 * not remove a PVC that outlives it.
 */
export const RELATIONSHIP: Record<HelmRelationship, { label: string; tone: Tone; why: string }> = {
  'helm-owned': {
    label: 'Helm-owned',
    tone: 'accent',
    why: 'This object appears in the release’s rendered manifest — Helm created it and Helm removes it.'
  },
  'helm-managed': {
    label: 'Helm-managed',
    tone: 'accent',
    why: 'This object carries the release’s Helm metadata labels but is not in the rendered manifest read here.'
  },
  'owner-reference': {
    label: 'Owner',
    tone: 'ok',
    why: 'A Kubernetes ownerReference on this object points at a resource the release owns.'
  },
  selector: {
    label: 'Selector',
    tone: 'ok',
    why: 'A label selector on a release resource matches this object.'
  },
  'configuration-reference': {
    label: 'References',
    tone: 'warn',
    why: 'A release resource names this object in its spec — a volume, a valueFrom or a backend.'
  },
  runtime: {
    label: 'Runtime relationship',
    tone: 'unknown',
    why: 'Kubernetes created this object while running the release’s resources. Helm does not know about it.'
  }
};

/** What each graph edge is drawn from. Every entry names a field, never a resemblance. */
export const EDGE: Record<HelmEdgeType, { label: string; colour: string; why: string }> = {
  'helm-managed': {
    label: 'Helm-managed',
    colour: '#8b7bd8',
    why: 'The release’s rendered manifest contains this object.'
  },
  owner: { label: 'Owner', colour: '#5eb87a', why: 'metadata.ownerReferences on the target names the source.' },
  selector: { label: 'Selector', colour: '#5eb87a', why: 'The source’s label selector matches the target’s labels.' },
  'routes-to': { label: 'Routes to', colour: '#4a9fd8', why: 'An Ingress, APIRule or VirtualService names the target as a backend.' },
  targets: { label: 'Targets', colour: '#4a9fd8', why: 'A scaleTargetRef or equivalent names the target directly.' },
  mounts: { label: 'Mounts', colour: '#d8a24a', why: 'A volume on the source mounts the target.' },
  references: { label: 'References', colour: '#d8a24a', why: 'A valueFrom, envFrom or secretName on the source names the target.' },
  'tls-binding': { label: 'TLS binding', colour: '#d85a5a', why: 'A Certificate or Ingress TLS block binds the target Secret.' },
  'associated-with': {
    label: 'Associated with',
    colour: '#6b7280',
    why: 'A weaker association than the types above, and the edge says which field produced it.'
  }
};

/** The status pill's tone, or `unknown` for the Kinds that genuinely publish none. */
export function liveTone(resource: HelmRelatedResource): Tone {
  return (resource.status?.tone ?? 'unknown') as Tone;
}

/**
 * A ReplicaSet Kubernetes keeps only as rollout history — scaled to zero and holding no Pods.
 *
 * Every `kubectl rollout` leaves one behind, so a release upgraded twenty times has twenty of them.
 * They are genuinely part of the release's live footprint, so dropping them would be a lie; but
 * listed alongside the Deployment that owns them they bury it, and they are the reason a two-workload
 * release reports twenty-four workload objects.
 *
 * `desired === 0` alone is not enough: a Deployment mid-scale-down has `desired: 0` while Pods are
 * still terminating, and that ReplicaSet is live news. Requiring `ready === 0` too keeps it visible.
 */
export function isSupersededReplicaSet(r: HelmRelatedResource): boolean {
  return (
    r.kind === 'ReplicaSet' &&
    r.status?.desired === 0 &&
    (r.status?.ready ?? 0) === 0
  );
}

/**
 * Which resources are worth an operator's attention, worst first.
 *
 * `bad` before `warn`, and nothing else: a resource whose Kind reports no status is not a finding,
 * and a resource that is `ok` is not either. Sorting by name inside a tone keeps the list stable
 * across refreshes, which matters when an operator is working down it.
 */
export function byLiveRisk(a: HelmRelatedResource, b: HelmRelatedResource): number {
  const rank = (r: HelmRelatedResource) =>
    r.status?.tone === 'bad' ? 0 : r.status?.tone === 'warn' ? 1 : r.status?.tone === 'unknown' ? 2 : 3;
  return rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
}

// Byte formatting lives in `src/format.ts` and is imported directly by the one Helm view that
// needs it. There used to be a second copy here that divided by 1024 but printed `kB`/`MB`,
// so Helm manifest sizes read ~2.4% low against every other size in the console.

// -------------------------------------------------------------- the live-resource drawer's twin

/**
 * The address of a Kind's canonical detail view on the cluster page, or null when this console
 * has no detail view for it.
 *
 * The Helm release page is its own route and does not mount `ResourceDetailDrawer`, so a
 * `<ResourceLink>` here would set `?res=` with nothing on screen to read it — a link that looks
 * live and does nothing. Instead a live-resource link *leaves* this page for the cluster page,
 * which owns the drawer, the registry and the per-Kind renderer. `ClusterDetail` moves itself to
 * the Kind's `home` tab on arrival, so the tab is carried only to spare the operator a flash of
 * Overview first.
 */
export function liveResourceHref(
  clusterId: string,
  kind: string,
  namespace: string | null,
  name: string
): string | null {
  if (!isKind(kind)) return null;
  const home = RESOURCE_REGISTRY[kind].home;
  const res = refToParam({ kind, namespace, name });
  const parts = [`res=${encodeURIComponent(res)}`];
  if (home) {
    parts.unshift(`tab=${encodeURIComponent(home.tab)}`);
    if (home.section) parts.splice(1, 0, `section=${encodeURIComponent(home.section)}`);
  }
  return `/clusters/${encodeURIComponent(clusterId)}?${parts.join('&')}`;
}

// ------------------------------------------------------------------------ the health grid

/**
 * One tile on Insights, computed from **live** resource state — never from the manifest.
 *
 * The distinction is the whole point of the tab. A release's manifest says a Deployment with
 * three replicas exists; only the live object says whether three are running. A grid built from
 * the manifest would report `3 / 3 Ready` on a cluster where none of them ever started.
 *
 * `ready` is null for the Kinds that publish no status at all (ConfigMap, Secret): the tile shows
 * the count and the word `present`, because `2 / 2 Healthy` beside two ConfigMaps is a tick
 * nothing ever checked. `noStatus` counts objects inside a *mixed* group that report nothing, so
 * the denominator can stay honest without hiding them.
 */
export interface HelmHealthTile {
  key: string;
  label: string;
  kinds: string[];
  /** Objects in a healthy native state, or null when the group has no status to report. */
  ready: number | null;
  /** Objects whose Kind does publish a status. The denominator. */
  total: number;
  /** Objects present but statusless — excluded from `total`, reported in the caption. */
  noStatus: number;
  /** The word after the numbers: `Ready`, `Running`, `Bound`, `present`. */
  word: string;
  tone: Tone;
  /** The read labels behind this tile, for `scope.of` — so a refused read says Unavailable. */
  labels: string[];
}

const TILE_SPEC: { key: string; label: string; kinds: string[]; word: string; labels: string[]; statusless?: boolean }[] = [
  {
    key: 'workloads',
    label: 'Workloads',
    kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'],
    word: 'Ready',
    labels: ['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs']
  },
  { key: 'pods', label: 'Pods', kinds: ['Pod'], word: 'Running', labels: ['pods'] },
  { key: 'services', label: 'Services', kinds: ['Service'], word: 'with endpoints', labels: ['services', 'endpointslices'] },
  {
    key: 'routing',
    label: 'Ingress / APIRules',
    kinds: ['Ingress', 'APIRule', 'VirtualService', 'Gateway'],
    word: 'routing',
    labels: ['ingresses', 'apirules', 'virtualservices', 'istio-gateways']
  },
  { key: 'hpa', label: 'Autoscalers', kinds: ['HorizontalPodAutoscaler'], word: 'scaling', labels: ['hpa'] },
  { key: 'pvc', label: 'Volume claims', kinds: ['PersistentVolumeClaim'], word: 'Bound', labels: ['pvcs'] },
  { key: 'pdb', label: 'Disruption budgets', kinds: ['PodDisruptionBudget'], word: 'with headroom', labels: ['pdbs'] },
  { key: 'configmaps', label: 'ConfigMaps', kinds: ['ConfigMap'], word: 'present', labels: ['configmaps'], statusless: true },
  { key: 'secrets', label: 'Secrets', kinds: ['Secret'], word: 'present', labels: ['secrets'], statusless: true }
];

/** The nine Insights tiles, in the order §16 fixes. Always nine — an empty group says `0`. */
export function healthTiles(data: HelmRelatedData): HelmHealthTile[] {
  return TILE_SPEC.map(spec => {
    const members = data.resources.filter(r => spec.kinds.includes(r.kind));
    if (spec.statusless) {
      return {
        key: spec.key,
        label: spec.label,
        kinds: spec.kinds,
        ready: null,
        total: members.length,
        noStatus: members.length,
        word: spec.word,
        // Neutral on purpose: a ConfigMap that exists is neither healthy nor unhealthy.
        tone: 'unknown' as Tone,
        labels: spec.labels
      };
    }
    const withStatus = members.filter(r => r.status !== null);
    const ready = withStatus.filter(r => r.status!.tone === 'ok').length;
    const worst = withStatus.some(r => r.status!.tone === 'bad')
      ? 'bad'
      : withStatus.some(r => r.status!.tone === 'warn')
        ? 'warn'
        : withStatus.length > 0 && ready === withStatus.length
          ? 'ok'
          : 'unknown';
    return {
      key: spec.key,
      label: spec.label,
      kinds: spec.kinds,
      ready,
      total: withStatus.length,
      noStatus: members.length - withStatus.length,
      word: spec.word,
      tone: worst as Tone,
      labels: spec.labels
    };
  });
}

// ---------------------------------------------------------------------------- findings

export type HelmSeverity = 'high' | 'medium' | 'low';

/**
 * One thing wrong with the release, as read off live objects.
 *
 * `evidence` is required and names the field the finding came from, for the same reason the graph
 * edges do: a finding an operator cannot trace is a finding they have to re-derive by hand before
 * they dare act on it.
 */
export interface HelmFinding {
  id: string;
  severity: HelmSeverity;
  title: string;
  detail: string;
  evidence: string;
  /** The object to open. Null only for a rendered entry that has no live object to open. */
  resource: { kind: string; namespace: string | null; name: string } | null;
}

const SEVERITY_RANK: Record<HelmSeverity, number> = { high: 0, medium: 1, low: 2 };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Every finding this page can support with a field it actually read, worst first.
 *
 * Deliberately not a health score. Each entry is a specific object in a specific state, and the
 * severities mean one thing only: `high` is broken now, `medium` will break a rollout or a
 * disruption, `low` is a standing risk with no incident attached. Nothing here is inferred from a
 * name, a chart or a label.
 */
export function findingsFor(data: HelmRelatedData): HelmFinding[] {
  const out: HelmFinding[] = [];

  for (const m of data.rendered.missing) {
    const where = m.namespace ? `${m.namespace}/${m.name}` : m.name;
    if (m.readable) {
      out.push({
        id: `missing:${m.kind}/${where}`,
        severity: 'high',
        title: `${m.kind} ${m.name} is in the manifest but not on the cluster`,
        detail:
          'The release rendered this object and the live list for its Kind was read in full, so its absence is real — it was deleted, or it never applied.',
        evidence: `rendered manifest lists ${m.kind}/${where}; the live ${m.kind} list does not`,
        resource: { kind: m.kind, namespace: m.namespace, name: m.name }
      });
    } else {
      out.push({
        id: `unconfirmed:${m.kind}/${where}`,
        severity: 'medium',
        title: `Could not confirm ${m.kind} ${m.name} exists`,
        detail:
          'This object is in the rendered manifest, but the live list for its Kind could not be read. That is a gap in this view, not a missing resource — do not read it as deleted.',
        evidence: `the ${m.kind} list read failed; rendered manifest lists ${m.kind}/${where}`,
        resource: null
      });
    }
  }

  for (const r of data.resources) {
    const facts = r.facts || {};

    if (r.status && r.status.tone === 'bad') {
      out.push({
        id: `status:${r.id}`,
        severity: 'high',
        title: `${r.kind} ${r.name} — ${r.status.text}`,
        detail: 'The object’s own status reports this. Nothing here is derived.',
        evidence: `native status of ${r.kind}/${r.name}`,
        resource: { kind: r.kind, namespace: r.namespace, name: r.name }
      });
    } else if (r.status && r.status.tone === 'warn') {
      out.push({
        id: `status:${r.id}`,
        severity: 'medium',
        title: `${r.kind} ${r.name} — ${r.status.text}`,
        detail: 'The object’s own status reports this. Nothing here is derived.',
        evidence: `native status of ${r.kind}/${r.name}`,
        resource: { kind: r.kind, namespace: r.namespace, name: r.name }
      });
    }

    const privileged = stringList(facts.privilegedContainers);
    if (privileged.length > 0) {
      out.push({
        id: `privileged:${r.id}`,
        severity: 'high',
        title: `${r.kind} ${r.name} runs ${privileged.length === 1 ? 'a privileged container' : `${privileged.length} privileged containers`}`,
        detail: `${privileged.join(', ')} — a container with privileged or allowPrivilegeEscalation set can escape to the node.`,
        evidence: 'securityContext.privileged / allowPrivilegeEscalation on the pod template',
        resource: { kind: r.kind, namespace: r.namespace, name: r.name }
      });
    }

    if (r.kind === 'Deployment' && facts.rolloutComplete === false) {
      out.push({
        id: `rollout:${r.id}`,
        severity: 'medium',
        title: `Deployment ${r.name} has not finished rolling out`,
        detail:
          typeof facts.rolloutMessage === 'string' && facts.rolloutMessage
            ? facts.rolloutMessage
            : 'The Progressing condition has not reached NewReplicaSetAvailable, so some pods are still on the previous template.',
        evidence: `status.conditions[type=Progressing]${typeof facts.rolloutReason === 'string' && facts.rolloutReason ? ` reason=${facts.rolloutReason}` : ''}`,
        resource: { kind: r.kind, namespace: r.namespace, name: r.name }
      });
    }

    if (r.kind === 'HorizontalPodAutoscaler' && r.status && (r.status as { atMax?: boolean }).atMax) {
      out.push({
        id: `hpa-max:${r.id}`,
        severity: 'medium',
        title: `${r.name} is at its maximum replica count`,
        detail: 'The autoscaler has nothing left to give — further load has nowhere to go.',
        evidence: 'status.currentReplicas equals spec.maxReplicas',
        resource: { kind: r.kind, namespace: r.namespace, name: r.name }
      });
    }

    if (r.kind === 'PodDisruptionBudget' && facts.disruptionsAllowed === 0) {
      out.push({
        id: `pdb:${r.id}`,
        severity: 'medium',
        title: `${r.name} is blocking voluntary disruption`,
        detail:
          'disruptionsAllowed is 0, so a node drain or an eviction will be refused until the covered pods recover.',
        evidence: 'status.disruptionsAllowed on the PodDisruptionBudget',
        resource: { kind: r.kind, namespace: r.namespace, name: r.name }
      });
    }

    if (r.kind === 'Certificate' && typeof facts.expiresAt === 'string') {
      const days = Math.floor((Date.parse(facts.expiresAt) - Date.now()) / 86_400_000);
      if (Number.isFinite(days) && days <= 30) {
        out.push({
          id: `cert:${r.id}`,
          severity: days <= 7 ? 'high' : 'medium',
          title:
            days < 0
              ? `Certificate ${r.name} expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
              : `Certificate ${r.name} expires in ${days} day${days === 1 ? '' : 's'}`,
          detail: 'Read from the Certificate’s own expiry field, not from the served TLS chain.',
          evidence: `status expiry field on ${r.kind}/${r.name}`,
          resource: { kind: r.kind, namespace: r.namespace, name: r.name }
        });
      }
    }

    const unbounded = stringList(facts.containersMissingResources);
    if (unbounded.length > 0) {
      out.push({
        id: `unbounded:${r.id}`,
        severity: 'low',
        title: `${r.kind} ${r.name} has ${unbounded.length === 1 ? 'a container' : `${unbounded.length} containers`} without CPU/memory bounds`,
        detail: `${unbounded.join(', ')} — a container with no requests cannot be scheduled predictably, and one with no memory limit can take the node down.`,
        evidence: 'resources.requests.cpu / requests.memory / limits.memory on the pod template',
        resource: { kind: r.kind, namespace: r.namespace, name: r.name }
      });
    }
  }

  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.resource?.kind ?? '').localeCompare(b.resource?.kind ?? '') ||
      a.title.localeCompare(b.title)
  );
}

export const SEVERITY_TONE: Record<HelmSeverity, Tone> = { high: 'bad', medium: 'warn', low: 'unknown' };
