// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

// Top Utilization was retired into Namespaces & Workloads → Top Consumers (2026-09-25). This pins
// the retirement so the tab cannot come back half-registered, and pins where its links now land.




const UI = path.join(FAKE_DIR, '../../src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the utilization tab id is gone from every registry', () => {
  const tabs = code(read('pages/cluster-tabs/tabs.ts'));
  const aliasBlock = tabs.match(/export const TAB_ALIASES[\s\S]*?\n};/)?.[0] ?? '';
  const rest = tabs.replace(aliasBlock, '');
  assert.doesNotMatch(rest, /'utilization'|\butilization\s*:/, 'tabs.ts still registers utilization outside TAB_ALIASES');
  assert.match(aliasBlock, /utilization:\s*\{\s*tab:\s*'workloads',\s*section:\s*'top'[^}]*\}/);
  assert.doesNotMatch(code(read('prefetch.ts')), /'utilization'|\butilization\s*:/, 'prefetch.ts still warms utilization');
});

test('the Top Utilization sources are deleted', () => {
  assert.equal(fs.existsSync(path.join(UI, 'pages/cluster-tabs/utilization')), false);
  assert.equal(fs.existsSync(path.join(UI, 'pages/cluster-tabs/UtilizationTab.tsx')), false);
  assert.doesNotMatch(code(read('pages/ClusterDetail.tsx')), /UtilizationTab|tab === 'utilization'/);
});

test('Top Consumers is mounted under section top', () => {
  const cd = code(read('pages/ClusterDetail.tsx'));
  assert.match(cd, /section === 'top' && \(\s*<TopConsumersSection/);
  assert.match(code(read('pages/cluster-tabs/tabs.ts')), /\{ id: 'top', label: 'Top Consumers'/);
});
