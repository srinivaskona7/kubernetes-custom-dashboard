// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

const TABS = path.join(FAKE_DIR, '../../src/pages/cluster-tabs');
const read = f => fs.readFileSync(path.join(TABS, f), 'utf8');

test('IngressCard routes every hint through splitHint', () => {
  const src = read('ingress/parts.tsx');
  assert.match(src, /splitHint\(hint\)/);
  assert.doesNotMatch(src, /\{hint\s*&&\s*<p/);
});

test('every Traces Section opts into the one-line hint', () => {
  for (const f of ['TracesTab.tsx', 'TracesEndpoints.tsx', 'TracesServiceMap.tsx', 'TracesOutbound.tsx']) {
    const sections = read(f).match(/<Section\b[^>]*?>/gs) ?? [];
    for (const s of sections) if (/\bhint=/.test(s)) assert.match(s, /\bcompactHint\b/, `${f}: ${s.slice(0, 80)}`);
  }
});
