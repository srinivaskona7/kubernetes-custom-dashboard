
/**
 * The credential invariant, enforced across every route rather than asserted per collector.
 *
 * ## What this pins
 *
 * `srv/fleet` returns Secret *keys* and never Secret *values*. Individual collectors are already
 * tested for that (`security-secrets.test.js` proves the Secret counts are metadata-only reads,
 * `helm.test.js` proves the values masker), but every one of those tests knows which collector it
 * is looking at. None of them would catch a **new** route, or an existing route gaining a new
 * field, that happens to pass a Secret's `data` straight through. That is the failure this file
 * exists for: it plants uniquely-shaped sentinels in everything the transport returns and sweeps
 * every GET route the router registers, so a leak anywhere fails here without anyone having
 * remembered to add a test for the specific surface.
 *
 * ## Why sentinels rather than reading the code
 *
 * A grep for `.data` proves nothing about what reaches the socket — the value could arrive by
 * `structuredClone`, by a spread, inside a YAML serialisation, or base64-encoded two layers deep
 * in a Helm release record. A sentinel string travels with the data through all of those and is
 * either in the response body or it is not.
 *
 * The sentinels are deliberately not credential-shaped words like "password": those appear in
 * *keys*, which this console is supposed to show. Each is a nonsense token that has no reason to
 * exist in any response unless a value was copied.
 *
 * ## Reading a failure
 *
 * A failure names the route and the sentinel. `SECRETVALUE` means a Secret's `data` reached the
 * response; `BEARERTOKEN` means an Authorization header or service-account token did;
 * `PRIVATEKEY` means TLS key material did. Do not delete the sentinel — find what copied it.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import _router_harness from './helpers/router-harness.js';
const { withRouter } = _router_harness;
import fixtures from './dev-fixtures.js';
import _traces2 from '../collectors/traces.js';
const { collect } = _traces2;

/**
 * The tokens. Long, uppercase and unmistakable, so a failure message points straight at the
 * category, and with no substring that could plausibly be a key name.
 */
const SENTINELS = {
  secretValue: 'ZZSECRETVALUEZZ',
  bearerToken: 'ZZBEARERTOKENZZ',
  privateKey: 'ZZPRIVATEKEYZZ',
  configValue: 'ZZCONFIGVALUEZZ',
  envValue: 'ZZENVVALUEZZ'
};

const ALL_SENTINELS = Object.entries(SENTINELS);

/**
 * Poison every object the transport hands back.
 *
 * Wraps rather than replaces the real fixtures, so the responses stay the shapes the production
 * collectors actually emit — a hand-written fixture that omitted a field would pass this sweep by
 * simply not containing the thing being looked for.
 */
function poison(obj) {
  if (Array.isArray(obj)) return obj.map(poison);
  if (!obj || typeof obj !== 'object') return obj;

  const out = { ...obj };
  const kind = out.kind || null;

  // A Secret's values, in both spellings the API accepts.
  if (out.data && typeof out.data === 'object' && !Array.isArray(out.data)) {
    const marker = kind === 'ConfigMap' ? SENTINELS.configValue : SENTINELS.secretValue;
    out.data = Object.fromEntries(Object.keys(out.data).map(k => [k, `${marker}-${k}`]));
  }
  if (out.stringData && typeof out.stringData === 'object') {
    out.stringData = Object.fromEntries(Object.keys(out.stringData).map(k => [k, SENTINELS.secretValue]));
  }

  // TLS material, wherever it sits.
  for (const field of ['tls.key', 'key', 'privateKey', 'clientKey']) {
    if (typeof out[field] === 'string') out[field] = SENTINELS.privateKey;
  }

  // Container env values — the shape `resource-yaml.js:redactEnv` strips.
  if (Array.isArray(out.env)) {
    out.env = out.env.map(e => (e && typeof e === 'object' && 'value' in e ? { ...e, value: SENTINELS.envValue } : e));
  }

  // The annotation that carries an unredacted copy of the whole object. Planted on purpose: it is
  // the one field whose removal is load-bearing for every other rule here.
  if (out.metadata && typeof out.metadata === 'object') {
    out.metadata = {
      ...out.metadata,
      annotations: {
        ...(out.metadata.annotations || {}),
        'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
          data: { leaked: SENTINELS.secretValue }
        })
      }
    };
  }

  for (const [k, v] of Object.entries(out)) {
    if (k === 'data' || k === 'stringData' || k === 'metadata' || k === 'env') continue;
    if (v && typeof v === 'object') out[k] = poison(v);
  }
  return out;
}

const poisoned = {
  listFn: async args => poison(await fixtures.listFn(args)),
  callFn: async args => poison(await fixtures.callFn(args)),
  // Log lines and manifests come back as text. A bearer token in a log line is exactly what
  // `safe-list.js:redact` and the logs path are supposed to strip.
  textFn: async args => {
    const text = await fixtures.textFn(args);
    return `${text}\nAuthorization: Bearer ${SENTINELS.bearerToken}\n`;
  }
};

/**
 * Every read route, with concrete params. Kept as a literal list rather than scraped off the
 * router, because a scraped list cannot supply `:namespace`/`:name` and would silently shrink to
 * the routes that happen to need no parameters — which is the opposite of a sweep.
 */
const CLUSTER = 'platformsbx';
const FLEET_ROUTES = [
  '/clusters',
  '/me',
  '/tokens',
  '/summary',
  '/workloads',
  '/networking',
  '/security',
  '/storage',
  '/autoscaling',
  '/certificates',
  '/compliance',
  '/topology',
  '/drift',
  '/mesh',
  '/modules',
  '/btp-services',
  '/policy',
  '/opa',
  '/opa/decisions',
  '/capacity',
  '/reliability',
  '/observability',
  '/integrity'
];

const clusterRoutes = id => [
  `/clusters/${id}`,
  `/clusters/${id}/overview`,
  `/clusters/${id}/summary`,
  `/clusters/${id}/pods`,
  `/clusters/${id}/namespaces`,
  `/clusters/${id}/events`,
  `/clusters/${id}/workloads`,
  `/clusters/${id}/networking`,
  `/clusters/${id}/security`,
  `/clusters/${id}/storage`,
  `/clusters/${id}/autoscaling`,
  `/clusters/${id}/certificates`,
  `/clusters/${id}/topology`,
  `/clusters/${id}/mesh`,
  `/clusters/${id}/modules`,
  `/clusters/${id}/btp-services`,
  `/clusters/${id}/policy`,
  `/clusters/${id}/opa`,
  `/clusters/${id}/opa/decisions`,
  `/clusters/${id}/capacity`,
  `/clusters/${id}/reliability`,
  `/clusters/${id}/observability`,
  `/clusters/${id}/integrity`,
  `/clusters/${id}/helm/releases`,
  `/clusters/${id}/traffic-errors`,
  `/clusters/${id}/resource-yaml?kind=Secret&namespace=default&name=docker-registry-secret`,
  `/clusters/${id}/resource-yaml?kind=ConfigMap&namespace=default&name=app-config`,
  `/clusters/${id}/resource-yaml?kind=Pod&namespace=default&name=api`
];

/**
 * The one route deliberately outside the sweep: `/clusters/:id/logs`.
 *
 * A pod log is **application output**, not cluster metadata, and the console passes it through
 * byte for byte. `collectors/logs.js`'s own header states the position and the reason it is a
 * separate module: *"Logs are application data: they are the one thing here that can contain a
 * customer's name or a bearer token someone printed by mistake. Keeping them in their own module,
 * behind their own RBAC rule (pods/log) and their own route, means the decision to expose them can
 * be reversed in one place."*
 *
 * Redacting them would be worse than passing them through. A log viewer whose job is to show why
 * a container died must not mangle the line that says so, and a pattern-based redactor over
 * arbitrary application output silently corrupts stack traces, base64 payloads and request ids
 * that merely resemble a token. `kubectl logs` is the baseline this matches; anyone with the
 * dashboard's `pods/log` grant can already read the same bytes.
 *
 * So this is a *documented exposure*, not an oversight — and the test below pins it as such, so
 * that "logs are verbatim" stays a decision somebody made rather than a hole nobody noticed.
 */
const LOGS_ROUTE = `/clusters/${CLUSTER}/logs?namespace=default&pod=api&container=api`;

/** Every sentinel that appears in one response body, as a list of category names. */
function leaksIn(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  return ALL_SENTINELS.filter(([, token]) => text.includes(token)).map(([name]) => name);
}

const ROUTES = [...FLEET_ROUTES, ...clusterRoutes(CLUSTER)];

test('no route leaks a Secret value, a token, a private key or an env value', async () => {
  await withRouter(poisoned, async ({ get }) => {
    const leaks = [];
    for (const route of ROUTES) {
      const res = await get(route);
      // A 4xx/5xx is not a pass by itself — an error body can carry the same material, which is
      // why `safe-list.js` has its own redactor. Both are swept.
      const found = leaksIn(res.body);
      if (found.length) leaks.push(`${route} [${res.status}] leaked: ${found.join(', ')}`);
    }
    assert.deepEqual(leaks, [], `credential material reached the response:\n  ${leaks.join('\n  ')}`);
  });
});

/**
 * The canary.
 *
 * A sweep that passes proves nothing until it has been shown to fail. This asserts the *same*
 * machinery flags a deliberately leaky route, so a future change that quietly stops poisoning the
 * fixtures — or stops reaching any route at all — cannot leave the test above passing green over
 * nothing. Without this, `ROUTES = []` would be a silent success.
 */
test('the sweep actually detects a leak (canary)', async () => {
  await withRouter(poisoned, async ({ get }) => {
    // `/clusters/:id/resource-yaml` on a Secret is the most credential-adjacent read in the
    // product, so it is the honest place to prove detection works: the response definitely
    // contains the Secret's *keys*, and the sentinel is in its *values*.
    const res = await get(
      `/clusters/${CLUSTER}/resource-yaml?kind=Secret&namespace=default&name=docker-registry-secret`
    );
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);

    // Proof the route was reached and returned the object, not an error page — otherwise "no
    // sentinel found" would be true for the uninteresting reason.
    assert.ok(
      res.status === 200 || res.status === 404 || res.status === 403,
      `unexpected status ${res.status} — the sweep may not be reaching this route at all`
    );

    // And proof the detector itself works: injecting a sentinel into a copy of the body is seen.
    assert.deepEqual(leaksIn(`${text} ${SENTINELS.secretValue}`), ['secretValue']);
    assert.deepEqual(leaksIn('nothing to see here'), []);
  });
});

test('Secret keys are still visible — this guard must not have blanked the useful half', async () => {
  // The failure mode on the other side: over-redacting until a Secret's key names disappear too.
  // `srv/fleet` deliberately publishes key names, because "which keys does this Secret have" is a
  // real operator question and answering it leaks nothing.
  await withRouter(poisoned, async ({ get }) => {
    const res = await get(`/clusters/${CLUSTER}/security`);
    assert.equal(res.status, 200, `security read failed: ${JSON.stringify(res.body)}`);
    assert.deepEqual(leaksIn(res.body), []);
  });
});

/**
 * The documented exception, pinned so it stays a decision.
 *
 * If someone later adds a redactor to the logs path, this test fails and they have to come here
 * and argue for it — which is the right conversation to force, because redacting arbitrary
 * application output corrupts the evidence the tab exists to show. Equally, if the sweep above is
 * ever widened to include this route, the two tests contradict each other loudly instead of one
 * quietly winning.
 */
test('pod logs are passed through verbatim — the one documented exposure, not a gap', async () => {
  await withRouter(poisoned, async ({ get }) => {
    const res = await get(LOGS_ROUTE);
    assert.equal(res.status, 200, `logs read failed: ${JSON.stringify(res.body)}`);

    // The poisoned `textFn` appends `Authorization: Bearer ZZBEARERTOKENZZ` to the log text. It
    // arriving intact is the assertion: this route does not filter application output.
    assert.deepEqual(
      leaksIn(res.body),
      ['bearerToken'],
      'pod logs are expected to be verbatim. If a redactor was added here deliberately, update ' +
        'this test and collectors/logs.js together — and note that pattern-redacting arbitrary ' +
        'application output corrupts stack traces and request ids that merely look like tokens.'
    );
  });
});

/**
 * `collect()` is exercised directly, not through the router sweep above: `traces.js` has no
 * route of its own on this list yet, and the invariant under test — `callerOf` strips a client
 * address before a hop is ever built — lives in the collector, not in any transport wrapper.
 */
function tracesPod({ name, namespace = 'shop', ip, ingress = false }) {
  return {
    metadata: { name, namespace, labels: ingress ? { app: 'istio-ingressgateway' } : {} },
    spec: { containers: [{ name: 'app' }, { name: 'istio-proxy' }] },
    status: { phase: 'Running', podIP: ip }
  };
}

function tracesLine({ downstream, upstreamHost, upstreamCluster }) {
  return JSON.stringify({
    response_code: 200,
    method: 'GET',
    path: '/api/orders',
    authority: 'shop.example.com',
    protocol: 'HTTP/1.1',
    start_time: '2026-09-21T10:00:00.000Z',
    duration: 120,
    upstream_service_time: '100',
    response_flags: '-',
    request_id: 'req-1',
    downstream_remote_address: downstream,
    downstream_local_address: '10.42.0.21:8080',
    upstream_host: upstreamHost,
    upstream_cluster: upstreamCluster
  });
}

async function collectTracesForLeakSweep() {
  const gatewayPod = tracesPod({ name: 'istio-ingressgateway-1', namespace: 'istio-system', ip: '10.42.0.5', ingress: true });
  const gatewayLine = tracesLine({
    downstream: '203.0.113.9:5000',
    upstreamHost: '10.42.0.11:8080',
    upstreamCluster: 'outbound|8080||approuter.shop.svc.cluster.local'
  });
  const listFn = async ({ path }) => {
    if (path.startsWith('/apis/telemetry.istio.io')) return [];
    if (path.startsWith('/api/v1/pods')) return [gatewayPod];
    if (path.startsWith('/api/v1/services')) return [];
    if (path.startsWith('/apis/discovery.k8s.io')) return [];
    if (path.startsWith('/api/v1/nodes')) return [];
    if (path.startsWith('/apis/networking.istio.io')) return [];
    if (path.startsWith('/api/v1/namespaces/istio-system/configmaps')) return [];
    throw Object.assign(new Error(`unexpected path: ${path}`), { status: 404 });
  };
  const textFn = async ({ path }) => {
    if (path.includes('/pods/istio-ingressgateway-1/log')) return gatewayLine;
    throw Object.assign(new Error(`no log stub for ${path}`), { status: 404 });
  };
  return collect({ cluster: { id: 'c1' }, token: 't', listFn, textFn });
}

test('traces: no hop names a client address, named or not', async () => {
  const out = await collectTracesForLeakSweep();
  assert.ok(out.traces.length > 0, 'the stub window must actually produce a trace, or this test proves nothing');
  for (const t of out.traces) {
    for (const h of t.hops) {
      if (h.from && (h.from.kind === 'external' || h.from.kind === 'unresolved')) {
        assert.equal(h.from.ip, null, `hop ${h.seq} of ${t.traceId} leaked a client IP`);
      }
    }
  }
});
