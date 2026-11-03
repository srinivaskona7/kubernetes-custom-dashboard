/**
 * One definition per column *concept*, shared by every table that shows it.
 *
 * The point is not to save keystrokes — it is that "Restarts" has to mean the same thing on the
 * Workloads table, the Pods table and the Reliability table, and the only way that stays true is for
 * there to be one sentence rather than three. `table-alignment.test.js` already enforces that one
 * header label means one alignment across the console; this is the same argument applied to meaning,
 * which is the half an operator actually needs.
 *
 * Every line here answers the question an operator has when a number surprises them: *where did this
 * come from, and what is it not telling me?* So each names its source and, where there is one, its
 * limitation — and none of them describes the UI. Three rules:
 *
 *  1. **Name the API object or the collector's source.** "from metrics-server", "from the pod spec",
 *     "decoded from the release Secret". A sentence that cannot be checked against
 *     `srv/fleet/collectors/` will drift the first time a collector changes.
 *  2. **State the limitation if it changes what the number means.** A metrics-server figure is an
 *     instantaneous sample with no history behind it; a restart count spans every container lifecycle
 *     in the pod, not the current one. Both are the difference between a right and a wrong reading.
 *  3. **No verdicts.** These explain the column, not the cluster. "High usage is bad" is an opinion
 *     that belongs on the row that has a tone, not in a definition.
 *
 * Keys are camelCase concepts, not header strings, because two tables legitimately render the same
 * concept under different labels (`Ready` and `Ready / Desired`) and the concept is what has to be
 * single.
 */
export const COLUMN_INFO = {
  /** The user-specified wording, kept verbatim, with the provenance it implies spelled out. */
  cpuUsedReq:
    'Actual usage from metrics-server vs requested cores in the pod spec. The usage half is an instantaneous sample — this console keeps no metrics history — and is absent entirely on a cluster where metrics-server does not answer.',
  memUsedReq:
    'Actual usage from metrics-server vs the memory requested in the pod spec. The usage half is an instantaneous sample, not a peak: a container that was OOM-killed a minute ago reads low here.',
  cpuRequest:
    'Cores requested in the pod spec, summed across containers. This is what the scheduler reserves, not what is being used — live usage needs metrics-server, which this cluster is not answering for.',
  memRequest:
    'Memory requested in the pod spec, summed across containers. This is what the scheduler reserves, not what is in use — live usage needs metrics-server, which this cluster is not answering for.',

  ready: 'Running and ready pods vs target desired replicas, from the controller’s own status. A pod that is Running but failing its readiness probe counts on the right and not on the left.',
  restarts:
    'Total container restarts across all pod lifecycles, from the container statuses. It is cumulative since the pod object was created, so a large number can mean one bad afternoon months ago rather than a problem now — the restart timestamp beside it is what distinguishes them.',

  imageDrift:
    'Pods of this Deployment whose live container images differ from the images its template declares, compared per container name after registry defaults are normalised (`nginx` and `docker.io/library/nginx:latest` are the same image). Which pods belong to the Deployment comes from the pod → ReplicaSet → Deployment owner chain, not from its label selector, and a pod mid-termination is excluded. When that chain cannot be read, no drift verdict is computed at all — an empty list then means unknown, not clean.',

  allocatable:
    'CPU and memory the kubelet reports as available to pods on this node — capacity minus what is reserved for the system and the kubelet. It is what the scheduler may fill, not what is filled.',
  podSlots:
    'Pods scheduled on this node against the node’s own pod capacity (110 by default on most distributions). A node can hit this ceiling with CPU and memory to spare.',
  qos: 'The QoS class the kubelet assigned from the pod’s own requests and limits: Guaranteed when every container sets both equal, Burstable when requests are set, BestEffort when neither is. It decides eviction order under node pressure.',
  /* Top Consumers' Share column: the denominator is every sampled pod, so a pod without a sample
     is outside it rather than a zero inside it. */
  clusterShare:
    'This pod’s current sample as a fraction of the sum over every Deployment, StatefulSet and DaemonSet pod that reported one. Job, CronJob and standalone pods, and pods without a sample, are outside the denominator rather than counted as zero.',
  namespaceShare:
    'This namespace’s current usage, summed over its pods that reported a sample, as a fraction of the same sum over every Deployment, StatefulSet and DaemonSet pod in the cluster. Requests and limits play no part.',
  headroom:
    'The sum of requests subtracted from the sum of current samples. A present-tense gap, not a capacity plan — it says nothing about what this namespace used yesterday or will need under load.',

  /* Cost & Budget's attribution table: the weight behind the monthly figure beside it. */
  costShare:
    'The mean of this namespace’s CPU request share and memory request share of cluster allocatable, from the pod specs of its Running and Pending pods. It is what the monthly figure is computed from; the two halves are in the cell’s tooltip. Requests, not usage, so an idle pod still pays for what it reserves.',

  age: 'Time since the object’s creationTimestamp, which is when the API server accepted it — not when its current pods started or when it was last changed.',
  lastSeen:
    'When the API server last recorded this, from the object’s own timestamp. Kubernetes events are garbage-collected after about an hour by default, so an absence here is not evidence that nothing happened.',

  sidecarCoverage:
    'Pods with an injected Istio sidecar against all pods in the namespace. Uncovered pods are outside the mesh: their traffic is neither mTLS-encrypted nor visible to the access logs the Traffic tab reads.',
  certExpiry:
    'The notAfter date on the issued certificate, read from the Certificate or its Secret. It is the certificate the cluster holds — not necessarily the one a client is being served, if an Ingress points somewhere else.',

  hpaReplicas:
    'Current and desired replicas from the HorizontalPodAutoscaler’s status, over the min and max bounds in its spec. The status half is empty until the HPA controller has reconciled the object, so an absent count reads as a dash — a 0 there would be indistinguishable from a workload deliberately scaled to zero.',
  hpaMetrics:
    'Each metric in the HPA’s spec.metrics, with the live reading matched to it from status.currentMetrics. Four of the five metric types are not a CPU or memory utilisation — a Pods, Object or External metric is whatever the custom metrics adapter reports — so only two percentages of the same kind are ever compared here.',

  helmRevision:
    'The revision number decoded from this release’s Helm Secret. The highest revision is not necessarily the deployed one: a failed upgrade leaves a higher revision behind while an earlier one stays live.',
  pvcCapacity:
    'The size requested in the claim, and the size the bound volume actually provides. Neither is how full the volume is — that is not visible to the API server.',

  /* -------------------------------------------------------------- the ingress gateway's own columns
     Every one of these is read out of Envoy's access log, which is a *tail* — so each says what its
     denominator is, because "4xx share" from a bounded sample is not an error rate for the cluster and
     an operator who reads it as one will escalate the wrong thing. */
  ingressServedBy:
    'The VirtualService, Ingress or HTTPRoute that declares this host, matched on the host the object itself lists. Empty means nothing in the cluster publishes it — whatever answered did so through a Gateway with no route behind it.',
  ingressErrorShare:
    'Non-2xx and unanswered records over this host’s own records in the window that was read. A share of the sample, deliberately not called a rate — a tail of N lines has no denominator for the cluster’s traffic.',
  ingressUpstreamLatency:
    'From upstream_service_time — the upstream’s own time, not the end-to-end duration. Absent on every connection rejected before routing, so the sample behind it is smaller than the request count beside it; the cell’s tooltip states how much smaller.',
  ingressRejected:
    'Connections Envoy accepted on this socket and then turned away before routing — response_code 0 with filter_chain_not_found. Not an HTTP error: no request line was ever parsed.',
  ingressTcpConnections:
    'Records with no HTTP request line — a raw TCP proxy, or a connection that produced no response. Counted apart from HTTP requests because folding the two would bury every genuine finding under them.',
  ingressSni:
    'The name the client asked for in the TLS handshake. These records carry no Host header, no path and no method, because Envoy rejected them before parsing a request line — the SNI is the only identity they have.',
  ingressPeerCount:
    'Distinct immediate peer addresses this group came from. One address repeating is a misconfigured client; a hundred addresses with one connection each is a scan.',
  ingressPeerKind:
    'How this address was named: a Pod, Service, endpoint or Node in this cluster, `external` for an address outside it, or `unresolved` for an in-cluster address that matches nothing this reader can see. Every resolution carries the field that proves it on hover.',
  ingressConnects:
    'HTTP CONNECT requests from this address. An ingress gateway is not a forward proxy, so a CONNECT against it is somebody testing whether it will act as one. Counted apart from the error share because it is intent rather than a failure.',
  ingressFlagDetail:
    'Sample `response_code_details` from the lines that carried this flag. This is the field that makes a flag actionable — `NR` alone says "no route", while `filter_chain_not_found` beside it says the connection never matched a listener at all.',

  /* ------------------------------------------------------------------- the traffic failures table
     Measured over all 430 groups on a live cluster before these were written, because several of the
     obvious columns are only *sometimes* populated and a definition that promises a field the payload
     rarely carries is worse than no column. The availability figure is stated wherever it decided the
     wording — it is the difference between "this is empty" and "this is unknown".

     None of these infers a cause. An access log records what Envoy did, never why: 403 is "Envoy
     returned 403", not "an AuthorizationPolicy denied it", and the operator is the one who gets to
     decide which of the several things that produce a 403 happened here. */
  trafficStatus:
    'The HTTP status Envoy recorded for this group, from the access log’s `response_code`. It is what the proxy returned, which is not always what the application decided — a 503 can come from the upstream or from Envoy never reaching it, and the response flag beside it is what separates those.',
  trafficCount:
    'How many records in the window that was read matched this exact group. A count within a bounded tail, not a rate: the same failure at ten times the volume would read the same here if the tail filled before the window closed, which is what the coverage note under the table states.',
  trafficMethod:
    'The request method from the access log. Absent on every record Envoy rejected before parsing a request line — those are grouped under no HTTP response, where there is no method to show rather than a method missing.',
  trafficPath:
    'The request path as logged, with query values that look like credentials stripped by the collector before it left the cluster. Grouped exactly, so two paths differing only by an id are two rows — that is deliberate, because collapsing them would hide which id fails.',
  trafficHost:
    'The `:authority` header — the host the client asked for, not necessarily a host this cluster publishes. A host here with nothing serving it is the interesting case, and it is why this column is not derived from the routes.',
  trafficServedBy:
    'The gateway that handled the request, from the access log. Populated on 381 of 430 groups measured; the upstream cluster Envoy actually routed to is present on only 1, so it is shown in the expanded detail rather than as a column that would read as empty.',
  trafficClient:
    'The immediate peer this group came from, resolved against the objects this reader can see. It is the last hop — behind a load balancer or another proxy it is that hop’s address and not the original caller, and the console deliberately does not read `x_forwarded_for`.',
  trafficDestination:
    'The upstream address Envoy recorded for the request. Empty is a finding rather than a gap: no upstream address means no upstream was ever reached, which is what separates a failing backend from a request that never left the proxy.',
  trafficResponseFlag:
    'Envoy’s own short flag for what it did with the connection, shown only on the groups whose records actually carried one. A dash is "no flag was logged", never "nothing went wrong" — most failures carry no flag at all.',

  trafficCodeCategory:
    'Which class this status falls in, from the code itself: 4xx client, 5xx server, and a separate class for records with no HTTP response at all. Arithmetic on the code, not a judgement about blame — a 404 is classed client-side whether or not the client was at fault.',
  trafficCodeShare:
    'This code’s share of the records that were read, so the column sums to 100% of the sample and not of the cluster’s traffic. The denominator is the window under the table; with 10 of 41 proxies readable it is a share of what could be seen.',

  trafficProxyRead:
    'Whether this proxy’s log could be read in this window. Three states, kept apart on purpose: read, not read because the window’s budget was spent elsewhere, and failed because the read itself errored. Only the third is a fault, and folding the other two into it would report a healthy cluster as broken.',
  trafficProxySpan:
    'The oldest and newest record actually returned for this proxy. It is usually shorter than the time range asked for, because the per-proxy line budget fills before the window does — this is the field that says by how much, rather than letting the requested range imply coverage it does not have.',

  podsTolerating:
    'How many Pods hold a toleration that would permit this taint. Permission, not placement — a Pod counted here may be running anywhere on the cluster, or nowhere. Compare it with the next column, which is the subset actually scheduled on this node.',
  podsOnTaintedNode:
    'How many of the tolerating Pods are actually placed on this node. The gap between this and the previous column is the point: tolerating a taint is what lets the scheduler consider a node, never what sends a Pod to it.',
  tolerationNode:
    'The node this Pod is running on, reported from its spec. It is stated beside the tolerations, not derived from them — a Pod very often tolerates a taint no node is declaring and is scheduled somewhere ordinary.',
  podTolerations:
    'The tolerations declared in this Pod’s own spec. The two Kubernetes injects into every Pod (not-ready and unreachable, both NoExecute) are filtered out, because they qualify every Pod on the cluster and would make this list an inventory rather than an answer. A toleration shown as “any taint” is `operator: Exists` with no key, which tolerates everything — the broadest permission a Pod can hold, and the one that renders as blank fields if it is not named.',

  namespaceWorkloads:
    'Deployments, StatefulSets and DaemonSets in this namespace. Pods are counted on the Overview tile and listed after opening the namespace.',
  namespaceCpu:
    'Read left to right as Used / Request / Limit. Used (a current metrics-server sample, summed over workload-selected pods) against the summed request tick and limit tick. “none” means no pod declared one, which is not a budget of zero.',
  namespaceMemory:
    'Read as Used / Request / Limit. Used against the summed request and limit, as for CPU. Memory at 80% of its limit is flagged because the next event is an OOMKill.',
  podCpu:
    'Read left to right as Used / Request / Limit, summed over the containers that run for the pod\'s life — its regular containers and native sidecars such as istio-proxy. Used is a current metrics-server sample, unknown if any of them has none; “none” means no container declared one; “≥” means some container has no limit, so the pod has no ceiling and is not graded against it.',
  podMemory:
    'Read as Used / Request / Limit, as for CPU. Memory at 80% of its limit is flagged because the next event is an OOMKill.',
  namespaceLastUpdated:
    'The newest workload creation or rollout restart in this namespace. A dash when the namespace holds no workload.'
} as const;

export type ColumnInfoKey = keyof typeof COLUMN_INFO;
