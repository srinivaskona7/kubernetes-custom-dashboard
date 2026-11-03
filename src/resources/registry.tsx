/**
 * One renderer per Kind, and the lookup that finds an object's row in a payload the console has
 * already fetched.
 *
 * ## The constraint that shapes this file
 *
 * A registry entry receives data; it never asks for any. Every Kind below is rendered out of an
 * endpoint some tab already calls, so opening a drawer costs a cache read rather than a cluster
 * read. The alternative — a `fetch` per Kind — turns one operator click into an N+1 against a
 * managed API server, and `k8s.js` already carries a concurrency gate and a 429 backoff because
 * this console has hit that wall before.
 *
 * ## Why the renderers narrow `unknown`
 *
 * `find` returns a row out of a loosely-typed payload, so each renderer casts once, at the top,
 * to the `api.ts` interface that endpoint actually ships. That cast is the seam where a wrong
 * assumption shows up as `undefined` on screen rather than as a silent wrong value — see the
 * per-cluster envelope alias trap in the project notes, where `tsc` blessed a wrong alias and
 * three tables rendered empty.
 */
import type {
  CertificateRow,
  ContainerRow,
  CronJobRow,
  GatewayRow,
  HelmRelease,
  HpaRow,
  HttpRouteRow,
  IngressRow,
  NamespaceRow,
  NodeRow,
  PodRow,
  PvcRow,
  QuotaRow,
  ServiceRow,
  VirtualServiceRow,
  WorkloadRow
} from '../api';
import { ago, bytes, cores, cpu as cpuValue } from '../format';
// The HPA formatters are shared with the Autoscaling tab on purpose: the drawer and the table must
// not disagree about whether an unreported replica count is a zero.
import { boundsLabel, hpaLimitLabel, hpaStatus, metricLine, replicaCount } from '../pages/cluster-tabs/autoscaling-format';
import type { Tone } from '../components/ui';
import type { DetailField, RelatedRef, ResourceDefinition, ResourceKind, ResourceRef, ResourceView } from './types';

/** `Running`/`Bound`/`Active` are healthy; the rest earn their own colour. */
function toneForPhase(phase: string | null): Tone {
  switch ((phase ?? '').toLowerCase()) {
    case 'running':
    case 'bound':
    case 'active':
    case 'succeeded':
    case 'ready':
      return 'ok';
    case 'pending':
    case 'progressing':
      return 'warn';
    case 'failed':
    case 'unbound':
    case 'lost':
      return 'bad';
    default:
      return 'unknown';
  }
}

const f = (label: string, value: DetailField['value'], mono = false): DetailField => ({ label, value, mono });

/** `—` for anything the cluster did not report, so a blank never reads as a zero. */
const or = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

/**
 * CPU is millicores on the wire; memory is bytes. Both are unreadable raw.
 *
 * Two CPU helpers, split by subject exactly as `format.ts` splits the formatters behind them:
 *
 *  - `cpu` for a workload, pod or container — one object's request, limit or live sample. Rendered
 *    at millicore precision, because a 7m sample formatted as cores reads "0 cores" and a drawer
 *    that says a running container uses no CPU is worse than one that says nothing.
 *  - `cpuCapacity` for a node's allocatable and requested totals, which are cores and are read as
 *    cores.
 */
const cpu = (n: number | null | undefined) => (n === null || n === undefined ? '—' : cpuValue(n));
const cpuCapacity = (n: number | null | undefined) => (n ? `${cores(n)} cores` : '—');
const mem = (n: number | null | undefined) => (n ? bytes(n) : '—');

// ---------------------------------------------------------------------------------------------
// Workloads — Deployment / StatefulSet / DaemonSet share one renderer, because they differ in
// which fields are *populated*, not in which fields exist. `workloads.js` already normalises the
// three into one `WorkloadRow`.
// ---------------------------------------------------------------------------------------------

function renderWorkload(raw: unknown, ref: ResourceRef): ResourceView {
  const w = raw as WorkloadRow;
  const related: RelatedRef[] = [];

  // Every pod is a destination. This is the spec's "every workload should lead to its Pods".
  for (const p of w.pods ?? []) {
    related.push({
      relation: 'Pod',
      ref: { kind: 'Pod', namespace: p.namespace, name: p.name },
      note: `${p.phase}${p.restarts ? ` · ${p.restarts} restarts` : ''}`
    });
  }
  // The nodes it landed on — the way from "this workload is unhappy" to "this node is".
  for (const n of w.nodes ?? []) {
    related.push({ relation: 'Node', ref: { kind: 'Node', namespace: null, name: n } });
  }

  return {
    status: w.state,
    tone: w.healthy ? 'ok' : 'bad',
    identity: [
      f('Kind', ref.kind),
      f('Namespace', w.namespace, true),
      f('Age', w.createdAt ? ago(w.createdAt) : '—'),
      f('Image', or(w.image), true)
    ],
    fields: [
      f('Ready', `${w.ready} / ${w.desired}`),
      f('Available', or(w.availableReplicas)),
      f('Updated', or(w.updatedReplicas)),
      f('Restarts', or(w.restarts)),
      // Generation vs observedGeneration is the honest rollout signal: a controller that has
      // not observed the current generation has not started the rollout the spec asks for.
      f('Generation', `${or(w.generation)} observed ${or(w.observedGeneration)}`),
      f('Last restarted', w.restartedAt ? ago(w.restartedAt) : '—'),
      f('CPU request / limit', `${cpu(w.cpuRequest)} / ${cpu(w.cpuLimit)}`),
      f('Memory request / limit', `${mem(w.memoryRequest)} / ${mem(w.memoryLimit)}`),
      f('CPU in use', cpu(w.cpuUsage)),
      f('Memory in use', mem(w.memoryUsage))
    ],
    related
  };
}

// ---------------------------------------------------------------------------------------------
// Pod and Container
// ---------------------------------------------------------------------------------------------

function renderPod(raw: unknown, _ref: ResourceRef): ResourceView {
  const p = raw as PodRow;
  const related: RelatedRef[] = [];
  if (p.node) related.push({ relation: 'Node', ref: { kind: 'Node', namespace: null, name: p.node } });

  // Containers are refs on the Pod, not objects of their own — see `ResourceRef.container`.
  for (const c of p.containers ?? []) {
    related.push({
      relation: c.init ? 'Init container' : 'Container',
      ref: { kind: 'Container', namespace: p.namespace, name: p.name, container: c.name },
      note: `${c.state}${c.restarts ? ` · ${c.restarts} restarts` : ''}`
    });
  }
  // Whole-block env sources are the only configuration reference the pod payload carries, and
  // they are exactly the spec's "every configuration reference should lead to its resource".
  // Rendered as notes rather than refs: ConfigMap and Secret have no list endpoint in this
  // console yet, so a link would lead to a drawer that cannot fill itself.
  return {
    status: p.phase,
    tone: toneForPhase(p.phase),
    identity: [
      f('Kind', 'Pod'),
      f('Namespace', p.namespace, true),
      f('Node', or(p.node), true),
      f('Age', p.startedAt ? ago(p.startedAt) : '—')
    ],
    fields: [
      f('Phase', or(p.phase)),
      f('Reason', or(p.reason)),
      f('Message', or(p.message)),
      f('Pod IP', or(p.podIP), true),
      f('QoS class', or(p.qosClass)),
      f('Restarts', or(p.restarts)),
      f('Containers', `${(p.containers ?? []).filter(c => c.ready).length} / ${(p.containers ?? []).length} ready`),
      f('CPU request / limit', `${cpu(p.cpuRequest)} / ${cpu(p.cpuLimit)}`),
      f('Memory request / limit', `${mem(p.memoryRequest)} / ${mem(p.memoryLimit)}`),
      f('CPU in use', cpu(p.cpuUsage)),
      f('Memory in use', mem(p.memoryUsage))
    ],
    related
  };
}

function renderContainer(raw: unknown, ref: ResourceRef): ResourceView {
  const p = raw as PodRow;
  const c = (p.containers ?? []).find((x: ContainerRow) => x.name === ref.container);
  if (!c) {
    return {
      status: null,
      tone: 'unknown',
      identity: [f('Kind', 'Container'), f('Pod', p.name, true)],
      fields: [f('Container', `'${ref.container}' is not in this pod's container list`)],
      related: [{ relation: 'Pod', ref: { kind: 'Pod', namespace: p.namespace, name: p.name } }]
    };
  }
  return {
    status: c.state,
    tone: c.ready ? 'ok' : c.state === 'running' ? 'warn' : 'bad',
    identity: [
      f('Kind', c.init ? 'Init container' : 'Container'),
      f('Pod', p.name, true),
      f('Namespace', p.namespace, true),
      f('Image', c.image, true)
    ],
    fields: [
      f('State', or(c.state)),
      f('Reason', or(c.reason)),
      f('Ready', c.ready ? 'Yes' : 'No'),
      f('Restarts', or(c.restarts)),
      f('Image digest', or(c.imageDigest), true),
      f('CPU request / limit', `${cpu(c.cpuRequest)} / ${cpu(c.cpuLimit)}`),
      f('Memory request / limit', `${mem(c.memoryRequest)} / ${mem(c.memoryLimit)}`),
      f('CPU in use', cpu(c.cpuUsage)),
      f('Memory in use', mem(c.memoryUsage)),
      // Names only. The collector never puts a value on the wire, and this is the surface where
      // someone would most expect one — so it says so rather than rendering an empty list.
      f('Env variables', c.envKeys?.length ? `${c.envKeys.length} (names only)` : 'none'),
      f(
        'Reads from',
        c.envFrom?.length ? c.envFrom.map(e => `${e.kind}/${e.name}`).join(', ') : 'nothing',
        true
      )
    ],
    related: [{ relation: 'Pod', ref: { kind: 'Pod', namespace: p.namespace, name: p.name } }]
  };
}

// ---------------------------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------------------------

function renderNode(raw: unknown, _ref: ResourceRef): ResourceView {
  const n = raw as NodeRow;
  const related: RelatedRef[] = (n.podsList ?? []).map(p => ({
    relation: 'Pod',
    ref: { kind: 'Pod' as const, namespace: p.namespace, name: p.name },
    note: p.phase
  }));
  return {
    status: n.unschedulable ? 'SchedulingDisabled' : n.ready ? 'Ready' : 'NotReady',
    tone: n.ready ? (n.unschedulable ? 'warn' : 'ok') : 'bad',
    identity: [
      f('Kind', 'Node'),
      f('Role', or(n.role)),
      f('Zone', or(n.zone), true),
      f('Instance type', or(n.instanceType), true),
      f('Age', n.createdAt ? ago(n.createdAt) : '—')
    ],
    fields: [
      f('Ready', n.ready ? 'Yes' : 'No'),
      f('Kubelet', or(n.version), true),
      f('OS', or(n.os)),
      f('Kernel', or(n.kernelVersion), true),
      f('Container runtime', or(n.containerRuntime), true),
      f('Schedulable', n.unschedulable ? 'No — cordoned' : 'Yes'),
      f('Pods', `${n.pods}${n.podCapacity ? ` / ${n.podCapacity}` : ''}`),
      // Allocatable, not capacity: capacity minus kubelet/system reservation is the number the
      // scheduler actually has, and quoting capacity overstates the headroom by a whole node's
      // reservation on every row.
      f('CPU allocatable', cpuCapacity(n.cpuAllocatable)),
      f('Memory allocatable', mem(n.memoryAllocatable)),
      f(
        'CPU requested',
        `${cpuCapacity(n.cpuRequested)}${n.cpuRequestedPercent != null ? ` (${n.cpuRequestedPercent}%)` : ''}`
      ),
      f('Memory requested', `${mem(n.memoryRequested)}${n.memoryRequestedPercent != null ? ` (${n.memoryRequestedPercent}%)` : ''}`),
      f('CPU in use', cpuCapacity(n.cpuUsage)),
      f('Memory in use', mem(n.memoryUsage)),
      f('Taints', n.taints?.length ? n.taints.join(', ') : 'none', true),
      f(
        'Problem conditions',
        n.problems?.length ? n.problems.map(p => `${p.type}${p.reason ? ` (${p.reason})` : ''}`).join(', ') : 'none'
      )
    ],
    related
  };
}

// ---------------------------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------------------------

function renderService(raw: unknown, _ref: ResourceRef): ResourceView {
  const s = raw as ServiceRow;
  return {
    status: s.type,
    tone: 'unknown',
    identity: [f('Kind', 'Service'), f('Namespace', s.namespace, true), f('Type', s.type)],
    fields: [
      f('Cluster IP', or(s.clusterIP), true),
      f(
        'Ports',
        s.ports?.length
          ? s.ports.map(p => `${p.name ? `${p.name}:` : ''}${p.port}→${p.targetPort}/${p.protocol}`).join(', ')
          : '—',
        true
      )
    ],
    related: []
  };
}

function renderGateway(raw: unknown, _ref: ResourceRef): ResourceView {
  const g = raw as GatewayRow;
  return {
    status: g.programmed === true ? 'Programmed' : g.programmed === false ? 'Not programmed' : null,
    tone: g.programmed === true ? 'ok' : g.programmed === false ? 'bad' : 'unknown',
    identity: [f('Kind', 'Gateway'), f('Namespace', g.namespace, true), f('Class', or(g.gatewayClassName), true)],
    fields: [
      f(
        'Listeners',
        g.listeners?.length
          ? g.listeners
              .map(l => `${l.name ? `${l.name} ` : ''}${l.hostname || '*'}:${l.port ?? '—'}/${l.protocol ?? '—'}${l.tls ? ' TLS' : ''}`)
              .join(', ')
          : '—',
        true
      )
    ],
    related: []
  };
}

function renderHttpRoute(raw: unknown, _ref: ResourceRef): ResourceView {
  const h = raw as HttpRouteRow;
  const related: RelatedRef[] = [];
  for (const parent of h.parents ?? []) {
    const [namespace, name] = parent.split('/');
    if (namespace && name) related.push({ relation: 'Gateway', ref: { kind: 'Gateway', namespace, name } });
  }
  for (const b of h.backends ?? []) {
    related.push({
      relation: 'Backend',
      ref: { kind: 'Service', namespace: b.namespace, name: b.name },
      note: b.port ? `port ${b.port}` : undefined
    });
  }
  return {
    status: h.accepted === true ? 'Accepted' : h.accepted === false ? 'Not accepted' : null,
    tone: h.accepted === true ? 'ok' : h.accepted === false ? 'bad' : 'unknown',
    identity: [f('Kind', 'HTTPRoute'), f('Namespace', h.namespace, true)],
    fields: [f('Hostnames', h.hostnames?.join(', ') || 'any', true)],
    related
  };
}

function renderVirtualService(raw: unknown, _ref: ResourceRef): ResourceView {
  const v = raw as VirtualServiceRow;
  const related: RelatedRef[] = [];
  for (const r of v.routes ?? []) {
    // A destination host is `svc.ns.svc.cluster.local` or a bare name; the first label is the
    // Service. Anything else is off-cluster and gets no link rather than a broken one.
    const first = r.destinationHost?.split('.')[0];
    if (first) {
      related.push({
        relation: 'Destination',
        ref: { kind: 'Service', namespace: v.namespace, name: first },
        note: r.destinationPort ? `port ${r.destinationPort}` : undefined
      });
    }
  }
  return {
    status: null,
    tone: 'unknown',
    identity: [f('Kind', 'VirtualService'), f('Namespace', v.namespace, true)],
    fields: [
      f('Hosts', v.hosts?.join(', ') || '—', true),
      f('Gateways', v.gateways?.join(', ') || '—', true),
      f(
        'Routes',
        v.routes?.length
          ? v.routes.map(r => `${r.destinationHost}${r.destinationPort ? `:${r.destinationPort}` : ''} (${r.weight}%)`).join(', ')
          : '—',
        true
      )
    ],
    related
  };
}

function renderIngress(raw: unknown, _ref: ResourceRef): ResourceView {
  const i = raw as IngressRow;
  const related: RelatedRef[] = [];
  for (const rule of i.rules ?? []) {
    for (const p of rule.paths ?? []) {
      if (p.backendService) {
        related.push({
          relation: 'Backend',
          ref: { kind: 'Service', namespace: i.namespace, name: p.backendService },
          note: `${rule.host}${p.path}`
        });
      }
    }
  }
  return {
    status: null,
    tone: 'unknown',
    identity: [f('Kind', 'Ingress'), f('Namespace', i.namespace, true), f('Class', or(i.ingressClassName), true)],
    fields: [
      f('Hosts', i.rules?.map(r => r.host).join(', ') || '—', true),
      f(
        'TLS',
        i.tls?.length ? i.tls.map(t => `${t.hosts.join(',')} → ${t.secretName ?? 'no secret'}`).join('; ') : 'none',
        true
      )
    ],
    related
  };
}

// ---------------------------------------------------------------------------------------------
// Scaling, storage, certificates
// ---------------------------------------------------------------------------------------------

function renderHpa(raw: unknown, _ref: ResourceRef): ResourceView {
  const h = raw as HpaRow;
  // The same verdict the Autoscaling table's Status pill shows. The drawer used to derive its own —
  // amber `ScalingLimited` on any ScalingLimited=True — so an HPA held at its *minimum*
  // (`TooFewReplicas`, an idle workload) read green in the table and amber here.
  const verdict = hpaStatus(h);
  return {
    status: verdict.label,
    tone: verdict.tone,
    identity: [
      f('Kind', 'HorizontalPodAutoscaler'),
      f('Namespace', h.namespace, true),
      f('Scale target', `${h.targetKind}/${h.targetName}`, true),
      f('Age', h.createdAt ? ago(h.createdAt) : '—')
    ],
    fields: [
      f('Replicas', `${replicaCount(h.currentReplicas)} current · ${replicaCount(h.desiredReplicas)} desired`),
      f('Bounds', boundsLabel(h.minReplicas, h.maxReplicas) ?? '—'),
      f('Limit', hpaLimitLabel(h)),
      f(
        'Metrics',
        h.metrics?.length
          ? h.metrics
              .map(m => metricLine(m))
              .map(line => `${line.subject}: ${line.reading}`)
              .join(', ')
          : '—',
        true
      ),
      f('Last scaled', h.lastScaleTime ? ago(h.lastScaleTime) : 'never'),
      f(
        'Conditions',
        // Each condition's own message, not just its reason. The Autoscaling tab used to carry a
        // second, local detail panel whose only advantage over this drawer was printing these
        // messages; the panel is gone and the messages moved here, so nothing was lost with it.
        h.conditions?.length
          ? h.conditions
              .map(c => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}${c.message ? ` — ${c.message}` : ''}`)
              .join(', ')
          : '—'
      )
    ],
    related: isKind(h.targetKind)
      ? [{ relation: 'Scale target', ref: { kind: h.targetKind as ResourceKind, namespace: h.namespace, name: h.targetName } }]
      : []
  };
}

function renderCronJob(raw: unknown, _ref: ResourceRef): ResourceView {
  const c = raw as CronJobRow;
  return {
    status: c.suspend ? 'Suspended' : 'Active',
    tone: c.suspend ? 'warn' : 'ok',
    identity: [
      f('Kind', 'CronJob'),
      f('Namespace', c.namespace, true),
      f('Schedule', c.schedule, true),
      f('Age', c.createdAt ? ago(c.createdAt) : '—')
    ],
    fields: [
      f('Suspended', c.suspend ? 'Yes — this schedule is not firing' : 'No'),
      f('Active runs', or(c.activeJobsCount)),
      f('Last scheduled', c.lastScheduleTime ? ago(c.lastScheduleTime) : 'never'),
      // Scheduled-but-never-succeeded is the failure this pair exists to expose: a job that
      // fires on time and fails every time looks identical to a healthy one on a count alone.
      f('Last succeeded', c.lastSuccessfulTime ? ago(c.lastSuccessfulTime) : 'never'),
      f('Concurrency policy', c.concurrencyPolicy)
    ],
    related: []
  };
}

function renderQuota(raw: unknown, _ref: ResourceRef): ResourceView {
  const q = raw as QuotaRow;
  return {
    status: null,
    tone: 'unknown',
    identity: [
      f('Kind', 'ResourceQuota'),
      f('Namespace', q.namespace, true),
      f('Age', q.createdAt ? ago(q.createdAt) : '—')
    ],
    // Server-formatted strings (`2Gi`, `500m`), passed through rather than re-parsed: the
    // quota API reports whatever unit the quota was written in, and converting to bytes here
    // would print a number the operator cannot match against their own manifest.
    fields: (q.dimensions ?? []).map(d => f(d.dimension, `${d.used} / ${d.hard}`, true)),
    related: []
  };
}

function renderNamespace(raw: unknown, _ref: ResourceRef): ResourceView {
  const n = raw as NamespaceRow;
  return {
    status: n.verdict,
    tone: n.findings ? 'bad' : n.warnings ? 'warn' : 'ok',
    identity: [
      f('Kind', 'Namespace'),
      f('Cluster', n.cluster, true),
      f('Type', n.system ? 'System namespace' : 'Workload namespace')
    ],
    fields: [
      f('Verdict', n.verdict),
      f('Findings', or(n.findings)),
      f('Warnings', or(n.warnings)),
      f('Checks run', or(n.checks?.length))
    ],
    related: []
  };
}

function renderHelmRelease(raw: unknown, _ref: ResourceRef): ResourceView {
  const r = raw as HelmRelease;
  const related: RelatedRef[] = [];
  for (const res of r.resources ?? []) {
    // `name` is nullable on a rendered resource — a manifest document the server could not
    // attribute. A ref without a name addresses nothing, so those stay in the release's own
    // resource table rather than becoming a link that opens an empty drawer.
    if (res.name && isKind(res.kind)) {
      related.push({
        relation: res.kind,
        ref: { kind: res.kind as ResourceKind, namespace: res.namespace ?? r.namespace, name: res.name }
      });
    }
  }
  return {
    status: r.status,
    tone: r.pendingRevision ? 'warn' : r.status === 'deployed' ? 'ok' : r.status ? 'bad' : 'unknown',
    identity: [
      f('Kind', 'Helm release'),
      f('Namespace', or(r.namespace), true),
      f('Chart', `${or(r.chart?.name)}-${or(r.chart?.version)}`, true),
      f('App version', or(r.chart?.appVersion), true)
    ],
    fields: [
      f('Status', or(r.status)),
      f('Revision', or(r.revision)),
      // The newest revision not being the deployed one is an upgrade that never landed — the
      // release looks current in `helm list` and is not.
      f(
        'Pending revision',
        r.pendingRevision ? `${r.pendingRevision} — an upgrade that never became the deployed revision` : 'none'
      ),
      f('Description', or(r.description)),
      f('First deployed', r.firstDeployed ? ago(r.firstDeployed) : '—'),
      f('Last deployed', r.lastDeployed ? ago(r.lastDeployed) : '—'),
      f('Resources', `${or(r.resourceCount)} across ${Object.keys(r.resourceKinds ?? {}).length} kinds`),
      f('Hooks', or(r.hookCount)),
      f('Revisions kept', or(r.revisionCount)),
      f('Overrides', Object.keys(r.overrides ?? {}).length ? `${Object.keys(r.overrides).length} top-level keys` : 'none')
    ],
    related
  };
}

function renderPvc(raw: unknown, _ref: ResourceRef): ResourceView {
  const p = raw as PvcRow;
  return {
    status: p.status,
    tone: toneForPhase(p.status),
    identity: [
      f('Kind', 'PersistentVolumeClaim'),
      f('Namespace', p.namespace, true),
      f('StorageClass', or(p.storageClass), true)
    ],
    fields: [
      f('Status', or(p.status)),
      f('Requested', or(p.requested), true),
      // `capacity` is what the bound volume actually provides, which a dynamic provisioner may
      // round up from the request. Showing only the request hides that difference.
      f('Bound capacity', or(p.capacity), true),
      f('Volume', or(p.volumeName), true),
      f('Access modes', p.accessModes?.join(', ') || '—', true),
      f('Age', p.createdAt ? ago(p.createdAt) : '—')
    ],
    related: []
  };
}

function renderCertificate(raw: unknown, _ref: ResourceRef): ResourceView {
  const c = raw as CertificateRow;
  return {
    status: c.isExpired ? 'Expired' : c.isExpiringSoon ? 'Expiring soon' : c.isReady ? 'Ready' : 'Not ready',
    tone: c.isExpired ? 'bad' : c.isExpiringSoon ? 'warn' : c.isReady ? 'ok' : 'unknown',
    identity: [
      f('Kind', 'Certificate'),
      f('Namespace', c.namespace, true),
      f('Issuer', or(c.issuerRef), true)
    ],
    fields: [
      f('Ready', c.isReady ? 'Yes' : 'No'),
      f('Expires', c.notAfter ? `${c.notAfter} (${ago(c.notAfter)})` : '—'),
      f('Days remaining', or(c.daysRemaining)),
      f('Expiring soon', c.isExpiringSoon ? 'Yes' : 'No'),
      f('Expired', c.isExpired ? 'Yes' : 'No'),
      f('Next renewal', c.renewalTime ? `${c.renewalTime} (${ago(c.renewalTime)})` : '—'),
      f('DNS names', c.dnsNames?.join(', ') || '—', true),
      // The Secret it writes into — named, never read. `srv/fleet` returns Secret keys and
      // never values, and a certificate's Secret is private key material by definition.
      f('Secret', or(c.secretName), true)
    ],
    related: []
  };
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

/**
 * Every Kind, its endpoint, and its renderer.
 *
 * `Record<ResourceKind, …>` on purpose: adding a Kind to the union without adding it here is a
 * compile error, which is the cheapest place to catch a `ResourceLink` that would open an empty
 * drawer. Kinds whose data the console does not yet fetch are absent from the union rather than
 * present with a stub renderer — the spec's "do not fabricate support for CRDs that do not
 * exist" applies just as much to Kinds the *server* does not send.
 */
export const RESOURCE_REGISTRY: Record<ResourceKind, ResourceDefinition> = {
  Deployment: { kind: 'Deployment', plural: 'Deployments', source: 'overview', render: renderWorkload },
  StatefulSet: { kind: 'StatefulSet', plural: 'StatefulSets', source: 'overview', render: renderWorkload },
  DaemonSet: { kind: 'DaemonSet', plural: 'DaemonSets', source: 'overview', render: renderWorkload },
  Pod: { kind: 'Pod', plural: 'Pods', source: 'overview', render: renderPod },
  Container: { kind: 'Container', plural: 'Containers', source: 'overview', render: renderContainer },
  Node: { kind: 'Node', plural: 'Nodes', clusterScoped: true, source: 'overview', render: renderNode },
  Service: {
    kind: 'Service',
    plural: 'Services',
    source: 'networking',
    home: { tab: 'networking', section: 'networking' },
    render: renderService
  },
  Ingress: {
    kind: 'Ingress',
    plural: 'Ingresses',
    source: 'networking',
    home: { tab: 'networking', section: 'networking' },
    render: renderIngress
  },
  Gateway: {
    kind: 'Gateway',
    plural: 'Gateways',
    source: 'networking',
    home: { tab: 'networking', section: 'networking' },
    render: renderGateway
  },
  HTTPRoute: {
    kind: 'HTTPRoute',
    plural: 'HTTPRoutes',
    source: 'networking',
    home: { tab: 'networking', section: 'networking' },
    render: renderHttpRoute
  },
  VirtualService: {
    kind: 'VirtualService',
    plural: 'VirtualServices',
    source: 'networking',
    home: { tab: 'networking', section: 'networking' },
    render: renderVirtualService
  },
  HorizontalPodAutoscaler: {
    kind: 'HorizontalPodAutoscaler',
    plural: 'HorizontalPodAutoscalers',
    source: 'autoscaling',
    home: { tab: 'workloads', section: 'hpas' },
    render: renderHpa
  },
  CronJob: {
    kind: 'CronJob',
    plural: 'CronJobs',
    source: 'autoscaling',
    home: { tab: 'workloads', section: 'cronjobs' },
    render: renderCronJob
  },
  PersistentVolumeClaim: {
    kind: 'PersistentVolumeClaim',
    plural: 'PersistentVolumeClaims',
    source: 'storage',
    home: { tab: 'storage' },
    render: renderPvc
  },
  ResourceQuota: {
    kind: 'ResourceQuota',
    plural: 'ResourceQuotas',
    source: 'storage',
    home: { tab: 'storage' },
    render: renderQuota
  },
  Certificate: {
    kind: 'Certificate',
    plural: 'Certificates',
    source: 'certificates',
    home: { tab: 'certificates', section: 'certificates' },
    render: renderCertificate
  },
  Namespace: { kind: 'Namespace', plural: 'Namespaces', clusterScoped: true, source: 'overview', render: renderNamespace },
  HelmRelease: {
    kind: 'HelmRelease',
    plural: 'Helm releases',
    source: 'helm',
    home: { tab: 'helm' },
    render: renderHelmRelease
  }
};

export const RESOURCE_KINDS = Object.keys(RESOURCE_REGISTRY) as ResourceKind[];

export function isKind(k: string): k is ResourceKind {
  return Object.prototype.hasOwnProperty.call(RESOURCE_REGISTRY, k);
}
