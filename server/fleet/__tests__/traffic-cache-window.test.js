
/**
 * Traffic and Traces serve an answer up to 10 minutes old (user decision, 2026-09-28: "10 minutes
 * plus an 'updated N min ago' label").
 *
 * The window is 15s fresh plus 585s stale-while-revalidate. Two other bounds derive from it and
 * must move with it, or the route serves a 10-minute-old body while the shared tails behind it
 * expire at 2 minutes (every interactive read re-tails), or the tails outlive the body:
 *
 *  - `logShare` retains a container tail for exactly the served window;
 *  - an interactive read may reuse a tail up to that same age.
 *
 * Read from source with comments stripped, so a doc comment quoting the old number cannot pass.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import _fanout from '../fanout.js';
const { Cache } = _fanout;

const __dirname = import.meta.dirname;

const SRC = fs.readFileSync(path.join(__dirname, '../router.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const code = stripComments(SRC);

function defaultOf(name, env) {
  const m = code.match(new RegExp(`const ${name} = Number\\(process\\.env\\.${env} \\|\\| ([0-9_]+)\\)`));
  assert.ok(m, `${name} must default from ${env}`);
  return Number(m[1].replace(/_/g, ''));
}

test('the traffic cache serves for 10 minutes: 15s fresh + 585s stale, both env-overridable', () => {
  const ttl = defaultOf('TRAFFIC_CACHE_TTL_MS', 'FLEET_TRAFFIC_CACHE_TTL_MS');
  const stale = defaultOf('TRAFFIC_CACHE_STALE_MS', 'FLEET_TRAFFIC_CACHE_STALE_MS');
  assert.equal(ttl, 15_000);
  assert.equal(stale, 585_000);
  assert.equal(ttl + stale, 600_000);
  assert.match(code, /const TRAFFIC_MAX_AGE_MS = TRAFFIC_CACHE_TTL_MS \+ TRAFFIC_CACHE_STALE_MS;/);
});

test('shared tails are retained and reused for exactly the served window', () => {
  assert.match(code, /createLogShare\(\{ retainMs: TRAFFIC_MAX_AGE_MS \}\)/);
  assert.match(code, /maxLogAgeMs: [^\n]*\? 0 : TRAFFIC_MAX_AGE_MS/);
  assert.match(code, /staleMs: TRAFFIC_CACHE_STALE_MS,/);
});

test('the route cache honours the declared window: stale at 9m59s, refetched after 10m', async () => {
  let now = 0;
  let runs = 0;
  const cache = new Cache({ ttlMs: 30_000, staleMs: 60_000, now: () => now });
  const fn = async () => ++runs;
  const opts = { ttlMs: 15_000, staleMs: 585_000 };
  assert.equal(await cache.wrap('k', fn, opts), 1);
  now = 599_000;
  assert.equal(await cache.wrap('k', fn, opts), 1, 'served stale inside the 10 minutes');
  await new Promise(r => setImmediate(r));
  assert.equal(runs, 2, 'and refreshed behind the answer');
  now += 600_001;
  assert.equal(await cache.wrap('k', fn, opts), 3, 'nothing older than 10 minutes is served');
});

