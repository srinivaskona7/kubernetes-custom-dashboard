import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import _tokens from '../tokens.js';
const { TokenStore, WARN_WINDOW_MS, RENEW_WINDOW_MS } = _tokens;

function mountWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tokens-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const T0 = Date.parse('2026-08-31T12:00:00Z');
const at = ms => () => T0 + ms;
const inHours = h => new Date(T0 + h * 3600_000).toISOString();

test('a cluster with no file at all is unseeded, not an error', () => {
  const store = new TokenStore({ mountPath: mountWith({}), now: at(0) });
  assert.strictEqual(store.read('platformsbx'), null);
  assert.strictEqual(store.tokenFor('platformsbx'), null);
  const h = store.health('platformsbx');
  assert.strictEqual(h.status, 'unseeded');
  assert.strictEqual(h.dueForRenewal, true);
});

test('a token with 18h left is valid and not yet due', () => {
  const mount = mountWith({
    platformsbx: { token: 'eyJ-abc', expiresAt: inHours(18), renewedAt: inHours(-6), lastError: null }
  });
  const h = new TokenStore({ mountPath: mount, now: at(0) }).health('platformsbx');
  assert.strictEqual(h.status, 'valid');
  assert.strictEqual(h.dueForRenewal, false);
  assert.strictEqual(h.expiresInMs, 18 * 3600_000);
});

test('a token inside the 12h renewal window is still valid but due', () => {
  const mount = mountWith({
    platformsbx: { token: 'eyJ-abc', expiresAt: inHours(11), renewedAt: inHours(-13), lastError: null }
  });
  const h = new TokenStore({ mountPath: mount, now: at(0) }).health('platformsbx');
  assert.strictEqual(h.status, 'valid', 'still perfectly usable');
  assert.strictEqual(h.dueForRenewal, true, 'but the job should renew it');
});

test('under 6h remaining the status escalates to expiring', () => {
  const mount = mountWith({
    platformsbx: { token: 'eyJ-abc', expiresAt: inHours(5), renewedAt: inHours(-19), lastError: null }
  });
  const h = new TokenStore({ mountPath: mount, now: at(0) }).health('platformsbx');
  assert.strictEqual(h.status, 'expiring');
  assert.ok(h.expiresInMs < WARN_WINDOW_MS);
});

test('a lapsed token is expired, which is what breaks the chain', () => {
  const mount = mountWith({
    platformsbx: { token: 'eyJ-abc', expiresAt: inHours(-2), renewedAt: inHours(-26), lastError: null }
  });
  const h = new TokenStore({ mountPath: mount, now: at(0) }).health('platformsbx');
  assert.strictEqual(h.status, 'expired');
  assert.ok(h.expiresInMs < 0);
});

test('the token value never appears in the health payload', () => {
  const mount = mountWith({
    platformsbx: { token: 'eyJ-super-secret', expiresAt: inHours(18), renewedAt: inHours(-6), lastError: null }
  });
  const h = new TokenStore({ mountPath: mount, now: at(0) }).health('platformsbx');
  assert.ok(!JSON.stringify(h).includes('eyJ-super-secret'),
    'health() must never leak the bearer token');
});

test('a corrupt token file degrades that one cluster, it does not throw', () => {
  const mount = mountWith({
    platformsbx: '{ this is not json',
    appkymadv: { token: 'eyJ-ok', expiresAt: inHours(18), renewedAt: inHours(-6), lastError: null }
  });
  const store = new TokenStore({ mountPath: mount, now: at(0) });
  const bad = store.health('platformsbx');
  assert.match(bad.lastError, /unreadable token file/);
  assert.strictEqual(store.health('appkymadv').status, 'valid', 'the healthy cluster is unaffected');
});

test('a cluster id that escapes the mount directory is rejected', () => {
  const store = new TokenStore({ mountPath: mountWith({}), now: at(0) });
  for (const evil of ['../../etc/passwd', 'a/b', '.', '', 'UPPER']) {
    assert.throws(() => store.read(evil), /invalid cluster id/, `should reject ${JSON.stringify(evil)}`);
  }
});

test('re-reading an unchanged file reuses the cached parse', () => {
  const mount = mountWith({
    platformsbx: { token: 'eyJ-abc', expiresAt: inHours(18), renewedAt: inHours(-6), lastError: null }
  });
  const store = new TokenStore({ mountPath: mount, now: at(0) });
  assert.strictEqual(store.read('platformsbx'), store.read('platformsbx'),
    'same object identity means the file was not re-parsed');
});

test('a changed file is picked up, which is how kubelet refresh reaches the app', () => {
  const mount = mountWith({
    platformsbx: { token: 'eyJ-old', expiresAt: inHours(2), renewedAt: inHours(-22), lastError: null }
  });
  const store = new TokenStore({ mountPath: mount, now: at(0) });
  assert.strictEqual(store.tokenFor('platformsbx'), 'eyJ-old');

  const file = path.join(mount, 'platformsbx');
  fs.writeFileSync(file, JSON.stringify({
    token: 'eyJ-new', expiresAt: inHours(24), renewedAt: inHours(0), lastError: null
  }));
  // Force a distinct mtime; some filesystems have coarse timestamp resolution.
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);

  assert.strictEqual(store.tokenFor('platformsbx'), 'eyJ-new');
  assert.strictEqual(store.health('platformsbx').status, 'valid');
});

test('RENEW_WINDOW_MS is exactly half the 24h token lifetime', () => {
  // The whole survivability argument rests on this: renewing at half-life means one
  // entire cycle can fail before anything breaks.
  assert.strictEqual(RENEW_WINDOW_MS, 12 * 3600_000);
  assert.strictEqual(RENEW_WINDOW_MS * 2, 24 * 3600_000);
});
