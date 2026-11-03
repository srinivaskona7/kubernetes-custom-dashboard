// @ts-nocheck
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fleet');
/**
 * The Security tab's two honesty rules, enforced as source checks.
 *
 * Both are cases where a field exists on the wire and the screen renders as if it did not.
 *
 * 1. **`secretTypeDistributionComplete` must be read.** It was produced by the collector, typed in
 *    `api.ts`, and covered by a backend test — and no component looked at it. So a Secret-type
 *    breakdown missing a type whose count was refused, or cut at its paging ceiling, rendered
 *    identically to a whole one. The collector's own comment says "the UI must not present them as
 *    a whole"; a rule that lives only in a comment ships broken. Generalised to *every* `*Complete`
 *    boolean in `api.ts`, because the next one will be added the same way this one was.
 *
 * 2. **A count that names objects must lead to them, and absent must not read as none.**
 *    `privilegedContainerList` / `rootCapableContainerList` exist so that "9 Privileged" is not a
 *    dead end. A server older than those fields sends neither, which is a different fact from
 *    sending `[]` — one is "this server does not say", the other is "the audit found none" — and
 *    only the second may be drawn as an empty table under a heading. `namesAreReported` is that
 *    distinction, so this asserts the section is gated on it rather than on `.length`.
 */




const UI_SRC = path.join(FAKE_DIR, '../../src');

const read = rel => fs.readFileSync(path.join(UI_SRC, rel), 'utf8');

/** Block and line comments removed, so a field named only in prose never satisfies a rule. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function sourceFiles(dir = UI_SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if ((entry.isDirectory() && entry.name !== 'guards')) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('every completeness flag on the wire is read by a component', () => {
  const api = stripComments(read('api.ts'));
  const flags = new Set(
    [...api.matchAll(/^\s*(\w+Complete)\??: boolean/gm)].map(m => m[1])
  );
  assert.ok(
    flags.size > 0,
    'no `*Complete` boolean was found in api.ts. Either the completeness contract lost its flags ' +
      'or this parser stopped matching them — both make this test pass while checking nothing.'
  );

  const consumers = sourceFiles().filter(f => path.basename(f) !== 'api.ts');
  for (const flag of flags) {
    const readers = consumers.filter(f => stripComments(fs.readFileSync(f, 'utf8')).includes(flag));
    assert.ok(
      readers.length > 0,
      `\`${flag}\` is typed in api.ts and read by no component. A partial breakdown then renders ` +
        `exactly like a whole one, which is the "never display 0 when the backend failed" bug in ` +
        `its quieter form: the numbers shown are true, and the set of them is not.`
    );
  }
});

test('the Secret type breakdown says when it is partial', () => {
  const code = stripComments(read('pages/cluster-tabs/SecurityTab.tsx'));

  assert.match(
    code,
    /secretTypeDistributionComplete === false/,
    'SecurityTab no longer tests `secretTypeDistributionComplete === false`. `=== false` and not ' +
      'falsiness: `undefined` means the server predates the field, and treating that as "partial" ' +
      'would print a warning about every older server.'
  );
  assert.match(
    code,
    /accountedSecrets/,
    'the breakdown no longer states what its buckets account for. The sum against ' +
      '`totalSecretsCount` is the check an operator can make at a glance; without it "partial" is ' +
      'a word with no number behind it.'
  );
});

test('the flagged-container table is gated on the server having answered', () => {
  const code = stripComments(read('pages/cluster-tabs/SecurityTab.tsx'));

  for (const field of ['privilegedContainerList', 'rootCapableContainerList']) {
    assert.ok(
      code.includes(field),
      `SecurityTab does not read \`${field}\`, so the count it belongs to is a dead end again`
    );
  }

  assert.match(
    code,
    /namesReported = payload \? namesAreReported\(payload\) : false/,
    'the section is no longer gated on `namesAreReported`. Gating on list length instead would ' +
      'draw an empty table for a server that reports no lists at all, which reads as a clean audit.'
  );
  assert.match(
    code,
    /\{namesReported &&/,
    'nothing consumes `namesReported`. The gate has to be on the render, not merely computed.'
  );
  assert.match(
    code,
    /'containers\[privileged\]',\s*'containers\[root-capable\]'/,
    'the table no longer reads the two truncation labels the collector emits, so a list cut at ' +
      'CONTAINER_LIST_CAP would present as the whole set of flagged containers.'
  );
});
