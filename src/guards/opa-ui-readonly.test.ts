// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The OPA dashboard's two UI invariants, enforced as source checks rather than as prose.
 *
 * `app/fleet-ui` has vitest configured and no test files, and installing jsdom is blocked on this
 * workstation (npm E401 against the internal registry), so a rendering test cannot run here. These
 * two facts are checkable without a DOM, and they are the two that matter most:
 *
 *  1. No control in the OPA folder offers a mutation. The console must be unambiguously read-only,
 *     and a button labelled "Apply" is the ambiguity — whether or not it is wired to anything.
 *  2. Only the shell and the two deferred surfaces fetch. The four data tabs receive their payload
 *     as props, which is what makes "the mounted tab fetches its own data and no more" true by
 *     construction instead of by inspection.
 */




const OPA_DIR = path.join(FAKE_DIR, '../../src/pages/cluster-tabs/opa');

function opaSources() {
  const files = fs.readdirSync(OPA_DIR).filter(f => /\.(ts|tsx)$/.test(f));
  assert.ok(files.length >= 8, `the OPA folder scan found only ${files.length} files — the scan is broken, not the folder`);
  return files.map(file => ({ file, src: fs.readFileSync(path.join(OPA_DIR, file), 'utf8') }));
}

/**
 * Strip comments before looking for verbs.
 *
 * Not cosmetic: this very file's neighbours explain at length why there is no Apply button, and a
 * naive grep matches the explanation and fails on the code that is correct. The guard has to read
 * what ships to the browser, which is the code.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Verbs that must never label a control here.
 *
 * Each one is a mutation an OPA console is conventionally expected to offer and this one refuses:
 * the master constraint is that there be zero ambiguity that the application is read-only.
 */
const FORBIDDEN_LABELS = [
  'Create Policy', 'Edit Policy', 'Delete Policy', 'Apply', 'Sync',
  'Enable', 'Disable', 'Change enforcement', 'Add exemption',
  'Modify Constraint', 'Modify ConstraintTemplate', 'Mutate',
  'Rollback', 'Uninstall', 'Install ', 'Restart', 'Scale', 'Redeploy'
];

test('no OPA control is labelled with a mutation verb', () => {
  const offenders = [];
  for (const { file, src } of opaSources()) {
    const code = stripComments(src);
    // Only string and JSX-text positions can become a label. A `<button>` whose text is a verb is
    // the defect; a variable named `applyFilters` is not, which is why this looks at quoted text
    // and JSX children rather than at every identifier.
    const labels = [
      ...code.matchAll(/>([^<>{}]{2,60})</g),
      ...code.matchAll(/'([^']{2,60})'/g),
      ...code.matchAll(/"([^"]{2,60})"/g)
    ].map(m => m[1]);
    for (const label of labels) {
      for (const verb of FORBIDDEN_LABELS) {
        if (label.includes(verb)) offenders.push(`${file}: "${label.trim()}" contains "${verb}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these OPA labels offer a mutation, and this console is read-only:\n  ' + offenders.join('\n  ')
  );
});

test('an editable YAML control would be caught — the YAML pane is a <pre>, never a form field', () => {
  const offenders = [];
  for (const { file, src } of opaSources()) {
    const code = stripComments(src);
    // `<textarea>` and `contentEditable` are the two ways a read-only pane silently becomes an
    // editor. `<input>` is legitimate here — search and filters use it — so it is not listed.
    if (/<textarea/i.test(code)) offenders.push(`${file}: <textarea>`);
    if (/contentEditable/.test(code)) offenders.push(`${file}: contentEditable`);
  }
  assert.deepEqual(offenders, [], 'these files can accept edited text: ' + offenders.join(', '));
});

test('only the shell and the two deferred surfaces call the API — the four data tabs take props', () => {
  // Overview, Policies, Violations and Coverage render from the payload the shell already holds.
  // If one of them starts fetching, the OPA strip issues five requests for one collection and the
  // four screens can disagree about the same cluster.
  const MAY_FETCH = new Set([
    'OpaSection.tsx',    // the one `clusterOpa` read, on mount of the strip
    'OpaDecisions.tsx',  // its own Deployment read, only when Decision Activity is mounted
    'PolicyDrawer.tsx'   // the YAML read, only when the drawer's YAML pane opens
  ]);

  const offenders = [];
  for (const { file, src } of opaSources()) {
    const code = stripComments(src);
    if (/\bapi\.cluster[A-Za-z]*\(/.test(code) && !MAY_FETCH.has(file)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these OPA screens fetch their own data instead of receiving it: ' + offenders.join(', ')
  );
});

test('the three fetching files each fetch exactly the read they are meant to defer', () => {
  const read = f => stripComments(fs.readFileSync(path.join(OPA_DIR, f), 'utf8'));

  // CANARY: this is the assertion that would fail if the shell's single read were ever split into
  // per-tab endpoints, or if the drawer started pulling the whole OPA payload again on open.
  assert.match(read('OpaSection.tsx'), /api\.clusterOpa\(/);
  assert.ok(!/api\.clusterOpaDecisions\(/.test(read('OpaSection.tsx')),
    'the shell must not fetch decision activity — that read belongs to the mounted tab');
  assert.match(read('OpaDecisions.tsx'), /api\.clusterOpaDecisions\(/);
  assert.match(read('PolicyDrawer.tsx'), /api\.clusterOpaPolicyYaml\(/);
  assert.ok(!/api\.clusterOpa\(/.test(read('PolicyDrawer.tsx')),
    'the drawer must render from the payload the list already has');
});

test('a violation message is rendered verbatim, and no decoded Secret value can reach the screen', () => {
  const { src: violations } = opaSources().find(f => f.file === 'OpaViolations.tsx');
  // The message is Gatekeeper's own sentence; a template literal that rebuilt it would be a
  // rewrite of what the cluster said.
  assert.match(violations, /\{v\.message\}/);

  // Nothing in the OPA folder may render a `data` or `stringData` map. server/fleet returns Secret
  // keys and never values, so a UI that read `.data[key]` would be reading something that is not
  // there — but the check is cheap and the invariant is absolute.
  for (const { file, src } of opaSources()) {
    assert.ok(!/\.stringData\b/.test(stripComments(src)), `${file} references stringData`);
  }
});
