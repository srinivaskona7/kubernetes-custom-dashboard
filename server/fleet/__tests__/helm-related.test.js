/**
 * The per-release live collector: what it will and will not claim about a release.
 *
 * This screen's whole value is that a relationship on it is a fact. Every assertion below is
 * therefore paired: the relationship IS drawn when the proving field is there, and it is NOT drawn
 * when only the names line up. A name-similarity graph looks exactly as convincing as a real one
 * and sends an operator to the wrong object, so the decoy resources here — `bookshop-srv-canary`,
 * an event on it — exist to fail this suite the moment a name fallback creeps in.
 *
 * The four behaviours under test, each with its canary:
 *
 *   relationship typing   six relationship kinds, each from its own field, strongest first
 *   the graph             nodes mirror rows, edges carry evidence, no edge invented
 *   events                joined on involvedObject only
 *   redaction             a Secret returns key names; its values never leave the cluster
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import related from '../collectors/helm-related.js';

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };
const NS = 'demo';
const SECRET_VALUE = 'hunter2-do-not-leak';

/** Encode a release payload the way Helm writes it, then the way the API server serves it. */
function encode(payload) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return Buffer.from(gz.toString('base64'), 'utf8').toString('base64');
}

/**
 * The rendered manifest.
 *
 * `bookshop-worker` is here without Helm's ownership annotations, which is what makes it
 * `helm-managed` rather than `helm-owned`; `bookshop-gone` is here and not live, which is what
 * makes it a `missing` entry.
 */
const MANIFEST = [
  'apiVersion: apps/v1',
  'kind: Deployment',
  'metadata:',
  '  name: bookshop-srv',
  '---',
  'apiVersion: apps/v1',
  'kind: Deployment',
  'metadata:',
  '  name: bookshop-worker',
  '---',
  'apiVersion: v1',
  'kind: ConfigMap',
  'metadata:',
  '  name: bookshop-gone'
].join('\n');

const releaseRecord = {
  name: 'bookshop',
  namespace: NS,
  version: 4,
  info: { status: 'deployed', last_deployed: '2026-09-01T00:00:00Z' },
  chart: { metadata: { name: 'bookshop', version: '1.2.0' }, values: {} },
  config: {},
  manifest: MANIFEST,
  hooks: []
};

const releaseSecret = {
  metadata: { name: 'sh.helm.release.v1.bookshop.v4', namespace: NS, labels: { owner: 'helm', name: 'bookshop' } },
  type: 'helm.sh/release.v1',
  data: { release: encode(releaseRecord) }
};

const HELM_ANNOTATIONS = {
  'meta.helm.sh/release-name': 'bookshop',
  'meta.helm.sh/release-namespace': NS
};

const podTemplate = {
  metadata: { labels: { app: 'bookshop' } },
  spec: {
    serviceAccountName: 'bookshop-sa',
    containers: [
      {
        name: 'srv',
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
        envFrom: [{ configMapRef: { name: 'bookshop-config' } }, { secretRef: { name: 'bookshop-creds' } }]
      }
    ]
  }
};

const OBJECTS = {
  deployments: [
    {
      metadata: { name: 'bookshop-srv', namespace: NS, annotations: HELM_ANNOTATIONS, creationTimestamp: '2026-08-01T00:00:00Z' },
      spec: { replicas: 2, selector: { matchLabels: { app: 'bookshop' } }, template: podTemplate },
      status: {
        replicas: 2,
        readyReplicas: 2,
        conditions: [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }]
      }
    },
    // In the rendered manifest, without the annotations. `helm-managed`, not `helm-owned`.
    {
      metadata: { name: 'bookshop-worker', namespace: NS },
      spec: { replicas: 1, template: { metadata: { labels: { app: 'worker' } }, spec: { containers: [{ name: 'w' }] } } },
      status: { replicas: 1, readyReplicas: 1 }
    },
    /**
     * THE DECOY. Shares the release's name prefix and its namespace, and nothing else: no Helm
     * annotation, not in the manifest, no ownerReference, no selector reaches it. It must not
     * appear anywhere in the payload.
     */
    {
      metadata: { name: 'bookshop-srv-canary', namespace: NS },
      spec: { replicas: 1, template: { metadata: { labels: { app: 'canary' } }, spec: { containers: [{ name: 'c' }] } } },
      status: { replicas: 1, readyReplicas: 1 }
    }
  ],
  replicasets: [
    {
      metadata: {
        name: 'bookshop-srv-7d9',
        namespace: NS,
        ownerReferences: [{ kind: 'Deployment', name: 'bookshop-srv' }]
      },
      spec: { replicas: 2, template: podTemplate },
      status: { replicas: 2, readyReplicas: 2 }
    }
  ],
  pods: [
    {
      metadata: {
        name: 'bookshop-srv-7d9-abcde',
        namespace: NS,
        labels: { app: 'bookshop' },
        ownerReferences: [{ kind: 'ReplicaSet', name: 'bookshop-srv-7d9' }]
      },
      spec: { containers: [{ name: 'srv' }] },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ restartCount: 0 }] }
    }
  ],
  services: [
    {
      metadata: { name: 'bookshop-svc', namespace: NS },
      spec: { type: 'ClusterIP', selector: { app: 'bookshop' }, ports: [{ name: 'http', port: 80, targetPort: 4004 }] }
    }
  ],
  configmaps: [{ metadata: { name: 'bookshop-config', namespace: NS }, data: { LEVEL: 'info' } }],
  secrets: [
    {
      metadata: { name: 'bookshop-creds', namespace: NS },
      type: 'Opaque',
      data: { password: Buffer.from(SECRET_VALUE, 'utf8').toString('base64') }
    }
  ],
  serviceaccounts: [{ metadata: { name: 'bookshop-sa', namespace: NS } }],
  horizontalpodautoscalers: [
    {
      metadata: { name: 'bookshop-hpa', namespace: NS },
      spec: { scaleTargetRef: { kind: 'Deployment', name: 'bookshop-srv' }, minReplicas: 2, maxReplicas: 5 },
      status: { currentReplicas: 2, desiredReplicas: 2 }
    }
  ],
  events: [
    {
      involvedObject: { kind: 'Deployment', namespace: NS, name: 'bookshop-srv' },
      type: 'Normal',
      reason: 'ScalingReplicaSet',
      message: 'Scaled up replica set bookshop-srv-7d9 to 2',
      lastTimestamp: '2026-09-15T10:00:00Z',
      firstTimestamp: '2026-09-15T10:00:00Z',
      source: { component: 'deployment-controller' },
      count: 1
    },
    // THE DECOY EVENT. Its involvedObject is the canary, whose name contains a related resource's
    // name. A prefix or `includes` join would attach this to `bookshop-srv`.
    {
      involvedObject: { kind: 'Deployment', namespace: NS, name: 'bookshop-srv-canary' },
      type: 'Warning',
      reason: 'FailedCreate',
      message: 'canary quota exceeded',
      lastTimestamp: '2026-09-15T11:00:00Z'
    }
  ]
};

/**
 * A listFn that answers by path.
 *
 * The release record and the live Secret list are both `/secrets`, told apart by the label
 * selector — which is exactly how the collector itself distinguishes them.
 */
const listFn = async ({ path }) => {
  if (path.includes('labelSelector=owner')) return [releaseSecret];
  if (path.includes('/events')) return OBJECTS.events;
  for (const [resource, items] of Object.entries(OBJECTS)) {
    if (resource === 'events') continue;
    if (path.includes(`/${resource}`)) return items;
  }
  return [];
};

const collect = () => related.related({ cluster, token: 't', listFn, namespace: NS, name: 'bookshop' });

test('each relationship is typed from the field that proves it, strongest claim first', async () => {
  const payload = await collect();
  const byId = new Map(payload.resources.map(r => [r.id, r]));

  const expected = [
    ['Deployment/demo/bookshop-srv', 'helm-owned', /meta\.helm\.sh\/release-name/],
    ['Deployment/demo/bookshop-worker', 'helm-managed', /rendered manifest of revision 4/],
    ['ReplicaSet/demo/bookshop-srv-7d9', 'owner-reference', /ownerReferences names Deployment\/bookshop-srv/],
    ['Pod/demo/bookshop-srv-7d9-abcde', 'owner-reference', /ownerReferences names ReplicaSet\/bookshop-srv-7d9/],
    ['Service/demo/bookshop-svc', 'selector', /spec\.selector matches Pod\//],
    ['ConfigMap/demo/bookshop-config', 'configuration-reference', /envFrom of Deployment\/bookshop-srv/],
    ['Secret/demo/bookshop-creds', 'configuration-reference', /envFrom of Deployment\/bookshop-srv/],
    ['ServiceAccount/demo/bookshop-sa', 'configuration-reference', /pod spec of Deployment\/bookshop-srv/],
    ['HorizontalPodAutoscaler/demo/bookshop-hpa', 'runtime', /scaleTargetRef names Deployment\/bookshop-srv/]
  ];

  for (const [id, relationship, evidence] of expected) {
    const row = byId.get(id);
    assert.ok(row, `${id} is missing from the resolved set`);
    assert.equal(row.relationship, relationship, `${id} was typed ${row.relationship}`);
    assert.match(row.evidence, evidence, `${id}'s evidence does not name the field it came from`);
  }

  // Every row carries evidence. A row without it is a relationship an operator has to take on
  // trust, which is the thing this collector exists to avoid.
  for (const row of payload.resources) {
    assert.ok(row.evidence && row.evidence.length > 3, `${row.id} carries no evidence`);
  }
});

test('a resource that only shares the release name is not related to it', async () => {
  const payload = await collect();
  const ids = payload.resources.map(r => r.id);

  assert.ok(
    !ids.includes('Deployment/demo/bookshop-srv-canary'),
    'the canary Deployment was claimed by this release on the strength of its name alone'
  );
  // CANARY: the same assertion said the other way round. If the resolver ever accepts by name, the
  // canary appears and this count goes up — the number is here so a silent extra row is a failure.
  assert.equal(payload.counts.byKind.Deployment, 2, 'exactly the two Deployments Helm rendered');
});

test('the graph mirrors the rows, and no edge exists without a field behind it', async () => {
  const payload = await collect();
  const nodeIds = new Set(payload.graph.nodes.map(n => n.id));

  // One synthetic root plus one node per row. The root is the release itself, which is not a
  // cluster resource and deliberately never appears on the Resources tab.
  assert.equal(payload.graph.nodes.length, payload.resources.length + 1);
  assert.ok(nodeIds.has('release'));
  for (const r of payload.resources) assert.ok(nodeIds.has(r.id), `${r.id} has a row but no node`);

  for (const e of payload.graph.edges) {
    assert.ok(nodeIds.has(e.from), `edge ${e.id} starts at a node that is not in the graph`);
    assert.ok(nodeIds.has(e.to), `edge ${e.id} ends at a node that is not in the graph`);
    assert.ok(e.evidence && e.evidence.length > 3, `edge ${e.id} carries no evidence`);
    assert.ok(e.explanation && e.explanation.length > 3, `edge ${e.id} carries no explanation`);
    assert.ok(!e.id.includes('canary'), `edge ${e.id} reaches the decoy`);
  }

  const has = (from, type, to) => payload.graph.edges.some(e => e.from === from && e.type === type && e.to === to);
  assert.ok(has('release', 'helm-managed', 'Deployment/demo/bookshop-srv'), 'the release does not reach what it installed');
  assert.ok(
    has('Deployment/demo/bookshop-srv', 'owner', 'ReplicaSet/demo/bookshop-srv-7d9'),
    'the ownerReference chain is not drawn'
  );
  assert.ok(
    has('Service/demo/bookshop-svc', 'selector', 'Pod/demo/bookshop-srv-7d9-abcde'),
    'the Service does not reach the pod its selector matches'
  );
  assert.ok(
    has('HorizontalPodAutoscaler/demo/bookshop-hpa', 'targets', 'Deployment/demo/bookshop-srv'),
    'the autoscaler does not reach its scale target'
  );
});

test('events attach by involvedObject, never by a name that looks close', async () => {
  const payload = await collect();

  assert.equal(payload.events.length, 1, 'the canary event was attached to this release');
  assert.deepEqual(payload.events[0].resource, { kind: 'Deployment', namespace: NS, name: 'bookshop-srv' });
  assert.equal(payload.events[0].reason, 'ScalingReplicaSet');
  // Gatekeeper-style verbatim rule: the message is the cluster's own sentence, not a rebuild of it.
  assert.equal(payload.events[0].message, 'Scaled up replica set bookshop-srv-7d9 to 2');

  // Coverage is stated so a short list is never read as a quiet release.
  assert.equal(payload.eventCoverage.readable, true);
  assert.equal(payload.eventCoverage.namespaceOnly, true);
  assert.ok(payload.eventCoverage.limit > 0);
});

test('a Secret returns its key names and never its values', async () => {
  const payload = await collect();
  const secret = payload.resources.find(r => r.kind === 'Secret');

  assert.ok(secret, 'the referenced Secret was not resolved at all');
  assert.deepEqual(secret.facts.keys, ['password'], 'the key names are what the drawer shows');
  assert.equal(secret.facts.type, 'Opaque');
  assert.equal(secret.status, null, 'a Secret publishes no status, and inventing one would be a green tick nothing checked');

  // The whole payload, not just the Secret's row: a value could leak through an event message, a
  // fact on another resource or a graph label just as easily.
  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes(SECRET_VALUE), 'a decoded Secret value reached the payload');
  assert.ok(
    !serialised.includes(Buffer.from(SECRET_VALUE, 'utf8').toString('base64')),
    'a base64 Secret value reached the payload — encoded is not redacted'
  );
  assert.ok(!/"stringData"/.test(serialised), 'stringData reached the payload');
});

test('live status is per kind, and a statusless kind says so rather than reporting a tick', async () => {
  const payload = await collect();
  const byId = new Map(payload.resources.map(r => [r.id, r]));

  const deployment = byId.get('Deployment/demo/bookshop-srv');
  assert.equal(deployment.status.tone, 'ok');
  assert.equal(deployment.status.ready, 2);
  assert.equal(deployment.status.desired, 2);
  assert.equal(deployment.facts.rolloutComplete, true);

  assert.equal(byId.get('Pod/demo/bookshop-srv-7d9-abcde').status.tone, 'ok');
  // CANARY: a generic "Ready" derivation would give these two a status. Only one of a dozen real
  // Kinds publishes a Ready condition, so a ConfigMap's status has to be null, not green.
  assert.equal(byId.get('ConfigMap/demo/bookshop-config').status, null);
  assert.equal(byId.get('ServiceAccount/demo/bookshop-sa').status, null);
});

test('a rendered resource with no live object is reported, and only when its kind was readable', async () => {
  const payload = await collect();

  assert.equal(payload.rendered.count, 3, 'three documents were rendered');
  const gone = payload.rendered.missing.find(m => m.name === 'bookshop-gone');
  assert.ok(gone, 'the rendered ConfigMap with no live object was not reported');
  assert.equal(gone.readable, true, 'the ConfigMap list succeeded, so its absence is a real finding');

  // The two Deployments the manifest names are both live, so neither is missing.
  assert.deepEqual(payload.rendered.missing.map(m => m.name), ['bookshop-gone']);
});

test('a refused Kind read makes an absence unconfirmed rather than a finding', async () => {
  // Same fixture, with the ConfigMap list refused. `bookshop-gone` is still not found, but now the
  // reason might be the read rather than the cluster — and `readable: false` is what says so.
  const refusing = async args => {
    if (args.path.includes('/configmaps')) {
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    }
    return listFn(args);
  };

  const payload = await related.related({ cluster, token: 't', listFn: refusing, namespace: NS, name: 'bookshop' });
  const gone = payload.rendered.missing.find(m => m.name === 'bookshop-gone');

  assert.ok(gone, 'the rendered ConfigMap is still listed');
  assert.equal(gone.readable, false, 'an unread Kind must not have its absence reported as confirmed');
  assert.ok(
    payload.summary.unavailable.includes('configmaps'),
    'the refused read is named in the completeness summary'
  );
  // The referenced ConfigMap cannot be resolved either, and that is a gap, not a deletion.
  assert.ok(!payload.resources.some(r => r.kind === 'ConfigMap'), 'no ConfigMap row survives a refused list');
});

/**
 * A Kyma APIRule is the only place the release's real public address is written down. The
 * hostname in `spec.hosts` is the shoot domain; the one operators type is the `x-forwarded-host`
 * the rule rewrites. Both are reported, and a missing one is `null` rather than a guess.
 */
const apiRule = ({ hosts = [], service = { name: 'approuter', port: 8080 }, rules = [] } = {}) => ({
  metadata: { name: 'approuter', namespace: NS },
  spec: { gateway: 'kyma-system/kyma-gateway', hosts, service, rules }
});

const HEADER_RULE = [{ path: '/*', request: { headers: { 'x-forwarded-host': 'responder-dev.example.com' } } }];

const graphOf = facts => {
  const resources = [
    { id: `APIRule/${NS}/approuter`, kind: 'APIRule', name: 'approuter', namespace: NS, group: 'Networking', relationship: 'helm-owned', evidence: 'test', facts },
    { id: `Service/${NS}/approuter`, kind: 'Service', name: 'approuter', namespace: NS, group: 'Networking', relationship: 'helm-owned', evidence: 'test', facts: {} }
  ];
  return related.buildGraph({ release: { name: 'bookshop', namespace: NS }, resources, live: new Map(), namespace: NS });
};

const routesEdge = graph => graph.edges.find(e => e.type === 'routes-to' && e.from === `APIRule/${NS}/approuter`);

test('an APIRule reports the forwarded host operators actually hit, and the graph names it', () => {
  const f = related.factsFor('APIRule', apiRule({ hosts: ['approuter-applecare.c-9d0a141.kyma.ondemand.com'], rules: HEADER_RULE }));

  assert.equal(f.forwardedHost, 'responder-dev.example.com');
  assert.deepEqual(f.hosts, ['approuter-applecare.c-9d0a141.kyma.ondemand.com']);
  assert.equal(f.service, 'approuter');
  assert.equal(f.port, 8080);
  assert.equal(f.gateway, 'kyma-system/kyma-gateway');
  // No scheme is invented: whether this is https is not stated anywhere in the manifest.
  assert.ok(!f.forwardedHost.includes('://'), 'a URL scheme was synthesised from a hostname');

  const edge = routesEdge(graphOf(f));
  assert.equal(edge.to, `Service/${NS}/approuter`);
  assert.equal(edge.evidence, 'APIRule routes external host responder-dev.example.com to Service/approuter');
});

test('the forwarded-host header is read whatever its casing, since HTTP headers are case-insensitive', () => {
  const capitalised = related.factsFor('APIRule', apiRule({
    rules: [{ path: '/*', request: { headers: { 'X-Forwarded-Host': 'responder-dev.example.com' } } }]
  }));
  assert.equal(capitalised.forwardedHost, 'responder-dev.example.com');
});

test('the first non-empty forwarded host across the rules wins, and an unrelated header is not one', () => {
  const f = related.factsFor('APIRule', apiRule({
    rules: [
      { path: '/healthz', request: { headers: { 'x-request-id': 'abc' } } },
      { path: '/*', request: { headers: { 'x-forwarded-host': 'second-rule.example.com' } } }
    ]
  }));
  assert.equal(f.forwardedHost, 'second-rule.example.com');
});

test('without a header the shoot host is still reported, and it is not promoted to the forwarded host', () => {
  const f = related.factsFor('APIRule', apiRule({ hosts: ['approuter-applecare.c-9d0a141.kyma.ondemand.com'] }));

  assert.equal(f.forwardedHost, null, 'a host was invented for a rule that declares no header');
  assert.deepEqual(f.hosts, ['approuter-applecare.c-9d0a141.kyma.ondemand.com']);

  // The edge still exists — the backend is named — and falls back to the declared host.
  assert.equal(routesEdge(graphOf(f)).evidence, 'APIRule routes external host approuter-applecare.c-9d0a141.kyma.ondemand.com to Service/approuter');
});

test('an APIRule with no host at all says so, rather than the graph claiming an address', () => {
  const f = related.factsFor('APIRule', apiRule({ rules: [{ path: '/*', request: { headers: { 'x-forwarded-host': '  ' } } }] }));

  assert.equal(f.forwardedHost, null, 'a whitespace-only header value is not a host');
  assert.deepEqual(f.hosts, []);

  const edge = routesEdge(graphOf(f));
  assert.ok(edge, 'the backend is named, so the routing edge still holds');
  assert.ok(!/external host/.test(edge.evidence), 'evidence claims an external host that no field states');
});

test('an APIRule without spec.service draws no edge rather than one to a fabricated target', () => {
  const f = related.factsFor('APIRule', apiRule({ service: null, rules: HEADER_RULE }));

  assert.equal(f.service, null);
  assert.equal(f.port, null);
  assert.equal(f.forwardedHost, 'responder-dev.example.com');
  assert.equal(routesEdge(graphOf(f)), undefined, 'an edge was drawn to a Service the APIRule never names');
});
