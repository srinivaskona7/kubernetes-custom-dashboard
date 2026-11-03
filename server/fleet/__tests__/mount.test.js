/**
 * The wiring in mount.js: what happens when the fleet cannot be configured, that the
 * production guard refuses an unauthenticated API, and that a configured fleet answers
 * through the same envelope the router tests pin.
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import _mount from '../mount.js';
const { mountFleet, assertAuthAllowed, fleetAuthDisabled } = _mount;

const saved = {};
const KEYS = ['FLEET_CLUSTERS_FILE', 'FLEET_CLUSTERS_DIR', 'FLEET_ALLOW_MANUAL_RENEW', 'FLEET_ALLOW_ONBOARD', 'FLEET_RENEW_IN_PROCESS'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  // No writers and no renewal clock: nothing here may reach for a Secret or start a timer.
  process.env.FLEET_ALLOW_MANUAL_RENEW = 'false';
  process.env.FLEET_ALLOW_ONBOARD = 'false';
  process.env.FLEET_RENEW_IN_PROCESS = 'false';
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function serve(configure) {
  const app = express();
  configure(app);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(r => server.close(r)) };
}

function tempRegistry(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mount-'));
  const file = path.join(dir, 'clusters.json');
  fs.writeFileSync(file, contents);
  process.env.FLEET_CLUSTERS_FILE = file;
  process.env.FLEET_CLUSTERS_DIR = path.join(dir, 'onboarded');
  return dir;
}

test('an unusable cluster registry degrades /api/fleet to a typed 503 and nothing else', async () => {
  tempRegistry('{not json');
  const s = await serve(app => {
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    mountFleet(app);
  });
  try {
    const fleet = await fetch(`${s.base}/api/fleet/clusters`);
    assert.strictEqual(fleet.status, 503);
    const body = await fleet.json();
    assert.strictEqual(body.code, 'FLEET_UNCONFIGURED');
    assert.match(body.message, /cluster registry unusable/);

    const health = await fetch(`${s.base}/api/health`);
    assert.deepStrictEqual(await health.json(), { ok: true });
  } finally {
    await s.close();
  }
});

test('a usable registry mounts the router; unmatched paths answer JSON, not HTML', async () => {
  tempRegistry(JSON.stringify({ clusters: [] }));
  const s = await serve(app => mountFleet(app));
  try {
    const list = await fetch(`${s.base}/api/fleet/clusters`);
    assert.strictEqual(list.status, 200);
    const body = await list.json();
    assert.deepStrictEqual(body.clusters, []);
    assert.strictEqual(body.summary.clusters, 0);

    const missing = await fetch(`${s.base}/api/fleet/no-such-route`);
    assert.strictEqual(missing.status, 404);
    assert.match(missing.headers.get('content-type'), /json/);
    assert.strictEqual((await missing.json()).code, 'NOT_FOUND');
  } finally {
    await s.close();
  }
});

test('the fleet body limit leaves room for the router to refuse an oversized kubeconfig itself', async () => {
  tempRegistry(JSON.stringify({ clusters: [] }));
  const s = await serve(app => mountFleet(app));
  try {
    // Well over express.json's default 100kb, under twice the router's own kubeconfig limit.
    const res = await fetch(`${s.base}/api/fleet/clusters/kubeconfig/describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kubeconfig: 'x'.repeat(150 * 1024) })
    });
    assert.notStrictEqual(res.status, 413, 'a 413 here would be the generic body-parser limit, not the router\'s');
  } finally {
    await s.close();
  }
});

test('FLEET_AUTH=none is refused in production and nowhere else', () => {
  assert.throws(() => assertAuthAllowed({ NODE_ENV: 'production', FLEET_AUTH: 'none' }), /not permitted/);
  assert.doesNotThrow(() => assertAuthAllowed({ NODE_ENV: 'production' }));
  assert.doesNotThrow(() => assertAuthAllowed({ NODE_ENV: 'development', FLEET_AUTH: 'none' }));
});

test('fleet auth is disabled exactly when shieldAuth is bypassed, or when FLEET_AUTH=none says so', () => {
  assert.strictEqual(fleetAuthDisabled({}), true);
  assert.strictEqual(fleetAuthDisabled({ NODE_ENV: 'development' }), true);
  assert.strictEqual(fleetAuthDisabled({ NODE_ENV: 'production' }), false);
  assert.strictEqual(fleetAuthDisabled({ NODE_ENV: 'production', FLEET_AUTH: 'none' }), true);
});

test('in production, a shield identity outside FLEET_ADMIN_GROUPS reads but cannot onboard', async () => {
  tempRegistry(JSON.stringify({ clusters: [] }));
  const before = { NODE_ENV: process.env.NODE_ENV, FLEET_ADMIN_GROUPS: process.env.FLEET_ADMIN_GROUPS };
  process.env.NODE_ENV = 'production';
  process.env.FLEET_ADMIN_GROUPS = '7';
  // Stands in for shieldAuth, which is mounted app-wide ahead of the fleet in server/index.js.
  const shield = (req, _res, next) => {
    req.user = req.headers['x-test-groups'] === 'admin'
      ? { email: 'admin@example.com', groups: [7] }
      : { email: 'reader@example.com', groups: [1] };
    next();
  };
  const s = await serve(app => { app.use(shield); mountFleet(app); });
  try {
    const reader = await (await fetch(`${s.base}/api/fleet/me`)).json();
    assert.strictEqual(reader.id, 'reader@example.com');
    assert.strictEqual(reader.admin, false);
    assert.strictEqual('groups' in reader, false);

    const denied = await fetch(`${s.base}/api/fleet/clusters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual((await denied.json()).code, 'MISSING_SCOPE');

    const admin = await (await fetch(`${s.base}/api/fleet/me`, { headers: { 'x-test-groups': 'admin' } })).json();
    assert.strictEqual(admin.admin, true);
  } finally {
    await s.close();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
