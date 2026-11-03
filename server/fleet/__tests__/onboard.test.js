/**
 * Onboarding.
 *
 * The bootstrap sequence writes RBAC into somebody's cluster, so the tests assert the
 * exact objects it sends, not merely that it succeeded. Three properties matter most:
 *
 *   - the read-only ClusterRole contains no write verb anywhere;
 *   - the self-mint Role is pinned to fleet-reader by resourceNames, so the account can
 *     renew itself and impersonate nothing;
 *   - the TokenRequest carries no `audiences` — a token minted with one is rejected as a
 *     bearer, which was verified against a real cluster and is the single easiest way to
 *     break the whole chain.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import onboard from '../onboard.js';
import _errors from '../errors.js';
const { ClusterError } = _errors;

const CLUSTER = { id: 'platform-dev', apiUrl: 'https://api.example.com', caData: null };

/** A fake API server: records every call and answers from a table of path handlers. */
function fakeApi(overrides = {}) {
  const calls = [];
  const callFn = async args => {
    calls.push(args);
    const key = `${args.method || 'GET'} ${args.path}`;
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (key.startsWith(pattern)) return typeof handler === 'function' ? handler(args) : handler;
    }
    if (args.path === '/version') return { gitVersion: 'v1.30.4' };
    if (args.path.endsWith('/token')) {
      return { status: { token: 'minted-token', expirationTimestamp: '2026-09-01T00:00:00Z' } };
    }
    return {};
  };
  return { calls, callFn };
}

function find(calls, method, pathFragment) {
  return calls.find(c => (c.method || 'GET') === method && c.path.includes(pathFragment));
}

test('a happy-path onboard runs every step in order and returns the first token', async () => {
  const api = fakeApi();
  const out = await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });

  assert.equal(out.token, 'minted-token');
  assert.equal(out.expiresAt, '2026-09-01T00:00:00Z');
  assert.equal(out.kubernetesVersion, 'v1.30.4');
  assert.deepEqual(
    out.steps.map(s => s.id),
    ['probe', 'namespace', 'account', 'rbac', 'selfmint', 'mint', 'verify']
  );
});

test('the probe happens before anything is created', async () => {
  const api = fakeApi();
  await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });
  assert.equal(api.calls[0].path, '/version');
});

test('a dead credential fails at the probe, before a single object is written', async () => {
  const api = fakeApi({
    'GET /version': () => {
      throw new ClusterError('UNAUTHENTICATED', 'token rejected', { cluster: CLUSTER.id, status: 401 });
    }
  });
  await assert.rejects(() => onboard.bootstrap({ cluster: CLUSTER, adminToken: 'bad', callFn: api.callFn }));
  assert.equal(api.calls.length, 1, 'nothing beyond the probe should have been attempted');
});

test('the read-only ClusterRole grants no write verb anywhere', async () => {
  const api = fakeApi();
  await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });
  const role = find(api.calls, 'POST', '/clusterroles');
  const verbs = new Set(role.body.rules.flatMap(r => r.verbs));
  // The reader ClusterRole is read-only, full stop. `update`/`patch` on Secrets used to live
  // here for "rotation" and were removed: nothing on a managed cluster writes a Secret.
  assert.deepEqual([...verbs].sort(), ['get', 'list', 'watch']);
  for (const forbidden of ['create', 'update', 'patch', 'delete', 'deletecollection', '*']) {
    assert.ok(!verbs.has(forbidden), `the reader role must never grant ${forbidden}`);
  }
});

test('Secrets are readable, never written, created or deleted', async () => {
  const rules = onboard.readOnlyRules();
  const secretRule = rules.find(r => r.resources.includes('secrets'));
  assert.deepEqual(secretRule.verbs, ['get', 'list', 'watch']);
  // `list` is load-bearing: it is how Helm release Secrets are read, and a GET-by-name is
  // refused wherever a role grants list without get.
  assert.ok(secretRule.verbs.includes('list'));
  for (const forbidden of ['create', 'update', 'patch', 'delete', 'deletecollection', '*']) {
    assert.ok(!secretRule.verbs.includes(forbidden), `never ${forbidden} on a Secret`);
  }
});

test('pods/log is its own rule, so it can be dropped without touching anything else', () => {
  const rule = onboard.readOnlyRules().find(r => r.resources.includes('pods/log'));
  assert.deepEqual(rule, { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] });
});

test('the self-mint Role is pinned to fleet-reader by resourceNames', async () => {
  const api = fakeApi();
  await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });
  const role = find(api.calls, 'POST', `/namespaces/${onboard.FLEET_NAMESPACE}/roles`);
  assert.deepEqual(role.body.rules, [
    { apiGroups: [''], resources: ['serviceaccounts/token'], resourceNames: [onboard.FLEET_SA], verbs: ['create'] }
  ]);
});

test('the TokenRequest carries no audiences — a scoped token is rejected as a bearer', async () => {
  const api = fakeApi();
  await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });
  const mint = find(api.calls, 'POST', '/token');
  assert.equal(mint.body.spec.expirationSeconds, onboard.FIRST_TOKEN_SECONDS);
  assert.ok(!('audiences' in mint.body.spec), 'audiences must never be sent');
});

/**
 * The read-only invariant, asserted against what onboarding actually PUTs on the cluster
 * rather than against the shape of `readOnlyRules()`.
 *
 * These replace two tests that checked the removed `kyma-fleet-rollout` grant behaved itself.
 * That grant is gone: nothing consumed it after the restart/scale routes were deleted, and
 * `allowRollout` was a field on the public onboarding body, so a curl could provision `patch`
 * on every workload in a cluster for a feature that no longer existed. The tests it needed are
 * replaced by the two below, which fail if any write verb returns by any route.
 */
test('onboarding sends no write verb on any cluster resource', async () => {
  const api = fakeApi();
  await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });

  const WRITE = new Set([
    'create', 'update', 'patch', 'delete', 'deletecollection',
    'bind', 'escalate', 'impersonate', 'approve', 'sign',
    'exec', 'attach', 'portforward', '*'
  ]);
  const offences = [];
  for (const c of api.calls) {
    for (const rule of (c.body && c.body.rules) || []) {
      for (const verb of rule.verbs || []) {
        if (!WRITE.has(verb)) continue;
        // The single allowed exception, and it is namespaced and pinned by resourceNames:
        // fleet-reader creating a token for fleet-reader. That is the renewal chain's hinge.
        const selfMint =
          verb === 'create' &&
          (rule.resources || []).join() === 'serviceaccounts/token' &&
          (rule.resourceNames || []).join() === onboard.FLEET_SA;
        if (!selfMint) offences.push(`${c.body.kind}/${c.body.metadata.name}: ${verb} on ${(rule.resources || rule.nonResourceURLs || []).join()}`);
      }
    }
  }
  assert.deepEqual(offences, [], `write verbs granted:\n  ${offences.join('\n  ')}`);
});

test('an onboarding request cannot ask for extra permission', async () => {
  const api = fakeApi();
  // Every key a caller could smuggle in through the request body. bootstrap() must ignore all
  // of them: its grant is a constant, not a function of untrusted input.
  await onboard.bootstrap({
    cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn,
    allowRollout: true, rollout: true, allowWrite: true, extraRules: [
      { apiGroups: ['apps'], resources: ['deployments'], verbs: ['patch'] }
    ]
  });
  const roles = api.calls.filter(c => c.body && c.body.kind === 'ClusterRole');
  assert.equal(roles.length, 1, 'exactly one ClusterRole, whatever the request asked for');
  assert.equal(roles[0].body.metadata.name, onboard.CLUSTER_ROLE);
  assert.deepEqual(roles[0].body.rules, onboard.readOnlyRules());
  assert.ok(!api.calls.some(c => JSON.stringify(c.body || {}).includes('kyma-fleet-rollout')));
});

test('a second onboard of the same cluster repairs the objects instead of failing', async () => {
  // Everything already exists: every POST answers 409, exactly as a real API server would.
  const api = fakeApi({
    'POST /api/v1/namespaces': args =>
      args.path.endsWith('/token')
        ? { status: { token: 't', expirationTimestamp: '2026-09-01T00:00:00Z' } }
        : (() => { throw new ClusterError('UPSTREAM', 'already exists', { cluster: CLUSTER.id, status: 409 }); })(),
    'POST /apis/rbac.authorization.k8s.io': () => {
      throw new ClusterError('UPSTREAM', 'already exists', { cluster: CLUSTER.id, status: 409 });
    },
    'GET ': args => (args.path === '/version' ? { gitVersion: 'v1.30.4' } : { metadata: { resourceVersion: '42' } })
  });

  const out = await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });
  assert.equal(out.token, 't');
  assert.ok(out.steps.some(s => /already existed/.test(s.detail)));

  // A replace must carry the resourceVersion it just read, or the API server rejects it.
  const put = api.calls.find(c => c.method === 'PUT');
  assert.equal(put.body.metadata.resourceVersion, '42');
});

test('a 403 during RBAC creation is not swallowed as "already exists"', async () => {
  const api = fakeApi({
    'POST /apis/rbac.authorization.k8s.io': () => {
      throw new ClusterError('FORBIDDEN', 'admin token lacks escalate', { cluster: CLUSTER.id, status: 403 });
    }
  });
  await assert.rejects(
    () => onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn }),
    /escalate/
  );
});

test('a TokenRequest that returns no token is an error, not a silent empty credential', async () => {
  const api = fakeApi({ 'POST /api/v1/namespaces/kyma-fleet/serviceaccounts/fleet-reader/token': { status: {} } });
  await assert.rejects(
    () => onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn }),
    /returned no token/
  );
});

test('the minted token is verified before onboarding is declared successful', async () => {
  const api = fakeApi({
    'GET /api/v1/namespaces?limit=1': () => {
      throw new ClusterError('UNAUTHENTICATED', 'the new token does not authenticate', { cluster: CLUSTER.id, status: 401 });
    }
  });
  await assert.rejects(
    () => onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn }),
    /does not authenticate/
  );
});

test('the verification call uses the new token, not the admin one', async () => {
  const api = fakeApi();
  await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });
  const verify = api.calls[api.calls.length - 1];
  assert.equal(verify.path, '/api/v1/namespaces?limit=1');
  assert.equal(verify.token, 'minted-token');
});

test('every created object is labelled as managed by the dashboard', async () => {
  const api = fakeApi();
  await onboard.bootstrap({ cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn });
  const created = api.calls.filter(c => c.method === 'POST' && c.body && c.body.kind);
  assert.ok(created.length >= 6);
  for (const c of created) {
    if (c.body.kind === 'TokenRequest') continue;
    assert.equal(c.body.metadata.labels['app.kubernetes.io/managed-by'], 'kyma-fleet-dashboard', c.body.kind);
  }
});

test('onStep reports progress as it happens, not only at the end', async () => {
  const api = fakeApi();
  const seen = [];
  await onboard.bootstrap({
    cluster: CLUSTER, adminToken: 'admin', callFn: api.callFn,
    onStep: step => seen.push(step)
  });
  assert.equal(seen[0].id, 'probe');
  assert.equal(seen[seen.length - 1].id, 'verify');
  assert.deepEqual(
    seen.map(s => s.level),
    seen.map(() => 'ok'),
    'bootstrap fails rather than half-succeeds, so no step is ever a warning'
  );
});

/**
 * The single most valuable test in this file: apply() PUT-replaces the whole ClusterRole
 * atomically, so one rule with an empty/missing verbs array is rejected by the API server
 * outright and fails re-onboarding for every cluster, not just the one feature the rule was
 * meant to support. Canary: comment out the `verbs` key on any one rule below and this test
 * goes red; every rule in the array — old and new — must carry a non-empty verbs array.
 */
test('every rule in readOnlyRules() has a non-empty verbs array', () => {
  const rules = onboard.readOnlyRules();
  for (const rule of rules) {
    assert.ok(Array.isArray(rule.verbs) && rule.verbs.length > 0,
      `rule for ${JSON.stringify(rule.apiGroups)}/${JSON.stringify(rule.resources)} has no verbs`);
    // A PolicyRule is resource-shaped or nonResource-shaped, never both and never neither. The
    // API server rejects a rule that mixes them, and a rule with neither grants nothing while
    // looking like it grants something.
    const resourceShaped = Array.isArray(rule.apiGroups) && Array.isArray(rule.resources);
    const urlShaped = Array.isArray(rule.nonResourceURLs);
    assert.ok(resourceShaped !== urlShaped,
      `rule must be resource-shaped or nonResourceURL-shaped, not both/neither: ${JSON.stringify(rule)}`);
  }
});

test('the Wave-1 rule groups are present with get/list/watch only', () => {
  const rules = onboard.readOnlyRules();
  const byGroup = group => rules.filter(r => (r.apiGroups || []).includes(group));

  const kyma = byGroup('operator.kyma-project.io');
  assert.equal(kyma.length, 1);
  // The Kyma CR plus the per-module CRs. `kymas` alone reports the DESIRED module state; the
  // module's own CR reports what its operator observed, and reading only the former is how a
  // broken module gets rendered healthy because its entry exists.
  assert.deepEqual(kyma[0].resources.slice().sort(), [
    'apigateways', 'applicationconnectors', 'btpoperators', 'clusterips', 'eventings',
    'istios', 'kedas', 'kymas', 'modulereleasemetas', 'moduletemplates', 'nats',
    'serverlesses', 'telemetries'
  ]);
  assert.deepEqual(kyma[0].verbs, ['get', 'list', 'watch']);

  const btp = byGroup('services.cloud.sap.com');
  assert.equal(btp.length, 1);
  assert.deepEqual(btp[0].resources.slice().sort(), ['servicebindings', 'serviceinstances']);

  const admission = byGroup('admissionregistration.k8s.io');
  assert.equal(admission.length, 1);
  assert.deepEqual(admission[0].resources.slice().sort(), [
    'mutatingwebhookconfigurations', 'validatingadmissionpolicies',
    'validatingadmissionpolicybindings', 'validatingwebhookconfigurations'
  ]);

  assert.deepEqual(byGroup('templates.gatekeeper.sh')[0].resources, ['constrainttemplates']);

  // The one deliberate resource wildcard: get/list/watch only, never a broader verb.
  const gatekeeperConstraints = byGroup('constraints.gatekeeper.sh');
  assert.equal(gatekeeperConstraints.length, 1);
  assert.deepEqual(gatekeeperConstraints[0].resources, ['*']);
  assert.deepEqual(gatekeeperConstraints[0].verbs, ['get', 'list', 'watch']);

  // Shared by two collectors — must appear exactly once, not duplicated per caller.
  const endpointslices = byGroup('discovery.k8s.io');
  assert.equal(endpointslices.length, 1);
  assert.deepEqual(endpointslices[0].resources, ['endpointslices']);

  assert.deepEqual(byGroup('apiregistration.k8s.io')[0].resources, ['apiservices']);
  assert.deepEqual(byGroup('cert.gardener.cloud')[0].resources.slice().sort(), ['certificates', 'issuers']);

  const monitoring = byGroup('monitoring.coreos.com');
  assert.equal(monitoring.length, 1);
  assert.deepEqual(monitoring[0].resources.slice().sort(), [
    'alertmanagerconfigs', 'alertmanagers', 'podmonitors', 'probes', 'prometheusagents',
    'prometheuses', 'prometheusrules', 'scrapeconfigs', 'servicemonitors', 'thanosrulers'
  ]);

  // telemetry.kyma-project.io already existed before this wave — assert it was merged into,
  // not duplicated into a second, conflicting rule for the same group.
  const telemetry = byGroup('telemetry.kyma-project.io');
  assert.equal(telemetry.length, 1, 'telemetry.kyma-project.io must appear exactly once');
  assert.deepEqual(telemetry[0].resources.slice().sort(), ['logpipelines', 'metricpipelines', 'tracepipelines']);

  // Now explicitly granted (Part-1 RBAC expansion) — verticalpodautoscalers, PVs, KEDA
  // cloudeventsources, and Istio serviceentries/sidecars all read-only.
  assert.equal(byGroup('autoscaling.k8s.io').length, 1);
  assert.deepEqual(byGroup('autoscaling.k8s.io')[0].resources, ['verticalpodautoscalers']);
  assert.equal(rules.some(r => (r.apiGroups || []).includes('') && r.resources.includes('persistentvolumes')), true);
  assert.equal(byGroup('eventing.keda.sh').length, 1);
  const istioNetworking = byGroup('networking.istio.io');
  assert.equal(istioNetworking.length, 1);
  assert.equal(istioNetworking[0].resources.includes('serviceentries'), true);
  assert.equal(istioNetworking[0].resources.includes('sidecars'), true);
});

/**
 * The 2026-09-16 gap audit. Each group below was refused by SubjectAccessReview for
 * `system:serviceaccount:kyma-fleet:fleet-reader` on the platformsbx cluster while its CRDs
 * were installed — the page that needed it could only ever render "unavailable". Canary: drop
 * any one rule from readOnlyRules() and the matching line here goes red.
 */
test('the 2026-09-16 gap audit additions are present, read-only, and one rule per group', () => {
  const rules = onboard.readOnlyRules();
  const byGroup = group => rules.filter(r => (r.apiGroups || []).includes(group));

  const expected = {
    // KEDA proper. `eventing.keda.sh` is Kyma Eventing and holds no autoscaler; the role had
    // only that, so ScaledObjects were unreachable on every cluster running KEDA.
    'keda.sh': ['clustertriggerauthentications', 'scaledjobs', 'scaledobjects', 'triggerauthentications'],
    // Per-pod Gatekeeper ingest status: the only way to tell "policy found nothing" from
    // "policy was never evaluated". Both leave a Constraint's aggregate status empty.
    'status.gatekeeper.sh': [
      'configpodstatuses', 'connectionpodstatuses', 'constraintpodstatuses',
      'constrainttemplatepodstatuses', 'expansiontemplatepodstatuses',
      'mutatorpodstatuses', 'providerpodstatuses'
    ],
    // Holds spec.match.excludedNamespaces — the real exemption list, not one derived from scope.
    'config.gatekeeper.sh': ['configs'],
    // What makes a MutatingWebhookConfiguration attributable to Gatekeeper by evidence rather
    // than by its name, which is the name-matching this codebase refuses everywhere else.
    'mutations.gatekeeper.sh': ['assign', 'assignimage', 'assignmetadata', 'modifyset'],
    'expansion.gatekeeper.sh': ['expansiontemplate'],
    'externaldata.gatekeeper.sh': ['providers'],
    // First hop of DNS → Certificate → Ingress → Service → EndpointSlice → Pod.
    'dns.gardener.cloud': ['dnsannotations', 'dnsentries', 'dnsproviders'],
    'scheduling.k8s.io': ['priorityclasses'],
    'node.k8s.io': ['runtimeclasses'],
    // Controller liveness: a 1/1-ready Deployment whose lease stopped renewing is dead.
    'coordination.k8s.io': ['leases'],
    'events.k8s.io': ['events'],
    'connectivityproxy.sap.com': ['connectivityproxies', 'servicemappings'],
    'gateway.networking.k8s.io': ['gatewayclasses', 'gateways', 'grpcroutes', 'httproutes', 'referencegrants']
  };

  for (const [group, resources] of Object.entries(expected)) {
    const found = byGroup(group);
    assert.equal(found.length, 1, `${group} must appear exactly once, found ${found.length}`);
    assert.deepEqual(found[0].resources.slice().sort(), resources, `${group} resources`);
    assert.deepEqual(found[0].verbs, ['get', 'list', 'watch'], `${group} must be read-only`);
  }

  // Kyma application connectivity, minus the one resource a read verb must never cover:
  // reading a TokenRequest returns a one-time connection token.
  const appconn = byGroup('applicationconnector.kyma-project.io');
  assert.equal(appconn.length, 1);
  assert.deepEqual(appconn[0].resources.slice().sort(), ['applicationmappings', 'applications', 'eventactivations']);
  assert.ok(!appconn[0].resources.includes('tokenrequests'),
    'tokenrequests returns token material — get on it is a credential read');

  // Discovery, granted explicitly rather than inherited from the system:discovery binding that
  // a cluster owner is free to remove. Without it every absence probe starts reporting 403 and
  // the console blames RBAC for modules that are simply not installed.
  const discovery = rules.filter(r => Array.isArray(r.nonResourceURLs));
  assert.equal(discovery.length, 1);
  assert.deepEqual(discovery[0].verbs, ['get']);
  for (const path of ['/apis', '/apis/*', '/version']) {
    assert.ok(discovery[0].nonResourceURLs.includes(path), `discovery must cover ${path}`);
  }

  // The proxy subresources stay refused. A proxy grant is arbitrary HTTP to any port of any
  // workload, so its blast radius is not the object it names — and the Gatekeeper metrics it
  // was requested for sit on a bare containerPort with no Service, so it would reach nothing.
  const everyResource = rules.flatMap(r => r.resources || []);
  for (const forbidden of ['services/proxy', 'pods/proxy', 'nodes/proxy', 'nodes/metrics']) {
    assert.ok(!everyResource.includes(forbidden), `${forbidden} must not be granted`);
  }
});
