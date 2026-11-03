/**
 * The detail panel for one live resource related to a release.
 *
 * ## Why this page has its own panel
 *
 * The cluster page's `ResourceDetailDrawer` renders from `RESOURCE_REGISTRY` and resolves refs out
 * of whichever tab is mounted. Neither applies here: the release page is a separate route that does
 * not mount `ResourceDataProvider`, and half the Kinds in a release (ReplicaSet, Job, ConfigMap,
 * Secret, ServiceAccount, PodDisruptionBudget, NetworkPolicy, EndpointSlice) have no registry entry
 * at all. Dropping them would leave most of a release un-inspectable; giving them a registry entry
 * each is the master prompt's §11 "do not create Helm-only versions of generic components" read
 * backwards — the generic component cannot answer here.
 *
 * So this panel renders the payload the `/related` route already returns, and hands off to the
 * canonical view with a `View live resource` link for the Kinds that have one. §10's order is kept:
 * identity, status, relationship, facts, links.
 *
 * ## Read-only, and Secret-safe
 *
 * `facts.keys` on a Secret is a list of key names — the server's `factsFor` returns names and never
 * values, and this panel says so on screen so a reader does not assume the values were merely
 * hidden by the UI. There is no action here but navigation.
 */
import { Link } from 'react-router-dom';
import { type HelmRelatedResource } from '../../api';
import { DetailPanel, Field, Section } from '../../components/layout';
import { LiveYaml } from '../../components/LiveYaml';
import { Pill } from '../../components/ui';
import { ago } from '../../format';
import { liveResourceHref, liveTone, RELATIONSHIP } from './shared';

/** Friendly labels for the fact keys `factsFor` emits. Anything unlisted is de-camelCased. */
const FACT_LABEL: Record<string, string> = {
  containerCount: 'Containers',
  containersMissingResources: 'Containers without CPU/memory bounds',
  privilegedContainers: 'Privileged containers',
  rolloutComplete: 'Rollout complete',
  rolloutReason: 'Rollout condition reason',
  rolloutMessage: 'Rollout message',
  node: 'Node',
  restarts: 'Container restarts',
  selector: 'Selector',
  type: 'Type',
  ports: 'Ports',
  service: 'Service',
  addressType: 'Address type',
  hosts: 'Hosts',
  backends: 'Backends',
  tlsSecrets: 'TLS Secrets',
  gateway: 'Gateway',
  gateways: 'Gateways',
  destinations: 'Destinations',
  servers: 'Servers',
  target: 'Scale target',
  min: 'Minimum replicas',
  max: 'Maximum replicas',
  volumeName: 'Bound volume',
  storageClass: 'Storage class',
  requested: 'Requested',
  accessModes: 'Access modes',
  keys: 'Keys',
  minAvailable: 'Minimum available',
  maxUnavailable: 'Maximum unavailable',
  disruptionsAllowed: 'Disruptions allowed',
  podSelector: 'Pod selector',
  policyTypes: 'Policy types',
  ingressRules: 'Ingress rules',
  egressRules: 'Egress rules',
  secretName: 'Secret',
  dnsNames: 'DNS names',
  expiresAt: 'Expires'
};

function labelFor(key: string): string {
  return FACT_LABEL[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

/**
 * One fact as text.
 *
 * A label selector is `{matchLabels: {app: x}}` in some Kinds and `{app: x}` in others, and a port
 * is an object; rendering `[object Object]` in an operator console is worse than rendering nothing.
 * So: primitives verbatim, string arrays joined, key/value maps as `k=v`, and anything still
 * structured as compact JSON — which for these shapes is short and readable.
 */
function formatFact(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(v => typeof v === 'string' || typeof v === 'number')) return value.join(', ');
    return value.map(v => JSON.stringify(v)).join('  ');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const inner = (obj.matchLabels ?? obj) as Record<string, unknown>;
    const pairs = Object.entries(inner).filter(([, v]) => typeof v === 'string' || typeof v === 'number');
    if (pairs.length > 0 && pairs.length === Object.keys(inner).length) {
      return pairs.map(([k, v]) => `${k}=${v}`).join(', ');
    }
    return JSON.stringify(obj);
  }
  return null;
}

export function HelmResourceDrawer({
  clusterId,
  resource,
  onClose
}: {
  clusterId: string;
  resource: HelmRelatedResource;
  onClose: () => void;
}): JSX.Element {
  const rel = RELATIONSHIP[resource.relationship];
  const href = liveResourceHref(clusterId, resource.kind, resource.namespace, resource.name);
  const facts = Object.entries(resource.facts || {})
    .map(([k, v]) => [k, formatFact(v)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);

  return (
    <DetailPanel
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{resource.name}</span>
          {resource.status && <Pill tone={liveTone(resource)}>{resource.status.text}</Pill>}
        </span>
      }
      subtitle={`${resource.kind} · ${resource.namespace ?? 'cluster-scoped'}`}
      onClose={onClose}
      /**
       * Pinned and bounded, so the panel's content scrolls instead of the page.
       *
       * Without this the inline panel is as tall as its contents — a long fact list plus a 50vh YAML
       * pane — which makes the whole release page that tall, hands the window scrollbar the job, and
       * scrolls the Architecture canvas off the top of the screen while the operator is reading the
       * node they just clicked. `DetailPanel`'s body is already `flex-1 overflow-y-auto`, so a
       * max-height on the root is all it takes for the wheel to land in the panel and the graph
       * beside it to stay put. Ignored in the overlay layout below 1280px, which is already fixed to
       * the viewport and has no use for either class.
       */
      inlineClassName="sticky top-4 max-h-[calc(100vh-6rem)]"
    >
      <div className="space-y-5">
        <Section label="Identity">
          <Field label="Kind" value={resource.kind} mono />
          <Field label="Name" value={resource.name} mono />
          <Field label="Namespace" value={resource.namespace ?? 'cluster-scoped'} mono />
          <Field label="Age" value={resource.createdAt ? ago(resource.createdAt) : 'not recorded'} mono />
        </Section>

        <Section label="Status">
          {resource.status ? (
            <>
              <Field label="Native status" value={<Pill tone={liveTone(resource)}>{resource.status.text}</Pill>} />
              {resource.status.ready !== undefined && resource.status.desired !== undefined && (
                <Field label="Ready" value={`${resource.status.ready} of ${resource.status.desired}`} mono />
              )}
            </>
          ) : (
            <p className="text-[13px] text-muted">
              A {resource.kind} publishes no status of its own — it either exists or it does not. This console shows a
              dash rather than inventing a green tick nothing has ever checked.
            </p>
          )}
        </Section>

        <Section label="Relationship to the release">
          <Field label="Type" value={<Pill tone={rel.tone}>{rel.label}</Pill>} />
          <Field label="What that means" value={rel.why} />
          <Field label="Evidence" value={<span className="mono text-[13px]">{resource.evidence}</span>} />
        </Section>

        {facts.length > 0 && (
          <Section label={resource.kind === 'Secret' ? 'Secret metadata' : 'Details'}>
            {resource.kind === 'Secret' && (
              <p className="mb-2 text-[12px] text-warn">
                Key names only. Secret values are never read out of the cluster by this console, so nothing below is a
                masked value — the values were never carried.
              </p>
            )}
            {facts.map(([k, v]) => (
              <Field key={k} label={labelFor(k)} value={v} mono />
            ))}
          </Section>
        )}

        <Section label="Live YAML">
          <LiveYaml
            clusterId={clusterId}
            kind={resource.kind}
            namespace={resource.namespace}
            name={resource.name}
            fetchKey={resource.id}
          />
        </Section>

        <Section label="Where else to look">
          {href ? (
            <Link
              to={href}
              className="inline-flex rounded-[6px] border border-line px-2.5 py-1.5 text-[13px] text-text transition-colors hover:border-accent hover:text-accent"
            >
              View live resource
            </Link>
          ) : (
            <p className="text-[13px] text-muted">
              This console has no dedicated detail view for a {resource.kind}. Everything it read about this object is
              above.
            </p>
          )}
        </Section>
      </div>
    </DetailPanel>
  );
}
