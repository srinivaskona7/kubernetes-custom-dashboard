/**
 * Byte truncation is its own flag.
 *
 * A log tail is bounded twice — `tailLines` and `limitBytes` — and only one of those bounds used to
 * be reported. `truncated` was `parsed.length >= lines`, so a container whose last 200 lines are
 * megabytes of stack traces came back under a 2 MB cut reporting `truncated: false`: the response
 * claimed completeness for a window that had been cut, and the line the cut landed inside was parsed
 * and rendered as if it were a log entry.
 *
 * These tests pin both halves: the flag, and the refusal to render a fragment.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import logs from '../collectors/logs.js';

const CLUSTER = { id: 'platformsbx', apiUrl: 'https://api.example.com' };
const STAMP = '2026-08-30T10:00:00.000000000Z';

/** A body of complete, timestamped lines whose total size is at or above the byte ceiling. */
function bigBody({ lines = 500, trailingNewline = true } = {}) {
  const width = Math.ceil(logs.LOG_LIMIT_BYTES / lines) + 8;
  const body = Array.from({ length: lines }, (_, i) => `${STAMP} ${String(i).padEnd(width, 'x')}`).join('\n');
  return trailingNewline ? `${body}\n` : body;
}

const tail = (body, over = {}) =>
  logs.tail({
    cluster: CLUSTER,
    token: 't',
    namespace: 'shop',
    pod: 'api-0',
    tailLines: 2000,
    textFn: async () => body,
    ...over
  });

test('a body at the byte ceiling reports bytesTruncated even when the line budget is not full', async () => {
  const body = bigBody();
  const out = await tail(body);

  assert.ok(out.bytesRead >= logs.LOG_LIMIT_BYTES, 'fixture must actually reach the ceiling');
  assert.equal(out.bytesTruncated, true, 'the byte cut must be reported');
  assert.equal(out.truncated, false, 'the LINE budget was not full, and that stays its own answer');
  assert.equal(out.limitBytes, logs.LOG_LIMIT_BYTES);
});

test('a body under both ceilings claims neither kind of truncation', async () => {
  const out = await tail(`${STAMP} started\n${STAMP} ready\n`);
  assert.equal(out.bytesTruncated, false);
  assert.equal(out.truncated, false);
  assert.equal(out.partialLinesDropped, 0);
  assert.equal(out.lines.length, 2);
});

test('a trailing fragment is dropped rather than parsed as a line', async () => {
  const out = await tail(bigBody({ trailingNewline: false }));

  assert.equal(out.bytesTruncated, true);
  assert.equal(out.partialLinesDropped, 1);
  assert.equal(out.lines.length, 499, 'the cut line is gone, not rendered');
  // Every surviving line is a whole line: it carries the stamp the API server prefixed.
  assert.ok(out.lines.every(l => l.at === STAMP), 'no fragment survived');
});

test('a leading fragment — no RFC3339 stamp — is dropped when stamps were requested', async () => {
  const out = await tail(`ontinuation of a line the cut landed inside\n${bigBody()}`);

  assert.equal(out.bytesTruncated, true);
  assert.equal(out.partialLinesDropped, 1);
  assert.ok(out.lines.every(l => l.at === STAMP), 'the stampless first line is gone');
});

test('a stampless line is kept when nothing was truncated — absence of a stamp is not evidence', async () => {
  const out = await tail(`no stamp here\n${STAMP} ready\n`);
  assert.equal(out.bytesTruncated, false);
  assert.equal(out.partialLinesDropped, 0);
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0].at, null);
  assert.equal(out.lines[0].message, 'no stamp here');
});

test('a stampless line is kept when stamps were not requested, however big the body', async () => {
  const body = bigBody().replace(new RegExp(`${STAMP} `, 'g'), '');
  const out = await tail(body, { timestamps: false, textFn: async () => body });
  assert.equal(out.partialLinesDropped, 0, 'with no stamps there is no evidence of a head fragment');
});

test('the line budget is judged before a fragment is dropped', async () => {
  // 40 lines returned against a 40-line request: the budget WAS full, and dropping the fragment the
  // byte cut left behind must not turn that into "nothing older exists".
  const width = Math.ceil(logs.LOG_LIMIT_BYTES / 40) + 8;
  const body = Array.from({ length: 40 }, (_, i) => `${STAMP} ${String(i).padEnd(width, 'x')}`).join('\n');
  const out = await tail(body, { tailLines: 40, textFn: async () => body });

  assert.equal(out.truncated, true, 'the line budget was full');
  assert.equal(out.bytesTruncated, true, 'and so was the byte budget');
  assert.equal(out.partialLinesDropped, 1);
  assert.equal(out.lines.length, 39);
});

test('the byte ceiling is the one sent to the API server', async () => {
  let seen = null;
  await logs.tail({
    cluster: CLUSTER,
    token: 't',
    namespace: 'shop',
    pod: 'api-0',
    textFn: async ({ path }) => {
      seen = path;
      return '';
    }
  });
  assert.match(seen, new RegExp(`limitBytes=${logs.LOG_LIMIT_BYTES}`));
});
