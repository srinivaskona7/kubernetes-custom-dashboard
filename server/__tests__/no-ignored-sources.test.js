/**
 * A source file hidden from git by an ignore rule stays on the author's disk, passes every local
 * test, and is absent from a fresh clone, so the built image crashloops with "Cannot find module".
 * (An unanchored `kubeconfig*` credential pattern once swallowed server/fleet/kubeconfig.js.)
 *
 * Asserted directly: no shipped source file may be invisible to git. Relative imports are resolved
 * against the working tree rather than `git ls-files`, so the check also holds before a first commit.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.join(import.meta.dirname, '..', '..');

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function ignoredUnder(dir) {
  return git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', dir])
    .split('\n')
    .filter(Boolean)
    .filter(f => !f.startsWith('node_modules/') && !/\.tsbuildinfo$/.test(f));
}

for (const dir of ['server', 'src', 'chart']) {
  test(`no source file under ${dir}/ is hidden from git by an ignore rule`, () => {
    const hidden = ignoredUnder(dir);
    assert.deepStrictEqual(
      hidden,
      [],
      `these files exist locally but would be missing from a fresh clone:\n  ${hidden.join('\n  ')}\n` +
        'Run `git check-ignore -v <file>` to find the offending pattern and anchor it.',
    );
  });
}

test('no tracked file is a symlink pointing outside the repository', () => {
  const entries = git(['ls-files', '-s'])
    .split('\n')
    .filter(Boolean)
    .map(line => line.split(/\s+/))
    .filter(([mode]) => mode === '120000')
    .map(parts => parts[parts.length - 1]);
  const escaping = entries.filter(f => {
    const target = fs.readlinkSync(path.join(REPO, f));
    return path.isAbsolute(target) || !path.resolve(path.dirname(path.join(REPO, f)), target).startsWith(REPO);
  });
  assert.deepStrictEqual(escaping, [], `tracked symlinks that break in every clone:\n  ${escaping.join('\n  ')}`);
});

test('every relative import in server/ resolves to a file that exists and is not ignored', () => {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '--', 'server'])
    .split('\n')
    .filter(f => f.endsWith('.js') && !f.includes('__tests__/'));
  assert.ok(files.length > 20, `only ${files.length} server files found; the listing is wrong`);
  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    for (const [, spec] of text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g)) {
      const base = path.resolve(path.dirname(path.join(REPO, file)), spec);
      const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
      if (!candidates.some(c => fs.existsSync(c) && fs.statSync(c).isFile())) missing.push(`${file} -> ${spec}`);
    }
  }
  assert.deepStrictEqual(missing, [], `imports that point at nothing:\n  ${missing.join('\n  ')}`);
});
