import { test } from 'vitest';
import assert from 'node:assert/strict';
import _traces from '../collectors/traces.js';
const { capJourneys } = _traces;
import _request_class2 from '../collectors/request-class.js';
const { NOISE_CLASSES } = _request_class2;

const j = (id, cls) => ({ traceId: id, class: cls });

test('app journeys survive a cap that noise would fill', () => {
  // newest-first input: 5 noise, then 2 app
  const input = [j('n1', 'direct-or-tls'), j('n2', 'direct-or-tls'), j('n3', 'security-refused'), j('n4', 'direct-or-tls'), j('n5', 'direct-or-tls'), j('a1', 'app'), j('a2', 'app')];
  const out = capJourneys(input, 4, NOISE_CLASSES);
  assert.deepEqual(out.map(t => t.traceId), ['n1', 'n2', 'a1', 'a2']);
});

test('under the cap nothing is dropped and order is kept', () => {
  const input = [j('n1', 'direct-or-tls'), j('a1', 'app')];
  assert.deepEqual(capJourneys(input, 200, NOISE_CLASSES).map(t => t.traceId), ['n1', 'a1']);
});

test('more app journeys than the cap keeps the newest app ones only', () => {
  const input = [j('a1', 'app'), j('n1', 'direct-or-tls'), j('a2', 'egress'), j('a3', 'app')];
  assert.deepEqual(capJourneys(input, 2, NOISE_CLASSES).map(t => t.traceId), ['a1', 'a2']);
});

test('an unclassified journey (older class-less path) counts as work, not noise', () => {
  const input = [j('n1', 'direct-or-tls'), j('u1', undefined)];
  assert.deepEqual(capJourneys(input, 1, NOISE_CLASSES).map(t => t.traceId), ['u1']);
});
