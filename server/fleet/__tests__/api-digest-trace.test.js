/**
 * The trace readers anchor on the router's own log lines. The server logs through Pino, so a
 * captured log carries pino-pretty's framing in front of every one; these pin that the readers
 * see through it, and still read an unframed line.
 */
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import _trace from '../tools/api-digest-trace.js';
const { readTraceSince } = _trace;

function logWith(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-prefix-')), 'dev.log');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('request and read lines are found behind a pino-pretty prefix, coloured or not', () => {
  const read = JSON.stringify({ k8s: 'c1', path: '/api/v1/pods', wait: 0, ms: 3, bytes: 10, t: 1 });
  const file = logWith([
    '[11:43:04.821] INFO (35797): [fleet-audit] GET /api/fleet/clusters -> 200 (4ms) user=a@x.com',
    `[11:43:04.822] INFO (35797): ${read}`,
    `\u001b[32m[11:43:04.823] INFO (35797): \u001b[39m[fleet-audit] POST /api/fleet/tokens/c1/renew -> 200 (9ms) user=a@x.com`,
    '[fleet-audit] GET /api/fleet/me -> 200 (1ms) user=anonymous',
    '[11:43:04.824] WARN (35797): something else entirely'
  ]);
  const out = readTraceSince(file, 0);
  assert.deepStrictEqual(out.requests.map(r => `${r.method} ${r.url}`), [
    'GET /api/fleet/clusters',
    'POST /api/fleet/tokens/c1/renew',
    'GET /api/fleet/me'
  ]);
  assert.strictEqual(out.lines.length, 1);
  assert.strictEqual(out.lines[0].k8s, 'c1');
});
