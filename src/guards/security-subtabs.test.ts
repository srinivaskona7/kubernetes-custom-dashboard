// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');

/**
 * Security & Compliance shows three sub-tabs: Namespace Compliance (the default), Admission & Policy
 * and Security & Isolation (restored 2026-09-26). PDBs & Drain was removed from the
 * strip; `PdbSection` is kept in SecurityTab.tsx but must not be mounted, and no copy may point at it.
 */




const ui = (...p) => fs.readFileSync(path.join(FAKE_DIR, '..', '..', 'src', ...p), 'utf8');
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const TABS = code(ui('pages', 'cluster-tabs', 'tabs.ts'));
const SECURITY_TAB = code(ui('pages', 'cluster-tabs', 'SecurityTab.tsx'));
const CLUSTER_DETAIL = code(ui('pages', 'ClusterDetail.tsx'));

function securitySectionIds() {
  const m = /\n  security: \[([\s\S]*?)\n  \],/.exec(TABS);
  assert.ok(m, 'TAB_SECTIONS.security not found in tabs.ts');
  return [...m[1].matchAll(/id: '([^']+)'/g)].map(x => x[1]);
}

test('Security & Compliance starts with Namespace Compliance', () => {
  // Order matters: SecurityTab falls back to SECTIONS[0], so the first entry is the default.
  assert.deepStrictEqual(securitySectionIds(), ['compliance', 'admission', 'isolation']);
  assert.match(SECURITY_TAB, /useSection<SectionId>\(SECTIONS, SECTIONS\[0\]\.id\)/);
});

test('the removed PDB section is not mounted; isolation is', () => {
  assert.match(SECURITY_TAB, /section === 'isolation' && <IsolationSection id=\{id\} \/>/);
  assert.doesNotMatch(SECURITY_TAB, /<PdbSection\b/);
  assert.match(SECURITY_TAB, /section === 'admission' && <AdmissionSection/);
  assert.match(SECURITY_TAB, /section === 'compliance'/);
});

test('no rendered copy names or links to a removed sub-tab', () => {
  for (const [name, src] of [['tabs.ts', TABS], ['SecurityTab.tsx', SECURITY_TAB], ['ClusterDetail.tsx', CLUSTER_DETAIL]]) {
    assert.doesNotMatch(src, /PDBs (&|&amp;) Drain/, `${name} still names PDBs & Drain`);
    assert.doesNotMatch(src, /setTab\('security', 'pdb'\)/, `${name} still links to a removed sub-tab`);
  }
});

test('Namespace Compliance cross-links to the restored Security & Isolation sub-tab', () => {
  assert.match(CLUSTER_DETAIL, /onViewIsolation=\{\(\) => setTab\('security', 'isolation'\)\}/);
  assert.match(CLUSTER_DETAIL, /Workload-level evidence is on Security &amp; Isolation/);
});
