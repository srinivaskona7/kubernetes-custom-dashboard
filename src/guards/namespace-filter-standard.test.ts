// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The namespace filter is a global standard, and this is what keeps it one.
 *
 * The request that introduced it asked for a filter "reusable across all resource pages so the same
 * UX can be used for Pods, Deployments, StatefulSets, DaemonSets, Jobs, Services, ConfigMaps,
 * Secrets, etc." A component that is merely *available* does not deliver that — the next page will
 * quietly grow its own `[...new Set(rows.map(r => r.namespace))]` and its own dropdown, and within
 * three pages "namespace" means three different things (does it include cluster-scoped rows? is
 * empty all or none? does the count follow the filter?). These tests make that drift fail the build
 * instead of shipping.
 *
 * Each assertion below is paired with a canary that proves it fires on bad input, because a
 * source-scanning guard that silently matches nothing is worse than no guard: it reads as coverage.
 */




const UI = path.join(FAKE_DIR, '..', '..', 'src');

/** Every `.ts`/`.tsx` under the UI source tree, excluding tests. */
function sources() {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if ((entry.isDirectory() && entry.name !== 'guards')) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(UI);
  return out;
}

const FILES = sources().map(f => ({ path: f, rel: path.relative(UI, f), text: fs.readFileSync(f, 'utf8') }));

test('the scan actually reaches the UI source tree', () => {
  // A floor, so deleting or moving the tree turns this file red rather than green-and-empty.
  assert.ok(FILES.length >= 60, `expected >= 60 UI sources, scanned ${FILES.length}`);
});

// ---------------------------------------------------------------- one set of rules, not many

/**
 * The namespace vocabulary lives in exactly one module.
 *
 * `matchesNamespace` is the single place that decides the three rules a namespace filter has to get
 * right: an empty selection admits everything, several selections are OR, and a row with no
 * namespace is cluster-scoped and survives any selection. A second implementation of any of those
 * is a second answer to the same question.
 */
test('namespace-filter.ts is the only place the selection semantics are decided', () => {
  const rules = FILES.filter(f => f.rel !== 'components/namespace-filter.ts').filter(f =>
    // A hand-rolled membership test against a namespace selection, in any of the shapes it takes.
    /(selected|selectedNamespaces|namespaces)\s*\.\s*has\s*\(\s*\w*\.?\s*namespace/i.test(f.text)
  );
  assert.deepEqual(
    rules.map(f => f.rel),
    [],
    'these files decide namespace membership themselves instead of calling matchesNamespace'
  );
});

test('canary: the membership-test scan fires on a hand-rolled check', () => {
  assert.match('rows.filter(r => selected.has(r.namespace))', /(selected|selectedNamespaces|namespaces)\s*\.\s*has\s*\(\s*\w*\.?\s*namespace/i);
  assert.match('if (namespaces.has(pod.namespace)) keep(pod)', /(selected|selectedNamespaces|namespaces)\s*\.\s*has\s*\(\s*\w*\.?\s*namespace/i);
});

/**
 * New namespace option lists go through `namespacesOf`.
 *
 * Five inline derivations predate the standard and are allowlisted below — each is a single-select
 * `FilterSelect` on a page that has not been migrated, and each is correct for what it does. The
 * allowlist exists so the *sixth* one fails: a new page must reuse the shared derivation, which is
 * the only one that drops empty and null namespaces and sorts the same way.
 */
const INLINE_DERIVATION = /new Set\s*\(\s*[^)]*\.\s*map\s*\(\s*\w+\s*=>\s*\w+\.namespace/;

const PRE_STANDARD = new Set([
  // Exported and unit-tested; typed to NodePodRow, and the Nodes tab's single-select predates this.
  'pages/cluster-tabs/node-pods.ts',
  // A field on the utilization model, computed alongside the rest of that payload.
  'pages/cluster-tabs/usage/utilization-model.ts',
  // Single-select namespace picker driving the pod-log selection, not a row filter.
  'pages/cluster-tabs/LogsTab.tsx'
]);

test('a new namespace option list uses namespacesOf rather than deriving its own', () => {
  const offenders = FILES.filter(
    f => f.rel !== 'components/namespace-filter.ts' && !PRE_STANDARD.has(f.rel) && INLINE_DERIVATION.test(f.text)
  );
  assert.deepEqual(
    offenders.map(f => f.rel),
    [],
    'derive namespace options with namespacesOf() from components/namespace-filter.ts'
  );
});

test('every pre-standard entry still has the inline derivation it is excused for', () => {
  // A stale allowlist entry is an invariant nobody is checking any more. If one of these pages is
  // migrated to the standard, its entry must be deleted in the same change.
  for (const rel of PRE_STANDARD) {
    const file = FILES.find(f => f.rel === rel);
    assert.ok(file, `allowlisted file no longer exists: ${rel}`);
    assert.ok(
      INLINE_DERIVATION.test(file.text),
      `${rel} no longer derives namespaces inline — remove it from PRE_STANDARD`
    );
  }
});

test('canary: the inline-derivation scan fires on the shape it is meant to catch', () => {
  assert.match('[...new Set(pods.map(p => p.namespace))].sort()', INLINE_DERIVATION);
  assert.match('const ns = new Set(rows.map(r => r.namespace));', INLINE_DERIVATION);
  // And does not fire on the sanctioned call.
  assert.doesNotMatch('namespacesOf(items, w => w.namespace)', INLINE_DERIVATION);
});

// ---------------------------------------------------------------- the selection must survive

/**
 * A page that renders the control holds its selection in the URL.
 *
 * `WorkloadsArea` remounts its table with `key={section}` when the operator moves between the
 * Workloads and Pods sub-tabs, so a selection in `useState` is destroyed on that switch: the table
 * silently returns every row while the toolbar still claims a filter is active. The URL survives
 * the remount, the reload and the Back button — and makes a filtered view shareable, which is the
 * whole point of a console two people read together during an incident.
 */
test('every page rendering NamespaceFilter holds the selection in the URL', () => {
  const users = FILES.filter(f => /<NamespaceFilter\b/.test(f.text));
  assert.ok(users.length >= 1, 'no page renders <NamespaceFilter> — the control is unused');
  for (const f of users) {
    assert.match(
      f.text,
      /useNamespaceSelection\s*\(/,
      `${f.rel} renders <NamespaceFilter> but does not call useNamespaceSelection — a selection in ` +
        'component state is discarded by the key={section} remount'
    );
  }
});

test('canary: a useState-backed selection would be rejected', () => {
  const bad = 'const [ns, setNs] = useState(new Set());\nreturn <NamespaceFilter selected={ns} />;';
  assert.match(bad, /<NamespaceFilter\b/);
  assert.doesNotMatch(bad, /useNamespaceSelection\s*\(/);
});

// ---------------------------------------------------------------- read-only

/**
 * The control is inspection-only.
 *
 * The request states it outright — "Do not add create, edit, delete, restart, scale, or any other
 * mutation actions" — and it restates the rule this whole console is built on. A namespace picker is
 * exactly where a "delete namespace" affordance would feel natural to add later.
 */
const MUTATION_LABELS = [
  'Delete',
  'Remove namespace',
  'Create namespace',
  'New namespace',
  'Edit',
  'Rename',
  'Drain',
  'Restart',
  'Scale',
  'Apply',
  'Quarantine'
];

test('the namespace control offers no mutation affordance', () => {
  const control = FILES.find(f => f.rel === 'components/NamespaceFilter.tsx');
  assert.ok(control, 'components/NamespaceFilter.tsx is missing');
  for (const label of MUTATION_LABELS) {
    assert.ok(
      !new RegExp(`['"\`>]\\s*${label}`, 'i').test(control.text),
      `NamespaceFilter offers a "${label}" control; this console is read-only`
    );
  }
});

test('the namespace control and its logic never call the API', () => {
  // The options come from rows the page already holds. A control that fetches would turn a
  // checkbox tick into a cluster read, and on a 60-namespace cluster into sixty of them.
  for (const rel of ['components/NamespaceFilter.tsx', 'components/namespace-filter.ts', 'components/use-namespace-selection.ts']) {
    const file = FILES.find(f => f.rel === rel);
    assert.ok(file, `${rel} is missing`);
    assert.doesNotMatch(file.text, /\bfetch\s*\(|\buseAsync\s*\(|from '\.\.?\/api'/, `${rel} must not fetch`);
  }
});

// ---------------------------------------------------------------- the invariant, in writing

test('the empty-set-means-all invariant is documented where it is decided', () => {
  const logic = FILES.find(f => f.rel === 'components/namespace-filter.ts');
  assert.ok(logic, 'components/namespace-filter.ts is missing');
  // Prose, deliberately. This is the one rule a reader has to know before touching any of it, and
  // the rule that makes the default state and the cleared state a single state.
  assert.match(logic.text, /empty set means "all"/i);
  assert.match(logic.text, /requirement 3/i);
});
