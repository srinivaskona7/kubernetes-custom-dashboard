// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The Helm release console's UI invariants, enforced as source checks rather than as prose.
 *
 * `app/fleet-ui` has vitest configured and no test files, and installing jsdom is blocked on this
 * workstation (npm E401 against the internal registry), so a rendering test cannot run here. What
 * follows are the invariants that are checkable without a DOM, and they happen to be the ones with
 * the worst failure modes:
 *
 *  1. Nothing in the Helm surface offers a mutation. Helm is the one domain where an operator
 *     *expects* Rollback and Upgrade buttons, which makes an accidental one the most plausible
 *     read-only breach in the whole console — and a "Rollback" label is the breach whether or not
 *     it is wired to anything.
 *  2. Only the four files that must fetch, fetch. The seven tabs would otherwise each pull the
 *     release list and disagree with each other about the same release.
 *  3. No Secret value and no raw release record can reach the browser through these components.
 */




const UI = path.join(FAKE_DIR, '../../src');
const HELM_DIR = path.join(UI, 'pages/helm');

/**
 * Shared components a Helm surface renders, outside `pages/helm/`.
 *
 * Explicit and short on purpose: the whole point of scanning `pages/helm/` as a folder is that a
 * new file there is caught for free, but `components/` is shared by every tab in the console, and
 * most of it has nothing to do with Helm. Naming the file here is the honest version of "this one
 * carries Helm's live-object read now" — a whole-directory scan would either miss a future Helm
 * file placed elsewhere or drag in unrelated components that were never reviewed against these
 * five checks.
 */
const SHARED_HELM_COMPONENTS = ['components/LiveYaml.tsx'];

/** The Helm tab folder, plus the two pages that frame it. All of it is one operator surface. */
function helmSources() {
  const files = fs.readdirSync(HELM_DIR).filter(f => /\.(ts|tsx)$/.test(f));
  assert.ok(
    files.length >= 9,
    `the Helm folder scan found only ${files.length} files — the scan is broken, not the folder`
  );
  const sources = files.map(file => ({
    file: `helm/${file}`,
    src: fs.readFileSync(path.join(HELM_DIR, file), 'utf8')
  }));
  for (const rel of ['pages/HelmReleasePage.tsx', 'pages/cluster-tabs/HelmTab.tsx', ...SHARED_HELM_COMPONENTS]) {
    sources.push({ file: rel, src: fs.readFileSync(path.join(UI, rel), 'utf8') });
  }
  return sources;
}

/**
 * Strip comments before looking for verbs.
 *
 * Not cosmetic: several of these files explain at length *why* there is no Rollback control, and a
 * naive grep matches the explanation and fails the file that is correct. The guard has to read what
 * ships to the browser, which is the code.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Verbs that can never be innocent, wherever they appear in a string.
 *
 * There is no read-only reason to write "Rollback" or "Uninstall" on this surface at all: Helm's
 * destructive lifecycle has no descriptive use in a console that only reads.
 */
const NEVER_ANYWHERE = ['Rollback', 'Roll back', 'Uninstall', 'Reinstall', 'Redeploy', 'Force delete'];

/**
 * Verbs that are forbidden *as a control* and fine as description.
 *
 * `Rollout complete` and `Scale target` are field labels reporting what the cluster says — the
 * Deployment's own `Progressing` condition and an HPA's `scaleTargetRef`. Banning the words outright
 * would push the console into paraphrasing Kubernetes' vocabulary, which is its own kind of lie. So
 * these are checked only where they could be pressed.
 */
const NEVER_ON_A_CONTROL = [
  ...NEVER_ANYWHERE,
  'Upgrade', 'Install', 'Restart', 'Rollout', 'Scale', 'Delete', 'Apply', 'Sync',
  'Edit', 'Patch', 'Suspend', 'Resume', 'Trigger', 'Drain', 'Cordon', 'Exec'
];

/**
 * Every string that could reach an operator as something pressable: the children of a `<button>` or
 * a `<Link>`, and the `title` / `aria-label` of anything.
 */
function controlLabels(code) {
  const out = [];
  for (const m of code.matchAll(/<(button|Link|a)\b[\s\S]*?>([\s\S]*?)<\/\1>/g)) {
    out.push((m[2] || '').replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' '));
  }
  for (const m of code.matchAll(/(?:title|aria-label)=\{?["'`]([^"'`]{2,120})["'`]/g)) {
    out.push(m[1] || '');
  }
  return out;
}

test('no Helm string offers a Helm lifecycle mutation', () => {
  const offenders = [];
  for (const { file, src } of helmSources()) {
    const code = stripComments(src);
    for (const verb of NEVER_ANYWHERE) {
      if (code.includes(verb)) offenders.push(`${file}: "${verb}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these files name a Helm lifecycle mutation, and this console only reads:\n  ' + offenders.join('\n  ')
  );
});

test('no Helm control is labelled with a mutation verb', () => {
  const offenders = [];
  for (const { file, src } of helmSources()) {
    for (const label of controlLabels(stripComments(src))) {
      for (const verb of NEVER_ON_A_CONTROL) {
        if (new RegExp(`\\b${verb}`, 'i').test(label)) {
          offenders.push(`${file}: pressable "${label.trim().replace(/\s+/g, ' ')}" contains "${verb}"`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these Helm controls offer a mutation, and this console is read-only:\n  ' + offenders.join('\n  ')
  );
});

test('no Helm component performs a write request', () => {
  const offenders = [];
  for (const { file, src } of helmSources()) {
    const code = stripComments(src);
    // The api module exposes reads as `cluster*` getters; a write would have to reach for fetch or
    // one of the mutating helpers directly.
    if (/\bfetch\s*\(/.test(code)) offenders.push(`${file}: a bare fetch(`);
    if (/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(code)) offenders.push(`${file}: an explicit write method`);
    if (/\bapi\.(post|put|patch|del|delete|remove|create|update)\b/.test(code)) offenders.push(`${file}: a mutating api call`);
  }
  assert.deepEqual(offenders, [], 'these Helm components issue writes: ' + offenders.join(', '));
});

test('an editable pane would be caught — Values and Manifest are viewers, never form fields', () => {
  const offenders = [];
  for (const { file, src } of helmSources()) {
    const code = stripComments(src);
    // `<textarea>` and `contentEditable` are the two ways a read-only pane silently becomes an
    // editor. `<input>` is legitimate here — search and filters use it — so it is not listed.
    if (/<textarea/i.test(code)) offenders.push(`${file}: <textarea>`);
    if (/contentEditable/.test(code)) offenders.push(`${file}: contentEditable`);
  }
  assert.deepEqual(offenders, [], 'these files can accept edited text: ' + offenders.join(', '));
});

test('only the deferred surfaces call the API — every other tab takes props', () => {
  // Insights, Resources, Architecture, Events and Values all render from a payload their parent
  // already holds. If one of them started fetching, opening a release would issue a request per tab
  // and the tabs could disagree about the same release.
  const MAY_FETCH = new Set([
    'pages/HelmReleasePage.tsx',        // the release list, and the one related-resources read
    'pages/cluster-tabs/HelmTab.tsx',   // the list page's own read
    'helm/revision.tsx',                // WithRevision: the per-revision record, on mount only
    'helm/HelmHistory.tsx',             // two revision records, and only when a diff is requested
    // The live object behind one selected node. `HelmResourceDrawer.tsx` no longer fetches at
    // all — this shared component carries the read instead, pinned to it alone below.
    'components/LiveYaml.tsx'
  ]);

  const offenders = [];
  for (const { file, src } of helmSources()) {
    if (/\bapi\.cluster[A-Za-z]*\(/.test(stripComments(src)) && !MAY_FETCH.has(file)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these Helm screens fetch their own data instead of receiving it: ' + offenders.join(', ')
  );
});

test('each fetching file fetches exactly the read it is meant to defer', () => {
  const byFile = new Map(helmSources().map(s => [s.file, stripComments(s.src)]));
  const src = f => {
    const found = byFile.get(f);
    assert.ok(found, `${f} is not in the scanned set — the scan is broken`);
    return found;
  };

  // The shell owns the list read and the related-resources read. Nothing else may take either.
  assert.match(src('pages/HelmReleasePage.tsx'), /api\.clusterHelmReleases\(/);
  assert.match(src('pages/HelmReleasePage.tsx'), /api\.clusterHelmRelated\(/);
  assert.ok(
    !/api\.clusterHelmManifest\(/.test(src('pages/HelmReleasePage.tsx')),
    'the shell must not fetch a revision record — that read belongs to the pane that needs it'
  );

  // The per-revision record is the expensive read, so exactly two files make it: the mount-to-fetch
  // wrapper, and History, which needs two of them side by side for a diff.
  assert.match(src('helm/revision.tsx'), /api\.clusterHelmManifest\(/);
  assert.match(src('helm/HelmHistory.tsx'), /api\.clusterHelmManifest\(/);

  // The resource drawer no longer fetches at all — the live-object read moved to the shared
  // `components/LiveYaml.tsx`, pinned below to the one read it exists for.
  const drawer = src('helm/HelmResourceDrawer.tsx');
  assert.deepEqual(
    [...new Set(drawer.match(/api\.cluster[A-Za-z]*\(/g) || [])],
    [],
    'the resource drawer must not fetch on its own — the live read belongs to LiveYaml.tsx'
  );

  const liveYaml = src('components/LiveYaml.tsx');
  assert.deepEqual(
    [...new Set(liveYaml.match(/api\.cluster[A-Za-z]*\(/g) || [])],
    ['api.clusterResourceYaml('],
    'LiveYaml may read one live object and nothing else'
  );

  // CANARY: this is the assertion that fails if Values or Manifest ever stops receiving its payload
  // through WithRevision and starts fetching on its own — the change that would make an operator
  // switching panes pay for the same read twice.
  for (const f of ['helm/HelmValues.tsx', 'helm/HelmManifest.tsx']) {
    assert.ok(!/api\.cluster/.test(src(f)), `${f} must render from the payload WithRevision hands it`);
  }
});

test('no Secret value and no raw release record can reach the screen through these components', () => {
  for (const { file, src } of helmSources()) {
    const code = stripComments(src);
    // server/fleet returns Secret keys and never values, so a UI reading `.stringData` or `.data[key]`
    // on a Secret would be reading something that is not on the wire. The check is cheap and the
    // invariant is absolute: it is the one that has to survive a future collector change.
    assert.ok(!/\.stringData\b/.test(code), `${file} references stringData`);
    assert.ok(
      !/atob\s*\(|Buffer\.from\([^)]*base64/.test(code),
      `${file} decodes base64 in the browser — release records are decoded and redacted server-side`
    );
  }

  // The Secret drawer renders the key names it was given, and says so.
  const drawer = byName('helm/HelmResourceDrawer.tsx');
  assert.match(drawer, /keys/, 'the Secret pane names keys');
  assert.ok(!/\bvalues\[/.test(stripComments(drawer)), 'the Secret pane must not index into values');
});

/** One named source, for a check that is about a single file rather than the whole set. */
function byName(file) {
  const found = helmSources().find(s => s.file === file);
  assert.ok(found, `${file} is not in the scanned set`);
  return found.src;
}

test('every pane that shows stored content explains its redaction', () => {
  // A bare `[redacted]` on screen reads as the literal configured value, which is worse than
  // showing nothing. Each pane explains it in the vocabulary of what it shows: Values and the
  // revision reads share one note, and the Manifest explains it per document, because there
  // redaction is decided by the document's own Kind rather than by a key name.
  assert.match(byName('helm/revision.tsx'), /REDACTION_NOTE/);
  assert.match(byName('helm/HelmValues.tsx'), /REDACTION_NOTE/);

  const manifest = stripComments(byName('helm/HelmManifest.tsx'));
  assert.match(manifest, /redactedByKind/, 'the manifest pane must react to the per-document flag');
  assert.match(
    manifest,
    /blanked because it is a Secret/,
    'a redacted manifest document must say why, or the blank reads as the configured value'
  );
});
