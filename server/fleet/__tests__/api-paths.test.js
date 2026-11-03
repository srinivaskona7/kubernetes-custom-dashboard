
/**
 * The bug this file exists to prevent.
 *
 * `modules.js` asked the API server for `/apis/operator.kyma-project.io/v1beta2/moduleReleaseMetas`
 * — the camelCase spelling used by the Kyma docs, the Go type and the CRD's `kind`. Kubernetes
 * collection paths are the lowercase plural and the API server is case-sensitive, so the request
 * 404ed on every cluster, forever.
 *
 * Nothing caught it, and that is the point. `safeList` did its job: it reported the read as
 * unavailable rather than inventing a zero. The RBAC rule granted `modulereleasemetas`, so an
 * access audit came back clean. `kymas` sat on the line above and worked. What the user saw was
 * three module cards reading "the token may have expired or the read may be forbidden" on a
 * cluster where the token was valid and the read was permitted — a typo wearing an auth error's
 * clothes. Unit tests could not see it either: they stub `listFn`, so the path is whatever the
 * source says it is and the assertion passes on a string the real API server would reject.
 *
 * So this asserts the invariant against the source text directly: every literal segment of every
 * Kubernetes API path in `srv/fleet` is lowercase.
 */

import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;

const ROOT = path.resolve(__dirname, '..');

/** `/api/v1/...` or `/apis/group/version/...`, in a backtick, single- or double-quoted string. */
const API_PATH = /['"`](\/apis?\/[^'"`\n]*)['"`]/g;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

/**
 * The segments of `raw` that are fixed text in the source — the only ones this file can judge.
 *
 * A `${...}` placeholder is dropped whole: its value is a constant defined elsewhere or a
 * caller-supplied name, and both are out of scope here. The query string is dropped too, because
 * field and label selectors legitimately carry uppercase (`fieldSelector=type%3DWarning`).
 */
function literalSegments(raw) {
  return raw
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, '\x00')
    .split('/')
    .filter(seg => seg && !seg.includes('\x00'));
}

test('every literal segment of every Kubernetes API path in srv/fleet is lowercase', () => {
  const offenders = [];

  for (const file of sources(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.resolve(__dirname, '..', '..'), file);
    for (const [, raw] of text.matchAll(API_PATH)) {
      for (const segment of literalSegments(raw)) {
        if (segment !== segment.toLowerCase()) offenders.push(`${rel}: ${raw}  (segment "${segment}")`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `these API paths contain an uppercase segment and will 404 against a real API server, ` +
      `which the UI then reports as an auth or availability failure:\n  ${offenders.join('\n  ')}\n` +
      `Use the CRD's lowercase plural (\`kubectl get crd <name> -o jsonpath='{.spec.names.plural}'\`).`,
  );
});
