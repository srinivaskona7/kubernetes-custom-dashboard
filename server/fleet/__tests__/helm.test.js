/**
 * Helm release collector.
 *
 * The load-bearing behaviours, each with a canary that goes red if the implementation is
 * loosened back to the obvious-but-wrong version:
 *
 *   - the four-layer decode (base64 -> base64 -> gzip -> JSON), including a Secret that is
 *     only single-encoded;
 *   - "the deployed revision is the truth", not simply the highest one — a failed upgrade
 *     leaves a higher revision that never took effect, and reporting it as current would
 *     tell an operator the cluster is running something it is not;
 *   - values merge semantics: maps merge, arrays replace (which is what Helm itself does,
 *     and getting it backwards silently invents configuration nobody set);
 *   - one undecodable Secret must not remove the other releases from the list.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import zlib from 'node:zlib';

import helm from '../collectors/helm.js';

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

/** Encode a release payload the way Helm writes it, then the way the API server serves it. */
function encode(payload, { doubleEncode = true, gzip = true } = {}) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const compressed = gzip ? zlib.gzipSync(json) : json;
  const inner = compressed.toString('base64');
  return Buffer.from(doubleEncode ? inner : compressed.toString('binary'), 'utf8').toString('base64');
}

function secret(payload, opts) {
  const name = `sh.helm.release.v1.${payload.name}.v${payload.version}`;
  return {
    metadata: {
      name,
      namespace: payload.namespace,
      labels: {
        owner: 'helm',
        name: payload.name,
        status: payload.info.status,
        version: String(payload.version)
      }
    },
    type: 'helm.sh/release.v1',
    data: { release: encode(payload, opts) }
  };
}

function release({
  name = 'bookshop',
  namespace = 'btp-platform-foundation',
  version = 1,
  status = 'deployed',
  chartValues = {},
  config = {},
  manifest = '',
  chartVersion = '1.0.0'
} = {}) {
  return {
    name,
    namespace,
    version,
    info: { status, first_deployed: '2026-01-01T00:00:00Z', last_deployed: '2026-09-01T00:00:00Z', description: 'Upgrade complete' },
    chart: { metadata: { name: 'bookshop', version: chartVersion, appVersion: '1.0.0', apiVersion: 'v2' }, values: chartValues },
    config,
    manifest,
    hooks: []
  };
}

/**
 * A listFn that answers the Helm Secret list with `items` and every other path (the workload
 * lists behind the resource tree's health column) with nothing — which is the honest shape of
 * a cluster where the chart's Deployments have been deleted out from under the release.
 */
const listing = items => async ({ path }) => (path.includes('/secrets') ? items : []);

test('a Helm release Secret decodes through base64, base64, gzip and JSON', async () => {
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([secret(release({ chartVersion: '2.3.4' }))])
  });

  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].name, 'bookshop');
  assert.equal(result.releases[0].chart.version, '2.3.4');
  assert.equal(result.releases[0].status, 'deployed');
  assert.equal(result.counts.undecodable, 0);
});

test('a single-encoded, uncompressed payload still decodes', async () => {
  // Not hypothetical: anything that writes a release Secret by hand — a test fixture, an
  // operator patching one — may skip Helm's inner base64 or its gzip. Failing closed on
  // those would report an existing release as unreadable.
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([secret(release({ name: 'plain' }), { doubleEncode: false, gzip: false })])
  });

  assert.equal(result.releases.length, 1, 'a single-encoded payload must not be dropped');
  assert.equal(result.releases[0].name, 'plain');
});

test('the deployed revision is reported as current, not the highest one', async () => {
  // The canary. A failed `helm upgrade` leaves revision 3 in pending-upgrade while the
  // cluster keeps running revision 2. Sorting by revision and taking [0] — the obvious
  // implementation — would report 3, i.e. tell the operator the upgrade landed.
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([
      secret(release({ version: 1, status: 'superseded', chartVersion: '1.0.0' })),
      secret(release({ version: 2, status: 'deployed', chartVersion: '2.0.0' })),
      secret(release({ version: 3, status: 'pending-upgrade', chartVersion: '3.0.0' }))
    ])
  });

  assert.equal(result.releases.length, 1, 'three revisions are one release');
  const [r] = result.releases;
  assert.equal(r.revision, 2, 'the deployed revision is what is running');
  assert.equal(r.chart.version, '2.0.0');
  assert.equal(r.pendingRevision, 3, 'the revision that did not land is still surfaced');
  assert.equal(r.revisionCount, 3);
  assert.deepEqual(r.revisions.map(x => x.revision), [3, 2, 1], 'history is newest first');
});

test('with no deployed revision at all, the newest is reported and flagged', async () => {
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([
      secret(release({ version: 1, status: 'failed' })),
      secret(release({ version: 2, status: 'pending-install' }))
    ])
  });

  const [r] = result.releases;
  assert.equal(r.revision, 2);
  assert.equal(r.status, 'pending-install');
  assert.equal(r.pendingRevision, 2);
  assert.equal(result.counts.notDeployed, 1);
});

test('values are the chart defaults with the operator overrides merged on top', async () => {
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([
      secret(
        release({
          chartValues: { srv: { replicas: 1, image: { tag: 'default', pullPolicy: 'IfNotPresent' } }, extra: true },
          config: { srv: { replicas: 3, image: { tag: 'v9' } } }
        })
      )
    ])
  });

  const [r] = result.releases;
  assert.deepEqual(r.overrides, { srv: { replicas: 3, image: { tag: 'v9' } } }, 'overrides stay the overrides alone');
  assert.deepEqual(
    r.values,
    { srv: { replicas: 3, image: { tag: 'v9', pullPolicy: 'IfNotPresent' } }, extra: true },
    'nested maps merge key-by-key, so an untouched default survives'
  );
  assert.equal(r.hasChartDefaults, true);
});

test('an array override replaces rather than merging, exactly as Helm does', () => {
  // Element-wise merging is the plausible mistake here, and it invents configuration: it
  // would leave a removed entry in place because the shorter override never overwrote it.
  const merged = helm.mergeValues({ hosts: ['a', 'b', 'c'], nested: { list: [1, 2] } }, { hosts: ['only'], nested: { list: [9] } });
  assert.deepEqual(merged, { hosts: ['only'], nested: { list: [9] } });
});

test('an explicit null override wins over a default', () => {
  assert.deepEqual(helm.mergeValues({ tls: { secret: 'x' } }, { tls: null }), { tls: null });
});

test('credential-shaped values are masked, and the keys around them survive', async () => {
  // The convention this enforces: every other Secret read in srv/fleet reports keys and stops
  // (collectors/compliance.js), and safe-list.js redacts credentials out of even error text.
  // A values viewer that returned decoded Secret contents verbatim would be the one place in
  // the codebase handing out credentials to anyone who can reach the dashboard.
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([
      secret(
        release({
          config: {
            replicaCount: 3,
            image: { tag: 'v9', pullPolicy: 'Always' },
            xsuaa: { clientsecret: 'sk-live-abcdef', clientid: 'sb-bookshop' },
            db: { password: 'hunter2', host: 'db.internal', port: 5432 },
            tls: { certificate: '-----BEGIN CERTIFICATE-----', enabled: true },
            apiKey: 'k-123',
            emptySecret: '',
            unsetToken: null
          }
        })
      )
    ])
  });

  const [r] = result.releases;
  assert.deepEqual(r.overrides, {
    replicaCount: 3,
    image: { tag: 'v9', pullPolicy: 'Always' },
    xsuaa: { clientsecret: '[redacted]', clientid: 'sb-bookshop' },
    db: { password: '[redacted]', host: 'db.internal', port: 5432 },
    tls: { certificate: '[redacted]', enabled: true },
    apiKey: '[redacted]',
    // '' and null mean "not set", which is a real finding and reveals nothing.
    emptySecret: '',
    unsetToken: null
  });

  const serialised = JSON.stringify(result);
  for (const leaked of ['sk-live-abcdef', 'hunter2', 'BEGIN CERTIFICATE', 'k-123']) {
    assert.ok(!serialised.includes(leaked), `${leaked} must not cross the wire`);
  }
  assert.ok(serialised.includes('clientsecret'), 'the key stays visible — a missing one is a finding');
});

test('masking preserves array length and nests through arrays', () => {
  assert.deepEqual(helm.maskValues({ tokens: ['a', 'b'], hosts: ['h1', 'h2'] }), {
    tokens: ['[redacted]', '[redacted]'],
    hosts: ['h1', 'h2']
  });
});

test('a benign key that merely contains a masked word is not over-masked', () => {
  // Two guards working together: the key is decomposed into words (so `keyspace` and `monkey`
  // keep their values, while `signingKey` does not), and booleans/numbers are never masked
  // (so a switch that merely mentions a credential stays readable).
  assert.deepEqual(
    helm.maskValues({
      keyspace: 'main',
      monkey: 'patch',
      signingKey: 'zzz',
      certManagerEnabled: true,
      keyLength: 4096,
      cert: 'PEM'
    }),
    {
      keyspace: 'main',
      monkey: 'patch',
      signingKey: '[redacted]',
      certManagerEnabled: true,
      keyLength: 4096,
      cert: '[redacted]'
    }
  );
});

test('an extraEnv name/value pair is masked by its NAME, not by the key "value"', () => {
  // The common chart idiom. Neither `name` nor `value` is credential-shaped, so a purely
  // key-driven walk hands the password straight to the browser.
  const masked = helm.maskValues({
    extraEnv: [
      { name: 'DB_PASSWORD', value: 'hunter2' },
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'CLIENT_SECRET', valueFrom: { secretKeyRef: { name: 'creds', key: 'cs' } } }
    ]
  });
  assert.equal(masked.extraEnv[0].value, '[redacted]');
  assert.equal(masked.extraEnv[0].name, 'DB_PASSWORD', 'the name must survive — that it is set is the finding');
  assert.equal(masked.extraEnv[1].value, 'debug', 'a benign env var stays readable');
  // A secretKeyRef holds no credential, only a pointer to one; masking it would hide which
  // Secret an operator has to look in.
  assert.equal(masked.extraEnv[2].valueFrom.secretKeyRef.name, 'creds');
});

test('a kubeconfig, a dockerconfigjson and a bare pwd are masked', () => {
  const masked = helm.maskValues({
    kubeconfig: 'apiVersion: v1\nclusters:',
    imagePullSecret: { dockerconfigjson: '{"auths":{}}' },
    db: { pwd: 'hunter2', host: 'db.internal' }
  });
  assert.equal(masked.kubeconfig, '[redacted]');
  assert.equal(masked.imagePullSecret.dockerconfigjson, '[redacted]');
  assert.equal(masked.db.pwd, '[redacted]');
  assert.equal(masked.db.host, 'db.internal');
});

test('one undecodable Secret is counted, not fatal', async () => {
  const good = secret(release({ name: 'good' }));
  const bad = {
    metadata: { name: 'sh.helm.release.v1.bad.v1', namespace: 'default', labels: { owner: 'helm', name: 'bad' } },
    type: 'helm.sh/release.v1',
    data: { release: Buffer.from('not a release at all', 'utf8').toString('base64') }
  };

  const result = await helm.collect({ cluster, token: 't', listFn: listing([bad, good]) });

  assert.deepEqual(result.releases.map(r => r.name), ['good'], 'the readable release still lands');
  assert.equal(result.counts.undecodable, 1, 'and the gap is reported rather than swallowed');
});

test('a Secret that is not a Helm release is ignored without counting as undecodable', async () => {
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([
      { metadata: { name: 'tls', namespace: 'default' }, type: 'kubernetes.io/tls', data: { release: 'zzzz' } },
      secret(release())
    ])
  });

  assert.equal(result.releases.length, 1);
  assert.equal(result.counts.undecodable, 0, 'a non-Helm Secret is not a failed read');
});

test('the manifest is parsed into a resource inventory, and never returned verbatim', async () => {
  const manifest = [
    '---',
    '# Source: bookshop/templates/service.yaml',
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: bookshop-srv',
    '  namespace: btp-platform-foundation',
    'spec:',
    '  ports:',
    '    - name: http',
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: bookshop-srv',
    'spec:',
    '  template:',
    '    metadata:',
    '      name: should-not-be-read',
    '---',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: bookshop-config'
  ].join('\n');

  const result = await helm.collect({ cluster, token: 't', listFn: listing([secret(release({ manifest }))]) });
  const [r] = result.releases;

  assert.deepEqual(r.resourceKinds, { Service: 1, Deployment: 1, ConfigMap: 1 });
  assert.equal(r.resourceCount, 3);
  assert.deepEqual(
    r.resources.map(x => `${x.kind}/${x.name}`),
    ['Service/bookshop-srv', 'Deployment/bookshop-srv', 'ConfigMap/bookshop-config'],
    'the name under the top-level metadata is taken, not a nested template name'
  );
  assert.equal('manifest' in r, false, 'the rendered YAML must not cross the wire');
});

test('a refused list is unavailable, never an empty release list read as a zero', async () => {
  const forbidden = async () => {
    const err = new Error('secrets is forbidden');
    err.status = 403;
    throw err;
  };

  const result = await helm.collect({ cluster, token: 't', listFn: forbidden });

  assert.deepEqual(result.releases, []);
  assert.ok(result.summary.unavailable.includes('helm release storage (Secrets)'));
  assert.equal(result.counts.releases, 0);
});

test('a refused release store is forbidden per pane, with the exact reason in each sentence', async () => {
  // The rule the whole capability layer exists for: a missing permission must not arrive as an
  // empty pane. Each record-derived pane names itself, because an operator on the History tab
  // needs to read about history — not a page-level "Helm unavailable".
  const forbidden = async ({ path }) => {
    if (path.includes('/secrets') || path.includes('/configmaps')) {
      const err = new Error('secrets is forbidden: User "system:serviceaccount:fleet:fleet-reader" cannot list resource "secrets"');
      err.status = 403;
      throw err;
    }
    return [];
  };

  const result = await helm.collect({ cluster, token: 't', listFn: forbidden });

  assert.equal(result.storage.capability.state, 'forbidden');
  assert.equal(result.capabilities.history.state, 'forbidden');
  assert.match(result.capabilities.history.sentence, /^Helm release history is unavailable because the read-only service account cannot access /);
  assert.match(result.capabilities.values.sentence, /^Helm release values are unavailable because /);
  assert.match(result.capabilities.manifest.sentence, /^The Helm rendered manifest is unavailable because /);
  assert.equal(result.capabilities.history.trusted, false, 'nothing beside a forbidden state is a fact');

  // The whole point of splitting the verdicts: live inspection has different RBAC and survives.
  assert.equal(result.capabilities.liveInspection.state, 'available');
});

test('an access-refused metadata list is not followed by a second read of the same store', async () => {
  // The deployed-revision read is the same `list` on the same resource as the metadata read, so a
  // 403 or 401 on the first is already the answer to the second. Retrying doubled the refused calls
  // on every refresh of a cluster whose reader role lacks Secrets; a failed read is never cached.
  const seen = [];
  const refuse = status => async ({ path }) => {
    if (!path.includes('/secrets') && !path.includes('/configmaps')) return [];
    seen.push(path);
    const err = new Error('refused');
    err.status = status;
    throw err;
  };

  for (const status of [403, 401]) {
    seen.length = 0;
    const result = await helm.collect({ cluster, token: 't', listFn: refuse(status) });

    assert.equal(seen.length, 2, `${status}: one refused list per driver, Secrets then ConfigMaps`);
    assert.equal(result.storage.capability.state, 'forbidden', `${status}: still reported as refused, not as empty`);
    assert.deepEqual(result.releases, []);
  }
});

test('a metadata list that failed for a reason other than access still falls back to the full read', async () => {
  // The retry exists for this: the index read broke, the contents read may not.
  const stored = secret(release({ name: 'shop' }));
  const reads = [];
  const listFn = async ({ path, accept }) => {
    if (!path.includes('/secrets')) return [];
    reads.push(accept ? 'metadata' : 'full');
    if (accept) {
      const err = new Error('upstream');
      err.status = 500;
      throw err;
    }
    return [stored];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.deepEqual(reads, ['metadata', 'full']);
  assert.deepEqual(result.releases.map(r => r.name), ['shop']);
});

test('release records are read from the ConfigMap driver when the Secret driver holds none', async () => {
  // HELM_DRIVER=configmap stores the identical payload in a ConfigMap, and a ConfigMap carries no
  // `type`, so the Secret type guard must not be applied to it.
  const paths = [];
  const listFn = async ({ path }) => {
    paths.push(path);
    if (path.includes('/configmaps') && path.includes('owner%3Dhelm')) {
      const cm = secret(release({ name: 'cm-release' }));
      delete cm.type;
      return [cm];
    }
    return [];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.equal(result.storage.backend, 'configmap');
  assert.deepEqual(result.releases.map(r => r.name), ['cm-release']);
  assert.equal(result.capabilities.history.state, 'available');
});

test('both drivers readable and empty reports zero AND names the SQL ambiguity', async () => {
  const result = await helm.collect({ cluster, token: 't', listFn: async () => [] });

  assert.equal(result.counts.releases, 0);
  assert.equal(result.storage.backend, 'none');
  assert.equal(result.storage.capability.state, 'available', 'the reads succeeded, so the zero is real');
  assert.match(result.storage.capability.extra.note, /HELM_DRIVER=sql/);
  assert.equal(result.storage.capability.extra.sqlIndistinguishable, true);
});

test('the ConfigMap driver is only read when the Secret driver came back empty', async () => {
  const paths = [];
  const listFn = async ({ path }) => {
    paths.push(path);
    return path.includes('/secrets') && path.includes('owner%3Dhelm') ? [secret(release())] : [];
  };

  await helm.collect({ cluster, token: 't', listFn });

  assert.equal(
    paths.filter(p => p.includes('/configmaps')).length,
    0,
    'the default-driver cluster must pay exactly one release-store request, as it did before'
  );
});

test('releases are read by label selector, never fetched by Secret name', async () => {
  // The reader role is granted `list` on Secrets and may not be granted `get`. A GET-by-name
  // implementation passes every unit test with a permissive double and then 403s in prod.
  const paths = [];
  const listFn = async ({ path }) => {
    paths.push(path);
    return [secret(release())];
  };

  await helm.collect({ cluster, token: 't', listFn });

  const secretPaths = paths.filter(p => p.includes('/secrets'));
  assert.equal(secretPaths.length, 2, 'metadata history plus deployed contents');
  assert.match(secretPaths[0], /^\/api\/v1\/secrets\?/);
  assert.match(secretPaths[0], /labelSelector=owner%3Dhelm/);
  assert.doesNotMatch(secretPaths[0], /sh\.helm\.release/, 'no Secret name may appear in the path');
});

test('the list reads history as metadata and decodes only the deployed record', async () => {
  const paths = [];
  const accepts = [];
  const history = [
    secret(release({ version: 1, status: 'superseded', chartVersion: '1.0.0' })),
    secret(release({ version: 2, status: 'deployed', chartVersion: '2.0.0' })),
    secret(release({ version: 3, status: 'pending-upgrade', chartVersion: '3.0.0' }))
  ];
  const listFn = async ({ path, accept }) => {
    paths.push(path);
    accepts.push(accept);
    if (accept) return history.map(({ metadata }) => ({ metadata }));
    if (path.includes('status%3Ddeployed')) return [history[1]];
    return [];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].chart.version, '2.0.0');
  assert.deepEqual(result.releases[0].revisions.map(r => r.revision), [3, 2, 1]);
  assert.ok(accepts.some(Boolean), 'the history index must request PartialObjectMetadataList');
  assert.ok(paths.some(p => p.includes('status%3Ddeployed')), 'the full payload list is restricted to deployed revisions');
  assert.equal(paths.filter(p => /version%3D\d/.test(p)).length, 0, 'older contents stay on demand');
});

test('a release with no deployed revision reads only its newest revision contents', async () => {
  const history = [
    secret(release({ version: 1, status: 'failed' })),
    secret(release({ version: 2, status: 'pending-install' }))
  ];
  const paths = [];
  const listFn = async ({ path, accept }) => {
    paths.push(path);
    if (accept) return history.map(({ metadata }) => ({ metadata }));
    if (path.includes('version%3D2')) return [history[1]];
    return [];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.equal(result.releases[0].revision, 2);
  assert.ok(paths.some(p => p.includes('version%3D2')));
  assert.ok(!paths.some(p => p.includes('version%3D1')));
});

test('a release whose deployed revision will not decode is withheld and named, not rebuilt from its metadata', async () => {
  // The index lists every revision, but a release is published only beside contents that were
  // read. Its metadata-only history on its own would render empty values and a manifest with no
  // resources as if that were the release.
  const good = secret(release({ name: 'good', version: 1 }));
  const bad1 = secret(release({ name: 'bad', version: 1, status: 'superseded' }));
  const bad2 = secret(release({ name: 'bad', version: 2, status: 'deployed' }));
  const unreadable = { ...bad2, data: { release: Buffer.from('not a release at all', 'utf8').toString('base64') } };
  const listFn = async ({ path, accept }) => {
    if (!path.includes('/secrets')) return [];
    if (accept) return [good, bad1, bad2].map(({ metadata }) => ({ metadata }));
    if (path.includes('status%3Ddeployed')) return [good, unreadable];
    return []; // the fallback read for bad v2 finds nothing either
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.releases.map(r => r.name), ['good'], 'the readable release lands; bad is not published from its metadata');
  assert.equal(result.counts.undecodable, 1);
  assert.ok(result.summary.unavailable.includes('helm release storage (Secrets): current revision contents'), 'the gap is named');
  assert.notEqual(result.capabilities.history.state, 'available', 'a withheld release means the history pane is not complete');
});

test('a deployed read that is not the revision the index named drops that release whole, and only that one', async () => {
  // An upgrade can land between the metadata index and the deployed-contents read: the index says
  // v2 is current, the read returns v3. Publishing v3 under an index that said v2 would mix two
  // reads of one release, so it is withheld and reported; the neighbour that lined up is untouched.
  const shop1 = secret(release({ name: 'shop', version: 1, status: 'superseded' }));
  const shop2 = secret(release({ name: 'shop', version: 2, status: 'deployed' }));
  const shop3 = secret(release({ name: 'shop', version: 3, status: 'deployed' }));
  const other = secret(release({ name: 'other', version: 1 }));
  const listFn = async ({ path, accept }) => {
    if (!path.includes('/secrets')) return [];
    if (accept) return [shop1, shop2, other].map(({ metadata }) => ({ metadata }));
    if (path.includes('status%3Ddeployed')) return [shop3, other];
    return [];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.releases.map(r => r.name), ['other'], 'shop is withheld, not shown as revision 3 beside an index that said 2');
  assert.ok(result.summary.unavailable.includes('helm release storage (Secrets): current revision contents'));
});

test('a release payload that omits its namespace is keyed by the Secret it came from', async () => {
  // Without the fallback, the index (keyed by the Secret's namespace) and the decoded record
  // (keyed by "undefined") disagree, so the release is read a second time and then dropped.
  const full = release({ name: 'bookshop', namespace: 'apps' });
  const payload = { ...full };
  delete payload.namespace;
  const stored = secret(full);
  stored.data.release = encode(payload);
  const paths = [];
  const listFn = async ({ path, accept }) => {
    if (!path.includes('/secrets')) return [];
    paths.push(path);
    return accept ? [{ metadata: stored.metadata }] : [stored];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  assert.deepEqual(result.releases.map(r => `${r.namespace}/${r.name}`), ['apps/bookshop']);
  assert.equal(paths.filter(p => /version%3D\d/.test(p)).length, 0, 'the deployed read covered it; no per-revision fallback');
});

test('one release name in two namespaces keeps each namespace its own revision history', async () => {
  // The index, the deployed read and the history merge all key a release as `namespace/name`. Keyed
  // by name alone, ns-b's deployed v1 would stand in for ns-a's superseded v1 and ns-a would lose
  // a revision from its history.
  const a1 = secret(release({ name: 'shared', namespace: 'ns-a', version: 1, status: 'superseded' }));
  const a2 = secret(release({ name: 'shared', namespace: 'ns-a', version: 2, status: 'deployed' }));
  const b1 = secret(release({ name: 'shared', namespace: 'ns-b', version: 1, status: 'deployed' }));
  const listFn = async ({ path, accept }) => {
    if (!path.includes('/secrets')) return [];
    if (accept) return [a1, a2, b1].map(({ metadata }) => ({ metadata }));
    if (path.includes('status%3Ddeployed')) return [a2, b1];
    return [];
  };

  const result = await helm.collect({ cluster, token: 't', listFn });

  const byNamespace = Object.fromEntries(result.releases.map(r => [r.namespace, r]));
  assert.deepEqual(byNamespace['ns-a'].revisions.map(r => r.revision), [2, 1]);
  assert.deepEqual(byNamespace['ns-b'].revisions.map(r => r.revision), [1]);
});

test('a requested Helm revision lists that revision only', async () => {
  const paths = [];
  const listFn = async ({ path }) => {
    paths.push(path);
    return [secret(release({ version: 2, status: 'superseded' }))];
  };

  const result = await helm.manifest({ cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop', revision: 2, listFn });

  assert.equal(result.revision, 2);
  assert.ok(paths[0].includes('version%3D2'));
  assert.ok(!paths[0].includes('status%3Ddeployed'));
});

const MANIFEST = [
  'apiVersion: apps/v1',
  'kind: Deployment',
  'metadata:',
  '  name: bookshop-srv',
  '---',
  'apiVersion: apps/v1',
  'kind: DaemonSet',
  'metadata:',
  '  name: bookshop-agent',
  '---',
  'apiVersion: v1',
  'kind: ConfigMap',
  'metadata:',
  '  name: bookshop-config'
].join('\n');

/** listFn answering the Helm Secret list plus the three workload lists behind the health join. */
const listingWithWorkloads = (items, workloads) => async ({ path }) => {
  if (path.includes('/secrets')) return items;
  for (const [resource, objs] of Object.entries(workloads)) {
    if (path.includes(`/${resource}`)) return objs;
  }
  return [];
};

test('the resource tree joins rendered resources to live health, per kind', async () => {
  const ns = 'btp-platform-foundation';
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listingWithWorkloads([secret(release({ manifest: MANIFEST }))], {
      deployments: [{ metadata: { name: 'bookshop-srv', namespace: ns }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }],
      // A DaemonSet reports numberReady/desiredNumberScheduled; reading the Deployment fields
      // for it would report a healthy agent as 0/1 Unavailable.
      daemonsets: [{ metadata: { name: 'bookshop-agent', namespace: ns }, status: { desiredNumberScheduled: 3, numberReady: 3 } }]
    })
  });

  const byName = Object.fromEntries(result.releases[0].resources.map(r => [r.name, r]));

  assert.deepEqual(byName['bookshop-srv'].health, { ready: 2, desired: 2, state: 'Ready' });
  assert.deepEqual(byName['bookshop-agent'].health, { ready: 3, desired: 3, state: 'Ready' });
  assert.equal(byName['bookshop-srv'].linkable, true);
  // A ConfigMap has no health state to report, and inventing "Healthy" for it would put a green
  // tick next to an object nothing verified. Not linkable either — Workloads cannot open it.
  assert.equal(byName['bookshop-config'].health, null);
  assert.equal(byName['bookshop-config'].linkable, false);
});

test('a manifest entry without a namespace is joined in the release namespace', async () => {
  // Helm installs a namespace-less manifest entry into the release namespace; joining it as
  // `Deployment/undefined/name` would report every such resource as missing from the cluster.
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listingWithWorkloads([secret(release({ namespace: 'ns-a', manifest: MANIFEST }))], {
      deployments: [{ metadata: { name: 'bookshop-srv', namespace: 'ns-a' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } }]
    })
  });
  const r = result.releases[0].resources.find(x => x.name === 'bookshop-srv');
  assert.equal(r.namespace, 'ns-a');
  assert.equal(r.health.state, 'Ready');
});

test('a rendered workload missing from the cluster is null health, not an invented state', async () => {
  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listingWithWorkloads([secret(release({ manifest: MANIFEST }))], {})
  });
  const r = result.releases[0].resources.find(x => x.name === 'bookshop-srv');
  assert.equal(r.health, null);
  assert.equal(r.linkable, true, 'the kind reports health, so the UI can call this one "not found"');
});

test('a refused workload list is reported unavailable rather than read as "not found"', async () => {
  const listFn = async ({ path }) => {
    if (path.includes('/secrets')) return [secret(release({ manifest: MANIFEST }))];
    if (path.includes('/deployments')) {
      const err = new Error('deployments is forbidden');
      err.status = 403;
      throw err;
    }
    return [];
  };
  const result = await helm.collect({ cluster, token: 't', listFn });
  assert.ok(
    result.summary.unavailable.includes('deployment health'),
    'without this label the tree shows "not found" next to workloads it was simply not allowed to read'
  );
});

test('credentials are masked by the SHAPE of the value when the key says nothing', () => {
  // The key vocabulary only works when the author named the key after what it holds. These are
  // all real chart shapes where they did not.
  const masked = helm.maskValues({
    env: { DATABASE_URL: 'postgres://user:pw@db.internal:5432/shop' },
    databaseUrl: 'postgres://user:pw@db.internal:5432/shop',
    sasl: { 'jaas.config': 'org.apache.kafka.PlainLoginModule required password="hunter2";' },
    connectionOptions: 'host=db.internal;user=shop;password=hunter2',
    webhookUrl: 'https://hooks.slack.com/services/T0/B0/XXXXXXXX',
    ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    blob: '{"auths":{"registry.example":{"auth":"abc"}}}',
    annotation: 'header eyJhbGciOiJSUzI1NiJ9.payload.sig'
  });

  // A URL keeps its host, port and database — that is what the screen is FOR. Only the
  // userinfo goes.
  assert.equal(masked.env.DATABASE_URL, 'postgres://[redacted]@db.internal:5432/shop');
  assert.equal(masked.databaseUrl, 'postgres://[redacted]@db.internal:5432/shop');
  // `jaas.config` names itself (the `jaas` word), so the KEY rule masks it whole before the
  // value pass is reached — belt and braces, and the stronger of the two wins.
  assert.equal(masked.sasl['jaas.config'], '[redacted]');
  // An inline assignment under a key that names nothing: only the credential goes.
  assert.equal(masked.connectionOptions, 'host=db.internal;user=shop;password=[redacted]');
  // A webhook URL IS the credential — there is no safe half to keep.
  assert.equal(masked.webhookUrl, '[redacted]');
  assert.equal(masked.ca, '[redacted]');
  assert.equal(masked.blob, '[redacted]');
  // A JWT embedded in a string under a key that names nothing still goes — all three segments
  // of it, since the signature is as much the credential as the header.
  assert.equal(masked.annotation, 'header [redacted]');
});

test('the value-shape pass does not touch ordinary strings', () => {
  assert.deepEqual(
    helm.maskValues({
      image: 'registry.example/srv:1.4.2',
      host: 'https://shop.example.com/path?a=b',
      replicaCount: 3,
      note: 'password rotation is manual',
      logLevel: 'debug'
    }),
    {
      image: 'registry.example/srv:1.4.2',
      // No userinfo, so nothing is redacted — a plain URL is the most useful thing on the screen.
      host: 'https://shop.example.com/path?a=b',
      replicaCount: 3,
      // Prose that merely mentions a credential has no assignment to redact.
      note: 'password rotation is manual',
      logLevel: 'debug'
    }
  );
});

test('a chart dependency repository keeps its host but loses inline credentials', async () => {
  const payload = release();
  payload.chart.metadata.dependencies = [
    { name: 'redis', version: '1.0.0', repository: 'https://user:pw@charts.internal/stable' }
  ];
  const result = await helm.collect({ cluster, token: 't', listFn: listing([secret(payload)]) });
  assert.equal(result.releases[0].chart.dependencies[0].repository, 'https://[redacted]@charts.internal/stable');
});

test('a refused health read renders as unreadable, never as "not found"', async () => {
  // The whole point: an empty index is indistinguishable from "the object is not there", so one
  // missing RBAC rule would otherwise make every workload in every release read a confident red
  // "not found" — the opposite of the truth.
  const listFn = async ({ path }) => {
    if (path.includes('/secrets')) return [secret(release({ manifest: MANIFEST }))];
    if (path.includes('/deployments')) {
      const err = new Error('deployments is forbidden');
      err.status = 403;
      throw err;
    }
    return [];
  };
  const result = await helm.collect({ cluster, token: 't', listFn });
  const byName = Object.fromEntries(result.releases[0].resources.map(r => [r.name, r]));

  assert.equal(byName['bookshop-srv'].healthReadable, false, 'the Deployment list was refused');
  assert.equal(byName['bookshop-srv'].health, null);
  // The DaemonSet list came back fine and is genuinely empty, so that one IS a true "not found".
  assert.equal(byName['bookshop-agent'].healthReadable, true);
  // A kind with no health state to report is never "unreadable" either.
  assert.equal(byName['bookshop-config'].healthReadable, true);
});

test('two releases of the same name in different namespaces stay separate', async () => {  const result = await helm.collect({
    cluster,
    token: 't',
    listFn: listing([
      secret(release({ name: 'shared', namespace: 'ns-a' })),
      secret(release({ name: 'shared', namespace: 'ns-b' }))
    ])
  });

  assert.equal(result.releases.length, 2);
  assert.deepEqual(result.releases.map(r => r.namespace), ['ns-a', 'ns-b']);
  assert.equal(result.counts.namespaces, 2);
});

/**
 * The masking walk propagated its "the key above me named a credential" flag into arrays but
 * dropped it for object children, so every leaf one level under a credential-named key was
 * re-judged on its own key alone. `apiKeys.mobile` is the shape that matters: `apiKeys`
 * matches, `mobile` does not, and the value is opaque enough that the value-shape pass does
 * not catch it either — so it reached the browser in cleartext from the one endpoint in this
 * codebase that returns decoded Secret contents at all.
 */
test('a credential nested under a credential-named key is masked, not just a direct child', () => {
  const masked = helm.maskValues({
    apiKeys: { mobile: 'a83f9c1d2e4b6a7f', web: 'ff01bc9928ae4d31' },
    secrets: { database: { username: 'svc_app', password: 'hunter2' } },
    tokens: { ci: { value: '9f8e7d6c5b4a3210' } },
    // Structure must still be legible: the operator needs to see THAT these are set.
    replicaCount: 3,
    image: { repository: 'ghcr.io/acme/api', tag: 'v1.4.2' }
  });

  assert.equal(masked.apiKeys.mobile, helm.MASKED, 'a leaf under apiKeys must not survive');
  assert.equal(masked.apiKeys.web, helm.MASKED);
  assert.equal(masked.secrets.database.password, helm.MASKED, 'masking must reach two levels down');
  assert.equal(masked.secrets.database.username, helm.MASKED,
    'everything under `secrets` is a credential until proven otherwise — over-masking is the safe side here');
  assert.equal(masked.tokens.ci.value, helm.MASKED);

  // The point of the screen survives.
  assert.equal(masked.replicaCount, 3);
  assert.equal(masked.image.repository, 'ghcr.io/acme/api');
  assert.equal(masked.image.tag, 'v1.4.2');
  assert.deepEqual(Object.keys(masked.secrets.database), ['username', 'password'],
    'the shape stays visible — a missing credential is itself a finding');
});

test('an Authorization header value and a bare `pw` key are masked', () => {
  const masked = helm.maskValues({
    extraHeaders: { Authorization: 'Basic YWRtaW46aHVudGVyMg==' },
    pw_value: 'hunter2',
    db: { pw: 'hunter2' }
  });
  // `Bearer <x>` was already caught by the value-shape rule; Basic was not, and
  // `authorization` matched neither the word list (`auth`) nor the substring pattern.
  assert.equal(masked.extraHeaders.Authorization, helm.MASKED);
  assert.equal(masked.pw_value, helm.MASKED);
  assert.equal(masked.db.pw, helm.MASKED);
});

test('a reference key publishes its pointer even under an inherited credential flag', () => {
  // Sensitivity is inherited downward now, and `secretKeyRef` matches the `secret` substring.
  // Both facts would redact the pointer if reference keys did not reset the flag — including
  // when the reference is itself nested under a credential-named parent, which is the case
  // the reset exists for.
  const masked = helm.maskValues({
    secrets: { db: { valueFrom: { secretKeyRef: { name: 'db-creds', key: 'password' } } } }
  });
  const ref = masked.secrets.db.valueFrom.secretKeyRef;
  assert.equal(ref.name, 'db-creds', 'which Secret to look in must survive two credential-named ancestors');
  assert.equal(ref.key, helm.MASKED, '`key` is a sensitive word in its own right and still masks');
});

/**
 * Over-masking is a data-integrity bug, not a safe default.
 *
 * Every path below was read off the live `applecare-responder` release on 2026-09-16 and came
 * back `[redacted]` while holding no credential at all — a zone name, a label key, a rotation
 * interval, a Secret's own name. A values screen that blanks an operator's scheduling
 * configuration is as wrong as one that leaks a password: they cannot tell which of the two it
 * did, so they cannot trust either verdict.
 *
 * The pairing in each case is what makes the fix safe: the false positive opens, and a real
 * credential sitting in the same subtree still masks, because the resets only clear what was
 * INHERITED and never what a leaf's own key says.
 */
test('a Kubernetes label-key field is a name, not key material', () => {
  const masked = helm.maskValues({
    topologySpreadConstraints: [
      { topologyKey: 'topology.kubernetes.io/zone', matchLabelKeys: ['pod-template-hash'], maxSkew: 1 }
    ],
    // The words that earned `key` its place on the list are untouched by the carve-out.
    tls: { key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', signingKey: 's3cret', privateKey: 'p' }
  });

  const c = masked.topologySpreadConstraints[0];
  assert.equal(c.topologyKey, 'topology.kubernetes.io/zone', 'a zone name is what the constraint is for');
  assert.deepEqual(c.matchLabelKeys, ['pod-template-hash']);
  assert.equal(c.maxSkew, 1);

  assert.equal(masked.tls.key, helm.MASKED, 'a bare `key` still masks');
  assert.equal(masked.tls.signingKey, helm.MASKED, 'the carve-out is a fixed list, not "any word before key"');
  assert.equal(masked.tls.privateKey, helm.MASKED);
});

test('a subtree that describes credential handling keeps its settings readable', () => {
  const masked = helm.maskValues({
    bindings: {
      auth: { serviceInstanceName: 'applecare-auth', enabled: true, password: 'hunter2' },
      defaultProperties: {
        credentialsRotationPolicy: { enabled: true, rotationFrequency: '24h', rotatedBindingTTL: '48h' },
        secretKey: 'sa-key'
      }
    },
    // A scalar named `auth` is still a credential — the reset applies to subtrees only.
    registry: { auth: 'dXNlcjpwdw==' }
  });

  assert.equal(masked.bindings.auth.serviceInstanceName, 'applecare-auth');
  assert.equal(masked.bindings.auth.enabled, true);
  assert.equal(masked.bindings.auth.password, helm.MASKED, 'a leaf is still judged on its own key');

  const rot = masked.bindings.defaultProperties.credentialsRotationPolicy;
  assert.equal(rot.rotationFrequency, '24h', 'whether rotation is on is exactly what the page is for');
  assert.equal(rot.rotatedBindingTTL, '48h');
  assert.equal(masked.bindings.defaultProperties.secretKey, helm.MASKED,
    'a chart that puts real key material under `secretKey` (MinIO does) must still mask');

  assert.equal(masked.registry.auth, helm.MASKED, 'a scalar `auth` is not a section');
});

test('a `name` under a credential-named parent names the object it points at', () => {
  const masked = helm.maskValues({
    global: { imagePullSecret: { name: 'docker-registry-secret' } },
    // The same release's Architecture tab already renders this Secret's name as a graph node, so
    // blanking it here contradicted the app's own output.
    secrets: { db: { name: 'db-creds', password: 'hunter2', apiKey: 'a83f9c1d' } },
    extraEnv: [{ name: 'DB_PASSWORD', value: 'hunter2' }]
  });

  assert.equal(masked.global.imagePullSecret.name, 'docker-registry-secret');
  assert.equal(masked.secrets.db.name, 'db-creds');
  assert.equal(masked.secrets.db.password, helm.MASKED, 'the carve-out is the `name` leaf alone');
  assert.equal(masked.secrets.db.apiKey, helm.MASKED);
  assert.equal(masked.extraEnv[0].name, 'DB_PASSWORD', 'the env NAME is what tells you what was set');
  assert.equal(masked.extraEnv[0].value, helm.MASKED);
});

test('a `name` that carries a credential inside a URL is still scrubbed', () => {
  // The `name` carve-out clears the INHERITED flag; it does not skip the value-shape pass, which
  // is the backstop for a credential under a key that names nothing.
  const masked = helm.maskValues({
    secrets: { upstream: { name: 'postgres://svc:hunter2@db.internal:5432/app' } }
  });
  assert.equal(masked.secrets.upstream.name, 'postgres://[redacted]@db.internal:5432/app');
});

// ------------------------------------------------------- manifest & chart source view

/**
 * The manifest view is the only surface that returns rendered cluster YAML to a browser, so
 * its redaction is the whole control. Every test below is a leak test: each one was run
 * against a `redactDocument` that returned its input unchanged and confirmed red first.
 *
 * The load-bearing distinction is `data:` on a Secret versus `data:` on a ConfigMap. They are
 * the same four characters; one is a credential by definition and the other is the content an
 * operator opened the page to read. Only the document's `kind:` separates them.
 */

const SECRET_DOC = [
  '# Source: bookshop/templates/secret.yaml',
  'apiVersion: v1',
  'kind: Secret',
  'metadata:',
  '  name: db-creds',
  '  namespace: shop',
  'type: Opaque',
  'data:',
  '  password: aHVudGVyMg==',
  '  username: YWRtaW4='
].join('\n');

const CONFIGMAP_DOC = [
  '# Source: bookshop/templates/configmap.yaml',
  'apiVersion: v1',
  'kind: ConfigMap',
  'metadata:',
  '  name: app-config',
  '  namespace: shop',
  'data:',
  '  LOG_LEVEL: debug',
  '  REGION: eu10'
].join('\n');

function manifestRelease(manifest, extra = {}) {
  const payload = release({ manifest });
  payload.chart = { ...payload.chart, ...extra };
  return payload;
}

/** A listFn that serves the namespaced Helm Secret list this view reads through. */
const manifestListing = items => async ({ path }) => (path.includes('/secrets') ? items : []);

test('a rendered Secret keeps its keys and loses every value', async () => {
  const result = await helm.manifest({
    cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop',
    listFn: manifestListing([secret(manifestRelease(`---\n${SECRET_DOC}\n`))])
  });

  const doc = result.documents.find(d => d.kind === 'Secret');
  assert.ok(doc, 'the Secret document must still be listed — hiding it hides what the release owns');
  assert.match(doc.content, /password: \[redacted\]/);
  assert.match(doc.content, /username: \[redacted\]/);
  assert.ok(!doc.content.includes('aHVudGVyMg=='), 'the base64 value must not cross the wire');
  assert.ok(!doc.content.includes('YWRtaW4='), 'every leaf under data: goes, not just the one named password');
  assert.equal(doc.redactedByKind, true);
});

test('a ConfigMap keeps its data values — the kind rule must not generalise', async () => {
  const result = await helm.manifest({
    cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop',
    listFn: manifestListing([secret(manifestRelease(`---\n${CONFIGMAP_DOC}\n`))])
  });

  const doc = result.documents.find(d => d.kind === 'ConfigMap');
  // Masking this is the failure that would make the whole view pointless: a ConfigMap's data
  // IS the thing an operator came to read, and it is not a credential.
  assert.match(doc.content, /LOG_LEVEL: debug/);
  assert.match(doc.content, /REGION: eu10/);
  assert.equal(doc.redactedByKind, false);
});

test('stringData on a Secret is masked as thoroughly as data', async () => {
  const doc = helm.redactDocument(
    ['kind: Secret', 'stringData:', '  clientsecret: literal-value', '  plain: also-secret'].join('\n').split('\n'),
    true
  ).join('\n');
  assert.ok(!doc.includes('literal-value'));
  assert.ok(!doc.includes('also-secret'), 'stringData holds cleartext, so an unremarkable key name protects nothing');
  assert.match(doc, /stringData:/);
});

test('a document whose kind cannot be read is treated as a Secret', () => {
  // Malformed input might be a Secret. Over-masking one odd document is recoverable;
  // leaking one is not. Flipping this default is exactly the regression to catch.
  const doc = helm.redactDocument(['metadata:', '  name: mystery', 'data:', '  token: abc123'].join('\n').split('\n'), true);
  assert.match(doc.join('\n'), /token: \[redacted\]/);
});

test('a credential-shaped key is masked in any document, whatever its kind', () => {
  const doc = helm.redactDocument(
    ['kind: Deployment', 'spec:', '  env:', '    - name: API_KEY', '      value: sk-live-1234567890'].join('\n').split('\n'),
    false
  ).join('\n');
  // The key rule, not the kind rule: a Deployment is not secretLike, but an inline credential
  // in a pod spec is still a credential.
  assert.ok(!doc.includes('sk-live-1234567890'));
});

test('a masked block scalar swallows its body instead of echoing a placeholder per line', () => {
  const doc = helm.redactDocument(
    ['kind: Secret', 'tls.key: |', '  -----BEGIN RSA PRIVATE KEY-----', '  MIIEowIBAAKCAQEA', '  -----END RSA PRIVATE KEY-----', 'other: kept'].join('\n').split('\n'),
    true
  ).join('\n');
  assert.ok(!doc.includes('MIIEowIBAAKCAQEA'), 'the PEM body must not survive');
  assert.ok(!doc.includes('BEGIN RSA PRIVATE KEY'));
  assert.match(doc, /tls\.key: \[redacted\]/);
  assert.match(doc, /other: kept/, 'the block must end at the dedent, not eat the rest of the document');
});

test('documents are split and attributed to the template that rendered them', async () => {
  const result = await helm.manifest({
    cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop',
    listFn: manifestListing([secret(manifestRelease(`---\n${SECRET_DOC}\n---\n${CONFIGMAP_DOC}\n`))])
  });

  assert.equal(result.documents.length, 2);
  // `# Source:` is the only link from a rendered object back to its template, and it is what
  // turns a 60 kB scroll into a file browser.
  assert.deepEqual(result.documents.map(d => d.source), [
    'bookshop/templates/secret.yaml',
    'bookshop/templates/configmap.yaml'
  ]);
  assert.deepEqual(result.documents.map(d => d.name), ['db-creds', 'app-config']);
});

test('chart source files are decoded and credential-scrubbed', async () => {
  const files = [{ name: 'values/sandbox.yaml', data: Buffer.from('replicas: 2\nclientsecret: real-secret\n').toString('base64') }];
  const templates = [{ name: 'templates/cm.yaml', data: Buffer.from('kind: ConfigMap\ndata:\n  LEVEL: info\n').toString('base64') }];
  const result = await helm.manifest({
    cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop',
    listFn: manifestListing([secret(manifestRelease('', { files, templates }))])
  });

  const values = result.chartFiles.find(f => f.name === 'values/sandbox.yaml');
  assert.match(values.content, /replicas: 2/);
  assert.ok(!values.content.includes('real-secret'), 'chart inputs carry client secrets too');
  assert.equal(values.type, 'file');

  // The kind rule deliberately does NOT apply to chart source: an unrendered template has no
  // settled kind, and blanking every `data:` would hide the most readable templates there are.
  const tpl = result.chartFiles.find(f => f.name === 'templates/cm.yaml');
  assert.match(tpl.content, /LEVEL: info/);
  assert.equal(tpl.type, 'template');
});

test('an oversized manifest is cut and reported truncated, never silently short', async () => {
  const filler = `---\n# Source: bookshop/templates/big.yaml\nkind: ConfigMap\nmetadata:\n  name: big\ndata:\n  blob: ${'x'.repeat(helm.MAX_MANIFEST_BYTES)}\n`;
  const result = await helm.manifest({
    cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop',
    listFn: manifestListing([secret(manifestRelease(filler))])
  });
  assert.ok(result.summary.truncated.includes('rendered manifest'));
  assert.ok(result.counts.manifestBytes > helm.MAX_MANIFEST_BYTES, 'the true size is still reported');
});

test('a missing release throws NOT_FOUND rather than returning an empty manifest', async () => {
  await assert.rejects(
    () => helm.manifest({
      cluster, token: 't', namespace: 'shop', name: 'ghost',
      listFn: manifestListing([])
    }),
    err => err.code === 'NOT_FOUND'
  );
});

test('a refused Secret list reports unavailable instead of claiming the release is gone', async () => {
  const refused = async () => {
    const err = new Error('secrets is forbidden');
    err.status = 403;
    throw err;
  };
  const result = await helm.manifest({
    cluster, token: 't', namespace: 'shop', name: 'bookshop', listFn: refused
  });
  // A failed read is never a zero, and it is never a 404 either: stating the release is
  // deleted because we were not allowed to look is the worst answer available.
  assert.ok(result.summary.unavailable.length > 0);
  assert.deepEqual(result.documents, []);
});

test('the deployed revision is served by default, and an explicit revision overrides it', async () => {
  const secrets = [
    secret(manifestRelease(`---\n${CONFIGMAP_DOC}\n`)),
    secret({ ...manifestRelease('---\nkind: ConfigMap\nmetadata:\n  name: newer\n'), version: 2, info: { status: 'pending-upgrade' } })
  ];
  const listFn = manifestListing(secrets);

  const deployed = await helm.manifest({ cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop', listFn });
  assert.equal(deployed.revision, 1, 'a pending upgrade is not what the cluster is running');

  const pinned = await helm.manifest({ cluster, token: 't', namespace: 'btp-platform-foundation', name: 'bookshop', revision: 2, listFn });
  assert.equal(pinned.revision, 2);
});

test('an env pair keeps its non-credential neighbours readable', () => {
  // The name/value rule must not become "mask every value:". An image tag and a log level are
  // exactly what an operator opens this view to read.
  const doc = helm.redactDocument([
    'kind: Deployment',
    'spec:',
    '  env:',
    '    - name: LOG_LEVEL',
    '      value: debug',
    '    - name: DB_PASSWORD',
    '      value: hunter2',
    '    - name: REGION',
    '      value: eu10'
  ], false).join('\n');
  assert.match(doc, /value: debug/);
  assert.match(doc, /value: eu10/);
  assert.ok(!doc.includes('hunter2'), 'the NAME decides whether the VALUE is masked');
  assert.match(doc, /name: DB_PASSWORD/, 'the name stays visible — a missing credential is a finding');
});

test('a long scalar does not pin the event loop', () => {
  // Bounded quantifiers in scrubValue. Measured 2026-09-16: before bounding, 16 kB took
  // 209 ms and 512 kB took minutes, which one `--from-file` ConfigMap would have triggered
  // on a single-replica pod. This canary goes red the moment a quantifier loses its bound.
  const started = Date.now();
  helm.redactDocument([`  blob: ${'x'.repeat(512 * 1024)}`], false);
  helm.maskValues({ blob: 'y'.repeat(512 * 1024) });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `scanning 512 kB took ${elapsed} ms — a quantifier lost its bound`);
});

test('a manifest publishes its Secret POINTERS while redacting the Secret itself', () => {
  // The carve-out that makes the view usable. Verified against the live cluster: the first
  // cut masked all three of these, which hides which Secret to go and look in — the exact
  // failure REFERENCE_KEYS exists to prevent in the values viewer.
  const doc = helm.redactDocument([
    'kind: Deployment',
    'spec:',
    '  imagePullSecrets:',
    '    - name: registry-creds',
    '  automountServiceAccountToken: true',
    '  volumes:',
    '    - secret:',
    '        secretName: tls-cert',
    '  env:',
    '    - name: DB_PASSWORD',
    '      valueFrom:',
    '        secretKeyRef:',
    '          name: db-creds',
    '          key: password'
  ], false).join('\n');

  assert.match(doc, /name: registry-creds/, 'an imagePullSecret names a Secret; it is not one');
  assert.match(doc, /secretName: tls-cert/, 'a volume secret source is a pointer');
  assert.match(doc, /name: db-creds/, 'without this an operator cannot tell which Secret to open');
  // `key` stays masked, matching what maskValues already does to `secretKeyRef.key` — the
  // load-bearing half of the pointer is WHICH Secret, and the two surfaces must not disagree.
  assert.match(doc, /key: \[redacted\]/);
  assert.match(doc, /automountServiceAccountToken: true/, 'a credential is never a boolean');
});

test('the pointer carve-out does not reopen the Secret data hole', () => {
  // The carve-out is about REFERENCES. Actual Secret material is still gone.
  const doc = helm.redactDocument([
    'kind: Secret',
    'metadata:',
    '  name: db-creds',
    'data:',
    '  password: aHVudGVyMg=='
  ], true).join('\n');
  assert.match(doc, /name: db-creds/, 'the Secret’s own name is not a credential');
  assert.ok(!doc.includes('aHVudGVyMg=='), 'its data still is');
});
