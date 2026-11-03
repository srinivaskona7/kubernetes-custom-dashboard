/**
 * NetworkPolicy coverage in the Security collector.
 *
 * The point of these is the distinction the old one-pill-per-namespace view could not make:
 * "this namespace has 4 NetworkPolicies" and "this namespace denies an unlabelled pod" are
 * different claims, and only the second one is isolation. Each assertion below is paired with
 * the wrong answer it exists to catch, so the guard is proven against a bad input before it is
 * trusted on a good one.
 *
 * Every list is an injected double; no test opens a socket.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import security from '../collectors/security.js';
const { collect, policyDirections, directionCoverage, selectsAllPods } = security;

const cluster = { id: 'test-cluster', displayName: 'Test Cluster', env: 'dev' };

const np = (name, namespace, spec) => ({ metadata: { name, namespace }, spec });
const pod = (name, namespace, labels) => ({ metadata: { name, namespace, labels }, spec: { containers: [{ name: 'c' }] } });
const ns = name => ({ metadata: { name } });

/** `list()` resolves to the array itself, not an envelope — `safeList` is what adds `.items`. */
function fakeList(responses) {
  return async ({ path }) => {
    for (const [fragment, value] of Object.entries(responses)) {
      if (path.includes(fragment)) return value;
    }
    return [];
  };
}

// --------------------------------------------------------------------------------------
// policyTypes inference — the rule that is easy to get backwards
// --------------------------------------------------------------------------------------

test('absent policyTypes infers Ingress only, never both', () => {
  // The API server's rule. A policy with no `policyTypes` and no `egress` rules restricts
  // ingress and nothing else; reading it as both is what makes a cluster look egress-isolated
  // when egress is entirely unrestricted.
  assert.deepEqual(policyDirections(np('p', 'a', { podSelector: {} })), ['Ingress']);
  assert.ok(!policyDirections(np('p', 'a', { podSelector: {} })).includes('Egress'));
});

test('absent policyTypes infers Egress too when egress rules are present', () => {
  const p = np('p', 'a', { podSelector: {}, egress: [{ to: [] }] });
  assert.deepEqual(policyDirections(p), ['Ingress', 'Egress']);
});

test('an explicit policyTypes wins over the inference', () => {
  // Egress-only is a real and common shape. Inferring Ingress here would claim ingress
  // protection that does not exist.
  const p = np('p', 'a', { podSelector: {}, policyTypes: ['Egress'], egress: [{ to: [] }] });
  assert.deepEqual(policyDirections(p), ['Egress']);
  assert.equal(directionCoverage([p], 'Ingress'), 'none');
});

test('an empty policyTypes array falls back to the inference rather than to no directions', () => {
  // `policyTypes: []` is not "governs nothing" in any cluster that has ever been observed —
  // it is an empty field that serialised, and the inference is the honest reading.
  assert.deepEqual(policyDirections(np('p', 'a', { podSelector: {}, policyTypes: [] })), ['Ingress']);
});

// --------------------------------------------------------------------------------------
// selectsAllPods — the difference between "a policy exists" and "every pod is covered"
// --------------------------------------------------------------------------------------

test('only a genuinely empty selector selects every pod', () => {
  assert.equal(selectsAllPods(undefined), true);
  assert.equal(selectsAllPods({}), true);
  assert.equal(selectsAllPods({ matchLabels: {} }), true);
  assert.equal(selectsAllPods({ matchExpressions: [] }), true);
  // The bad answers this catches: either of these returning true would turn a pod-selective
  // policy into a claim of full namespace isolation.
  assert.equal(selectsAllPods({ matchLabels: { app: 'api' } }), false);
  assert.equal(selectsAllPods({ matchExpressions: [{ key: 'app', operator: 'Exists' }] }), false);
});

// --------------------------------------------------------------------------------------
// directionCoverage — none / partial / all
// --------------------------------------------------------------------------------------

test('no policy naming the direction is none, not partial', () => {
  const ingressOnly = np('web', 'a', { podSelector: {}, policyTypes: ['Ingress'] });
  assert.equal(directionCoverage([ingressOnly], 'Egress'), 'none');
  assert.equal(directionCoverage([], 'Ingress'), 'none');
});

test('pod-selective policies are partial, never all', () => {
  // Four policies, none of them default-deny. The old view rendered this as a green
  // "4 Policies" pill; it is the exact case where an unlabelled pod is wide open.
  const selective = ['a', 'b', 'c', 'd'].map((n, i) =>
    np(n, 'a', { podSelector: { matchLabels: { app: `app-${i}` } }, policyTypes: ['Ingress'] }));
  assert.equal(directionCoverage(selective, 'Ingress'), 'partial');
});

test('one all-pods policy makes the direction all, even beside selective ones', () => {
  const denyAll = np('default-deny', 'a', { podSelector: {}, policyTypes: ['Ingress', 'Egress'], egress: [] });
  const selective = np('api', 'a', { podSelector: { matchLabels: { app: 'api' } }, policyTypes: ['Ingress'] });
  assert.equal(directionCoverage([denyAll, selective], 'Ingress'), 'all');
  assert.equal(directionCoverage([denyAll, selective], 'Egress'), 'all');
});

// --------------------------------------------------------------------------------------
// The assembled per-namespace rows
// --------------------------------------------------------------------------------------

test('collect reports coverage, pods observed and the unselected-pod exceptions per namespace', async () => {
  const listFn = fakeList({
    '/namespaces': [ns('team-a'), ns('team-b'), ns('team-c'), ns('kube-system')],
    'networkpolicies': [
      // team-a: a real default-deny on both directions
      np('deny-all', 'team-a', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
      // team-b: selective ingress only. `web` is covered, `batch` is not.
      np('web', 'team-b', { podSelector: { matchLabels: { app: 'web' } }, policyTypes: ['Ingress'] })
    ],
    '/pods': [
      pod('a1', 'team-a', { app: 'anything' }),
      pod('b1', 'team-b', { app: 'web' }),
      pod('b2', 'team-b', { app: 'batch' }),
      pod('c1', 'team-c', {})
    ],
    '/secrets': [],
    '/serviceaccounts': []
  });

  const out = await collect({ cluster, token: 't', listFn });
  const rows = Object.fromEntries(out.networkPolicies.map(r => [r.namespace, r]));

  assert.deepEqual(rows['team-a'], {
    namespace: 'team-a', hasNetworkPolicy: true, policyCount: 1,
    podsObserved: 1, ingress: 'all', egress: 'all', unselectedPods: 0
  });
  assert.deepEqual(rows['team-b'], {
    namespace: 'team-b', hasNetworkPolicy: true, policyCount: 1,
    // The row the whole change exists for: a namespace that "has a NetworkPolicy" and still
    // leaves one of its two pods unreachable by any selector, with egress untouched.
    podsObserved: 2, ingress: 'partial', egress: 'none', unselectedPods: 1
  });
  assert.deepEqual(rows['team-c'], {
    namespace: 'team-c', hasNetworkPolicy: false, policyCount: 0,
    podsObserved: 1, ingress: 'none', egress: 'none', unselectedPods: 1
  });

  // System namespaces stay out of the audit, as before.
  assert.equal(rows['kube-system'], undefined);

  // The headline pair: three namespaces, two have a policy, only one is actually isolated.
  assert.equal(out.summary.networkPolicyProtectedNamespaces, 2);
  assert.equal(out.summary.networkPolicyFullyIsolatedNamespaces, 1);
});

test('a namespace with policies but no observed pods reports zero exceptions, not a false alarm', async () => {
  const listFn = fakeList({
    '/namespaces': [ns('team-a')],
    'networkpolicies': [np('web', 'team-a', { podSelector: { matchLabels: { app: 'web' } } })],
    '/pods': [],
    '/secrets': [],
    '/serviceaccounts': []
  });
  const out = await collect({ cluster, token: 't', listFn });
  assert.equal(out.networkPolicies[0].podsObserved, 0);
  assert.equal(out.networkPolicies[0].unselectedPods, 0);
});
