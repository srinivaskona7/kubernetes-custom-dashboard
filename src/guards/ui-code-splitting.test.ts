// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The code-splitting boundaries, and the one way they regress.
 *
 * Nothing about a `lazy()` boundary is visible at runtime when it is *removed*: the page still works,
 * the tests still pass, and the only symptom is 600 kB more in the chunk that has to arrive before the
 * console paints. Adding a plain `import TrafficTab from ...` back to `ClusterDetail.tsx` is one line
 * and looks like a tidy-up.
 *
 * Measured on this repo: the main chunk was 924 kB (257 kB gzipped) with the sixteen cluster tabs and
 * all eight routes imported eagerly, and 305 kB (98 kB gzipped) with both boundaries in place.
 *
 * Two tabs and one route are deliberately eager, and the exceptions are listed here rather than
 * inferred, so that a future addition to the list is a decision somebody wrote down:
 *
 *   OverviewTab   the tab a cluster page opens on
 *   TokensTab     small, and the tab an operator needs when the others are failing to authenticate
 *   Overview      the page `/` renders
 */




const UI_SRC = path.join(FAKE_DIR, '..', '..', 'src');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The cluster tabs that must stay behind a `lazy()` boundary. */
const LAZY_TABS = [
  'AutoscalingTab',
  'CostTab',
  'HelmTab',
  'LogsTab',
  'ModulesIntegrityTab',
  'NetworkOperationsTab',
  'SecurityTab',
  'StorageTab',
];

/** Eager on purpose. Each one costs the main chunk its own weight, so the list has to stay short. */
const EAGER_TABS = ['OverviewTab', 'TokensTab'];

test('every heavy cluster tab is loaded on demand', () => {
  const body = stripComments(fs.readFileSync(path.join(UI_SRC, 'pages', 'ClusterDetail.tsx'), 'utf8'));
  for (const tab of LAZY_TABS) {
    assert.match(
      body,
      new RegExp(`const ${tab} = lazy\\(`),
      `${tab} is no longer behind a \`lazy()\` boundary in ClusterDetail.tsx — it is back in the chunk that has to arrive before the page paints.`
    );
    assert.ok(
      !new RegExp(`^import .*\\b${tab}\\b.* from '\\./cluster-tabs/`, 'm').test(body),
      `${tab} is imported eagerly as well as lazily — the static import wins and the boundary does nothing.`
    );
  }
  for (const tab of EAGER_TABS) {
    assert.match(
      body,
      new RegExp(`^import ${tab} from '\\./cluster-tabs/`, 'm'),
      `${tab} is in the deliberately-eager list but is no longer imported eagerly — update the list here, or the exception is undocumented.`
    );
  }
});

test('the lazy tabs are rendered inside a Suspense boundary, inside the error boundary', () => {
  const body = stripComments(fs.readFileSync(path.join(UI_SRC, 'pages', 'ClusterDetail.tsx'), 'utf8'));
  const boundary = body.indexOf('<TabErrorBoundary');
  const suspense = body.indexOf('<Suspense');
  assert.ok(boundary !== -1, 'ClusterDetail.tsx no longer wraps its tabs in TabErrorBoundary');
  assert.ok(suspense !== -1, 'ClusterDetail.tsx renders lazy tabs with no <Suspense> — the first open would throw');
  assert.ok(
    boundary < suspense,
    'the <Suspense> is outside TabErrorBoundary — a chunk that fails to load throws during render, and the error boundary is what turns that into an in-page error instead of a blank page.'
  );
});

test('every route except the landing page is loaded on demand', () => {
  const body = stripComments(fs.readFileSync(path.join(UI_SRC, 'App.tsx'), 'utf8'));
  for (const page of [
    'ClusterDetail',
    'Drift',
    'HelmReleasePage',
    'NotFound',
    'OnboardPage',
    'OnboardSsoPage',
    'Tokens'
  ]) {
    assert.match(
      body,
      new RegExp(`const ${page} = lazy\\(`),
      `${page} is imported eagerly in App.tsx — every route's code would ship with the first page load.`
    );
  }
  // The landing route, eager on purpose: deferring what `/` always renders adds a round trip.
  assert.match(body, /^import Overview from '\.\/pages\/Overview';$/m);
  assert.ok(body.includes('<Suspense'), 'App.tsx has lazy routes and no <Suspense> boundary');
});
