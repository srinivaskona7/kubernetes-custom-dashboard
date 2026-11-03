// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/*
  An allowlist refusing unknown clients is the policy working (user decision 2026-09-28): the
  Problems strip shows it as info, so the Clients tables must not paint the same count amber.
*/




const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = strip(fs.readFileSync(path.join(FAKE_DIR, '../../src/pages/cluster-tabs/ingress/IngressClients.tsx'), 'utf8'));

test('policy and host refusal counts on Clients are not drawn as warnings', () => {
  const denied = [...src.matchAll(/<Num value=\{(p\.denied|d\.count)\}[^>]*\/>/g)].map(m => m[0]);
  assert.equal(denied.length, 2, 'the two refusal cells were not found');
  for (const el of denied) assert.doesNotMatch(el, /tone="(warn|bad)"/, el);
});
