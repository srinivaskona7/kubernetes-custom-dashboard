/**
 * Gatekeeper policy-library matching: the catalogue's integrity, the custom / library / modified
 * verdict, version comparison, and per-bundle coverage over OPA policy rows.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import gk from '../collectors/gatekeeper-library.js';
import catalogue from '../collectors/gatekeeper-library.json';

const template = (name, rego, version) => ({
  metadata: { name, annotations: version ? { 'metadata.gatekeeper.sh/version': version } : {} },
  spec: { targets: [{ target: 'admission.k8s.gatekeeper.sh', code: [{ engine: 'Rego', source: { rego } }] }] }
});

test('the catalogue is stamped, non-empty, and every entry carries what the screen shows', () => {
  assert.ok(catalogue.source && /^[0-9a-f]{40}$/.test(catalogue.source.commit), 'stamped with the library commit');
  assert.ok(catalogue.templates.length >= 40, `expected the full library, got ${catalogue.templates.length}`);
  for (const t of catalogue.templates) {
    assert.ok(t.name && t.title && t.version, `incomplete entry ${t.name}`);
    assert.ok(Array.isArray(t.bundles));
  }
  for (const b of gk.BUNDLES) {
    assert.ok(catalogue.templates.some(t => t.bundles.includes(b)), `no template in bundle ${b}`);
  }
});

test('an unknown name is custom, whatever its Rego says', () => {
  const m = gk.libraryMatch(template('restrictjenkinsdeployer', 'package x', '1.0.0'));
  assert.equal(m.state, 'custom');
  assert.equal(m.title, null);
  assert.equal(m.clusterVersion, '1.0.0');
});

test('a library name with different Rego is modified, not library (canary for trusting the name)', () => {
  const m = gk.libraryMatch(template('k8spspprivilegedcontainer', 'package forked\nviolation[{"msg": "x"}] { true }', '1.1.3'));
  assert.equal(m.state, 'modified');
  assert.equal(m.rego, 'differs');
  assert.equal(m.title, 'Privileged Container');
  assert.ok(m.bundles.includes('pod-security-baseline'));
});

test('identical Rego (modulo indentation) is library; version behind is compared numerically', () => {
  const t = template('k8sdemo', 'package demo\n  violation[{"msg": m}] {\n    m := "x"\n  }\n', '1.2.0');
  const entry = { title: 'Demo', version: '1.10.0', bundles: [], path: 'library/demo', regoFingerprint: gk.regoFingerprint(
    template('k8sdemo', 'package demo\nviolation[{"msg": m}] {\nm := "x"\n}', null)) };
  const m = gk.matchEntry(entry, t);
  assert.equal(m.state, 'library');
  assert.equal(m.rego, 'identical');
  // 1.2.0 < 1.10.0 numerically; a string compare would say the opposite.
  assert.equal(m.behind, true);
  assert.equal(gk.compareVersions('1.10.0', '1.2.0'), 1);
  assert.equal(gk.compareVersions('v1', '1.0'), null, 'an unparseable version is unknown, never "current"');
});

test('a CEL-only template has no fingerprint, so the Rego verdict is null rather than identical', () => {
  const cel = { metadata: { name: 'k8spspprivilegedcontainer' }, spec: { targets: [{ code: [{ engine: 'K8sNativeValidation', source: {} }] }] } };
  assert.equal(gk.regoFingerprint(cel), null);
  const m = gk.libraryMatch(cel);
  assert.equal(m.rego, null);
  assert.equal(m.state, 'library');
  assert.equal(m.behind, null, 'no version annotation, so behind is unknown');
});

test('bundleCoverage counts installed and deny-enforcing library members per bundle', () => {
  const policies = [
    { templateName: 'k8spspprivilegedcontainer', enforcementAction: 'deny', status: 'active', library: { state: 'library' } },
    { templateName: 'k8spsphostnamespace', enforcementAction: 'dryrun', status: 'active', library: { state: 'modified' } },
    { templateName: 'restrictjenkinsdeployer', enforcementAction: 'deny', status: 'active', library: { state: 'custom' } }
  ];
  const [baseline] = gk.bundleCoverage(policies);
  assert.equal(baseline.bundle, 'pod-security-baseline');
  assert.equal(baseline.total, catalogue.templates.filter(t => t.bundles.includes('pod-security-baseline')).length);
  assert.equal(baseline.installed, 2);
  assert.equal(baseline.enforcing, 1, 'dry-run is installed but does not enforce');
  assert.equal(baseline.templates.find(t => t.name === 'k8spsphostnamespace').modified, true);
});

test('bundleCoverage never counts an unread Constraint as "does not deny"', () => {
  const policies = [{ templateName: 'k8spspprivilegedcontainer', enforcementAction: 'unknown', status: 'unknown', library: { state: 'library' } }];
  const [baseline] = gk.bundleCoverage(policies);
  assert.equal(baseline.installed, 1);
  assert.equal(baseline.enforcing, 0);
  assert.equal(baseline.enforcingUnknown, 1);
  assert.equal(baseline.templates.find(t => t.name === 'k8spspprivilegedcontainer').enforcing, null);
});

test('bundleCoverage: a template with no Constraint is a definite "does not deny", not unknown', () => {
  const [baseline] = gk.bundleCoverage([{ templateName: 'k8spspprivilegedcontainer', enforcementAction: 'unknown', status: 'inactive', library: { state: 'library' } }]);
  assert.equal(baseline.enforcingUnknown, 0);
  assert.equal(baseline.templates.find(t => t.name === 'k8spspprivilegedcontainer').enforcing, false);
});
