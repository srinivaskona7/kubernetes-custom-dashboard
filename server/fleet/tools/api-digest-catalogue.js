/**
 * The fleet API's routes, one entry per mounted route, for the API digest.
 *
 * `api-digest.js` calls every GET route against a live cluster and documents what came back. The
 * router can tell it a route's method and path and nothing else: not what a query parameter means,
 * which object a path parameter must name, whose cached answer a composite route reuses, or why a
 * write route may exist in a read-only console. That knowledge lives in the handlers in router.js
 * and the collectors they call, so it is written down here by hand, from that code.
 *
 * A hand-kept list drifts, so `server/fleet/__tests__/api-digest-catalogue.test.js` holds it to the live router
 * in both directions and in mounted order, checks every documented query parameter against the
 * names the backend's code reads, and calls every route that documents its answer through its
 * handler, which must answer exactly the documented fields.
 *
 * ## An entry
 *
 *   - `method`, `path`: exactly as mounted. `topic`: siblings share one and are documented side by
 *     side. `title`, `purpose`: what the route answers, the Kinds it reads, its caching and caps.
 *   - `query`: only names the handler or its collector reads; `repeatable` when it may repeat.
 *   - `probe`: how the digest calls it. `needs` names the discovery kind that fills a path
 *     parameter from an earlier answer; `query` adds fixed values; `noCache` sends
 *     `cache-control: no-cache`; `structureOnly` keeps the response's values off the page; `record`
 *     judges the answer by its fields, not its lists, because it describes one thing; `skip` says
 *     why a write route is not called.
 *   - `reuses`: mounted GET paths whose route-cache answer this route reads instead of its own.
 *   - `console`: a caller the digest's static scan of the console cannot see.
 *   - `body`, `effect`: write routes only. A value-free JSONC skeleton of the request, and what the
 *     route writes and why the read-only invariant allows it.
 *   - `responds`: what a route answers when it succeeds, where the digest never sees that: every write
 *     route, and the SSO callback. Read from the handler and written like `body`: a first line
 *     `// <status> <reason>`, then the JSON skeleton with a type name for every value, and an
 *     `// Or <status> <reason>` line for any other success answer. Refusals stay in `purpose`.
 *
 * Prose here reaches the digest as written, so it cites a file and a symbol rather than a line, and
 * names no cluster value: no pod, node, host, address or customer namespace.
 */

// Methods are named constants rather than quoted words: the read-only guard in
// server/fleet/__tests__/router.test.js scans every file under server/fleet for a request whose method is a quoted
// write verb, and this file describes the write routes without making one.
const GET = 'GET';
const POST = 'POST';
const DELETE = 'DELETE';

/** The log window both trace routes read (`tracesQuery` in router.js); it also picks the cache entry. */
const TRACES_QUERY = [
  { name: 'namespace', doc: 'Comma list of namespaces whose proxies are read; the ingress gateways are always kept. Omitted, the whole cluster.' },
  { name: 'polls', doc: '`show` keeps successful liveness polls, which are left out by default; failing ones always stay.' },
  { name: 'tailLines', doc: 'Access-log lines read per proxy: default 500, at most 1000.' },
  { name: 'maxPods', doc: 'Proxies read: default and at most 12.' },
  { name: 'sinceSeconds', doc: 'Only lines newer than this many seconds. A value under 1, or not a number, means no time window.' }
];

/** The fleet-wide twin of a per-cluster group route (`registerGroupRoutes` in router.js). */
const fleetGroup = what =>
  `${what} for every cluster: one slot per cluster carrying the per-cluster answer under data, and a fleet ` +
  'summary of clusters, unreachable clusters and completeness. Cached 30 s, then served stale while it refreshes.';

/**
 * The per-cluster routes whose cache entries both verdict routes read: `SUMMARY_GROUPS` in
 * router.js keys each group by its `clusterKey`, or by `${cacheKey}:${id}` for a group route.
 */
const SUMMARY_REUSES = [
  '/clusters/:id',
  '/clusters/:id/namespaces',
  '/clusters/:id/workloads',
  '/clusters/:id/networking',
  '/clusters/:id/storage',
  '/clusters/:id/security',
  '/clusters/:id/autoscaling',
  '/clusters/:id/certificates',
  '/clusters/:id/topology',
  '/clusters/:id/mesh',
  '/clusters/:id/modules',
  '/clusters/:id/btp-services',
  '/clusters/:id/policy',
  '/clusters/:id/capacity',
  '/clusters/:id/reliability',
  '/clusters/:id/observability',
  '/clusters/:id/integrity'
];

/**
 * The answer of a successful onboarding, which three handlers in router.js send alike:
 * `router.post('/clusters')` for a token, `onboardFromKubeconfig` for a kubeconfig's own credential,
 * and the SSO callback. Its cluster is the registered record as `publicCluster` in fanout.js shapes it.
 */
const onboarded = ({ head = '201 Created', via, renewable }) => `// ${head}
{
  "cluster": {                           // the registered cluster, as the fleet roster lists it
    "id": "string",                      // the cluster id, derived from the name sent
    "displayName": "string",             // the name sent, trimmed
    "env": "string",                     // the env sent, else unknown
    "apiUrl": "string",                  // the API server URL, trailing slashes removed
    "namespace": "string",               // where the account the fleet reads with lives
    "serviceAccount": "string",          // the account the fleet reads with
    "enabled": "boolean",                // always true
    "authMode": "string",                // always token: the cluster is read with the stored token from now on
    "onboardedVia": "string",            // ${via}
    "renewable": "boolean"               // ${renewable}
  },
  "steps": [                             // what onboarding did, in order
    {
      "id": "string",                    // the step's name, e.g. verify
      "detail": "string",                // what it did, in a sentence
      "level": "string"                  // ok, or warn where onboarding went on past a problem
    }
  ],
  "expiresAt": "string",                 // when the stored token expires, ISO 8601
  "kubernetesVersion": "string | null",  // the API server's gitVersion, null when it reports none
  "onboardedVia": "string",              // the same as the cluster's
  "renewable": "boolean",                // the same as the cluster's
  "note": "string"                       // says the cluster is registered and other replicas pick it up within a minute
}`;

/** What `removeClusterHandler` in router.js answers, under each of the three spellings of the route. */
const REMOVED = `// 200 OK
{
  "cluster": "string",    // the removed cluster's id
  "removed": "boolean",   // always true
  "leftBehind": "string"  // what onboarding left on the cluster, and the kubectl commands that remove it
}`;

const ROUTES = [
  {
    method: GET,
    path: '/clusters',
    topic: 'clusters',
    title: 'Fleet roster and health',
    purpose:
      'Every registered cluster with its health: nodes, Kubernetes version, pod phases and capacity, read from ' +
      'Nodes, Pods (up to 2000) and NodeMetrics where metrics-server answers. A disabled cluster is listed with ' +
      'notRead `disabled`, and one not read yet with ok null and notRead `pending`, which does not count as unreachable. ' +
      'The fleet summary and the caller\'s canOnboard and canRemove flags ride beside the rows; cached 30 s, then ' +
      'served stale for up to 30 s more while it refreshes.'
  },
  {
    method: GET,
    path: '/clusters/:id',
    topic: 'clusters',
    title: 'Cluster health',
    purpose:
      'One cluster\'s health, from the same reads as the fleet roster, plus whether it can be removed and where its ' +
      'registration came from (source, onboardedAt, onboardedBy). An unknown id is 404 `NOT_FOUND`; cached 30 s per cluster.'
  },
  {
    method: GET,
    path: '/clusters/:id/overview',
    topic: 'overview',
    title: 'Cluster overview bundle',
    purpose:
      'What the cluster page opens with, in one response: health, namespace compliance, workloads, and one page of up ' +
      'to 25 Warning events sorted newest first. The events stay a bare array, with their count, limit, atLimit and ' +
      'completeness under eventsSummary, so an empty list can be told from a refused read. Cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/namespaces',
    topic: 'compliance',
    title: 'Namespace compliance',
    purpose:
      'Every namespace of one cluster, checked for Istio injection, a Pod Security enforce level, the ' +
      '`docker-registry-secret` pull secret, a deployer RoleBinding and the `egress-allow-btp-traffic` NetworkPolicy. ' +
      'Platform namespaces are listed as system and not audited; `default` is audited like an application namespace. ' +
      'Reads Namespaces, that Secret by name, RoleBindings, NetworkPolicies and Pods (metadata only); cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/workloads',
    topic: 'workloads',
    title: 'Workloads',
    purpose:
      'Deployments, StatefulSets and DaemonSets with their readiness and pods, for the whole cluster or for up to 8 ' +
      'selected namespaces. Reads the three workload Kinds and Pods (up to 2000) per scope, and PodMetrics where ' +
      'metrics-server answers; cached 30 s per namespace selection.',
    query: [
      {
        name: 'namespace',
        repeatable: true,
        doc: 'Namespaces to scope to, repeated or as a comma list; at most 8, each a valid namespace name, else 400 ' +
          '`INVALID_NAMESPACE`. Omitted, the whole cluster.'
      }
    ],
    console:
      'Requested by the console prefetch sweep (`TAB_READS` in prefetch.ts) at low priority, which warms ' +
      'the entry the group verdicts read'
  },
  {
    method: GET,
    path: '/clusters/:id/workloads/:namespace/:kind/:name/graph',
    topic: 'workload-graph',
    title: 'Workload dependency graph',
    purpose:
      'The objects around one workload: its ReplicaSets, pods, Services, HorizontalPodAutoscalers, Ingresses and ' +
      'APIRules, and the ConfigMaps and Secrets its pod template references, by name only. Reads lists in the ' +
      'workload\'s own namespace, on selection rather than on every poll; cached 30 s. The kind must be Deployment, ' +
      'StatefulSet or DaemonSet (else 400 `UNSUPPORTED_KIND`), and a workload that is gone is 404.',
    probe: { needs: 'workload' }
  },
  {
    method: GET,
    path: '/clusters/:id/events',
    topic: 'events',
    title: 'Warning events',
    purpose:
      'Warning events for one cluster or one namespace: one page of up to 50 in the API\'s order, sorted newest first. ' +
      'When the page is full, atLimit is true, the count is a floor, and events is listed under truncated. Cached 30 s per namespace.',
    query: [{ name: 'namespace', doc: 'Namespace to read events from. Omitted, the whole cluster.' }],
    console: 'Requested by the console prefetch sweep (`TAB_READS` in prefetch.ts) at low priority'
  },
  {
    method: GET,
    path: '/clusters/:id/pods',
    topic: 'pods',
    title: 'Pods and containers',
    purpose:
      'Every pod with its phase and containers, for the log pickers: Pods (up to 2000) for the cluster or one ' +
      'namespace. Cached 30 s per namespace.',
    query: [{ name: 'namespace', doc: 'Namespace to list pods in. Omitted, the whole cluster.' }]
  },
  {
    method: GET,
    path: '/clusters/:id/logs',
    topic: 'logs',
    title: 'Container log tail',
    purpose:
      'The tail of one container\'s log, from pods/log with a 2,000,000-byte cap. When the current container has not ' +
      'started or has written nothing, it falls back to the previous instance and says so under fallback. Never ' +
      'cached, and the one route that passes cluster data through verbatim, so the digest records its structure only.',
    query: [
      { name: 'namespace', doc: 'Namespace of the pod. Required.' },
      { name: 'pod', doc: 'Pod name. Required.' },
      { name: 'container', doc: 'Container to read. Omitted, Kubernetes picks the pod\'s default container.' },
      { name: 'tailLines', doc: 'Lines from the end: default 200, at most 2000.' },
      { name: 'sinceSeconds', doc: 'Only lines newer than this many seconds; at least 1.' },
      { name: 'timestamps', doc: 'Prefixes each line with its timestamp; on unless `false`.' },
      { name: 'previous', doc: '`true` reads the previous container instance instead of the current one.' }
    ],
    probe: { needs: 'pod', structureOnly: true, query: { tailLines: '5' } }
  },
  {
    method: GET,
    path: '/clusters/:id/traffic-errors',
    topic: 'traffic-errors',
    title: 'Traffic errors',
    purpose:
      'Failed requests at the mesh edge and behind it, from istio-proxy access logs (ingress gateways first, then the ' +
      'pods behind each route), with the Gateways, VirtualServices, APIRules, Services, EndpointSlices, mesh policies ' +
      'and egress registry that explain them. Cluster-only, on the traffic cache: 15 s fresh, then served stale for up ' +
      'to 10 minutes while it refreshes, and its log read is shared with the traces route. A `cache-control: no-cache` ' +
      'or `no-store` header discards the cached answer and reads again.',
    query: [
      { name: 'namespace', doc: 'Namespace whose istio-proxy logs are read. Omitted, the whole cluster.' },
      { name: 'tailLines', doc: 'Access-log lines read per proxy: default 300, at most 1000.' },
      { name: 'maxPods', doc: 'Proxies read: default and at most 10.' },
      { name: 'sinceSeconds', doc: 'Only lines newer than this many seconds. A value under 1, or not a number, means no time window.' }
    ],
    probe: { noCache: true }
  },
  {
    method: GET,
    path: '/clusters/:id/traces',
    topic: 'traces',
    title: 'Traces',
    purpose:
      'Request traces rebuilt from istio-proxy access logs, each the hops one request took through the mesh: at most ' +
      '200 traces of at most 20 hops. Shares the traffic cache and its log read with traffic-errors (15 s fresh, then ' +
      'served stale for up to 10 minutes), and `cache-control: no-cache` forces a fresh read. The list leaves out each ' +
      'trace\'s endpoint samples, which the single-trace route keeps.',
    query: TRACES_QUERY,
    probe: { noCache: true }
  },
  {
    method: GET,
    path: '/clusters/:id/traces/:traceId',
    topic: 'traces',
    title: 'One trace',
    purpose:
      'One trace by id, picked from the same read and cache entry as the list, so the same query gives the same ' +
      'window. A trace outside that window answers with notFoundReason `NOT_IN_WINDOW` rather than a 404, and a ' +
      'failed read is returned as the failure it is.',
    query: TRACES_QUERY,
    // No cache bypass: a fresh read could roll the window past the trace the list just found.
    probe: { needs: 'trace' },
    reuses: ['/clusters/:id/traces']
  },
  {
    method: GET,
    path: '/compliance',
    topic: 'compliance',
    title: 'Fleet namespace compliance',
    purpose:
      'Namespace compliance across the fleet: every cluster\'s namespaces with the same checks as the per-cluster ' +
      'route, and a fleet summary counting audited, compliant, with-warnings and with-findings namespaces, system ones ' +
      'excluded. Cached 30 s.'
  },
  {
    method: GET,
    path: '/workloads',
    topic: 'workloads',
    title: 'Fleet workloads',
    purpose:
      'Workloads across the fleet: every cluster\'s Deployments, StatefulSets and DaemonSets in one list, each with ' +
      'its cluster, and totals of workloads, not-ready workloads and restarts summed from each cluster\'s summary. Cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/workloads/:namespace/:name/rollout',
    topic: 'rollout',
    title: 'Rollout status',
    purpose:
      'Rollout progress of one Deployment or StatefulSet: desired, updated, available and ready replicas, the ' +
      'conditions, and when it was last restarted. Reads the one object directly and uncached, so it reflects the ' +
      'cluster at the moment of asking; complete means the controller has seen the newest generation and every ' +
      'replica is updated and available.',
    query: [{ name: 'kind', doc: '`Deployment` (the default) or `StatefulSet`; any other kind is 400.' }],
    probe: { needs: 'workload' }
  },
  {
    method: GET,
    path: '/networking',
    topic: 'networking',
    title: 'Fleet networking inventory',
    purpose:
      'Routing objects across the fleet, each row with its cluster, and fleet totals of APIRules, VirtualServices, ' +
      'Ingresses and Services. Cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/networking',
    topic: 'networking',
    title: 'Networking inventory',
    purpose:
      'One cluster\'s routing objects: APIRules (gateway.kyma-project.io v2, an absent API read as none), Istio ' +
      'VirtualServices and Gateways, Ingresses and Services. Cached 30 s per namespace.',
    query: [{ name: 'namespace', doc: 'Namespace that scopes all five reads. Omitted, the whole cluster.' }]
  },
  {
    method: GET,
    path: '/storage',
    topic: 'storage',
    title: 'Fleet storage inventory',
    purpose:
      'Storage across the fleet: PersistentVolumeClaims and ResourceQuotas, each with its cluster, and totals of ' +
      'claims, bound and pending claims, and quotas. Cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/storage',
    topic: 'storage',
    title: 'Storage inventory',
    purpose:
      'One cluster\'s PersistentVolumeClaims, ResourceQuotas, LimitRanges and StorageClasses. A namespace scopes the ' +
      'first three; StorageClasses are cluster-wide, and Namespaces are read only for the whole-cluster view. Cached 30 s per namespace.',
    query: [
      { name: 'namespace', doc: 'Namespace that scopes the claims, quotas and limit ranges. Omitted, the whole cluster.' }
    ]
  },
  {
    method: GET,
    path: '/security',
    topic: 'security',
    title: 'Fleet security posture',
    purpose:
      'Security posture per cluster, side by side: each cluster\'s summary, NetworkPolicies and Secret type ' +
      'distribution, with the clusters that could not be read listed under unreachable. Cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/security',
    topic: 'security',
    title: 'Security posture',
    purpose:
      'One cluster\'s isolation and credential posture, from Namespaces, NetworkPolicies, Pods (up to 1500, a read ' +
      'that must succeed) and ServiceAccounts. Secrets are counted by type from a metadata-only list and one ' +
      'field-selector count per type, so no Secret value is transferred. Cached 30 s.'
  },
  {
    method: GET,
    path: '/autoscaling',
    topic: 'autoscaling',
    title: 'Fleet autoscaling',
    purpose:
      'HorizontalPodAutoscalers and CronJobs across the fleet, each with its cluster, and totals of autoscalers, ' +
      'CronJobs and active CronJobs. Cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/autoscaling',
    topic: 'autoscaling',
    title: 'Autoscaling',
    purpose: 'One cluster\'s HorizontalPodAutoscalers (autoscaling/v2) and CronJobs (batch/v1). Cached 30 s.'
  },
  {
    method: GET,
    path: '/certificates',
    topic: 'certificates',
    title: 'Fleet certificates',
    purpose:
      'Certificates across the fleet, each with its cluster, and totals of certificates and of those expiring soon, ' +
      'expired and not ready. The total is null rather than 0 when no reachable cluster could read either ' +
      'Certificate API; cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/certificates',
    topic: 'certificates',
    title: 'Certificates',
    purpose:
      'One cluster\'s Certificates from cert-manager (cert-manager.io/v1) and Gardener (cert.gardener.cloud/v1alpha1), ' +
      'and the TLS sections of its Ingresses, counting those expiring soon, expired and not ready. The total is null ' +
      'rather than 0 when neither Certificate API can be read; cached 30 s.'
  },
  {
    method: GET,
    path: '/topology',
    topic: 'topology',
    title: 'Fleet node topology',
    purpose:
      'Nodes across the fleet, each with its cluster, node groups merged, and totals of nodes, ready nodes, distinct ' +
      'zones and node groups, scheduled pods and pod capacity. Cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/topology',
    topic: 'topology',
    title: 'Node topology',
    purpose:
      'One cluster\'s nodes by zone and node group, with the pods scheduled on each against its pod capacity, from ' +
      'Nodes (a read that must succeed) and Pods. Cached 30 s.'
  },
  {
    method: GET,
    path: '/mesh',
    topic: 'mesh',
    title: 'Fleet Istio service mesh',
    purpose: fleetGroup('The Istio mesh read')
  },
  {
    method: GET,
    path: '/clusters/:id/mesh',
    topic: 'mesh',
    title: 'Istio service mesh',
    purpose:
      'One cluster\'s Istio mesh in four verdicts: sidecar coverage, effective mTLS, ingress binding integrity and ' +
      'authorization posture. Reads Pods and Namespaces (reads that must succeed), DestinationRules, Gateways and ' +
      'VirtualServices (networking.istio.io), PeerAuthentications and AuthorizationPolicies (security.istio.io), and ' +
      'the istio-system DaemonSets; an absent Istio API reads as none, and the answer is cached 30 s.'
  },
  {
    method: GET,
    path: '/modules',
    topic: 'modules',
    title: 'Fleet Kyma modules',
    purpose: fleetGroup('The Kyma module read')
  },
  {
    method: GET,
    path: '/clusters/:id/modules',
    topic: 'modules',
    title: 'Kyma modules',
    purpose:
      'One cluster\'s Kyma modules and whether each is current: the modules in its Kyma resource, joined to the ' +
      'ModuleReleaseMetas (operator.kyma-project.io/v1beta2) that say which version is current on each channel. An ' +
      'absent Kyma API reads as none; cached 30 s.'
  },
  {
    method: GET,
    path: '/btp-services',
    topic: 'btp-services',
    title: 'Fleet BTP services',
    purpose: fleetGroup('The BTP service read')
  },
  {
    method: GET,
    path: '/clusters/:id/btp-services',
    topic: 'btp-services',
    title: 'BTP services',
    purpose:
      'One cluster\'s SAP BTP service instances and bindings (services.cloud.sap.com), its Serverless Functions and ' +
      'Eventing Subscriptions (an absent API reads as none), and Pods. Cached 30 s.',
    console: 'Requested by the console prefetch sweep (`TAB_READS` in prefetch.ts) at low priority'
  },
  {
    method: GET,
    path: '/policy',
    topic: 'policy',
    title: 'Fleet admission policy',
    purpose: fleetGroup('The admission-policy read')
  },
  {
    method: GET,
    path: '/clusters/:id/policy',
    topic: 'policy',
    title: 'Admission policy',
    purpose:
      'One cluster\'s admission control in three checks: what enforces policy (Gatekeeper ConstraintTemplates and ' +
      'constraints, at most 25 templates, or native ValidatingAdmissionPolicies and their bindings), how far a ' +
      'fail-closed Validating or Mutating webhook reaches when its backend is down, and PodDisruptionBudget coverage ' +
      'of Deployments, StatefulSets and DaemonSets. Namespaces and EndpointSlices answer which namespaces a webhook ' +
      'selects and whether its backend is up; cached 30 s.'
  },
  {
    method: GET,
    path: '/opa',
    topic: 'opa',
    title: 'Fleet OPA Gatekeeper policies',
    purpose: fleetGroup('The OPA Gatekeeper read')
  },
  {
    method: GET,
    path: '/clusters/:id/opa',
    topic: 'opa',
    title: 'OPA Gatekeeper policies',
    purpose:
      'One cluster\'s OPA Gatekeeper policies, one row per constraint with its template, match scope, parameters and ' +
      'audit violations. Reads ConstraintTemplates and their constraints (at most 25 templates), Namespaces, ' +
      'ValidatingWebhookConfigurations, EndpointSlices, and the Services and Deployments in gatekeeper-system; cached 30 s.'
  },
  {
    method: GET,
    path: '/opa/decisions',
    topic: 'opa-decisions',
    title: 'Fleet OPA decision sources',
    purpose: fleetGroup('The OPA decision-source read')
  },
  {
    method: GET,
    path: '/clusters/:id/opa/decisions',
    topic: 'opa-decisions',
    title: 'OPA decision sources',
    purpose:
      'Whether one cluster has a source of runtime admission decisions, and which setting is off: the Gatekeeper ' +
      'controller Deployment in gatekeeper-system (for `--log-denies`) and the Gatekeeper metrics Service. available is ' +
      'nearly always false, because reading the metrics needs the services proxy, which the fleet\'s role does not ' +
      'grant; cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/opa/policies/:template/yaml',
    topic: 'opa-yaml',
    title: 'Policy YAML',
    purpose:
      'The live YAML of one ConstraintTemplate, and of one constraint under it when asked, with managedFields and the ' +
      'last-applied annotation removed and values masked. Names are checked before any read, a template or constraint ' +
      'that is gone is 404, and the answer is cached 30 s.',
    query: [{ name: 'constraint', doc: 'Name of one constraint under the template to include. Omitted, the template alone.' }],
    probe: { needs: 'template' }
  },
  {
    method: GET,
    path: '/capacity',
    topic: 'capacity',
    title: 'Fleet capacity',
    purpose: fleetGroup('The capacity read')
  },
  {
    method: GET,
    path: '/clusters/:id/capacity',
    topic: 'capacity',
    title: 'Capacity',
    purpose:
      'One cluster\'s capacity posture: limit overcommit (the burst a node or namespace could draw if every container ' +
      'used its ceiling), containers without limits, the QoS mix, pending pods, and whether metrics-server is serving. ' +
      'Reads Nodes, Pods (up to 2000) and NodeMetrics; cached 30 s.'
  },
  {
    method: GET,
    path: '/cost',
    topic: 'cost',
    title: 'Fleet cost',
    purpose: fleetGroup('The cost estimate')
  },
  {
    method: GET,
    path: '/clusters/:id/cost',
    topic: 'cost',
    title: 'Cost',
    purpose:
      'An estimated cost for one cluster: each node priced from `DEFAULT_CATALOG` in cost-catalog.js (replaced by the ' +
      'FLEET_COST_CATALOG setting), in USD as the authoritative meter with capacity units beside it, and shared out to ' +
      'namespaces by their requests, with an unallocated row. A node without a price makes the cost a floor ' +
      '(costIsFloor), and money fields are null when the node read fails. Reads Nodes, Pods (up to 2000) and ' +
      'NodeMetrics; cached 30 s, and not part of the group verdicts.'
  },
  {
    method: GET,
    path: '/reliability',
    topic: 'reliability',
    title: 'Fleet reliability',
    purpose: fleetGroup('The reliability read')
  },
  {
    method: GET,
    path: '/clusters/:id/reliability',
    topic: 'reliability',
    title: 'Reliability',
    purpose:
      'One cluster\'s workload reliability in five checks: crashlooping containers, whether each Deployment and ' +
      'StatefulSet rollout has really finished (no pod still on an older image), Deployments short of replicas after ' +
      'a rollout, DaemonSet coverage of their nodes, and Services with no ready endpoint. Reads Deployments, ' +
      'StatefulSets, DaemonSets, ReplicaSets (metadata only, for the owner chain), Pods (up to 2000), Services and ' +
      'EndpointSlices; cached 30 s.'
  },
  {
    method: GET,
    path: '/observability',
    topic: 'observability',
    title: 'Fleet observability stack',
    purpose: fleetGroup('The observability-stack read')
  },
  {
    method: GET,
    path: '/clusters/:id/observability',
    topic: 'observability',
    title: 'Observability stack',
    purpose:
      'Whether one cluster\'s observability is wired: is the Prometheus Operator installed and scraping anything, and ' +
      'are Kyma\'s telemetry pipelines healthy and flowing. One discovery read for the API groups it serves, then ' +
      'Prometheus, ServiceMonitor, PodMonitor and PrometheusRule resources (monitoring.coreos.com), LogPipelines, ' +
      'TracePipelines and MetricPipelines (telemetry.kyma-project.io/v1beta1), and DaemonSets; cached 30 s.'
  },
  {
    method: GET,
    path: '/integrity',
    topic: 'integrity',
    title: 'Fleet platform integrity',
    purpose: fleetGroup('The platform-integrity read')
  },
  {
    method: GET,
    path: '/clusters/:id/integrity',
    topic: 'integrity',
    title: 'Platform integrity',
    purpose:
      'Whether one cluster\'s API is serving whole: every APIService (apiregistration.k8s.io/v1) and its availability, ' +
      'and one discovery read that audits the versions each API group serves. Cached 30 s.'
  },
  {
    method: GET,
    path: '/helm/releases',
    topic: 'helm-releases',
    title: 'Fleet Helm releases',
    purpose: fleetGroup('The Helm release read')
  },
  {
    method: GET,
    path: '/clusters/:id/helm/releases',
    topic: 'helm-releases',
    title: 'Helm releases',
    purpose:
      'One cluster\'s Helm releases, from a metadata-only list of the release Secrets labelled owner=helm (up to 2000), ' +
      'falling back to ConfigMaps when no Secret is found. Full records are read only for deployed revisions, plus the ' +
      'newest record of a release with none deployed, and each release is joined to the health of its Deployments, ' +
      'StatefulSets and DaemonSets (up to 2000 each); cached 30 s.'
  },
  {
    method: GET,
    path: '/clusters/:id/helm/releases/:namespace/:name/manifest',
    topic: 'helm-manifest',
    title: 'Helm release manifest',
    purpose:
      'One Helm release\'s rendered manifest, chart files and chart metadata, with values, overrides and defaults ' +
      'masked by `maskValues` in collectors/helm.js and every Secret document blanked to its keys. Reads the release ' +
      'record through a namespaced list by label (at most 200), the deployed revision unless one is asked for, and ' +
      'caps the manifest at 512 KiB. A release that is gone is 404; cached 30 s.',
    query: [
      {
        name: 'revision',
        doc: 'Release revision to read, a positive integer, else 400 `INVALID_REVISION`. Omitted, the deployed revision.'
      }
    ],
    probe: { needs: 'release' }
  },
  {
    method: GET,
    path: '/clusters/:id/helm/releases/:namespace/:name/related',
    topic: 'helm-related',
    title: 'Helm release live inventory',
    purpose:
      'The live objects one Helm release owns, from 23 lists in its namespace (`LIVE_KINDS` in ' +
      'collectors/helm-related.js), with their Events (at most 500) and, when a claim is bound, the PersistentVolumes ' +
      'behind it (up to 500). A release that is gone is 404; cached 30 s.',
    probe: { needs: 'release' }
  },
  {
    method: GET,
    path: '/clusters/:id/resource-yaml',
    topic: 'resource-yaml',
    title: 'Live object YAML',
    purpose:
      'The live YAML of one object, with five redactions named under redactions: Secret and ConfigMap data reduced to ' +
      'their keys, container env values dropped, and managedFields and the last-applied annotation removed. A kind ' +
      'outside the readable list is 400 `UNSUPPORTED_KIND` before any read, a Certificate is looked up under both ' +
      'Certificate APIs, and an object that is gone is 404; cached 30 s.',
    query: [
      {
        name: 'kind',
        doc: 'Required. One of `READABLE_KINDS` in collectors/resource-yaml.js: APIRule, AuthorizationPolicy, ' +
          'Certificate, ConfigMap, CronJob, DaemonSet, Deployment, EndpointSlice, Gateway, HorizontalPodAutoscaler, ' +
          'Ingress, Job, NetworkPolicy, PersistentVolumeClaim, Pod, PodDisruptionBudget, ReplicaSet, Secret, Service, ' +
          'ServiceAccount, StatefulSet or VirtualService.'
      },
      { name: 'name', doc: 'Object name. Required, else 400 `BAD_REQUEST`.' },
      { name: 'namespace', doc: 'Namespace of the object; every readable Kind is namespaced.' }
    ],
    probe: { needs: 'object' }
  },
  {
    method: GET,
    path: '/drift',
    topic: 'drift',
    title: 'Fleet drift',
    purpose:
      'Drift across the fleet: cluster parity (Kubernetes version, nodes, allocatable), image drift for workloads that ' +
      'share a namespace and name across clusters, and module parity, with a summary of what was compared and what ' +
      'drifted. Built from the cache entries of the roster, the fleet workloads and the fleet modules, so whichever ' +
      'route asks first warms them for the others.',
    reuses: ['/clusters', '/workloads', '/modules']
  },
  {
    method: GET,
    path: '/report',
    topic: 'report',
    title: 'Fleet audit report',
    purpose:
      'A Markdown audit report of the fleet, sent as a file attachment: cluster summary, health, compliance findings, ' +
      'security and isolation, and data completeness. Built from the cache entries of the roster, fleet compliance and ' +
      'fleet security, with every string a cluster supplies escaped for a table cell (`mdCell` in router.js).',
    reuses: ['/clusters', '/compliance', '/security']
  },
  {
    method: GET,
    path: '/summary',
    topic: 'summary',
    title: 'Fleet group verdicts',
    purpose:
      'One verdict per signal group (health, completeness and signals) for every active cluster, and the same per ' +
      'cluster under perCluster. Built from the per-cluster group routes\' cache entries, not the fleet-wide ones, and ' +
      'always run at low priority behind interactive reads.',
    reuses: SUMMARY_REUSES
  },
  {
    method: GET,
    path: '/clusters/:id/summary',
    topic: 'summary',
    title: 'Group verdicts',
    purpose:
      'One cluster\'s verdict per signal group, with the headline numbers its Overview tiles show. Built from the same ' +
      'per-cluster cache entries as the fleet verdicts, at normal priority.',
    reuses: SUMMARY_REUSES
  },
  {
    method: POST,
    path: '/clusters/kubeconfig/describe',
    topic: 'onboarding',
    title: 'Cluster onboarding',
    purpose:
      'Parses a pasted kubeconfig on the server and answers what onboarding would use: the API server URL, the chosen ' +
      'and available contexts, the default namespace, whether a CA is present, the credential type, the OIDC issuer, ' +
      'and whether a token is still needed. Nothing is stored, no cluster is contacted and no credential is echoed ' +
      'back, so the preview and the onboarding read a file by one set of rules. Needs the admin scope where it is ' +
      'enforced (else 403 `MISSING_SCOPE`); no kubeconfig is 400 `NO_KUBECONFIG`, one over 256 KiB is 413 ' +
      '`TOO_LARGE`, and a refused API server URL is 400.',
    probe: { skip: 'writes nothing, but needs a kubeconfig in its body; the digest is GET-only' },
    body: `{
  "kubeconfig": "string",   // the kubeconfig YAML, as pasted
  "contextName": "string"   // optional: the context to describe; omitted, the current context
}`,
    responds: `// 200 OK
{
  "apiUrl": "string",                   // the API server URL of the context, trailing slashes removed
  "contextName": "string",              // the context described: the one sent, else the current context
  "contexts": [ "string" ],             // every context name in the file
  "defaultNamespace": "string | null",  // the context's namespace, null when it sets none
  "caPresent": "boolean",               // whether the cluster entry inlines a CA; the CA is not sent back
  "credential": "string",               // token, exec-oidc, exec, auth-provider, client-certificate or none
  "hasStaticToken": "boolean",          // whether the user entry carries a token; the token is not sent back
  "oidcIssuer": "string | null",        // the issuer an OIDC exec sign-in names, null without one
  "needsToken": "boolean"               // true when the file has no token, so a service-account token must be pasted
}`,
    effect:
      'None: it stores nothing, contacts no cluster and echoes back no credential. It is a POST only because a ' +
      'kubeconfig does not belong in a query string, which is the reason it is on the route allowlist of the ' +
      '"no route mutates cluster state" guard in router.test.js.'
  },
  {
    method: POST,
    path: '/clusters',
    topic: 'onboarding',
    title: 'Register a cluster',
    purpose:
      'Registers a cluster, either from a service-account token (with the API URL and CA given directly or read from a ' +
      'kubeconfig) or from a kubeconfig with a static credential, used once to set up the fleet\'s own read access. ' +
      'An existing id is 409 `CLUSTER_EXISTS` unless the body sets replace to true (the kubeconfig-only path does not ' +
      'pass replace on), a cluster baked into the image is always 409 `BAKED_CLUSTER`, and success is 201 with the ' +
      'cluster, the steps taken and the token\'s expiry. Needs the admin scope where it is enforced, and answers 501 ' +
      '`ONBOARD_DISABLED` where the fleet cannot write its registry.',
    probe: { skip: 'writes the fleet registry and mints a token on the target cluster; the digest is GET-only' },
    body: `{
  "name": "string",         // display name; the cluster id is derived from it
  "token": "string",        // a service-account token; omit it to onboard from the kubeconfig's own credential
  "kubeconfig": "string",   // kubeconfig YAML: the endpoint and CA, and the credential when no token is sent
  "apiUrl": "string",       // with a token and no kubeconfig: the API server URL
  "caData": "string",       // with a token and no kubeconfig: the API server's CA certificate
  "contextName": "string",  // optional: the kubeconfig context to use
  "env": "string",          // optional: an environment label
  "replace": "boolean"      // optional: true replaces a cluster registered under the same id
}`,
    responds: onboarded({
      via: 'token or kubeconfig: which way it came in',
      renewable: 'false only for a pasted token that cannot mint its successor'
    }),
    effect:
      'Writes the fleet registry: the cluster record and its token go to the in-process stores (`memClusters` and ' +
      '`memTokens` in redis-store.js) and, where a service account is mounted, to the hub Secrets kyma-fleet-clusters ' +
      'and kyma-fleet-tokens. A kubeconfig-only onboarding also creates, once, on the target cluster: the kyma-fleet ' +
      'Namespace, the fleet-reader ServiceAccount, the kyma-fleet-reader ClusterRole (`readOnlyRules` in onboard.js) ' +
      'and its binding, the kyma-fleet-token-issuer Role and RoleBinding, and a first 24 h token; a token onboarding ' +
      'mints its successor with a TokenRequest. Both guards in router.test.js allow it as the bootstrap of ' +
      'read access: admin-gated, and touching no workload.'
  },
  {
    method: POST,
    path: '/clusters/bootstrap-oidc',
    topic: 'onboarding',
    title: 'Start an SSO onboarding',
    purpose:
      'Starts onboarding a cluster whose kubeconfig signs in through an OIDC exec plugin: checks the API server and ' +
      'the issuer against `FLEET_OIDC_PASSTHROUGH_HOSTS`, discovers the issuer, and answers 202 with a flowId and the ' +
      'authorization URL to open, valid for 5 minutes. A kubeconfig without an exec sign-in is onboarded as ' +
      'POST /clusters would onboard it. Refusals: 400 `NO_NAME`, 403 `OIDC_HOST_NOT_ALLOWLISTED` or ' +
      '`OIDC_ISSUER_NOT_ALLOWLISTED`, 400 `OIDC_ENDPOINT_NOT_ALLOWED`, 502 when discovery fails, and 409 for an ' +
      'existing id without replace.',
    probe: { skip: 'writes an in-memory sign-in flow and starts a browser redirect; the digest is GET-only' },
    body: `{
  "name": "string",         // display name; the cluster id is derived from it
  "kubeconfig": "string",   // kubeconfig YAML whose user signs in through an OIDC exec plugin
  "contextName": "string",  // optional: the kubeconfig context to use
  "env": "string",          // optional: an environment label
  "replace": "boolean"      // optional: true replaces a cluster registered under the same id
}`,
    responds: `// 202 Accepted
{
  "flowId": "string",            // the sign-in flow's id, which the issuer sends back as state
  "authorizationUrl": "string",  // the issuer's authorize URL to open, with the PKCE challenge, state and nonce
  "expiresAt": "string",         // when the flow lapses, 5 minutes on, ISO 8601
  "note": "string"               // names the callback URL the IdP client must already have registered
}
// Or 201 Created, for a kubeconfig without an exec sign-in: what POST /clusters answers, onboardedVia kubeconfig`,
    effect:
      'Writes an in-memory sign-in flow (its PKCE verifier and the cluster it is for) that expires after 5 minutes; ' +
      'nothing reaches a store, a Secret or a cluster until the callback completes it. The route is on the allowlist ' +
      'of the "no route mutates cluster state" guard in router.test.js as the PKCE variant of onboarding, ' +
      'and a kubeconfig without an exec sign-in writes what POST /clusters writes.'
  },
  {
    method: GET,
    path: '/clusters/bootstrap-oidc/callback',
    topic: 'onboarding',
    title: 'SSO onboarding callback',
    purpose:
      'Where the identity provider sends the browser after sign-in: it matches state to a live flow, used once and ' +
      'only by the admin who started it (else 403 `OIDC_FLOW_NOT_YOURS`), exchanges the code for an ID token, sets up ' +
      'the fleet\'s read access on the cluster as that identity, and registers it (201, onboardedVia `oidc-bootstrap`). ' +
      'A browser is redirected to the console\'s onboard page with the outcome. Without a live flow, as when the ' +
      'digest calls it, it answers 400 `OIDC_FLOW_EXPIRED`.',
    query: [
      { name: 'code', doc: 'The authorization code the identity provider issued.' },
      { name: 'state', doc: 'The flowId of the sign-in flow being completed.' },
      { name: 'error', doc: 'An error the identity provider reported; answered as 400 `OIDC_ISSUER_ERROR`.' },
      { name: 'error_description', doc: 'The identity provider\'s description of that error.' }
    ],
    probe: {},
    responds: `${onboarded({
      head: '201 Created, as JSON, unless the client ranks text/html above JSON',
      via: 'always oidc-bootstrap',
      renewable: 'always true'
    })}
// Or 302 Found, to a client that ranks text/html above JSON, as a browser does: Location is the console's
// SSO onboarding page, /kyma-fleet-dashboard/#/onboard/advanced?sso=connected&cluster=<id>, where
// FLEET_UI_BASE_PATH, when set, replaces /kyma-fleet-dashboard`,
    console: 'Reached by the identity provider\'s redirect after sign-in, not by a console call'
  },
  {
    method: DELETE,
    path: '/clusters/:id',
    topic: 'remove-cluster',
    title: 'Remove a cluster',
    purpose:
      'Removes a cluster from the fleet\'s registry and token store without any call to the cluster, and answers ' +
      'with the kubectl commands that would remove what onboarding left there (leftBehind). An unknown id is 404, a ' +
      'cluster baked into the image is 409 `BAKED_CLUSTER`, and a fleet that cannot write its registry answers 501 ' +
      '`ONBOARD_DISABLED`; needs the admin scope where it is enforced.',
    probe: { skip: 'writes the fleet registry: it removes a cluster; the digest is GET-only' },
    responds: REMOVED,
    effect:
      'Deletes the cluster\'s record and token from the in-process stores and, where a service account is mounted, ' +
      'from the hub Secrets, and drops its cache entries; nothing on the target cluster changes. It is local ' +
      'bookkeeping, so it is on the route allowlist of the "no route mutates cluster state" guard in ' +
      'router.test.js.'
  },
  {
    method: POST,
    path: '/clusters/:id/remove',
    topic: 'remove-cluster',
    title: 'Remove a cluster (POST alias)',
    purpose:
      'The same removal as DELETE /clusters/:id, for clients that cannot send DELETE: one handler ' +
      '(`removeClusterHandler` in router.js), the same checks and the same answer.',
    probe: { skip: 'writes the fleet registry: it removes a cluster; the digest is GET-only' },
    responds: REMOVED,
    effect:
      'What DELETE /clusters/:id writes: the record and token leave the fleet\'s stores and hub Secrets, and the ' +
      'target cluster is untouched. On the same route allowlist in router.test.js.'
  },
  {
    method: POST,
    path: '/clusters/:id/delete',
    topic: 'remove-cluster',
    title: 'Remove a cluster (POST alias)',
    purpose:
      'The same removal as DELETE /clusters/:id, for clients that cannot send DELETE: one handler ' +
      '(`removeClusterHandler` in router.js), the same checks and the same answer.',
    probe: { skip: 'writes the fleet registry: it removes a cluster; the digest is GET-only' },
    responds: REMOVED,
    effect:
      'What DELETE /clusters/:id writes: the record and token leave the fleet\'s stores and hub Secrets, and the ' +
      'target cluster is untouched. On the same route allowlist in router.test.js.'
  },
  {
    method: GET,
    path: '/tokens',
    topic: 'tokens',
    title: 'Service-account tokens',
    purpose:
      'The health of every cluster\'s stored token, never its value: expiry and renewal state per cluster, the ' +
      'renewal interval (12 h) and token lifetime (24 h), whether the caller may renew and remove, and how the ' +
      'in-process renewer is running. Never cached, so it shows the store as it is.'
  },
  {
    method: POST,
    path: '/tokens/:id/renew',
    topic: 'tokens',
    title: 'Renew a cluster\'s token',
    purpose:
      'Renews one cluster\'s token now rather than at the renewer\'s next sweep: mints a successor through a ' +
      'TokenRequest made with the current token, stores it, drops the cluster\'s cache entries, and answers with the ' +
      'new expiry. An unknown id is 404, a cluster with no stored token to renew from is 409 `UNSEEDED`, and a fleet ' +
      'with manual renewal switched off answers 501 `RENEW_DISABLED`; needs the admin scope where it is enforced.',
    probe: { skip: 'writes a freshly minted token to the token store; the digest is GET-only' },
    responds: `// 200 OK
{
  "cluster": "string",    // the cluster's id
  "expiresAt": "string",  // the new token's expiry, as the cluster granted it in the TokenRequest
  "renewedBy": "string"   // the caller's user id
}`,
    effect:
      'Creates a TokenRequest on the target cluster, authenticated by the current token, and writes the new token to ' +
      'the token store and, where a service account is mounted, the hub Secret kyma-fleet-tokens. Minting is how the ' +
      'console gets the short-lived credential it reads with, so the route and mint.js are allowed by both guards in ' +
      'router.test.js.'
  },
  {
    method: GET,
    path: '/me',
    topic: 'me',
    title: 'Caller identity and capabilities',
    purpose:
      'Who the caller is and what this deployment lets them do: the signed-in user\'s fields, whether they hold the ' +
      'admin scope, whether onboarding and token renewal are on, and the SSO callback URL (`FLEET_SSO_CALLBACK_URL`) ' +
      'with whether it is configured and secure, and what is wrong with it if anything. Answered from the request and ' +
      'the configuration alone, with no cluster read and no cache.',
    // One caller's record: under `FLEET_AUTH=none` its `scopes` list is empty and every other field is set.
    probe: { record: true }
  }
];

export default { ROUTES };
