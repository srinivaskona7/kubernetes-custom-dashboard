/**
 * LabelSelector evaluation, shared by security.js (NetworkPolicy coverage) and helm-related.js
 * (which workload a PDB or NetworkPolicy selects). Kubernetes semantics: an absent or empty
 * selector selects everything, and every matchLabels pair and matchExpression must hold.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import labelSelector from '../collectors/label-selector.js';
const { selectorMatches } = labelSelector;

const labels = { app: 'shop', tier: 'web' };

test('an absent or empty selector selects everything', () => {
  assert.equal(selectorMatches(labels, undefined), true);
  assert.equal(selectorMatches(labels, {}), true);
  assert.equal(selectorMatches(undefined, {}), true);
});

test('matchLabels must all hold', () => {
  assert.equal(selectorMatches(labels, { matchLabels: { app: 'shop' } }), true);
  assert.equal(selectorMatches(labels, { matchLabels: { app: 'shop', tier: 'db' } }), false);
});

test('matchExpressions follow In, NotIn, Exists and DoesNotExist', () => {
  const expr = (operator, values) => ({ matchExpressions: [{ key: 'tier', operator, values }] });
  assert.equal(selectorMatches(labels, expr('In', ['web', 'api'])), true);
  assert.equal(selectorMatches(labels, expr('In', ['db'])), false);
  assert.equal(selectorMatches(labels, expr('NotIn', ['db'])), true);
  assert.equal(selectorMatches(labels, expr('NotIn', ['web'])), false);
  assert.equal(selectorMatches(labels, expr('Exists')), true);
  assert.equal(selectorMatches(labels, expr('DoesNotExist')), false);
  assert.equal(selectorMatches({}, expr('NotIn', ['web'])), true, 'an absent key is not in any set');
});

test('an unknown operator selects nothing rather than everything', () => {
  assert.equal(selectorMatches(labels, { matchExpressions: [{ key: 'tier', operator: 'Gt', values: ['1'] }] }), false);
});
