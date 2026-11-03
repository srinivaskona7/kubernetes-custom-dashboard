/**
 * Logs.
 *
 * Two things are being protected here. The first is the operator's reading of the log:
 * the timestamp must be split off cleanly and a level guess must never mangle the
 * message. The second is the pod: a tail with no ceiling is a way to pull a gigabyte out
 * of a chatty container and take the dashboard down with it, so the clamps are asserted
 * explicitly rather than trusted.
 */
import { test } from 'vitest';
import assert from 'node:assert';

import logs from '../collectors/logs.js';

const CLUSTER = { id: 'platformsbx', apiUrl: 'https://api.example.com' };

function pod(overrides = {}) {
  return {
    metadata: { name: overrides.name || 'api-0', namespace: overrides.namespace || 'shop' },
    spec: {
      nodeName: overrides.node === undefined ? 'node-a' : overrides.node,
      containers: overrides.containers || [{ name: 'srv', image: 'srv:1' }],
      initContainers: overrides.initContainers || []
    },
    status: {
      phase: overrides.phase || 'Running',
      startTime: '2026-08-30T10:00:00Z',
      containerStatuses: overrides.containerStatuses || [
        { name: 'srv', ready: true, restartCount: 0, state: { running: {} } }
      ]
    }
  };
}

// ------------------------------------------------------------------- inventory

test('inventory lists pods with their containers and node placement', async () => {
  const listFn = async () => [pod()];
  const out = await logs.inventory({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.summary.pods, 1);
  assert.equal(out.summary.containers, 1);
  assert.equal(out.items[0].node, 'node-a');
  assert.equal(out.items[0].cluster, 'platformsbx');
});

test('a pending pod reports no node rather than inventing one', async () => {
  const listFn = async () => [pod({ node: null, phase: 'Pending', containerStatuses: [] })];
  const out = await logs.inventory({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.items[0].node, null);
});

test('unhappy pods sort first, because that is what is being looked for', async () => {
  const listFn = async () => [
    pod({ name: 'healthy' }),
    pod({ name: 'crashing', phase: 'Running', containerStatuses: [{ name: 'srv', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }] }),
    pod({ name: 'pending', phase: 'Pending', containerStatuses: [] })
  ];
  const out = await logs.inventory({ cluster: CLUSTER, token: 't', listFn });
  assert.deepEqual(out.items.map(p => p.name), ['pending', 'crashing', 'healthy']);
});

test('hasPrevious is true only when a previous instance actually exists', async () => {
  const listFn = async () => [
    pod({
      containerStatuses: [
        { name: 'srv', ready: true, restartCount: 2, state: { running: {} }, lastState: { terminated: { exitCode: 137 } } }
      ]
    })
  ];
  const out = await logs.inventory({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.items[0].containers[0].hasPrevious, true);
});

test('a container that has never restarted offers no previous instance', async () => {
  const listFn = async () => [pod()];
  const out = await logs.inventory({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.items[0].containers[0].hasPrevious, false);
});

test('init containers are listed and flagged as init', async () => {
  const listFn = async () => [
    pod({ initContainers: [{ name: 'migrate', image: 'migrate:1' }] })
  ];
  const out = await logs.inventory({ cluster: CLUSTER, token: 't', listFn });
  const init = out.items[0].containers.find(c => c.name === 'migrate');
  assert.equal(init.init, true);
});

test('a waiting container surfaces its reason, which is the diagnosis worth reading', async () => {
  const listFn = async () => [
    pod({ containerStatuses: [{ name: 'srv', ready: false, restartCount: 3, state: { waiting: { reason: 'ImagePullBackOff' } } }] })
  ];
  const out = await logs.inventory({ cluster: CLUSTER, token: 't', listFn });
  assert.equal(out.items[0].containers[0].reason, 'ImagePullBackOff');
  assert.equal(out.items[0].restarts, 3);
});

// ------------------------------------------------------------------------ tail

test('a tail request clamps to the hard ceiling however much is asked for', async () => {
  let seen = null;
  const textFn = async args => { seen = args; return ''; };
  const out = await logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0', tailLines: 999_999, textFn });
  assert.ok(seen.path.includes(`tailLines=${logs.MAX_TAIL_LINES}`));
  assert.equal(out.tailLines, logs.MAX_TAIL_LINES);
});

test('a nonsense tailLines falls back to the default rather than to NaN', async () => {
  let seen = null;
  const textFn = async args => { seen = args; return ''; };
  await logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0', tailLines: 'abc', textFn });
  assert.ok(seen.path.includes(`tailLines=${logs.DEFAULT_TAIL_LINES}`));
});

test('limitBytes is always sent, so one chatty pod cannot flood the process', async () => {
  let seen = null;
  const textFn = async args => { seen = args; return ''; };
  await logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0', textFn });
  assert.ok(seen.path.includes('limitBytes=2000000'));
});

test('previous is only requested when asked for', async () => {
  const paths = [];
  const textFn = async args => { paths.push(args.path); return ''; };
  await logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0', textFn });
  await logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0', previous: true, textFn });
  assert.ok(!paths[0].includes('previous'));
  assert.ok(paths[1].includes('previous=true'));
});

test('the pod name is URL-encoded, so an odd name cannot alter the path', async () => {
  let seen = null;
  const textFn = async args => { seen = args; return ''; };
  await logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'a b/../c', textFn });
  assert.ok(!seen.path.includes('/../'));
  assert.ok(seen.path.includes('a%20b%2F..%2Fc'));
});

test('a missing pod name is a 400 rather than a malformed request to the API server', async () => {
  await assert.rejects(
    () => logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', textFn: async () => '' }),
    err => err.status === 400
  );
});

test('an empty log is an empty list, not one blank line', async () => {
  const out = await logs.tail({ cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0', textFn: async () => '' });
  assert.deepEqual(out.lines, []);
  assert.equal(out.truncated, false);
});

test('a trailing newline does not become a phantom final line', async () => {
  const out = await logs.tail({
    cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0',
    textFn: async () => '2026-08-31T10:00:00.000Z one\n2026-08-31T10:00:01.000Z two\n'
  });
  assert.equal(out.lines.length, 2);
});

test('hitting the requested line count is reported as truncated', async () => {
  const body = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
  const out = await logs.tail({
    cluster: CLUSTER, token: 't', namespace: 'shop', pod: 'api-0', tailLines: 5, textFn: async () => body
  });
  assert.equal(out.truncated, true);
});

// ------------------------------------------------------------------- parseLine

test('the RFC3339 prefix is split into its own field', () => {
  const line = logs.parseLine('2026-08-31T10:00:00.123456789Z GET /health 200');
  assert.equal(line.at, '2026-08-31T10:00:00.123456789Z');
  assert.equal(line.message, 'GET /health 200');
});

test('a line with no timestamp keeps its full text', () => {
  const line = logs.parseLine('no timestamp here');
  assert.equal(line.at, null);
  assert.equal(line.message, 'no timestamp here');
});

test('levels are guessed for colouring, and the message is never altered', () => {
  assert.equal(logs.parseLine('2026-08-31T10:00:00.000Z ERROR boom').level, 'error');
  assert.equal(logs.parseLine('2026-08-31T10:00:00.000Z WARN slow').level, 'warn');
  assert.equal(logs.parseLine('2026-08-31T10:00:00.000Z FATAL dead').level, 'fatal');
  assert.equal(logs.parseLine('2026-08-31T10:00:00.000Z DEBUG chatty').level, 'debug');
  assert.equal(logs.parseLine('2026-08-31T10:00:00.000Z all good').level, null);
  assert.equal(logs.parseLine('2026-08-31T10:00:00.000Z ERROR boom').message, 'ERROR boom');
});

test('a JSON log line survives parsing intact', () => {
  const raw = '2026-08-31T10:00:00.000Z {"level":"info","msg":"ok, no errors"}';
  const line = logs.parseLine(raw);
  assert.equal(line.message, '{"level":"info","msg":"ok, no errors"}');
  assert.doesNotThrow(() => JSON.parse(line.message));
});
