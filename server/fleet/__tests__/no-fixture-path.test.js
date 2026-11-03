
/**
 * There is exactly one data path, and it is the real one.
 *
 * The server used to carry a fixture mode: `FLEET_MOCK=1` swapped the transport for
 * `test/fleet/dev-fixtures`, and the only thing standing between an operator and invented
 * numbers they believed were real was `NODE_ENV` being set correctly on that one deployment.
 * `srv/fleet/dev-server.js` carried the same switch, so a locally reviewed feature could be
 * reviewed entirely against data no cluster ever produced.
 *
 * Both are gone. These tests are the guard that keeps them gone: they fail if any shipped
 * source reaches into the test fixtures, reads a mock switch, or bakes a cluster identity in.
 *
 * The fixtures themselves are untouched and still used — by tests, which is the only caller
 * a fixture should ever have.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRV = path.join(REPO, 'server');

/** Every .js file that ships in the image. */
function shippedSources(dir = SRV, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__') shippedSources(full, out); }
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SOURCES = shippedSources();
const rel = f => path.relative(REPO, f);

test('the guard sees the files it is meant to guard', () => {
  // Without this, a broken walk would make every test below pass over an empty list.
  assert.ok(SOURCES.length > 20, `expected the server tree, found ${SOURCES.length} files`);
  assert.ok(SOURCES.some(f => rel(f) === 'server/index.js'));
  assert.ok(SOURCES.some(f => rel(f) === 'server/fleet/dev-server.js'));
});

test('no shipped source requires the test fixtures', () => {
  const offenders = SOURCES.filter(f =>
    /(?:require\(|from\s+)['"][^'"]*dev-fixtures[^'"]*['"]/.test(fs.readFileSync(f, 'utf8'))
  ).map(rel);

  assert.deepEqual(
    offenders,
    [],
    `these shipped files load test fixtures, so a deployment could serve invented data:\n  ${offenders.join('\n  ')}`
  );
});

test('no shipped source reads a mock or demo switch', () => {
  // Names, not values: it is the existence of the switch that is the defect. A file that
  // merely mentions one in prose is caught too, which is deliberate — a comment describing a
  // live switch is how the next reader concludes the switch is still there.
  const SWITCHES = /\b(FLEET_MOCK|FLEET_DEMO|FLEET_FIXTURES|USE_MOCK|MOCK_DATA)\b/;
  const offenders = SOURCES
    .filter(f => SWITCHES.test(fs.readFileSync(f, 'utf8')))
    .map(rel);

  assert.deepEqual(
    offenders,
    [],
    `these shipped files still reference a fixture switch:\n  ${offenders.join('\n  ')}`
  );
});

test('the dev server bakes in no cluster identity', () => {
  // The old harness shipped `BAKED_IDS = ['platformsbx', 'demo-dev']` with display names and
  // apiUrls. A universal console must not know any cluster before an operator adds one, and a
  // reviewer must never mistake a baked entry for a connected one.
  const text = fs.readFileSync(path.join(SRV, 'fleet', 'dev-server.js'), 'utf8');

  assert.doesNotMatch(text, /BAKED/, 'the dev server must not carry a baked cluster list');
  assert.match(
    text,
    /JSON\.stringify\(\{\s*clusters:\s*\[\]\s*\}/,
    'the dev server must start from an empty cluster list'
  );
  for (const invented of ['platformsbx', 'demo-dev', 'Platform SBX', 'Kyma Dev']) {
    assert.ok(!text.includes(invented), `the dev server still names the cluster ${invented}`);
  }
});

test('no shipped source carries a fixture token literal', () => {
  const offenders = SOURCES
    .filter(f => /FIXTURE-NOT-A-REAL-TOKEN|NOT-A-REAL-TOKEN/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);

  assert.deepEqual(offenders, [], `fixture token literals in shipped code:\n  ${offenders.join('\n  ')}`);
});
