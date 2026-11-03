/**
 * The kubelet applies `limitBytes` from the start of the tail, so a proxy whose tail outweighs the
 * ceiling used to come back as its OLDEST lines. readProxyLogs re-reads with a tail that fits, so
 * every proxy's window ends at its newest line and request ids line up across proxies.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import _traffic from '../collectors/traffic.js';
const { readProxyLogs, LOG_LIMIT_BYTES } = _traffic;

const LINES = 1000;
const WIDTH = Math.ceil((LOG_LIMIT_BYTES * 2) / LINES); // the tail is twice the ceiling
const line = i => JSON.stringify({ start_time: `t${String(i).padStart(4, '0')}`, pad: 'x'.repeat(WIDTH) });
const LOG = Array.from({ length: LINES }, (_, i) => line(i));

/** What the kubelet does: take the last `tailLines` lines, then cut to `limitBytes` from the front. */
function kubelet(calls) {
  return async ({ path }) => {
    const q = new URLSearchParams(path.split('?')[1]);
    calls.push(Number(q.get('tailLines')));
    const body = LOG.slice(-Number(q.get('tailLines'))).join('\n') + '\n';
    return body.slice(0, Number(q.get('limitBytes')));
  };
}

const pod = { metadata: { name: 'gw-1', namespace: 'istio-system' } };

test('an overflowing tail is re-read so the window ends at the newest line', async () => {
  const calls = [];
  const [out] = await readProxyLogs({ baseCtx: {}, proxies: [pod], textFn: kubelet(calls), tailLines: LINES });
  assert.ok(calls.length >= 2, 'the ceiling was reached, so a second read must follow');
  assert.ok(calls[1] < LINES);
  const raw = await kubelet([])({ path: `x?tailLines=${out.tailLines}&limitBytes=${LOG_LIMIT_BYTES}` });
  assert.match(raw.trimEnd().split('\n').pop(), /"t0999"/, 'the newest line is in the final read');
  assert.equal(out.byteCapped, false);
  assert.equal(out.truncated, true, 'older lines exist that the window never saw');
});

test('a tail under the ceiling is read once, as asked (canary for the refit trigger)', async () => {
  const calls = [];
  const [out] = await readProxyLogs({ baseCtx: {}, proxies: [pod], textFn: kubelet(calls), tailLines: 100 });
  assert.deepEqual(calls, [100]);
  assert.equal(out.tailLines, 100);
  assert.equal(out.byteCapped, false);
});

test('a re-read that fails keeps the capped body already read, flagged, rather than failing the proxy', async () => {
  const calls = [];
  const inner = kubelet(calls);
  const textFn = async ctx => {
    if (calls.length >= 1) {
      calls.push('fail');
      throw Object.assign(new Error('timeout'), { status: 504 });
    }
    return inner(ctx);
  };
  const [out] = await readProxyLogs({ baseCtx: {}, proxies: [pod], textFn, tailLines: LINES });
  assert.equal(out.failed, false);
  assert.ok(out.requests.length > 0 || out.read > 0);
  assert.equal(out.byteCapped, true);
  assert.equal(out.truncated, true);
  assert.equal(out.tailLines, LINES);
});

/*
  The gap read (2026-09-28). Logs come back uncompressed, and on platformsbx the approuter
  sidecar's 500-line tail weighed ~540 KB: the refit re-read 460 KB it already mostly held, 12 s
  on the critical path of the Ingress tab. When only a small newest slice is missing, the reader
  fetches that slice plus a margin and stitches it on at a verified overlap.
*/
const { fetchCappedTail } = _traffic;

/** A kubelet over a log that may grow between reads. `log` is mutated by the caller. */
function growingKubelet(log, calls, onRead = () => {}) {
  return async tail => {
    calls.push(tail);
    const body = log.slice(-tail).join('\n') + '\n';
    onRead();
    return body.slice(0, LOG_LIMIT_BYTES);
  };
}
const SLIGHT = 500;
const SLIGHT_WIDTH = Math.ceil((LOG_LIMIT_BYTES * 1.08) / SLIGHT); // 8% over the ceiling
const slightLine = i => JSON.stringify({ start_time: `s${String(i).padStart(5, '0')}`, pad: 'y'.repeat(SLIGHT_WIDTH) });
const linesOf = raw => raw.replace(/\n$/, '').split('\n');

test('a tail slightly over the ceiling is completed with a small gap read, not a near-full re-read', async () => {
  const log = Array.from({ length: 2000 }, (_, i) => slightLine(i));
  const calls = [];
  const got = await fetchCappedTail(growingKubelet(log, calls), SLIGHT);
  assert.equal(calls.length, 2);
  assert.ok(calls[1] < 150, `the second read fetched ${calls[1]} lines, not a gap`);
  assert.deepEqual(linesOf(got.raw), log.slice(-SLIGHT), 'exactly the newest 500 lines, in order');
  assert.equal(got.tail, SLIGHT);
  assert.equal(got.byteCapped, false);
});

test('lines appended between the two reads are stitched without a duplicate or a hole', async () => {
  const log = Array.from({ length: 2000 }, (_, i) => slightLine(i));
  const calls = [];
  let grown = false;
  const read = growingKubelet(log, calls, () => {
    if (!grown) { grown = true; for (let i = 2000; i < 2020; i++) log.push(slightLine(i)); }
  });
  const got = await fetchCappedTail(read, SLIGHT);
  assert.equal(calls.length, 2);
  assert.deepEqual(linesOf(got.raw), log.slice(-SLIGHT), 'the window ends at the line written mid-read');
});

test('growth past the margin finds no overlap and falls back to the refit re-read', async () => {
  const log = Array.from({ length: 2000 }, (_, i) => slightLine(i));
  const calls = [];
  let grown = false;
  const read = growingKubelet(log, calls, () => {
    if (!grown) { grown = true; for (let i = 2000; i < 2400; i++) log.push(slightLine(i)); }
  });
  const got = await fetchCappedTail(read, SLIGHT);
  assert.ok(calls.length >= 3, 'the gap read could not be joined, so the old refit ran');
  assert.equal(linesOf(got.raw).pop(), log[log.length - 1]);
  assert.ok(got.tail < SLIGHT);
});

test('a tail far over the ceiling still refits to the budget rather than stitching past it', async () => {
  const calls = [];
  const got = await fetchCappedTail(async tail => { calls.push(tail); return (LOG.slice(-tail).join('\n') + '\n').slice(0, LOG_LIMIT_BYTES); }, LINES);
  assert.ok(calls[1] > LINES / 3, 'a refit, not a gap read');
  assert.ok(Buffer.byteLength(got.raw) <= LOG_LIMIT_BYTES);
  assert.match(linesOf(got.raw).pop(), /"t0999"/);
});
