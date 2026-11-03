
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import _workloads from '../collectors/workloads.js';
const { podSummary } = _workloads;

const __dirname = import.meta.dirname;

const SOURCE = path.join(__dirname, '..', 'collectors', 'workloads.js');

function podWith(containers, initContainers) {
  return {
    metadata: { namespace: 'ns', name: 'p1' },
    spec: { containers, ...(initContainers ? { initContainers } : {}) },
    status: { phase: 'Running', qosClass: 'Burstable' }
  };
}

test('qosBasis reads PRESENCE, so an explicit cpu: "0" request is set while its parsed value is 0', () => {
  const row = podSummary(podWith([
    { name: 'main', image: 'reg/x:1', resources: { requests: { cpu: '0' } } }
  ])).containers[0];

  // This is the whole point of the field: the number cannot tell these two cases apart.
  assert.equal(row.cpuRequest, 0);
  assert.equal(row.qosBasis.cpuRequestSet, true);

  // memory was never named, and cpu had no limit — those stay false.
  assert.deepEqual(row.qosBasis, {
    cpuRequestSet: true,
    cpuLimitSet: false,
    memoryRequestSet: false,
    memoryLimitSet: false
  });

  // The same zero written as a number rather than a quantity string. `!!req.cpu` reports the
  // string "0" as set by accident (a non-empty string is truthy) but reports numeric 0 as
  // unset, so this case is what actually pins the semantics.
  const numeric = podSummary(podWith([
    { name: 'main', image: 'reg/x:1', resources: { requests: { cpu: 0, memory: 0 }, limits: { cpu: 0, memory: 0 } } }
  ])).containers[0];
  assert.deepEqual(numeric.qosBasis, {
    cpuRequestSet: true,
    cpuLimitSet: true,
    memoryRequestSet: true,
    memoryLimitSet: true
  });
});

test('a container with no resources block at all is all-false, and one fully specified is all-true', () => {
  const bare = podSummary(podWith([{ name: 'main', image: 'reg/x:1' }])).containers[0];
  assert.deepEqual(bare.qosBasis, {
    cpuRequestSet: false,
    cpuLimitSet: false,
    memoryRequestSet: false,
    memoryLimitSet: false
  });

  const full = podSummary(podWith([{
    name: 'main',
    image: 'reg/x:1',
    resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '100m', memory: '128Mi' } }
  }])).containers[0];
  assert.deepEqual(full.qosBasis, {
    cpuRequestSet: true,
    cpuLimitSet: true,
    memoryRequestSet: true,
    memoryLimitSet: true
  });

  // An empty requests object is present but names nothing — still all-false.
  const empty = podSummary(podWith([
    { name: 'main', image: 'reg/x:1', resources: { requests: {}, limits: {} } }
  ])).containers[0];
  assert.equal(empty.qosBasis.cpuRequestSet, false);
  assert.equal(empty.qosBasis.memoryLimitSet, false);
});

test('init and sidecar (restartable init) containers are published and distinguishable', () => {
  const row = podSummary(podWith(
    [{ name: 'main', image: 'reg/x:1' }],
    [
      { name: 'setup', image: 'reg/i:1', resources: { limits: { memory: '64Mi' } } },
      { name: 'proxy', image: 'reg/p:1', restartPolicy: 'Always' }
    ]
  ));
  const by = new Map(row.containers.map(c => [c.name, c]));

  assert.deepEqual([...by.keys()].sort(), ['main', 'proxy', 'setup']);
  assert.equal(by.get('main').init, false);
  assert.equal(by.get('main').sidecar, false);
  assert.equal(by.get('setup').init, true);
  assert.equal(by.get('setup').sidecar, false);
  assert.equal(by.get('proxy').init, true);
  assert.equal(by.get('proxy').sidecar, true);

  // Init containers carry their own presence booleans — they participate in the pod's class.
  assert.equal(by.get('setup').qosBasis.memoryLimitSet, true);
  assert.equal(by.get('setup').qosBasis.memoryRequestSet, false);
});

test('qosBasis never computes presence from truthiness', () => {
  const src = readFileSync(SOURCE, 'utf8');
  const block = /qosBasis: \{[\s\S]*?\n {6}\}/.exec(src);
  assert.ok(block, 'the qosBasis block must exist in workloads.js');

  const body = block[0];
  assert.match(body, /Object\.prototype\.hasOwnProperty\.call/);
  assert.equal(
    (body.match(/Object\.prototype\.hasOwnProperty\.call/g) || []).length, 4,
    'all four presence booleans must use hasOwnProperty, not truthiness'
  );
  for (const bad of [/!!\s*(req|lim)\./, /Boolean\(\s*(req|lim)\./, /(req|lim)\.\w+\s*!==\s*undefined/]) {
    assert.doesNotMatch(body, bad, `truthiness-based presence: ${bad}`);
  }
});
