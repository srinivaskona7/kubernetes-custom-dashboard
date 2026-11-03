
/**
 * The admin onboarding tool drives four privileged steps against two different clusters.
 * Getting the argv wrong is the whole risk — a patch aimed at the wrong context writes a
 * live token into the wrong cluster's Secret, and a record with a misspelled field is
 * silently ignored by the registry.
 *
 * So these assert the exact commands and the exact record shapes, with no cluster
 * anywhere near the test.
 */

import { test } from 'vitest';
import assert from 'node:assert';

import _onboard_cluster from '../tools/onboard-cluster.js';
const { onboard, clusterRecord, tokenRecord, patchArgs } = _onboard_cluster;
import _onboard2 from '../onboard.js';
import _registryModule from '../registry.js';
import _print_rbacModule from '../tools/print-rbac.js';
const { FLEET_NAMESPACE, FLEET_SA } = _onboard2;

/** A well-formed JWT whose exp is a fixed, known instant. */
const EXP_SECONDS = 1788300000; // 2026-09-01T20:40:00Z
function fakeToken(exp = EXP_SECONDS) {
  const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return [
    b64({ alg: 'RS256' }),
    b64({
      sub: `system:serviceaccount:${FLEET_NAMESPACE}:${FLEET_SA}`,
      exp,
      iss: 'https://kubernetes.default.svc',
      'kubernetes.io': { namespace: FLEET_NAMESPACE, serviceaccount: { name: FLEET_SA } },
    }),
    'signature',
  ].join('.');
}

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

/** Answers kubectl by inspecting the argv, the way the real thing would. */
function fakeKubectl(overrides = {}) {
  const calls = [];
  const run = argv => {
    calls.push(argv);
    const joined = argv.join(' ');
    if (joined.includes('jsonpath={.clusters[0].cluster.server}')) return 'https://api.example.kyma.ondemand.com/';
    if (joined.includes('certificate-authority-data')) return Buffer.from(CA, 'utf8').toString('base64');
    if (argv.includes('create') && argv.includes('token')) return overrides.token ?? fakeToken();
    if (argv.includes('can-i')) return overrides.canMint ?? 'yes';
    return '';
  };
  run.calls = calls;
  return run;
}

const BASE = {
  target: 'platformsbx',
  id: 'platformsbx',
  hub: 'appkymadv',
  hubNamespace: 'btp-platform-foundation',
  name: 'Platform Sandbox',
  env: 'sbx',
  logFn: () => {},
  nowFn: () => '2026-09-01T10:00:00.000Z',
};

test('applies the read-only bundle to the target cluster first', () => {
  const runFn = fakeKubectl();
  onboard({ ...BASE, runFn });

  const apply = runFn.calls.find(a => a.includes('apply'));
  assert.ok(apply, 'no kubectl apply was issued');
  assert.deepStrictEqual(apply.slice(0, 3), ['--context', 'platformsbx', 'apply']);
  assert.match(apply[apply.length - 1], /fleet-dashboard-rbac\.yaml$/);
});

test('onboarding applies the fleet-dashboard-rbac.yaml bundle', () => {
  const runFn = fakeKubectl();
  onboard({ ...BASE, runFn });

  const applies = runFn.calls.filter(a => a.includes('apply'));
  assert.strictEqual(applies.length, 1);
  assert.match(applies[0][applies[0].length - 1], /fleet-dashboard-rbac\.yaml$/);
});

test('every target-side call names the target context and every hub-side call the hub', () => {
  const runFn = fakeKubectl();
  onboard({ ...BASE, runFn });

  for (const argv of runFn.calls) {
    const i = argv.indexOf('--context');
    assert.notStrictEqual(i, -1, `call without a --context: ${argv.join(' ')}`);
    const ctx = argv[i + 1];
    const isHubCall = argv.includes('patch');
    assert.strictEqual(ctx, isHubCall ? 'appkymadv' : 'platformsbx', `wrong context on: ${argv.join(' ')}`);
  }
});

test('the expiry comes off the token, not off --duration', () => {
  // The API server may clamp a requested lifetime. Trusting --duration would leave the
  // renewer asleep past the real expiry.
  const runFn = fakeKubectl({ token: fakeToken(EXP_SECONDS) });
  const { expiresAt } = onboard({ ...BASE, duration: '999h', runFn });
  assert.strictEqual(expiresAt, new Date(EXP_SECONDS * 1000).toISOString());
});

test('refuses to write anything if the account cannot mint its successor', () => {
  const runFn = fakeKubectl({ canMint: 'no' });
  assert.throws(() => onboard({ ...BASE, runFn }), /cannot mint its own successor/);
  assert.strictEqual(
    runFn.calls.filter(a => a.includes('patch')).length,
    0,
    'a token was written for a cluster whose chain cannot turn',
  );
});

test('refuses an id that could escape the token mount directory', () => {
  const runFn = fakeKubectl();
  assert.throws(() => onboard({ ...BASE, id: '../etc', runFn }), /--id must match/);
  assert.strictEqual(runFn.calls.length, 0, 'it touched the cluster before validating the id');
});

test('the cluster record uses exactly the field names registry.js validates', () => {
  const rec = clusterRecord({
    id: 'platformsbx', name: 'Platform Sandbox', env: 'sbx',
    apiUrl: 'https://api.example.kyma.ondemand.com', caData: CA,
    by: 'someone', at: '2026-09-01T10:00:00.000Z',
  });
  assert.deepStrictEqual(Object.keys(rec).sort(), [
    'apiUrl', 'caData', 'displayName', 'enabled', 'env', 'id',
    'namespace', 'onboardedAt', 'onboardedBy', 'serviceAccount', 'source',
  ]);
  assert.strictEqual(rec.namespace, FLEET_NAMESPACE);
  assert.strictEqual(rec.serviceAccount, FLEET_SA);
  assert.strictEqual(rec.source, 'onboarded');
  assert.strictEqual(rec.enabled, true);
});

test('the registry accepts the record this tool writes', () => {
  // The contract that actually matters: a record this tool produces must survive the
  // reader's own validation, or the cluster lands in the Secret and never appears.
  const { Registry } = _registryModule;
  const rec = clusterRecord({
    id: 'platformsbx', name: 'Platform Sandbox', env: 'sbx',
    apiUrl: 'https://api.example.kyma.ondemand.com/', caData: CA,
    by: 'someone', at: '2026-09-01T10:00:00.000Z',
  });
  const registry = new Registry({ clusters: [rec] });
  const loaded = registry.all().find(c => c.id === 'platformsbx');
  assert.ok(loaded, 'the registry dropped a record this tool writes');
  assert.strictEqual(loaded.apiUrl, 'https://api.example.kyma.ondemand.com', 'trailing slash not stripped');
  assert.strictEqual(loaded.displayName, 'Platform Sandbox');
});

test('the token record matches what the token store expects, with renewedAt unset', () => {
  const rec = tokenRecord({ token: 'a.b.c', expiresAt: '2026-09-02T10:00:00.000Z' });
  assert.deepStrictEqual(rec, {
    token: 'a.b.c',
    expiresAt: '2026-09-02T10:00:00.000Z',
    renewedAt: null,   // this is a first issue, not a renewal; the renewer sets it
    lastError: null,
  });
});

test('the Secret patch is a merge touching one key, so other clusters survive', () => {
  const argv = patchArgs({
    hub: 'appkymadv', namespace: 'btp-platform-foundation',
    secret: 'fleet-dashboard-tokens', key: 'platformsbx', value: { token: 'a.b.c' },
  });
  assert.deepStrictEqual(argv.slice(0, 8), [
    '--context', 'appkymadv', '-n', 'btp-platform-foundation',
    'patch', 'secret', 'fleet-dashboard-tokens', '--type',
  ]);
  assert.strictEqual(argv[8], 'merge');

  const payload = JSON.parse(argv[argv.length - 1]);
  assert.deepStrictEqual(Object.keys(payload.data), ['platformsbx']);
  assert.deepStrictEqual(
    JSON.parse(Buffer.from(payload.data.platformsbx, 'base64').toString('utf8')),
    { token: 'a.b.c' },
  );
});

test('both Secrets are patched, clusters before tokens', () => {
  const runFn = fakeKubectl();
  onboard({ ...BASE, runFn });

  const patched = runFn.calls.filter(a => a.includes('patch')).map(a => a[a.indexOf('secret') + 1]);
  assert.deepStrictEqual(patched, ['fleet-dashboard-clusters', 'fleet-dashboard-tokens']);
});

test('--dry-run changes nothing on either cluster', () => {
  const runFn = fakeKubectl();
  const lines = [];
  onboard({ ...BASE, dryRun: true, runFn, logFn: m => lines.push(m) });

  assert.strictEqual(runFn.calls.filter(a => a.includes('patch')).length, 0);
  assert.strictEqual(runFn.calls.filter(a => a.includes('apply')).length, 0);
  assert.ok(lines.some(l => l.includes('DRY-RUN')), 'dry run printed no commands');
});

test('a missing --hub is refused before anything is applied', () => {
  const runFn = fakeKubectl();
  assert.throws(() => onboard({ ...BASE, hub: undefined, runFn }), /--hub is required/);
  assert.strictEqual(runFn.calls.length, 0);
});

// ---------------------------------------------------------------- custom naming

test('default names are unchanged, so the committed bundle stays the reviewed artifact', () => {
  const runFn = fakeKubectl();
  onboard({ ...BASE, runFn });

  const apply = runFn.calls.find(a => a.includes('apply'));
  assert.match(apply[apply.length - 1], /fleet-dashboard-rbac\.yaml$/,
    'with no naming flags it must apply the committed file, not a generated one');
});

test('--prefix renames the RBAC objects and applies a generated bundle over stdin', () => {
  const applied = [];
  const runFn = fakeKubectl();
  const wrapped = (argv, input) => { applied.push({ argv, input }); return runFn(argv, input); };

  onboard({ ...BASE, prefix: 'acme-fleet', runFn: wrapped });

  const apply = applied.find(c => c.argv.includes('apply'));
  assert.deepStrictEqual(apply.argv.slice(-2), ['-f', '-'], 'a renamed bundle must come over stdin');
  assert.ok(apply.input.includes('name: acme-fleet-reader'), 'ClusterRole not renamed');
  assert.ok(apply.input.includes('name: acme-fleet-token-issuer'), 'self-mint Role not renamed');
  assert.ok(!apply.input.includes('fleet-dashboard-reader'), 'a default name survived the rename');
});

test('--namespace and --sa reach the mint, the self-mint check and the stored record', () => {
  const runFn = fakeKubectl();
  const { cluster } = onboard({ ...BASE, namespace: 'acme-ops', serviceAccount: 'acme-reader', runFn });

  const mint = runFn.calls.find(a => a.includes('create') && a.includes('token'));
  assert.ok(mint.includes('acme-reader'), 'the token was minted for the wrong account');
  assert.strictEqual(mint[mint.indexOf('-n') + 1], 'acme-ops', 'minted in the wrong namespace');

  const canI = runFn.calls.find(a => a.includes('can-i'));
  assert.ok(canI.includes('serviceaccounts/acme-reader'), 'self-mint checked the wrong account');
  assert.ok(canI.includes('acme-ops'), 'self-mint checked the wrong namespace');

  // This is the one that matters at runtime: the collectors read these back off the record.
  assert.strictEqual(cluster.namespace, 'acme-ops');
  assert.strictEqual(cluster.serviceAccount, 'acme-reader');
});

test('a renamed bundle grants the same rules as the reviewed one', () => {
  // Renaming must not become a way to quietly change permissions.
  const { documents } = _print_rbacModule;
  const rulesOf = docs => docs.filter(d => d.rules).map(d => JSON.stringify(d.rules));
  assert.deepStrictEqual(
    rulesOf(documents({ names: { prefix: 'acme-fleet', namespace: 'acme-ops', serviceAccount: 'acme-reader' } })),
    rulesOf(documents()).map(r => r.replace(/"fleet-reader"/g, '"acme-reader"')),
  );
});
