/**
 * Onboarding a cluster from an uploaded kubeconfig.
 *
 * The whole point of this module is that the uploaded credential is used **once** and
 * then dropped. It creates a least-privilege identity on the target cluster, mints that
 * identity's first 24h token, and stores only the token. The admin credential is never
 * written to a Secret, never logged, and does not outlive the request.
 *
 * The steps, in order, each idempotent so a retry after a partial failure is safe:
 *
 *   1. probe        — GET /version, so an unreachable cluster or a dead credential fails
 *                     in one second with a clear message instead of half-onboarding.
 *   2. namespace    — create fleet-dashboard if absent.
 *   3. account      — create the fleet-reader ServiceAccount if absent.
 *   4. clusterrole  — create/replace the read-only ClusterRole.
 *   5. binding      — bind the account to it.
 *   6. selfmint     — a namespaced Role letting fleet-reader mint its own successor,
 *                     restricted by resourceNames to itself. This is the hinge the whole
 *                     renewal chain turns on: without it the first token is also the last.
 *   7. mint         — the first 24h token, requested as fleet-reader, not as the admin.
 *
 * Step 7 uses the *admin* credential to mint a token *for* fleet-reader. Every later
 * renewal uses fleet-reader's own token to mint its successor, via step 6's Role. The two
 * paths differ only in who authenticates, which is why a successful onboard proves the
 * chain will keep turning.
 */
import k8sModule from './k8s.js';
const { call } = k8sModule;
import errorsModule from './errors.js';
const { ClusterError } = errorsModule;

const FLEET_NAMESPACE = 'fleet-dashboard';
const FLEET_SA = 'fleet-reader';
const CLUSTER_ROLE = 'fleet-dashboard-reader';
const SELF_MINT_ROLE = 'fleet-dashboard-token-issuer';
const FIRST_TOKEN_SECONDS = 24 * 60 * 60;

/**
 * The read-only ClusterRole granted on every onboarded cluster.
 *
 * get/list/watch and nothing else, on exactly the resources the collectors read. It is
 * written out in full rather than assembled from a wildcard so that reviewing it is a
 * matter of reading it — "what can this dashboard do to my production cluster" should be
 * answerable in ten seconds.
 *
 * pods/log is separate from pods because it is the one rule that exposes application data
 * rather than metadata; anyone tightening this for a production cluster will want to drop
 * that line first.
 *
 * ## What is deliberately NOT granted, and why (audited by SubjectAccessReview 2026-09-16)
 *
 * Every rule below is get/list/watch. The audit that widened this role also refused four
 * things a "read everything" reading of the request would have added, and the reasons are
 * recorded here so a later pass does not add them as an oversight-looking gap:
 *
 * | Refused | Why |
 * |---|---|
 * | `services/proxy`, `pods/proxy`, `nodes/proxy` | A proxy grant is arbitrary HTTP GET to any port of any workload in the cluster. Its scope is not the object it names, so it cannot be reasoned about the way every rule below can. It was requested to reach Gatekeeper's `gatekeeper_validation_request_count`, and measurement killed the case: `gatekeeper-system` exposes only `gatekeeper-webhook-service:443`, port 8888 is a bare containerPort with no Service in front of it, so `services/proxy` would grant the privilege and still reach nothing. |
 * | `nodes/metrics` | Kubelet's raw cAdvisor surface. `metrics.k8s.io` already answers every question the console asks of it, through an aggregated API that is scoped to metrics. |
 * | `applicationconnector.kyma-project.io/tokenrequests` | Reading one returns a one-time connection token. A read verb here IS a credential read. |
 * | `authorization.k8s.io/selfsubjectaccessreviews` | Would let the backend probe its own permissions, but only via POST. A read-only platform does not acquire a write verb to ask a question it can answer by attempting the read and reading the status. |
 *
 * Secrets stay `get/list/watch`, and the values never leave the backend. The console publishes
 * Secret NAMES and KEYS and masks every value — see `collectors/helm.js maskValues`, which is
 * the single place decoded Secret content is projected, and the keys-only convention every
 * other collector follows. RBAC cannot express "names but not values": Kubernetes returns the
 * whole object or nothing, so that boundary is enforced in code, not in this role.
 */
function readOnlyRules() {
  return [
    {
      apiGroups: [''],
      resources: [
        'nodes', 'namespaces', 'pods', 'services', 'events',
        'serviceaccounts', 'configmaps', 'persistentvolumeclaims', 'resourcequotas', 'limitranges',
        'endpoints', 'persistentvolumes', 'replicationcontrollers'
      ],
      verbs: ['get', 'list', 'watch']
    },
    /**
     * Secrets: READ ONLY. `list` is the load-bearing verb — it is how Helm release state is
     * read (`sh.helm.release.v1.*`, labelled `owner=helm`), and a GET-by-name is refused
     * wherever a role grants list without get.
     *
     * `update`/`patch` were granted here once for "rotation" and are removed: nothing on a
     * MANAGED cluster ever writes a Secret. The fleet's own token and cluster records live in
     * `fleet-dashboard-tokens`/`fleet-dashboard-clusters` on the HUB cluster, and `secret-writer.js`
     * reaches them with the POD's service-account token against
     * `https://kubernetes.default.svc` — never with a managed cluster's fleet-reader token.
     * Granting write on every Secret in every namespace of every onboarded cluster bought
     * nothing and would let a compromised dashboard rewrite any credential in the fleet.
     */
    { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    { apiGroups: [''], resources: ['pods/status'], verbs: ['get'] },
    { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'controllerrevisions'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies', 'ingresses', 'ingressclasses', 'servicecidrs'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['metrics.k8s.io'], resources: ['pods', 'nodes'], verbs: ['get', 'list'] },
    { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['autoscaling.k8s.io'], resources: ['verticalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['cert-manager.io'], resources: ['certificates', 'issuers', 'clusterissuers', 'certificaterequests'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['gateway.kyma-project.io'], resources: ['apirules', 'ratelimits'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['telemetry.kyma-project.io'], resources: ['logpipelines', 'tracepipelines', 'metricpipelines'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['telemetry.istio.io'], resources: ['telemetries'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['serverless.kyma-project.io'], resources: ['functions'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['eventing.kyma-project.io'], resources: ['subscriptions'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['eventing.keda.sh'], resources: ['cloudeventsources', 'clustercloudeventsources'], verbs: ['get', 'list', 'watch'] },
    /**
     * KEDA proper. `eventing.keda.sh` above is Kyma Eventing's group and holds no autoscaler —
     * the actual ScaledObject/ScaledJob kinds live under `keda.sh`, which this role never
     * granted. Verified by SubjectAccessReview on 2026-09-16: fleet-reader was refused `list`
     * on all four while the CRDs are installed, so the Autoscaling tab could never show KEDA on
     * a cluster that runs it. TriggerAuthentications name the Secret they read from and never
     * carry its contents, which is the same keys-not-values line the rest of this role holds.
     */
    { apiGroups: ['keda.sh'], resources: ['scaledobjects', 'scaledjobs', 'triggerauthentications', 'clustertriggerauthentications'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['storage.k8s.io'], resources: ['storageclasses', 'csinodes', 'csidrivers', 'volumeattachments', 'csistoragecapacities'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['scheduling.k8s.io'], resources: ['priorityclasses'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['node.k8s.io'], resources: ['runtimeclasses'], verbs: ['get', 'list', 'watch'] },
    // Leases are how you tell a controller is ALIVE rather than merely installed — the holder
    // identity and renew timestamp, nothing else. A Deployment with 1/1 ready pods whose lease
    // stopped renewing is the failure this makes visible.
    { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['get', 'list', 'watch'] },
    // The modern Event API alongside core `events`. Both are granted because which one a given
    // controller writes to is the controller's choice, not ours, and reading only core silently
    // loses whichever half migrated.
    { apiGroups: ['events.k8s.io'], resources: ['events'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['apiextensions.k8s.io'], resources: ['customresourcedefinitions'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['networking.istio.io'], resources: ['virtualservices', 'gateways', 'destinationrules', 'envoyfilters', 'serviceentries', 'sidecars', 'workloadentries', 'workloadgroups', 'proxyconfigs'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['security.istio.io'], resources: ['authorizationpolicies', 'peerauthentications', 'requestauthentications'], verbs: ['get', 'list', 'watch'] },
    // Gateway API. Absent on the clusters measured so far, granted anyway for the same
    // fleet-wide reason as every CRD rule below: Kyma is migrating ingress onto it, and a role
    // applied before that migration must not need re-applying after it.
    { apiGroups: ['gateway.networking.k8s.io'], resources: ['gatewayclasses', 'gateways', 'httproutes', 'grpcroutes', 'referencegrants'], verbs: ['get', 'list', 'watch'] },
    // The following rule groups back Wave-1 collectors. A rule for a CRD that does not exist
    // on a given customer's cluster is harmless in RBAC — it simply never matches anything,
    // and the resulting 404 is correctly turned into an absence signal by safeList/absentList
    // downstream. This is deliberate for every Kyma/Istio/Gatekeeper/Prometheus-Operator/
    // BTP-operator rule below, and must not be "cleaned up" by a future pass that assumes an
    // unused-looking rule is a mistake — the whole point is that this role is applied to a
    // fleet of clusters with different modules installed, before any of them are probed.
    /**
     * Kyma's module CRs, not just the Kyma CR that lists them. `kymas` reports the DESIRED
     * state of a module; the per-module CR here reports what its own operator OBSERVED, and the
     * two disagree exactly when something is wrong. Reading only `kymas` is how a module gets
     * called healthy because its entry exists. Enumerated from the live CRD set on 2026-09-16.
     */
    {
      apiGroups: ['operator.kyma-project.io'],
      resources: [
        'kymas', 'modulereleasemetas', 'moduletemplates',
        'apigateways', 'applicationconnectors', 'btpoperators', 'clusterips',
        'eventings', 'istios', 'kedas', 'nats', 'serverlesses', 'telemetries'
      ],
      verbs: ['get', 'list', 'watch']
    },
    { apiGroups: ['services.cloud.sap.com'], resources: ['serviceinstances', 'servicebindings'], verbs: ['get', 'list', 'watch'] },
    /**
     * Kyma application connectivity. `tokenrequests` is deliberately EXCLUDED: reading one
     * returns a one-time connection token, so a read verb on it is a credential read in every
     * sense that matters. It is the one resource in this whole audit where `get` is not safe.
     */
    { apiGroups: ['applicationconnector.kyma-project.io'], resources: ['applications', 'applicationmappings', 'eventactivations'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['connectivityproxy.sap.com'], resources: ['connectivityproxies', 'servicemappings'], verbs: ['get', 'list', 'watch'] },
    {
      apiGroups: ['admissionregistration.k8s.io'],
      resources: [
        'validatingwebhookconfigurations', 'mutatingwebhookconfigurations',
        'validatingadmissionpolicies', 'validatingadmissionpolicybindings'
      ],
      verbs: ['get', 'list', 'watch']
    },
    { apiGroups: ['templates.gatekeeper.sh'], resources: ['constrainttemplates'], verbs: ['get', 'list', 'watch'] },
    // The one deliberate resource wildcard in this whole role: Gatekeeper mints one CRD per
    // ConstraintTemplate at runtime, so the actual constraint kinds are not knowable ahead of
    // time. get/list/watch only, never broader verbs — do not turn this into an enumerated
    // list later; it would silently miss every constraint kind added after onboarding.
    { apiGroups: ['constraints.gatekeeper.sh'], resources: ['*'], verbs: ['get', 'list', 'watch'] },
    /**
     * The rest of Gatekeeper, and the reason each part is here rather than derived.
     *
     * `status.gatekeeper.sh` is the only PER-POD record of what Gatekeeper actually ingested.
     * A Constraint's own `status` is an aggregate that stays empty both when a policy found
     * nothing and when the audit pod never processed it; the pod statuses separate those two,
     * which is the difference between "compliant" and "not evaluated". Without them the
     * console can only guess, and guessing here means calling an unenforced policy clean.
     *
     * `config.gatekeeper.sh/configs` holds `spec.match.excludedNamespaces` — the real exemption
     * list. The Coverage tab currently derives exclusions from Constraint scope alone, which
     * misses every namespace Gatekeeper itself is configured to skip.
     *
     * `mutations.gatekeeper.sh` is what makes a MutatingWebhookConfiguration attributable: a
     * mutating webhook is Gatekeeper-owned when Gatekeeper has mutators, and Kyma, Istio and
     * cert-manager all register their own. Without this the only way to assign an owner is the
     * webhook's name, which is name-matching — the thing this codebase refuses to do elsewhere.
     *
     * `externaldata.gatekeeper.sh/providers` carries a URL and a CA bundle, both public halves.
     * No provider credential is exposed by reading one.
     */
    {
      apiGroups: ['status.gatekeeper.sh'],
      resources: [
        'constraintpodstatuses', 'constrainttemplatepodstatuses', 'configpodstatuses',
        'mutatorpodstatuses', 'expansiontemplatepodstatuses', 'providerpodstatuses',
        'connectionpodstatuses'
      ],
      verbs: ['get', 'list', 'watch']
    },
    { apiGroups: ['config.gatekeeper.sh'], resources: ['configs'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['mutations.gatekeeper.sh'], resources: ['assign', 'assignimage', 'assignmetadata', 'modifyset'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['expansion.gatekeeper.sh'], resources: ['expansiontemplate'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['externaldata.gatekeeper.sh'], resources: ['providers'], verbs: ['get', 'list', 'watch'] },
    // Shared by policy.js's fail-closed-webhook check and reliability.js's zero-endpoint
    // check — one rule, read by two collectors.
    { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['apiregistration.k8s.io'], resources: ['apiservices'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['cert.gardener.cloud'], resources: ['certificates', 'issuers'], verbs: ['get', 'list', 'watch'] },
    /**
     * Gardener DNS. This is the first hop of the externally-reachable chain
     * `DNS/Host → Certificate → Ingress/APIRule/VirtualService → Service → EndpointSlice → Pod`,
     * and without it the chain has to start at the Certificate and assume the hostname resolves.
     * `dnsproviders` reference their cloud credential by Secret NAME only.
     */
    { apiGroups: ['dns.gardener.cloud'], resources: ['dnsentries', 'dnsproviders', 'dnsannotations'], verbs: ['get', 'list', 'watch'] },
    {
      apiGroups: ['monitoring.coreos.com'],
      resources: [
        'prometheuses', 'prometheusagents', 'servicemonitors', 'podmonitors', 'prometheusrules',
        'probes', 'scrapeconfigs', 'alertmanagers', 'alertmanagerconfigs', 'thanosrulers'
      ],
      verbs: ['get', 'list', 'watch']
    },
    /**
     * Discovery. `observability.js` and `safeList` both GET `/apis/<group>` directly to tell a
     * missing CRD apart from a refused read — an absent-vs-forbidden distinction the whole
     * capability contract rests on. Today that works only because Kubernetes ships
     * `system:discovery` bound to `system:authenticated`, a DEFAULT binding a cluster owner is
     * free to remove; when they do, every absence probe starts returning 403 and the console
     * reports refusals for modules that are simply not installed. Granting it explicitly costs
     * nothing — these paths expose the API shape, never an object.
     */
    {
      nonResourceURLs: [
        '/api', '/api/*', '/apis', '/apis/*', '/version',
        '/healthz', '/readyz', '/livez', '/openapi/v2', '/openapi/v3', '/openapi/v3/*'
      ],
      verbs: ['get']
    }
  ];
}

/**
 * There is no second ClusterRole. `readOnlyRules()` above is the whole grant.
 *
 * A `fleet-dashboard-rollout` role used to live here, created on demand when an onboarding request
 * carried `allowRollout: true`, and it granted `patch` on Deployments, StatefulSets and the
 * three `/scale` subresources. It is removed, because by the time it was audited it had become
 * the worst possible shape for a grant: nothing consumed it and anything could ask for it.
 *
 *   - Nothing consumed it. `POST .../restart` and `POST .../scale` were deleted from the router
 *     when Kyma Fleet became strictly read-only, so no code path anywhere could use the patch
 *     verb it handed out.
 *   - Anything could ask for it. `allowRollout` was a field on the public onboarding request
 *     body. The console hardcoded `false`, but the console is not the security boundary — one
 *     curl with `"allowRollout": true` provisioned standing write permission on every workload
 *     in a production cluster, for a feature that no longer existed.
 *
 * That is exactly the "unused reachable action" a read-only guarantee is supposed to rule out,
 * and a dead grant is harder to spot than a live one. Do not reintroduce it: a rollout restart
 * from this console needs the whole read-only decision revisited, not a role added back.
 */

/** PUT-if-exists, POST-if-not. Kubernetes has no upsert, and 409 is not an error here. */
async function apply({ cluster, token, collectionPath, name, object, callFn = call }) {
  try {
    await callFn({ cluster, token, path: collectionPath, method: 'POST', body: object });
    return 'created';
  } catch (err) {
    if (!(err instanceof ClusterError) || err.status !== 409) throw err;
    // Already there. Replace it, so a re-onboard repairs a hand-edited or outdated role
    // instead of silently leaving the old rules in place.
    const existing = await callFn({ cluster, token, path: `${collectionPath}/${name}` });
    await callFn({
      cluster, token, path: `${collectionPath}/${name}`, method: 'PUT',
      body: { ...object, metadata: { ...object.metadata, resourceVersion: existing.metadata.resourceVersion } }
    });
    return 'updated';
  }
}

const labels = {
  'app.kubernetes.io/managed-by': 'k8s-fleet-dashboard',
  'app.kubernetes.io/part-of': 'fleet-dashboard'
};

/**
 * @param {object} args
 * @param {{id: string, apiUrl: string, caData: string|null}} args.cluster
 * @param {string} args.adminToken   the uploaded credential; used here and nowhere else
 * @param {(step: {id: string, detail: string, level: string}) => void} [args.onStep]
 * @param {typeof call} [args.callFn]  injection seam; the tests drive a fake API server
 * @returns {Promise<{token: string, expiresAt: string,
 *                    steps: Array<{id: string, detail: string, level: string}>}>}
 */
async function bootstrap({ cluster, adminToken, onStep, callFn = call }) {
  const steps = [];
  // Same shape as sa-token.js emits, so the dialog renders either onboarding path with one
  // component. Nothing here is ever a warning: bootstrap fails rather than half-succeeds.
  const record = (id, detail) => {
    const step = { id, detail, level: 'ok' };
    steps.push(step);
    if (onStep) onStep(step);
  };
  const ctx = { cluster, token: adminToken, callFn };
  // The same options minus callFn, for the two steps that call the API directly instead of
  // going through apply(). Built explicitly rather than destructured-and-discarded, so the
  // reader does not have to work out which key the omission was aimed at.
  const plain = { cluster, token: adminToken };

  // 1. Probe. Fail here rather than after creating half an identity.
  const version = await callFn({ ...plain, path: '/version', timeoutMs: 10000 });
  record('probe', `reached ${cluster.apiUrl}, Kubernetes ${version.gitVersion || 'unknown'}`);

  // 2. Namespace.
  record('namespace', await apply({
    ...ctx, collectionPath: '/api/v1/namespaces', name: FLEET_NAMESPACE,
    object: {
      apiVersion: 'v1', kind: 'Namespace',
      // No istio-injection label: nothing runs in this namespace. It holds one service
      // account and its Role, and injecting a sidecar into a namespace with no pods is
      // the kind of drift that confuses the next person to look.
      metadata: { name: FLEET_NAMESPACE, labels }
    }
  }) === 'created' ? `created ${FLEET_NAMESPACE}` : `${FLEET_NAMESPACE} already existed`);

  // 3. Service account.
  record('account', await apply({
    ...ctx, collectionPath: `/api/v1/namespaces/${FLEET_NAMESPACE}/serviceaccounts`, name: FLEET_SA,
    object: {
      apiVersion: 'v1', kind: 'ServiceAccount',
      metadata: { name: FLEET_SA, namespace: FLEET_NAMESPACE, labels }
    }
  }) === 'created' ? `created ${FLEET_SA}` : `${FLEET_SA} already existed`);

  // 4 + 5. Read-only ClusterRole and its binding.
  await apply({
    ...ctx, collectionPath: '/apis/rbac.authorization.k8s.io/v1/clusterroles', name: CLUSTER_ROLE,
    object: {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
      metadata: { name: CLUSTER_ROLE, labels }, rules: readOnlyRules()
    }
  });
  await apply({
    ...ctx, collectionPath: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings', name: CLUSTER_ROLE,
    object: {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
      metadata: { name: CLUSTER_ROLE, labels },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: CLUSTER_ROLE },
      subjects: [{ kind: 'ServiceAccount', name: FLEET_SA, namespace: FLEET_NAMESPACE }]
    }
  });
  record('rbac', `granted read-only access (${readOnlyRules().length} rule groups, get/list/watch only)`);

  // 6. Self-mint. resourceNames pins it to fleet-reader's own token endpoint, so this
  //    account can renew itself and impersonate nothing.
  await apply({
    ...ctx, collectionPath: `/apis/rbac.authorization.k8s.io/v1/namespaces/${FLEET_NAMESPACE}/roles`, name: SELF_MINT_ROLE,
    object: {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
      metadata: { name: SELF_MINT_ROLE, namespace: FLEET_NAMESPACE, labels },
      rules: [{ apiGroups: [''], resources: ['serviceaccounts/token'], resourceNames: [FLEET_SA], verbs: ['create'] }]
    }
  });
  await apply({
    ...ctx, collectionPath: `/apis/rbac.authorization.k8s.io/v1/namespaces/${FLEET_NAMESPACE}/rolebindings`, name: SELF_MINT_ROLE,
    object: {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: SELF_MINT_ROLE, namespace: FLEET_NAMESPACE, labels },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: SELF_MINT_ROLE },
      subjects: [{ kind: 'ServiceAccount', name: FLEET_SA, namespace: FLEET_NAMESPACE }]
    }
  });
  record('selfmint', `${FLEET_SA} may now mint its own successor token — the renewal chain can turn`);

  // 7. The first token. No `audiences`: a token minted with one is rejected as a bearer.
  const minted = await callFn({
    ...plain,
    path: `/api/v1/namespaces/${FLEET_NAMESPACE}/serviceaccounts/${FLEET_SA}/token`,
    method: 'POST',
    body: {
      apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
      spec: { expirationSeconds: FIRST_TOKEN_SECONDS }
    }
  });
  const token = minted && minted.status && minted.status.token;
  const expiresAt = minted && minted.status && minted.status.expirationTimestamp;
  if (!token || !expiresAt) throw new Error('TokenRequest succeeded but returned no token');
  record('mint', `first token issued, expires ${expiresAt}`);

  // 8. Prove it. Minting a token is not the same as the token working — a cluster with an
  //    unusual audience or authenticator configuration fails here rather than at the first
  //    dashboard refresh, while the operator is still looking at the upload dialog.
  await callFn({ cluster, token, path: '/api/v1/namespaces?limit=1' });
  record('verify', 'the new token authenticates and can list namespaces');

  return { token, expiresAt, steps, kubernetesVersion: version.gitVersion || null };
}

export default {
  bootstrap, readOnlyRules,
  FLEET_NAMESPACE, FLEET_SA, CLUSTER_ROLE, SELF_MINT_ROLE, FIRST_TOKEN_SECONDS
};
