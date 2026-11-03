/**
 * The registry, with onboarded clusters merged in.
 *
 * The baked file is the blast radius: it is what the image ships with, and it is the only
 * source that can define the hub's own cluster. The projected directory is what the
 * upload endpoint writes. The rules that matter, and that these tests hold to:
 *
 *   - a baked entry always wins over an uploaded one with the same id, because the baked
 *     one is the definition known to work;
 *   - one malformed uploaded file must never blank the cluster list — a bad upload that
 *     hides the clusters that *are* working is the worst possible failure here;
 *   - a filename that is not a valid cluster id is ignored, which is also what keeps the
 *     projected volume's own `..data` bookkeeping out of the list.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import _registry from '../registry.js';
import _redis_storeModule from '../redis-store.js';
const { Registry, validate } = _registry;

const __dirname = import.meta.dirname;

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reg-'));
  const file = path.join(dir, 'clusters.json');
  const mount = path.join(dir, 'onboarded');
  fs.mkdirSync(mount);
  fs.writeFileSync(file, JSON.stringify({
    clusters: [{ id: 'platformsbx', displayName: 'Platform SBX', env: 'sbx', apiUrl: 'https://kubernetes.default.svc' }]
  }));
  return { dir, file, mount };
}

function write(mount, id, body) {
  fs.writeFileSync(path.join(mount, id), typeof body === 'string' ? body : JSON.stringify(body));
}

const ONBOARDED = {
  id: 'platform-dev',
  displayName: 'Platform Dev',
  env: 'dev',
  apiUrl: 'https://api.dev.example.com',
  caData: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
  onboardedAt: '2026-08-31T09:00:00Z',
  onboardedBy: 'jo@example.com'
};

test('the baked file alone is a complete registry', () => {
  const { file, mount } = scratch();
  const reg = new Registry({ file, dir: mount });
  assert.equal(reg.all().length, 1);
  assert.equal(reg.get('platformsbx').source, 'baked');
  assert.equal(reg.isBaked('platformsbx'), true);
});

test('an absent onboarded mount is normal, not an error', () => {
  const { file, dir } = scratch();
  const reg = new Registry({ file, dir: path.join(dir, 'does-not-exist') });
  assert.equal(reg.all().length, 1);
});

test('an onboarded file is merged in and marked as such', () => {
  const { file, mount } = scratch();
  write(mount, 'platform-dev', ONBOARDED);
  const reg = new Registry({ file, dir: mount });
  const dev = reg.get('platform-dev');
  assert.equal(dev.source, 'onboarded');
  assert.equal(dev.caData, ONBOARDED.caData);
  assert.equal(dev.onboardedBy, 'jo@example.com');
  assert.equal(reg.isBaked('platform-dev'), false);
});

test('a baked cluster cannot be shadowed by an upload of the same id', () => {
  const { file, mount } = scratch();
  write(mount, 'platformsbx', { ...ONBOARDED, id: 'platformsbx', apiUrl: 'https://evil.example.com' });
  const reg = new Registry({ file, dir: mount });
  assert.equal(reg.all().length, 1);
  assert.equal(reg.get('platformsbx').apiUrl, 'https://kubernetes.default.svc');
  assert.equal(reg.get('platformsbx').source, 'baked');
});

test('one malformed upload is skipped and the rest of the fleet survives', () => {
  const { file, mount } = scratch();
  write(mount, 'good-one', { ...ONBOARDED, id: 'good-one' });
  write(mount, 'broken', '{ not json');
  const reg = new Registry({ file, dir: mount });
  assert.deepEqual(reg.all().map(c => c.id).sort(), ['good-one', 'platformsbx']);
});

test('an upload with a non-https apiUrl is skipped rather than trusted', () => {
  const { file, mount } = scratch();
  write(mount, 'plaintext', { ...ONBOARDED, id: 'plaintext', apiUrl: 'http://api.example.com' });
  const reg = new Registry({ file, dir: mount });
  assert.equal(reg.get('plaintext'), null);
});

test('projected-volume bookkeeping entries are ignored', () => {
  const { file, mount } = scratch();
  write(mount, 'platform-dev', ONBOARDED);
  fs.mkdirSync(path.join(mount, '..2026_08_31_10_00_00'), { recursive: true });
  fs.writeFileSync(path.join(mount, '.hidden'), '{}');
  const reg = new Registry({ file, dir: mount });
  assert.deepEqual(reg.all().map(c => c.id).sort(), ['platform-dev', 'platformsbx']);
});

test('a filename that is not a valid cluster id is ignored', () => {
  const { file, mount } = scratch();
  write(mount, 'Not_An_Id', ONBOARDED);
  const reg = new Registry({ file, dir: mount });
  assert.equal(reg.all().length, 1);
});

test('a re-scan is throttled, so a burst of requests does not stat the mount each time', () => {
  const { file, mount } = scratch();
  let clock = 1_000_000;
  const reg = new Registry({ file, dir: mount, now: () => clock });
  assert.equal(reg.all().length, 1);

  write(mount, 'platform-dev', ONBOARDED);
  assert.equal(reg.all().length, 1, 'within the throttle window the new file is not yet visible');

  clock += 6000;
  assert.equal(reg.all().length, 2, 'after the window it is picked up with no restart');
});

test('invalidate makes the very next read see a just-written cluster', () => {
  const { file, mount } = scratch();
  let clock = 1_000_000;
  const reg = new Registry({ file, dir: mount, now: () => clock });
  reg.all();
  write(mount, 'platform-dev', ONBOARDED);
  reg.invalidate();
  assert.equal(reg.all().length, 2);
});

test('a removed file disappears from the registry on the next scan', () => {
  const { file, mount } = scratch();
  write(mount, 'platform-dev', ONBOARDED);
  let clock = 1_000_000;
  const reg = new Registry({ file, dir: mount, now: () => clock });
  assert.equal(reg.all().length, 2);

  fs.unlinkSync(path.join(mount, 'platform-dev'));
  reg.invalidate();
  assert.equal(reg.all().length, 1);
});

test('a disabled cluster is listed but not called', () => {
  const { file, mount } = scratch();
  write(mount, 'platform-dev', { ...ONBOARDED, enabled: false });
  const reg = new Registry({ file, dir: mount });
  assert.equal(reg.all().length, 2);
  assert.deepEqual(reg.active().map(c => c.id), ['platformsbx']);
});

test('explicit clusters bypass both sources entirely, which is what the other suites rely on', () => {
  const reg = new Registry({ clusters: [{ id: 'fixture', apiUrl: 'https://example.com' }] });
  assert.deepEqual(reg.all().map(c => c.id), ['fixture']);
});

test('validate rejects an id that could escape the token mount', () => {
  assert.throws(() => validate({ id: '../etc', apiUrl: 'https://x.example.com' }, 0), /id must match/);
  assert.throws(() => validate({ id: 'UPPER', apiUrl: 'https://x.example.com' }, 0), /id must match/);
});

test('validate fills the defaults the collectors assume', () => {
  const c = validate({ id: 'x', apiUrl: 'https://x.example.com/' }, 0);
  assert.equal(c.namespace, 'kyma-fleet');
  assert.equal(c.serviceAccount, 'fleet-reader');
  assert.equal(c.enabled, true);
  assert.equal(c.apiUrl, 'https://x.example.com', 'a trailing slash would double up in every path');
});

test('a duplicate id in the baked file is fatal at startup rather than ambiguous at runtime', () => {
  const { dir, mount } = scratch();
  const file = path.join(dir, 'dupes.json');
  fs.writeFileSync(file, JSON.stringify({
    clusters: [
      { id: 'a', apiUrl: 'https://one.example.com' },
      { id: 'a', apiUrl: 'https://two.example.com' }
    ]
  }));
  assert.throws(() => new Registry({ file, dir: mount }), /duplicate cluster id/);
});

test('a missing baked file fails loudly, naming the path', () => {
  const { dir, mount } = scratch();
  assert.throws(
    () => new Registry({ file: path.join(dir, 'nope.json'), dir: mount }),
    /cannot read cluster registry/
  );
});

test('the shipped registry starts empty for universal dynamic onboarding', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../clusters.json'), 'utf8'));
  assert.deepEqual(shipped.clusters, []);
});

test('onboardedVia and renewable survive the round trip through the mount', () => {
  // The registry rebuilds every cluster field by field, so anything it does not name is
  // silently dropped. These two are what the UI uses to warn that a cluster will go dark;
  // losing them here makes a doomed cluster look healthy until the moment it stops working.
  const { file, mount } = scratch();
  write(mount, 'pasted', {
    ...ONBOARDED, id: 'pasted', onboardedVia: 'token', renewable: false
  });
  const c = new Registry({ file, dir: mount }).get('pasted');
  assert.equal(c.onboardedVia, 'token');
  assert.equal(c.renewable, false);
});

test('a baked cluster is renewable, and says which door it came through', () => {
  const registry = new Registry({ clusters: [{ id: 'hub', apiUrl: 'https://a' }] });
  assert.equal(registry.get('hub').renewable, true);
  assert.equal(registry.get('hub').onboardedVia, 'baked');
});

// ------------------------------------------------------- free-text field safety (displayName, env, ...)
//
// displayName and env are interpolated raw into the exported Markdown report; namespace and
// serviceAccount are interpolated into the copy-paste `kubectl create token` command shown in
// the console. A newline in any of them forges extra lines/commands; a Unicode bidi override
// reorders how the value reads. validate() must refuse all of these rather than strip them.

test('validate rejects a displayName carrying the exact newline payload that forges lines in the report', () => {
  const forged = 'Prod EU\n- **Prod US** (prod): HEALTHY\n- **Prod AP** (prod): HEALTHY\n<img src=x onerror="alert(1)">';
  assert.throws(
    () => validate({ id: 'x', displayName: forged, apiUrl: 'https://x.example.com' }, 0),
    /displayName contains a control character/
  );
});

test('validate rejects a displayName carrying a bare CR', () => {
  assert.throws(
    () => validate({ id: 'x', displayName: 'Prod\rEU', apiUrl: 'https://x.example.com' }, 0),
    /displayName contains a control character/
  );
});

test('validate rejects a displayName carrying a C0 control character', () => {
  assert.throws(
    () => validate({ id: 'x', displayName: 'Prod\x07EU', apiUrl: 'https://x.example.com' }, 0),
    /displayName contains a control character/
  );
});

test('validate rejects a displayName over the length cap', () => {
  assert.throws(
    () => validate({ id: 'x', displayName: 'a'.repeat(101), apiUrl: 'https://x.example.com' }, 0),
    /displayName must be at most 100 characters/
  );
});

test('validate rejects a displayName carrying a Unicode bidi override', () => {
  // \u escapes, not the literal characters — a literal RLO/LRI pasted into this file
  // would itself reorder how the surrounding source reads.
  const rlo = 'Prod' + String.fromCharCode(0x202e) + 'EU';
  const lri = 'Prod' + String.fromCharCode(0x2066) + 'EU';
  assert.throws(
    () => validate({ id: 'x', displayName: rlo, apiUrl: 'https://x.example.com' }, 0),
    /displayName contains a control character or Unicode bidi override/
  );
  assert.throws(
    () => validate({ id: 'x', displayName: lri, apiUrl: 'https://x.example.com' }, 0),
    /displayName contains a control character or Unicode bidi override/
  );
});

test('validate accepts legitimate names with spaces, dots, hyphens and non-ASCII letters', () => {
  const c1 = validate({ id: 'x', displayName: 'Kyma Prod — München', apiUrl: 'https://x.example.com' }, 0);
  assert.equal(c1.displayName, 'Kyma Prod — München');
  const c2 = validate({ id: 'y', displayName: 'Prod-EU v1.2 (Frankfurt)', apiUrl: 'https://y.example.com' }, 0);
  assert.equal(c2.displayName, 'Prod-EU v1.2 (Frankfurt)');
});

test('validate rejects a newline in env, which the report interpolates exactly like displayName', () => {
  assert.throws(
    () => validate({ id: 'x', env: 'prod\n- **fake**: HEALTHY', apiUrl: 'https://x.example.com' }, 0),
    /env contains a control character/
  );
});

test('validate rejects a control character in namespace or serviceAccount, which reach the copy-paste kubectl command', () => {
  assert.throws(
    () => validate({ id: 'x', namespace: 'kyma\nfleet', apiUrl: 'https://x.example.com' }, 0),
    /namespace contains a control character/
  );
  assert.throws(
    () => validate({ id: 'x', serviceAccount: 'fleet\rreader', apiUrl: 'https://x.example.com' }, 0),
    /serviceAccount contains a control character/
  );
});

test('an onboarded file with a forged displayName is skipped, and the rest of the fleet survives', () => {
  const { file, mount } = scratch();
  write(mount, 'good-one', { ...ONBOARDED, id: 'good-one' });
  write(mount, 'evil', {
    ...ONBOARDED,
    id: 'evil',
    displayName: 'Prod EU\n- **Prod US** (prod): HEALTHY'
  });
  const reg = new Registry({ file, dir: mount });
  assert.deepEqual(reg.all().map(c => c.id).sort(), ['good-one', 'platformsbx']);
});

test('a pre-existing in-memory-store record with a forged displayName is excluded, not fatal', async () => {
  const { fleetStore } = _redis_storeModule;
  const { file, mount } = scratch();
  await fleetStore.saveCluster('evil-store', {
    ...ONBOARDED,
    id: 'evil-store',
    displayName: 'Prod EU\n- **Prod US**: HEALTHY'
  });
  try {
    const reg = new Registry({ file, dir: mount });
    assert.deepEqual(reg.all().map(c => c.id).sort(), ['platformsbx']);
  } finally {
    await fleetStore.deleteCluster('evil-store');
  }
});
